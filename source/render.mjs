// Deterministic animation renderer: draw(t) -> raw RGBA frames -> ffmpeg
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { spawn } from 'child_process';
import fs from 'fs';

GlobalFonts.registerFromPath('node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2', 'JBM');
GlobalFonts.registerFromPath('node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff2', 'JBM');

const W = 1920, H = 1080, FPS = 30;
const TL = JSON.parse(fs.readFileSync('timeline.json', 'utf8'));
const cv = createCanvas(W, H), ctx = cv.getContext('2d');
const layer = createCanvas(W, H), lx = layer.getContext('2d');

// ---------- palette ----------
const C = {
  bg: '#0A1120', bg2: '#0F1A30', grid: 'rgba(120,160,220,0.05)', text: '#E8EEF8', muted: '#8EA3C4',
  cyan: '#38BDF8', amber: '#F5A524', amberD: '#9A6412', green: '#34D399', pink: '#F472B6',
  red: '#F43F5E', stock: '#56657E', part1: '#A3B1C6', part2: '#66768F', white: '#FFFFFF', panel: '#111C33', line: '#22314F'
};
const F = (w, s) => `${w} ${s}px Inter`;
const M = (w, s) => `${w} ${s}px JBM`;

// ---------- math / timing ----------
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const prog = (t, a, b) => clamp((t - a) / (b - a));
const ease = u => u < .5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
const eout = u => 1 - Math.pow(1 - u, 3);
const lerp = (a, b, u) => a + (b - a) * u;
const D2R = Math.PI / 180;
const fadeIn = (t, a, d = .5) => eout(prog(t, a, a + d));
function cue(sc, name) { const l = sc.lines.find(l => l.cue === name); if (!l) throw new Error('cue ' + name); return l; }
function line(sc, i) { return sc.lines[i]; }
function mix(c1, c2, u) {
  const p = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
  const a = p(c1), b = p(c2);
  return '#' + a.map((v, i) => Math.round(lerp(v, b[i], u)).toString(16).padStart(2, '0')).join('');
}

// ---------- view: world mm (z right, x up) -> screen ----------
const view = (ox, oy, s) => ({ ox, oy, s, p: (z, x) => [ox + z * s, oy - x * s] });

// ---------- text ----------
function text(str, x, y, o = {}) {
  ctx.save();
  ctx.font = o.font || F(600, 32); ctx.fillStyle = o.color || C.text;
  ctx.textAlign = o.align || 'left'; ctx.textBaseline = o.base || 'alphabetic';
  ctx.globalAlpha *= (o.alpha ?? 1);
  if (o.bg) {
    const m = ctx.measureText(str), pad = o.pad ?? 14, h = o.h ?? 52;
    let x0 = x - (ctx.textAlign === 'center' ? m.width / 2 : ctx.textAlign === 'right' ? m.width : 0) - pad;
    ctx.fillStyle = o.bg; rr(x0, y - h * .68, m.width + pad * 2, h, o.r ?? 12); ctx.fill();
    if (o.stroke) { ctx.strokeStyle = o.stroke; ctx.lineWidth = 2; ctx.stroke(); }
    ctx.fillStyle = o.color || C.text;
  }
  ctx.fillText(str, x, y); ctx.restore();
}
function rr(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }
function card(x, y, w, h, o = {}) {
  ctx.save(); ctx.globalAlpha *= (o.alpha ?? 1);
  ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = 30; ctx.shadowOffsetY = 8;
  ctx.fillStyle = o.fill || C.panel; rr(x, y, w, h, o.r ?? 20); ctx.fill();
  ctx.shadowColor = 'transparent'; ctx.strokeStyle = o.stroke || C.line; ctx.lineWidth = o.lw || 2; ctx.stroke(); ctx.restore();
}

// ---------- geometry primitives ----------
function polyPath(g, V, pts) { g.beginPath(); pts.forEach(([z, x], i) => { const [a, b] = V.p(z, x); i ? g.lineTo(a, b) : g.moveTo(a, b); }); }
function arcPts(cz, cx, r, a0, a1, n = 40) { const o = []; for (let i = 0; i <= n; i++) { const a = lerp(a0, a1, i / n) * D2R; o.push([cz + r * Math.cos(a), cx + r * Math.sin(a)]); } return o; }
function dashLine(V, pts, color, lw = 3, dash = [14, 10], alpha = 1) {
  ctx.save(); ctx.globalAlpha *= alpha; ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.setLineDash(dash); ctx.lineCap = 'round';
  polyPath(ctx, V, pts); ctx.stroke(); ctx.restore();
}
function dot(x, y, r, color, ring) {
  ctx.save(); ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
  if (ring) { ctx.strokeStyle = color; ctx.globalAlpha *= .45; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(x, y, r + ring, 0, 7); ctx.stroke(); }
  ctx.restore();
}
function arrow(x1, y1, x2, y2, color, lw = 4, head = 18) {
  ctx.save(); ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = lw; ctx.lineCap = 'round';
  const a = Math.atan2(y2 - y1, x2 - x1);
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2 - Math.cos(a) * head * .6, y2 - Math.sin(a) * head * .6); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x2, y2); ctx.lineTo(x2 - head * Math.cos(a - .45), y2 - head * Math.sin(a - .45));
  ctx.lineTo(x2 - head * Math.cos(a + .45), y2 - head * Math.sin(a + .45)); ctx.closePath(); ctx.fill(); ctx.restore();
}

// Insert (rhombic, 80°) with nose centre (cz,cx) mm, radius R mm, tip bisector phi (deg, world)
function insert(V, cz, cx, R, phi = 225, o = {}) {
  const al = (o.angle ?? 80) * D2R / 2, L = o.L ?? 7.5;
  const u = a => [Math.cos(a), Math.sin(a)], ph = phi * D2R;
  const vd = R / Math.sin(al), Vz = cz + vd * Math.cos(ph), Vx = cx + vd * Math.sin(ph);
  const e1 = u(ph + Math.PI - al), e2 = u(ph + Math.PI + al), tl = R / Math.tan(al);
  const T1 = [Vz + tl * e1[0], Vx + tl * e1[1]], T2 = [Vz + tl * e2[0], Vx + tl * e2[1]];
  const A = [Vz + L * e1[0], Vx + L * e1[1]], B = [Vz + L * (e1[0] + e2[0]), Vx + L * (e1[1] + e2[1])], Cc = [Vz + L * e2[0], Vx + L * e2[1]];
  const a1 = Math.atan2(T2[1] - cx, T2[0] - cz), a0 = Math.atan2(T1[1] - cx, T1[0] - cz);
  let s0 = a0, s1 = a1; // arc from T2 to T1 through phi
  let d = s0 - s1; while (d < 0) d += 2 * Math.PI; // ccw from T2 to T1
  const midCcw = s1 + d / 2; const ok = Math.abs(Math.atan2(Math.sin(midCcw - ph), Math.cos(midCcw - ph))) < 1;
  const arc = []; const n = 30;
  for (let i = 0; i <= n; i++) { const a = ok ? s1 + d * i / n : s1 - (2 * Math.PI - d) * i / n; arc.push([cz + R * Math.cos(a), cx + R * Math.sin(a)]); }
  const pts = [T1, A, B, Cc, T2, ...arc];
  ctx.save(); ctx.globalAlpha *= (o.alpha ?? 1);
  if (o.shank) { // boring bar / holder
    ctx.fillStyle = '#334155'; polyPath(ctx, V, o.shank); ctx.closePath(); ctx.fill();
  }
  const g = ctx.createLinearGradient(...V.p(Vz, Vx), ...V.p(B[0], B[1]));
  g.addColorStop(0, '#FFC75A'); g.addColorStop(1, '#C27F14');
  ctx.fillStyle = o.fill || g; polyPath(ctx, V, pts); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = '#FFE2A3'; ctx.lineWidth = 2; ctx.stroke();
  // clamp hole
  const mz = (Vz + B[0]) / 2, mx = (Vx + B[1]) / 2, [hx, hy] = V.p(mz, mx);
  ctx.fillStyle = '#6B4A12'; ctx.beginPath(); ctx.arc(hx, hy, Math.max(4, L * V.s * .12), 0, 7); ctx.fill();
  ctx.restore();
  return { T1, T2, V: [Vz, Vx] };
}

