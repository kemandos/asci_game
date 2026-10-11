'use strict';
// ---------------------------------------------------------------------------
// Maps: tiles, procedural hunting grounds, the Hunter's Dream, the Flower
// Field, lighting and field of view.
// ---------------------------------------------------------------------------

const T = { WALL: 0, FLOOR: 1, FOG: 2, DECOR: 3, LAMP: 4, GRASS: 5, SKY: 6, FLOWER: 7, FEATURE: 8 };
const T_WALK_E = [0, 1, 0, 0, 0, 1, 0, 1, 0];   // enemy-walkable
const T_OPAQUE = [1, 0, 1, 0, 0, 0, 0, 0, 0];   // blocks sight (FOG is opaque)

function inb(m, x, y) { return x >= 0 && y >= 0 && x < m.w && y < m.h; }
function tileAt(m, x, y) { return inb(m, x, y) ? m.tiles[y * m.w + x] : T.WALL; }
function isOpaque(m, x, y) { return !inb(m, x, y) || T_OPAQUE[m.tiles[y * m.w + x]] === 1; }
function walkE(m, x, y) { return inb(m, x, y) && T_WALK_E[m.tiles[y * m.w + x]] === 1; }
function walkP(m, x, y) {
  if (!inb(m, x, y)) return false;
  const t = m.tiles[y * m.w + x];
  return T_WALK_E[t] === 1 || (t === T.FOG && !m.fogLocked);
}
function setT(m, x, y, t) {
  if (!inb(m, x, y)) return;
  const i = y * m.w + x;
  m.tiles[i] = t;
  if (t !== T.DECOR) m.decor.delete(i);
}

// --- construction helpers ----------------------------------------------------
function mapNew(id, w, h) {
  const n = w * h;
  return {
    id, def: AREAS[id], name: AREAS[id].name, w, h,
    tiles: new Uint8Array(n),            // all WALL (0)
    decor: new Map(), fglyph: new Map(), featAt: new Map(), features: [],
    light: new Float32Array(n), vis: new Float32Array(n), seen: new Uint8Array(n),
    blood: new Uint8Array(n), wallVis: new Uint8Array(n),
    lamps: [], lights: [], spawns: [], items: [],
    arena: null, fog: [], bossId: null, bossSpawn: null, start: { x: 0, y: 0 },
    fogLocked: false, rooms: [],
  };
}

// Fill an inclusive rectangle (clamped so the outer border stays solid).
function mapCarve(m, x0, y0, x1, y1, t) {
  if (t === undefined) t = T.FLOOR;
  const ax = Math.max(1, Math.min(x0, x1)), bx = Math.min(m.w - 2, Math.max(x0, x1));
  const ay = Math.max(1, Math.min(y0, y1)), by = Math.min(m.h - 2, Math.max(y0, y1));
  for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) m.tiles[y * m.w + x] = t;
}

function mapAddFeature(m, kind, x, y, ch, col, name) {
  const f = { kind, x, y, ch, col, name };
  setT(m, x, y, T.FEATURE);
  m.features.push(f);
  m.featAt.set(y * m.w + x, f);
  return f;
}

function computeWallVis(m) {
  const { w, h, tiles } = m;
  m.wallVis.fill(0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (tiles[i] !== T.WALL) continue;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < w && ny < h && tiles[ny * w + nx] !== T.WALL) { m.wallVis[i] = 1; break; }
      }
    }
  }
}

function mapInRect(r, x, y) { return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h; }

// --- public entry point --------------------------------------------------------
function buildMap(id, seed) {
  let m;
  if (id === 'dream') m = buildDream();
  else if (id === 'field') m = buildField();
  else m = genArea(id, seed);
  computeWallVis(m);
  computeLight(m);
  return m;
}

