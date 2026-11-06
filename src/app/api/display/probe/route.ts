import { db } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";
import { espAuthorized } from "@/lib/esp/auth";
import { NextResponse, type NextRequest } from "next/server";
import { apiForbidden } from "@/lib/api-error";

export const dynamic = "force-dynamic";

// GET  /api/display/probe?k=…  -> tiny HTML that measures the casting browser and POSTs back
// POST /api/display/probe?k=…  -> stores the report in audit_log (action display.probe)
export async function GET(req: NextRequest) {
  if (!espAuthorized(req)) return apiForbidden(req);
  const k = new URL(req.url).searchParams.get("k") ?? "";
  const html = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<body style="margin:0;background:#101318;color:#eee;font:20px system-ui;padding:24px">
<h1 id=h style="margin:0 0 12px;font-size:28px">probe…</h1><pre id=o style="white-space:pre-wrap;font-size:16px"></pre>
<script>
(function(){
  var c=document.createElement('canvas');var gl=null;try{gl=c.getContext('webgl2')||c.getContext('webgl')}catch(e){}
  var dbg=gl&&gl.getExtension('WEBGL_debug_renderer_info');
  var s=document.createElement('div').style;
  function sup(p,v){try{return CSS.supports(p,v)}catch(e){return false}}
  var r={
    ua:navigator.userAgent, dpr:window.devicePixelRatio, w:innerWidth,h:innerHeight, sw:screen.width,sh:screen.height,
    cores:navigator.hardwareConcurrency, mem:navigator.deviceMemory, touch:'ontouchstart' in window, maxTouch:navigator.maxTouchPoints,
    webgl:!!gl, webgl2:!!(gl&&gl.constructor&&/2/.test(gl.constructor.name)), gpu:dbg&&gl?gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL):null,
    css:{backdrop:sup('backdrop-filter','blur(4px)'),oklch:sup('color','oklch(0.5 0.1 200)'),colorMix:sup('color','color-mix(in srgb,red,blue)'),
      grid:sup('display','grid'),gap:sup('gap','1px'),aspect:sup('aspect-ratio','1'),containerQ:sup('container-type','inline-size'),
      has:(function(){try{document.querySelector(':has(a)');return true}catch(e){return false}})(),
      clamp:sup('width','clamp(1px,2px,3px)'),inset:sup('inset','0'),scrollSnap:sup('scroll-snap-type','x mandatory'),
      textWrapBalance:sup('text-wrap','balance'),mask:sup('mask-image','linear-gradient(black,transparent)')||sup('-webkit-mask-image','linear-gradient(black,transparent)')},
    js:{viewTransition:!!document.startViewTransition, waapi:!!(s.animate||Element.prototype.animate), io:'IntersectionObserver' in window,
      ro:'ResizeObserver' in window, es:'EventSource' in window, ws:'WebSocket' in window, wakeLock:!!(navigator.wakeLock),
      optionalChaining:(function(){try{new Function('return ({}).a?.b');return true}catch(e){return false}})(),
      topLevelAwait:false, bigint:typeof BigInt==='function', avif:false, webp:false},
    prefersReducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches
  };
  var img=new Image();img.onload=function(){r.js.webp=img.width>0;done()};img.onerror=function(){done()};
  img.src='data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA';
  var t0=performance.now();var frames=0;function tick(){frames++;if(performance.now()-t0<1000)requestAnimationFrame(tick);else{r.fps=frames;send()}}
  var sent=false;function done(){requestAnimationFrame(tick)}
  function send(){if(sent)return;sent=true;document.getElementById('h').textContent='probe sent';document.getElementById('o').textContent=JSON.stringify(r,null,1);
    fetch(location.pathname+'?k=${k}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(r)}).catch(function(){})}
  setTimeout(send,4000);
})();
</script>`;
  return new NextResponse(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

export async function POST(req: NextRequest) {
  if (!espAuthorized(req)) return apiForbidden(req);
  const body = await req.text();
  await db.insert(auditLog).values({ accountId: "home", action: "display.probe", target: "nest-hub", status: "ok", message: body.slice(0, 4000) });
  return NextResponse.json({ ok: true });
}