// ---------- profiles: segments -> samples, offsets ----------
// seg: {L:[[z,x],[z,x]]} or {A:{c:[z,x], r, a0, a1}} (deg, ccw if a1>a0)
function segPts(s, n = 40) { if (s.L) return [s.L[0], s.L[1]]; const { c, r, a0, a1 } = s.A; return arcPts(c[0], c[1], r, a0, a1, n); }
function segDir(s, end) {
  if (s.L) { const [a, b] = s.L, l = Math.hypot(b[0] - a[0], b[1] - a[1]); return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; }
  const { a0, a1 } = s.A, a = (end ? a1 : a0) * D2R, sg = Math.sign(a1 - a0); return [-Math.sin(a) * sg, Math.cos(a) * sg];
}
const rightN = d => [d[1], -d[0]];
function profilePts(segs) { const o = []; segs.forEach((s, i) => { const p = segPts(s); o.push(...(i ? p.slice(1) : p)); }); return o; }
// Offset to the RIGHT of travel by R (tool-nose centre path with G42)
function offsetPts(segs, R) {
  const parts = segs.map(s => {
    if (s.L) { const n = rightN(segDir(s)); return s.L.map(p => [p[0] + R * n[0], p[1] + R * n[1]]); }
    const { c, r, a0, a1 } = s.A; const sg = Math.sign(a1 - a0); return arcPts(c[0], c[1], r + (sg > 0 ? R : -R), a0, a1);
  });
  const out = [...parts[0]];
  for (let i = 1; i < segs.length; i++) {
    const d1 = segDir(segs[i - 1], true), d2 = segDir(segs[i], false), cr = d1[0] * d2[1] - d1[1] * d2[0];
    const J = segs[i].L ? segs[i].L[0] : arcPts(segs[i].A.c[0], segs[i].A.c[1], segs[i].A.r, segs[i].A.a0, segs[i].A.a0, 1)[0];
    if (cr > 1e-6) { // convex: round join
      const n1 = rightN(d1), n2 = rightN(d2); let b0 = Math.atan2(n1[1], n1[0]) / D2R, b1 = Math.atan2(n2[1], n2[0]) / D2R;
      while (b1 < b0) b1 += 360; out.push(...arcPts(J[0], J[1], R, b0, b1, 16)); out.push(...parts[i]);
    } else if (cr < -1e-6 && segs[i - 1].L && segs[i].L) { // concave line-line: intersect
      const p1 = out[out.length - 2], q1 = out[out.length - 1], p2 = parts[i][0], q2 = parts[i][1];
      const X = isect(p1, q1, p2, q2); out[out.length - 1] = X; out.push(X, ...parts[i].slice(1));
    } else out.push(...parts[i]);
  }
  return out;
}
function isect(p1, p2, p3, p4) {
  const d = (p1[0] - p2[0]) * (p3[1] - p4[1]) - (p1[1] - p2[1]) * (p3[0] - p4[0]);
  const t = ((p1[0] - p3[0]) * (p3[1] - p4[1]) - (p1[1] - p3[1]) * (p3[0] - p4[0])) / d;
  return [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])];
}
// polyline: point at fraction u of length, plus partial polyline
function along(pts, u) {
  const L = [0]; for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const tot = L[L.length - 1], tgt = clamp(u) * tot; let i = 1; while (i < L.length - 1 && L[i] < tgt) i++;
  const f = (tgt - L[i - 1]) / ((L[i] - L[i - 1]) || 1);
  const p = [lerp(pts[i - 1][0], pts[i][0], f), lerp(pts[i - 1][1], pts[i][1], f)];
  return { p, part: [...pts.slice(0, i), p], dir: [pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]] };
}
// carve: stock zone coloured, minus swept nose along centre path
function carve(V, stock, part, cpath, R, zone, o = {}) {
  lx.clearRect(0, 0, W, H);
  lx.globalCompositeOperation = 'source-over'; lx.fillStyle = zone; polyPath(lx, V, stock); lx.closePath(); lx.fill();
  if (cpath && cpath.length > 1) {
    lx.globalCompositeOperation = 'destination-out'; lx.strokeStyle = '#000'; lx.lineWidth = 2 * R * V.s; lx.lineCap = 'round'; lx.lineJoin = 'round';
    polyPath(lx, V, cpath); lx.stroke();
  }
  lx.globalCompositeOperation = 'source-over';
  ctx.save(); ctx.globalAlpha *= (o.alpha ?? 1); ctx.drawImage(layer, 0, 0);
  const [, y0] = V.p(0, Math.max(...part.map(p => p[1]))), [, y1] = V.p(0, Math.min(...part.map(p => p[1])));
  const g = ctx.createLinearGradient(0, y0, 0, y1); g.addColorStop(0, C.part1); g.addColorStop(1, C.part2);
  ctx.fillStyle = g; polyPath(ctx, V, part); ctx.closePath(); ctx.fill();
  // hatch for section look
  ctx.save(); polyPath(ctx, V, part); ctx.closePath(); ctx.clip(); ctx.strokeStyle = 'rgba(255,255,255,.07)'; ctx.lineWidth = 2;
  for (let k = -H; k < W + H; k += 26) { ctx.beginPath(); ctx.moveTo(k, 0); ctx.lineTo(k - H, H); ctx.stroke(); }
  ctx.restore(); ctx.restore();
}
function sliverOverlay(V, stock, part, cpath, R, u) { // re-draw leftovers in red with alpha u
  if (u <= 0) return; carve(V, stock, part, cpath, R, C.red, { alpha: u });
}

