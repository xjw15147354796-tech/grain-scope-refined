export function scoreMasks(pred,ref){
 if(pred.length!==ref.length)throw Error('Mask 尺寸不一致');
 let tp=0,fp=0,fn=0;
 for(let i=0;i<pred.length;i++){if(pred[i]&&ref[i])tp++;else if(pred[i])fp++;else if(ref[i])fn++;}
 const ratio=(a,b)=>b?a/b:null;
 return {intersection_px:tp,extra_px:fp,missed_px:fn,predicted_area_px:tp+fp,reference_area_px:tp+fn,IoU:ratio(tp,tp+fp+fn),Dice:ratio(2*tp,2*tp+fp+fn),area_bias:ratio(fp-fn,tp+fn)};
}
export function installEvaluation({button,current,busy,maskCanvas,download,toast}){
 const d=document.createElement('dialog');d.style.cssText='width:90vw;max-width:1200px;background:#111d30;color:white';
 d.innerHTML='<h2>参考 Mask 评估</h2><p>请导入同一照片、同一裁剪范围的黑白 PNG。尺寸相同不代表内容已对齐；本工具不自动平移、拉伸或配准。参考图应完整标注本图所有目标颗粒，否则未标注颗粒会被计为多识别。</p><input type="file" accept="image/png" data-ref><label><input type="checkbox" data-invert>黑色代表颗粒（默认白色）</label><p><label><input type="checkbox" data-confirm>我已确认参考图与当前照片方向、裁剪范围和尺寸一致</label></p><button data-run>计算并显示误差图</button> <button data-save disabled>下载评估 JSON</button> <button data-png disabled>下载误差图</button> <button data-close>关闭</button><p data-status></p><p>绿色＝重合；蓝色＝漏掉；红色＝多识别；黑色＝共同背景。指标针对全部保留颗粒的像素区域，不代表逐颗粒检出率。</p><div style="overflow:auto;max-height:60vh"><canvas style="max-width:100%;image-rendering:pixelated"></canvas></div>';
 document.body.append(d);const q=x=>d.querySelector(x);let item=null,report=null;
 function reset(){report=null;q('[data-save]').disabled=q('[data-png]').disabled=true;q('[data-status]').textContent='';q('canvas').width=q('canvas').height=1;}
 button.onclick=()=>{if(!current()?.result||busy()){toast('请先完成识别');return;}item=current();reset();q('[data-ref]').value='';q('[data-confirm]').checked=false;d.showModal();};
 q('[data-close]').onclick=()=>d.close();for(const selector of ['[data-ref]','[data-invert]','[data-confirm]'])q(selector).onchange=reset;
 q('[data-run]').onclick=async()=>{reset();let bitmap;const run=q('[data-run]');run.disabled=true;try{
  const file=q('[data-ref]').files[0];if(!file||!q('[data-confirm]').checked)throw Error('请选择参考 PNG，并确认坐标一致');
  if(file.size>50000000)throw Error('参考文件超过 50 MB');bitmap=await createImageBitmap(file);const r=item.result;
  if(bitmap.width!==r.width||bitmap.height!==r.height)throw Error(`参考为 ${bitmap.width}×${bitmap.height}，当前识别为 ${r.width}×${r.height}。请用对应尺寸的参考 Mask；原始尺寸参考需在原始像素模式重新识别。`);
  const c=q('canvas');c.width=r.width;c.height=r.height;const ctx=c.getContext('2d');ctx.drawImage(bitmap,0,0);const a=ctx.getImageData(0,0,c.width,c.height).data;
  const ref=new Uint8Array(c.width*c.height),pred=new Uint8Array(ref.length),invert=q('[data-invert]').checked;
  for(let i=0;i<ref.length;i++){const j=i*4,v=a[j];if(a[j+3]!==255||a[j+1]!==v||a[j+2]!==v||(v!==0&&v!==255))throw Error('参考必须是不透明的纯黑白二值 PNG（像素为 0 或 255），请勿使用彩色标注图或截图');ref[i]=invert?v===0:v===255;}
  const mask=await maskCanvas(item),p=mask.getContext('2d').getImageData(0,0,c.width,c.height).data;for(let i=0;i<pred.length;i++)pred[i]=p[i*4]>0;
  const scores=scoreMasks(pred,ref);report={image:item.name,reference:file.name,width:c.width,height:c.height,foreground:invert?'black':'white',alignment:'user-confirmed; no registration',excludedParticlesOmitted:true,...scores};
  const im=ctx.createImageData(c.width,c.height);for(let i=0;i<ref.length;i++){const j=i*4;im.data[j]=pred[i]&&!ref[i]?255:0;im.data[j+1]=pred[i]&&ref[i]?220:0;im.data[j+2]=ref[i]&&!pred[i]?255:0;im.data[j+3]=255;}ctx.putImageData(im,0,0);
  const f=v=>v===null?'不适用':(v*100).toFixed(2)+'%';q('[data-status]').textContent=`IoU ${f(scores.IoU)} · Dice ${f(scores.Dice)} · 面积偏差 ${f(scores.area_bias)}（正值偏大，负值偏小） · 多识别 ${scores.extra_px} px² · 漏掉 ${scores.missed_px} px²。参考为空时面积偏差不适用；双方为空时重合指标不适用。`;q('[data-save]').disabled=q('[data-png]').disabled=false;
 }catch(e){reset();q('[data-status]').textContent=e.message;}finally{bitmap?.close();run.disabled=false;}};
 q('[data-save]').onclick=()=>{if(report)download(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}),'mask-evaluation.json');};q('[data-png]').onclick=()=>{if(report)q('canvas').toBlob(b=>download(b,'mask-errors.png'));};
}
