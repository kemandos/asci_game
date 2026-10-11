'use strict';
// ---------------------------------------------------------------------------
// Renderer: the whole screen is a COLS x ROWS grid of glyphs drawn on a canvas.
// Each frame fills three cell buffers (glyph / foreground / background), then
// flushes them in a few batched passes. Pixel effects (particles, floating
// text, banners, flashes, vignettes) are drawn on top.
// ---------------------------------------------------------------------------

const RND = {
  canvas: null, ctx: null, stage: null,
  cw: 10, ch: 19,                 // logical cell size (css px at scale 1)
  s: 1,                           // device px per logical px
  colX: new Int32Array(COLS + 1), // device-pixel cell edges (snapped: no seams)
  rowY: new Int32Array(ROWS + 1),
  font: '', fontPx: 16,
  gw: new Map(),                  // glyph width cache (device px)
  chB: new Array(COLS * ROWS).fill(' '),
  fgB: new Array(COLS * ROWS).fill(null),
  bgB: new Array(COLS * ROWS).fill(null),
  vig: null, last: 0,
  motes: [], embers: [], ash: [],
  skyline: null,
  bossLag: 0, bossRef: null, bars: [], moon: null, prev: [], prevBusy: false,
  camX: 0, camY: 0,
  lampIdx: new WeakMap(),
};

const RND_SERIF = "'Cinzel', 'Trajan Pro', 'Cormorant Garamond', 'EB Garamond', 'Liberation Serif', 'DejaVu Serif', Georgia, 'Times New Roman', serif";
const RND_MEM = [62, 70, 96];          // memory tint (blue-grey)
const RND_WARM = [255, 178, 96];       // lamplight
const RND_BLOOD = [118, 10, 16];

// Untinted colour (HUD / UI chrome is never blood-moon tinted).
function rndRGB(c, k) {
  const r = Math.min(255, c[0] * k) | 0, g = Math.min(255, c[1] * k) | 0, b = Math.min(255, c[2] * k) | 0;
  return `rgb(${r},${g},${b})`;
}
function rndRGBA(c, a) { return `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a.toFixed(3)})`; }

// --- setup -----------------------------------------------------------------
function initScreen() {
  RND.canvas = document.getElementById('screen');
  RND.stage = document.getElementById('stage');
  RND.ctx = RND.canvas.getContext('2d', { alpha: false });
  const c = RND.ctx;
  c.font = `16px ${FONT_STACK}`;
  RND.cw = Math.ceil(c.measureText('M').width);
  RND.ch = Math.round(16 * 1.18);
  rndResize();
  window.addEventListener('resize', rndResize);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => RND.gw.clear()).catch(() => {});
}

function rndResize() {
  const cv = RND.canvas;
  if (!cv) return;
  const hint = document.getElementById('hint');
  const hintH = hint ? hint.offsetHeight + 6 : 0;
  const availW = Math.max(200, window.innerWidth - 12);
  const availH = Math.max(150, window.innerHeight - hintH - 12);
  const lw = COLS * RND.cw, lh = ROWS * RND.ch;
  const scale = Math.max(0.35, Math.min(availW / lw, availH / lh));
  const cssW = Math.floor(lw * scale), cssH = Math.floor(lh * scale);
  const dpr = window.devicePixelRatio || 1;
  cv.style.width = cssW + 'px';
  cv.style.height = cssH + 'px';
  cv.width = Math.round(cssW * dpr);
  cv.height = Math.round(cssH * dpr);
  RND.s = cv.width / lw;
  for (let x = 0; x <= COLS; x++) RND.colX[x] = Math.round(x * RND.cw * RND.s);
  for (let y = 0; y <= ROWS; y++) RND.rowY[y] = Math.round(y * RND.ch * RND.s);
  RND.fontPx = 16 * RND.s;
  RND.font = `${RND.fontPx.toFixed(2)}px ${FONT_STACK}`;
  RND.gw.clear();
  if (RND.stage) {
    RND.stage.style.width = cssW + 'px';
    RND.stage.style.height = cssH + 'px';
    RND.stage.style.setProperty('--u', (cssW / lw).toFixed(4));
  }
  // viewport vignette
  const ctx = RND.ctx;
  const x0 = 0, y0 = RND.rowY[VIEW_Y], x1 = RND.colX[VIEW_W], y1 = RND.rowY[VIEW_Y + VIEW_H];
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rad = Math.hypot(x1 - x0, y1 - y0) / 2;
  const v = ctx.createRadialGradient(cx, cy, rad * 0.42, cx, cy, rad);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,0.62)');
  RND.vig = v;
  const lv = ctx.createRadialGradient(cx, cy, rad * 0.3, cx, cy, rad);
  lv.addColorStop(0, 'rgba(120,0,0,0)');
  lv.addColorStop(1, 'rgba(150,0,0,0.55)');
  RND.lowVig = lv;
}

// --- cell buffer ---------------------------------------------------------------
function rndClear() {
  RND.chB.fill(' '); RND.fgB.fill(null); RND.bgB.fill(null);
}
function rndPut(x, y, ch, fg, bg) {
  if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return;
  const i = y * COLS + x;
  RND.chB[i] = ch; RND.fgB[i] = fg;
  if (bg !== undefined) RND.bgB[i] = bg;
}
function rndBg(x, y, bg) {
  if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return;
  RND.bgB[y * COLS + x] = bg;
}
function rndText(x, y, str, fg, bg) {
  for (let k = 0; k < str.length; k++) rndPut(x + k, y, str[k], fg, bg);
  return x + str.length;
}

function rndFlush(r0, r1, dx, dy) {
  const ctx = RND.ctx, cX = RND.colX, rY = RND.rowY, chB = RND.chB, fgB = RND.fgB, bgB = RND.bgB;
  // backgrounds: merge horizontal runs of identical colour
  for (let y = r0; y < r1; y++) {
    const row = y * COLS;
    let x = 0;
    while (x < COLS) {
      const bg = bgB[row + x];
      if (!bg) { x++; continue; }
      let e = x + 1;
      while (e < COLS && bgB[row + e] === bg) e++;
      ctx.fillStyle = bg;
      ctx.fillRect(cX[x] + dx, rY[y] + dy, cX[e] - cX[x], rY[y + 1] - rY[y]);
      x = e;
    }
  }
  ctx.font = RND.font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const cwD = cX[1] - cX[0];
  const yAdj = RND.s * 0.5;
  let cur = null;
  for (let y = r0; y < r1; y++) {
    const row = y * COLS;
    const cy = (rY[y] + rY[y + 1]) / 2 + dy + yAdj;
    for (let x = 0; x < COLS; x++) {
      const ch = chB[row + x];
      if (ch === ' ') continue;
      const fg = fgB[row + x];
      if (!fg) continue;
      if (fg !== cur) { ctx.fillStyle = fg; cur = fg; }
      let w = RND.gw.get(ch);
      if (w === undefined) { w = ctx.measureText(ch).width; RND.gw.set(ch, w); }
      const cx = (cX[x] + cX[x + 1]) / 2 + dx;
      if (w > cwD * 1.04) ctx.fillText(ch, cx, cy, cwD);
      else ctx.fillText(ch, cx, cy);
    }
  }
}

// map cell -> device pixel centre
function rndCellPx(mx, my) {
  if (typeof isoActive === 'function' && isoActive()) return isoCellPx(mx, my);
  const sx = mx - RND.camX, sy = my - RND.camY + VIEW_Y;
  const cw = RND.cw * RND.s, ch = RND.ch * RND.s;
  return [(sx + 0.5) * cw, (sy + 0.5) * ch];
}

