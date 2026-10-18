// node brand/scripts/pixel-check.mjs -> .copilot-tmp/uipass/brand/pixel.html
// Rasterises each optical size at its REAL pixel size (canvas), then shows it 10x with
// nearest-neighbour so stroke snapping and counters can be judged honestly.
import { writeFileSync } from "node:fs";
import { svg } from "./mark.mjs";

const cases = [
  ["micro", 16, "dark"], ["micro", 20, "dark"], ["small", 24, "dark"], ["small", 32, "dark"],
  ["micro", 16, "light"], ["micro", 20, "light"], ["small", 24, "light"], ["small", 32, "light"],
];
const data = cases.map(([size, px, way]) => ({ size, px, way, svg: svg({ size, way, tile: true, px, pad: 3 }) }));
const html = `<!doctype html><meta charset="utf-8"><style>body{background:#777;margin:0;padding:16px;display:flex;flex-wrap:wrap;gap:16px;font:12px system-ui}
.c{display:grid;gap:4px;justify-items:center;color:#fff}canvas.big{image-rendering:pixelated}</style><body>
<script>
const D=${JSON.stringify(data)};
for (const d of D){const wrap=document.createElement('div');wrap.className='c';const c=document.createElement('canvas');c.width=c.height=d.px;
const img=new Image();img.onload=()=>{c.getContext('2d').drawImage(img,0,0,d.px,d.px);const b=document.createElement('canvas');b.className='big';b.width=b.height=d.px;b.getContext('2d').drawImage(c,0,0);b.style.width=b.style.height=(d.px*10)+'px';wrap.prepend(b);};
img.src='data:image/svg+xml;utf8,'+encodeURIComponent(d.svg);const l=document.createElement('div');l.textContent=d.size+' '+d.px+'px '+d.way;wrap.append(l);document.body.append(wrap);}
</script>`;
writeFileSync(".copilot-tmp/uipass/brand/pixel.html", html);
console.log("ok");
