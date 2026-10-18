// Vatra mark: ONE parametric source for every export (SVG, PNG, ICO, tray, motion).
// Geometry is authored on a 48-unit keyline grid. Three optical sizes:
//   master (>= 64 px)  stroke 4, two-tone flame, 3 puffs, floating walls
//   small  (24-48 px)  stroke 4.5, flame without core, 2 puffs
//   micro  (<= 20 px)  stroke 6 (= 2 px at 16), pixel-snapped verticals, 1 puff, walls closed
// Construction rules (see brand/logo/construction.svg):
//   - roof pitch 0.861 (40.7 deg), eaves overhang the walls by 5 units each side
//   - chimney's right edge sits on the right wall's axis (x = 37 / 36 micro)
//   - roof and walls are separated by a clear gap >= 1 stroke unit (the "floating roof")
//   - flame tip leans right, same direction the smoke drifts (wind reads consistently)
//   - smoke puffs shrink by 0.75 each step and rise along one gentle curve

export const PITCH = 15.5 / 18;

const roofY = (x, apexY, apexX = 24) => +(apexY + Math.abs(x - apexX) * PITCH).toFixed(2);

export const OPTICAL = {
  master: { stroke: 4, apexY: 13, eave: 6, wallL: 11, wallR: 37, wallTop: 31, base: 42, chimL: 30.2, chimTop: 9.5, puffs: 3, core: true },
  small: { stroke: 4.5, apexY: 13.5, eave: 5.5, wallL: 11, wallR: 37, wallTop: 31.5, base: 42, chimL: 29.6, chimTop: 9.5, puffs: 2, core: false },
  micro: { stroke: 6, apexY: 13.5, eave: 5, wallL: 12, wallR: 36, wallTop: 31.5, base: 41, chimL: 29.5, chimTop: 9, puffs: 1, core: false },
};

/** Path data for each part, per optical size. */
export function geometry(size = "master") {
  const g = OPTICAL[size];
  const s = g.stroke;
  const chimR = g.wallR;
  const roof = [
    `M${g.eave} ${roofY(g.eave, g.apexY)}`,
    `L24 ${g.apexY}`,
    `L${g.chimL} ${roofY(g.chimL, g.apexY)}`,
    `V${g.chimTop}`,
    `H${chimR}`,
    `V${roofY(chimR, g.apexY)}`,
    `L${48 - g.eave} ${roofY(48 - g.eave, g.apexY)}`,
  ].join(" ");
  const r = size === "micro" ? 0 : 2.5;
  const walls =
    r === 0
      ? `M${g.wallL} ${g.wallTop} V${g.base} H${g.wallR} V${g.wallTop}`
      : `M${g.wallL} ${g.wallTop} V${g.base - r} Q${g.wallL} ${g.base} ${g.wallL + r} ${g.base} H${g.wallR - r} Q${g.wallR} ${g.base} ${g.wallR} ${g.base - r} V${g.wallTop}`;
  // Flame: teardrop, base on the hearth line, tip leaning right (+1 unit).
  const fb = g.base - s / 2 - (size === "micro" ? 1.2 : 2.2); // bottom of flame
  const fw = size === "micro" ? 6.2 : 4.6; // half width
  const fh = size === "micro" ? 13 : 12; // height
  const ft = fb - fh;
  const flame = `M24 ${fb} C${24 - fw * 0.62} ${fb} ${24 - fw} ${fb - 1.9} ${24 - fw} ${fb - 4.5} C${24 - fw} ${fb - 7.6} ${21.6} ${fb - 8.7} ${23.1} ${ft} C${26.9} ${ft + 2.1} ${24 + fw} ${fb - 7.1} ${24 + fw} ${fb - 4.3} C${24 + fw} ${fb - 1.7} ${24 + fw * 0.6} ${fb} 24 ${fb} Z`;
  const core = g.core
    ? `M24 ${fb - 0.8} C22.6 ${fb - 0.8} 21.7 ${fb - 1.8} 21.7 ${fb - 3.1} C21.7 ${fb - 4.7} 22.9 ${fb - 5.4} 23.5 ${fb - 7.1} C25.3 ${fb - 6} 26.3 ${fb - 4.5} 26.3 ${fb - 3} C26.3 ${fb - 1.7} 25.3 ${fb - 0.8} 24 ${fb - 0.8} Z`
    : null;
  // Smoke: first puff clears the chimney cap by 1.2 units; drift bends (wind): dx 3.6 then 2.9,
  // dy 2.6 then 3.1, radius x0.75 per step.
  const capTop = g.chimTop - s / 2;
  const cx0 = (g.chimL + chimR) / 2 + 0.6;
  const r0 = size === "micro" ? 3 : 2.3;
  const puffs = [];
  for (let i = 0; i < g.puffs; i++) {
    const ri = +(r0 * 0.75 ** i).toFixed(2);
    const prev = puffs[i - 1];
    const dx = [3.6, 2.9][i - 1] ?? 2.9;
    const dy = [2.6, 3.1][i - 1] ?? 3.1;
    const cy = prev ? +(prev.cy - dy).toFixed(2) : +(capTop - 1.2 - ri).toFixed(2);
    const cx = prev ? +(prev.cx + dx).toFixed(2) : +cx0.toFixed(2);
    puffs.push({ cx, cy, r: ri });
  }
  const last = puffs[puffs.length - 1];
  const bbox = {
    x0: g.eave - s / 2,
    x1: Math.max(48 - g.eave + s / 2, last ? last.cx + last.r : 0),
    y0: Math.min(capTop, ...puffs.map((p) => p.cy - p.r)),
    y1: g.base + s / 2,
  };
  return { roof, walls, flame, core, puffs, stroke: s, bbox, houseCx: 24 };
}