// --- procedural hunting grounds -------------------------------------------------
function genArea(id, seed) {
  const def = AREAS[id];
  const rng = makeRNG(((seed | 0) ^ hashStr(id)) >>> 0);
  const H = 62;
  const MAIN_TOP = 20, MAIN_BOT = 41;     // main plazas live in these rows; side rooms above/below
  const n = def.rooms || 7;

  // 1. lay out the plazas left -> right
  const rooms = [];
  let cx = 3;
  for (let i = 0; i < n; i++) {
    const w = rng.int(12, 18), h = rng.int(8, 13);
    const y = rng.int(MAIN_TOP, MAIN_BOT - h + 1);
    rooms.push({ x: cx, y, w, h, kind: 'main', index: i });
    cx += w + rng.int(5, 10);
  }

  // 2. boss arena geometry (to the right of the last plaza)
  const last = rooms[n - 1];
  const aw = def.arena.w, ah = def.arena.h;
  const cw = rng.int(2, 3);                                   // fog corridor width
  const cy = rng.int(last.y + 1, last.y + last.h - 1 - cw);   // fog corridor top row
  const ax = last.x + last.w + rng.int(7, 10);
  const lo = cy + cw + 2 - ah, hi = cy - 2;
  let ay = clamp(cy + (cw >> 1) - (ah >> 1) + rng.int(-3, 3), lo, hi);
  ay = clamp(ay, 2, H - 3 - ah);
  const W = ax + aw + 2;

  const m = mapNew(id, W, H);
  m.bossId = def.boss || null;

  // 3. carve plazas with irregular bulges
  for (const r of rooms) {
    mapCarve(m, r.x, r.y, r.x + r.w - 1, r.y + r.h - 1);
    const k = rng.int(2, 4);
    for (let b = 0; b < k; b++) {
      const side = rng.int(0, 3);
      if (side < 2) { // top / bottom
        const bw = rng.int(3, Math.min(8, r.w - 2)), bh = rng.int(1, 2);
        const bx = r.x + rng.int(0, r.w - bw);
        const by = side === 0 ? r.y - bh : r.y + r.h;
        mapCarve(m, bx, by, bx + bw - 1, by + bh - 1);
      } else {        // left / right
        const bh = rng.int(3, Math.min(6, r.h - 2)), bw = rng.int(1, 2);
        const by = r.y + rng.int(0, r.h - bh);
        const bx = side === 2 ? r.x - bw : r.x + r.w;
        mapCarve(m, bx, by, bx + bw - 1, by + bh - 1);
      }
    }
  }

  // 4. streets between consecutive plazas (2-3 wide, bent)
  const streets = [];
  for (let i = 0; i < n - 1; i++) {
    const a = rooms[i], b = rooms[i + 1];
    const sw = rng.int(2, 3);
    const ya = rng.int(a.y + 1, a.y + a.h - 1 - sw);
    const yb = rng.int(b.y + 1, b.y + b.h - 1 - sw);
    const ax0 = a.x + (a.w >> 1);
    const cells = [];
    const carveS = (x0, y0, x1, y1) => {
      mapCarve(m, x0, y0, x1, y1);
      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++)
        for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++)
          if (x >= a.x + a.w + 2 && x < b.x - 2) cells.push([x, y]);
    };
    if (rng.chance(0.35)) {
      // L-shape: along row ya into b's columns, then down/up into b
      const xm = b.x + rng.int(2, b.w - 3 - sw);
      carveS(ax0, ya, xm + sw - 1, ya + sw - 1);
      carveS(xm, Math.min(ya, yb), xm + sw - 1, Math.max(ya, yb) + sw - 1);
    } else {
      // two bends: across, along the gap, across
      const gl = a.x + a.w + 1, gr = Math.max(gl, b.x - 1 - sw);
      const xm = rng.int(gl, gr);
      carveS(ax0, ya, xm + sw - 1, ya + sw - 1);
      carveS(xm, Math.min(ya, yb), xm + sw - 1, Math.max(ya, yb) + sw - 1);
      carveS(xm, yb, b.x + (b.w >> 1), yb + sw - 1);
    }
    streets.push(cells);
  }

  // 5. optional side rooms (dead ends with loot) above/below middle plazas
  const sideRooms = [];
  const cand = [];
  for (let i = 1; i < n - 1; i++) cand.push(i);
  for (let i = cand.length - 1; i > 0; i--) { const j = rng.int(0, i); [cand[i], cand[j]] = [cand[j], cand[i]]; }
  const want = rng.int(2, 3);
  const solid = (x0, y0, x1, y1) => {   // is the (inclusive) rectangle still untouched wall?
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (tileAt(m, x, y) !== T.WALL) return false;
    return true;
  };
  for (const i of cand) {
    if (sideRooms.length >= want) break;
    const r = rooms[i];
    const first = rng.int(0, 1);
    for (let t = 0; t < 2; t++) {
      const top = ((first + t) & 1) === 0;
      const sw = rng.int(7, 11), sh = rng.int(5, 7);
      const sx = r.x + rng.int(0, r.w - sw);
      const gap = rng.int(3, 6);
      const sy = top ? r.y - gap - sh : r.y + r.h + gap;
      const s = { x: sx, y: sy, w: sw, h: sh, kind: 'side', parent: i, top };
      if (sy < 2 || sy + sh > H - 2 || !solid(sx - 1, sy - 1, sx + sw, sy + sh)) continue;
      mapCarve(m, sx, sy, sx + sw - 1, sy + sh - 1);
      const kw = rng.int(1, 2);
      const kx = sx + rng.int(1, sw - 1 - kw);
      const ry = r.y + (r.h >> 1);
      if (top) mapCarve(m, kx, sy + sh, kx + kw - 1, ry);
      else mapCarve(m, kx, ry, kx + kw - 1, sy - 1);
      sideRooms.push(s);
      break;
    }
  }
  m.rooms = rooms.concat(sideRooms);

  // 6. corridor to the arena, fog gate, arena
  mapCarve(m, last.x + (last.w >> 1), cy, ax - 2, cy + cw - 1);
  mapCarve(m, ax, ay, ax + aw - 1, ay + ah - 1);
  for (let y = cy; y < cy + cw; y++) { m.tiles[y * W + ax - 1] = T.FOG; m.fog.push([ax - 1, y]); }
  m.arena = { x: ax, y: ay, w: aw, h: ah };
  const inArena = (x, y) => mapInRect(m.arena, x, y);

  // 7. grass patches (random blobs)
  const floorCells = [];
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++)
    if (m.tiles[y * W + x] === T.FLOOR && !inArena(x, y) && x < ax - 3) floorCells.push([x, y]);
  for (let g = 0; g < (def.grassPatches || 0); g++) {
    let [gx, gy] = rng.pick(floorCells);
    const steps = rng.int(10, 26);
    for (let s = 0; s < steps; s++) {
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1]]) {
        const x = gx + dx, y = gy + dy;
        if (inb(m, x, y) && m.tiles[y * W + x] === T.FLOOR && !inArena(x, y) && x < ax - 3) m.tiles[y * W + x] = T.GRASS;
      }
      const d = rng.pick(DIRS);
      gx = clamp(gx + d[0], 1, W - 2); gy = clamp(gy + d[1], 1, H - 2);
    }
  }

  // 8. start lamp in room 0
  const r0 = rooms[0];
  const reserved = new Set();
  const res = (x, y) => reserved.add(y * W + x);
  const isRes = (x, y) => reserved.has(y * W + x);
  const sl = { x: r0.x + 3, y: r0.y + (r0.h >> 1) };
  setT(m, sl.x, sl.y, T.LAMP);
  m.lamps.push({ id: `${id}:start`, name: def.lamps.start, x: sl.x, y: sl.y, active: true });
  m.start = { x: sl.x + 1, y: sl.y };
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    // keep the lamp's surroundings plain floor so it is always reachable
    const i = (sl.y + dy) * W + sl.x + dx;
    if (m.tiles[i] === T.GRASS) m.tiles[i] = T.FLOOR;
    res(sl.x + dx, sl.y + dy);
  }

  // 9. boss lamp (inside the arena, near the left wall, away from the entrance)
  const entryMid = cy + cw / 2;
  const bl = { x: ax + 2, y: entryMid < ay + ah / 2 ? ay + ah - 3 : ay + 2 };
  m.lamps.push({ id: `${id}:boss`, name: def.lamps.boss, x: bl.x, y: bl.y, active: false });

  // 10. window feature (Tomb): a wall next to room-0 floor
  if (def.window) {
    const cands = [];
    for (let y = r0.y - 3; y <= r0.y + r0.h + 2; y++) {
      for (let x = r0.x - 2; x <= r0.x + r0.w + 1; x++) {
        if (x < 1 || y < 1 || x > W - 2 || y > H - 2 || m.tiles[y * W + x] !== T.WALL) continue;
        let ok = false;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy;
          if (walkE(m, nx, ny) && nx >= r0.x - 2 && nx < r0.x + r0.w + 2 && !(nx === m.start.x && ny === m.start.y)) ok = true;
        }
        if (ok && cheb(x, y, sl.x, sl.y) > 2) cands.push([x, y]);
      }
    }
    if (cands.length) {
      const [wx, wy] = rng.pick(cands);
      mapAddFeature(m, 'window', wx, wy, '□', '#f0d070', 'A lit window');
      m.lights.push({ x: wx, y: wy, r: 3, k: 0.6 });
    }
  }

  // 11. decor inside plazas and side rooms
  let area = 0;
  for (const r of m.rooms) area += r.w * r.h;
  const nDecor = Math.round(area * (def.decorDensity || 0));
  const decorList = (def.decor || []).map(d => [d, d.w || 1]);
  let placed = 0;
  for (let tries = 0; placed < nDecor && tries < nDecor * 30 && decorList.length; tries++) {
    const r = rng.pick(m.rooms);
    const x = r.x + rng.int(0, r.w - 1), y = r.y + rng.int(0, r.h - 1);
    const i = y * W + x;
    if (!walkE(m, x, y) || isRes(x, y) || m.fglyph.has(i) || cheb(x, y, m.start.x, m.start.y) <= 2) continue;
    const d = rng.weighted(decorList);
    if (d.block) {
      let ok = true;
      for (const [dx, dy] of DIRS) if (!walkE(m, x + dx, y + dy)) { ok = false; break; }
      if (!ok) continue;
      m.tiles[i] = T.DECOR;
      m.decor.set(i, { ch: d.ch, col: d.col, flicker: !!d.flicker });
    } else {
      m.fglyph.set(i, { ch: d.ch, col: d.col, flicker: !!d.flicker });
    }
    if (d.light) m.lights.push({ x, y, r: d.light, k: d.k || 0.7 });
    placed++;
  }

  // 12. arena dressing: floor colour, edge deco, corner lights
  const ad = def.arena.deco;
  let decoLights = 0;
  for (let y = ay; y < ay + ah; y++) {
    for (let x = ax; x < ax + aw; x++) {
      const i = y * W + x;
      const edge = Math.min(x - ax, ax + aw - 1 - x, y - ay, ay + ah - 1 - y);
      if (ad && edge === 0 && !(x === ax && y >= cy - 1 && y <= cy + cw) && rng.chance(0.22)) {
        m.fglyph.set(i, { ch: ad.ch, col: ad.col, flicker: !!ad.light });
        if (ad.light && decoLights < 10 && rng.chance(0.5)) { m.lights.push({ x, y, r: 3, k: 0.55 }); decoLights++; }
      } else {
        m.fglyph.set(i, { ch: '.', col: def.arena.floor });
      }
    }
  }
  for (const [lx, ly] of [[ax + 1, ay + 1], [ax + aw - 2, ay + 1], [ax + 1, ay + ah - 2], [ax + aw - 2, ay + ah - 2]])
    m.lights.push({ x: lx, y: ly, r: 7, k: 0.75 });
  m.lights.push({ x: ax + (aw >> 1), y: ay + (ah >> 1), r: 6, k: 0.45 });
  m.lights.push({ x: ax - 3, y: cy, r: 4, k: 0.55 });   // light the fog gate

  const bsize = (BOSSES[def.boss] && BOSSES[def.boss].size) || 1;
  m.bossSpawn = { x: ax + (aw >> 1) - (bsize >> 1), y: ay + (ah >> 1) - (bsize >> 1) };

  // --- tile pickers for spawns & items
  const freeTile = (r, extra) => {
    const ok = (x, y) => walkE(m, x, y) && !isRes(x, y) && !inArena(x, y) && (!extra || extra(x, y));
    for (let t = 0; t < 80; t++) {
      const x = r.x + rng.int(0, r.w - 1), y = r.y + rng.int(0, r.h - 1);
      if (ok(x, y)) return [x, y];
    }
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (ok(x, y)) return [x, y];
    return null;
  };
  const farFromStart = (x, y) => cheb(x, y, m.start.x, m.start.y) > 6;
  const tableFor = (idx) => def.spawnTable.filter(e => (e[2] || 0) <= idx).map(e => [e[0], e[1]]);

  // 13. spawns
  const addSpawn = (type, p) => { if (!p) return; m.spawns.push({ type, x: p[0], y: p[1] }); res(p[0], p[1]); };
  for (let i = 1; i < n; i++) {
    const cnt = def.spawn.base + Math.floor(i * def.spawn.growth) + rng.int(0, 1);
    const tbl = tableFor(i);
    for (let k = 0; k < cnt; k++) addSpawn(rng.weighted(tbl), freeTile(rooms[i], farFromStart));
  }
  for (const s of sideRooms) {
    const tbl = tableFor(s.parent);
    const cnt = rng.int(1, 2);
    for (let k = 0; k < cnt; k++) addSpawn(rng.weighted(tbl), freeTile(s, farFromStart));
  }
  streets.forEach((cells, si) => {
    if (!cells.length || !rng.chance(0.35)) return;
    for (let t = 0; t < 10; t++) {
      const [x, y] = rng.pick(cells);
      if (walkE(m, x, y) && !isRes(x, y) && farFromStart(x, y)) { addSpawn(rng.weighted(tableFor(si + 1)), [x, y]); break; }
    }
  });

  // 14. items
  let keyN = 0;
  const addItem = (kind, p, text) => {
    if (!p) return;
    const it = { kind, x: p[0], y: p[1], key: `${id}:${keyN++}` };
    if (text !== undefined) it.text = text;
    m.items.push(it);
    res(p[0], p[1]);
  };
  const notStart = (x, y) => cheb(x, y, m.start.x, m.start.y) >= 2;
  const notes = def.notes || [];
  notes.forEach((text, j) => {
    const ri = j === 0 ? 0 : clamp(Math.round(j * (n - 1) / Math.max(1, notes.length - 1)), 1, n - 1);
    addItem('note', freeTile(rooms[ri], notStart), text);
  });
  const anyRoom = () => (sideRooms.length && rng.chance(0.25)) ? rng.pick(sideRooms) : rooms[rng.int(1, n - 1)];
  const sideOr = (p) => (sideRooms.length && rng.chance(p)) ? rng.pick(sideRooms) : rooms[rng.int(1, n - 1)];
  const cnt = def.items || {};
  for (const kind of ['vial', 'bullets', 'coldblood', 'shard', 'cord']) {
    for (let k = 0; k < (cnt[kind] || 0); k++) {
      const r = kind === 'cord' ? (sideRooms.length ? rng.pick(sideRooms) : rooms[n - 1])
        : kind === 'shard' ? sideOr(0.7) : anyRoom();
      addItem(kind, freeTile(r, notStart));
    }
  }

  return mapCropRows(m);
}

