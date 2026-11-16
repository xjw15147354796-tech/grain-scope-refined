export function evaluate(cv,poly,radius,resize,scale){
 const xs=poly.filter((_,i)=>i%2===0),ys=poly.filter((_,i)=>i%2),pad=radius+3,x=Math.min(...xs)-pad,y=Math.min(...ys)-pad,w=Math.max(...xs)-x+pad+1,h=Math.max(...ys)-y+pad+1;
 const owned=[],keep=v=>(owned.push(v),v);
 try{
 const base=keep(cv.Mat.zeros(h,w,cv.CV_8UC1)),v=keep(new cv.MatVector()),c=keep(cv.matFromArray(poly.length/2,1,cv.CV_32SC2,poly.map((p,i)=>p-(i%2?y:x))));v.push_back(c);cv.drawContours(base,v,0,new cv.Scalar(255),-1);
 const out=[];
 for(const delta of [-radius,0,radius]){
 const m=keep(base.clone()),k=keep(cv.getStructuringElement(cv.MORPH_ELLIPSE,new cv.Size(radius*2+1,radius*2+1)));
 if(delta<0)cv.erode(base,m,k);if(delta>0)cv.dilate(base,m,k);
 const cs=keep(new cv.MatVector()),hier=keep(new cv.Mat());cv.findContours(m,cs,hier,cv.RETR_EXTERNAL,cv.CHAIN_APPROX_SIMPLE);
 const row={delta,originalPixelOffset:delta/resize,status:cs.size()===1?'正常':cs.size()?'分裂，形状指标不计算':'消失',components:cs.size()};
 if(cs.size()===1){const a=keep(cs.get(0)),area=cv.contourArea(a),per=cv.arcLength(a,true),mu=cv.moments(a),hull=keep(new cv.Mat());cv.convexHull(a,hull);const aa=mu.mu20/mu.m00,bb=mu.mu11/mu.m00,ee=mu.mu02/mu.m00,root=Math.hypot(aa-ee,2*bb),major=4*Math.sqrt(Math.max(0,(aa+ee+root)/2)),minor=4*Math.sqrt(Math.max(0,(aa+ee-root)/2)),s=scale/resize;
 Object.assign(row,{area:area*s*s,perimeter:per*s,equivalentDiameter:Math.sqrt(4*area/Math.PI)*s,major:major*s,minor:minor*s,aspectRatio:major/minor,circularity:Math.min(1,4*Math.PI*area/(per*per)),solidity:Math.min(1,area/cv.contourArea(hull))});}
 out.push(row);
 }return {rows:out};
 }finally{for(let i=owned.length-1;i>=0;i--)owned[i].delete();}
}
