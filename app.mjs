import {measureShape,csv,VERSION} from './metrics.mjs';
import {makeZip} from './zip.mjs';
const $=id=>document.getElementById(id),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let images=[],current=null,engineReady=false,busy=false,cancel=false,model=null,tool='select',selected=null,page=0,zoom=1,polygon=[],stroke=[],drawing=false,calibrationPixels=0;
let requestId=0,pending=new Map(),toastTimer;
const worker=new Worker('./worker.js');
worker.onmessage=({data:d})=>{if(d.type==='ready'){engineReady=true;$('engineStatus').textContent='识别引擎已就绪';refreshControls();return;}if(d.type==='init-error'){engineReady=false;$('engineStatus').textContent='引擎加载失败，请刷新重试';$('engineStatus').classList.add('failed-init');toast(d.error);return;}const p=pending.get(d.id);if(p){clearTimeout(p.timer);pending.delete(d.id);d.type==='error'?p.reject(Error(d.error)):p.resolve(d);}};
worker.onerror=e=>{$('engineStatus').textContent='识别引擎发生错误，请刷新重试';for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error(e.message));}pending.clear();};
function rpc(d){return new Promise((resolve,reject)=>{const id=++requestId;const timer=setTimeout(()=>{pending.delete(id);reject(Error('识别超时，请减少分辨率后刷新重试'));},120000);pending.set(id,{resolve,reject,timer});worker.postMessage({...d,id});});}
function toast(s){$('toast').textContent=s;$('toast').classList.remove('hidden');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.add('hidden'),5500);}
function confirmAction(text){$('confirmText').textContent=text;$('confirmDialog').showModal();return new Promise(resolve=>{let settled=false;const done=v=>{if(settled)return;settled=true;$('confirmDialog').close();$('confirmDialog').oncancel=null;resolve(v);};$('confirmYes').onclick=()=>done(true);$('confirmNo').onclick=()=>done(false);$('confirmDialog').oncancel=()=>done(false);});}
function params(){return{method:$('segmentationMethod')?.value||'global',sensitivity:+$('sensitivity').value,minArea:+$('minArea').value,maxArea:10000000,field:$('autoField').checked,close:$('closeGaps').checked,resolution:+$('resolution').value,probability:.5};}
function validParams(p){return Number.isFinite(p.minArea)&&p.minArea>=6&&p.minArea<=1000000;}
function refreshControls(){
 $('analyzeButton').disabled=!current||!engineReady||busy;$('batchButton').disabled=!images.length||!engineReady||busy;
 $('clearAll').disabled=!images.length||busy;$('exportAll').disabled=busy||!images.some(x=>x.result);
 $('exportCSV').disabled=busy||!current?.result;$('downloadOverlay').disabled=busy||!current?.result;
 $('applyScaleAll').disabled=!current||busy;$('undoButton').disabled=busy||!current?.history?.length;
 $('trainButton').disabled=busy||!engineReady||!current||current.fg.length<20||current.bg.length<20;
 $('resetModel').classList.toggle('hidden',!model);$('fileInput').disabled=busy;$('demoButton').disabled=busy;
 document.querySelectorAll('[data-tool]').forEach(b=>b.disabled=!current||busy);
 $('saveSession').disabled=!images.some(x=>x.result)||busy;
}
function setBusy(v,text='正在识别…'){busy=v;$('busyCover').classList.toggle('hidden',!v);$('busyText').textContent=text;refreshControls();}
function drawFiles(){
 $('fileCount').textContent=images.length;$('fileList').innerHTML=images.length?images.map(x=>`<button class="file-row ${current===x?'selected':''}" data-file="${x.id}" title="${esc(x.name)}"><img src="${x.url}" alt=""><span><span class="filename">${esc(x.name)}</span><small class="${x.error?'error':x.result?'done':''}">${x.error?'处理失败':x.processing?'处理中…':x.result?x.result.particles.filter(p=>!p.excluded).length+' 颗粒 · 已识别':'等待识别'}</small></span></button>`).join(''):'<div class="library-empty">你的照片会显示在这里</div>';
 $('fileList').querySelectorAll('[data-file]').forEach(b=>b.onclick=()=>{if(!busy)selectImage(images.find(x=>x.id===b.dataset.file));});refreshControls();
}
async function addFiles(list){
 if(busy){toast('请等待当前任务结束');return;}
 let added=0;
 for(const f of list){if(!/\.(png|jpe?g|webp|bmp)$/i.test(f.name)){toast('已跳过不支持的格式：'+f.name);continue;}if(f.size>50*1024*1024){toast('单张照片请小于50 MB：'+f.name);continue;}if(images.some(x=>x.name===f.name&&x.file.size===f.size&&x.file.lastModified===f.lastModified))continue;
  images.push({id:crypto.randomUUID(),name:f.name,file:f,url:URL.createObjectURL(f),scale:null,result:null,history:[],fg:[],bg:[],strokes:[],modified:false});added++;
 }
 drawFiles();if(!current&&images.length)await selectImage(images[0]);if(added)toast(`已添加 ${added} 张照片。先检查一张，再批量识别。`);
}
async function loadPixels(item,resolution){
 const b=await createImageBitmap(item.file);if(b.width*b.height>60000000){b.close();throw Error('照片像素过大，请先缩小至6000万像素以内');}
 item.originalWidth=b.width;item.originalHeight=b.height;
 let resize=Math.min(1,resolution/Math.max(b.width,b.height)),w=Math.round(b.width*resize),h=Math.round(b.height*resize);
 // Keep a single uniform ratio. Minor rounding is reported through actual analysis dimensions.
 const c=document.createElement('canvas');c.width=w;c.height=h;const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(b,0,0,w,h);b.close();return{canvas:c,rgba:ctx.getImageData(0,0,w,h).data,width:w,height:h,resize};
}
async function selectImage(item){
 current=item;selected=null;page=0;polygon=[];stroke=[];zoom=1;drawFiles();$('scale').value=item.scale??'';
 $('imageTag').textContent=item.name;$('viewerTitle').textContent=item.name;$('emptyState').classList.add('hidden');$('canvasWrap').classList.remove('hidden');
 try{const resolution=item.result?Math.max(item.result.width,item.result.height):params().resolution;const p=await loadPixels(item,resolution);if(current!==item)return;item.pixels=p;const c=$('imageCanvas');c.width=p.width;c.height=p.height;c.getContext('2d').drawImage(p.canvas,0,0);$('overlayCanvas').width=p.width;$('overlayCanvas').height=p.height;fitCanvas();renderResults();updateMarks();setTool('select');}
 catch(e){item.error=e.message;toast('无法打开照片：'+e.message);drawFiles();}
}
function fitCanvas(){if(!current?.pixels)return;const{width:w,height:h}=current.pixels,stage=$('dropZone');const fit=Math.min((stage.clientWidth-20)/w,(stage.clientHeight-16)/h);let sw=Math.max(1,w*fit*zoom),sh=Math.max(1,h*fit*zoom);$('canvasWrap').style.width=sw+'px';$('canvasWrap').style.height=sh+'px';for(const id of ['imageCanvas','overlayCanvas']){$(id).style.width=sw+'px';$(id).style.height=sh+'px';}$('canvasWrap').style.alignSelf=sh>stage.clientHeight?'flex-start':'center';drawOverlay();if($('zoomText'))$('zoomText').textContent=Math.round(zoom*100)+'%';}
window.addEventListener('resize',fitCanvas);
function color(p){return p.excluded?'#929eb4':p.flags.length&&!p.reviewed?'#ffc655':'#48e2bd';}
function drawOverlay(){
 const c=$('overlayCanvas'),ctx=c.getContext('2d');ctx.clearRect(0,0,c.width,c.height);if(!current?.pixels)return;
 const ratio=c.width/Math.max(1,c.getBoundingClientRect().width);ctx.lineWidth=1.4*ratio;
 if(current.result&&$('showContours').checked)for(const p of current.result.particles){const a=p.polygon;if(!a?.length)continue;ctx.beginPath();ctx.moveTo(a[0],a[1]);for(let j=2;j<a.length;j+=2)ctx.lineTo(a[j],a[j+1]);ctx.closePath();ctx.strokeStyle=p.id===selected?'#fff':color(p);ctx.lineWidth=(p.id===selected?2.6:1.4)*ratio;ctx.stroke();if(p.id===selected){ctx.fillStyle='#ffffff22';ctx.fill();}if($('showLabels').checked){ctx.font=`${11*ratio}px sans-serif`;ctx.fillStyle=color(p);ctx.shadowColor='#061425';ctx.shadowBlur=4;ctx.fillText(p.id,p.x+3*ratio,p.y-3*ratio);ctx.shadowBlur=0;}}
 for(const mark of current.strokes){ctx.strokeStyle=mark.type==='fg'?'#a467ffbb':'#ff667bbb';ctx.lineWidth=10*ratio;ctx.lineCap='round';ctx.beginPath();mark.points.forEach((p,i)=>i?ctx.lineTo(...p):ctx.moveTo(...p));ctx.stroke();}
 const pts=tool==='polygon'?polygon:stroke;if(pts.length){ctx.strokeStyle=tool==='calibrate'?'#fff':tool==='bg'?'#ff667b':tool==='fg'?'#b68aff':'#ff8c80';ctx.lineWidth=(tool==='fg'||tool==='bg'?10:2)*ratio;ctx.lineCap='round';ctx.beginPath();pts.forEach((p,i)=>i?ctx.lineTo(...p):ctx.moveTo(...p));ctx.stroke();if(tool==='polygon'){ctx.fillStyle='#fff';for(const p of pts){ctx.beginPath();ctx.arc(...p,2.5*ratio,0,Math.PI*2);ctx.fill();}}}
}
function median(a){if(!a.length)return null;a=[...a].sort((x,y)=>x-y);const m=a.length>>1;return a.length%2?a[m]:(a[m-1]+a[m])/2;}
const fmt=(n,d=2)=>n==null?'—':Number(n).toLocaleString('zh-CN',{maximumFractionDigits:d,minimumFractionDigits:d});
function shape(p,item=current){return measureShape(p.raw,item.scale||1);}
function renderResults(){
 const ps=current?.result?.particles||[],included=ps.filter(p=>!p.excluded),unit=current?.scale?'μm':'px';
 $('statCount').textContent=current?.result?included.length:'—';$('statDiameter').textContent=fmt(median(included.map(p=>shape(p).equivalentDiameter)));$('diameterUnit').textContent=unit;$('statAspect').textContent=fmt(median(included.map(p=>shape(p).aspectRatio)));$('statReview').textContent=current?.result?included.filter(p=>p.flags.length&&!p.reviewed).length:'—';$('resultCount').textContent=ps.length;
 const filter=$('filter').value,filtered=ps.filter(p=>filter==='all'||filter==='review'&&p.flags.length&&!p.reviewed&&!p.excluded||filter==='included'&&!p.excluded||filter==='excluded'&&p.excluded);const pages=Math.max(1,Math.ceil(filtered.length/60));page=Math.min(page,pages-1);
 $('tableBody').innerHTML=filtered.length?filtered.slice(page*60,page*60+60).map(p=>{const s=shape(p),status=p.excluded?'已排除':p.reviewed?'已复核':p.flags.length?'待复核':'自动纳入';return`<tr data-particle="${p.id}" class="${p.id===selected?'chosen':''}"><td>#${p.id}</td><td>${fmt(s.equivalentDiameter)} <span class="hint">${unit}</span></td><td>${fmt(s.aspectRatio)}</td><td>${fmt(s.circularity,3)}</td><td>${fmt(s.solidity,3)}</td><td>${s.elongation}</td><td><span class="tag ${p.excluded?'excluded':p.flags.length&&!p.reviewed?'warn':''}">${status}</span><button class="row-action" data-toggle="${p.id}">${p.excluded?'恢复':'排除'}</button></td></tr>`;}).join(''):`<tr><td colspan="7" class="no-data">${current?.result?'没有符合条件的颗粒，可调整灵敏度或最小面积。':'识别后，在这里查看每一颗粒的形状参数'}</td></tr>`;
 $('tableBody').querySelectorAll('[data-particle]').forEach(tr=>tr.onclick=()=>{selected=+tr.dataset.particle;renderResults();});$('tableBody').querySelectorAll('[data-toggle]').forEach(b=>b.onclick=e=>{e.stopPropagation();toggleParticle(+b.dataset.toggle);});
 $('pagination').innerHTML=filtered.length?`<span>${filtered.length} 条 · 第 ${page+1} / ${pages} 页</span><div><button id="prevPage" class="quiet small" ${page===0?'disabled':''}>上一页</button><button id="nextPage" class="quiet small" ${page>=pages-1?'disabled':''}>下一页</button></div>`:'';
 if($('prevPage')){$('prevPage').onclick=()=>{page--;renderResults();};$('nextPage').onclick=()=>{page++;renderResults();};}
 if(current?.result){const r=current.result;$('analysisNote').textContent=`${r.engine} · ${r.autoField?'已排除视野黑边':'全幅分析'} · ${r.width} × ${r.height} px${current.modified?' · 含人工修正':''}`;}
 renderDetail();drawOverlay();refreshControls();
}
function renderDetail(){const p=current?.result?.particles.find(x=>x.id===selected);if(!p){$('particleDetail').innerHTML='<h3>颗粒检查</h3><p class="hint">点击轮廓或表格行，查看测量结果。</p>';return;}const s=shape(p),u=current.scale?'μm':'px';$('particleDetail').innerHTML=`<h3>颗粒 #${p.id}</h3>${[['长轴',fmt(s.major)+' '+u],['短轴',fmt(s.minor)+' '+u],['投影面积',fmt(s.area)+' '+u+'²'],['周长',fmt(s.perimeter)+' '+u],['长短轴比',fmt(s.aspectRatio)],['圆形度',fmt(s.circularity,3)],['实心度',fmt(s.solidity,3)]].map(([a,b])=>`<div class="detail-line"><span>${a}</span><b>${b}</b></div>`).join('')}<p class="hint">${p.flags.join(' · ')||'未触发质量提示；仍建议抽样复核。'}</p><div class="detail-buttons"><button id="detailToggle" class="secondary">${p.excluded?'恢复纳入':'排除此颗粒'}</button><button id="detailReview" class="quiet">确认已复核</button></div>`;$('detailToggle').onclick=()=>toggleParticle(p.id);$('detailReview').onclick=()=>{snapshot();p.reviewed=true;current.modified=true;renderResults();};}
function snapshot(){if(!current?.result)return;current.history.push({result:structuredClone(current.result),modified:current.modified});if(current.history.length>4)current.history.shift();}
function toggleParticle(id){if(busy)return;const p=current.result.particles.find(x=>x.id===id);snapshot();p.excluded=!p.excluded;current.modified=true;renderResults();drawFiles();}
async function analyze(item,options={}){
 const config=options.edit?item.params:params();if(!validParams(config))throw Error('最小面积需为6至1000000之间的数字');
 const pixels=await loadPixels(item,config.resolution),old=item.result;let baseMask=null;
 if(options.edit&&old){if(old.mask)baseMask=old.mask;else{const c=document.createElement('canvas');c.width=old.width;c.height=old.height;const cx=c.getContext('2d');cx.fillStyle='white';for(const p of old.particles){cx.beginPath();p.polygon.forEach((v,i,a)=>{if(i%2===0)i?cx.lineTo(v,a[i+1]):cx.moveTo(v,a[i+1]);});cx.closePath();cx.fill();}const a=cx.getImageData(0,0,c.width,c.height).data;const b=new Uint8Array(c.width*c.height);for(let i=0;i<b.length;i++)b[i]=a[i*4];baseMask=b.buffer;}}
 item.processing=true;drawFiles();
 const r=await rpc({rgba:pixels.rgba.buffer,width:pixels.width,height:pixels.height,resize:pixels.resize,params:config,model,baseMask,edits:options.edit?[options.edit]:[],train:options.train?{fg:item.fg,bg:item.bg}:null});
 if(options.edit&&old){for(const p of r.particles){const prior=old.particles.find(o=>Math.hypot(p.x-o.x,p.y-o.y)<4&&Math.abs(p.raw.area-o.raw.area)<3);if(prior){p.excluded=prior.excluded;p.reviewed=prior.reviewed;}}}
 delete r.id;delete r.type;item.result=r;item.params={...config};item.resize=pixels.resize;item.processing=false;item.error=null;item.modified=!!options.edit;item.engineModel=model?structuredClone(model):null;
 if(r.learnedModel){model=r.learnedModel;item.engineModel=structuredClone(model);$('modelNote').textContent='已学习标记。批处理将使用此模型；换背景或倍率请先检查。';item.fg=[];item.bg=[];item.strokes=[];}
 if(current===item){item.pixels=pixels;const c=$('imageCanvas');c.width=pixels.width;c.height=pixels.height;c.getContext('2d').drawImage(pixels.canvas,0,0);$('overlayCanvas').width=pixels.width;$('overlayCanvas').height=pixels.height;fitCanvas();selected=null;page=0;updateMarks();renderResults();}
 else item.pixels=null;
 drawFiles();return r;
}
async function analyzeCurrent(train=false){if(!current||busy)return;const item=current;if(item.modified&&!await confirmAction('重新识别将替换当前图的人工轮廓修正和排除记录。是否继续？'))return;if(!validParams(params())){toast('请填写有效的最小面积');return;}
 snapshot();setBusy(true,train?'正在学习标记并识别…':'正在识别颗粒…');try{await analyze(item,{train});toast(`识别完成：${item.result.particles.length} 个候选轮廓，请检查黄色标记。`);}catch(e){item.error=e.message;item.processing=false;drawFiles();toast('识别失败：'+e.message);}finally{setBusy(false);}}
