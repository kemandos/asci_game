'use strict';
// ---------------------------------------------------------------------------
// Isometric ASCII view. Replaces the top-down map drawing of render.js when
// G.view === 'iso' (the default; KeyT toggles). Game logic is untouched: the
// same tile grid, seen from an angle.
//
// Projection (character cells, ~10x19 px): a map tile (x, y) becomes a 4-cell
// wide "slab" on screen row (x + y), starting at column 2 * (x - y). One step
// along a map axis moves 2 columns and 1 row (~45 degrees on screen), so the
// floor reads as a staggered cobblestone lattice and walls rise from it.
//
// Two passes, both back-to-front by depth s = x + y (painter's algorithm):
//   1. ground: flat slabs (floor, telegraph and preview highlights, items),
//   2. upright: walls, props, lamps, creatures, the hunter, slashes.
// Upright things only paint rows at or above their own slab, so the ground
// never covers them. Walls in front of the hunter are cut down to stubs, and
// creatures still hidden by a wall are redrawn as an x-ray silhouette.
// The view is drawn into its own buffer with a 2-cell margin so the camera
// can glide at sub-cell precision (smooth scrolling) inside the viewport.
// ---------------------------------------------------------------------------

const ISO_M = 2;                                  // buffer margin (cells)
const ISO_W = VIEW_W + ISO_M * 2, ISO_H = VIEW_H + ISO_M * 2;
const ISO_CX = ISO_M + 39;                        // buffer column of the hunter's slab
const ISO_CY = ISO_M + 15;                        // buffer row of the hunter's feet
const ISO_KIND_FLOOR = 1, ISO_KIND_WALL = 2, ISO_KIND_ENT = 3;

const ISO = {
  ch: new Array(ISO_W * ISO_H).fill(' '),
  fg: new Array(ISO_W * ISO_H).fill(null),
  bg: new Array(ISO_W * ISO_H).fill(null),
  z: new Int32Array(ISO_W * ISO_H),
  kd: new Uint8Array(ISO_W * ISO_H),
  camC: 0, camR: 0, camCi: 0, camRi: 0, fx: 0, fy: 0, mapRef: null, last: 0,
  // per-map scratch: telegraph intensity / kind, attack preview
  tele: null, teleK: null, prev: null, touched: [],
  // painter buckets: drawables indexed by depth
  bk: [], s0: 0, s1: 0,
  // x-ray pass state
  xray: false, xz: 0, ghostFg: null,
  glows: [], embers: [], bars: [],
  anim: new WeakMap(),
  pl: { act: 0, at: -1e9, dur: 1, kind: '', flip: 1 },
  sky: 0,                                          // 0 none, 1 dream mist, 2 field night
  pal: {},
};

// ---------------------------------------------------------------------------
// view toggle + input rotation
// ---------------------------------------------------------------------------
function isoActive(g) {
  g = g || (typeof G !== 'undefined' ? G : null);
  return !!(g && g.view !== 'top');
}
function isoToggleView() {
  if (typeof G === 'undefined') return;
  G.view = isoActive(G) ? 'top' : 'iso';
  try { localStorage.setItem('bloodborne-ascii-view', G.view); } catch (e) { /* ignore */ }
  ISO.mapRef = null;  // snap the camera
  try { if (typeof log === 'function' && G.map) log(G.view === 'iso' ? 'View: isometric. [T] toggles.' : 'View: top-down. [T] toggles.', '#8a8a9a'); } catch (e) { /* ignore */ }
}
(function isoInit() {
  if (typeof G === 'undefined') return;
  let v = null;
  try { v = localStorage.getItem('bloodborne-ascii-view'); } catch (e) { v = null; }
  if (G.view !== 'top' && G.view !== 'iso') G.view = v === 'top' ? 'top' : 'iso';
})();