// Drop the empty wall rows above and below the generated layout (keeps 1 wall row).
function mapCropRows(m) {
  const W = m.w;
  let y0 = m.h, y1 = -1;
  for (let y = 0; y < m.h; y++) for (let x = 0; x < W; x++) if (m.tiles[y * W + x] !== T.WALL) { if (y < y0) y0 = y; y1 = y; break; }
  const dy = y0 - 1, H = y1 - y0 + 3;
  if (dy <= 0 && H >= m.h) return m;
  const n = W * H, off = dy * W;
  m.tiles = m.tiles.slice(off, off + n);
  const shiftMap = mp => new Map([...mp].map(([i, v]) => [i - off, v]));
  m.decor = shiftMap(m.decor); m.fglyph = shiftMap(m.fglyph); m.featAt = shiftMap(m.featAt);
  for (const o of [...m.features, ...m.lamps, ...m.lights, ...m.spawns, ...m.items, ...m.rooms, m.start, m.bossSpawn, m.arena]) if (o) o.y -= dy;
  for (const f of m.fog) f[1] -= dy;
  m.h = H;
  m.light = new Float32Array(n); m.vis = new Float32Array(n); m.seen = new Uint8Array(n);
  m.blood = new Uint8Array(n); m.wallVis = new Uint8Array(n);
  return m;
}

