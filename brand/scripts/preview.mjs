// node brand/scripts/preview.mjs -> writes .copilot-tmp/uipass/brand/mark-preview.html
import { mkdirSync, writeFileSync } from "node:fs";
import { svg, geometry } from "./mark.mjs";

const pick = (px) => (px <= 20 ? "micro" : px <= 48 ? "small" : "master");
const sizes = [16, 20, 24, 32, 48, 64, 128, 256];
const row = (way, bg) =>
  `<div class="row" style="background:${bg}">${sizes.map((px) => `<div class="c">${svg({ size: pick(px), way, tile: true, px })}<span>${px}</span></div>`).join("")}</div>`;
const bare = (way, bg) =>
  `<div class="row" style="background:${bg}">${sizes.map((px) => `<div class="c">${svg({ size: pick(px), way, px })}<span>${px}</span></div>`).join("")}</div>`;

// Animated master with classes for the two smoke variants.
const anim = (variant) => svg({ size: "master", way: "dark", px: 160, classes: true }).replace("<svg ", `<svg data-v="${variant}" `);

const g = geometry("master");
const grid = `<svg viewBox="0 0 48 48" width="480" height="480" style="background:#17110d">
  ${Array.from({ length: 49 }, (_, i) => `<line x1="${i}" y1="0" x2="${i}" y2="48" stroke="#ffffff" stroke-opacity="${i % 6 === 0 ? 0.14 : 0.05}" stroke-width="0.06"/><line x1="0" y1="${i}" x2="48" y2="${i}" stroke="#ffffff" stroke-opacity="${i % 6 === 0 ? 0.14 : 0.05}" stroke-width="0.06"/>`).join("")}
  <circle cx="24" cy="24" r="20" fill="none" stroke="#5af" stroke-opacity=".35" stroke-width=".12"/>
  <rect x="4" y="4" width="40" height="40" fill="none" stroke="#5af" stroke-opacity=".35" stroke-width=".12"/>
  <line x1="24" y1="0" x2="24" y2="48" stroke="#f80" stroke-opacity=".35" stroke-width=".1"/>
  <path d="${g.roof}" fill="none" stroke="#f3ece3" stroke-opacity=".85" stroke-width="${g.stroke}" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="${g.walls}" fill="none" stroke="#f3ece3" stroke-opacity=".85" stroke-width="${g.stroke}" stroke-linecap="round"/>
  <path d="${g.flame}" fill="#e0682a"/><path d="${g.core}" fill="#ffd28a"/>
  ${g.puffs.map((p) => `<circle cx="${p.cx}" cy="${p.cy}" r="${p.r}" fill="#f3ece3" fill-opacity=".8"/>`).join("")}
  <path d="${g.roof}" fill="none" stroke="#0ff" stroke-width=".12"/><path d="${g.walls}" fill="none" stroke="#0ff" stroke-width=".12"/>
</svg>`;