async function runBatch(){if(busy)return;if(images.some(x=>x.modified)&&!await confirmAction('批量识别会替换所有照片的现有结果，包括人工修正。已导出结果后再继续。'))return;if(!validParams(params())){toast('请填写有效的最小面积');return;}
 const saved=current;cancel=false;setBusy(true,'批量识别准备中…');$('cancelButton').classList.remove('hidden');$('batchProgress').classList.remove('hidden');$('batchProgress').max=images.length;$('batchProgress').value=0;let done=0,errors=0;
 for(let i=0;i<images.length;i++){if(cancel)break;const item=images[i];$('busyText').textContent=`正在识别 ${i+1} / ${images.length} · ${item.name}`;item.history=[];
  try{await analyze(item);done++;}catch(e){item.error=e.message;item.processing=false;errors++;drawFiles();}finally{if(item!==current)item.pixels=null;}$('batchProgress').value=i+1;
 }
 setBusy(false);$('cancelButton').classList.add('hidden');$('batchProgress').classList.add('hidden');if(saved)await selectImage(saved);toast(`${cancel?'已停止后续任务。':''}完成 ${done} 张${errors?'，失败 '+errors+' 张，请查看图像库':''}。`);
}
const hints={select:'点击颗粒查看，排除误识别或确认复核。可用右侧 + / − 放大。',cut:'沿粘连处按住拖动划线，松开后重算轮廓。',polygon:'沿颗粒外缘逐点点击，再点击“完成补画”。',fg:'在明确的颗粒内部涂画几笔，避开边缘与透明背景。',bg:'在圆形视野内的背景涂画几笔，避免颗粒与黑边。',calibrate:'沿比例尺或其他已知长度按住拖动画线。'};
function setTool(t){tool=t;polygon=[];stroke=[];document.querySelectorAll('[data-tool]').forEach(b=>b.classList.toggle('active',b.dataset.tool===t));$('finishPolygon').classList.toggle('hidden',t!=='polygon');$('toolHint').textContent=hints[t];drawOverlay();}
function point(e){const r=$('overlayCanvas').getBoundingClientRect();return[(e.clientX-r.left)*$('overlayCanvas').width/r.width,(e.clientY-r.top)*$('overlayCanvas').height/r.height];}
function inside(x,y,a){let yes=false;for(let i=0,j=a.length-2;i<a.length;j=i,i+=2){const xi=a[i],yi=a[i+1],xj=a[j],yj=a[j+1];if((yi>y)!==(yj>y)&&x<(xj-xi)*(y-yi)/(yj-yi)+xi)yes=!yes;}return yes;}
const oc=$('overlayCanvas');
oc.onpointerdown=e=>{if(!current?.pixels||busy)return;const p=point(e);if(tool==='select'){selected=current.result?.particles.find(x=>inside(...p,x.polygon))?.id??null;renderResults();return;}if(tool==='polygon'){polygon.push(p);drawOverlay();return;}
 if(tool==='cut'&&!current.result){toast('请先识别图像，再拆分颗粒');return;}drawing=true;stroke=[p];oc.setPointerCapture(e.pointerId);drawOverlay();};
