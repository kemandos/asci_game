'use strict';
// ---------------------------------------------------------------------------
// Core constants & small helpers shared by every other script.
// ---------------------------------------------------------------------------

const TICK_MS = 50;                 // game logic runs at 20 ticks per second
const COLS = 80, ROWS = 36;         // character grid of the whole screen
const VIEW_W = 80, VIEW_H = 28;     // map viewport (in cells)
const VIEW_Y = 2;                   // first screen row of the viewport
const FONT_STACK = "'DejaVu Sans Mono', Menlo, Consolas, 'Liberation Mono', 'Courier New', monospace";

// 8 directions, clockwise starting East (screen y grows downward)
const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

function dirIndex(dx, dy) {
  if (!dx && !dy) return -1;
  const a = Math.atan2(dy, dx);
  return ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
}
function cheb(ax, ay, bx, by) { return Math.max(Math.abs(ax - bx), Math.abs(ay - by)); }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function angDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// --- seeded RNG (mulberry32) ----------------------------------------------
function makeRNG(seed) {
  let s = (seed >>> 0) || 1;
  const r = () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  r.int = (a, b) => a + Math.floor(r() * (b - a + 1));
  r.range = (a, b) => a + r() * (b - a);
  r.pick = arr => arr[Math.floor(r() * arr.length)];
  r.chance = p => r() < p;
  r.weighted = list => { // list: [[item, weight], ...]
    let total = 0;
    for (const [, w] of list) total += w;
    let x = r() * total;
    for (const [it, w] of list) if ((x -= w) < 0) return it;
    return list[list.length - 1][0];
  };
  return r;
}
const R = makeRNG((Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0);

function hashStr(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function hash2(x, y, s) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul((s | 0) + 1, 982451653);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// --- lines -----------------------------------------------------------------
// Points from (x0,y0) to (x1,y1), excluding the start point.
function bresenham(x0, y0, x1, y1) {
  const pts = [];
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy, x = x0, y = y0, guard = 0;
  while (!(x === x1 && y === y1) && guard++ < 400) {
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
    pts.push([x, y]);
  }
  return pts;
}
// A ray from (x0,y0) through (x1,y1), `len` cells long (chebyshev).
function rayTo(x0, y0, x1, y1, len) {
  const dx = x1 - x0, dy = y1 - y0;
  const m = Math.max(Math.abs(dx), Math.abs(dy)) || 1;
  return bresenham(x0, y0, Math.round(x0 + dx / m * len), Math.round(y0 + dy / m * len));
}
function rayAngle(x0, y0, ang, len) {
  const sx = Math.round(x0), sy = Math.round(y0);
  return bresenham(sx, sy, Math.round(x0 + Math.cos(ang) * len), Math.round(y0 + Math.sin(ang) * len));
}

// --- rotating attack shapes ------------------------------------------------
// Shapes are written facing East. To face another of the 8 directions we
// rotate every offset around its own chebyshev "ring", which keeps shapes
// exact on a square grid (45 degrees == r steps around a ring of radius r).
function ringIndex(x, y, r) {
  if (x === r && y >= 0) return y;
  if (y === r) return r + (r - x);
  if (x === -r) return 3 * r + (r - y);
  if (y === -r) return 5 * r + (x + r);
  return 7 * r + (y + r);
}
function ringPos(i, r) {
  const n = 8 * r;
  i = ((i % n) + n) % n;
  if (i <= r) return [r, i];
  if (i <= 3 * r) return [r - (i - r), r];
  if (i <= 5 * r) return [-r, r - (i - 3 * r)];
  if (i <= 7 * r) return [-r + (i - 5 * r), -r];
  return [r, -r + (i - 7 * r)];
}
function rotOff(dx, dy, d) {
  const r = Math.max(Math.abs(dx), Math.abs(dy));
  if (!r) return [0, 0];
  return ringPos(ringIndex(dx, dy, r) + d * r, r);
}

// --- colours ---------------------------------------------------------------
let TINT = [1, 1, 1];   // global colour multiplier (blood moon etc.)
const _colCache = new Map();
function C(hex) {
  let c = _colCache.get(hex);
  if (!c) {
    let h = hex.replace('#', '');
    if (h.length === 3) h = h.split('').map(ch => ch + ch).join('');
    const n = parseInt(h, 16);
    c = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    _colCache.set(hex, c);
  }
  return c;
}
function shade(c, k) {
  const r = Math.min(255, c[0] * k * TINT[0]) | 0;
  const g = Math.min(255, c[1] * k * TINT[1]) | 0;
  const b = Math.min(255, c[2] * k * TINT[2]) | 0;
  return `rgb(${r},${g},${b})`;
}
function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function wrap(text, width) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      if (line && (line + ' ' + word).length > width) { out.push(line); line = word; }
      else line = line ? line + ' ' + word : word;
    }
    out.push(line);
  }
  return out;
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