const html = `<!doctype html><meta charset="utf-8"><title>Vatra mark preview</title>
<style>
body{margin:0;background:#120d0a;color:#efe6dc;font:13px/1.4 "Segoe UI",system-ui;padding:24px}
h2{font-size:15px;margin:22px 0 8px;color:#f08a4b}
.row{display:flex;align-items:flex-end;gap:14px;padding:12px 14px;border-radius:14px;margin-bottom:8px}
.c{display:grid;justify-items:center;gap:4px}.c span{font:10px ui-monospace,monospace;opacity:.55}
.flex{display:flex;gap:24px;align-items:flex-start;flex-wrap:wrap}
.tb{display:flex;gap:8px;align-items:center;padding:6px 12px;border-radius:8px}
.o{width:24px;height:24px;border-radius:5px}
.box{padding:28px 16px 16px;border-radius:18px;background:#1d1611}.box svg{overflow:visible}
/* smoke A: rising wisp (puffs drift up + fade, staggered) */
@keyframes vtRise{0%{transform:translate(-2px,5px) scale(.6);opacity:0}30%{opacity:1}100%{transform:translate(2px,-5px) scale(1.15);opacity:0}}
svg[data-v=A] .vt-puff{transform-box:fill-box;transform-origin:center;animation:vtRise 2.1s cubic-bezier(.33,.7,.4,1) infinite}
svg[data-v=A] .vt-p2{animation-delay:.7s}svg[data-v=A] .vt-p3{animation-delay:1.4s}
/* smoke B: discrete puffs (step blink like an ellipsis) */
@keyframes vtDot{0%,100%{opacity:.15}35%{opacity:1}}
svg[data-v=B] .vt-puff{animation:vtDot 1.2s ease-in-out infinite}
svg[data-v=B] .vt-p2{animation-delay:.2s}svg[data-v=B] .vt-p3{animation-delay:.4s}
/* flame breathing (both) */
@keyframes vtFlame{0%,100%{transform:scale(1,1)}50%{transform:scale(.94,1.06)}}
svg[data-v] .vt-flame,svg[data-v] .vt-core{transform-box:fill-box;transform-origin:50% 100%;animation:vtFlame 1.8s ease-in-out infinite}
/* intro: draw roof+walls, then flame, then smoke */
@keyframes vtDraw{from{stroke-dashoffset:120}to{stroke-dashoffset:0}}
@keyframes vtPop{from{transform:scale(0);opacity:0}to{transform:scale(1);opacity:1}}
svg[data-v=I] .vt-roof,svg[data-v=I] .vt-walls{stroke-dasharray:120;animation:vtDraw .7s cubic-bezier(.65,0,.35,1) both}
svg[data-v=I] .vt-walls{animation-delay:.15s}
svg[data-v=I] .vt-flame,svg[data-v=I] .vt-core{transform-box:fill-box;transform-origin:50% 100%;animation:vtPop .35s cubic-bezier(.34,1.56,.64,1) .65s both}
svg[data-v=I] .vt-puff{transform-box:fill-box;transform-origin:center;animation:vtPop .3s ease-out both}
svg[data-v=I] .vt-p1{animation-delay:.9s}svg[data-v=I] .vt-p2{animation-delay:1s}svg[data-v=I] .vt-p3{animation-delay:1.1s}
@media (prefers-reduced-motion:reduce){svg[data-v] *{animation:none!important}}
</style>
<h2>Optical sizes on tile — dark (micro ≤20 · small 24–48 · master ≥64)</h2>${row("dark", "#120d0a")}
<h2>On tile — light</h2>${row("light", "#f4ede5")}
<h2>Bare mark — dark / light / mono</h2>${bare("dark", "#120d0a")}${bare("light", "#f4ede5")}${bare("monoWhite", "#3a2a20")}${bare("monoBlack", "#e8e0d6")}
<h2>Taskbar 24 px (dark + light) beside other apps · tray 16 px with states</h2>
<div class="tb" style="background:#202124"><div class="o" style="background:#2b7de9"></div><div class="o" style="background:#3fb950"></div>${svg({ size: "small", way: "dark", tile: true, px: 24 })}<div class="o" style="background:#d4a72c"></div><span style="width:30px"></span>${["ok", "warn", "down", "active"].map((s) => svg({ size: "micro", way: "dark", state: s, px: 16 })).join("")}${svg({ size: "micro", way: "dark", px: 16 })}</div>
<div class="tb" style="background:#eceef1;margin-top:6px"><div class="o" style="background:#2b7de9"></div><div class="o" style="background:#3fb950"></div>${svg({ size: "small", way: "light", tile: true, px: 24 })}<div class="o" style="background:#d4a72c"></div><span style="width:30px"></span>${["ok", "warn", "down", "active"].map((s) => svg({ size: "micro", way: "light", state: s, px: 16 })).join("")}${svg({ size: "micro", way: "light", px: 16 })}</div>
<h2>Android circle mask (66/108 safe) · maskable</h2><div class="row" style="background:#120d0a">${[192, 96, 48].map((px) => `<div style="width:${px}px;height:${px}px;border-radius:50%;overflow:hidden">${svg({ size: px > 48 ? "master" : "small", way: "dark", tile: true, pad: 9, mask: "circle", px })}</div>`).join("")}</div>
<h2>Motion demo — A: rising wisp · B: discrete puffs · I: intro (reload to replay)</h2>
<div class="flex"><div class="box">${anim("A")}<div>A · rising wisp + breathing flame</div></div><div class="box">${anim("B")}<div>B · discrete puffs (ellipsis rhythm)</div></div><div class="box">${anim("I")}<div>I · intro (draw → flame → smoke)</div></div></div>
<h2>Construction (48-unit keyline grid, 6-unit major, centre axis, safe circle r20)</h2>${grid}
`;
mkdirSync(".copilot-tmp/uipass/brand", { recursive: true });
writeFileSync(".copilot-tmp/uipass/brand/mark-preview.html", html);
console.log("wrote .copilot-tmp/uipass/brand/mark-preview.html");