// In the isometric view the screen axes are the map diagonals. Rotate the held
// direction so W/Up walks up the screen, D/Right walks right, and diagonal key
// combos become the map's cardinal steps. Wraps game.js's heldDir() (also used
// by the quickstep), so keyboard, numpad and the gamepad stick all follow.
function isoScreenToMap(dx, dy) {
  // screen right = map (1,-1), screen down = map (1,1)
  const mx = Math.sign(dx + dy), my = Math.sign(dy - dx);
  return mx || my ? [mx, my] : null;
}
if (typeof heldDir === 'function') {
  const isoBaseHeldDir = heldDir;
  heldDir = function () {
    const d = isoBaseHeldDir();
    if (!d || !isoActive()) return d;
    return isoScreenToMap(d[0], d[1]);
  };
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------
const ISO_MIRROR = {
  '/': '\\', '\\': '/', '(': ')', ')': '(', '<': '>', '>': '<', '[': ']', ']': '[', '{': '}', '}': '{',
  '▌': '▐', '▐': '▌', '▖': '▗', '▗': '▖', '▘': '▝', '▝': '▘', '▙': '▟', '▟': '▙', '▛': '▜', '▜': '▛',
  '◢': '◣', '◣': '◢', '◤': '◥', '◥': '◤', '┐': '┌', '┌': '┐', '┘': '└', '└': '┘', '╱': '╲', '╲': '╱',
  '¬': '⌐', '⌐': '¬', 'P': 'q', 'q': 'P', 'd': 'b', 'b': 'd', '╗': '╔', '╔': '╗', '╝': '╚', '╚': '╝',
  '▞': '▚', '▚': '▞', '«': '»', '»': '«', '7': 'r', 'r': '7', 'ɾ': 'ɿ', 'ɿ': 'ɾ',
};
function isoMirror(ch) { return ISO_MIRROR[ch] || ch; }

// cached css colours (the iso view creates thousands of colours per frame)
const ISO_CSS = new Map();
function isoRGB(c, k) {
  let r = (c[0] * k) | 0, g = (c[1] * k) | 0, b = (c[2] * k) | 0;
  r = r < 0 ? 0 : r > 255 ? 255 : r; g = g < 0 ? 0 : g > 255 ? 255 : g; b = b < 0 ? 0 : b > 255 ? 255 : b;
  const key = (r << 16) | (g << 8) | b;
  let s = ISO_CSS.get(key);
  if (s === undefined) {
    s = `rgb(${r},${g},${b})`;
    if (ISO_CSS.size > 60000) ISO_CSS.clear();
    ISO_CSS.set(key, s);
  }
  return s;
}
// world colour: lit by k and tinted by the blood moon (TINT), like util.js shade()
function isoShade(c, k) {
  ISO_T4[0] = c[0] * TINT[0]; ISO_T4[1] = c[1] * TINT[1]; ISO_T4[2] = c[2] * TINT[2];
  return isoRGB(ISO_T4, k);
}
const ISO_T4 = [0, 0, 0];

function isoK(b) { return 0.18 + 1.1 * Math.min(1.1, b); }

// rgb array scaled; reuse a scratch triple to avoid allocations
const ISO_T3 = [0, 0, 0];
function isoScale(c, k) { ISO_T3[0] = c[0] * k; ISO_T3[1] = c[1] * k; ISO_T3[2] = c[2] * k; return ISO_T3; }
function isoMem(c, k) {      // remembered tile colour: blue-grey, untinted
  const r = c[0] * 0.38 + RND_MEM[0] * 0.62, g = c[1] * 0.38 + RND_MEM[1] * 0.62, b = c[2] * 0.38 + RND_MEM[2] * 0.62;
  ISO_T4[0] = r; ISO_T4[1] = g; ISO_T4[2] = b;
  return isoRGB(ISO_T4, k);
}

// ---------------------------------------------------------------------------
// buffer
// ---------------------------------------------------------------------------
function isoClear() {
  ISO.ch.fill(' '); ISO.fg.fill(null); ISO.bg.fill(null); ISO.z.fill(-1e6); ISO.kd.fill(0);
}
function isoPut(bx, by, ch, fg, bg, z, kd) {
  if (bx < 0 || by < 0 || bx >= ISO_W || by >= ISO_H) return;
  const i = by * ISO_W + bx;
  if (ISO.xray) {
    // silhouette pass: only over wall cells painted after (in front of) the creature
    if (ISO.kd[i] !== ISO_KIND_WALL || ISO.z[i] <= ISO.xz || ch === ' ') return;
    ISO.ch[i] = ch; ISO.fg[i] = ISO.ghostFg;
    return;
  }
  if (ch !== null) { ISO.ch[i] = ch; ISO.fg[i] = fg; }
  if (bg) ISO.bg[i] = bg;
  ISO.z[i] = z; ISO.kd[i] = kd;
}
function isoBgAt(bx, by, bg) {
  if (bx < 0 || by < 0 || bx >= ISO_W || by >= ISO_H) return;
  ISO.bg[by * ISO_W + bx] = bg;
}

// sprite: { rows:[str], pal:[str], w, h, ax } — bottom row sits on the slab row,
// column `ax` of the art sits on the creature's centre column.
function SPR(rows, pal, ax) {
  const w = rows.reduce((n, r) => Math.max(n, r.length), 0);
  rows = rows.map(r => r.padEnd(w, ' '));
  pal = (pal || rows.map(r => r.replace(/[^ ]/g, 'a'))).map(r => r.padEnd(w, 'a'));
  return { rows, pal, w, h: rows.length, ax: ax === undefined ? (w >> 1) : ax };
}
// draw a sprite; colours come from palette map `P` (key -> css colour)
function isoSprite(sp, cc, br, flip, P, z, kd) {
  const top = br - sp.h + 1;
  for (let r = 0; r < sp.h; r++) {
    const row = sp.rows[r], pr = sp.pal[r];
    const y = top + r;
    if (y < 0 || y >= ISO_H) continue;
    for (let c = 0; c < sp.w; c++) {
      let ch = row[c];
      if (ch === ' ') continue;
      const off = c - sp.ax;
      const x = cc + (flip < 0 ? -off : off);
      if (flip < 0) ch = isoMirror(ch);
      const col = P[pr[c]] || P.a;
      isoPut(x, y, ch, col, ch === '█' && !ISO.xray ? col : undefined, z, kd);
    }
  }
}

// ---------------------------------------------------------------------------
// art
// ---------------------------------------------------------------------------
const ISO_ART = {
  hunter: SPR(['▄▲▄', '/█\\', '/▀\\'], ['hhh', 'cac', 'dad']),
  huntsman: SPR([' ● ', '/█\\', '/ \\'], [' s ', 'bab', 'd d']),
  rifle: SPR([' ▄ ', '▐█▌', '/ \\'], [' h ', 'bab', 'd d']),
  dog: SPR(['    ▗▖', '\\▄▄▄█▘', ' ▌ ▌  '], ['    aa', 'baaaae', ' d d  '], 3),
  crow: [SPR(['\\v/'], ['beb']), SPR(['_v_'], ['beb'])],
  beast: SPR([' ▄▄▀▄ ', '▐██▀█▌', '▐███▌ ', '▐▌ ▐▌ '], [' aaea ', 'baaaab', 'baaab ', 'dd dd '], 2),
  patient: SPR([' ō ', '/█▌', '/ \\'], [' s ', 'bab', 'd d']),
  servant: SPR([' ▲ ', ' █ ', '/█\\', '▟█▙'], [' a ', ' s ', 'bab', 'bbb']),
  troll: SPR([' ▄█▄ ', '▐█▀█▌', '▐███▌', '▐▀ ▀▌'], [' aea ', 'baaab', 'baaab', 'dd dd']),
  giant: SPR(['  ▲  ', ' ▐█▌ ', '/███\\', '▐███▌', ' █ █ '], ['  a  ', ' bsb ', 'baaab', 'baaab', ' d d ']),
  generic: SPR(['?'], ['a']),
  // bosses (art scaled to the footprint)
  cleric: SPR([
    ' \\Y/   \\Y/ ',
    '  \\▄▄█▄▄/  ',
    '  ▐█▀O▀█▌  ',
    ' ▄███████▄ ',
    '▐▌▐██ ██▌▐▌',
    ' ▀ ▀▀ ▀▀ ▀ ',
  ], [
    ' xxx   xxx ',
    '  xaaaaax  ',
    '  aaaeaaa  ',
    ' baaaaaaab ',
    'bbbaa aabbb',
    ' d dd dd d ',
  ]),
  gascoigne: SPR(['▄▀▄', '▐█▌', '▐█▌', '▐ ▌'], ['hhh', 'cac', 'cac', 'd d']),
  gascoigne2: SPR([' ▄▲ ▲▄ ', '▐█▀█▀█▌', '▄█████▄', '█▌███▐█', '▀ ▀ ▀ ▀'], [' aa aa ', 'baeaeab', 'baaaaab', 'bbaaabb', 'd d d d']),
  amelia: SPR([
    '   ▄▲ ▲▄   ',
    '  ▐█▀█▀█▌  ',
    ' ▄███████▄ ',
    '▐█▌█████▐█▌',
    '▐▌ ██ ██ ▐▌',
    '▀▀ ▀▀ ▀▀ ▀▀',
  ], [
    '   aa aa   ',
    '  aaeaeaa  ',
    ' baaaaaaab ',
    'bbbaaaaabbb',
    'bb aa aa bb',
    'dd dd dd dd',
  ]),
  gehrman: SPR(['▄▲▄', '▐█▌', '▐█▌', '▐ ▌'], ['hhh', 'cac', 'cac', 'd d']),
  moon: SPR([
    '\\  \\  ║  /  /',
    ' \\ ▄▄███▄▄ / ',
    '══▐█▀▀O▀▀█▌══',
    '  ▐███████▌  ',
    ' / ▀█▀█▀█▀ \\ ',
    '/  / ║ ║ \\  \\',
    '  /  ║ ║  \\  ',
  ], [
    'b  b  b  b  b',
    ' b aaaaaaa b ',
    'bbaaaaeaaaabb',
    '  aaaaaaaaa  ',
    ' b aaaaaaa b ',
    'b  b b b b  b',
    '  b  b b  b  ',
  ]),
};
// weapons: len = blade cells, tip = glyph at the end, line = override for the shaft
const ISO_WEAPON = {
  saw: [{ len: 1, tip: '}' }, { len: 2, tip: '}', line: '=' }],
  axe: [{ len: 1, tip: 'P' }, { len: 3, tip: 'P' }],
  cane: [{ len: 1, tip: '·' }, { len: 3, tip: '~', line: '~' }],
  huntsman: { len: 1, tip: '¬' },
  pitch: { len: 2, tip: 'Ψ' },
  torch: { len: 1, tip: '♦', fire: true },
  rifle: { len: 2, tip: '═', line: '═', aim: true },
  servant: { len: 2, tip: '†' },
  gascoigne: { len: 2, tip: 'P' },
  gehrman: { len: 3, tip: 'ɾ' },
};
const ISO_ENT_ART = {
  huntsman: 'huntsman', pitch: 'huntsman', torch: 'huntsman', rifle: 'rifle', dog: 'dog', beast: 'beast',
  patient: 'patient', servant: 'servant', troll: 'troll', giant: 'giant',
  cleric: 'cleric', gascoigne: 'gascoigne', amelia: 'amelia', gehrman: 'gehrman', moon: 'moon',
};

// props standing on DECOR tiles (and features / lamps), keyed by glyph
const ISO_PROP = {
  '=': SPR(['▄▄▄▄', '█▀▀█', 'o  o'], ['aaaa', 'bccb', 'dddd'], 1),
  'Ø': SPR(['▗▄▄▖', '▐▀▀▌'], ['aaaa', 'bbbb'], 1),
  '^': SPR([' ) ', '(^)', '/#\\'], [' f ', 'fgf', 'www']),
  'i': SPR([' ◘ ', ' │ ', ' │ ', '▄█▄'], [' g ', ' d ', ' d ', 'ddd']),
  '¦': SPR(['┬┬┬┬', '││││'], ['aaaa', 'bbbb'], 1),
  '†': SPR([' ┼ ', ' █ ', '▀▀▀'], [' a ', ' a ', 'bbb']),
  '♣': SPR([' ▲ ', '▲▲▲', ' █ '], [' a ', 'aba', ' w ']),
  'Ω': SPR([' Ω ', '/█\\', '▐█▌', '▀▀▀'], [' a ', 'bab', 'bab', 'ddd']),
  'I': SPR(['▄█▄', ' █ ', ' █ ', '▄█▄'], ['aaa', ' a ', ' b ', 'bbb']),
  '≡': SPR(['▄▄▄▄', '≡≡≡≡', '≡≡≡≡'], ['aaaa', 'bbbb', 'bbbb'], 1),
  '¡': SPR([' ¡ ', '¡▄¡'], [' g ', 'gwg']),
  '+': SPR([' + ', ' ▀ '], [' a ', ' b ']),
  lamp: SPR([' ¥ ', ' │ ', '▄█▄'], [' g ', ' d ', 'ddd']),
  doll: SPR([' ● ', '▐█▌', '▟█▙'], [' s ', 'bab', 'aaa']),
  messenger: SPR(['ᵔmᵔ'], ['aaa']),
  workbench: SPR(['▄▄▄▄', 'π  π'], ['aaaa', 'bbbb'], 1),
  headstone: SPR([' ▄ ', '▐Π▌', '▀▀▀'], [' a ', 'aaa', 'bbb']),
  gehrman: SPR(['▄▲▄', '▐█╗', 'o─o'], ['hhh', 'cab', 'ddd']),
  tree: [SPR([' ▲ ', '▲♣▲', '♣♣♣', ' █ '], [' a ', 'aba', 'bab', ' w ']),
    SPR(['  ▲  ', ' ♣▲♣ ', '♣♣♣♣♣', '  █  '], ['  a  ', ' bab ', 'babab', '  w  ']),
    SPR(['▲ ▲', '♣♣♣', ' █ '], ['a a', 'bab', ' w '])],
};

// ---------------------------------------------------------------------------
// camera & projection
// ---------------------------------------------------------------------------
function isoCamera(now, g, m) {
  const p = g.p;
  const tc = 2 * (p.x - p.y), tr = p.x + p.y;
  const dt = Math.min(100, Math.max(0, now - (ISO.last || now)));
  ISO.last = now;
  if (ISO.mapRef !== m || Math.abs(tc - ISO.camC) > 40 || Math.abs(tr - ISO.camR) > 24) {
    ISO.camC = tc; ISO.camR = tr; ISO.mapRef = m;
    const n = m.w * m.h;
    if (!ISO.tele || ISO.tele.length !== n) {
      ISO.tele = new Float32Array(n); ISO.teleK = new Uint8Array(n); ISO.prev = new Uint8Array(n);
    } else { ISO.tele.fill(0); ISO.teleK.fill(0); ISO.prev.fill(0); }
    ISO.touched.length = 0;
    ISO.embers.length = 0;
  } else {
    const a = 1 - Math.exp(-dt / 85);
    ISO.camC += (tc - ISO.camC) * a;
    ISO.camR += (tr - ISO.camR) * a;
    if (Math.abs(tc - ISO.camC) < 0.02) ISO.camC = tc;
    if (Math.abs(tr - ISO.camR) < 0.02) ISO.camR = tr;
  }
  ISO.camCi = Math.floor(ISO.camC); ISO.camRi = Math.floor(ISO.camR);
  ISO.fx = ISO.camC - ISO.camCi; ISO.fy = ISO.camR - ISO.camRi;
  if (g.cam) { g.cam.x = p.x - (VIEW_W >> 1); g.cam.y = p.y - (VIEW_H >> 1); }
}
// buffer column of a tile's slab (leftmost cell) / buffer row of its slab
function isoBC(x, y) { return 2 * (x - y) - ISO.camCi + ISO_CX; }
function isoBR(x, y) { return (x + y) - ISO.camRi + ISO_CY; }

// device-pixel position (inside the shaken viewport transform) of a map point,
// lifted to chest height. Used by render.js for particles and floating text.
function isoCellPx(mx, my) {
  const s = RND.s, cw = RND.cw * s, ch = RND.ch * s;
  const col = 2 * (mx - my) - ISO.camC + ISO_CX + 1 - ISO_M + 0.5;
  const row = (mx + my) - ISO.camR + ISO_CY - 1.2 - ISO_M + VIEW_Y + 0.5;
  return [col * cw, row * ch];
}

// ---------------------------------------------------------------------------
// main entry: fill the iso buffer for this frame
// ---------------------------------------------------------------------------
function drawIsoView(now, g, m) {
  isoCamera(now, g, m);
  isoClear();
  ISO.glows.length = 0;
  ISO.bars.length = 0;
  ISO.sky = m.id === 'field' ? 2 : m.id === 'dream' ? 1 : 0;
  const W = m.w, H = m.h;
  // visible depth / diagonal ranges (+ extra rows below for tall things)
  const s0 = ISO.camRi - ISO_CY - 1, s1 = ISO.camRi - ISO_CY + ISO_H + 8;
  const d0 = Math.floor((ISO.camCi - ISO_CX - 6) / 2), d1 = Math.ceil((ISO.camCi - ISO_CX + ISO_W + 2) / 2);
  ISO.s0 = s0; ISO.s1 = s1;
  isoMarkOverlays(now, g, m);

  // ---- pass 1: ground ----
  for (let s = s0; s <= s1; s++) {
    let d = d0;
    if (((d + s) & 1) !== 0) d++;
    for (; d <= d1; d += 2) {
      const x = (s + d) >> 1, y = (s - d) >> 1;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      isoGround(now, g, m, x, y, y * W + x, s);
    }
  }
  isoItems(now, g, m);

  // ---- pass 2: upright things ----
  isoBucket(g, m, s0, s1);
  const p = g.p, ps = p.x + p.y, pd = p.x - p.y;
  for (let s = s0; s <= s1; s++) {
    let d = d0;
    if (((d + s) & 1) !== 0) d++;
    for (; d <= d1; d += 2) {
      const x = (s + d) >> 1, y = (s - d) >> 1;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      isoUpright(now, g, m, x, y, y * W + x, s, ps, pd);
    }
    const b = ISO.bk[s - s0];
    if (b && b.length) for (let k = 0; k < b.length; k += 2) isoDrawThing(now, g, m, b[k], b[k + 1], s, false);
  }
  // ---- pass 3: x-ray silhouettes of creatures hidden behind walls ----
  ISO.xray = true;
  for (let s = s0; s <= s1; s++) {
    const b = ISO.bk[s - s0];
    if (!b || !b.length) continue;
    for (let k = 0; k < b.length; k += 2) {
      const kind = b[k];
      if (kind !== 1 && kind !== 2) continue;
      ISO.xz = s;
      isoDrawThing(now, g, m, kind, b[k + 1], s, true);
    }
  }
  ISO.xray = false;
}

// telegraphs + attack preview -> per-tile scratch arrays
function isoMarkOverlays(now, g, m) {
  const tele = ISO.tele, teleK = ISO.teleK, prev = ISO.prev, touched = ISO.touched;
  for (let k = 0; k < touched.length; k++) { const i = touched[k]; tele[i] = 0; teleK[i] = 0; prev[i] = 0; }
  touched.length = 0;
  for (const e of (g.enemies || [])) {
    if (e.dead || e.state !== 'windup' || !e.tiles || !e.atk) continue;
    const wu = e.atk.windup || 10;
    const pr = clamp(1 - (e.timer || 0) / wu, 0, 1);
    let I = 0.28 + 0.72 * pr;
    const parry = rndParryable(e);
    if (parry) I *= 0.85 + 0.15 * Math.sin(now * 0.06);
    const kind = e.atk.special === 'bloodletting' ? 2 : 1;
    for (const idx of e.tiles) {
      if (idx < 0 || idx >= tele.length) continue;
      if (I > tele[idx]) { tele[idx] = I; teleK[idx] = kind | (parry ? 4 : 0); }
      touched.push(idx);
    }
  }
  const p = g.p;
  if (g.mode === 'play' && p && !p.dead && typeof currentShapeTiles === 'function') {
    let tiles = null;
    try { tiles = currentShapeTiles(); } catch (e) { tiles = null; }
    if (tiles) {
      const busy = (p.act || 0) > 0 ? 2 : 1;
      for (const tt of tiles) {
        const i = tt[1] * m.w + tt[0];
        if (i < 0 || i >= prev.length) continue;
        prev[i] = busy; touched.push(i);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// ground slabs
// ---------------------------------------------------------------------------
function isoGround(now, g, m, x, y, i, s) {
  const t = m.tiles[i], W = m.w;
  if (t === T.SKY) return;
  const b = m.vis[i], sn = m.seen[i];
  if (b <= 0 && !sn) return;
  if (t === T.WALL) return;            // walls are upright things
  if (t === T.FEATURE) { const f = m.featAt && m.featAt.get(i); if (f && f.kind === 'window') return; }
  const bc = isoBC(x, y), br = isoBR(x, y);
  if (br < 0 || br >= ISO_H || bc < -4 || bc >= ISO_W) return;
  const def = m.def || {};
  const h = hash2(x, y, 11);
  let base, chars, dens = 0.45, water = false;
  const fgl = (t === T.FLOOR || t === T.GRASS) && m.fglyph ? m.fglyph.get(i) : null;
  if (t === T.GRASS) { base = C(def.grass || '#4d5c3c'); chars = def.grassChars || '"'; dens = 0.7; }
  else if (t === T.FLOWER) { base = C(def.grass || '#5a6a4a'); chars = null; }
  else {
    base = C(def.floor || '#6f665d'); chars = def.floorChars || '.';
    if (fgl && fgl.ch === '.') base = C(fgl.col);
    if (t === T.DECOR) { const dd = m.decor && m.decor.get(i); if (dd && dd.ch === '≈') water = true; }
  }
  const lt = m.light ? m.light[i] : 0;
  const tsec = now / 1000;
  let k, bgS, fgCol = base;
  const lit = b > 0;
  // slab tone varies per stone so the staggered lattice reads as cobbles
  const tone = 0.82 + 0.3 * h;
  if (lit) {
    k = isoK(b);
    // contact shadow at the foot of the walls behind this slab
    if ((x > 0 && m.tiles[i - 1] === T.WALL) || (y > 0 && m.tiles[i - W] === T.WALL)) k *= 0.62;
    let col = base;
    if (lt > 0.04) { col = mix(col, RND_WARM, Math.min(0.42, lt * 0.5)); k *= 1 + 0.06 * Math.sin(now * 0.009 + h * 30) * Math.min(1, lt * 2); }
    const bl = m.blood ? m.blood[i] : 0;
    let bgc = col;
    if (bl) { const bt = Math.min(0.85, 0.3 + bl * 0.12); col = mix(col, RND_BLOOD, bt); bgc = mix(bgc, [70, 4, 8], bt); k = Math.max(k, 0.5); }
    fgCol = col;
    bgS = isoShade(isoScale(bgc, tone), k * (t === T.FLOWER ? 0.3 : 0.27));
  } else {
    k = 0;
    bgS = isoMem(isoScale(base, tone), 0.13);
  }
  // overlays: enemy telegraphs, attack preview
  const tv = ISO.tele[i];
  if (tv > 0) {
    const kind = ISO.teleK[i];
    if (kind & 2) bgS = isoRGB([120 + 100 * tv, 8, 60 + 40 * tv], 0.55 + 0.45 * tv);
    else if (kind & 4) bgS = `rgb(${(70 + 185 * tv) | 0},${(10 + 40 * tv) | 0},${(10 + 22 * tv) | 0})`;
    else bgS = `rgb(${(48 + 172 * tv) | 0},${(4 + 16 * tv) | 0},${(6 + 12 * tv) | 0})`;
  } else if (ISO.prev[i] && lit) {
    bgS = ISO.prev[i] === 2 ? 'rgb(74,60,36)' : 'rgb(44,38,30)';
  }
  const z = s;
  // the four cells of the slab
  for (let u = 0; u < 4; u++) {
    const hu = hash2(x * 4 + u, y, 29);
    let ch = ' ', fg = null;
    if (water) {
      const ph = Math.sin(tsec * 1.4 + x * 0.9 + u * 0.7 + y * 0.5);
      ch = ph > 0.3 ? '≈' : '~';
      fg = lit ? isoShade([70 + 30 * ph, 100 + 30 * ph, 160 + 30 * ph], k) : isoMem([70, 100, 160], 0.4);
    } else if (t === T.FLOWER) {
      const sway = Math.sin(tsec * 1.3 + x * 0.35 + y * 0.2 + u);
      if (hu < 0.3) {
        ch = hu < 0.16 ? '*' : '·';
        const w = 0.88 + 0.12 * sway;
        fg = lit ? isoShade([232 * w, 228 * w, 220 * w], Math.max(0.5, k * 0.9)) : isoMem([220, 220, 220], 0.3);
      } else if (hu < 0.62) {
        ch = hu < 0.45 ? '"' : hu < 0.55 ? ',' : '\'';
        fg = lit ? isoShade(isoScale(base, 0.85 + 0.3 * hash2(x, u, 3) + 0.08 * sway), k) : isoMem(base, 0.3);
      }
    } else if (hu < dens && chars) {
      ch = chars[Math.floor(hash2(x + u, y * 3, 5) * chars.length)];
      if (ch === '.' && hu < dens * 0.25) ch = '·';
      fg = lit ? isoShade(isoScale(fgCol, 0.75 + 0.35 * hu), k * 0.9) : isoMem(fgCol, 0.32);
    }
    isoPut(bc + u, br, ch === ' ' ? ' ' : ch, fg, bgS, z, ISO_KIND_FLOOR);
  }
  // flat decorations lying on the floor (corpses, grave markers, arena dressing)
  if (fgl && fgl.ch !== '.') {
    let col = C(fgl.col);
    if (fgl.flicker) {
      const fk = 0.8 + 0.2 * Math.sin(now * 0.019 + h * 40);
      col = mix(col, [255, 226, 130], 0.3);
      col = isoScale(col, fk).slice();
      if (lit && ISO.glows.length < 120) ISO.glows.push(bc + 1.5, br - 0.6, 2.2, 255, 190, 90, 0.16 * fk);
    }
    const sp = ISO_PROP[fgl.ch];
    if (sp && (fgl.ch === '¡' || fgl.ch === '+' || fgl.ch === '¦')) {
      // small upright things are drawn in pass 2 (they stand up)
    } else {
      isoPut(bc + 1, br, fgl.ch, lit ? isoShade(col, Math.max(0.55, k)) : isoMem(col, 0.35), undefined, z, ISO_KIND_FLOOR);
    }
  }
  // the flower field floats in the night: earth cliffs under edges facing the sky
  if (ISO.sky === 2 && (t === T.FLOWER || t === T.GRASS || t === T.FLOOR)) {
    const sx = x + 1 < m.w ? m.tiles[i + 1] === T.SKY : false;
    const sy = y + 1 < m.h ? m.tiles[i + m.w] === T.SKY : false;
    if (sx || sy) {
      for (let r = 1; r <= 3; r++) {
        const kk = (lit ? 0.5 : 0.25) * (1 - r * 0.22);
        const c1 = isoShade([70, 56, 44], kk), c2 = isoShade([46, 38, 32], kk);
        if (sy) { isoPut(bc, br + r, r === 3 ? '▀' : '▓', c1, isoRGB([22, 16, 14], 1), z, ISO_KIND_FLOOR); isoPut(bc + 1, br + r, '▒', c1, isoRGB([22, 16, 14], 1), z, ISO_KIND_FLOOR); }
        if (sx) { isoPut(bc + 2, br + r, '▒', c2, isoRGB([14, 10, 10], 1), z, ISO_KIND_FLOOR); isoPut(bc + 3, br + r, r === 3 ? '▀' : '▓', c2, isoRGB([14, 10, 10], 1), z, ISO_KIND_FLOOR); }
      }
    }
  }
}

// items, drops, the bloodstain: small glyphs on their slabs
function isoItems(now, g, m) {
  const W = m.w, vis = m.vis, seen = m.seen;
  const save = g.save || {}, taken = save.taken || {};
  for (const it of (m.items || [])) {
    if (taken[it.key] && it.kind !== 'note') continue;
    const i = it.y * W + it.x;
    const bc = isoBC(it.x, it.y), br = isoBR(it.x, it.y);
    if (br < 0 || br >= ISO_H || bc < -3 || bc >= ISO_W) continue;
    const gl = ITEM_GLYPH[it.kind] || ITEM_GLYPH.note;
    const c = C(gl.col);
    if (vis[i] > 0) {
      const ph = (now / 1000 + hash2(it.x, it.y, 3) * 7) % 3.2;
      const glint = ph < 0.14;
      const read = taken[it.key] && it.kind === 'note';
      isoPut(bc + 1, br, gl.ch, glint ? '#ffffff' : isoShade(c, read ? 0.5 : 0.8 + 0.35 * Math.min(1, vis[i])), read ? undefined : 'rgb(46,38,24)', it.x + it.y, ISO_KIND_FLOOR);
      if (!read) {
        isoPut(bc, br, '‹', isoRGB(c, 0.35), undefined, it.x + it.y, ISO_KIND_FLOOR);
        isoPut(bc + 2, br, '›', isoRGB(c, 0.35), undefined, it.x + it.y, ISO_KIND_FLOOR);
        if (ISO.glows.length < 120) ISO.glows.push(bc + 1.5, br, 1.6, c[0], c[1], c[2], glint ? 0.3 : 0.1);
      }
    } else if (seen[i]) isoPut(bc + 1, br, gl.ch, isoMem(c, 0.3), undefined, it.x + it.y, ISO_KIND_FLOOR);
  }
  for (const d of (g.drops || [])) {
    const i = d.y * W + d.x;
    if (!(vis[i] > 0)) continue;
    const gl = ITEM_GLYPH[d.kind];
    if (!gl) continue;
    const bc = isoBC(d.x, d.y), br = isoBR(d.x, d.y);
    const pk = 0.85 + 0.25 * Math.sin(now * 0.008 + d.x);
    isoPut(bc + 1, br, gl.ch, isoShade(C(gl.col), pk), 'rgb(52,40,22)', d.x + d.y, ISO_KIND_FLOOR);
  }
  // impact marks, tracers and dodge trails lie on the ground (slashes stand up: pass 2)
  for (const f of (g.fx || [])) {
    if (f.k !== 'g' || ISO_ROT_GLYPH[f.ch]) continue;
    const x = Math.round(f.x), y = Math.round(f.y);
    if (x < 0 || y < 0 || x >= W || y >= m.h || !(vis[y * W + x] > 0)) continue;
    const bc = isoBC(x, y), br = isoBR(x, y);
    const a = 1 - rndFxFrac(f) * 0.75;
    const c = C(f.col || '#ffffff');
    const fg = isoShade(c, a);
    if (f.ch === '·') { isoPut(bc + 1, br, '·', fg, undefined, x + y, ISO_KIND_FLOOR); isoPut(bc + 2, br, '·', fg, undefined, x + y, ISO_KIND_FLOOR); continue; }
    const bg = isoRGB(c, 0.28 * a);
    for (let u = 0; u < 4; u++) isoPut(bc + u, br, u === 1 || u === 2 ? f.ch : ' ', fg, bg, x + y, ISO_KIND_FLOOR);
  }
  const st = save.stain;
  if (st && st.area === m.id) {
    const i = st.y * W + st.x;
    if (seen[i] || vis[i] > 0) {
      const bc = isoBC(st.x, st.y), br = isoBR(st.x, st.y);
      const pk = 0.6 + 0.4 * Math.sin(now * 0.005);
      const bg = isoRGB([90, 0, 8], 0.4 + 0.5 * pk);
      for (let u = 0; u < 4; u++) isoBgAt(bc + u, br, bg);
      isoPut(bc + 1, br, '§', isoRGB([255, 40, 50], 0.55 + 0.45 * pk), bg, st.x + st.y, ISO_KIND_FLOOR);
      if (ISO.glows.length < 120) ISO.glows.push(bc + 1.5, br, 2.5, 255, 30, 40, 0.18 * pk);
    }
  }
}

// ---------------------------------------------------------------------------
// upright tiles: walls, fog gates, props, lamps, features
// ---------------------------------------------------------------------------
function isoOpen(m, x, y) {
  if (x < 0 || y < 0 || x >= m.w || y >= m.h) return false;
  const t = m.tiles[y * m.w + x];
  if (t === T.WALL || t === T.SKY) return false;
  if (t === T.FEATURE) { const f = m.featAt && m.featAt.get(y * m.w + x); if (f && f.kind === 'window') return false; }
  return true;
}

function isoUpright(now, g, m, x, y, i, s, ps, pd) {
  const t = m.tiles[i];
  if (t === T.FLOOR || t === T.GRASS || t === T.FLOWER || t === T.SKY) {
    if (t === T.FLOOR || t === T.GRASS) {
      const fgl = m.fglyph && m.fglyph.get(i);
      if (fgl && (fgl.ch === '¡' || fgl.ch === '+' || fgl.ch === '¦')) isoPropAt(now, m, x, y, i, s, ISO_PROP[fgl.ch], C(fgl.col), fgl.flicker);
    }
    return;
  }
  const b = m.vis[i], sn = m.seen[i];
  if (b <= 0 && !sn) return;
  if (t === T.WALL) {
    if (m.wallVis && !m.wallVis[i]) return;
    isoWall(now, g, m, x, y, i, s, ps, pd, null);
    return;
  }
  if (t === T.FEATURE) {
    const f = m.featAt && m.featAt.get(i);
    if (!f) return;
    if (f.kind === 'window') { isoWall(now, g, m, x, y, i, s, ps, pd, f); return; }
    const sp = ISO_PROP[f.kind] || null;
    if (sp) isoPropAt(now, m, x, y, i, s, sp, C(f.col), false, f);
    else isoPropAt(now, m, x, y, i, s, SPR([f.ch], ['a']), C(f.col), false, f);
    return;
  }
  if (t === T.LAMP) { isoLamp(now, g, m, x, y, i, s); return; }
  if (t === T.DECOR) {
    const d = m.decor && m.decor.get(i);
    if (!d || d.ch === '≈') return;
    let sp = ISO_PROP[d.ch];
    if (d.ch === '♣') sp = ISO_PROP.tree[Math.floor(hash2(x, y, 7) * 3)];
    if (!sp) sp = SPR([d.ch, '▀'], ['a', 'b']);
    isoPropAt(now, m, x, y, i, s, sp, C(d.col), d.flicker);
    return;
  }
  if (t === T.FOG) { isoFog(now, g, m, x, y, i, s, ps, pd); }
}

// how far a wall in front of the hunter is cut down (0 = not, 1 = to a ledge, 2 = to a stub)
function isoCut(x, y, ps, pd) {
  const ds = x + y - ps;
  if (ds <= 0) return 0;
  const dd = (x - y) - pd;
  const e = (dd / 6.5) * (dd / 6.5) + ((ds - 0.5) / 6) * ((ds - 0.5) / 6);
  return e <= 1 ? 2 : e <= 1.7 ? 1 : 0;
}

function isoWall(now, g, m, x, y, i, s, ps, pd, feat) {
  const bc = isoBC(x, y), br = isoBR(x, y);
  if (bc < -4 || bc >= ISO_W || br < 0 || br - 5 >= ISO_H) return;
  const def = m.def || {};
  const b = m.vis[i], lit = b > 0;
  const tree = def.wallCh === '♣';
  const dream = m.id === 'dream';
  // back walls (whose faces look onto open ground) stand tall; front walls are ledges
  const back = isoOpen(m, x + 1, y) || isoOpen(m, x, y + 1) || isoOpen(m, x + 1, y + 1);
  let hgt = back ? (dream ? 2 : 4) : 1;
  const cut = isoCut(x, y, ps, pd);
  if (cut === 2) hgt = 0; else if (cut === 1) hgt = Math.min(hgt, 1);
  const z = s;
  const h = hash2(x, y, 11);
  const wc = C(def.wall || '#5f4f49');
  if (tree) { isoTree(now, m, x, y, i, s, bc, br, hgt, lit, b); return; }
  const k = lit ? 0.5 + 0.75 * Math.min(1, b) : 0;
  const lt = lit && m.light ? m.light[i] : 0;
  let col = wc;
  if (lt > 0.05) col = mix(col, RND_WARM, Math.min(0.35, lt * 0.45));
  const tone = 0.9 + 0.2 * h;
  const topBg = lit ? isoShade(isoScale(col, tone * 0.95), k) : isoMem(wc, 0.3);
  const topFg = lit ? isoShade(isoScale(col, tone * 1.25), k) : isoMem(wc, 0.42);
  if (hgt === 0) {
    // cut away: a stub outline at floor level so the room shape stays readable
    const stubBg = lit ? isoShade(isoScale(col, 0.42), k) : isoMem(wc, 0.18);
    for (let u = 0; u < 4; u++) isoPut(bc + u, br, '▄', topBg, stubBg, z, ISO_KIND_WALL);
    return;
  }
  const lBg = lit ? isoShade(isoScale(col, 0.55 * tone), k) : isoMem(wc, 0.2);
  const rBg = lit ? isoShade(isoScale(col, 0.3 * tone), k) : isoMem(wc, 0.12);
  const top = br - hgt;
  // top face
  for (let u = 0; u < 4; u++) {
    const hu = hash2(x * 4 + u, y, 41);
    isoPut(bc + u, top, hu < 0.3 ? '▔' : hu < 0.42 ? '·' : ' ', topFg, topBg, z, ISO_KIND_WALL);
  }
  // gothic skyline: spires and chimneys rise from some back-wall tops
  if (back && hgt >= 3 && !dream && lit) {
    const sp = hash2(x, y, 77);
    if (sp < 0.07) {
      isoPut(bc + 1, top - 1, sp < 0.025 ? '†' : '▲', topFg, undefined, z, ISO_KIND_WALL);
      isoPut(bc + 2, top - 1, sp < 0.025 ? ' ' : '▖', topBg, undefined, z, ISO_KIND_WALL);
    } else if (sp < 0.11) {
      isoPut(bc + 1, top - 1, '▄', topBg, undefined, z, ISO_KIND_WALL);
      isoPut(bc + 2, top - 1, '▄', topBg, undefined, z, ISO_KIND_WALL);
    }
  }
  // side faces: solid stone with drawn courses; the left face catches the light, the right is in shade
  const lFg = lit ? isoShade(isoScale(col, 0.25 * tone), k) : isoMem(wc, 0.1);
  const rFg = lit ? isoShade(isoScale(col, 0.13 * tone), k) : isoMem(wc, 0.06);
  for (let r = top + 1; r <= br; r++) {
    const j = r - top;
    for (let u = 0; u < 4; u++) {
      const left = u < 2;
      let ch;
      if (dream) ch = ((j + u + x) & 1) ? '░' : ' ';
      else if ((j & 1) === 0) ch = '_';
      else ch = ((u & 1) === (((j >> 1) + x + y) & 1)) ? '|' : ' ';
      isoPut(bc + u, r, ch, left ? lFg : rFg, left ? lBg : rBg, z, ISO_KIND_WALL);
    }
  }
  // edge highlight between faces (the corner the light catches)
  if (hgt > 1) for (let r = top + 1; r <= br; r++) isoPut(bc + 2, r, '▏', topFg, undefined, z, ISO_KIND_WALL);
  // lit windows: the window feature, plus a few warm windows in the townhouses
  const win = feat ? 1 : (!dream && back && hgt >= 3 && hash2(x, y, 93) < 0.05) ? 2 : 0;
  if (win && hgt >= 2) {
    const pk = 0.8 + 0.2 * Math.sin(now * 0.003 + h * 9);
    const wcol = feat ? C(feat.col) : [236, 170, 80];
    const u = feat ? 0 : (hash2(x, y, 5) < 0.5 ? 0 : 2);
    const r = top + 1 + (hgt >= 3 ? 1 : 0);
    isoPut(bc + u, r, feat ? '▐' : '▪', isoShade(wcol, pk * (feat ? 1.1 : 0.8)), isoRGB([60, 40, 12], 0.8 * pk), z, ISO_KIND_WALL);
    isoPut(bc + u + 1, r, feat ? '▌' : '▪', isoShade(wcol, pk * (feat ? 1.1 : 0.8)), isoRGB([60, 40, 12], 0.8 * pk), z, ISO_KIND_WALL);
    if (ISO.glows.length < 120) ISO.glows.push(bc + u + 1, r, feat ? 4 : 2.2, wcol[0], wcol[1], wcol[2], (feat ? 0.22 : 0.1) * pk);
  }
}

function isoTree(now, m, x, y, i, s, bc, br, hgt, lit, b) {
  const k = lit ? 0.35 + 0.9 * Math.min(1, b) : 0;
  const base = C((m.def && m.def.wall) || '#2c3328');
  const z = s;
  const sway = Math.sin(now * 0.0012 + x * 0.7 + y * 0.3);
  const P = ISO.pal;
  P.a = lit ? isoShade(isoScale(base, 1.9 + 0.15 * sway), k) : isoMem(base, 0.5);
  P.b = lit ? isoShade(isoScale(base, 1.3), k) : isoMem(base, 0.38);
  P.w = lit ? isoShade([70, 52, 38], k) : isoMem([70, 52, 38], 0.3);
  if (hgt <= 1) {
    for (let u = 0; u < 4; u++) isoPut(bc + u, br, hash2(x + u, y, 3) < 0.5 ? '♣' : '"', P.b, undefined, z, ISO_KIND_WALL);
    return;
  }
  const sp = ISO_PROP.tree[Math.floor(hash2(x, y, 7) * 3)];
  isoSprite(sp, bc + 1 + (hash2(x, y, 9) < 0.5 ? 0 : 1), br, 1, P, z, ISO_KIND_WALL);
}

function isoFog(now, g, m, x, y, i, s, ps, pd) {
  const bc = isoBC(x, y), br = isoBR(x, y);
  const cut = isoCut(x, y, ps, pd);
  const hgt = cut === 2 ? 1 : 3;
  const z = s;
  const locked = m.fogLocked;
  const tsec = now / 1000;
  for (let r = br - hgt; r <= br; r++) {
    for (let u = 0; u < 4; u++) {
      const ph = hash2(x * 4 + u, r + y, 13) * 6.28 + tsec * 1.7 + Math.sin(tsec * 0.6 + r * 0.7 + u);
      const sv = Math.sin(ph);
      const ch = sv > 0.6 ? '▒' : sv > -0.3 ? '░' : '·';
      const kk = (0.42 + 0.2 * Math.sin(ph * 0.7 + 1)) * (r === br - hgt ? 0.7 : 1);
      const bs = locked ? [236, 228, 222] : [196, 204, 232];
      isoPut(bc + u, r, ch, isoRGB(bs, kk), isoRGB(locked ? [52, 50, 56] : [36, 40, 58], 0.75 + 0.15 * sv), z, ISO_KIND_WALL);
    }
  }
  if (ISO.glows.length < 120 && hash2(x, y, 1) < 0.5) ISO.glows.push(bc + 2, br - 1.5, 3, 200, 210, 240, 0.07);
}

function isoLamp(now, g, m, x, y, i, s) {
  const bc = isoBC(x, y), br = isoBR(x, y);
  const lamp = rndLampAt(m, i);
  const litLamps = (g.save && g.save.litLamps) || [];
  const on = lamp && (litLamps.indexOf(lamp.id) >= 0 || m.id === 'dream');
  const vis = m.vis[i] > 0;
  const P = ISO.pal;
  const pk = 0.85 + 0.2 * Math.sin(now * 0.004 + x);
  if (!vis) { P.a = P.g = P.d = isoMem([176, 150, 98], 0.35); }
  else if (on) { P.g = isoRGB([255, 205, 96], pk); P.d = isoRGB([120, 96, 60], 1); P.a = P.g; }
  else { P.g = isoRGB([176, 150, 98], 0.75); P.d = isoRGB([96, 82, 60], 1); P.a = P.g; }
  isoSprite(ISO_PROP.lamp, bc + 1, br, 1, P, s, ISO_KIND_WALL);
  if (vis) {
    if (on) {
      for (let u = 0; u < 4; u++) isoBgAt(bc + u, br, isoRGB([96, 64, 14], 0.45 + 0.2 * Math.sin(now * 0.004)));
      ISO.glows.push(bc + 1.5, br - 2, 7, 255, 190, 90, 0.2 * pk);
    } else ISO.glows.push(bc + 1.5, br - 2, 3, 200, 170, 110, 0.06);
  }
}

function isoPropAt(now, m, x, y, i, s, sp, col, flicker, feat) {
  if (!sp) return;
  const b = m.vis[i], sn = m.seen[i];
  if (b <= 0 && !sn) return;
  const bc = isoBC(x, y), br = isoBR(x, y);
  if (bc < -6 || bc >= ISO_W + 2 || br < 0 || br - sp.h >= ISO_H) return;
  const lit = b > 0;
  const P = ISO.pal;
  const h = hash2(x, y, 11);
  if (!lit) {
    P.a = isoMem(col, 0.45); P.b = isoMem(col, 0.32); P.c = P.b; P.d = isoMem(col, 0.25);
    P.f = P.a; P.g = P.a; P.w = P.d; P.s = P.a; P.h = P.d; P.e = P.a;
  } else {
    let k = Math.max(0.55, isoK(b));
    if (feat) k = Math.max(k, 0.85);
    P.a = isoShade(col, k); P.b = isoShade(isoScale(col, 0.7), k); P.c = isoShade(isoScale(col, 0.45), k);
    P.d = isoShade(isoScale(col, 0.5), k); P.s = isoShade([220, 200, 180], k); P.h = isoShade(isoScale(col, 0.6), k);
    P.w = isoShade([110, 74, 44], k); P.e = P.a;
    if (flicker || sp === ISO_PROP['^']) {
      const fk = 0.78 + 0.22 * Math.sin(now * 0.021 + h * 40) + 0.12 * Math.sin(now * 0.053 + h * 17);
      P.f = isoRGB([255, 150 + 70 * fk, 50], fk);
      P.g = isoRGB([255, 220, 120], 0.8 + 0.25 * fk);
      const bc2 = bc + 1.5;
      if (ISO.glows.length < 120) ISO.glows.push(bc2, br - 1.5, sp === ISO_PROP['^'] ? 6 : 3, 255, 150, 60, (sp === ISO_PROP['^'] ? 0.22 : 0.12) * fk);
      if (sp === ISO_PROP['^']) isoSpawnEmber(bc2 + ISO.camCi - ISO_CX, br - 2 + ISO.camRi - ISO_CY);
    } else {
      P.f = P.a;
      P.g = (sp === ISO_PROP.i) ? isoRGB([255, 214, 120], 0.9 + 0.1 * Math.sin(now * 0.003 + h * 7)) : P.a;
      if (sp === ISO_PROP.i && ISO.glows.length < 120) ISO.glows.push(bc + 1.5, br - 3, 5, 255, 200, 110, 0.14);
    }
  }
  isoSprite(sp, bc + 1, br, 1, P, s, ISO_KIND_WALL);
}

// ---------------------------------------------------------------------------
// creatures, the hunter, fx glyphs — bucketed by depth
// ---------------------------------------------------------------------------
function isoBucket(g, m, s0, s1) {
  const n = s1 - s0 + 1;
  while (ISO.bk.length < n) ISO.bk.push([]);
  for (let k = 0; k < n; k++) ISO.bk[k].length = 0;
  const add = (s, kind, ref) => { if (s >= s0 && s <= s1) ISO.bk[s - s0].push(kind, ref); };
  for (const e of (g.enemies || [])) {
    if (e.dead) continue;
    const sz = e.size || 1;
    add(e.x + e.y + 2 * (sz - 1), 1, e);
  }
  const p = g.p;
  if (p) {
    const gh = p.ghost;
    if (gh && typeof gh.x === 'number' && (gh.x !== p.x || gh.y !== p.y) && (gh.t === undefined || gh.t > 0)) add(gh.x + gh.y, 3, gh);
    add(p.x + p.y, 2, p);
  }
  for (const f of (g.fx || [])) if (f.k === 'g' && ISO_ROT_GLYPH[f.ch]) add(Math.round(f.x) + Math.round(f.y), 4, f);
}

function isoDrawThing(now, g, m, kind, ref, s, xray) {
  if (kind === 1) isoEnemy(now, g, m, ref, s, xray);
  else if (kind === 2) isoHunter(now, g, m, ref, s, xray);
  else if (kind === 3) isoGhost(now, g, m, ref, s);
  else if (kind === 4) isoFxGlyph(now, g, m, ref, s);
}

// screen-horizontal sign of a map facing: +1 right, -1 left, 0 straight up/down
function isoFlipOf(facing) {
  const d = DIRS[((facing | 0) % 8 + 8) % 8];
  return Math.sign(d[0] - d[1]);
}

function isoAnim(e) {
  let a = ISO.anim.get(e);
  if (!a) { a = { st: e.state, swingAt: -1e9, flip: 1, x: e.x, y: e.y }; ISO.anim.set(e, a); }
  return a;
}

// weapon as a short line from the hand: angle in degrees (0 = forward, - = up)
function isoWeapon(hx, hy, flip, ang, wp, steel, tipCol, z, kd) {
  const a = ang * Math.PI / 180;
  const len = wp.len;
  const DX = Math.cos(a) * len * 1.9, DY = Math.sin(a) * len;
  const steps = Math.max(1, Math.round(Math.max(Math.abs(DX), Math.abs(DY))));
  const deg = Math.atan2(DY * 19, DX * 10) * 180 / Math.PI;
  let lc;
  const ad = Math.abs(deg);
  if (ad < 24 || ad > 156) lc = '─';
  else if (ad > 66 && ad < 114) lc = '│';
  else lc = (deg > 0) === (ad < 90) ? '\\' : '/';
  if (wp.line) lc = wp.line;
  let lx = 0, ly = 0;
  for (let k = 1; k <= steps; k++) {
    const cx = Math.round(DX * k / steps), cy = Math.round(DY * k / steps);
    if (cx === lx && cy === ly && k > 1) continue;
    lx = cx; ly = cy;
    const last = k === steps;
    let ch = last ? wp.tip : lc;
    const x = hx + (flip < 0 ? -cx : cx), y = hy + cy;
    if (flip < 0) ch = isoMirror(ch);
    isoPut(x, y, ch, last ? tipCol : steel, undefined, z, kd);
  }
  return [hx + (flip < 0 ? -lx : lx), hy + ly];
}

function isoEnemy(now, g, m, e, s, xray) {
  const sz = e.size || 1;
  // only shown when some body cell is in sight
  let v = 0;
  for (let dy = 0; dy < sz; dy++) for (let dx = 0; dx < sz; dx++) {
    const x = e.x + dx, y = e.y + dy;
    if (x < 0 || y < 0 || x >= m.w || y >= m.h) continue;
    v = Math.max(v, m.vis[y * m.w + x]);
  }
  if (!(v > 0)) return;
  const an = isoAnim(e);
  if (!xray) {
    if (an.st !== e.state) {
      if (an.st === 'windup' && (e.state === 'recover' || e.state === 'chase' || e.state === 'windup')) an.swingAt = now;
      an.st = e.state;
    }
  }
  // footprint centre (top-left + (size-1)/2); bottom of the art on the front tile
  const cx = e.x + (sz - 1) / 2, cy = e.y + (sz - 1) / 2;
  const bc = 2 * (cx - cy) - ISO.camCi + ISO_CX;
  const br = (e.x + e.y + 2 * (sz - 1)) - ISO.camRi + ISO_CY;
  const cc = Math.round(bc + 1);
  const fl = isoFlipOf(e.facing);
  if (fl) an.flip = fl;
  const flip = an.flip;
  const base = C(e.col || (e.d && e.d.col) || '#cccccc');
  const type = e.type || e.id;
  let artKey = ISO_ENT_ART[type] || null;
  if (type === 'gascoigne' && (e.phase === 2 || sz === 2)) artKey = 'gascoigne2';
  let sp = artKey ? ISO_ART[artKey] : null;
  if (type === 'crow') sp = ISO_ART.crow[((now / 160) | 0) & 1];
  if (!sp) sp = SPR([e.ch || '?'], ['a']);
  // state colouring
  let col = base, k = 0.6 + 0.5 * Math.min(1, v), white = e.flashT > 0, bgPulse = null;
  if (e.state === 'stagger') {
    const pk = 0.5 + 0.5 * Math.sin(now * 0.025);
    col = mix(base, [255, 222, 60], 0.55 + 0.45 * pk);
    bgPulse = isoRGB([90, 70, 0], 0.4 + 0.6 * pk);
  } else if (e.state === 'windup' && e.atk) {
    const pr = clamp(1 - (e.timer || 0) / (e.atk.windup || 10), 0, 1);
    if (rndParryable(e)) {
      const pk = 0.5 + 0.5 * Math.sin(now * 0.05);
      col = mix([255, 70, 56], [255, 244, 210], 0.35 + 0.65 * pk);
      bgPulse = isoRGB([150, 24, 16], 0.6 + 0.4 * pk);
    } else col = mix(base, [255, 70, 56], 0.2 + 0.45 * pr);
  } else if (e.state === 'dormant') col = mix(base, [90, 90, 110], 0.3);
  else if (e.state === 'transform') col = mix(base, [255, 255, 255], 0.5 + 0.5 * Math.sin(now * 0.04));
  const P = ISO.pal;
  if (white) { P.a = P.b = P.c = P.d = P.e = P.h = P.s = P.x = P.w = '#ffffff'; }
  else {
    P.a = isoShade(col, k);
    P.b = isoShade(isoScale(col, 0.72), k);
    P.c = isoShade(isoScale(col, 0.55), k);
    P.d = isoShade(isoScale(col, 0.5), k);
    P.h = isoShade(isoScale(col, 0.45), k);
    P.s = isoShade(mix(col, [214, 186, 160], 0.6), k);
    P.x = isoShade(mix(col, [236, 226, 200], 0.7), k * 1.05);
    P.w = isoShade([170, 168, 176], k);
    P.e = e.state === 'dormant' ? P.a : isoRGB(e.boss ? [255, 60, 40] : [255, 120, 60], 0.9 + 0.1 * Math.sin(now * 0.01));
  }
  if (xray) {
    ISO.ghostFg = isoRGB(mix(col, [120, 130, 170], 0.5), 0.55);
  } else {
    // shadow / stagger glow under the feet
    if (!e.boss) {
      const sb = bgPulse || 'rgb(10,8,10)';
      const bcI = Math.round(bc);
      for (let u = 0; u < 4; u++) {
        const ii = br * ISO_W + bcI + u;
        if (bcI + u < 0 || bcI + u >= ISO_W || br < 0 || br >= ISO_H) continue;
        if (ISO.kd[ii] === ISO_KIND_FLOOR && !(ISO.tele[e.y * m.w + e.x] > 0)) ISO.bg[ii] = sb;
      }
    } else if (bgPulse) {
      for (let dy = 0; dy < sz; dy++) for (let dx = 0; dx < sz; dx++) {
        const tb = isoBC(e.x + dx, e.y + dy), tr = isoBR(e.x + dx, e.y + dy);
        for (let u = 0; u < 4; u++) isoBgAt(tb + u, tr, bgPulse);
      }
    }
  }
  // lunge/strike: lean toward the facing for a moment after the blow
  const sw = (now - an.swingAt) / 220;
  const lean = sw >= 0 && sw < 1 ? Math.round(Math.sin(sw * Math.PI) * (sz > 1 ? 2 : 1)) * flip : 0;
  const ccx = cc + lean;
  const z = s;
  // crouch during windup for beasts (art sinks a row as it coils)
  isoSprite(sp, ccx, br, flip, P, z, ISO_KIND_ENT);
  // weapon
  const wp = ISO_WEAPON[type] || null;
  if (wp && !(type === 'gascoigne' && artKey === 'gascoigne2')) {
    let ang = 40;
    if (e.state === 'windup' && e.atk) {
      const pr = clamp(1 - (e.timer || 0) / (e.atk.windup || 10), 0, 1);
      ang = wp.aim ? 0 : 40 - 150 * pr;
    } else if (sw >= 0 && sw < 1) ang = -110 + 175 * Math.min(1, sw * 1.6);
    else if (wp.aim) ang = 20;
    const hx = ccx + flip, hy = br - (sp.h >= 4 ? 2 : 1);
    const tipCol = wp.fire ? isoRGB([255, 170, 60], 0.85 + 0.25 * Math.sin(now * 0.03 + e.uid)) : (white ? '#ffffff' : P.w);
    const tip = isoWeapon(hx, hy, flip, ang, wp, white ? '#ffffff' : P.d, tipCol, z, ISO_KIND_ENT);
    if (wp.fire && !xray) {
      ISO.glows.push(tip[0] + 0.5, tip[1], 5, 255, 140, 50, 0.16);
      isoSpawnEmber(tip[0] + 0.5 + ISO.camCi - ISO_CX, tip[1] + ISO.camRi - ISO_CY);
    }
  }
  if (xray) return;
  // swing arc after the blow
  if (sw >= 0 && sw < 0.8 && e.atk) {
    const a = 1 - sw / 0.8;
    const arcC = isoRGB([255, 236, 200], 0.4 + 0.6 * a);
    const hx = ccx + flip * 2;
    isoPut(hx + flip, br - 2, flip > 0 ? '╮' : '╭', arcC, undefined, z, ISO_KIND_ENT);
    isoPut(hx + flip * 2, br - 1, '│', arcC, undefined, z, ISO_KIND_ENT);
  }
  // health pip bar for wounded regular foes
  if (!e.boss && e.hp < e.maxHp && e.maxHp > 0) ISO.bars.push(cc - 1, br - sp.h, 3, clamp(e.hp / e.maxHp, 0, 1));
  if (e.state === 'windup' && e.boss && ISO.glows.length < 120) ISO.glows.push(cc + 0.5, br - sp.h / 2, sp.w * 0.6, 255, 40, 30, 0.1);
}

function isoHunterPalette(now, g, p, ghost) {
  const P = ISO.pal;
  let coat = [196, 182, 156], cape = [126, 104, 88], hat = [150, 120, 92], legs = [104, 92, 84], k = 1.05;
  const mh = rndMaxHp();
  if (ghost) { coat = cape = hat = legs = [70, 84, 118]; k = 1; }
  else if (p.dead || g.mode === 'dead') { coat = cape = hat = legs = [150, 20, 24]; k = 0.9; }
  else if (p.flashT > 0) { coat = [120, 236, 130]; cape = [80, 170, 90]; }
  else if (p.iframes > 0) { coat = [128, 150, 190]; cape = hat = legs = [90, 104, 140]; k = 0.8; }
  else if (mh && p.hp / mh < 0.25) { const t = 0.45 + 0.4 * Math.sin(now * 0.012); coat = mix(coat, [255, 50, 50], t); cape = mix(cape, [200, 30, 30], t); }
  P.a = isoRGB(coat, k); P.c = isoRGB(cape, k); P.h = isoRGB(hat, k); P.d = isoRGB(legs, k);
  P.s = P.a; P.e = P.a; P.b = P.c; P.x = P.a;
  P.w = ghost ? P.a : isoRGB([206, 210, 220], 1);
  return P;
}

function isoHunter(now, g, m, p, s, xray) {
  const bc = isoBC(p.x, p.y), br = isoBR(p.x, p.y);
  const pl = ISO.pl;
  const fl = isoFlipOf(p.facing);
  if (fl) pl.flip = fl;
  const flip = pl.flip;
  if (!xray) {
    // detect a new action from the recovery counter rising
    const act = p.act || 0;
    if (act > pl.act) {
      pl.at = now; pl.dur = Math.max(120, Math.min(420, act * TICK_MS));
      pl.kind = p.ghost && p.ghost.t >= 5 ? 'dodge' : p.flashT > 0 ? 'heal' : isoRecentGun(g, p) ? 'gun' : 'swing';
    }
    pl.act = act;
  }
  const P = isoHunterPalette(now, g, p, false);
  if (xray) { ISO.ghostFg = 'rgb(150,160,190)'; }
  else if (!(ISO.tele[p.y * m.w + p.x] > 0)) {
    // a warm lantern-lit slab marks where the hunter stands
    for (let u = 0; u < 4; u++) {
      const x = bc + u;
      if (x < 0 || x >= ISO_W || br < 0 || br >= ISO_H) continue;
      if (ISO.kd[br * ISO_W + x] === ISO_KIND_FLOOR) ISO.bg[br * ISO_W + x] = u === 0 || u === 3 ? 'rgb(52,42,28)' : 'rgb(72,58,36)';
    }
  }
  const cc = bc + 1;
  isoSprite(ISO_ART.hunter, cc, br, flip, P, s, ISO_KIND_ENT);
  // weapon (changes with the trick form) and the pistol in the off hand
  const sv = g.save || {};
  const forms = ISO_WEAPON[sv.weapon] || ISO_WEAPON.saw;
  const wp = forms[p.form ? 1 : 0] || forms[0];
  const t = (now - pl.at) / pl.dur;
  let ang = 40;
  const swinging = pl.kind === 'swing' && t >= 0 && t < 1;
  if (swinging) ang = t < 0.25 ? -60 - 60 * (t / 0.25) : -120 + 190 * Math.min(1, (t - 0.25) / 0.45);
  else if (p.form && sv.weapon === 'axe') ang = 60;
  const hx = cc + flip * 2, hy = br - 1;
  isoWeapon(cc + flip, hy, flip, ang, wp, P.w, isoRGB([230, 224, 212], 1), s, ISO_KIND_ENT);
  if (pl.kind === 'gun' && t >= 0 && t < 1) {
    isoPut(cc - flip * 2, br - 1, flip > 0 ? '⌐' : '¬', P.w, undefined, s, ISO_KIND_ENT);
    if (t < 0.4 && !xray) {
      isoPut(cc - flip * 3, br - 1, '*', '#ffe6a0', undefined, s, ISO_KIND_ENT);
      ISO.glows.push(cc - flip * 3 + 0.5, br - 1, 4, 255, 220, 140, 0.3 * (1 - t / 0.4));
    }
  }
  if (xray) return;
  // a faint lantern pool around the hunter
  ISO.glows.push(cc + 0.5, br - 0.5, 9, 255, 200, 140, 0.035);
  // swing trail
  if (swinging && t > 0.25 && t < 0.9) {
    const a = 1 - (t - 0.25) / 0.65;
    const c = isoRGB([255, 236, 200], 0.35 + 0.65 * a);
    isoPut(hx + flip, br - 3, flip > 0 ? '╮' : '╭', c, undefined, s, ISO_KIND_ENT);
    isoPut(hx + flip * 2, br - 2, '│', c, undefined, s, ISO_KIND_ENT);
    isoPut(hx + flip * 2, br - 1, flip > 0 ? '╯' : '╰', c, undefined, s, ISO_KIND_ENT);
  }
}
function isoRecentGun(g, p) {
  for (const f of (g.fx || [])) if (f.k === 'g' && f.ch === '*' && (f.t || 0) <= 1 && f.col === '#ffe6a0') return true;
  return false;
}

function isoGhost(now, g, m, gh, s) {
  const p = g.p;
  const bc = isoBC(gh.x, gh.y), br = isoBR(gh.x, gh.y);
  const P = isoHunterPalette(now, g, p, true);
  isoSprite(ISO_ART.hunter, bc + 1, br, ISO.pl.flip, P, s, ISO_KIND_ENT);
  // streak between the afterimage and the hunter
  const dx = isoBC(p.x, p.y) - bc, dy = isoBR(p.x, p.y) - br;
  const n = Math.max(Math.abs(dx), Math.abs(dy));
  for (let k = 1; k < n; k++) {
    const x = bc + 1 + Math.round(dx * k / n), y = br - 1 + Math.round(dy * k / n);
    isoPut(x, y, '·', 'rgb(90,104,150)', undefined, s, ISO_KIND_ENT);
  }
}

// slash marks / tracers dropped by game.js on map tiles: rotate line glyphs to screen space
const ISO_ROT_GLYPH = { '|': '/', '-': '\\', '\\': '│', '/': '─' };
function isoFxGlyph(now, g, m, f, s) {
  const x = Math.round(f.x), y = Math.round(f.y);
  if (x < 0 || y < 0 || x >= m.w || y >= m.h) return;
  if (!(m.vis[y * m.w + x] > 0)) return;
  const bc = isoBC(x, y), br = isoBR(x, y);
  const a = 1 - rndFxFrac(f) * 0.75;
  const c = C(f.col || '#ffffff');
  const ch = ISO_ROT_GLYPH[f.ch] || f.ch;
  const fg = isoShade(c, a);
  if (ISO_ROT_GLYPH[f.ch]) {
    // a slash: two cells at chest height
    isoPut(bc + 1, br - 1, ch, fg, undefined, s, ISO_KIND_ENT);
    isoPut(bc + 2, br - 1, ch === '─' ? '─' : ' ', fg, undefined, s, ISO_KIND_ENT);
    if (ch !== '─') isoPut(bc + (ch === '/' ? 0 : 2), br, ch, fg, undefined, s, ISO_KIND_ENT);
  } else isoPut(bc + 1, br - 1, ch, fg, undefined, s, ISO_KIND_ENT);
}

// ---------------------------------------------------------------------------
// embers (projected-cell space)
// ---------------------------------------------------------------------------
function isoSpawnEmber(pc, pr) {
  if (ISO.embers.length > 90 || Math.random() > 0.04) return;
  ISO.embers.push({ x: pc + (Math.random() - 0.5) * 1.5, y: pr, vx: (Math.random() - 0.5) * 0.8, vy: -(0.6 + Math.random() * 0.9), life: 1 + Math.random() * 1.2, t: 0 });
}

// ---------------------------------------------------------------------------
// flush: sky backdrop, cells, glows, embers, pip bars (inside the viewport clip)
// ---------------------------------------------------------------------------
function isoFlushView(now, sx, sy) {
  const ctx = RND.ctx, s = RND.s;
  const cw = RND.cw * s, chh = RND.ch * s;
  const ox = sx - (ISO.fx + ISO_M) * cw;
  const oy = sy + (VIEW_Y - ISO_M - ISO.fy) * chh;
  const dt = Math.min(100, Math.max(0, now - (ISO.flushLast || now)));
  ISO.flushLast = now;
  if (ISO.sky) isoSkyBackdrop(now, sx, sy);
  const chB = ISO.ch, fgB = ISO.fg, bgB = ISO.bg;
  for (let y = 0; y < ISO_H; y++) {
    const row = y * ISO_W;
    const py0 = Math.round(oy + y * chh), py1 = Math.round(oy + (y + 1) * chh);
    let x = 0;
    while (x < ISO_W) {
      const bg = bgB[row + x];
      if (!bg) { x++; continue; }
      let e = x + 1;
      while (e < ISO_W && bgB[row + e] === bg) e++;
      const px0 = Math.round(ox + x * cw), px1 = Math.round(ox + e * cw);
      ctx.fillStyle = bg;
      ctx.fillRect(px0, py0, px1 - px0, py1 - py0);
      x = e;
    }
  }
  ctx.font = RND.font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const yAdj = s * 0.5;
  let cur = null;
  for (let y = 0; y < ISO_H; y++) {
    const row = y * ISO_W;
    const cy = Math.round(Math.round(oy + y * chh) + chh / 2 + yAdj);
    for (let x = 0; x < ISO_W; x++) {
      const ch = chB[row + x];
      if (ch === ' ') continue;
      const fg = fgB[row + x];
      if (!fg) continue;
      if (fg !== cur) { ctx.fillStyle = fg; cur = fg; }
      let w = RND.gw.get(ch);
      if (w === undefined) { w = ctx.measureText(ch).width; RND.gw.set(ch, w); }
      const cx = Math.round(ox + (x + 0.5) * cw);
      if (w > cw * 1.04) ctx.fillText(ch, cx, cy, cw);
      else ctx.fillText(ch, cx, cy);
    }
  }
  // light glows (additive)
  const gl = ISO.glows;
  if (gl.length) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let k = 0; k < gl.length; k += 7) {
      const gx = ox + gl[k] * cw, gy = oy + (gl[k + 1] + 0.5) * chh, r = gl[k + 2] * cw;
      const a = gl[k + 6];
      if (a <= 0.004) continue;
      const gr = ctx.createRadialGradient(gx, gy, 0, gx, gy, r);
      gr.addColorStop(0, `rgba(${gl[k + 3] | 0},${gl[k + 4] | 0},${gl[k + 5] | 0},${a.toFixed(3)})`);
      gr.addColorStop(1, `rgba(${gl[k + 3] | 0},${gl[k + 4] | 0},${gl[k + 5] | 0},0)`);
      ctx.fillStyle = gr;
      ctx.fillRect(gx - r, gy - r, r * 2, r * 2);
    }
    ctx.restore();
  }
  // embers
  const em = ISO.embers, sec = dt / 1000;
  for (let i = em.length - 1; i >= 0; i--) {
    const e = em[i];
    e.t += sec; e.x += e.vx * sec + Math.sin(now * 0.004 + i) * 0.01; e.y += e.vy * sec;
    if (e.t >= e.life) { em.splice(i, 1); continue; }
    const px = ox + (e.x - ISO.camCi + ISO_CX + 0.5) * cw, py = oy + (e.y - ISO.camRi + ISO_CY + 0.5) * chh;
    const a = 1 - e.t / e.life;
    ctx.fillStyle = `rgba(255,${(150 + 80 * a) | 0},60,${(a * 0.9).toFixed(3)})`;
    const sz = Math.max(1, 1.6 * s);
    ctx.fillRect(px, py, sz, sz);
  }
  // pip health bars above wounded foes
  const bars = ISO.bars;
  for (let k = 0; k < bars.length; k += 4) {
    const bx = ox + bars[k] * cw, by = oy + bars[k + 1] * chh - 1 * s;
    const w = bars[k + 2] * cw, h = Math.max(2, 2.5 * s);
    ctx.fillStyle = 'rgba(20,4,6,0.85)';
    ctx.fillRect(bx, by, w, h);
    ctx.fillStyle = 'rgb(186,24,30)';
    ctx.fillRect(bx, by, w * bars[k + 3], h);
  }
}

// night sky behind small maps: mist for the Dream, a great moon over the flower field
function isoSkyBackdrop(now, sx, sy) {
  const ctx = RND.ctx, s = RND.s;
  const x0 = 0, y0 = RND.rowY[VIEW_Y], x1 = RND.colX[VIEW_W], y1 = RND.rowY[VIEW_Y + VIEW_H];
  const g = (typeof G !== 'undefined') ? G : null;
  const red = !!(g && g.save && g.save.flags && g.save.flags.moonRed);
  const field = ISO.sky === 2;
  const gkey = `${y0},${y1},${red},${field}`;
  let gr = ISO.skyGrad;
  if (!gr || ISO.skyKey !== gkey) {
    gr = ISO.skyGrad = ctx.createLinearGradient(0, y0, 0, y1);
    ISO.skyKey = gkey;
  if (field) {
    gr.addColorStop(0, red ? '#1e0507' : '#05050f');
    gr.addColorStop(0.6, red ? '#2c080a' : '#0d0c1c');
    gr.addColorStop(1, red ? '#14040a' : '#120c16');
  } else {
    gr.addColorStop(0, '#0c0b14');
    gr.addColorStop(0.5, '#15131e');
    gr.addColorStop(1, '#0d0b10');
  }
  }
  ctx.fillStyle = gr;
  ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  // stars with slight parallax
  const cw = RND.cw * s, chh = RND.ch * s;
  const pxo = -ISO.camC * 0.15 * cw, pyo = -ISO.camR * 0.15 * chh;
  const W = x1 - x0, Hh = y1 - y0;
  for (let k = 0; k < 90; k++) {
    const hx = hash2(k, 7, 61), hy = hash2(k, 9, 63);
    let px = (hx * W * 1.3 + pxo) % W; if (px < 0) px += W;
    let py = (hy * Hh * 1.3 + pyo) % Hh; if (py < 0) py += Hh;
    const tw = 0.4 + 0.6 * Math.abs(Math.sin(now * 0.0011 + k * 1.7));
    ctx.fillStyle = field ? (red ? `rgba(240,170,160,${(0.5 * tw).toFixed(3)})` : `rgba(210,214,240,${(0.6 * tw).toFixed(3)})`) : `rgba(200,200,220,${(0.25 * tw).toFixed(3)})`;
    const sz = Math.max(1, (hash2(k, 3, 5) < 0.15 ? 2 : 1.2) * s);
    ctx.fillRect(x0 + px + sx, y0 + py + sy, sz, sz);
  }
  if (field) {
    // the moon hangs in the north (screen upper right), far away (slow parallax)
    const mc = red ? [222, 58, 46] : [238, 224, 176];
    const gx = x0 + W * 0.74 - (ISO.camC - 20) * 0.12 * cw + sx;
    const gy = y0 + Hh * 0.2 - (ISO.camR - 50) * 0.1 * chh + sy;
    isoMoon(gx, gy, 6.5 * chh * 0.75, mc, red, now);
  } else {
    // the Dream: pale drifting mist bands
    ctx.save();
    for (let k = 0; k < 3; k++) {
      const yy = y0 + Hh * (0.25 + k * 0.25) + Math.sin(now * 0.0003 + k) * 8 * s;
      const mg = ctx.createLinearGradient(0, yy - 30 * s, 0, yy + 30 * s);
      mg.addColorStop(0, 'rgba(180,180,210,0)');
      mg.addColorStop(0.5, 'rgba(180,180,210,0.045)');
      mg.addColorStop(1, 'rgba(180,180,210,0)');
      ctx.fillStyle = mg;
      ctx.fillRect(x0, yy - 30 * s, W, 60 * s);
    }
    ctx.restore();
  }
}

// The moon (halo, blur, maria, craters) is pre-rendered once into an offscreen
// canvas by render.js's rndMoonPx, then blitted each frame: the blur is costly.
function isoMoon(gx, gy, r, mc, red, now) {
  const key = `${r.toFixed(1)},${red}`;
  let mcache = ISO.moonCache;
  if (!mcache || mcache.key !== key) {
    const size = Math.ceil(r * 6.4);
    let cv = null;
    try { cv = document.createElement('canvas'); cv.width = size; cv.height = size; } catch (e) { cv = null; }
    if (!cv) { rndMoonPx(gx, gy, r, mc, now, true); return; }
    const main = RND.ctx;
    RND.ctx = cv.getContext('2d');
    try { rndMoonPx(size / 2, size / 2, r, mc, now, true); } finally { RND.ctx = main; }
    mcache = ISO.moonCache = { key, cv, size };
  }
  const ctx = RND.ctx;
  const breathe = 0.94 + 0.06 * Math.sin(now * 0.0011);
  ctx.globalAlpha = breathe;
  ctx.drawImage(mcache.cv, Math.round(gx - mcache.size / 2), Math.round(gy - mcache.size / 2));
  ctx.globalAlpha = 1;
}