// ---------- background & overlays ----------
function background() {
  const g = ctx.createRadialGradient(W * .5, H * .35, 100, W * .5, H * .5, W * .8); g.addColorStop(0, C.bg2); g.addColorStop(1, C.bg);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 60) { ctx.beginPath(); ctx.moveTo(x + .5, 0); ctx.lineTo(x + .5, H); ctx.stroke(); }
  for (let y = 0; y < H; y += 60) { ctx.beginPath(); ctx.moveTo(0, y + .5); ctx.lineTo(W, y + .5); ctx.stroke(); }
}
function chip(sc, idx, t) {
  if (sc.id === 'intro') return;
  const a = fadeIn(t, sc.start + 1.2, .5);
  ctx.save(); ctx.globalAlpha = a;
  ctx.font = F(700, 26); const lbl = String(idx).padStart(2, '0'), w = ctx.measureText(sc.title).width;
  card(56, 44, w + 120, 64, { r: 32, fill: 'rgba(17,28,51,.9)' });
  ctx.fillStyle = C.amber; ctx.beginPath(); ctx.arc(90, 76, 22, 0, 7); ctx.fill();
  text(lbl, 90, 85, { font: F(800, 22), color: '#1A1205', align: 'center' });
  text(sc.title, 128, 86, { font: F(700, 26) });
  ctx.restore();
  text('CNC Turning · Tool Nose Radius Compensation', W - 56, 84, { font: F(600, 20), color: C.muted, align: 'right', alpha: a * .8 });
}
function titleCard(sc, idx, t) {
  if (sc.id === 'intro') return;
  const u = prog(t, sc.start, sc.start + 1.7); if (u >= 1) return;
  const a = u < .15 ? u / .15 : u > .62 ? 1 - (u - .62) / .38 : 1;
  ctx.save(); ctx.globalAlpha = clamp(a);
  ctx.fillStyle = 'rgba(10,17,32,.86)'; ctx.fillRect(0, 0, W, H);
  text(`PART ${String(idx).padStart(2, '0')}`, W / 2, H / 2 - 40, { font: F(700, 28), color: C.amber, align: 'center' });
  text(sc.title, W / 2, H / 2 + 40, { font: F(800, 76), align: 'center' });
  ctx.restore();
}
function checkpointCard(sc, t) {
  if (!sc.checkpoint) return;
  const a = prog(t, sc.checkpoint, sc.checkpoint + .35) * (1 - prog(t, sc.end - .3, sc.end));
  if (a <= 0) return;
  const n = TL.checkpoints.find(c => c.scene === sc.id).questions.length;
  ctx.save(); ctx.globalAlpha = a; ctx.fillStyle = 'rgba(6,10,20,.82)'; ctx.fillRect(0, 0, W, H);
  card(W / 2 - 360, H / 2 - 170, 720, 340, { r: 28, stroke: C.amber, lw: 3 });
  ctx.fillStyle = C.amber; ctx.beginPath(); ctx.arc(W / 2, H / 2 - 70, 46, 0, 7); ctx.fill();
  text('?', W / 2, H / 2 - 50, { font: F(800, 58), color: '#1A1205', align: 'center' });
  text('Quick check', W / 2, H / 2 + 40, { font: F(800, 54), align: 'center' });
  text(`${n} question${n > 1 ? 's' : ''} — answer to continue`, W / 2, H / 2 + 100, { font: F(500, 28), color: C.muted, align: 'center' });
  ctx.restore();
}

// ---------- SCENES ----------
const R8 = 0.8;
const S = {};

S.intro = (t, sc) => {
  const l = sc.lines;
  const a0 = fadeIn(t, 0.2, .9);
  ctx.save(); ctx.globalAlpha = a0;
  text('CNC TURNING', 140, 300, { font: F(700, 30), color: C.amber });
  text('Tool Nose Radius', 136, 400, { font: F(800, 96) });
  text('Compensation', 136, 505, { font: F(800, 96) });
  text('G41 · G42 · G40', 140, 580, { font: M(700, 44), color: C.cyan });
  ctx.restore();
  // insert on right with nose radius highlight
  const V = view(1450, 560, 46);
  const wob = Math.sin(t * .8) * 4;
  insert(V, 0, 0, 1.2, 225 + wob, { L: 7, alpha: fadeIn(t, .5, 1) });
  const g = fadeIn(t, l[1].start, .6);
  if (g > 0) {
    const [x, y] = V.p(0, 0);
    ctx.save(); ctx.globalAlpha = g;
    ctx.strokeStyle = C.cyan; ctx.lineWidth = 4; ctx.setLineDash([10, 8]); ctx.beginPath(); ctx.arc(x, y, 1.2 * V.s, 0, 7); ctx.stroke(); ctx.setLineDash([]);
    dot(x, y, 7, C.cyan); arrow(x, y, x - 1.2 * V.s * .707, y + 1.2 * V.s * .707, C.cyan, 3, 14);
    text('nose radius R', x - 120, y + 140, { font: F(700, 32), color: C.cyan, align: 'center' });
    ctx.restore();
  }
  const items = ['Why tapers & arcs go wrong', 'How big the error is', 'G41 · G42 · G40 fix it'];
  items.forEach((s, i) => {
    const a = fadeIn(t, l[2].start + i * 1.3, .5); if (a <= 0) return;
    ctx.save(); ctx.globalAlpha = a; ctx.translate(0, (1 - a) * 20);
    card(140, 650 + i * 84, 620, 66, { r: 16 });
    dot(180, 683 + i * 84, 10, [C.red, C.amber, C.green][i]);
    text(s, 210, 694 + i * 84, { font: F(600, 30) }); ctx.restore();
  });
  const q = fadeIn(t, l[3].start, .5);
  if (q > 0) { ctx.save(); ctx.globalAlpha = q; ctx.fillStyle = C.amber; ctx.fillRect(142, 936, 8, 28); ctx.fillRect(156, 936, 8, 28); ctx.restore(); text('Quick checks pause the video', 182, 960, { font: F(700, 30), color: C.amber, alpha: q }); }
};

S.nose = (t, sc) => {
  const z = ease(prog(t, cue(sc, 'zoom').start, cue(sc, 'zoom').start + 1.5));
  const s = lerp(70, 170, z);
  const V = view(1000, 560, s);
  const R = R8;
  const touch = cue(sc, 'touch'), tan = cue(sc, 'tangents'), tip = cue(sc, 'tip'), last = sc.lines[5];
  // work surfaces (touched)
  const ta = fadeIn(t, touch.start, .6);
  if (ta > 0) {
    ctx.save(); ctx.globalAlpha = ta;
    // diameter surface below (x = -R), face at left (z = -R)
    const [x0, y0] = V.p(-R, -R);
    ctx.fillStyle = C.part2; ctx.fillRect(x0 - 900, y0, 2600, 500);
    ctx.fillStyle = C.part1; ctx.fillRect(x0 - 900, y0 - 380, 900, 880); // shoulder: face is its right side
    text('diameter → sets X', x0 + 170, y0 + 64, { font: F(700, 30), color: '#0A1120' });
    text('face → sets Z', x0 - 24, y0 - 330, { font: F(700, 30), color: '#0A1120', align: 'right' });
    ctx.restore();
  }
  insert(V, 0, 0, R, 225, { L: 3.0 });
  // radius callout
  const ra = fadeIn(t, cue(sc, 'zoom').start + 1.2, .5) * (1 - fadeIn(t, touch.start, .4));
  if (ra > 0) {
    const [cx, cy] = V.p(0, 0); ctx.save(); ctx.globalAlpha = ra;
    ctx.strokeStyle = C.cyan; ctx.lineWidth = 3; ctx.setLineDash([8, 7]); ctx.beginPath(); ctx.arc(cx, cy, R * s, 0, 7); ctx.stroke(); ctx.setLineDash([]);
    dot(cx, cy, 6, C.cyan); arrow(cx, cy, cx - R * s * .866, cy + R * s * .5, C.cyan, 3, 14);
    text('R', cx - R * s * .45, cy + 4, { font: F(800, 34), color: C.cyan, align: 'right' });
    const vals = ['0.4', '0.8', '1.2']; vals.forEach((v, i) => text(`R ${v} mm`, 160, 330 + i * 70, { font: M(700, 36), color: i === 1 ? C.amber : C.muted, alpha: ra }));
    ctx.restore();
  }
  // contact flashes
  if (ta > 0 && t < tan.start + .5) {
    const [bx, by] = V.p(0, -R), [lx_, ly] = V.p(-R, 0), pulse = .5 + .5 * Math.sin(t * 6);
    dot(bx, by, 9, C.white, 6 + pulse * 6); dot(lx_, ly, 9, C.white, 6 + pulse * 6);
  }
  // tangent lines
  const tg = ease(prog(t, tan.start, tan.start + 1.4));
  if (tg > 0) {
    dashLine(V, [[-R - 3, -R], [-R + 3 * tg + 2, -R]], C.pink, 4);
    dashLine(V, [[-R, -R - 2.5], [-R, -R + 4 * tg + 1]], C.pink, 4);
    dot(...V.p(0, -R), 8, C.white); dot(...V.p(-R, 0), 8, C.white);
  }
  const ti = fadeIn(t, tip.start, .6);
  if (ti > 0) {
    const [px, py] = V.p(-R, -R), pulse = .5 + .5 * Math.sin(t * 5);
    ctx.save(); ctx.globalAlpha = ti; dot(px, py, 12, C.pink, 8 + pulse * 8);
    text('IMAGINARY TOOL TIP', px - 60, py + 150, { font: F(800, 34), color: C.pink, align: 'right', bg: 'rgba(10,17,32,.88)' });
    // centre to tip distance
    const [cx, cy] = V.p(0, 0); ctx.strokeStyle = C.pink; ctx.lineWidth = 2; ctx.setLineDash([5, 6]); ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(px, py); ctx.stroke(); ctx.restore();
    text('— not on the tool', px - 60, py + 205, { font: F(700, 26), color: '#0A1120', align: 'right', alpha: ti });
  }
  const la = fadeIn(t, last.start, .6);
  if (la > 0) {
    const u = (t - last.start) / (last.end - last.start);
    card(1250, 800, 600, 170, { alpha: la, stroke: C.cyan });
    text('Compensation OFF:', 1285, 860, { font: F(700, 30), color: C.cyan, alpha: la });
    text('control drives the imaginary', 1285, 902, { font: F(600, 28), alpha: la });
    text('tip along the programmed path', 1285, 940, { font: F(600, 28), alpha: la });
  }
};