function rndFxFrac(f) {
  // f.t counts up from 0 to f.life (age). Returns 0..1 of elapsed life.
  if (!f.life) return 0;
  return clamp((f.t || 0) / f.life, 0, 1);
}

// --- main entry ----------------------------------------------------------------
function renderFrame(now) {
  if (!RND.ctx) return;
  const dt = Math.min(100, Math.max(0, now - (RND.last || now)));
  RND.last = now;
  const ctx = RND.ctx, cv = RND.canvas;
  rndClear();
  RND.bars.length = 0;
  RND.moon = null;
  RND.prev.length = 0;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#060507';
  ctx.fillRect(0, 0, cv.width, cv.height);

  const g = (typeof G !== 'undefined') ? G : null;
  if (!g || !g.map || !g.p || g.mode === 'title' || g.mode === 'ending') {
    rndBackdrop(now, dt, g);
    rndBanner(now, g);
    return;
  }
  const m = g.map;
  const iso = typeof isoActive === 'function' && isoActive(g);   // js/iso.js
  if (iso) drawIsoView(now, g, m); else rndMap(now, g, m);
  rndHud(now, g);
  rndBottom(now, g, m);

  // HUD rows
  rndFlush(0, VIEW_Y, 0, 0);
  rndFlush(VIEW_Y + VIEW_H, ROWS, 0, 0);
  rndFrameLines();
  for (const b of RND.bars) rndBar(b);

  // viewport with shake
  let sx = 0, sy = 0;
  const shake = Math.min(14, +g.shake || 0);
  if (shake > 0) {
    const a = shake * RND.s * 0.9;
    sx = Math.round((Math.random() * 2 - 1) * a);
    sy = Math.round((Math.random() * 2 - 1) * a);
  }
  const vx0 = 0, vy0 = RND.rowY[VIEW_Y], vx1 = RND.colX[VIEW_W], vy1 = RND.rowY[VIEW_Y + VIEW_H];
  ctx.save();
  ctx.beginPath(); ctx.rect(vx0, vy0, vx1 - vx0, vy1 - vy0); ctx.clip();
  if (iso) isoFlushView(now, sx, sy); else rndFlush(VIEW_Y, VIEW_Y + VIEW_H, sx, sy);
  ctx.translate(sx, sy);
  if (RND.moon) rndFieldMoon(now, m);
  rndPreview(now);
  rndMotes(now, dt, g, m);
  rndFxPixels(now, g);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // vignette, low health, flash, death veil
  ctx.fillStyle = RND.vig; ctx.fillRect(vx0, vy0, vx1 - vx0, vy1 - vy0);
  const p = g.p;
  const mh = rndMaxHp();
  if (p && !p.dead && mh && p.hp / mh < 0.3 && g.mode !== 'dead') {
    ctx.globalAlpha = 0.45 + 0.35 * Math.sin(now * 0.006);
    ctx.fillStyle = RND.lowVig; ctx.fillRect(vx0, vy0, vx1 - vx0, vy1 - vy0);
    ctx.globalAlpha = 1;
  }
  const fl = +g.flash || 0;
  if (fl > 0) {
    const a = fl > 1 ? Math.min(0.5, fl * 0.05) : Math.min(0.5, fl * 0.5);
    ctx.fillStyle = `rgba(160,0,8,${a.toFixed(3)})`;
    ctx.fillRect(vx0, vy0, vx1 - vx0, vy1 - vy0);
  }
  if (g.mode === 'dead') {
    ctx.fillStyle = 'rgba(8,0,0,0.42)';
    ctx.fillRect(vx0, vy0, vx1 - vx0, vy1 - vy0);
  }
  ctx.restore();
  rndBanner(now, g);
}

function rndParryable(e) {
  try { return typeof parryWindow === 'function' && parryWindow(e); } catch (err) { return false; }
}
function rndMaxHp() {
  try { return typeof maxHp === 'function' ? maxHp() : 100; } catch (e) { return 100; }
}
function rndMaxSt() {
  try { return typeof maxSt === 'function' ? maxSt() : 100; } catch (e) { return 100; }
}

// --- map -------------------------------------------------------------------------
function rndLampAt(m, i) {
  let idx = RND.lampIdx.get(m);
  if (!idx) {
    idx = new Map();
    for (const l of (m.lamps || [])) idx.set(l.y * m.w + l.x, l);
    RND.lampIdx.set(m, idx);
  }
  return idx.get(i);
}

function rndCamera(g, m) {
  const p = g.p;
  let cx, cy;
  if (m.w <= VIEW_W) cx = -Math.floor((VIEW_W - m.w) / 2);
  else cx = clamp(p.x - (VIEW_W >> 1), 0, m.w - VIEW_W);
  if (m.h <= VIEW_H) cy = -Math.floor((VIEW_H - m.h) / 2);
  else cy = clamp(p.y - (VIEW_H >> 1), 0, m.h - VIEW_H);
  RND.camX = cx; RND.camY = cy;
  if (g.cam) { g.cam.x = cx; g.cam.y = cy; } else g.cam = { x: cx, y: cy };
}