// ---------- colour ----------
export function oklchToHex(L, C, h) {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return (
    "#" +
    lin
      .map((x) => {
        const v = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.max(x, 0) ** (1 / 2.4) - 0.055;
        return Math.round(Math.min(1, Math.max(0, v)) * 255)
          .toString(16)
          .padStart(2, "0");
      })
      .join("")
  );
}

export const COLOURWAYS = {
  // on dark surfaces
  dark: { line: [0.95, 0.015, 70], flame: [0.7, 0.16, 48], core: [0.88, 0.1, 78], smoke: [0.95, 0.015, 70], tile: [0.2, 0.018, 50] },
  // on light surfaces
  light: { line: [0.24, 0.03, 45], flame: [0.6, 0.17, 45], core: [0.84, 0.12, 75], smoke: [0.24, 0.03, 45], tile: [0.985, 0.008, 70] },
  monoWhite: { line: [1, 0, 0], flame: [1, 0, 0], core: null, smoke: [1, 0, 0], tile: null },
  monoBlack: { line: [0.12, 0, 0], flame: [0.12, 0, 0], core: null, smoke: [0.12, 0, 0], tile: null },
};

const hex = (c) => (c ? oklchToHex(...c) : "none");

/**
 * Build a standalone SVG.
 * opts: size (optical), way (colourway key or object), tile (bool, rounded-square bg),
 *       smoke ("neutral" | "ember"), state (null|"ok"|"warn"|"down"|"active") for tray badges,
 *       px (output pixel size hint for width/height attrs), pad (tile padding in units)
 */
export function svg({ size = "master", way = "dark", tile = false, smoke = "neutral", state = null, px = 48, pad = 5, mask = null, classes = false } = {}) {
  const g = geometry(size);
  const c = typeof way === "string" ? COLOURWAYS[way] : way;
  const smokeCol = smoke === "ember" ? c.flame : c.smoke;
  const smokeOp = smoke === "ember" ? [1, 0.8, 0.6] : [0.95, 0.7, 0.45];
  // Fit the analytic bbox into the box (tile inner area, or the whole 48 with a 1-unit margin).
  // Horizontal: centre on the HOUSE axis (x=24), not the bbox, so smoke trails off to the right
  // like a real chimney instead of dragging the house left; clamp so the last puff stays inside.
  // Vertical: bbox centred, then lifted 2 % (optical centre sits above the geometric one).
  const view = 48;
  const off = tile ? pad : 1;
  const inner = view - off * 2;
  const b = g.bbox;
  const k = Math.min(inner / (b.y1 - b.y0), inner / (2 * Math.max(24 - b.x0, b.x1 - 24)));
  let tx = 24 - 24 * k;
  tx = Math.min(tx, off + inner - b.x1 * k);
  const ty = off + (inner - (b.y1 - b.y0) * k) / 2 - b.y0 * k - inner * 0.02;
  const cls = (n) => (classes ? ` class="vt-${n}"` : "");
  const parts = [
    `<path${cls("roof")}${classes ? ' pathLength="100"' : ""} d="${g.roof}" fill="none" stroke="${hex(c.line)}" stroke-width="${g.stroke}" stroke-linecap="round" stroke-linejoin="round"/>`,
    `<path${cls("walls")}${classes ? ' pathLength="100"' : ""} d="${g.walls}" fill="none" stroke="${hex(c.line)}" stroke-width="${g.stroke}" stroke-linecap="round" stroke-linejoin="round"/>`,
    `<path${cls("flame")} d="${g.flame}" fill="${hex(c.flame)}"/>`,
    g.core && c.core ? `<path${cls("core")} d="${g.core}" fill="${hex(c.core)}"/>` : "",
    ...g.puffs.map((p, i) => `<circle${cls(`puff vt-p${i + 1}`)} cx="${p.cx}" cy="${p.cy}" r="${p.r}" fill="${hex(smokeCol)}" fill-opacity="${size === "micro" ? 1 : smokeOp[i]}"/>`),
  ].join("");
  const bg = tile && c.tile ? `<rect width="48" height="48" rx="${mask === "circle" ? 24 : 10.5}" fill="${hex(c.tile)}"/>` : "";
  const badge = state ? stateBadge(state) : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${view} ${view}" width="${px}" height="${px}">${bg}<g transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${k.toFixed(4)})">${parts}</g>${badge}</svg>`;
}

const STATE = { ok: [0.72, 0.17, 150], warn: [0.8, 0.16, 80], down: [0.62, 0.21, 25], active: [0.7, 0.16, 48] };
function stateBadge(state) {
  return `<circle cx="38" cy="38" r="9" fill="#000" fill-opacity="0.55"/><circle cx="38" cy="38" r="7" fill="${hex(STATE[state])}"/>`;
}