// error scene panels (local mm)
const P_STRAIGHT = { part: [[-12, -6], [4, -6], [4, 0], [-12, 0]], stock: [[-12, -6], [4, -6], [4, .5], [-12, .5]], path: [[6, 0], [-11, 0]], n: [0, 1] };
const P_FACE = { part: [[-12, -6], [0, -6], [0, 2], [-12, 2]], stock: [[-12, -6], [.5, -6], [.5, 2], [-12, 2]], path: [[0, 5], [0, -5]], n: [1, 0] };
const CH_SEGS = [{ L: [[3, -4], [0, -4]] }, { L: [[0, -4], [-4, 0]] }, { L: [[-4, 0], [-11, 0]] }];
const P_CHAMF = { part: [[-11, -8], [0, -8], [0, -4], [-4, 0], [-11, 0]], stock: [[-11, -8], [0, -8], [0, -3.293], [-3.793, .5], [-11, .5]], segs: CH_SEGS };
const AR_SEGS = [{ L: [[3, -4], [0, -4]] }, { A: { c: [-4, -4], r: 4, a0: 0, a1: 90 } }, { L: [[-4, 0], [-11, 0]] }];
const P_ARC = { part: [[-11, -8], [0, -8], ...arcPts(-4, -4, 4, 0, 90), [-11, 0]], stock: [[-11, -8], [0, -8], [0, -4], [.5, -4], ...arcPts(-4, -4, 4.5, 0, 90), [-11, .5]], segs: AR_SEGS };
const shift = pts => pts.map(p => [p[0] + R8, p[1] + R8]); // uncompensated nose centre = P + (R,R)

function drawToolAt(V, P, R, o = {}) { // P = imaginary tip (uncomp)
  const cz = P[0] + R, cx = P[1] + R; insert(V, cz, cx, R, 225, { L: 6, ...o });
  if (o.tip !== false) dot(...V.p(P[0], P[1]), 7, C.pink);
  return [cz, cx];
}
function panelUncomp(V, pn, u, sliver, label, t) {
  const prof = pn.segs ? profilePts(pn.segs) : pn.path;
  const cpts = shift(prof);
  const a = along(cpts, u), ap = along(prof, u);
  carve(V, pn.stock, pn.part, a.part, R8, C.stock);
  if (sliver > 0) sliverOverlay(V, pn.stock, pn.part, a.part, R8, sliver);
  dashLine(V, prof, C.cyan, 4, [16, 10]);
  insert(V, a.p[0], a.p[1], R8, 225, { L: 4 });
  dot(...V.p(ap.p[0], ap.p[1]), 8, C.pink, 6);
  // contact point = C - R*n (n: outward normal of profile under the tip)
  const d = ap.dir, l = Math.hypot(d[0], d[1]) || 1; const n = rightN([d[0] / l, d[1] / l]);
  const cp = [a.p[0] - R8 * n[0], a.p[1] - R8 * n[1]];
  dot(...V.p(cp[0], cp[1]), 9, C.white, 5);
  return { cp, P: ap.p, Cn: a.p };
}
S.error = (t, sc) => {
  const st = cue(sc, 'straight'), fa = cue(sc, 'face'), ch = cue(sc, 'chamfer'), sl = cue(sc, 'sliver'), ar = cue(sc, 'arc');
  const V = view(1080, 610, 56);
  const legend = () => {
    const y = 1030; const items = [[C.cyan, 'programmed path', 'dash'], [C.pink, 'imaginary tip', 'dot'], [C.white, 'actual cutting point', 'dot'], [C.red, 'material left', 'box']];
    let x = 160; items.forEach(([c, s, k]) => {
      if (k === 'dash') { ctx.save(); ctx.strokeStyle = c; ctx.lineWidth = 4; ctx.setLineDash([12, 8]); ctx.beginPath(); ctx.moveTo(x, y - 9); ctx.lineTo(x + 40, y - 9); ctx.stroke(); ctx.restore(); }
      else if (k === 'dot') dot(x + 20, y - 9, 9, c); else { ctx.fillStyle = c; ctx.fillRect(x + 6, y - 22, 28, 26); }
      text(s, x + 54, y, { font: F(600, 26), color: C.muted }); ctx.font = F(600, 26); x += 54 + ctx.measureText(s).width + 60;
    });
  };
  let pname, label, okTxt;
  if (t < fa.start) {
    const u = ease(prog(t, st.start, st.end));
    panelUncomp(V, P_STRAIGHT, u, 0); label = 'Straight turning (along Z)'; okTxt = ['error = 0', C.green];
  } else if (t < ch.start) {
    const u = ease(prog(t, fa.start, fa.end));
    panelUncomp(V, P_FACE, u, 0); label = 'Facing (along X)'; okTxt = ['error = 0', C.green];
  } else if (t < ar.start) {
    const u = ease(prog(t, ch.start, sl.start - .2) * .88 + prog(t, sl.start, sl.end) * .12);
    const sv = fadeIn(t, sl.start, .8);
    panelUncomp(V, P_CHAMF, u, sv * .95); label = '45° chamfer'; okTxt = sv > 0 ? ['material left!', C.red] : null;
    if (sv > 0) { // call-out arrow to sliver
      const [x, y] = V.p(-2.1, -1.4); ctx.save(); ctx.globalAlpha = sv; arrow(x + 260, y + 160, x + 18, y + 14, C.red, 4);
      text('sliver of extra material', x + 270, y + 200, { font: F(700, 30), color: C.red }); ctx.restore();
    }
  } else {
    const u = ease(prog(t, ar.start, ar.start + (ar.end - ar.start) * .7));
    const sv = fadeIn(t, ar.start + (ar.end - ar.start) * .72, .7);
    panelUncomp(V, P_ARC, u, sv * .95); label = 'Convex arc'; okTxt = sv > 0 ? ['oversize — max at 45°', C.red] : null;
    if (sv > 0) { const [x, y] = V.p(-4 + 4 * .707, -4 + 4 * .707); ctx.save(); ctx.globalAlpha = sv; arrow(x + 240, y - 120, x + 16, y - 10, C.red, 4); ctx.restore(); }
  }
  card(150, 170, 560, 120, {});
  text(label, 185, 224, { font: F(800, 36) });
  if (okTxt) text(okTxt[0], 185, 268, { font: F(700, 28), color: okTxt[1] });
  legend();
};

