// Operational, unvalidated 2D morphology rules; not mineralogical roundness.
export const CLASS_VERSION='shape-2d-2.0';
export const CLASSES=['近圆形','近椭圆形','近三角形','近矩形','不规则形','待复核'];
export const RULES='试验规则 v2，依次判断：近圆形要求轴比≤1.20、圆形度≥0.82、实心度≥0.95、椭圆残差≤0.075；近椭圆形要求轴比>1.20、实心度≥0.94、椭圆残差≤0.075；近三角形/近矩形要求轮廓在周长1.5%、2%、2.5%简化尺度中至少两次得到3/4个顶点，面积比0.85–1.15、边界拟合残差≤0.04、实心度≥0.90，矩形另要求四角均在70–110度；其余为不规则形，质量异常则待复核。残差不是准确率。这是二维操作性分类，阈值未经独立参考样本验证。';
function area(p){let a=0;for(let i=0;i<p.length;i++){let q=p[(i+1)%p.length];a+=p[i][0]*q[1]-q[0]*p[i][1];}return Math.abs(a/2);}
function distance(p,a,b){let x=b[0]-a[0],y=b[1]-a[1],t=Math.max(0,Math.min(1,((p[0]-a[0])*x+(p[1]-a[1])*y)/(x*x+y*y||1)));return Math.hypot(p[0]-a[0]-t*x,p[1]-a[1]-t*y);}
function dp(p,e){if(p.length<=2)return p;let d=0,k=0;for(let i=1;i<p.length-1;i++){let v=distance(p[i],p[0],p.at(-1));if(v>d){d=v;k=i;}}return d>e?[...dp(p.slice(0,k+1),e).slice(0,-1),...dp(p.slice(k),e)]:[p[0],p.at(-1)];}
export function polygonFit(flat){
 const p=[];for(let i=0;i<flat.length;i+=2)p.push([flat[i],flat[i+1]]);
 if(p.length<3)return {kind:null};let per=0,k=1;
 for(let i=0;i<p.length;i++){per+=Math.hypot(p[i][0]-p[(i+1)%p.length][0],p[i][1]-p[(i+1)%p.length][1]);if(Math.hypot(p[i][0]-p[0][0],p[i][1]-p[0][1])>Math.hypot(p[k][0]-p[0][0],p[k][1]-p[0][1]))k=i;}
 const A=area(p);if(!A)return {kind:null};let fits=[];
 for(const f of [.015,.02,.025]){
  const q=[...dp(p.slice(0,k+1),per*f).slice(0,-1),...dp([...p.slice(k),p[0]],per*f).slice(0,-1)];
  const n=q.length,ratio=area(q)/A;let sq=0,weight=0;
  for(let i=0;i<p.length;i++){const next=p[(i+1)%p.length],len=Math.hypot(next[0]-p[i][0],next[1]-p[i][1]),mid=[(next[0]+p[i][0])/2,(next[1]+p[i][1])/2];let d=Math.min(...q.map((a,j)=>distance(mid,a,q[(j+1)%n])));sq+=d*d*len;weight+=len;}
  const residual=Math.sqrt(sq/(weight||1))/Math.sqrt(A);
  let angles=q.map((a,i)=>{let b=q[(i+n-1)%n],c=q[(i+1)%n],u=[b[0]-a[0],b[1]-a[1]],v=[c[0]-a[0],c[1]-a[1]];return Math.acos(Math.max(-1,Math.min(1,(u[0]*v[0]+u[1]*v[1])/(Math.hypot(...u)*Math.hypot(...v)||1))))*180/Math.PI;});
  if(ratio>=.85&&ratio<=1.15&&residual<=.04&&(n===3||(n===4&&angles.every(a=>a>=70&&a<=110))))fits.push({kind:n===3?'近三角形':'近矩形',residual});
 }
 for(const kind of ['近三角形','近矩形']){let found=fits.filter(f=>f.kind===kind);if(found.length>=2)return {kind,residual:Math.max(...found.map(f=>f.residual))};}return {kind:null};
}
const cache=new WeakMap();
export function ellipseResidual(poly){
 if(!poly||poly.length<6||poly.some(v=>!Number.isFinite(v)))return null;
 // Shift to local coordinates for numerical stability.
 const ox=poly[0],oy=poly[1],p=poly.map((v,i)=>v-(i%2?oy:ox));
 let a=0,cx=0,cy=0,xx=0,yy=0,xy=0,per=0;
 const seg=[];
 for(let i=0;i<p.length;i+=2){const j=(i+2)%p.length,x=p[i],y=p[i+1],u=p[j],v=p[j+1],z=x*v-u*y;
  a+=z;cx+=(x+u)*z;cy+=(y+v)*z;xx+=(x*x+x*u+u*u)*z;yy+=(y*y+y*v+v*v)*z;xy+=(2*x*y+x*v+u*y+2*u*v)*z;
  const len=Math.hypot(u-x,v-y);seg.push({x,y,u,v,len,start:per});per+=len;
 }
 if(Math.abs(a)<1e-8||!per)return null;
 cx/=3*a;cy/=3*a;xx=xx/(6*a)-cx*cx;yy=yy/(6*a)-cy*cy;xy=xy/(12*a)-cx*cy;
 const det=xx*yy-xy*xy;if(det<=1e-9)return null;
 let error=0,k=0;
 for(let n=0;n<160;n++){const d=per*(n+.5)/160;while(k<seg.length-1&&d>=seg[k].start+seg[k].len)k++;const s=seg[k],t=s.len?(d-s.start)/s.len:0,x=s.x+t*(s.u-s.x)-cx,y=s.y+t*(s.v-s.y)-cy;
  const radius=Math.sqrt(Math.max(0,(yy*x*x-2*xy*x*y+xx*y*y)/(4*det)));error+=(radius-1)**2;
 }
 return Math.sqrt(error/160);
}
export function classifyParticle(p,s,resize=1){
 let auto=cache.get(p);
 if(!auto||auto.resize!==resize){
  const residual=ellipseResidual(p.polygon),fit=polygonFit(p.polygon),quality=[...(p.flags||[])];
  if(p.raw.minor*resize<15)quality.push('识别图短轴不足15像素');
  let label='待复核',reason;
  if(![s.aspectRatio,s.circularity,s.solidity].every(Number.isFinite)||residual==null){reason='轮廓或指标不足，不能分类';}
  else if(quality.length){reason='质量提示：'+[...new Set(quality)].join('、');}
  else if(residual<=.075&&s.solidity>=.95&&s.aspectRatio<=1.2&&s.circularity>=.82){label='近圆形';reason='长短轴接近，圆形度高，轮廓与等效椭圆接近';}
  else if(residual<=.075&&s.solidity>=.94&&s.aspectRatio>1.2){label='近椭圆形';reason='轮廓与等效椭圆接近，且存在伸长';}
  else if(fit.kind&&s.solidity>=.90){label=fit.kind;reason='多个轮廓简化尺度下顶点数及拟合均满足规则；多边形残差='+fit.residual.toFixed(4);}
  else {label='不规则形';reason='未满足近圆、近椭圆、近三角或近矩形拟合规则；不能由此推断磨圆度';}
  auto={label,reason,residual,resize,version:CLASS_VERSION};cache.set(p,auto);
 }
 const manual=p.shapeReview?.version===CLASS_VERSION&&CLASSES.includes(p.shapeReview.label)?p.shapeReview:null;
 return{...auto,finalLabel:manual?.label||auto.label,source:manual?'人工确认':'自动初判',note:manual?.note||'',reviewed:!!manual};
}