oc.onpointermove=e=>{if(!drawing)return;const p=point(e);if(tool==='calibrate')stroke=[stroke[0],p];else stroke.push(p);drawOverlay();};
oc.onpointerup=async e=>{if(!drawing)return;drawing=false;const points=[...stroke];if(tool==='fg'||tool==='bg'){
  const target=tool==='fg'?current.fg:current.bg;for(const [x,y]of points)for(let dy=-4;dy<=4;dy+=2)for(let dx=-4;dx<=4;dx+=2){const xx=Math.round(x+dx),yy=Math.round(y+dy);if(xx>=0&&yy>=0&&xx<oc.width&&yy<oc.height&&target.length<6000)target.push([xx,yy]);}
  current.strokes.push({type:tool,points});updateMarks();
 }else if(tool==='cut'&&points.length>=2){await applyEdit({type:'cut',points});}
 else if(tool==='calibrate'&&points.length>=2){calibrationPixels=Math.hypot(points.at(-1)[0]-points[0][0],points.at(-1)[1]-points[0][1])/current.pixels.resize;if(calibrationPixels>2){$('lineInfo').textContent=`所画线段约 ${fmt(calibrationPixels)} 个原图像素。`;$('knownLength').value='';$('calibrationDialog').showModal();$('knownLength').focus();}}
 stroke=[];drawOverlay();};