S.calc = (t, sc) => {
  const fo = cue(sc, 'formula'), gr = cue(sc, 'graph'), pk = cue(sc, 'peak'), ex = cue(sc, 'example'), last = sc.lines[4];
  // formula banner
  const fa = fadeIn(t, fo.start, .6);
  card(560, 140, 800, 120, { alpha: fa, stroke: C.amber });
  ctx.save(); ctx.globalAlpha = fa;
  text('e  =  R ( sin θ + cos θ − 1 )', 960, 220, { font: F(800, 52), align: 'center', color: C.amber });
  ctx.restore();
  // geometry at 45° (left)
  const V = view(470, 600, 110), R = R8, th = 45 * D2R;
  const gA = fadeIn(t, fo.start + .5, .8);
  ctx.save(); ctx.globalAlpha = gA;
  // programmed line through P(0,0) with normal (cos45, sin45)
  const dir = [-Math.sin(th), Math.cos(th)], n = [Math.cos(th), Math.sin(th)];
  const L = 2.4, Pp = [0, 0], Cn = [R, R];
  const e = R * (Math.sin(th) + Math.cos(th) - 1);
  const part = [[-L * dir[0] * -1 + 0, -L * dir[1] * -1], [L * dir[0], L * dir[1]], [L * dir[0] - 3 * n[0], L * dir[1] - 3 * n[1]], [-L * dir[0] - 3 * n[0], -L * dir[1] - 3 * n[1]]];
  const g = ctx.createLinearGradient(0, 400, 0, 900); g.addColorStop(0, C.part1); g.addColorStop(1, C.part2);
  // sliver band
  ctx.fillStyle = 'rgba(244,63,94,.75)'; polyPath(ctx, V, [[-L * dir[0], -L * dir[1]], [L * dir[0], L * dir[1]], [L * dir[0] + e * n[0], L * dir[1] + e * n[1]], [-L * dir[0] + e * n[0], -L * dir[1] + e * n[1]]]); ctx.closePath(); ctx.fill();
  ctx.fillStyle = g; polyPath(ctx, V, [[-L * dir[0], -L * dir[1]], [L * dir[0], L * dir[1]], [L * dir[0] - 1.6 * n[0], L * dir[1] - 1.6 * n[1]], [-L * dir[0] - 1.6 * n[0], -L * dir[1] - 1.6 * n[1]]]); ctx.closePath(); ctx.fill();
  dashLine(V, [[-L * dir[0], -L * dir[1]], [L * dir[0], L * dir[1]]], C.cyan, 4);
  insert(V, Cn[0], Cn[1], R, 225, { L: 2.2 });
  // tangents & P
  dashLine(V, [[-.9, 0], [1.6, 0]], C.pink, 2, [6, 6], .8); dashLine(V, [[0, -.9], [0, 1.6]], C.pink, 2, [6, 6], .8);
  dot(...V.p(0, 0), 9, C.pink); text('P', ...V.p(-.25, -.05), { font: F(800, 30), color: C.pink, align: 'right' });
  dot(...V.p(R, R), 6, C.green);
  const cp = [Cn[0] - R * n[0], Cn[1] - R * n[1]]; dot(...V.p(cp[0], cp[1]), 8, C.white);
  // dimension e
  const m0 = [-1.5 * dir[0], -1.5 * dir[1]], m1 = [m0[0] + e * n[0], m0[1] + e * n[1]];
  const [ax, ay] = V.p(...m0), [bx, by] = V.p(...m1);
  ctx.strokeStyle = C.white; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  text('e', bx - 30, by - 10, { font: F(800, 38), color: C.white, align: 'right' });
  text('θ = 45°', ...V.p(1.2, -2.2), { font: F(700, 30), color: C.muted });
  ctx.restore();
  // graph (right)
  const gx = 1060, gy = 860, gw = 700, gh = 460;
  const ga = fadeIn(t, gr.start, .5);
  if (ga > 0) {
    ctx.save(); ctx.globalAlpha = ga;
    card(gx - 90, gy - gh - 70, gw + 150, gh + 170, {});
    ctx.strokeStyle = C.muted; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(gx, gy - gh); ctx.lineTo(gx, gy); ctx.lineTo(gx + gw, gy); ctx.stroke();
    const ymax = .5, X = d => gx + d / 90 * gw, Y = v => gy - v / ymax * gh;
    [0, 15, 30, 45, 60, 75, 90].forEach(d => text(d + '°', X(d), gy + 38, { font: F(600, 22), color: C.muted, align: 'center' }));
    [0, .1, .2, .3, .4].forEach(v => text(v.toFixed(1), gx - 14, Y(v) + 8, { font: F(600, 22), color: C.muted, align: 'right' }));
    text('e / R', gx, gy - gh - 22, { font: F(700, 26), color: C.muted, align: 'center' });
    text('taper angle θ', gx + gw / 2, gy + 80, { font: F(700, 26), color: C.muted, align: 'center' });
    const u = ease(prog(t, gr.start + .2, gr.end + .6));
    ctx.strokeStyle = C.amber; ctx.lineWidth = 5; ctx.beginPath();
    for (let d = 0; d <= 90 * u; d += 1) { const v = Math.sin(d * D2R) + Math.cos(d * D2R) - 1; d ? ctx.lineTo(X(d), Y(v)) : ctx.moveTo(X(d), Y(v)); } ctx.stroke();
    dot(X(0), Y(0), 9, C.green); if (u > .98) dot(X(90), Y(0), 9, C.green);
    const pa = fadeIn(t, pk.start, .5);
    if (pa > 0) {
      ctx.globalAlpha = ga * pa; ctx.setLineDash([8, 8]); ctx.strokeStyle = C.red; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(X(45), gy); ctx.lineTo(X(45), Y(.4142)); ctx.lineTo(gx, Y(.4142)); ctx.stroke(); ctx.setLineDash([]);
      dot(X(45), Y(.4142), 12, C.red, 8);
      text('0.414 R', X(45) + 26, Y(.4142) - 22, { font: F(800, 36), color: C.red });
    }
    ctx.restore();
  }
  const ea = fadeIn(t, ex.start, .5);
  if (ea > 0) {
    card(120, 880, 760, 170, { alpha: ea, stroke: C.amber });
    text('R = 0.8 mm, θ = 45°', 155, 935, { font: F(700, 30), color: C.muted, alpha: ea });
    text('e = 0.414 × 0.8 ≈ 0.33 mm', 155, 985, { font: M(700, 36), color: C.amber, alpha: ea });
    const la = fadeIn(t, last.start, .5);
    text('on Ø:  2e / cos 45° ≈ 0.94 mm', 155, 1030, { font: M(700, 30), color: C.red, alpha: la });
  }
};