function rndMap(now, g, m) {
  rndCamera(g, m);
  const camX = RND.camX, camY = RND.camY, def = m.def || {};
  const W = m.w, H = m.h;
  const vis = m.vis, seen = m.seen, light = m.light, tiles = m.tiles, blood = m.blood;
  const wallCol = C(def.wall || '#5f4f49'), floorCol = C(def.floor || '#6f665d'), grassCol = C(def.grass || '#4d5c3c');
  const floorChars = def.floorChars || '.', grassChars = def.grassChars || '"';
  const wallCh = def.wallCh || '#';
  const tT = (typeof T !== 'undefined') ? T : { WALL: 0, FLOOR: 1, FOG: 2, DECOR: 3, LAMP: 4, GRASS: 5, SKY: 6, FLOWER: 7, FEATURE: 8 };
  const flags = (g.save && g.save.flags) || {};
  const litLamps = (g.save && g.save.litLamps) || [];
  const tSec = now / 1000;
  const shimmer = now * 0.009;
  const isDream = m.id === 'dream' || m.id === 'field';

  for (let vy = 0; vy < VIEW_H; vy++) {
    const my = vy + camY;
    if (my < 0 || my >= H) continue;
    const sy = vy + VIEW_Y;
    for (let vx = 0; vx < VIEW_W; vx++) {
      const mx = vx + camX;
      if (mx < 0 || mx >= W) continue;
      const i = my * W + mx;
      const t = tiles[i];
      if (t === tT.SKY) { rndSky(vx, sy, mx, my, m, now, flags); continue; }
      const b = vis ? vis[i] : 0;
      const sn = seen ? seen[i] : 0;
      if (b <= 0 && !sn) continue;
      const h = hash2(mx, my, 11);
      let ch = '.', col = floorCol, bg, emissive = 0, fixedK = 0;

      if (t === tT.WALL) {
        if (m.wallVis && !m.wallVis[i]) continue;
        ch = wallCh;
        col = wallCol;
        const v = 0.86 + h * 0.26;
        col = [col[0] * v, col[1] * v, col[2] * v];
        if (b > 0) bg = shade(wallCol, 0.1 * (0.3 + b));
      } else if (t === tT.FLOOR || t === tT.GRASS) {
        const fg = m.fglyph && m.fglyph.get(i);
        if (fg) {
          ch = fg.ch; col = C(fg.col);
          if (fg.flicker) {
            const fk = 0.8 + 0.2 * Math.sin(now * 0.019 + h * 40) + 0.1 * Math.sin(now * 0.047 + h * 13);
            col = mix(col, [255, 226, 130], 0.2 + 0.2 * Math.sin(now * 0.015 + h * 9));
            col = [col[0] * fk, col[1] * fk, col[2] * fk];
            emissive = 0.9;
            if (b > 0) bg = rndRGB([70, 40, 8], 0.3 + 0.2 * fk);
          }
        }
        else if (t === tT.GRASS) {
          ch = grassChars[Math.floor(h * grassChars.length)];
          const v = 0.8 + hash2(mx, my, 3) * 0.4;
          col = [grassCol[0] * v, grassCol[1] * v, grassCol[2] * v];
        } else {
          ch = floorChars[Math.floor(h * floorChars.length)];
          const v = 0.82 + hash2(mx, my, 5) * 0.32;
          col = [floorCol[0] * v, floorCol[1] * v, floorCol[2] * v];
        }
      } else if (t === tT.FLOWER) {
        const f = hash2(mx, my, 23);
        const sway = Math.sin(tSec * 1.3 + mx * 0.35 + my * 0.2);
        if (f < 0.34) {
          ch = f < 0.2 ? '*' : '·';
          const w = 0.88 + 0.12 * sway;
          col = f < 0.2 ? [232 * w, 228 * w, 220 * w] : [214 * w, 206 * w, 228 * w];
        } else {
          ch = f < 0.6 ? '"' : f < 0.8 ? ',' : '\'';
          const v = 0.75 + hash2(mx, my, 3) * 0.4 + 0.08 * sway;
          col = [grassCol[0] * v, grassCol[1] * v, grassCol[2] * v];
        }
      } else if (t === tT.FOG) {
        const ph = h * 6.28 + tSec * 1.6 + Math.sin(tSec * 0.7 + my * 0.5);
        const s = Math.sin(ph);
        ch = s > 0.35 ? '▒' : s > -0.5 ? '░' : '▒';
        const k = 0.55 + 0.25 * Math.sin(ph * 0.7 + 1);
        const base = m.fogLocked ? [228, 220, 214] : [200, 204, 222];
        col = [base[0] * k, base[1] * k, base[2] * k];
        fixedK = 1;
        bg = rndRGB([42, 42, 54], (m.fogLocked ? 1.3 : 0.8) * (0.7 + 0.3 * s));
      } else if (t === tT.DECOR) {
        const d = m.decor && m.decor.get(i);
        if (d) {
          ch = d.ch; col = C(d.col);
          if (d.flicker) {
            const fk = 0.78 + 0.22 * Math.sin(now * 0.021 + h * 40) + 0.12 * Math.sin(now * 0.053 + h * 17);
            col = mix(col, [255, 214, 90], 0.25 + 0.25 * Math.sin(now * 0.017 + h * 9));
            col = [col[0] * fk, col[1] * fk, col[2] * fk];
            emissive = 1;
            if (b > 0) {
              bg = rndRGB([90, 32, 6], 0.35 + 0.25 * fk);
              rndSpawnEmber(mx, my, now);
            }
          } else if (d.ch === 'i' || d.ch === '¡') emissive = 0.8;
        } else { ch = '?'; col = [120, 120, 120]; }
      } else if (t === tT.LAMP) {
        ch = '¥';
        const lamp = rndLampAt(m, i);
        const lit = lamp && (litLamps.indexOf(lamp.id) >= 0 || (m.id === 'dream'));
        if (lit) {
          const pk = 0.85 + 0.2 * Math.sin(now * 0.004 + h * 6);
          col = [255 * pk, 205 * pk, 96 * pk];
          emissive = 1;
          bg = rndRGB([96, 64, 14], 0.45 + 0.2 * Math.sin(now * 0.004));
        } else {
          col = [176, 150, 98];
          const pk = 0.7 + 0.12 * Math.sin(now * 0.002 + h * 6);
          col = [col[0] * pk, col[1] * pk, col[2] * pk];
          emissive = 0.4;
        }
      } else if (t === tT.FEATURE) {
        const f = m.featAt && m.featAt.get(i);
        if (f) {
          ch = f.ch; col = C(f.col);
          if (f.kind === 'window') {
            const pk = 0.85 + 0.15 * Math.sin(now * 0.003);
            col = [col[0] * pk, col[1] * pk, col[2] * pk];
            emissive = 1;
            bg = rndRGB([80, 58, 14], 0.6 * pk);
          } else emissive = 0.55;
        } else { ch = '?'; col = [180, 180, 180]; }
      }

      let fg;
      if (b > 0) {
        let k = fixedK ? 1 : 0.18 + 1.1 * Math.min(1.1, b);
        if (emissive) k = Math.max(k, 0.8 + 0.2 * emissive);
        const lt = light ? light[i] : 0;
        if (lt > 0.04 && !fixedK) {
          col = mix(col, RND_WARM, Math.min(0.42, lt * 0.5));
          k *= 1 + 0.07 * Math.sin(shimmer + h * 30) * Math.min(1, lt * 2);
          if (!bg && lt > 0.2 && !isDream) bg = rndRGB([34, 17, 5], lt);
        }
        if (blood && blood[i] && t !== tT.WALL) {
          const bt = Math.min(0.85, 0.3 + blood[i] * 0.12);
          col = mix(col, RND_BLOOD, bt);
          k = Math.max(k, 0.5);
          if (!bg || bt > 0.5) bg = shade([58, 3, 7], bt * Math.min(1, 0.4 + b));
        }
        fg = shade(col, k);
        // faint ground: lit stone/grass gets a quantized dark backing so rooms read as solid
        if (!bg && t !== tT.WALL && t !== tT.FOG) {
          const q = Math.round(Math.min(1, b) * 8) / 8;
          if (q > 0) bg = shade(lt > 0.2 ? [60, 40, 24] : [34, 30, 30], 0.18 + 0.32 * q);
        }
      } else {
        // remembered: very dim blue-grey, no lamps, no blood glow
        const mc = mix(col, RND_MEM, 0.62);
        fg = rndRGB(mc, t === tT.WALL ? 0.46 : 0.36);
        bg = undefined;
        if (t === tT.FOG) fg = rndRGB([150, 150, 170], 0.35);
      }
      rndPut(vx, sy, ch, fg, bg);
    }
  }

  rndOverlays(now, g, m);
}

function rndSky(vx, sy, mx, my, m, now, flags) {
  const red = !!flags.moonRed;
  const skyBg = red ? [26, 6, 8] : [10, 10, 22];
  const fade = 1 - my / Math.max(1, (m.moon ? m.moon.cy * 4 : 20));
  let bg = rndRGB(skyBg, 0.55 + 0.45 * Math.max(0, fade));
  if (m.moon && !RND.moon) RND.moon = { mo: m.moon, mc: red ? [222, 58, 46] : [238, 224, 176] };
  const s = hash2(mx, my, 47);
  if (s < 0.035) {
    const tw = 0.5 + 0.5 * Math.sin(now * 0.002 + s * 900);
    const ch = s < 0.006 ? '+' : s < 0.018 ? '·' : '.';
    rndPut(vx, sy, ch, rndRGB(red ? [230, 170, 160] : [210, 214, 240], 0.35 + 0.6 * tw), bg);
  } else rndBg(vx, sy, bg);
}