oc.onpointercancel=()=>{drawing=false;stroke=[];drawOverlay();};
function updateMarks(){$('sampleCount').textContent=`颗粒 ${current?.fg.length||0} · 背景 ${current?.bg.length||0}`;refreshControls();}
async function applyEdit(edit){snapshot();setBusy(true,'正在更新轮廓与测量…');try{await analyze(current,{edit});}catch(e){toast(e.message);}finally{setBusy(false);}}
$('finishPolygon').onclick=async()=>{if(polygon.length<3){toast('请至少标记三个轮廓点');return;}if(!current.result){toast('请先自动识别，再补画漏检颗粒');return;}await applyEdit({type:'polygon',points:polygon});polygon=[];drawOverlay();};
$('undoButton').onclick=()=>{const h=current?.history.pop();if(h){current.result=h.result;current.modified=h.modified;renderResults();drawFiles();}};
function applyScale(v){if(!current)return;if(v!==''&&(!Number.isFinite(+v)||+v<=0)){toast('标定值必须大于0；没有标定请留空');$('scale').value=current.scale??'';return;}current.scale=v===''?null:+v;renderResults();}
$('scale').onchange=e=>applyScale(e.target.value);
$('applyScaleAll').onclick=async()=>{if(await confirmAction('仅当所有照片倍率和像素分辨率一致时才能共用标定。是否应用当前标定到全部照片？')){for(const x of images)x.scale=current.scale;toast('已应用标定到全部照片');renderResults();}};
$('saveCalibration').onclick=()=>{const v=+$('knownLength').value;if(!v||v<=0){toast('请输入大于0的实际长度');return;}applyScale(v/calibrationPixels);$('scale').value=current.scale;$('calibrationDialog').close();setTool('select');toast('已标定当前照片');};$('cancelCalibration').onclick=()=>$('calibrationDialog').close();
function download(blob,name){const u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),30000);}
const columns=['image','particle_id','included','reviewed','quality_flags','unit','scale_um_per_pixel','area','perimeter','equivalent_diameter','major_axis','minor_axis','aspect_ratio','circularity','solidity','elongation_class','center_x_original_px','center_y_original_px','engine'];
function particleRows(items){const rows=[columns];for(const item of items)if(item.result)for(const p of item.result.particles){const s=shape(p,item);rows.push([item.name,p.id,p.excluded?0:1,p.reviewed?1:0,p.flags.join(';'),item.scale?'um':'px',item.scale??'',s.area,s.perimeter,s.equivalentDiameter,s.major,s.minor,s.aspectRatio,s.circularity,s.solidity,s.elongation,p.x/item.resize,p.y/item.resize,item.result.engine]);}return rows;}
function session(){return{format:'grainscope-session',version:VERSION,created:new Date().toISOString(),model,files:images.filter(x=>x.result).map(x=>({name:x.name,size:x.file.size,lastModified:x.file.lastModified,originalWidth:x.originalWidth,originalHeight:x.originalHeight,scale:x.scale,resize:x.resize,params:x.params,modified:x.modified,engineModel:x.engineModel,result:{...x.result,mask:undefined,learnedModel:undefined}}))};}
function summaryRows(){const rows=[['image','included','excluded','needs_review','unit','median_equivalent_diameter','median_aspect_ratio','near_equant','elongated','highly_elongated','near_equant_fraction','elongated_fraction','highly_elongated_fraction']];for(const item of images)if(item.result){const ps=item.result.particles.filter(p=>!p.excluded),ss=ps.map(p=>shape(p,item)),counts=['近等轴','一般伸长','高度伸长'].map(t=>ss.filter(s=>s.elongation===t).length);rows.push([item.name,ps.length,item.result.particles.length-ps.length,ps.filter(p=>p.flags.length&&!p.reviewed).length,item.scale?'um':'px',median(ss.map(s=>s.equivalentDiameter))??'',median(ss.map(s=>s.aspectRatio))??'',...counts,...counts.map(n=>ps.length?n/ps.length:'')]);}return rows;}
const readme=`粒析 GrainScope ${VERSION}\n\n图像在浏览器本地处理。本压缩包不含原始照片。\nparticles.csv 包含所有候选颗粒：included=1 才纳入汇总；reviewed=1 代表人工确认。\nsummary.csv 按照片统计数量比例，不是质量比例。\n未标定使用px，面积px²；标定后长度um，面积um²。不同单位不得混合汇总。\n默认形状分组：轴比<1.5近等轴，1.5<=轴比<3一般伸长，>=3高度伸长，为操作性分类。\n测量以填充内部孔洞后的二维外轮廓为准。长短轴来自面积二阶矩等效椭圆。\n自动分割不是已经验证的深度学习模型；交互学习是基于用户标记的逻辑回归像素分类器。\nsession.json 保存轮廓、版本、各图实际运行参数、标定、复核和模型。重新选择同名同大小原图后可导入。\n低分辨率、遮挡、接触、透明颗粒可能产生误差；请在独立人工标注样本上验证。\n`;
$('exportCSV').onclick=()=>download(new Blob([csv(particleRows([current]))],{type:'text/csv;charset=utf-8'}),current.name.replace(/\.[^.]+$/,'')+'-particles.csv');
$('exportAll').onclick=()=>{const s=JSON.stringify(session(),null,2);const files=[['particles.csv',csv(particleRows(images))],['summary.csv',csv(summaryRows())],['session.json',s],['README.txt',readme]];download(makeZip(files),'GrainScope-results.zip');toast('结果包已导出；未包含原始照片。');};
$('saveSession').onclick=()=>download(new Blob([JSON.stringify(session())],{type:'application/json'}),'GrainScope-session.json');
$('sessionInput').onchange=async e=>{try{const f=e.target.files[0];if(!f)return;if(f.size>150000000)throw Error('会话文件过大');const s=JSON.parse(await f.text());if(s.format!=='grainscope-session'||!Array.isArray(s.files))throw Error('不是有效的粒析会话');let matched=0;
 for(const saved of s.files){const item=images.find(x=>x.name===saved.name&&x.file.size===saved.size);if(!item)continue;if(!saved.result?.particles||!Number.isFinite(saved.resize)||saved.resize<=0)continue;
  const ps=saved.result.particles;if(ps.length>100000)throw Error('会话包含过多颗粒');for(const p of ps){if(!Array.isArray(p.polygon)||p.polygon.some(v=>!Number.isFinite(v))||!p.raw||Object.values(p.raw).some(v=>!Number.isFinite(v)))throw Error('会话中存在无效测量数据');}
  Object.assign(item,{result:saved.result,params:saved.params,scale:saved.scale>0?saved.scale:null,resize:saved.resize,modified:!!saved.modified,engineModel:saved.engineModel,originalWidth:saved.originalWidth,originalHeight:saved.originalHeight});matched++;
 }
 if(s.model?.weights?.length===5&&s.model.weights.every(Number.isFinite))model=s.model;drawFiles();if(current)await selectImage(current);toast(`已恢复 ${matched} 张结果。请先添加同名、同大小的原始照片再导入会话。`);
 }catch(e){toast('导入失败：'+e.message);}finally{e.target.value='';}};