// comp vs no comp chamfer panel
function panelComp(V, pn, u) {
  const off = offsetPts(pn.segs, R8), a = along(off, u);
  carve(V, pn.stock, pn.part, a.part, R8, C.stock);
  dashLine(V, profilePts(pn.segs), C.cyan, 4);
  dashLine(V, a.part, C.green, 3, [3, 8]);
  insert(V, a.p[0], a.p[1], R8, 225, { L: 4 });
  dot(...V.p(a.p[0], a.p[1]), 6, C.green);
}
function lathe(cxS, cyS, mode, a, t, moveU) { // schematic: chuck left, bar, centre line
  ctx.save(); ctx.globalAlpha *= a;
  const L = 620, Rb = 150, x0 = cxS - L / 2;
  ctx.fillStyle = '#28354F'; rr(x0 - 120, cyS - 230, 120, 460, 10); ctx.fill(); // chuck
  ctx.fillStyle = '#3A4A6A'; [-180, 120].forEach(o => { rr(x0 - 40, cyS + o, 60, 60, 6); ctx.fill(); });
  text('CHUCK', x0 - 60, cyS + 270, { font: F(700, 20), color: C.muted, align: 'center' });
  const g = ctx.createLinearGradient(0, cyS - Rb, 0, cyS + Rb); g.addColorStop(0, C.part2); g.addColorStop(.35, C.part1); g.addColorStop(1, C.part2);
  ctx.fillStyle = g; ctx.fillRect(x0, cyS - Rb, L, 2 * Rb);
  if (mode === 'id') { // sectioned bore
    ctx.fillStyle = '#0D1628'; ctx.fillRect(x0 + 160, cyS - 80, L - 160, 160);
    ctx.save(); ctx.beginPath(); ctx.rect(x0, cyS - Rb, L, 2 * Rb); ctx.clip(); ctx.strokeStyle = 'rgba(255,255,255,.09)'; ctx.lineWidth = 2;
    for (let k = x0 - 300; k < x0 + L + 300; k += 22) { ctx.beginPath(); ctx.moveTo(k, cyS - Rb); ctx.lineTo(k - 300, cyS + Rb); ctx.stroke(); } ctx.restore();
    ctx.fillStyle = '#0D1628'; ctx.fillRect(x0 + 160, cyS - 80, L - 160, 160);
  }
  ctx.setLineDash([24, 8, 4, 8]); ctx.strokeStyle = C.muted; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x0 - 140, cyS); ctx.lineTo(x0 + L + 80, cyS); ctx.stroke(); ctx.setLineDash([]);
  text('CL', x0 + L + 100, cyS + 10, { font: F(700, 28), color: C.muted });
  const Vv = view(0, 0, 14);
  const tx = lerp(x0 + L - 40, x0 + 260, moveU);
  if (mode === 'od') {
    const ty = cyS - Rb; // nose touching top surface
    const Vt = view(tx, ty - 0.8 * 14, 14);
    insert(Vt, 0, 0, .8, 225, { L: 6 });
    // path & motion arrow
    ctx.strokeStyle = C.cyan; ctx.lineWidth = 4; ctx.setLineDash([14, 10]); ctx.beginPath(); ctx.moveTo(x0 + L, cyS - Rb); ctx.lineTo(x0 + 150, cyS - Rb); ctx.stroke(); ctx.setLineDash([]);
    arrow(tx - 40, ty - 150, tx - 180, ty - 150, C.cyan, 5);
    text('direction of travel', tx - 110, ty - 180, { font: F(600, 22), color: C.cyan, align: 'center' });
  } else {
    const ty = cyS - 80; // bore upper wall, tool below it
    const Vt = view(tx, ty + .8 * 14, 14);
    ctx.fillStyle = '#334155'; ctx.fillRect(tx + 30, ty + 30, 420, 50);
    insert(Vt, 0, 0, .8, 135, { L: 5 });
    ctx.strokeStyle = C.cyan; ctx.lineWidth = 4; ctx.setLineDash([14, 10]); ctx.beginPath(); ctx.moveTo(x0 + L, ty); ctx.lineTo(x0 + 170, ty); ctx.stroke(); ctx.setLineDash([]);
    arrow(tx - 40, cyS + 170 + 70, tx - 180, cyS + 170 + 70, C.cyan, 5);
    text('direction of travel', tx - 110, cyS + 290, { font: F(600, 22), color: C.cyan, align: 'center' });
  }
  text('+X', x0 - 175, cyS - 200, { font: F(700, 22), color: C.muted, align: 'center' }); arrow(x0 - 175, cyS - 120, x0 - 175, cyS - 190, C.muted, 3, 12);
  ctx.restore();
}
S.g4142 = (t, sc) => {
  const cm = cue(sc, 'comp'), g41 = cue(sc, 'g41'), g42 = cue(sc, 'g42'), od = cue(sc, 'od'), id = cue(sc, 'id');
  if (t < g41.start) {
    const a = fadeIn(t, sc.start + 1, .5);
    ctx.save(); ctx.globalAlpha = a;
    const V1 = view(560, 640, 40), V2 = view(1450, 640, 40);
    panelUncomp(V1, P_CHAMF, 1, .95);
    const u = ease(prog(t, cm.start + .5, sc.lines[1].end));
    panelComp(V2, P_CHAMF, u);
    card(150, 170, 640, 110, {}); text('Compensation OFF (G40)', 185, 238, { font: F(800, 34), color: C.red });
    card(1040, 170, 700, 110, {}); text('Compensation ON (G42)', 1075, 238, { font: F(800, 34), color: C.green });
    text('nose-centre path offset by R', 1075, 330, { font: F(600, 26), color: C.green });
    ctx.restore();
    return;
  }
  if (t < od.start) {
    // left/right of the direction of motion
    const a = fadeIn(t, g41.start, .5);
    ctx.save(); ctx.globalAlpha = a;
    const x0 = 560, y0 = 820, x1 = 1360, y1 = 340;
    ctx.strokeStyle = C.cyan; ctx.lineWidth = 6; ctx.setLineDash([18, 12]); ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); ctx.setLineDash([]);
    arrow(x1 - 120, y1 + 72, x1 + 20, y1 - 12, C.cyan, 6, 26);
    text('programmed profile', x1 - 360, y1 - 10, { font: F(600, 26), color: C.cyan });
    // observer arrows
    const dx = (x1 - x0), dy = (y1 - y0), l = Math.hypot(dx, dy), ux = dx / l, uy = dy / l, nlx = uy, nly = -ux; // left normal (screen)
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, rad = 70;
    const lA = fadeIn(t, g41.start + .3, .5), rA = fadeIn(t, g42.start, .5);
    const tool = (sx, sy, col, lab, al) => {
      ctx.save(); ctx.globalAlpha *= al; ctx.fillStyle = col; ctx.globalAlpha *= .9; ctx.beginPath(); ctx.arc(sx, sy, rad, 0, 7); ctx.fill();
      ctx.globalAlpha = a * al; text(lab, sx, sy + 16, { font: M(700, 44), color: '#0A1120', align: 'center' }); ctx.restore();
    };
    tool(mx - nlx * (rad + 8) * -1 - 0, my - nly * (rad + 8) * -1, C.amber, 'G41', lA);
    tool(mx - nlx * (rad + 8), my - nly * (rad + 8), C.green, 'G42', rA);
    text('LEFT of profile', mx + nlx * 200 - 40, my + nly * 200, { font: F(800, 34), color: C.amber, align: 'center', alpha: lA });
    text('RIGHT of profile', mx - nlx * 200 + 40, my - nly * 200 + 20, { font: F(800, 34), color: C.green, align: 'center', alpha: rA });
    // eye
    text('stand on the path, face the direction of travel', x0 - 20, y0 + 70, { font: F(600, 26), color: C.muted });
    const g40 = fadeIn(t, sc.lines[4].start, .5);
    card(1380, 760, 400, 110, { alpha: g40 }); text('G40 = cancel', 1580, 830, { font: M(700, 40), align: 'center', alpha: g40 });
    ctx.restore();
    return;
  }
  const oa = fadeIn(t, od.start, .5), ia = fadeIn(t, id.start, .5);
  const ou = ease(prog(t, od.start + .3, od.end + .5)), iu = ease(prog(t, id.start + .3, id.end + .5));
  lathe(540, 600, 'od', oa, t, ou);
  if (ia > 0) lathe(1440, 600, 'id', ia, t, iu);
  card(240, 860, 600, 110, { alpha: oa, stroke: C.green }); text('OD turning → G42', 540, 930, { font: M(700, 40), color: C.green, align: 'center', alpha: oa });
  card(1140, 860, 600, 110, { alpha: ia, stroke: C.amber }); text('ID boring → G41', 1440, 930, { font: M(700, 40), color: C.amber, align: 'center', alpha: ia });
  text('standard view: +X up, tool above centre line, travel toward chuck', 960, 200, { font: F(600, 28), color: C.muted, align: 'center', alpha: oa });
};