// A great moon drawn in pixels (smooth disc, soft maria) with an ASCII crater
// texture snapped to the character grid. Coordinates in device px.
const RND_MARIA = [[-0.32, -0.22, 0.36], [0.28, 0.12, 0.3], [0.02, 0.48, 0.22], [-0.38, 0.36, 0.17], [0.42, -0.38, 0.14]];
function rndMoonPx(gx, gy, r, mc, now, halo) {
  const ctx = RND.ctx, s = RND.s;
  ctx.save();
  if (halo) {
    const hg = ctx.createRadialGradient(gx, gy, r * 0.9, gx, gy, r * 3);
    hg.addColorStop(0, rndRGBA(mc, 0.26));
    hg.addColorStop(0.35, rndRGBA(mc, 0.07));
    hg.addColorStop(1, rndRGBA(mc, 0));
    ctx.fillStyle = hg;
    ctx.fillRect(gx - r * 3, gy - r * 3, r * 6, r * 6);
  }
  const breathe = 0.97 + 0.03 * Math.sin(now * 0.0011);
  const dg = ctx.createRadialGradient(gx - r * 0.35, gy - r * 0.35, r * 0.05, gx, gy, r);
  dg.addColorStop(0, rndRGB(mc, 1.1 * breathe));
  dg.addColorStop(0.7, rndRGB(mc, 0.95 * breathe));
  dg.addColorStop(1, rndRGB(mc, 0.72 * breathe));
  ctx.beginPath();
  ctx.arc(gx, gy, r, 0, Math.PI * 2);
  ctx.shadowColor = rndRGBA(mc, 0.85);
  ctx.shadowBlur = 34 * s;
  ctx.fillStyle = dg;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.clip();
  const dark = [mc[0] * 0.55, mc[1] * 0.5, mc[2] * 0.5];
  for (const [ox, oy, rr] of RND_MARIA) {
    const mx = gx + ox * r, my = gy + oy * r, R2 = rr * r;
    const mg = ctx.createRadialGradient(mx, my, 0, mx, my, R2);
    mg.addColorStop(0, rndRGBA(dark, 0.32));
    mg.addColorStop(1, rndRGBA(dark, 0));
    ctx.fillStyle = mg;
    ctx.fillRect(mx - R2, my - R2, R2 * 2, R2 * 2);
  }
  // ASCII craters on the character grid
  ctx.font = RND.font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = rndRGBA(dark, 0.75);
  const cX = RND.colX, rY = RND.rowY;
  for (let row = 0; row < ROWS; row++) {
    const cy = (rY[row] + rY[row + 1]) / 2;
    if (cy < gy - r || cy > gy + r) continue;
    for (let col = 0; col < COLS; col++) {
      const cx = (cX[col] + cX[col + 1]) / 2;
      const dd = Math.hypot(cx - gx, cy - gy) / r;
      if (dd > 0.88) continue;
      const h = hash2(col, row, 5);
      if (h < 0.16) ctx.fillText(h < 0.035 ? 'o' : h < 0.09 ? '.' : '·', cx, cy);
    }
  }
  ctx.restore();
}

// --- things on top of the map -------------------------------------------------------
function rndOverlays(now, g, m) {
  const camX = RND.camX, camY = RND.camY, W = m.w;
  const vis = m.vis, seen = m.seen;
  const inView = (x, y) => x - camX >= 0 && x - camX < VIEW_W && y - camY >= 0 && y - camY < VIEW_H && x >= 0 && y >= 0 && x < W && y < m.h;
  const put = (x, y, ch, fg, bg) => rndPut(x - camX, y - camY + VIEW_Y, ch, fg, bg);
  const bgAt = (x, y, bg) => rndBg(x - camX, y - camY + VIEW_Y, bg);
  const save = g.save || {};
  const taken = save.taken || {};

  // items lying around
  for (const it of (m.items || [])) {
    if (taken[it.key] && it.kind !== 'note') continue;
    if (!inView(it.x, it.y)) continue;
    const i = it.y * W + it.x;
    const gl = ITEM_GLYPH[it.kind] || ITEM_GLYPH.note;
    if (vis[i] > 0) {
      const ph = (now / 1000 + hash2(it.x, it.y, 3) * 7) % 3.2;
      const glint = ph < 0.14;
      const read = taken[it.key] && it.kind === 'note';
      const c = C(gl.col);
      put(it.x, it.y, gl.ch, glint ? '#ffffff' : shade(c, read ? 0.5 : 0.75 + 0.35 * Math.min(1, vis[i])),
        glint ? 'rgb(70,64,48)' : (read ? undefined : rndRGB([40, 34, 22], 1)));
    } else if (seen[i]) put(it.x, it.y, gl.ch, rndRGB(mix(C(gl.col), RND_MEM, 0.6), 0.3));
  }

  // drops
  for (const d of (g.drops || [])) {
    if (!inView(d.x, d.y)) continue;
    const i = d.y * W + d.x;
    if (!(vis[i] > 0)) continue;
    const gl = ITEM_GLYPH[d.kind];
    if (!gl) continue;
    const pk = 0.85 + 0.25 * Math.sin(now * 0.008 + d.x);
    put(d.x, d.y, gl.ch, shade(C(gl.col), pk), rndRGB([46, 36, 20], 1));
  }

  // bloodstain
  const st = save.stain;
  if (st && st.area === m.id && inView(st.x, st.y)) {
    const i = st.y * W + st.x;
    if (seen[i] || vis[i] > 0) {
      const pk = 0.6 + 0.4 * Math.sin(now * 0.005);
      put(st.x, st.y, '§', rndRGB([255, 40, 50], 0.55 + 0.45 * pk), rndRGB([90, 0, 8], 0.4 + 0.5 * pk));
    }
  }

  // attack-shape preview in front of the player (faint)
  const p = g.p;
  if (g.mode === 'play' && p && !p.dead && typeof currentShapeTiles === 'function') {
    let tiles = null;
    try { tiles = currentShapeTiles(); } catch (e) { tiles = null; }
    if (tiles) {
      RND.prevBusy = (p.act || 0) > 0;
      for (const tt of tiles) {
        const x = tt[0], y = tt[1];
        if (!inView(x, y)) continue;
        const i = y * W + x;
        if (m.tiles[i] === 0) continue;
        RND.prev.push(x, y);
        if (RND.prevBusy) bgAt(x, y, 'rgb(62,50,30)');
      }
    }
  }

  // telegraphs: every winding-up entity paints its stored target tiles red
  const ents = g.enemies || [];
  for (const e of ents) {
    if (e.dead || e.state !== 'windup' || !e.tiles || !e.atk) continue;
    const wu = e.atk.windup || 10;
    const pr = clamp(1 - (e.timer || 0) / wu, 0, 1);
    let I = 0.28 + 0.72 * pr;
    if (rndParryable(e)) I *= 0.85 + 0.15 * Math.sin(now * 0.06);
    const special = e.atk.special === 'bloodletting';
    const bg = special
      ? rndRGB([120 + 100 * I, 8, 60 + 40 * I], 0.55 + 0.45 * I)
      : `rgb(${(48 + 172 * I) | 0},${(4 + 16 * I) | 0},${(6 + 12 * I) | 0})`;
    for (const idx of e.tiles) {
      const x = idx % W, y = (idx / W) | 0;
      if (!inView(x, y)) continue;
      if (m.tiles[idx] === 0 && m.wallVis && !m.wallVis[idx]) continue;
      bgAt(x, y, bg);
    }
  }

  // enemies (only on visible tiles)
  for (const e of ents) {
    if (e.dead) continue;
    const size = e.size || 1;
    const base = C(e.col || (e.d && e.d.col) || '#cccccc');
    let col = base;
    let bgCol;
    if (e.flashT > 0) col = [255, 255, 255];
    else if (e.state === 'stagger') {
      const pk = 0.5 + 0.5 * Math.sin(now * 0.025);
      col = mix(base, [255, 222, 60], 0.55 + 0.45 * pk);
      bgCol = rndRGB([90, 70, 0], 0.4 + 0.6 * pk);
    } else if (e.state === 'windup' && e.atk) {
      const pr = clamp(1 - (e.timer || 0) / (e.atk.windup || 10), 0, 1);
      if (rndParryable(e)) {
        // exactly the gun-parry window: hard white-hot flash ("shoot now")
        const pk = 0.5 + 0.5 * Math.sin(now * 0.05);
        col = mix([255, 70, 56], [255, 244, 210], 0.35 + 0.65 * pk);
        bgCol = rndRGB([150, 24, 16], 0.6 + 0.4 * pk);
      } else col = mix(base, [255, 70, 56], 0.15 + 0.35 * pr);
    } else if (e.state === 'dormant') col = mix(base, [90, 90, 110], 0.25);
    else if (e.state === 'transform') col = mix(base, [255, 255, 255], 0.5 + 0.5 * Math.sin(now * 0.04));
    const art = size > 1 ? (e.art || (e.d && e.d.art)) : null;
    for (let dy = 0; dy < size; dy++) {
      for (let dx = 0; dx < size; dx++) {
        const x = e.x + dx, y = e.y + dy;
        if (!inView(x, y)) continue;
        const i = y * W + x;
        const v = vis[i];
        if (!(v > 0)) continue;
        let ch = art ? ((art[dy] && art[dy][dx]) || ' ') : (e.ch || (e.d && e.d.ch) || '?');
        const k = 0.6 + 0.5 * Math.min(1, v);
        const fg = (e.flashT > 0) ? '#ffffff' : shade(col, k);
        const curBg = RND.bgB[(y - camY + VIEW_Y) * COLS + (x - camX)];
        let bg = bgCol;
        if (!bg && e.boss) bg = curBg || rndRGB(mix(base, [0, 0, 0], 0.88), 1);
        if (ch === ' ') { if (bg) bgAt(x, y, bg); continue; }
        put(x, y, ch, fg, bg);
      }
    }
  }

  // fx glyphs
  for (const f of (g.fx || [])) {
    if (f.k !== 'g') continue;
    const x = Math.round(f.x), y = Math.round(f.y);
    if (!inView(x, y)) continue;
    const a = 1 - rndFxFrac(f) * 0.75;
    put(x, y, f.ch, shade(C(f.col || '#ffffff'), a));
  }

  // the hunter
  if (p && inView(p.x, p.y)) {
    let col = [238, 230, 212], k = 1.05;
    const mh = rndMaxHp();
    if (p.dead || g.mode === 'dead') { col = [150, 20, 24]; k = 0.9; }
    else if (p.flashT > 0) col = [120, 236, 130];
    else if (p.iframes > 0) { col = [128, 150, 190]; k = 0.75; }
    else if (mh && p.hp / mh < 0.25) col = mix(col, [255, 50, 50], 0.45 + 0.4 * Math.sin(now * 0.012));
    // dodge afterimage (optional ghost)
    const gh = p.ghost;
    if (gh && typeof gh.x === 'number' && inView(gh.x, gh.y) && (gh.x !== p.x || gh.y !== p.y) && (gh.t === undefined || gh.t > 0)) {
      put(gh.x, gh.y, '@', 'rgb(70,84,118)');
    }
    put(p.x, p.y, '@', rndRGB(col, k));
  }
}