$('downloadOverlay').onclick=()=>{const c=document.createElement('canvas'),p=current.pixels;c.width=p.width;c.height=p.height;const cx=c.getContext('2d');cx.drawImage($('imageCanvas'),0,0);cx.lineWidth=2;
 for(const q of current.result.particles){cx.strokeStyle=color(q);cx.beginPath();q.polygon.forEach((v,i,a)=>{if(i%2===0)i?cx.lineTo(v,a[i+1]):cx.moveTo(v,a[i+1]);});cx.closePath();cx.stroke();cx.font='16px sans-serif';cx.fillStyle=color(q);cx.fillText(q.id,q.x+4,q.y-4);}
 c.toBlob(b=>download(b,current.name.replace(/\.[^.]+$/,'')+'-overlay.png'),'image/png');};
$('fileInput').onchange=e=>{addFiles([...e.target.files]);e.target.value='';};$('chooseButton').onclick=()=>$('fileInput').click();
for(const name of ['dragenter','dragover'])$('dropZone').addEventListener(name,e=>{e.preventDefault();$('dropZone').classList.add('dragover');});for(const name of ['dragleave','drop'])$('dropZone').addEventListener(name,e=>{e.preventDefault();$('dropZone').classList.remove('dragover');if(name==='drop')addFiles([...e.dataTransfer.files]);});
$('clearAll').onclick=async()=>{if(!await confirmAction('清空会移除当前会话中的全部照片和结果。原始照片不会被删除。请先导出需要的结果。'))return;for(const x of images)URL.revokeObjectURL(x.url);images=[];current=null;selected=null;model=null;$('canvasWrap').classList.add('hidden');$('emptyState').classList.remove('hidden');$('imageTag').textContent='尚未选择图像';$('viewerTitle').textContent='图像与轮廓';drawFiles();renderResults();updateMarks();};
$('sensitivity').oninput=e=>$('sensitivityValue').textContent=e.target.value;$('analyzeButton').onclick=()=>analyzeCurrent();$('batchButton').onclick=runBatch;$('cancelButton').onclick=()=>{cancel=true;toast('将完成当前照片后停止');};$('trainButton').onclick=()=>analyzeCurrent(true);
$('resetModel').onclick=()=>{model=null;if(current){current.fg=[];current.bg=[];current.strokes=[];}$('modelNote').textContent='已恢复自动阈值分割，点击识别后应用。';updateMarks();drawOverlay();};
$('filter').onchange=()=>{page=0;renderResults();};for(const id of ['showContours','showLabels'])$(id).onchange=drawOverlay;document.querySelectorAll('[data-tool]').forEach(b=>b.onclick=()=>setTool(b.dataset.tool));
$('helpButton').onclick=()=>$('helpDialog').showModal();$('closeHelp').onclick=()=>$('helpDialog').close();
$('demoButton').onclick=()=>{const c=document.createElement('canvas');c.width=900;c.height=680;const cx=c.getContext('2d');cx.fillStyle='#f0e7d3';cx.fillRect(0,0,900,680);cx.fillStyle='#4d4339';for(const[x,y,rx,ry,angle]of [[150,150,55,55,0],[355,145,80,34,.2],[625,150,98,24,-.3],[170,420,75,50,.5],[415,410,50,50,0],[465,450,46,42,0],[685,420,40,100,.6]]){cx.beginPath();cx.ellipse(x,y,rx,ry,angle,0,Math.PI*2);cx.fill();}c.toBlob(b=>addFiles([new File([b],'几何测试图.png',{type:'image/png'})]));};
const z=document.createElement('div');z.className='zoom-controls';z.innerHTML='<button id="zoomOut" class="quiet" aria-label="缩小图像">−</button><span id="zoomText">100%</span><button id="zoomIn" class="quiet" aria-label="放大图像">＋</button><button id="zoomFit" class="quiet" aria-label="适应视野">适应</button>';$('toolstrip').append(z);$('zoomOut').onclick=()=>{zoom=Math.max(1,zoom-.5);fitCanvas();};$('zoomIn').onclick=()=>{zoom=Math.min(6,zoom+.5);fitCanvas();};$('zoomFit').onclick=()=>{zoom=1;fitCanvas();};
document.addEventListener('keydown',e=>{if(e.key==='Escape'){polygon=[];stroke=[];drawing=false;drawOverlay();}});
// Additional controls are created here to keep older saved sessions compatible.
const segmentationControls=document.createElement('div');
document.querySelector('.version').textContent='试验版 '+VERSION;
segmentationControls.innerHTML='<label class="field-label" for="segmentationMethod">分割方法</label><select id="segmentationMethod"><option value="global">全局阈值（原方法）</option><option value="local">局部明暗（浅色暗边试验）</option></select><p class="hint">局部模式寻找比邻域更暗的边缘，再填充闭合轮廓。可能增加背景碎屑；先复核浅色、深色和粘连颗粒。学习模型启用时优先使用模型。</p>';
$('sensitivity').previousElementSibling.before(segmentationControls);
const refineOption=document.createElement('option');refineOption.value='refined';refineOption.textContent='逐颗粒局部阈值贴边（试验）';$('segmentationMethod').append(refineOption);
const nativeOption=document.createElement('option');nativeOption.value='10000';nativeOption.textContent='原始像素 · 不缩小（较慢）';$('resolution').append(nativeOption);
const maskButton=document.createElement('button');maskButton.className='quiet small';maskButton.textContent='下载 Mask';$('downloadOverlay').after(maskButton);
async function maskCanvas(item){
 const r=item.result,c=document.createElement('canvas');c.width=r.width;c.height=r.height;const ctx=c.getContext('2d');ctx.fillStyle='black';ctx.fillRect(0,0,c.width,c.height);ctx.fillStyle='white';
 // Rasterize the exact measurement contours; exclude rejected particles.
 for(const p of r.particles.filter(p=>!p.excluded)){ctx.beginPath();for(let i=0;i<p.polygon.length;i+=2)i?ctx.lineTo(p.polygon[i],p.polygon[i+1]):ctx.moveTo(p.polygon[i],p.polygon[i+1]);ctx.closePath();ctx.fill();}
 const packed=await rpc({width:r.width,height:r.height,exportContours:r.particles.filter(p=>!p.excluded).map(p=>p.polygon)});const data=new Uint8Array(packed.mask);
 const im=ctx.createImageData(c.width,c.height);for(let i=0;i<im.data.length;i+=4){const v=data[i/4];im.data[i]=im.data[i+1]=im.data[i+2]=v;im.data[i+3]=255;}ctx.putImageData(im,0,0);return c;
}
maskButton.onclick=async()=>{if(!current?.result||busy){toast('请先完成识别');return;}const item=current;setBusy(true,'正在导出 Mask…');try{(await exportMaskCanvas(item)).toBlob(b=>download(b,item.name.replace(/\.[^.]+$/,'')+'-mask.png'));}catch(e){toast(e.message);}finally{setBusy(false);}};
const maskBatch=document.createElement('button');maskBatch.className='quiet';maskBatch.textContent='批量导出 Mask';$('exportAll').before(maskBatch);
maskBatch.onclick=async()=>{
 if(busy||!images.some(i=>i.result)){toast('请先完成识别');return;}setBusy(true,'正在逐张导出 Mask…');
 try{const files=[],manifest=[];let n=0;for(const item of images.filter(i=>i.result)){const name=String(++n).padStart(5,'0')+'-'+item.name.replace(/\.[^.]+$/,'')+'-mask.png';const canvas=await exportMaskCanvas(item);const blob=await new Promise(resolve=>canvas.toBlob(resolve));files.push([name,new Uint8Array(await blob.arrayBuffer())]);manifest.push({file:name,source:item.name,width:item.result.width,height:item.result.height,originalWidth:item.originalWidth,originalHeight:item.originalHeight,resize:item.resize,scale_um_per_original_pixel:item.scale,foreground:0,background:255,excludedParticlesOmitted:true});}files.push(['manifest.json',JSON.stringify(manifest,null,2)]);download(makeZip(files),'GrainScope-masks.zip');}catch(e){toast('导出失败：'+e.message);}finally{setBusy(false);}
};
refreshControls();
const correctedOption=document.createElement('option');correctedOption.value='corrected';correctedOption.textContent='背景校正＋局部阈值细化（试验）';$('segmentationMethod').append(correctedOption);
const boxButton=document.createElement('button');boxButton.textContent='框选局部重分割';boxButton.className='quiet small';maskButton.after(boxButton);
const boxDialog=document.createElement('dialog');boxDialog.style.cssText='width:85vw;max-width:1000px;background:#111d30;color:white';boxDialog.innerHTML='<h2>框内交互分割与预览</h2><p>框内应只有一个目标颗粒，四周留背景。确认后会替换整个框内的识别范围。此功能不是 SAM，不适合直接拆分严重重叠颗粒。</p><label>局部阈值偏移 <input id="boxOffset" type="number" min="-80" max="80" value="0"></label><button id="boxPreview">重新预览</button><button id="boxApply" disabled>确认替换框内结果</button><button id="boxCancel">取消</button><p id="boxStatus"></p><canvas id="boxCanvas" style="max-width:100%;max-height:65vh;object-fit:contain"></canvas>';
document.body.append(boxDialog);let boxStart=null,boxRect=null,boxItem=null,boxEdit=null;
boxButton.onclick=()=>{if(!current?.result||busy){toast('请先识别当前图像');return;}setTool('select');tool='localBox';$('toolHint').textContent='在图上拖动矩形框住一个颗粒，四周留出背景。';};
const originalDown=oc.onpointerdown,originalUp=oc.onpointerup,originalMove=oc.onpointermove;
oc.onpointerdown=e=>{if(tool!=='localBox')return originalDown(e);if(busy)return;boxStart=point(e);oc.setPointerCapture(e.pointerId);};
oc.onpointermove=e=>{if(tool!=='localBox')return originalMove(e);if(!boxStart)return;drawOverlay();const p=point(e),cx=oc.getContext('2d');cx.strokeStyle='#ffdc49';cx.lineWidth=2;cx.strokeRect(boxStart[0],boxStart[1],p[0]-boxStart[0],p[1]-boxStart[1]);};
oc.onpointerup=async e=>{if(tool!=='localBox')return originalUp(e);if(!boxStart)return;const p=point(e),x=Math.max(0,Math.floor(Math.min(p[0],boxStart[0]))),y=Math.max(0,Math.floor(Math.min(p[1],boxStart[1]))),right=Math.min(oc.width,Math.ceil(Math.max(p[0],boxStart[0]))),bottom=Math.min(oc.height,Math.ceil(Math.max(p[1],boxStart[1])));boxStart=null;setTool('select');if(right-x<12||bottom-y<12){toast('框选范围太小，请拖动框选');return;}guideStrokes=[];boxRect=[x,y,right-x,bottom-y];boxItem=current;boxEdit=null;$('boxOffset').value='0';boxDialog.showModal();await previewBox();};
async function previewBox(){const bc=$('boxCanvas'),[bx,by,bw,bh]=boxRect;bc.width=bw;bc.height=bh;bc.getContext('2d').drawImage($('imageCanvas'),bx,by,bw,bh,0,0,bw,bh);boxEdit=null;$('boxApply').disabled=true;const offset=+$('boxOffset').value;if(!Number.isFinite(offset)||Math.abs(offset)>80){$('boxStatus').textContent='阈值偏移需在 -80 到 80 之间';return;}setBusy(true,'正在局部预览…');try{const pixels=await loadPixels(boxItem,boxItem.params.resolution),mask=await maskCanvas(boxItem),data=mask.getContext('2d').getImageData(0,0,mask.width,mask.height).data,base=new Uint8Array(mask.width*mask.height);for(let i=0;i<base.length;i++)base[i]=data[i*4];const edit={type:'localBox',rect:boxRect,offset,marks:structuredClone(guideStrokes)};const result=await rpc({rgba:pixels.rgba.buffer,width:pixels.width,height:pixels.height,resize:pixels.resize,params:boxItem.params,baseMask:boxItem.result.mask||base.buffer,edits:[edit]});const c=$('boxCanvas'),ctx=c.getContext('2d'),[x,y,w,h]=boxRect;c.width=w;c.height=h;ctx.drawImage(pixels.canvas,x,y,w,h,0,0,w,h);ctx.strokeStyle='#00ffff';ctx.lineWidth=1;let found=0;for(const q of result.particles){if(q.x<x||q.x>x+w||q.y<y||q.y>y+h)continue;found++;ctx.beginPath();for(let i=0;i<q.polygon.length;i+=2)i?ctx.lineTo(q.polygon[i]-x,q.polygon[i+1]-y):ctx.moveTo(q.polygon[i]-x,q.polygon[i+1]-y);ctx.closePath();ctx.stroke();}if(!found)throw Error('候选被面积或视野过滤，请扩大框选或检查最小面积');boxEdit=edit;$('boxStatus').textContent='青色为预览轮廓。确认后可用主界面的撤销恢复。';$('boxApply').disabled=false;}catch(e){$('boxStatus').textContent=e.message;}finally{setBusy(false);guidePaint();}}
$('boxPreview').onclick=previewBox;$('boxOffset').oninput=()=>{boxEdit=null;$('boxApply').disabled=true;};$('boxCancel').onclick=()=>boxDialog.close();$('boxApply').onclick=async()=>{if(!boxEdit||busy||current!==boxItem)return;const edit=boxEdit;boxDialog.close();await applyEdit(edit);};
const evaluationButton=document.createElement('button');evaluationButton.textContent='参考 Mask 评估';evaluationButton.className='quiet small';maskButton.after(evaluationButton);
import('./evaluation.mjs').then(({installEvaluation})=>installEvaluation({button:evaluationButton,current:()=>current,busy:()=>busy,maskCanvas,download,toast})).catch(e=>toast('评估功能加载失败：'+e.message));
// Compare the exact exported mask against the same image coordinate system.
const compareButton=document.createElement('button');compareButton.textContent='原图 / Mask 核查';compareButton.className='quiet small';maskButton.after(compareButton);
const compareDialog=document.createElement('dialog');compareDialog.style.cssText='width:94vw;max-width:1500px;background:#111d30;color:#eef4ff';
compareDialog.innerHTML='<h2>原图与 Mask 同尺寸核查</h2><p id="compareInfo"></p><label>显示比例 <select id="compareZoom"><option value="0">适应窗口</option><option value="1">100%（1像素对应1屏幕像素）</option><option value="2">200%</option><option value="4">400%</option></select></label> <label>叠加透明度 <input id="compareAlpha" type="range" min="0" max="100" value="40"></label> <button id="compareClose">关闭</button><p>左：原图；右：白色 Mask；下：红色 Mask 叠加原图。三幅图使用同一尺寸与坐标，滚动同步。已排除的颗粒不显示。</p><div id="compareGrid" style="display:grid;grid-template-columns:1fr 1fr;gap:12px"><div style="overflow:auto;max-height:55vh"><canvas id="compareOriginal"></canvas></div><div style="overflow:auto;max-height:55vh"><canvas id="compareMask"></canvas></div><div style="overflow:auto;max-height:60vh;grid-column:1/-1"><canvas id="compareOverlay"></canvas></div></div><p>这是分割范围核查，不是自动准确率评估；请观察红色是否越过真实边缘或遗漏颗粒内部。</p>';
document.body.append(compareDialog);$('compareClose').onclick=()=>compareDialog.close();
let comparison=null;
function paintComparison(){if(!comparison)return;const {original,mask,tint}=comparison;const canvases=[$('compareOriginal'),$('compareMask'),$('compareOverlay')];const scale=+$('compareZoom').value||Math.min(1,($('compareGrid').clientWidth-12)/2/original.width);for(const [i,c]of canvases.entries()){c.width=original.width;c.height=original.height;c.style.width=c.width*scale+'px';c.style.height=c.height*scale+'px';c.style.maxWidth='none';c.style.imageRendering='pixelated';const ctx=c.getContext('2d');ctx.drawImage(i===1?mask:original,0,0);if(i===2){ctx.globalAlpha=+$('compareAlpha').value/100;ctx.drawImage(tint,0,0);ctx.globalAlpha=1;}}}
$('compareZoom').onchange=paintComparison;$('compareAlpha').oninput=paintComparison;
for(const pane of $('compareGrid').children)pane.onscroll=()=>{for(const other of $('compareGrid').children)if(other!==pane&&(other.scrollLeft!==pane.scrollLeft||other.scrollTop!==pane.scrollTop)){other.scrollLeft=pane.scrollLeft;other.scrollTop=pane.scrollTop;}};
compareButton.onclick=async()=>{if(!current?.result||busy){toast('请先完成识别');return;}setBusy(true,'正在生成对比…');try{const item=current,mask=await maskCanvas(item),original=document.createElement('canvas');original.width=mask.width;original.height=mask.height;original.getContext('2d').drawImage($('imageCanvas'),0,0,mask.width,mask.height);const tint=document.createElement('canvas');tint.width=mask.width;tint.height=mask.height;const ctx=tint.getContext('2d'),data=mask.getContext('2d').getImageData(0,0,mask.width,mask.height);let foreground=0;for(let i=0;i<data.data.length;i+=4){const on=data.data[i]>0;foreground+=on;data.data[i]=255;data.data[i+1]=40;data.data[i+2]=40;data.data[i+3]=on?255:0;}ctx.putImageData(data,0,0);comparison={original,mask,tint};$('compareInfo').textContent=`${item.name} · 原始照片 ${item.originalWidth} × ${item.originalHeight} px · 对比/Mask ${mask.width} × ${mask.height} px · 识别缩放 ${((item.resize||1)*100).toFixed(1)}% · 保留区域 ${foreground} px²。原图在此按识别尺寸等比显示；若要原始像素核查，请选择「原始像素 · 不缩小」后重新识别。`;$('compareZoom').value='0';compareDialog.showModal();paintComparison();}catch(e){toast('对比失败：'+e.message);}finally{setBusy(false);}};
compareDialog.addEventListener('close',()=>{comparison=null;for(const id of ['compareOriginal','compareMask','compareOverlay']){$(id).width=1;$(id).height=1;}});