S.offsets = (t, sc) => {
  const pg = cue(sc, 'page'), co = cue(sc, 'codes'), ty = cue(sc, 'typical'), rL = sc.lines[1], wL = sc.lines[5];
  const pa = fadeIn(t, pg.start, .5);
  const mv = ease(prog(t, co.start, co.start + .8));
  const tx = lerp(360, 120, mv), tyy = lerp(220, 200, mv), sc_ = lerp(1, .78, mv);
  ctx.save(); ctx.globalAlpha = pa; ctx.translate(tx, tyy); ctx.scale(sc_, sc_);
  card(0, 0, 1200, 520, {});
  text('OFFSET / GEOMETRY', 40, 66, { font: M(700, 32), color: C.amber });
  const cols = ['NO.', 'X', 'Z', 'R', 'T'], cx = [40, 220, 520, 820, 1030];
  cols.forEach((c, i) => text(c, cx[i], 140, { font: M(700, 30), color: C.muted }));
  const rows = [['01', '-152.340', '-310.115', '0.800', '·'], ['02', '-148.905', '-296.420', '0.400', '·'], ['03', '-201.770', '-305.010', '0.800', '·'], ['04', '0.000', '0.000', '0.000', '0']];
  const rH = fadeIn(t, rL.start, .4), tH = fadeIn(t, co.start - .1, .4);
  rows.forEach((r, j) => {
    const y = 210 + j * 70;
    if (j === 0) { ctx.fillStyle = 'rgba(56,189,248,.08)'; ctx.fillRect(20, y - 46, 1160, 64); }
    r.forEach((v, i) => text(v, cx[i], y, { font: M(600, 32), color: C.text }));
  });
  if (rH > 0) { ctx.save(); ctx.globalAlpha = pa * rH; ctx.strokeStyle = C.cyan; ctx.lineWidth = 4; rr(cx[3] - 18, 162, 170, 66, 10); ctx.stroke(); text('nose radius', cx[3] + 66, 480, { font: F(700, 28), color: C.cyan, align: 'center' }); ctx.restore(); }
  if (tH > 0) { ctx.save(); ctx.globalAlpha = pa * tH; ctx.strokeStyle = C.pink; ctx.lineWidth = 4; rr(cx[4] - 22, 162, 140, 66, 10); ctx.stroke(); text('tip code', cx[4] + 50, 480, { font: F(700, 28), color: C.pink, align: 'center' }); ctx.restore(); }
  ctx.restore();
  // wear
  const wa = fadeIn(t, wL.start, .5);
  if (wa > 0) {
    card(120, 640, 940, 230, { alpha: wa, stroke: C.amber });
    ctx.save(); ctx.globalAlpha = wa;
    text('OFFSET / WEAR   01   R  0.020', 160, 710, { font: M(700, 30), color: C.amber });
    text('R used = 0.800 + 0.020 = 0.820', 160, 780, { font: M(700, 34) });
    text('no program edit needed', 160, 835, { font: F(600, 26), color: C.muted });
    ctx.restore();
  }
  // tip code compass (right)
  const ca = fadeIn(t, co.start + .3, .6);
  if (ca > 0) {
    ctx.save(); ctx.globalAlpha = ca;
    const ox = 1500, oy = 470, r = 190;
    card(ox - 300, oy - 300, 600, 640, {});
    ctx.strokeStyle = C.cyan; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(ox, oy, r * .55, 0, 7); ctx.stroke();
    for (let k = 0; k < 8; k++) {
      const a = k * 45 * D2R, ex = ox + Math.cos(a) * r, ey = oy - Math.sin(a) * r;
      ctx.strokeStyle = 'rgba(244,114,182,.5)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ex, ey); ctx.stroke();
      dot(ex, ey, 16, C.pink);
    }
    dot(ox, oy, 18, C.green); text('0 / 9', ox + 40, oy + 50, { font: M(700, 30), color: C.green, align: 'center' });
    text('nose centre', ox + 40, oy + 82, { font: F(600, 22), color: C.muted, align: 'center' });
    text('8 tip directions → codes 1–8', ox, oy + 300, { font: F(700, 28), color: C.pink, align: 'center' });
    // highlight OD direction (down-left) and boring (up-left)
    const ta = fadeIn(t, ty.start, .5);
    if (ta > 0) {
      const hl = (deg, col, lab, dy) => { const a = deg * D2R, ex = ox + Math.cos(a) * r, ey = oy - Math.sin(a) * r; dot(ex, ey, 24, col, 8); arrow(ox, oy, ex + Math.cos(a) * -26, ey - Math.sin(a) * -26, col, 5); text(lab, ex - 30, ey + dy, { font: F(800, 26), color: col, align: 'center' }); };
      ctx.globalAlpha = ca * ta; hl(225, C.amber, 'OD tool', 60); hl(135, C.green, 'boring bar', -40);
    }
    ctx.restore();
    const wa2 = fadeIn(t, ty.start + .8, .5);
    if (wa2 > 0) {
      card(1180, 960 - 40, 680, 90, { alpha: wa2, stroke: C.red });
      text('⚠ front/rear turret charts are mirrored — use YOUR chart', 1520, 978, { font: F(700, 24), color: C.text, align: 'center', alpha: wa2 });
    }
  }
};