// --- the Hunter's Dream -----------------------------------------------------------
function buildDream() {
  const W = 50, H = 17;
  const m = mapNew('dream', W, H);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) m.tiles[y * W + x] = T.FLOWER;
  const deco = (x, y, ch, col) => { setT(m, x, y, T.DECOR); m.decor.set(y * W + x, { ch, col }); };
  const stamp = (ox, oy, rows, fn) => rows.forEach((row, dy) => {
    for (let dx = 0; dx < row.length; dx++) if (row[dx] !== ' ') fn(row[dx], ox + dx, oy + dy);
  });

  stamp(14, 2, ['#############', '#bb..w....bb#', '#.....G.....#', '#...........#', '######+######'], (c, x, y) => {
    if (c === '#') setT(m, x, y, T.WALL);
    else if (c === 'b') deco(x, y, '≡', '#6b4a30');
    else if (c === 'w') mapAddFeature(m, 'workbench', x, y, 'π', '#a07850', 'Workbench');
    else if (c === 'G') mapAddFeature(m, 'gehrman', x, y, 'G', '#9aa0b8', 'Gehrman, the First Hunter');
    else setT(m, x, y, T.FLOOR); // '.' and '+' door
  });
  stamp(18, 7, [' ,., ', ',...,', ',.L.,', ',...,', ',.D.,', ',...,', ' ,., ', '  @  '], (c, x, y) => {
    if (c === ',') setT(m, x, y, T.GRASS);
    else if (c === '.') setT(m, x, y, T.FLOOR);
    else if (c === 'L') { setT(m, x, y, T.LAMP); m.lamps.push({ id: 'dream', name: "Hunter's Dream", x, y, active: true }); }
    else if (c === 'D') mapAddFeature(m, 'doll', x, y, 'D', '#ecdfca', 'The Doll');
    else if (c === '@') m.start = { x, y };
  });
  stamp(7, 9, ['~~~', '~~~m', '~~~'], (c, x, y) => {
    if (c === '~') deco(x, y, '≈', '#4a6a9a');
    else if (c === 'm') mapAddFeature(m, 'messenger', x, y, 'm', '#d8d8c8', 'Bath Messengers');
  });
  stamp(36, 8, ['h  h  h', '', 'h  h  h'], (c, x, y) => {
    if (c === 'h') mapAddFeature(m, 'headstone', x, y, 'Π', '#8f8f98', 'Headstone');
  });
  for (const [x, y] of [[3, 1], [46, 1], [3, 15], [46, 15]]) deco(x, y, '♣', '#3e5a34');
  for (const [x, y] of [[6, 4], [38, 4], [40, 12]]) {
    deco(x, y, 'i', '#e2b04c');
    m.lights.push({ x, y, r: 4, k: 0.7 });
  }
  m.rooms = [{ x: 1, y: 1, w: W - 2, h: H - 2, kind: 'main', index: 0 }];
  m.seen.fill(1);   // the Dream is home: the whole garden is always remembered
  return m;
}

