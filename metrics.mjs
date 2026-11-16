export const VERSION = '1.1.0-preview';
export function measureShape(raw, scale = 1) {
  const ratio = raw.major / Math.max(raw.minor, 1e-9);
  return {area: raw.area*scale*scale, perimeter: raw.perimeter*scale, major:raw.major*scale,
    minor:raw.minor*scale, equivalentDiameter:Math.sqrt(4*raw.area/Math.PI)*scale,
    aspectRatio:ratio, circularity:Math.min(1,4*Math.PI*raw.area/Math.max(raw.perimeter**2,1e-9)),
    solidity:Math.min(1,raw.area/Math.max(raw.hullArea,1e-9)),
    elongation:ratio<1.5?'近等轴':ratio<3?'一般伸长':'高度伸长'};
}
export function escapeCSV(value) {
  let s=String(value??''); if (/^[=+\-@\t\r]/.test(s)) s="'"+s;
  return /[",\n\r]/.test(s)?'"'+s.replaceAll('"','""')+'"':s;
}
export function fitPixelModel(foreground,background) {
  if(foreground.length<20||background.length<20) {
    // Small explicit training sets are allowed for unit checks, never for UI training.
    if(!foreground.length||!background.length)throw Error('需要同时标记颗粒和背景');
  }
  const weights=[0,0,0,0,0];
  for(let epoch=0;epoch<180;epoch++){
    let g=[0,0,0,0,0];
    for(const [group,y] of [[foreground,1],[background,0]])for(const x of group){
      let z=weights[0]; for(let j=0;j<4;j++)z+=weights[j+1]*x[j];
      const error=(1/(1+Math.exp(-Math.max(-30,Math.min(30,z))))-y)/(2*group.length);
      g[0]+=error;for(let j=0;j<4;j++)g[j+1]+=error*x[j];
    }
    for(let j=0;j<5;j++)weights[j]-=1.6*(g[j]+(j?.001*weights[j]:0));
  }
  return {weights,foreground:foreground.length,background:background.length,kind:'user-trained-logistic-pixel',version:1};
}
export function predictPixel(model,features){let z=model.weights[0];for(let j=0;j<4;j++)z+=model.weights[j+1]*features[j];return 1/(1+Math.exp(-Math.max(-30,Math.min(30,z))));}
export function csv(rows){return '\uFEFF'+rows.map(r=>r.map(escapeCSV).join(',')).join('\r\n');}
