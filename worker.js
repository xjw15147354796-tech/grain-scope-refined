/* OpenCV runs off the UI thread. No image or annotation is sent to a server. */
let CV, metrics, guided, sensitivity;
const ready=(async()=>{importScripts('./vendor/opencv.js');await new Promise(resolve=>{if(self.cv.Mat){CV=self.cv;resolve();}else self.cv.then(c=>{CV=c;resolve();});});metrics=await import('./metrics.mjs');guided=await import('./guided.mjs');sensitivity=await import('./sensitivity.mjs');postMessage({type:'ready'});})();
ready.catch(e=>postMessage({type:'init-error',error:String(e)}));
const MODES={};
self.onmessage=async({data:d})=>{
  try{await ready; const r=process(d);postMessage({id:d.id,type:'result',...r});}
  catch(e){postMessage({id:d.id,type:'error',error:e.message||String(e)});}
};
function process(d){
 const cv=CV,{width:w,height:h}=d;const allocated=[];const keep=m=>(allocated.push(m),m);
 try{
  if(d.sensitivity)return sensitivity.evaluate(cv,d.sensitivity.poly,d.sensitivity.radius,d.resize,d.sensitivity.scale);
  if(d.exportContours){const m=keep(cv.Mat.zeros(h,w,cv.CV_8UC1));for(const poly of d.exportContours){const c=cv.matFromArray(poly.length/2,1,cv.CV_32SC2,poly),v=new cv.MatVector();try{v.push_back(c);cv.drawContours(m,v,0,new cv.Scalar(255),-1);}finally{v.delete();c.delete();}}return{mask:new Uint8Array(m.data).buffer};}
  const src=keep(cv.matFromImageData({data:new Uint8ClampedArray(d.rgba),width:w,height:h}));
  const gray=keep(new cv.Mat()),blur=keep(new cv.Mat()),field=keep(new cv.Mat()),mask=keep(new cv.Mat());
  cv.cvtColor(src,gray,cv.COLOR_RGBA2GRAY);cv.GaussianBlur(gray,blur,new cv.Size(3,3),0);
  let autoField=false; let fieldPolygon=null;
  const fc=keep(new cv.MatVector()),fh=keep(new cv.Mat());
  cv.threshold(blur,field,38,255,cv.THRESH_BINARY);
  const kernel=keep(cv.getStructuringElement(cv.MORPH_ELLIPSE,new cv.Size(17,17)));
  cv.morphologyEx(field,field,cv.MORPH_CLOSE,kernel);
  cv.findContours(field,fc,fh,cv.RETR_EXTERNAL,cv.CHAIN_APPROX_SIMPLE);
  let best=-1,bestA=0;for(let i=0;i<fc.size();i++){let c=fc.get(i);let a=cv.contourArea(c);c.delete();if(a>bestA){bestA=a;best=i;}}
  let edgeDark=0,edgeTotal=0;for(let x=0;x<w;x+=7){edgeDark+=gray.data[x]<38;edgeDark+=gray.data[(h-1)*w+x]<38;edgeTotal+=2;}
  for(let y=0;y<h;y+=7){edgeDark+=gray.data[y*w]<38;edgeDark+=gray.data[y*w+w-1]<38;edgeTotal+=2;}
  if(d.params.field&&best>=0&&edgeDark/edgeTotal>.65&&bestA>w*h*.1&&bestA<w*h*.92){
   const c=keep(fc.get(best)),hull=keep(new cv.Mat()),v=keep(new cv.MatVector());cv.convexHull(c,hull);v.push_back(hull);
   field.setTo(new cv.Scalar(0));cv.drawContours(field,v,0,new cv.Scalar(255),-1);
   const k=keep(cv.getStructuringElement(cv.MORPH_ELLIPSE,new cv.Size(19,19)));cv.erode(field,field,k);
   autoField=true;fieldPolygon=Array.from(hull.data32S);
  }else{field.setTo(new cv.Scalar(255));}
  if(d.params.method==='corrected'){
   // Normalized convolution avoids treating the black outside as illumination.
   const signal=keep(new cv.Mat()),weight=keep(new cv.Mat()),smooth=keep(new cv.Mat()),weights=keep(new cv.Mat());
   blur.convertTo(signal,cv.CV_32F);field.convertTo(weight,cv.CV_32F,1/255);cv.multiply(signal,weight,signal);
   const size=Math.min(201,Math.max(31,(Math.round(Math.min(w,h)/8)|1)));
   cv.GaussianBlur(signal,smooth,new cv.Size(size,size),0);cv.GaussianBlur(weight,weights,new cv.Size(size,size),0);
   for(let i=0;i<w*h;i++){const bg=smooth.data32F[i]/Math.max(.001,weights.data32F[i]);blur.data[i]=field.data[i]?Math.max(0,Math.min(255,180+blur.data[i]-bg)):180;}
  }
  const hist=new Float64Array(256);let count=0,sum=0;
  for(let i=0;i<w*h;i++)if(field.data[i]){hist[blur.data[i]]++;count++;sum+=blur.data[i];}
  let wb=0,sb=0,bv=-1,threshold=100;
  for(let t=0;t<255;t++){wb+=hist[t];sb+=t*hist[t];if(!wb||wb===count)continue;const delta=sb/wb-(sum-sb)/(count-wb);const variance=wb*(count-wb)*delta*delta;if(variance>bv){bv=variance;threshold=t;}}
  threshold=Math.max(5,Math.min(245,threshold+Number(d.params.sensitivity)));
  const local=keep(new cv.Mat());cv.GaussianBlur(blur,local,new cv.Size(41,41),0);
  if(d.train){
   const extract=points=>points.filter(([x,y])=>x>=0&&y>=0&&x<w&&y<h&&field.data[Math.round(y)*w+Math.round(x)]).slice(0,6000).map(([x,y])=>{let i=Math.round(y)*w+Math.round(x),p=i*4;return[src.data[p]/255,src.data[p+1]/255,src.data[p+2]/255,(blur.data[i]-local.data[i])/128];});
   const fg=extract(d.train.fg),bg=extract(d.train.bg);if(fg.length<20||bg.length<20)throw Error('请在有效视野内分别涂画至少一小片颗粒和背景');
   d.model=metrics.fitPixelModel(fg,bg);
  }
  if(d.baseMask){mask.create(h,w,cv.CV_8UC1);mask.data.set(new Uint8Array(d.baseMask));}
  else{
   mask.create(h,w,cv.CV_8UC1);
   for(let i=0;i<w*h;i++){
    let yes;
    if(d.model){const p=i*4;yes=metrics.predictPixel(d.model,[src.data[p]/255,src.data[p+1]/255,src.data[p+2]/255,(blur.data[i]-local.data[i])/128])>Number(d.params.probability||.5);}
    else if(d.params.method==='local') yes=blur.data[i]<local.data[i]-Math.max(2,12-Number(d.params.sensitivity)*.2);
    else yes=blur.data[i]<threshold;
    mask.data[i]=field.data[i]&&yes?255:0;
   }
   if(d.params.close){const k=keep(cv.getStructuringElement(cv.MORPH_ELLIPSE,new cv.Size(3,3)));cv.morphologyEx(mask,mask,cv.MORPH_CLOSE,k);cv.bitwise_and(mask,field,mask);}
  }
  if(!d.baseMask&&!d.model&&['refined','corrected'].includes(d.params.method)){
   // Re-estimate threshold around each proposal, using original image pixels.
   // Reject large topology/area changes instead of claiming an uncertain fit.
   const seeds=keep(new cv.MatVector()),sh=keep(new cv.Mat()),out=keep(cv.Mat.zeros(h,w,cv.CV_8UC1));
   cv.findContours(mask,seeds,sh,cv.RETR_EXTERNAL,cv.CHAIN_APPROX_SIMPLE);
   for(let j=0;j<seeds.size();j++){
    const seed=seeds.get(j);const area=cv.contourArea(seed),b=cv.boundingRect(seed);
    if(area/d.resize**2<Number(d.params.minArea)||area>count*.2){seed.delete();continue;}
    const pad=Math.max(12,Math.round(Math.max(b.width,b.height)*.25));
    const x=Math.max(0,b.x-pad),y=Math.max(0,b.y-pad),rw=Math.min(w,b.x+b.width+pad)-x,rh=Math.min(h,b.y+b.height+pad)-y;
    const roi=blur.roi(new cv.Rect(x,y,rw,rh)),binary=new cv.Mat(),cc=new cv.MatVector(),hh=new cv.Mat();
    try{
     const t=cv.threshold(roi,binary,0,255,cv.THRESH_BINARY_INV|cv.THRESH_OTSU);
     cv.threshold(roi,binary,Math.max(0,Math.min(255,t+Number(d.params.sensitivity))),255,cv.THRESH_BINARY_INV);
     if(d.params.close){const k=cv.getStructuringElement(cv.MORPH_ELLIPSE,new cv.Size(3,3));cv.morphologyEx(binary,binary,cv.MORPH_CLOSE,k);k.delete();}
     cv.findContours(binary,cc,hh,cv.RETR_EXTERNAL,cv.CHAIN_APPROX_SIMPLE);
     let chosen=null,bestScore=0;
     for(let z=0;z<cc.size();z++){const q=cc.get(z),a=cv.contourArea(q),r=cv.boundingRect(q);
      if(a>area*.5&&a<area*1.8&&r.x>0&&r.y>0&&r.x+r.width<rw&&r.y+r.height<rh){
       let distance=0;for(let k=0;k<seed.data32S.length;k+=2)distance+=Math.abs(cv.pointPolygonTest(q,new cv.Point(seed.data32S[k]-x,seed.data32S[k+1]-y),true));
       const mean=distance/(seed.data32S.length/2),score=1/(1+mean);if(mean<Math.max(3,Math.min(b.width,b.height)*.12)&&score>bestScore){if(chosen)chosen.delete();chosen=q.clone();bestScore=score;}
      }q.delete();}
     if(chosen){for(let k=0;k<chosen.data32S.length;k+=2){chosen.data32S[k]+=x;chosen.data32S[k+1]+=y;}const v=new cv.MatVector();v.push_back(chosen);cv.drawContours(out,v,0,new cv.Scalar(255),-1);v.delete();chosen.delete();}
     else cv.drawContours(out,seeds,j,new cv.Scalar(255),-1);
    }finally{roi.delete();binary.delete();cc.delete();hh.delete();seed.delete();}
   }out.copyTo(mask);
  }
  // Explicit manual edits operate on the mask, then measurements are recomputed.
  for(const edit of d.edits||[]){
   if(edit.type==='localBox'){
    if(edit.marks?.some(s=>s.type==='fg')){const pt=edit.marks.find(s=>s.type==='fg').points[0];edit.seed=[pt[0]+edit.rect[0],pt[1]+edit.rect[1]];}
      const [x,y,rw,rh]=edit.rect,roi=keep(blur.roi(new cv.Rect(x,y,rw,rh))),bin=keep(new cv.Mat()),cc=keep(new cv.MatVector()),hh=keep(new cv.Mat());
    const t=cv.threshold(roi,bin,0,255,cv.THRESH_BINARY_INV|cv.THRESH_OTSU);
    cv.threshold(roi,bin,Math.max(0,Math.min(255,t+(edit.offset||0))),255,cv.THRESH_BINARY_INV);
    if(edit.marks?.some(s=>s.type==='fg'))bin.data.set(guided.segment(keep(roi.clone()).data,rw,rh,edit.marks));
      cv.findContours(bin,cc,hh,cv.RETR_EXTERNAL,cv.CHAIN_APPROX_SIMPLE);let chosen=-1,area=0;
    for(let i=0;i<cc.size();i++){const c=cc.get(i),b=cv.boundingRect(c),a=cv.contourArea(c);if(b.x>0&&b.y>0&&b.x+b.width<rw&&b.y+b.height<rh&&a>area&&(!edit.seed||cv.pointPolygonTest(c,new cv.Point(edit.seed[0]-x,edit.seed[1]-y),false)>=0)){area=a;chosen=i;}c.delete();}
    if(chosen<0)throw Error('框内没有找到完整闭合颗粒，请扩大框选范围或调整局部阈值');
    const target=keep(mask.roi(new cv.Rect(x,y,rw,rh)));target.setTo(new cv.Scalar(0));cv.drawContours(target,cc,chosen,new cv.Scalar(255),-1);
   }
   if(edit.type==='polygon'&&edit.points.length>=3){let c=keep(cv.matFromArray(edit.points.length,1,cv.CV_32SC2,edit.points.flat().map(Math.round)));let v=keep(new cv.MatVector());v.push_back(c);cv.fillPoly(mask,v,new cv.Scalar(255));}
   if(edit.type==='cut')for(let i=1;i<edit.points.length;i++)cv.line(mask,new cv.Point(...edit.points[i-1].map(Math.round)),new cv.Point(...edit.points[i].map(Math.round)),new cv.Scalar(0),Math.max(2,Math.round(d.resize*3)));
  }
  cv.bitwise_and(mask,field,mask);
  const cs=keep(new cv.MatVector()),hier=keep(new cv.Mat());cv.findContours(mask,cs,hier,cv.RETR_EXTERNAL,cv.CHAIN_APPROX_SIMPLE);
  // RETR_EXTERNAL intentionally fills internal optical highlights and holes in a particle silhouette.
  mask.setTo(new cv.Scalar(0));const particles=[];let skipped=0;let tiny=0;
  for(let i=0;i<cs.size();i++){
   const c=cs.get(i);let area=cv.contourArea(c);let a0=area/d.resize**2;
   if(a0<Number(d.params.minArea)||area<6){tiny++;c.delete();continue;}
   if(a0>Number(d.params.maxArea)||area>count*.2){skipped++;c.delete();continue;}
   const m=cv.moments(c);if(!m.m00){c.delete();continue;}
   const cx=m.m10/m.m00,cy=m.m01/m.m00;
   const a=m.mu20/m.m00,b=m.mu11/m.m00,e=m.mu02/m.m00;
   const root=Math.sqrt(Math.max(0,(a-e)**2+4*b*b));
   const major=4*Math.sqrt(Math.max(0,(a+e+root)/2)),minor=4*Math.sqrt(Math.max(0,(a+e-root)/2));
   const hull=new cv.Mat();cv.convexHull(c,hull);
   const raw={area:a0,perimeter:cv.arcLength(c,true)/d.resize,major:major/d.resize,minor:minor/d.resize,hullArea:cv.contourArea(hull)/d.resize**2};hull.delete();
   const shape=metrics.measureShape(raw);const pts=Array.from(c.data32S);let border=false;
   for(let k=0;k<pts.length;k+=2){const x=pts[k],y=pts[k+1],p=y*w+x;if(x<3||y<3||x>=w-3||y>=h-3||!field.data[p-2]||!field.data[p+2]||!field.data[p-2*w]||!field.data[p+2*w]){border=true;break;}}
   const flags=[];if(border)flags.push('边缘截断');if(shape.solidity<.82)flags.push('疑似接触/凹陷');if(minor/d.resize<10)flags.push('分辨率偏低');
   // Keep the measured contour exactly: simplifying this for display hid small
   // concavities and made the overlay disagree with both measurements and mask.
   const poly=Array.from(c.data32S);
   particles.push({id:particles.length+1,raw,shape,x:cx,y:cy,polygon:poly,flags,excluded:border,reviewed:false});
   cv.drawContours(mask,cs,i,new cv.Scalar(255),-1);c.delete();
  }
  const packed=new Uint8Array(mask.data);return{particles,width:w,height:h,mask:packed.buffer,threshold,fieldPolygon,autoField,skipped,tiny,engine:d.params.method==='corrected'&&!d.model?'背景校正＋局部阈值细化（试验）':d.model?'交互学习分割':d.params.method==='local'?'局部明暗分割（试验）':d.params.method==='refined'?'逐颗粒局部阈值贴边（试验）':'自动阈值分割',learnedModel:d.train?d.model:null};
 }finally{for(let i=allocated.length-1;i>=0;i--)allocated[i].delete();}
}


