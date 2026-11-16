// Marker-controlled minimax watershed. Coordinates stay in the source ROI.
export function segment(gray,w,h,strokes){
 const n=w*h,labels=new Uint8Array(n),fixed=new Uint8Array(n),cost=new Float64Array(n).fill(Infinity),heap=[];
 function push(p,c){let i=heap.length;heap.push([p,c]);while(i){const j=(i-1)>>1;if(heap[j][1]<=c)break;heap[i]=heap[j];i=j;}heap[i]=[p,c];}
 function pop(){const a=heap[0],b=heap.pop();if(heap.length){let i=0;while(i*2+1<heap.length){let j=i*2+1;if(j+1<heap.length&&heap[j+1][1]<heap[j][1])j++;if(heap[j][1]>=b[1])break;heap[i]=heap[j];i=j;}heap[i]=b;}return a;}
 for(let x=0;x<w;x++)fixed[x]=fixed[(h-1)*w+x]=2;
 for(let y=0;y<h;y++)fixed[y*w]=fixed[y*w+w-1]=2;
 for(const s of strokes)for(const [x,y]of s.points)for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){const xx=Math.round(x)+dx,yy=Math.round(y)+dy;if(xx>0&&yy>0&&xx<w-1&&yy<h-1&&dx*dx+dy*dy<=4)fixed[yy*w+xx]=s.type==='fg'?1:2;}
 for(let p=0;p<n;p++)if(fixed[p]){labels[p]=fixed[p];cost[p]=0;push(p,0);}
 while(heap.length){const [p,c]=pop();if(c!==cost[p])continue;const x=p%w,y=(p/w)|0;for(const q of [x?p-1:-1,x<w-1?p+1:-1,y?p-w:-1,y<h-1?p+w:-1]){if(q<0||fixed[q])continue;const v=Math.max(c,Math.abs(gray[p]-gray[q]))+0.001;if(v<cost[q]){cost[q]=v;labels[q]=labels[p];push(q,v);}}}
 return Uint8Array.from(labels,v=>v===1?255:0);
}