// --- the Flower Field (Gehrman) ---------------------------------------------------
function buildField() {
  const W = 64, H = 34;
  const m = mapNew('field', W, H);
  const ex = 32, ey = 22, rx = 28, ry = 10;
  const inside = (x, y) => ((x - ex) / rx) ** 2 + ((y - ey) / ry) ** 2 <= 1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = (inside(x, y) && x > 0 && y > 0 && x < W - 1 && y < H - 1) ? T.FLOWER : (y < ey ? T.SKY : T.WALL);
      m.tiles[y * W + x] = t;
    }
  }
  m.moon = { cx: 32, cy: 5, rx: 9, ry: 4.5 };
  let sx = 32, sy = 30;
  while (!walkE(m, sx, sy) && sy > ey) sy--;
  m.start = { x: sx, y: sy };
  m.arena = { x: 0, y: 0, w: 64, h: 26 };
  m.bossId = 'gehrman';
  m.bossSpawn = { x: 32, y: 16 };
  m.rooms = [{ x: ex - rx, y: ey - ry, w: rx * 2 + 1, h: ry * 2 + 1, kind: 'main', index: 0 }];
  return m;
}

// --- lighting ------------------------------------------------------------------------
function computeLight(m) {
  const L = m.light;
  L.fill(0);
  const srcs = m.lights.slice();
  for (const l of m.lamps) if (l.active) srcs.push({ x: l.x, y: l.y, r: 6, k: 0.9 });
  for (const s of srcs) {
    const r = s.r, k = s.k, ri = Math.ceil(r);
    for (let dy = -ri; dy <= ri; dy++) {
      const y = s.y + dy;
      if (y < 0 || y >= m.h) continue;
      for (let dx = -ri; dx <= ri; dx++) {
        const x = s.x + dx;
        if (x < 0 || x >= m.w) continue;
        const d = Math.hypot(dx, dy);
        if (d > r) continue;
        const v = k * (1 - d / (r + 1));
        const i = y * m.w + x;
        if (v > L[i]) L[i] = v;
      }
    }
  }
}