async function exportMaskCanvas(item){const c=await maskCanvas(item),ctx=c.getContext('2d'),im=ctx.getImageData(0,0,c.width,c.height);for(let i=0;i<im.data.length;i+=4)im.data[i]=im.data[i+1]=im.data[i+2]=255-im.data[i];ctx.putImageData(im,0,0);return c;}
maskButton.textContent='下载 Mask（黑颗粒）';maskBatch.textContent='批量导出 Mask（黑颗粒）';
const guideBar=document.createElement('div');guideBar.innerHTML='<p>交互分割：用画笔标记颗粒内部（包括浅色内部）与框内背景，再点击重新预览。框边默认作为背景。有画笔标记时使用标记引导分割，阈值偏移仅对无标记模式有效。少量点不能保证正确，请核查青色外轮廓。</p><select id="guideMode"><option value="fg">标颗粒</option><option value="bg">标背景</option></select> <button id="guideUndo">撤销一笔</button> <button id="guideClear">清空标记</button>';
$('boxCanvas').before(guideBar);let guideStrokes=[],guideDrawing=false;
function guidePaint(){const ctx=$('boxCanvas').getContext('2d');for(const s of guideStrokes){ctx.fillStyle=s.type==='fg'?'#ff3030':'#44ff66';for(const [x,y]of s.points){ctx.beginPath();ctx.arc(x,y,2,0,Math.PI*2);ctx.fill();}}}
function guideInvalidate(){boxEdit=null;$('boxApply').disabled=true;$('boxStatus').textContent='标记已变化，请重新预览后确认。';}
$('boxCanvas').style.touchAction='none';
function guidePoint(e){const c=$('boxCanvas'),r=c.getBoundingClientRect();return [(e.clientX-r.left)*c.width/r.width,(e.clientY-r.top)*c.height/r.height];}
$('boxCanvas').onpointerdown=e=>{if(busy)return;guideDrawing=true;guideStrokes.push({type:$('guideMode').value,points:[guidePoint(e)]});e.target.setPointerCapture(e.pointerId);guideInvalidate();guidePaint();};
$('boxCanvas').onpointermove=e=>{if(!guideDrawing)return;guideStrokes.at(-1).points.push(guidePoint(e));guidePaint();};
$('boxCanvas').onpointerup=$('boxCanvas').onpointercancel=()=>{guideDrawing=false;};
$('guideUndo').onclick=async()=>{if(busy)return;guideStrokes.pop();await previewBox();};
$('guideClear').onclick=async()=>{if(busy)return;guideStrokes=[];await previewBox();};