// The field's moon hangs far away (parallax) and sets behind the hill: clip it
// to the sky cells of each column.
function rndFieldMoon(now, m) {
  const { mo, mc } = RND.moon;
  const ctx = RND.ctx, s = RND.s;
  const cw = RND.cw * s, ch = RND.ch * s;
  const tSky = (typeof T !== 'undefined') ? T.SKY : 6;
  ctx.save();
  ctx.beginPath();
  let any = false;
  for (let vx = 0; vx < VIEW_W; vx++) {
    const mx = vx + RND.camX;
    if (mx < 0 || mx >= m.w) continue;
    let n = 0;
    for (let my = Math.max(0, RND.camY); my < m.h && m.tiles[my * m.w + mx] === tSky; my++) n++;
    if (n) { ctx.rect(vx * cw, VIEW_Y * ch, cw + 0.5, n * ch); any = true; }
  }
  if (any) {
    ctx.clip();
    const gx = (mo.cx - RND.camX + 0.5) * cw;
    const gy = (mo.cy - RND.camY * 0.3 + VIEW_Y + 0.5) * ch;
    rndMoonPx(gx, gy, (mo.rx * RND.cw + mo.ry * RND.ch) / 2 * s * 0.95, mc, now, true);
  }
  ctx.restore();
}

// faint bracket outline of the player's current attack shape
function rndPreview(now) {
  const pv = RND.prev;
  if (!pv.length) return;
  const ctx = RND.ctx, s = RND.s;
  const cw = RND.cw * s, ch = RND.ch * s;
  const busy = RND.prevBusy;
  ctx.fillStyle = busy ? 'rgba(255,214,140,0.10)' : 'rgba(200,180,140,0.06)';
  ctx.strokeStyle = busy ? 'rgba(255,214,140,0.45)' : 'rgba(210,190,150,0.20)';
  ctx.lineWidth = Math.max(1, s);
  const ins = 1.5 * s;
  for (let k = 0; k < pv.length; k += 2) {
    const px = (pv[k] - RND.camX) * cw, py = (pv[k + 1] - RND.camY + VIEW_Y) * ch;
    ctx.fillRect(px + ins, py + ins, cw - ins * 2, ch - ins * 2);
    ctx.strokeRect(px + ins + 0.5, py + ins + 0.5, cw - ins * 2 - 1, ch - ins * 2 - 1);
  }
}

// --- ambient motes / embers (render-only particles) ----------------------------------------
function rndSpawnEmber(mx, my, now) {
  if (RND.embers.length > 90 || Math.random() > 0.03) return;
  RND.embers.push({ x: mx + 0.3 + Math.random() * 0.4, y: my + 0.2, vx: (Math.random() - 0.5) * 0.4, vy: -(0.6 + Math.random() * 0.9), life: 1 + Math.random() * 1.2, t: 0 });
}

function rndMotes(now, dt, g, m) {
  const ctx = RND.ctx, s = RND.s, cw = RND.cw * s, ch = RND.ch * s;
  const sec = dt / 1000;
  // embers rising from pyres (map-space)
  const em = RND.embers;
  for (let i = em.length - 1; i >= 0; i--) {
    const e = em[i];
    e.t += sec; e.x += e.vx * sec + Math.sin(now * 0.004 + i) * 0.01; e.y += e.vy * sec;
    if (e.t >= e.life) { em.splice(i, 1); continue; }
    const px = (e.x - RND.camX) * cw, py = (e.y - RND.camY + VIEW_Y) * ch;
    const a = 1 - e.t / e.life;
    ctx.fillStyle = `rgba(255,${(150 + 80 * a) | 0},60,${(a * 0.9).toFixed(3)})`;
    const sz = Math.max(1, 1.6 * s);
    ctx.fillRect(px, py, sz, sz);
  }
  // drifting ash / petals (screen-space)
  const kind = m.id === 'dream' || m.id === 'field' ? 'petal' : 'ash';
  const want = kind === 'petal' ? 26 : 34;
  const W = RND.colX[VIEW_W], y0 = RND.rowY[VIEW_Y], y1 = RND.rowY[VIEW_Y + VIEW_H];
  const mo = RND.motes;
  while (mo.length < want) mo.push({ x: Math.random() * W, y: y0 + Math.random() * (y1 - y0), ph: Math.random() * 7, sp: 0.4 + Math.random() * 0.8, z: 0.4 + Math.random() * 0.6 });
  const red = typeof TINT !== 'undefined' && TINT[1] < 0.9;
  for (const a of mo) {
    a.y += (kind === 'petal' ? 9 : 14) * a.sp * sec * s;
    a.x += (Math.sin(now * 0.0007 + a.ph) * 10 + (kind === 'petal' ? 6 : -4)) * sec * s;
    if (a.y > y1) { a.y = y0 - 2; a.x = Math.random() * W; }
    if (a.x < 0) a.x += W; else if (a.x > W) a.x -= W;
    const al = 0.12 + 0.22 * a.z;
    ctx.fillStyle = kind === 'petal' ? `rgba(236,232,224,${al.toFixed(3)})` : red ? `rgba(170,90,80,${al.toFixed(3)})` : `rgba(150,142,140,${al.toFixed(3)})`;
    const sz = Math.max(1, (kind === 'petal' ? 2 : 1.5) * a.z * s);
    ctx.fillRect(a.x, a.y, sz, sz * (kind === 'petal' ? 0.7 : 1));
  }
}