// Program scene
const PROG = [
  ['N10 G21 G18 G40 G99', ''],
  ['N20 T0101', '(OD FINISH R0.8)'],
  ['N30 G50 S2500', ''],
  ['N40 G96 S200 M03', ''],
  ['N50 G00 G42 X20.0 Z3.0', '(COMP ON)'],
  ['N60 G01 Z0 F0.15', ''],
  ['N70 X30.0 Z-5.0', '(45° CHAMFER)'],
  ['N80 Z-25.0', ''],
  ['N90 X40.0', ''],
  ['N100 G03 X50.0 Z-30.0 R5.0', '(ARC)'],
  ['N110 G01 Z-40.0', ''],
  ['N120 G40 G00 X60.0', '(COMP OFF)'],
  ['N130 G00 Z50.0', ''],
  ['N140 M30', ''],
];
const PSEGS = [{ L: [[3, 10], [0, 10]] }, { L: [[0, 10], [-5, 15]] }, { L: [[-5, 15], [-25, 15]] }, { L: [[-25, 15], [-25, 20]] }, { A: { c: [-30, 20], r: 5, a0: 0, a1: 90 } }, { L: [[-30, 25], [-40, 25]] }];
const PPART = [[-46, 0], [0, 0], [0, 10], [-5, 15], [-25, 15], [-25, 20], ...arcPts(-30, 20, 5, 0, 90), [-46, 25]];
const PSTOCK = (() => { const o = offsetPts(PSEGS.slice(1), .6); return [[-46, 0], [0, 0], [0, 10.6], ...o.slice(1), [-46, 25.6]]; })();
const POFF = offsetPts(PSEGS, R8);
S.program = (t, sc) => {
  const cd = cue(sc, 'code'), su = cue(sc, 'startup'), na = cue(sc, 'noarc'), lk = cue(sc, 'lookahead'), cu = cue(sc, 'cutting'), ca = cue(sc, 'cancel');
  const longL = sc.lines[2];
  // listing
  card(70, 150, 760, 860, {});
  const hlLines = [];
  if (t >= su.start && t < na.start) hlLines.push(4);
  let cutU = ease(prog(t, cu.start - .2, cu.end + .2));
  if (t >= cu.start - .2 && t < ca.start) { const idx = cutU < .08 ? 5 : cutU < .3 ? 6 : cutU < .62 ? 7 : cutU < .7 ? 8 : cutU < .86 ? 9 : 10; hlLines.push(idx); }
  if (t >= ca.start) hlLines.push(11);
  PROG.forEach(([c, cm], i) => {
    const a = fadeIn(t, cd.start + i * .12, .3), y = 222 + i * 56;
    if (hlLines.includes(i)) { ctx.fillStyle = 'rgba(245,165,36,.16)'; ctx.fillRect(84, y - 38, 732, 52); ctx.fillStyle = C.amber; ctx.fillRect(84, y - 38, 6, 52); }
    let col = C.text; if (i === 4) col = C.green; if (i === 11) col = C.red;
    text(c, 110, y, { font: M(700, 28), color: col, alpha: a });
    if (cm) text(cm, 800, y, { font: M(400, 22), color: C.muted, align: 'right', alpha: a });
  });
  // toolpath view
  const V = view(1640, 830, 17.5);
  const R = R8;
  // tool centre position by phase
  const home = [6, 28], homeC = [home[0] + R, home[1] + R];
  let Cpos, cpath = [];
  const suU = ease(prog(t, su.start + .3, su.end));
  const startC = POFF[0];
  if (t < cu.start - .2) {
    Cpos = [lerp(homeC[0], startC[0], suU), lerp(homeC[1], startC[1], suU)];
  } else if (t < ca.start) {
    const a = along(POFF, cutU); Cpos = a.p; cpath = a.part;
  } else {
    const end = POFF[POFF.length - 1]; const cu2 = ease(prog(t, ca.start + .2, ca.end));
    const tgt = [-40 + R, 30 + R];
    Cpos = [lerp(end[0], tgt[0], cu2), lerp(end[1], tgt[1], cu2)]; cpath = POFF;
  }
  // clip view to right panel
  ctx.save(); ctx.beginPath(); ctx.rect(860, 150, 1000, 860); ctx.clip();
  card(860, 150, 1000, 860, {});
  carve(V, PSTOCK, PPART, cpath, R, C.stock);
  // centre line
  ctx.setLineDash([24, 8, 4, 8]); ctx.strokeStyle = C.muted; ctx.lineWidth = 2; const [, cly] = V.p(0, 0); ctx.beginPath(); ctx.moveTo(860, cly); ctx.lineTo(1860, cly); ctx.stroke(); ctx.setLineDash([]);
  dashLine(V, profilePts(PSEGS), C.cyan, 3, [10, 8]);
  if (t >= su.start) {
    dashLine(V, [homeC, startC], C.amber, 2, [4, 8], .7);
    if (cpath.length) dashLine(V, cpath, C.green, 3, [3, 7]);
  }
  insert(V, Cpos[0], Cpos[1], R, 225, { L: 6 });
  dot(...V.p(Cpos[0], Cpos[1]), 5, C.green);
  ctx.restore();
  // callouts
  const lA = fadeIn(t, longL.start, .4) * (1 - fadeIn(t, na.start, .3));
  if (lA > 0) { card(900, 180, 560, 140, { alpha: lA, stroke: C.amber }); text('start-up move  >  R', 930, 245, { font: M(700, 36), color: C.amber, alpha: lA }); text('straight move, in clear air', 930, 292, { font: F(600, 26), color: C.muted, alpha: lA }); }
  const nA = fadeIn(t, na.start, .4) * (1 - fadeIn(t, lk.start, .3));
  if (nA > 0) { card(900, 180, 900, 150, { alpha: nA, stroke: C.red }); text('×  G03 G42 X..  Z..  R..', 935, 245, { font: M(700, 36), color: C.red, alpha: nA }); text('comp ON/OFF on an arc → alarm', 935, 300, { font: F(600, 28), color: C.text, alpha: nA }); }
  const kA = fadeIn(t, lk.start, .4) * (1 - fadeIn(t, cu.start, .3));
  if (kA > 0) {
    card(900, 180, 900, 230, { alpha: kA, stroke: C.red });
    text('×  N61 M08', 935, 245, { font: M(700, 32), color: C.red, alpha: kA });
    text('×  N62 G04 X1.0', 935, 290, { font: M(700, 32), color: C.red, alpha: kA });
    text('×  N63 M01', 935, 335, { font: M(700, 32), color: C.red, alpha: kA });
    text('several non-motion blocks → look-ahead lost → gouge', 935, 385, { font: F(600, 26), color: C.text, alpha: kA });
  }
  const cA = fadeIn(t, cu.start + 1, .4) * (1 - fadeIn(t, ca.start, .3));
  if (cA > 0) { card(900, 180, 640, 100, { alpha: cA, stroke: C.green }); text('✓ chamfer & arc cut to size', 930, 245, { font: F(800, 34), color: C.green, alpha: cA }); }
};

S.summary = (t, sc) => {
  const items = [
    ['s1', C.red, 'No compensation', 'tapers & arcs cut wrong — up to 0.414 R at 45°'],
    ['s2', C.amber, 'Set R and T', 'nose radius + tip code (from your machine chart)'],
    ['s2', C.green, 'G42 OD · G41 ID', 'toward the chuck, standard view'],
    ['s2', C.cyan, 'Start & cancel on straight moves', 'clear of the part, longer than R · G40 to cancel'],
  ];
  items.forEach(([c, col, h, sub], i) => {
    const l = cue(sc, c); const a = fadeIn(t, l.start + (c === 's2' ? (i - 1) * 2.2 : 0), .5); if (a <= 0) return;
    const y = 200 + i * 175;
    ctx.save(); ctx.globalAlpha = a; ctx.translate((1 - a) * 40, 0);
    card(260, y, 1400, 145, {});
    ctx.fillStyle = col; rr(260, y, 14, 145, 7); ctx.fill();
    text(h, 320, y + 64, { font: F(800, 40) });
    text(sub, 320, y + 112, { font: F(500, 30), color: C.muted });
    ctx.restore();
  });
  const fa = fadeIn(t, cue(sc, 's3').start, .6);
  if (fa > 0) { ctx.save(); ctx.globalAlpha = fa; ctx.fillStyle = 'rgba(10,17,32,.88)'; ctx.fillRect(0, 0, W, H);
    dot(W / 2, 430, 70, C.green); text('✓', W / 2, 460, { font: F(800, 80), color: '#0A1120', align: 'center' });
    text('Lesson complete', W / 2, 600, { font: F(800, 72), align: 'center' });
    text('Your score and progress have been recorded', W / 2, 670, { font: F(500, 32), color: C.muted, align: 'center' }); ctx.restore(); }
};

// ---------- main ----------
function frame(t) {
  background();
  let idx = TL.scenes.findIndex(s => t >= s.start && t < s.end); if (idx < 0) idx = TL.scenes.length - 1;
  const sc = TL.scenes[idx];
  S[sc.id](t, sc);
  chip(sc, idx, t);
  checkpointCard(sc, t);
  titleCard(sc, idx, t);
}

const args = process.argv.slice(2);
if (args[0] === '--still') {
  fs.mkdirSync('build/stills', { recursive: true });
  for (const ts of args[1].split(',')) { frame(+ts); fs.writeFileSync(`build/stills/t${(+ts).toFixed(1).padStart(6, '0')}.png`, cv.toBuffer('image/png')); }
  console.log('stills done');
} else {
  const out = args[0] || 'site/assets/tnrc-lesson.mp4';
  const N = Math.ceil(TL.duration * FPS);
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(FPS), '-i', '-',
    '-i', 'audio/narration.wav', '-vf', 'scale=1280:720:flags=lanczos', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-g', '60',
    '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', '-shortest', out], { stdio: ['pipe', 'inherit', 'inherit'] });
  const t0 = Date.now();
  for (let f = 0; f < N; f++) {
    frame(f / FPS);
    if (!ff.stdin.write(cv.data())) await new Promise(r => ff.stdin.once('drain', r));
    if (f % 900 === 0) console.log(`frame ${f}/${N}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  ff.stdin.end(); await new Promise(r => ff.on('close', r)); console.log('done', out);
}