const sensitivityButton=document.createElement('button');sensitivityButton.textContent='边界敏感性分析';sensitivityButton.className='quiet small';maskButton.after(sensitivityButton);
const sd=document.createElement('dialog');sd.style.cssText='width:92vw;max-width:1150px;background:#111d30;color:white';sd.innerHTML='<h2>单颗粒边界敏感性分析</h2><p>按当前识别尺寸，对一颗粒单独内缩／外扩，不改变已保存轮廓，也不与邻近颗粒合并。这是参数扰动测试，不是真实误差、置信区间或准确率。</p><label>颗粒 <select id="sensParticle"></select></label> <label>半径（识别图像像素）<select id="sensRadius"><option>1</option><option>2</option><option>3</option></select></label> <button id="sensRun">计算</button> <button id="sensExport" disabled>导出 CSV</button> <button id="sensClose">关闭</button><p id="sensInfo"></p><div id="sensTable" style="overflow:auto"></div>';
document.body.append(sd);let sensItem=null,sensRows=null;const sensKeys=['area','equivalentDiameter','major','minor','perimeter','aspectRatio','circularity','solidity'];const sensNames=['面积','等效粒径','长轴','短轴','周长','长短轴比','圆形度','实心度'];
$('sensClose').onclick=()=>sd.close();
function sensClear(){sensRows=null;$('sensExport').disabled=true;$('sensTable').textContent='参数已改变，请点击计算。';}
$('sensParticle').onchange=$('sensRadius').onchange=sensClear;
sensitivityButton.onclick=()=>{if(busy||!current?.result){toast('请先完成识别');return;}sensItem=current;const ps=current.result.particles.filter(p=>!p.excluded);$('sensParticle').replaceChildren(...ps.map(p=>new Option('颗粒 '+p.id,p.id)));if(ps.some(p=>p.id===selected))$('sensParticle').value=selected;sensClear();sd.showModal();};
$('sensRun').onclick=async()=>{if(busy)return;const p=sensItem.result.particles.find(p=>p.id===+$('sensParticle').value);if(!p){$('sensInfo').textContent='没有保留颗粒';return;}sensClear();setBusy(true,'正在计算边界扰动…');try{const radius=+$('sensRadius').value,r=await rpc({width:sensItem.result.width,height:sensItem.result.height,resize:sensItem.resize,sensitivity:{poly:p.polygon,radius,scale:sensItem.scale||1}});sensRows=r.rows;const base=r.rows[1],unit=sensItem.scale?'µm':'px';$('sensInfo').textContent=`颗粒 ${p.id} · ±${radius} 识别像素 = ±${(radius/sensItem.resize).toFixed(3)} 原图像素；长度单位 ${unit}，面积 ${unit}²。形态学使用椭圆核，离散像素偏移不是连续几何平移。`;
let html='<table style="width:100%"><thead><tr><th>指标</th><th>内缩</th><th>原轮廓</th><th>外扩</th><th>有效值范围</th><th>最大相对变化</th></tr></thead><tbody>';
for(let i=0;i<sensKeys.length;i++){const k=sensKeys[i],vals=r.rows.map(row=>row[k]),valid=vals.filter(Number.isFinite),max=valid.length&&base[k]>0?Math.max(...valid.map(v=>Math.abs(v-base[k])/base[k]*100)):null;html+='<tr><td>'+sensNames[i]+'</td>'+vals.map(v=>'<td>'+(Number.isFinite(v)?v.toFixed(4):'不可用')+'</td>').join('')+'<td>'+(valid.length?Math.min(...valid).toFixed(4)+' – '+Math.max(...valid).toFixed(4):'不可用')+'</td><td>'+(max===null?'不可用':max.toFixed(2)+'%')+'</td></tr>';}
html+='</tbody></table><p>'+r.rows.map(row=>(row.delta<0?'内缩':row.delta>0?'外扩':'原轮廓')+'：'+row.status).join('；')+'</p>';$('sensTable').innerHTML=html;$('sensExport').disabled=false;
}catch(e){$('sensInfo').textContent=e.message;}finally{setBusy(false);}};
$('sensExport').onclick=()=>{if(!sensRows)return;const rows=[['image','particle_id','unit','offset_analysis_px','offset_original_px','status','components',...sensKeys],...sensRows.map(r=>[sensItem.name,$('sensParticle').value,sensItem.scale?'um':'px',r.delta,r.originalPixelOffset,r.status,r.components,...sensKeys.map(k=>r[k]??'')])];download(new Blob([csv(rows)],{type:'text/csv;charset=utf-8'}),'boundary-sensitivity.csv');};