function rndFxPixels(now, g) {
  const ctx = RND.ctx, s = RND.s;
  const fx = g.fx || [];
  for (const f of fx) {
    if (f.k === 'p') {
      const fr = rndFxFrac(f);
      const [px, py] = rndCellPx(f.x, f.y);
      const c = C(f.col || '#b0101a');
      ctx.fillStyle = rndRGBA(c, Math.max(0, 1 - fr) * 0.95);
      const sz = Math.max(1, (f.size || 2.6) * s * (1 - fr * 0.4));
      ctx.fillRect(px - sz / 2, py - sz / 2, sz, sz);
    }
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const slots = new Map();   // texts born together on the same cell stack upward
  for (let n = fx.length - 1; n >= 0; n--) {
    const f = fx[n];
    if (f.k !== 't') continue;
    const fr = rndFxFrac(f);
    const key = `${Math.round(f.x)},${Math.round(f.y)},${Math.floor((f.t || 0) / 8)}`;
    const slot = slots.get(key) || 0;
    slots.set(key, slot + 1);
    const [px, py] = rndCellPx(f.x, f.y);
    const rise = (0.4 + fr * 1.6 + slot * 0.85) * RND.ch * s;
    const a = fr < 0.75 ? 1 : (1 - fr) / 0.25;
    const big = f.big || (f.str && f.str.length <= 4 && /^[0-9!]/.test(f.str));
    const sz = (big ? 13 : 12) * s;
    ctx.font = `bold ${sz.toFixed(1)}px ${FONT_STACK}`;
    let str = String(f.str);
    if (/^[+-]?\d*\.\d{2,}$/.test(str)) str = (str[0] === '+' ? '+' : '') + Math.round(parseFloat(str));
    ctx.globalAlpha = Math.max(0, a);
    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    ctx.fillText(str, px + s, py - rise + s);
    ctx.fillStyle = f.col || '#ffffff';
    ctx.fillText(str, px, py - rise);
    ctx.globalAlpha = 1;
  }
}

// --- HUD -------------------------------------------------------------------------------------
function rndHud(now, g) {
  const p = g.p, sv = g.save || {};
  const HBG = 'rgb(13,9,11)';
  for (let x = 0; x < COLS; x++) { rndBg(x, 0, HBG); rndBg(x, 1, HBG); }
  const mh = Math.max(1, rndMaxHp()), ms = Math.max(1, rndMaxSt());
  // HP bar
  const hw = clamp(Math.round(mh / 7), 18, 34);
  const hp = Math.max(0, p.hp || 0), rally = Math.max(0, p.rally || 0);
  const low = hp / mh < 0.25;
  const pk = low ? 0.75 + 0.25 * Math.sin(now * 0.012) : 1;
  rndText(1, 0, 'HP', '#9c8a78');
  RND.bars.push({ x: 4, y: 0, w: hw, back: [48, 14, 16], segs: [
    [clamp(hp / mh, 0, 1), clamp((hp + rally) / mh, 0, 1), [232, 128, 40], 0.85 + 0.15 * Math.sin(now * 0.01)],
    [0, clamp(hp / mh, 0, 1), [196, 26, 32], pk],
  ] });
  let x = 5 + hw;
  x = rndText(x, 0, `${Math.ceil(hp)}`, low ? '#ff6a5a' : '#e8d6c0');
  x = rndText(x, 0, `/${mh}`, '#7d6c60');
  // stamina
  const sw = clamp(Math.round(ms / 5), 14, 26);
  const stv = Math.max(0, p.st || 0);
  x = Math.max(x + 3, 47);
  rndText(x, 0, 'ST', '#7f907a');
  x += 3;
  const exhausted = stv < 15;
  RND.bars.push({ x, y: 0, w: sw, back: [16, 34, 22], segs: [[0, clamp(stv / ms, 0, 1), exhausted ? [70, 110, 70] : [70, 168, 92], 1]] });
  // row 1: counters on the left, weapon right-aligned; tighten the spacing (then
  // drop the weapon's name) when a late-game hunter's numbers would overflow the row.
  let lv = 0;
  try { lv = typeof level === 'function' ? level() : 0; } catch (e) { lv = 0; }
  const items = [
    [['!', '#e3303e'], [String(sv.vials ?? 0), (sv.vials || 0) ? '#e8d6c0' : '#6a5050']],
    [[':', '#ccd4e0'], [String(sv.bullets ?? 0), (sv.bullets || 0) ? '#e8d6c0' : '#6a5050']],
    [['◊', '#b8b8ff'], [String(sv.shards ?? 0), '#c8c4e8']],
  ];
  if (sv.cords) items.push([['∞', '#d862a8'], [String(sv.cords), '#e0b0cc']]);
  items.push([['Echoes', '#9a8a60'], [String(Math.floor(sv.echoes || 0)), '#f0d898']]);
  items.push([['Insight', '#7c8aa8'], [String(sv.insight || 0), '#b8c8f0']]);
  items.push([['Lv', '#9c8a78'], [String(lv), '#e8d6c0']]);
  const wd = (typeof WEAPONS !== 'undefined' && WEAPONS[sv.weapon]) || null;
  const up = wd && sv.upgrade ? ` +${sv.upgrade}` : '';
  const form = wd && wd.forms[p.form || 0] ? wd.forms[p.form || 0].name : '';
  let wn = wd ? wd.name + up : '', fm = wd ? ` [${form}]` : '';
  const leftW = gap => 1 + items.reduce((n, it) => n + it[0][0].length + 1 + it[1][0].length, 0) + gap * (items.length - 1);
  let gap = 3;
  if (leftW(gap) + 2 + wn.length + fm.length > COLS - 1) gap = 2;
  if (wd && leftW(gap) + 2 + wn.length + fm.length > COLS - 1) wn = up.trim();
  x = 1;
  items.forEach((it, n) => {
    x = rndText(x + (n ? gap : 0), 1, it[0][0], it[0][1]);
    x = rndText(x + 1, 1, it[1][0], it[1][1]);
  });
  if (wd) {
    const total = wn.length + fm.length;
    let wx = Math.max(x + 2, COLS - 1 - total);
    wx = rndText(wx, 1, wn, '#d8c8a8');
    rndText(wx, 1, wn ? fm : fm.trim(), p.form ? '#e0a050' : '#8a7a68');
  }
}

function rndBottom(now, g, m) {
  const BBG = 'rgb(10,7,9)';
  for (let y = VIEW_Y + VIEW_H; y < ROWS; y++) for (let x = 0; x < COLS; x++) rndBg(x, y, BBG);
  const row = VIEW_Y + VIEW_H;
  const b = g.bossBar;
  if (b && !b.dead && b.hp > 0) {
    if (RND.bossRef !== b) { RND.bossRef = b; RND.bossLag = b.hp; }
    if (RND.bossLag < b.hp) RND.bossLag = b.hp;
    RND.bossLag = Math.max(b.hp, RND.bossLag - (b.maxHp || 1) * 0.004);
    const name = b.name || (b.d && b.d.name) || 'Boss';
    let x = rndText(2, row, name, '#e6dcc8');
    x += 2;
    const w = COLS - 2 - x;
    const mxh = b.maxHp || 1;
    RND.bars.push({ x, y: row, w, back: [40, 10, 12], segs: [
      [0, clamp(RND.bossLag / mxh, 0, 1), [214, 180, 96], 1],
      [0, clamp(b.hp / mxh, 0, 1), [168, 18, 24], 1],
    ] });
  } else {
    RND.bossRef = null;
    const nm = m.name || (m.def && m.def.name) || '';
    if (nm) {
      const s = `~ ${nm} ~`;
      rndText(Math.floor((COLS - s.length) / 2), row, s, rndRGB([150, 128, 88], 0.85));
    }
    const hint = rndInteractHint(g, m);
    if (hint) rndText(Math.max(1, COLS - 1 - hint.length), row, hint, rndRGB([200, 170, 100], 0.7 + 0.3 * Math.sin(now * 0.005)));
  }
  // log
  const lg = g.log || [];
  const lines = lg.slice(-5);
  const ks = [1, 0.74, 0.56, 0.43, 0.34];
  for (let j = 0; j < lines.length; j++) {
    const L = lines[lines.length - 1 - j];
    const y = ROWS - 1 - j;
    let txt = String(L.text || '');
    if (txt.length > COLS - 2) txt = txt.slice(0, COLS - 3) + '…';
    rndText(1, y, txt, rndRGB(C(L.col || '#cfc4b4'), ks[j]));
  }
}

function rndInteractHint(g, m) {
  const p = g.p;
  if (!p || g.mode !== 'play') return '';
  const tT = (typeof T !== 'undefined') ? T : null;
  if (!tT) return '';
  for (const d of DIRS) {
    const x = p.x + d[0], y = p.y + d[1];
    if (x < 0 || y < 0 || x >= m.w || y >= m.h) continue;
    const i = y * m.w + x;
    const t = m.tiles[i];
    if (t === tT.LAMP) return '[E] Lamp';
    if (t === tT.FEATURE) {
      const f = m.featAt && m.featAt.get(i);
      if (f && f.name) return `[E] ${f.name}`;
    }
  }
  return '';
}

function rndFrameLines() {
  const ctx = RND.ctx, s = RND.s;
  const W = RND.colX[COLS];
  const lw = Math.max(1, Math.round(s));
  ctx.fillStyle = 'rgba(150,118,60,0.55)';
  ctx.fillRect(0, RND.rowY[VIEW_Y] - lw, W, lw);
  ctx.fillRect(0, RND.rowY[VIEW_Y + VIEW_H], W, lw);
  ctx.fillStyle = 'rgba(90,20,22,0.6)';
  ctx.fillRect(0, RND.rowY[VIEW_Y] - lw * 2, W, lw);
  ctx.fillRect(0, RND.rowY[VIEW_Y + VIEW_H] + lw, W, lw);
}

// Smooth pixel bar (HP / stamina / boss): segments [from, to, rgb, k], later ones on top.
function rndBar(b) {
  const ctx = RND.ctx, s = RND.s;
  const x0 = RND.colX[b.x], x1 = RND.colX[b.x + b.w];
  const ry0 = RND.rowY[b.y], ry1 = RND.rowY[b.y + 1];
  const h = Math.max(4, Math.round((ry1 - ry0) * 0.5));
  const y0 = Math.round((ry0 + ry1) / 2 - h / 2);
  const bw = Math.max(1, Math.round(s));
  ctx.fillStyle = 'rgb(74,58,36)';
  ctx.fillRect(x0 - bw, y0 - bw, x1 - x0 + bw * 2, h + bw * 2);
  ctx.fillStyle = rndRGB(b.back, 1);
  ctx.fillRect(x0, y0, x1 - x0, h);
  const W = x1 - x0;
  for (const [f0, f1, c, k] of b.segs) {
    if (f1 <= f0) continue;
    const a = x0 + Math.round(W * f0), e = x0 + Math.round(W * f1);
    const gr = ctx.createLinearGradient(0, y0, 0, y0 + h);
    gr.addColorStop(0, rndRGB(c, k * 1.25));
    gr.addColorStop(0.45, rndRGB(c, k));
    gr.addColorStop(1, rndRGB(c, k * 0.6));
    ctx.fillStyle = gr;
    ctx.fillRect(a, y0, e - a, h);
  }
}

// --- big serif banners ("YOU DIED") ---------------------------------------------------------------
function rndBanner(now, g) {
  if (!g || !g.banner) return;
  const b = g.banner;
  let dur = +b.dur || 3000;
  if (dur < 300) dur *= TICK_MS;            // tolerate durations given in ticks
  const start = b.start || now;
  const e = now - start;
  if (e > dur) return;
  const fi = Math.min(700, dur * 0.25), fo = Math.min(1200, dur * 0.35);
  let a = e < fi ? e / fi : e > dur - fo ? (dur - e) / fo : 1;
  a = clamp(a, 0, 1);
  const ctx = RND.ctx, s = RND.s;
  const W = RND.colX[COLS];
  const cy = (RND.rowY[VIEW_Y] + RND.rowY[VIEW_Y + VIEW_H]) / 2;
  const size = +b.size || 1;
  const px = (size > 6 ? size : 58 * size) * s;
  const bandH = px * (b.sub ? 2.9 : 2.3);
  ctx.save();
  ctx.globalAlpha = a;
  const gr = ctx.createLinearGradient(0, cy - bandH / 2, 0, cy + bandH / 2);
  gr.addColorStop(0, 'rgba(0,0,0,0)');
  gr.addColorStop(0.25, 'rgba(0,0,0,0.82)');
  gr.addColorStop(0.75, 'rgba(0,0,0,0.82)');
  gr.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = gr;
  ctx.fillRect(0, cy - bandH / 2, W, bandH);
  const zoom = 1 + 0.07 * clamp(e / dur, 0, 1);
  const col = b.col || '#a8141c';
  const ty = cy - (b.sub ? px * 0.22 : 0);
  ctx.translate(W / 2, ty);
  ctx.scale(zoom, zoom);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${px.toFixed(1)}px ${RND_SERIF}`;
  try { ctx.letterSpacing = `${(px * 0.08).toFixed(1)}px`; } catch (err) { /* older browsers */ }
  ctx.shadowColor = col;
  ctx.shadowBlur = 22 * s;
  ctx.fillStyle = col;
  ctx.fillText(String(b.text || ''), 0, 0);
  ctx.shadowBlur = 0;
  ctx.globalAlpha = a * 0.35;
  ctx.fillText(String(b.text || ''), 0, 0);
  ctx.globalAlpha = a;
  if (b.sub) {
    ctx.font = `italic ${(px * 0.3).toFixed(1)}px ${RND_SERIF}`;
    try { ctx.letterSpacing = `${(px * 0.02).toFixed(1)}px`; } catch (err) { /* ignore */ }
    ctx.fillStyle = 'rgba(226,212,186,0.92)';
    ctx.fillText(String(b.sub), 0, px * 0.82);
  }
  try { ctx.letterSpacing = '0px'; } catch (err) { /* ignore */ }
  ctx.restore();
}

// --- title / ending backdrop: night sky, great moon, Yharnam skyline, ash -----------------------------
function rndBuildSkyline() {
  const r = makeRNG(1337);
  const tops = new Array(COLS).fill(ROWS);
  const deco = new Map();       // idx -> {ch, col}
  let x = 0;
  while (x < COLS) {
    const w = r.int(3, 8);
    const kind = r();
    const h = r.int(5, 11);
    for (let k = 0; k < w && x + k < COLS; k++) tops[x + k] = ROWS - h - (k === 0 || k === w - 1 ? 0 : r.int(0, 1));
    if (kind < 0.45) { // spire
      const sx = x + (w >> 1);
      const sh = r.int(4, 10);
      if (sx < COLS) {
        const top = ROWS - h - sh;
        for (let y = top; y < ROWS - h; y++) deco.set(y * COLS + sx, '│');
        deco.set((top - 1) * COLS + sx, kind < 0.15 ? '†' : '▲');
        tops[sx] = Math.min(tops[sx], top);
      }
    } else if (kind < 0.7) { // gabled roof
      for (let k = 0; k < w; k++) if (x + k < COLS) deco.set((tops[x + k] - 1) * COLS + x + k, k < w / 2 ? '▟' : '▙');
    }
    x += w + (r.chance(0.3) ? 1 : 0);
  }
  // cathedral at centre-left
  const cx = 24;
  for (let k = -3; k <= 3; k++) tops[cx + k] = Math.min(tops[cx + k], ROWS - 15 + Math.abs(k));
  for (let y = ROWS - 22; y < ROWS - 15; y++) deco.set(y * COLS + cx, '║');
  deco.set((ROWS - 23) * COLS + cx, '†');
  const windows = [];
  for (let xx = 0; xx < COLS; xx++) {
    for (let y = tops[xx] + 1; y < ROWS - 1; y++) if (r.chance(0.035)) windows.push([xx, y, r()]);
  }
  RND.skyline = { tops, deco, windows };
}

function rndBackdrop(now, dt, g) {
  if (!RND.skyline) rndBuildSkyline();
  const ctx = RND.ctx, s = RND.s, cv = RND.canvas;
  const flags = (g && g.save && g.save.flags) || {};
  const ending = g && g.mode === 'ending' ? flags.ending : null;
  const dawn = ending === 'sunrise';
  const red = ending === 'childhood' || (!!flags.moonRed && ending !== 'honor' && !dawn && g && g.mode === 'ending');
  // sky gradient
  const gr = ctx.createLinearGradient(0, 0, 0, cv.height);
  if (dawn) {
    gr.addColorStop(0, '#120c1e');
    gr.addColorStop(0.45, '#3a2034');
    gr.addColorStop(0.75, '#a0503a');
    gr.addColorStop(1, '#e09a58');
  } else {
    gr.addColorStop(0, '#040309');
    gr.addColorStop(0.55, red ? '#1c0608' : '#0c0a16');
    gr.addColorStop(0.85, red ? '#3a0a0c' : '#24101a');
    gr.addColorStop(1, '#100608');
  }
  ctx.fillStyle = gr;
  ctx.fillRect(0, 0, cv.width, cv.height);
  // moon glow
  const mcx = 60, mcy = dawn ? 13 : 9, mrx = dawn ? 8 : 10;
  const gx = (mcx + 0.5) * RND.cw * s, gy = (mcy + 0.5) * RND.ch * s;
  const rg = ctx.createRadialGradient(gx, gy, mrx * RND.cw * s * 0.6, gx, gy, mrx * RND.cw * s * 2.6);
  rg.addColorStop(0, dawn ? 'rgba(255,200,120,0.45)' : red ? 'rgba(200,40,30,0.32)' : 'rgba(236,220,170,0.22)');
  rg.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = rg;
  ctx.fillRect(0, 0, cv.width, cv.height);
  const mc = dawn ? [255, 222, 160] : red ? [224, 60, 48] : [238, 226, 186];
  // stars
  for (let y = 0; y < 22; y++) for (let x = 0; x < COLS; x++) {
    const h = hash2(x, y, 91);
    if (h < (dawn ? 0.006 : 0.025)) {
      const tw = 0.5 + 0.5 * Math.sin(now * 0.0015 + h * 2000);
      rndPut(x, y, h < 0.004 ? '+' : h < 0.012 ? '·' : '.', rndRGB([200, 205, 235], 0.25 + 0.55 * tw));
    }
  }
  // skyline silhouette
  const sk = RND.skyline;
  const SIL = 'rgb(7,5,9)';
  for (let x = 0; x < COLS; x++) for (let y = sk.tops[x]; y < ROWS; y++) rndBg(x, y, SIL);
  for (const [i, ch] of sk.deco) {
    const x = i % COLS, y = (i / COLS) | 0;
    if (y < 0 || y >= ROWS) continue;
    rndPut(x, y, ch, 'rgb(14,10,16)');
  }
  for (const [x, y, ph] of sk.windows) {
    const f = 0.5 + 0.5 * Math.sin(now * 0.002 + ph * 40) * Math.sin(now * 0.0031 + ph * 13);
    if (ph < 0.6) rndPut(x, y, '▪', rndRGB([236, 160, 70], 0.35 + 0.5 * f));
  }
  // the moon sits behind the skyline: draw sky glyphs, moon, then skyline on top
  rndFlush(0, ROWS, 0, 0);
  ctx.save();
  ctx.beginPath();
  for (let x = 0; x < COLS; x++) ctx.rect(RND.colX[x], 0, RND.colX[x + 1] - RND.colX[x], RND.rowY[sk.tops[x]]);
  ctx.clip();
  rndMoonPx(gx, gy, mrx * RND.cw * s, mc, now, false);
  ctx.restore();
  // ash and embers drifting over everything
  const sec = dt / 1000;
  const W = cv.width, H = cv.height;
  while (RND.ash.length < 90) RND.ash.push({ x: Math.random() * W, y: Math.random() * H, z: 0.3 + Math.random() * 0.7, ph: Math.random() * 7, ember: Math.random() < 0.18 });
  for (const a of RND.ash) {
    if (a.ember) { a.y -= 18 * a.z * sec * s; a.x += Math.sin(now * 0.001 + a.ph) * 12 * sec * s; }
    else { a.y += 16 * a.z * sec * s; a.x += (Math.sin(now * 0.0006 + a.ph) * 14 - 6) * sec * s; }
    if (a.y > H) { a.y = -2; a.x = Math.random() * W; }
    if (a.y < -2) { a.y = H; a.x = Math.random() * W; }
    if (a.x < 0) a.x += W; else if (a.x > W) a.x -= W;
    const al = a.ember ? (0.35 + 0.5 * a.z) * (0.6 + 0.4 * Math.sin(now * 0.01 + a.ph)) : 0.15 + 0.3 * a.z;
    ctx.fillStyle = a.ember ? `rgba(255,140,50,${al.toFixed(3)})` : `rgba(160,150,150,${al.toFixed(3)})`;
    const sz = Math.max(1, 2 * a.z * s);
    ctx.fillRect(a.x, a.y, sz, sz);
  }
  // soft vignette
  const v = ctx.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, Math.hypot(W, H) / 2);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,0.7)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);
}