// --- field of view (raycasting) ----------------------------------------------------
// The player always stands on an integer cell and rays start at its centre, so the
// sequence of cells each ray crosses is fixed: precompute it once as offsets.
const FOV_RADIUS = 26, FOV_RAYS = 900;
const FOV_AMB_R2 = 18 * 18;   // ambient light only reaches this far; lamps/pyres are seen to FOV_RADIUS
const FOV_PATHS = (() => {
  const paths = [];
  for (let a = 0; a < FOV_RAYS; a++) {
    const ang = a / FOV_RAYS * Math.PI * 2, c = Math.cos(ang), s = Math.sin(ang);
    const offs = [];
    let lx = 0, ly = 0;
    for (let t = 0.5; t <= FOV_RADIUS; t += 0.5) {
      const dx = Math.floor(0.5 + c * t), dy = Math.floor(0.5 + s * t);
      if (dx === lx && dy === ly) continue;
      lx = dx; ly = dy;
      offs.push(dx, dy);
    }
    paths.push(Int8Array.from(offs));
  }
  return paths;
})();

function computeFOV(m, px, py) {
  const { w, h, tiles, vis, seen, light } = m;
  vis.fill(0);
  const def = m.def || {};
  // sight radius ~11 tiles across (~8 rows up/down: cells are tall) for light 7.5;
  // brightness falls from ~1 at the hunter to 0.16 at the rim, so the edge stays readable.
  const amb = def.ambient || 0, sr = (def.light || 7) * 1.5, ambFar = amb >= 0.5;  // hubs: daylight-bright
  const visList = [];
  const mark = (x, y) => {
    const i = y * w + x;
    if (vis[i] > 0) return;
    const dx = x - px, dy = (y - py) * 1.4, dl = Math.sqrt(dx * dx + dy * dy);
    const f = 1 - dl / sr;
    const b = Math.max(ambFar || dx * dx + (y - py) * (y - py) <= FOV_AMB_R2 ? amb : 0, f > 0 ? 0.16 + 0.9 * f : 0, light[i]);
    if (b >= 0.12) { vis[i] = Math.min(1.2, b); seen[i] = 1; visList.push(i); }
  };
  if (inb(m, px, py)) mark(px, py);
  for (let a = 0; a < FOV_RAYS; a++) {
    const p = FOV_PATHS[a];
    for (let k = 0; k < p.length; k += 2) {
      const x = px + p[k], y = py + p[k + 1];
      if (x < 0 || y < 0 || x >= w || y >= h) break;
      mark(x, y);
      if (T_OPAQUE[tiles[y * w + x]]) break;
    }
  }
  // reveal opaque tiles bordering visible open tiles (closes gaps in wall outlines)
  const n = visList.length;
  for (let q = 0; q < n; q++) {
    const i = visList[q];
    if (T_OPAQUE[tiles[i]]) continue;
    const x = i % w, y = (i / w) | 0;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (T_OPAQUE[tiles[ny * w + nx]]) mark(nx, ny);
    }
  }
}
