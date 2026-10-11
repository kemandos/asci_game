'use strict';
// ---------------------------------------------------------------------------
// Game state & logic: the hunter, beasts, bosses, lamps, the Hunter's Dream,
// menus (built through the UI API), saving, death and endings.
// ---------------------------------------------------------------------------

const MAX_VIALS = 20, MAX_BULLETS = 20, VIAL_STOCK = 10, SAVE_KEY = 'bloodborne-ascii-save-v1';

const G = {
  mode: 'title', tick: 0, map: null, p: null, enemies: [], drops: [], fx: [], log: [],
  timers: [], save: null, mapCache: {}, keys: new Set(), shake: 0, flash: 0, banner: null,
  bossBar: null, cam: { x: 0, y: 0 }, deadT: 0,
  // internal
  flow: null, flowKey: -1, flowMap: null, flowQ: null, uid: 1,
};

const STAT_DEFS = [
  { k: 'vit', name: 'Vitality', desc: 'Health' },
  { k: 'end', name: 'Endurance', desc: 'Stamina' },
  { k: 'str', name: 'Strength', desc: 'Weapon scaling' },
  { k: 'skl', name: 'Skill', desc: 'Weapon scaling & visceral attacks' },
  { k: 'blt', name: 'Bloodtinge', desc: 'Firearm damage' },
];
const MOVE_KEYS = {
  KeyW: [0, -1], ArrowUp: [0, -1], Numpad8: [0, -1],
  KeyS: [0, 1], ArrowDown: [0, 1], Numpad2: [0, 1],
  KeyA: [-1, 0], ArrowLeft: [-1, 0], Numpad4: [-1, 0],
  KeyD: [1, 0], ArrowRight: [1, 0], Numpad6: [1, 0],
  Numpad7: [-1, -1], Home: [-1, -1], Numpad9: [1, -1], PageUp: [1, -1],
  Numpad1: [-1, 1], End: [-1, 1], Numpad3: [1, 1], PageDown: [1, 1],
};
const MOVE_CD = 3;           // ticks per step
const RALLY_WINDOW = 36;     // ticks before the rally portion starts draining
const ST_DELAY = 14;         // ticks before stamina regenerates after an action
const DODGE_COST = 18;
const MUSIC_CD = 400;
const BLOOD_MOON_TINT = [1.12, 0.78, 0.74];

// ---------------------------------------------------------------------------
// small safe wrappers
// ---------------------------------------------------------------------------
function sfx(name) {
  try { if (typeof Sound !== 'undefined' && Sound && Sound.play) Sound.play(name); } catch (e) { /* silent */ }
}
function nowMs() {
  try { return performance.now(); } catch (e) { return Date.now(); }
}
function uiOpen(spec) {
  if (typeof UI !== 'undefined' && UI) UI.open(spec);
}
function uiClose() {
  try { if (typeof UI !== 'undefined' && UI && UI.isOpen()) UI.close(); } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// derived stats
// ---------------------------------------------------------------------------
function curStats() { return (G.save && G.save.stats) || { vit: 10, end: 10, str: 10, skl: 10, blt: 10 }; }
function level() { const s = curStats(); return s.vit + s.end + s.str + s.skl + s.blt - 40; }
function maxHp() { return 60 + curStats().vit * 8; }
function maxSt() { return 60 + curStats().end * 4; }
function levelCost(lv) {
  if (lv === undefined) lv = level();
  return Math.round(100 + 28 * Math.pow(Math.max(1, lv - 9), 1.35));
}
function weaponMult(stats, upgrade) {
  const s = G.save || {};
  const st = stats || curStats();
  const w = WEAPONS[s.weapon] || WEAPONS.saw;
  const up = upgrade !== undefined ? upgrade : (s.upgrade || 0);
  return (1 + (st.str - 10) * w.scale.str + (st.skl - 10) * w.scale.skl) * (1 + 0.1 * up);
}
function gunDmg(stats) { return GUN.dmg * (1 + ((stats || curStats()).blt - 10) * 0.09); }
function visceralMult(stats) { return 5 + ((stats || curStats()).skl - 10) * 0.2; }
function ngMult() { return 1 + 0.6 * ((G.save && G.save.ng) || 0); }
function areaMult() {
  const d = G.map && AREAS[G.map.id];
  return (d && d.mult) || { hp: 1, dmg: 1, echo: 1 };
}
function curWeapon() { return WEAPONS[(G.save && G.save.weapon) || 'saw'] || WEAPONS.saw; }

// ---------------------------------------------------------------------------
// log / banner / fx helpers
// ---------------------------------------------------------------------------
function log(text, col) {
  const lines = wrap(String(text), COLS - 3);
  for (const t of lines) if (t) G.log.push({ text: t, col: col || '#c8bfae', t: G.tick });
  if (G.log.length > 80) G.log.splice(0, G.log.length - 80);
}
function banner(text, col, dur, size, sub) {
  G.banner = { text: String(text), col: col || '#d8b45a', dur: dur || 2600, size: size || 1, sub: sub || '', start: nowMs() };
}
function fxGlyph(x, y, ch, col, life) { G.fx.push({ k: 'g', x, y, ch, col, life: life || 4, t: 0 }); }
function fxText(x, y, str, col, life, big) { G.fx.push({ k: 't', x, y, str: String(str), col: col || '#ffffff', life: life || 22, t: 0, big: !!big }); }
function fxPart(x, y, vx, vy, col, life, size) { G.fx.push({ k: 'p', x, y, vx, vy, col, life: life || 12, t: 0, size: size || 2.6 }); }
function bleed(x, y, n, col) {
  for (let i = 0; i < n; i++) {
    const a = R() * Math.PI * 2, sp = R.range(0.08, 0.42);
    fxPart(x + 0.5, y + 0.5, Math.cos(a) * sp, Math.sin(a) * sp - 0.05, col || (R.chance(0.5) ? '#b0101a' : '#7a0810'), R.int(8, 18), R.range(1.8, 3.6));
  }
  const m = G.map;
  if (!m || !m.blood) return;
  const spots = Math.min(5, 1 + (n >> 3));
  for (let k = 0; k < spots; k++) {
    const bx = x + (k ? R.int(-1, 1) : 0), by = y + (k ? R.int(-1, 1) : 0);
    if (!inb(m, bx, by) || isOpaque(m, bx, by)) continue;
    const i = by * m.w + bx;
    m.blood[i] = Math.min(6, m.blood[i] + 1);
  }
}
function tickFx() {
  for (const f of G.fx) {
    f.t++;
    if (f.k === 'p') { f.x += f.vx; f.y += f.vy; f.vx *= 0.86; f.vy = f.vy * 0.86 + 0.012; }
  }
  if (G.fx.length) G.fx = G.fx.filter(f => f.t < f.life);
  if (G.fx.length > 600) G.fx.splice(0, G.fx.length - 600);
  G.shake = G.shake > 0.25 ? G.shake * 0.8 : 0;
  G.flash = Math.max(0, G.flash - 0.06);
  const p = G.p;
  if (p && p.ghost) { p.ghost.t--; if (p.ghost.t <= 0) p.ghost = null; }
}
function schedule(ticks, fn) { G.timers.push({ at: G.tick + ticks, fn }); }

// ---------------------------------------------------------------------------
// saving
// ---------------------------------------------------------------------------
function defaultSave(weapon) {
  return {
    v: 1, seed: R.int(1, 2000000000), ng: 0, weapon: WEAPONS[weapon] ? weapon : 'saw', upgrade: 0,
    stats: { vit: 10, end: 10, str: 10, skl: 10, blt: 10 },
    echoes: 0, insight: 0, vials: 5, bullets: 12, shards: 0,
    litLamps: ['central:start'], lastLamp: { area: 'central', id: 'central:start' },
    bosses: {}, taken: {}, flags: { musicBox: false }, cords: 0, stain: null, deaths: 0, playTicks: 0,
  };
}
function normalizeSave(s) {
  if (!s || typeof s !== 'object') return null;
  const d = defaultSave(s.weapon);
  for (const k in d) if (s[k] === undefined || s[k] === null && d[k] !== null) s[k] = d[k];
  if (!WEAPONS[s.weapon]) s.weapon = 'saw';
  if (!s.stats || typeof s.stats !== 'object') s.stats = d.stats;
  for (const k in d.stats) if (!(s.stats[k] >= 1)) s.stats[k] = 10;
  for (const k of ['echoes', 'insight', 'vials', 'bullets', 'shards', 'cords', 'deaths', 'playTicks', 'upgrade', 'ng']) {
    if (typeof s[k] !== 'number' || !isFinite(s[k])) s[k] = d[k];
  }
  if (!Array.isArray(s.litLamps)) s.litLamps = d.litLamps;
  if (typeof s.flags !== 'object') s.flags = d.flags;
  if (typeof s.bosses !== 'object') s.bosses = {};
  if (typeof s.taken !== 'object') s.taken = {};
  if (s.lastLamp && (!s.lastLamp.area || !s.lastLamp.id)) s.lastLamp = d.lastLamp;
  return s;
}
function saveGame() {
  if (!G.save) return false;
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(G.save)); return true; } catch (e) { return false; }
}
function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || s.v !== 1) return null;
    return normalizeSave(s);
  } catch (e) { return null; }
}
function hasSave() { return !!loadSave(); }

// ---------------------------------------------------------------------------
// starting / continuing / NG+ / title
// ---------------------------------------------------------------------------
function makePlayer(x, y) {
  return {
    x: x || 0, y: y || 0, facing: 0, hp: maxHp(), rally: 0, rallyT: 0, st: maxSt(), stDelay: 0,
    act: 0, moveCd: 0, iframes: 0, form: 0, buffer: null, bufferT: 0, flashT: 0, dead: false,
    ghost: null, musicCd: 0, exhaustT: 0, noteKey: null,
  };
}
function resetRuntime() {
  G.enemies = []; G.drops = []; G.fx = []; G.timers = [];
  G.bossBar = null; G.shake = 0; G.flash = 0; G.deadT = 0;
  G.flow = null; G.flowKey = -1; G.flowMap = null;
}
function beginRun(fresh) {
  G.mapCache = {}; G.log = []; G.tick = 0; G.banner = null;
  resetRuntime();
  G.p = makePlayer(0, 0);
  TINT = [1, 1, 1];
  if (G.keys && G.keys.clear) G.keys.clear();
  const s = G.save;
  const ll = s.lastLamp;
  if (!fresh && ll && ll.area && (AREAS[ll.area] || ll.area === 'dream')) {
    loadArea(ll.area, ll.id);
  } else loadArea('central', null);
  G.mode = 'play';
}

function newGame(weaponId) {
  uiClose();
  G.save = defaultSave(weaponId);
  beginRun(true);
  banner('Central Yharnam', '#d8cfb8', 3200, 0.75, 'The night of the hunt');
  log('You wake in Iosefka\'s clinic. Yharnam burns.', '#d8c8a8');
  log('WASD move · J/K attack · L gun · Space dodge · Q transform · R vial · H help', '#9a9488');
  saveGame();
}

function continueGame() {
  const s = loadSave();
  if (!s) { if (typeof openTitle === 'function') openTitle(); return false; }
  uiClose();
  G.save = s;
  if (s.flags.ending && ENDINGS[s.flags.ending]) {
    G.mapCache = {}; G.log = []; resetRuntime();
    G.p = makePlayer(0, 0);
    G.map = null;
    G.mode = 'ending';
    openEndingMenu(s.flags.ending);
    return true;
  }
  beginRun(false);
  const m = G.map;
  banner(m.name, '#d8cfb8', 2600, 0.7, 'The hunt continues');
  log('You awaken beside the lamp.', '#c8b88a');
  return true;
}

function startNGPlus() {
  uiClose();
  const o = G.save || defaultSave('saw');
  const s = defaultSave(o.weapon);
  s.ng = (o.ng || 0) + 1;
  s.stats = Object.assign({}, o.stats);
  s.upgrade = o.upgrade || 0;
  s.echoes = o.echoes || 0;
  s.insight = o.insight || 0;
  s.deaths = o.deaths || 0;
  s.playTicks = o.playTicks || 0;
  s.flags.endings = Object.assign({}, (o.flags && o.flags.endings) || {});
  G.save = s;
  beginRun(true);
  banner('NEW GAME+' + (s.ng > 1 ? s.ng : ''), '#c83a3a', 3400, 0.9, 'The nightmare begins again... and it is stronger');
  log('The hunt begins anew. The beasts have grown stronger.', '#d07060');
  saveGame();
}

function toTitle() {
  if (G.save && (G.mode === 'play' || G.mode === 'menu')) saveGame();
  uiClose();
  G.mode = 'title';
  G.map = null; G.p = null;
  resetRuntime();
  G.banner = null;
  TINT = [1, 1, 1];
  if (G.keys && G.keys.clear) G.keys.clear();
  if (typeof openTitle === 'function' && !(typeof UI !== 'undefined' && UI.isOpen())) openTitle();
}

// ---------------------------------------------------------------------------
// areas
// ---------------------------------------------------------------------------
function mapSeedFor(id) { return ((G.save.seed + G.save.ng * 7919 + hashStr(id)) >>> 0) || 1; }
function getMap(id) {
  let m = G.mapCache[id];
  if (!m) { m = buildMap(id, mapSeedFor(id)); G.mapCache[id] = m; }
  return m;
}
function isHuntingArea(id) { return AREA_ORDER.indexOf(id) >= 0; }

// Bring the map in line with the save: lamps, fog walls.
function syncMap(m) {
  const s = G.save;
  for (const l of m.lamps) {
    let on = true;
    if (l.id.endsWith(':boss')) on = !!(m.bossId && s.bosses[m.bossId]) || s.litLamps.indexOf(l.id) >= 0;
    l.active = on;
    const t = m.tiles[l.y * m.w + l.x];
    if (on && t !== T.LAMP) setT(m, l.x, l.y, T.LAMP);
    else if (!on && t === T.LAMP) setT(m, l.x, l.y, T.FLOOR);
  }
  if (m.bossId && s.bosses[m.bossId] && m.fog) {
    for (const [x, y] of m.fog) if (m.tiles[y * m.w + x] === T.FOG) setT(m, x, y, T.FLOOR);
  }
  m.fogLocked = false;
}

function applyTint(m) {
  const s = G.save;
  if (s && s.flags.moonRed && isHuntingArea(m.id)) TINT = BLOOD_MOON_TINT.slice();
  else TINT = [1, 1, 1];
}

function loadArea(id, lampId, pos) {
  const m = getMap(id);
  G.map = m;
  resetRuntime();
  syncMap(m);
  const s = G.save;
  if (isHuntingArea(id) && s.litLamps.indexOf(id + ':start') < 0) s.litLamps.push(id + ':start');
  const p = G.p;
  let sp = null;
  if (pos && playerCanStand(pos.x, pos.y)) sp = [pos.x, pos.y];
  if (!sp && lampId) {
    const l = m.lamps.find(q => q.id === lampId);
    if (l) sp = findFreeNear(l.x, l.y, 4, playerCanStand);
  }
  if (!sp) sp = playerCanStand(m.start.x, m.start.y) ? [m.start.x, m.start.y] : findFreeNear(m.start.x, m.start.y, 8, playerCanStand);
  if (!sp) sp = [m.start.x, m.start.y];
  p.x = sp[0]; p.y = sp[1];
  p.act = 0; p.moveCd = 0; p.buffer = null; p.iframes = 10; p.ghost = null; p.noteKey = null;
  spawnEntities(m);
  applyTint(m);
  computeLight(m);
  computeFOV(m, p.x, p.y);
  pickupAt(p.x, p.y);
}

function spawnEntities(m) {
  const s = G.save, p = G.p;
  for (const sp of m.spawns || []) {
    if (!ENEMIES[sp.type]) continue;
    if (!walkE(m, sp.x, sp.y) || cheb(sp.x, sp.y, p.x, p.y) < 4 || occupantAt(sp.x, sp.y)) continue;
    G.enemies.push(makeEnemy(sp.type, sp.x, sp.y));
  }
  if (m.id === 'field') {
    if (!s.bosses.gehrman) spawnBoss('gehrman', m.bossSpawn.x, m.bossSpawn.y);
    else if (s.cords >= 3 && !s.bosses.moon) spawnBoss('moon', m.bossSpawn.x - 1, m.bossSpawn.y - 2);
  } else if (m.bossId && BOSSES[m.bossId] && !s.bosses[m.bossId] && m.bossSpawn) {
    spawnBoss(m.bossId, m.bossSpawn.x, m.bossSpawn.y);
  }
}

// ---------------------------------------------------------------------------
// entities
// ---------------------------------------------------------------------------
function makeEnemy(type, x, y) {
  const d = ENEMIES[type], am = areaMult();
  const hp = Math.max(1, Math.round(d.hp * am.hp * ngMult()));
  return {
    uid: G.uid++, type, id: type, d, boss: false, x, y, size: 1, ch: d.ch, col: d.col, art: null,
    hp, maxHp: hp, state: 'idle', timer: 0, atk: null, atkBase: null, tiles: null, path: null, flashT: 0,
    dead: false, aware: false, phase: 1, name: d.name, speed: d.speed, moveT: R.int(0, d.speed),
    cds: {}, comboLeft: 0, readyAt: 0, facing: R.int(0, 7), lost: 0, parried: false, healDmg: 0, healUses: 0,
  };
}
function makeBoss(id, x, y) {
  const d = BOSSES[id];
  const hp = Math.round(d.hp * ngMult());
  return {
    uid: G.uid++, type: id, id, d, boss: true, x, y, size: d.size || 1,
    ch: d.ch || (d.art ? d.art[1][1] : 'B'), col: d.col, art: d.art || null,
    hp, maxHp: hp, state: 'dormant', timer: 0, atk: null, atkBase: null, tiles: null, path: null, flashT: 0,
    dead: false, aware: false, phase: 1, name: d.name, speed: d.speed, moveT: 0,
    cds: {}, comboLeft: 0, readyAt: 0, facing: 4, lost: 0, parried: false, healDmg: 0, healUses: 0,
  };
}
function spawnBoss(id, x, y) {
  const e = makeBoss(id, x, y);
  if (!canOccupy(e, x, y, e.size)) {
    const spot = findBodySpot(e, x, y, 8, e.size, true);
    if (spot) { e.x = spot[0]; e.y = spot[1]; }
  }
  G.enemies.push(e);
  return e;
}

function occupantAt(x, y, except) {
  for (const e of G.enemies) {
    if (e.dead || e === except) continue;
    if (x >= e.x && x < e.x + e.size && y >= e.y && y < e.y + e.size) return e;
  }
  return null;
}
function footDist(e, x, y) {
  const dx = Math.max(0, e.x - x, x - (e.x + e.size - 1));
  const dy = Math.max(0, e.y - y, y - (e.y + e.size - 1));
  return Math.max(dx, dy);
}
function nearestCell(e, x, y) {
  return [clamp(x, e.x, e.x + e.size - 1), clamp(y, e.y, e.y + e.size - 1)];
}
function bodyCenter(e) { return [e.x + (e.size - 1) / 2, e.y + (e.size - 1) / 2]; }
function bodyCenterI(e) { return [e.x + (e.size >> 1), e.y + (e.size >> 1)]; }
function inBody(e, x, y) { return x >= e.x && x < e.x + e.size && y >= e.y && y < e.y + e.size; }

function playerCanStand(x, y) {
  const m = G.map;
  return inb(m, x, y) && walkP(m, x, y) && !occupantAt(x, y);
}
// Can entity e stand with its top-left at (x,y)? Blocks walls, player, others.
function canOccupy(e, x, y, size, ignorePlayer) {
  const m = G.map, p = G.p;
  size = size || e.size;
  for (let dy = 0; dy < size; dy++) {
    for (let dx = 0; dx < size; dx++) {
      const cx = x + dx, cy = y + dy;
      if (!walkE(m, cx, cy)) return false;
      if (!ignorePlayer && p && !p.dead && cx === p.x && cy === p.y) return false;
      if (occupantAt(cx, cy, e)) return false;
    }
  }
  return true;
}
function bodyWalkable(e, x, y) {
  const m = G.map;
  for (let dy = 0; dy < e.size; dy++) for (let dx = 0; dx < e.size; dx++) if (!walkE(m, x + dx, y + dy)) return false;
  return true;
}
function findFreeNear(x, y, maxR, pred) {
  for (let r = 0; r <= maxR; r++) {
    let best = null, bd = 1e9;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const nx = x + dx, ny = y + dy;
        if (!pred(nx, ny)) continue;
        const d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = [nx, ny]; }
      }
    }
    if (best) return best;
  }
  return null;
}
function findBodySpot(e, x, y, maxR, size, ignorePlayer, avoidPlayerBy) {
  const p = G.p;
  return findFreeNear(x, y, maxR, (nx, ny) => {
    if (!canOccupy(e, nx, ny, size, ignorePlayer)) return false;
    if (avoidPlayerBy && p) {
      const dx = Math.max(0, nx - p.x, p.x - (nx + size - 1)), dy = Math.max(0, ny - p.y, p.y - (ny + size - 1));
      if (Math.max(dx, dy) < avoidPlayerBy) return false;
    }
    return true;
  });
}

// Line of sight between two cells (endpoints may be opaque).
function losClear(x0, y0, x1, y1) {
  const m = G.map;
  x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
  const pts = bresenham(x0, y0, x1, y1);
  for (let i = 0; i < pts.length - 1; i++) if (isOpaque(m, pts[i][0], pts[i][1])) return false;
  return true;
}
function enemySeesPlayer(e) {
  const p = G.p, [cx, cy] = bodyCenterI(e);
  const [nx, ny] = nearestCell(e, p.x, p.y);
  return losClear(nx, ny, p.x, p.y) || losClear(cx, cy, p.x, p.y);
}
function visibleToPlayer(e) {
  const m = G.map, p = G.p;
  const [nx, ny] = nearestCell(e, p.x, p.y);
  return m.vis[ny * m.w + nx] > 0;
}

// A ray from (x0,y0) passing exactly through (tx,ty), `len` cells long.
function aimRay(x0, y0, tx, ty, len) {
  const dx = tx - x0, dy = ty - y0, dd = Math.max(Math.abs(dx), Math.abs(dy));
  if (!dd) return [];
  const k = Math.max(1, Math.ceil(len / dd));
  return bresenham(x0, y0, x0 + dx * k, y0 + dy * k).slice(0, len);
}

// ---------------------------------------------------------------------------
// input
// ---------------------------------------------------------------------------
function heldDir() {
  let dx = 0, dy = 0;
  if (!G.keys) return null;
  for (const k of G.keys) {
    const d = MOVE_KEYS[k];
    if (d) { dx += d[0]; dy += d[1]; }
  }
  dx = Math.sign(dx); dy = Math.sign(dy);
  return dx || dy ? [dx, dy] : null;
}

function queueAction(name) {
  const p = G.p;
  if (G.mode !== 'play' || !p || p.dead) return;
  p.buffer = name;
  p.bufferT = 6;
}

function doAction(a) {
  switch (a) {
    case 'light': playerAttack(false, false); break;
    case 'heavy': playerAttack(true, false); break;
    case 'gun': fireGun(); break;
    case 'dodge': dodge(); break;
    case 'trick': trickWeapon(); break;
    case 'heal': useVial(); break;
    case 'interact': interact(); break;
    case 'bloodbullet': bloodBullet(); break;
    case 'music': playMusicBox(); break;
    default: break;
  }
}

// ---------------------------------------------------------------------------
// the hunter
// ---------------------------------------------------------------------------
function shapeTilesAt(shapeName, x, y, facing) {
  const m = G.map, out = [];
  const sh = SHAPES[shapeName] || SHAPES.front;
  for (const [ox, oy] of sh) {
    const [rx, ry] = rotOff(ox, oy, facing);
    const tx = x + rx, ty = y + ry;
    if (!inb(m, tx, ty) || isOpaque(m, tx, ty)) continue;
    if (!losClear(x, y, tx, ty)) continue;
    out.push([tx, ty]);
  }
  return out;
}
function currentShapeTiles() {
  const p = G.p, m = G.map;
  if (!p || !m || !G.save) return [];
  const f = curWeapon().forms[p.form] || curWeapon().forms[0];
  return shapeTilesAt(f.shape, p.x, p.y, p.facing);
}
function enemiesOnTiles(tiles) {
  const hit = [];
  for (const [x, y] of tiles) {
    const e = occupantAt(x, y);
    if (e && e.state !== 'dormant' && hit.indexOf(e) < 0) hit.push(e);
  }
  return hit;
}
function nearestFoe(range) {
  const p = G.p;
  let best = null, bd = 1e9;
  for (const e of G.enemies) {
    if (e.dead || e.state === 'dormant') continue;
    const d = footDist(e, p.x, p.y);
    if (d > range || !visibleToPlayer(e)) continue;
    const [nx, ny] = nearestCell(e, p.x, p.y);
    if (!losClear(p.x, p.y, nx, ny)) continue;
    const dd = d + Math.hypot(nx - p.x, ny - p.y) * 0.01;
    if (dd < bd) { bd = dd; best = e; }
  }
  return best;
}
function faceToward(x, y) {
  const p = G.p;
  const d = dirIndex(x - p.x, y - p.y);
  if (d >= 0) p.facing = d;
}
function spendStamina(cost) {
  const p = G.p;
  if (p.st < 1) {
    if (p.exhaustT <= 0) { fxText(p.x, p.y, 'exhausted', '#7fa07a', 16); p.exhaustT = 20; }
    return false;
  }
  p.st = Math.max(0, p.st - cost);
  p.stDelay = ST_DELAY;
  return true;
}
const SLASH_CH = ['|', '\\', '-', '/', '|', '\\', '-', '/'];

function playerAttack(heavy, transform) {
  const p = G.p, w = curWeapon();
  const f = w.forms[p.form] || w.forms[0];
  if (!heavy && !transform) {
    const v = visceralTarget();
    if (v) { visceralAttack(v); return; }
  }
  if (!spendStamina(f.stam * (heavy ? 1.5 : 1) * (transform ? 0.8 : 1))) return;
  let tiles = shapeTilesAt(f.shape, p.x, p.y, p.facing);
  let hits = enemiesOnTiles(tiles);
  if (!hits.length) {
    const t = nearestFoe(2);
    if (t) {
      const [nx, ny] = nearestCell(t, p.x, p.y);
      faceToward(nx, ny);
      tiles = shapeTilesAt(f.shape, p.x, p.y, p.facing);
      hits = enemiesOnTiles(tiles);
    }
  }
  const base = f.dmg * weaponMult() * (heavy ? 1.75 : 1) * (transform ? 1.15 : 1);
  for (const e of hits) {
    const dmg = base * (e.d.beast ? (w.beast || 1) : 1) * R.range(0.92, 1.08);
    damageEnemy(e, dmg, { heavy });
  }
  p.act = Math.round(f.rec * (heavy ? 1.6 : 1));
  const ch = SLASH_CH[p.facing];
  const col = heavy ? '#ffd27a' : transform ? '#ffb070' : '#e8e0d0';
  for (const [x, y] of tiles) fxGlyph(x, y, ch, col, heavy ? 5 : 3);
  sfx(heavy ? 'heavy' : 'swing');
  if (hits.length) { sfx('hit'); if (heavy) G.shake = Math.max(G.shake, 2.5); }
}

function visceralTarget() {
  const p = G.p;
  let best = null;
  for (const e of G.enemies) {
    if (e.dead || e.state !== 'stagger' || !e.parried) continue;
    if (footDist(e, p.x, p.y) <= 1) { best = e; break; }
  }
  return best;
}
function visceralAttack(e) {
  const p = G.p, w = curWeapon(), f = w.forms[p.form] || w.forms[0];
  const [nx, ny] = nearestCell(e, p.x, p.y);
  faceToward(nx, ny);
  const dmg = f.dmg * weaponMult() * visceralMult() * (e.d.beast ? (w.beast || 1) : 1);
  p.iframes = 14; p.act = 14;
  e.parried = false; e.state = 'recover'; e.timer = 18; e.tiles = null; e.comboLeft = 0;
  sfx('visceral');
  G.shake = 8;
  bleed(nx, ny, 34);
  fxText(nx, ny - 1, 'VISCERAL', '#ff4a3a', 30, true);
  damageEnemy(e, dmg, { visceral: true });
}

function fireGun() {
  const p = G.p, s = G.save, m = G.map;
  if (s.bullets <= 0) {
    log('No Quicksilver Bullets. [B] turns your blood into bullets.', '#9aa0b0');
    p.act = 3;
    return;
  }
  s.bullets--;
  p.act = 6;
  sfx('gun');
  const t = gunTarget();
  let tx, ty;
  if (t) {
    [tx, ty] = nearestCell(t, p.x, p.y);
    faceToward(tx, ty);
  } else {
    const d = DIRS[p.facing];
    tx = p.x + d[0] * GUN.range; ty = p.y + d[1] * GUN.range;
  }
  const line = bresenham(p.x, p.y, tx, ty);
  for (let i = 0; i < line.length; i++) {
    const [x, y] = line[i];
    if (isOpaque(m, x, y)) break;
    fxGlyph(x, y, i === 0 ? '*' : '·', '#ffe6a0', 2 + (i >> 2));
    if (t && inBody(t, x, y)) break;
    if (!t && occupantAt(x, y)) break;
  }
  if (!t) return;
  const parry = parryWindow(t);
  damageEnemy(t, gunDmg() * R.range(0.92, 1.08), { gun: true, noPoise: parry });
  if (parry && !t.dead) parryEnemy(t);
}
// Gun parries only land in the last 40% of a wind-up (when the telegraph glows brightest).
function parryWindow(e) {
  return !!(e && !e.dead && e.state === 'windup' && e.atk && e.atk.parry !== false && e.atk.shape !== 'heal' &&
    e.timer <= Math.max(2, Math.ceil(e.atk.windup * 0.4)));
}
function gunTarget() {
  const p = G.p, fdir = DIRS[p.facing];
  const fang = Math.atan2(fdir[1], fdir[0]);
  let best = null, bs = 1e9;
  for (const e of G.enemies) {
    if (e.dead || e.state === 'dormant') continue;
    const d = footDist(e, p.x, p.y);
    if (d > GUN.range || !visibleToPlayer(e)) continue;
    const [nx, ny] = nearestCell(e, p.x, p.y);
    if (!losClear(p.x, p.y, nx, ny)) continue;
    let sc = d;
    const a = Math.atan2(ny - p.y, nx - p.x);
    if (d > 0 && Math.abs(angDiff(a, fang)) > Math.PI * 50 / 180) sc += 2.5;
    if (e.state === 'windup' && e.atk && e.atk.parry !== false && e.atk.shape !== 'heal') sc -= 3.5;
    if (sc < bs) { bs = sc; best = e; }
  }
  return best;
}
function parryEnemy(e) {
  e.state = 'stagger';
  e.timer = e.boss ? 45 : 40;
  e.parried = true;
  e.tiles = null; e.comboLeft = 0; e.path = null;
  sfx('parry');
  G.shake = Math.max(G.shake, 3);
  const [cx, cy] = bodyCenterI(e);
  fxText(cx, cy - 1, 'PARRIED', '#ffe060', 28, true);
  for (let i = 0; i < 10; i++) {
    const a = R() * Math.PI * 2;
    fxPart(cx + 0.5, cy + 0.5, Math.cos(a) * 0.35, Math.sin(a) * 0.35, '#ffe48a', 10, 2.2);
  }
  if (e.boss) log(`${e.name} is staggered! Strike now [J]!`, '#ffe080');
}

function dodge() {
  const p = G.p, m = G.map;
  let d = heldDir(), back = false;
  if (!d) { d = DIRS[(p.facing + 4) % 8]; back = true; }
  if (!spendStamina(DODGE_COST)) return;
  const can = (x, y) => inb(m, x, y) && walkP(m, x, y);
  let dir = d;
  if (!can(p.x + dir[0], p.y + dir[1]) && dir[0] && dir[1]) {
    if (can(p.x + dir[0], p.y)) dir = [dir[0], 0];
    else if (can(p.x, p.y + dir[1])) dir = [0, dir[1]];
  }
  const ox = p.x, oy = p.y;
  let cx = ox, cy = oy, land = [ox, oy];
  for (let i = 0; i < 2; i++) {
    const nx = cx + dir[0], ny = cy + dir[1];
    if (!can(nx, ny)) break;
    cx = nx; cy = ny;
    if (!occupantAt(cx, cy)) land = [cx, cy];
  }
  p.x = land[0]; p.y = land[1];
  p.iframes = back ? 6 : 7;
  p.act = back ? 4 : 5;
  p.moveCd = 0;
  p.ghost = { x: ox, y: oy, t: 6 };
  sfx('dodge');
  if (p.x !== ox || p.y !== oy) {
    const mid = bresenham(ox, oy, p.x, p.y);
    for (const [x, y] of mid.slice(0, -1)) fxGlyph(x, y, '·', '#7080a8', 4);
    onPlayerStep();
  }
}

function trickWeapon() {
  const p = G.p, w = curWeapon();
  p.form = p.form ? 0 : 1;
  sfx('trick');
  fxText(p.x, p.y, w.forms[p.form].name, p.form ? '#e0a050' : '#c8b8a0', 18);
  if (p.st >= 1) playerAttack(false, true);
  else p.act = 6;
}

function useVial() {
  const p = G.p, s = G.save, mh = maxHp();
  if (s.vials <= 0) { log('You have no Blood Vials.', '#a08080'); p.act = 2; return; }
  if (p.hp >= mh) { fxText(p.x, p.y, 'full health', '#8a9a8a', 14); return; }
  s.vials--;
  const amt = Math.round(mh * 0.4);
  const before = p.hp;
  p.hp = Math.min(mh, p.hp + amt);
  p.rally = Math.min(p.rally, mh - p.hp);
  p.act = 8; p.flashT = 8;
  sfx('heal');
  fxText(p.x, p.y, '+' + Math.round(p.hp - before), '#7ae08a', 22);
}

function bloodBullet() {
  const p = G.p, s = G.save, mh = maxHp();
  const cost = Math.round(mh * 0.2);
  if (s.bullets >= MAX_BULLETS) { log('Your bullet pouch is full.', '#9aa0b0'); return; }
  if (p.hp <= cost + 1) { log('You are too weak to draw more blood.', '#a08080'); return; }
  p.hp -= cost;
  p.rally = Math.min(mh - p.hp, p.rally + cost);
  p.rallyT = RALLY_WINDOW;
  s.bullets = Math.min(MAX_BULLETS, s.bullets + 5);
  p.act = 10;
  sfx('hurt');
  bleed(p.x, p.y, 10);
  fxText(p.x, p.y, '+5 bullets', '#ccd4e0', 20);
}

function playMusicBox() {
  const p = G.p, s = G.save;
  if (!s.flags.musicBox) { log('You have nothing to play.', '#8a8a9a'); return; }
  if (p.musicCd > 0) { log('The tiny music box must rest a moment.', '#8a8a9a'); return; }
  p.musicCd = MUSIC_CD;
  p.act = 20;
  sfx('music');
  log('A melancholy tune drifts from the Tiny Music Box...', '#d8c0e0');
  for (let i = 0; i < 6; i++) fxText(p.x + R.int(-1, 1), p.y, '♪', '#e8d0f0', 26 + i * 4);
  const g = G.enemies.find(e => !e.dead && e.id === 'gascoigne' && e.state !== 'dormant');
  if (g && footDist(g, p.x, p.y) <= 14) {
    if (g.phase === 1) {
      g.state = 'stagger'; g.timer = 80; g.parried = false; g.tiles = null; g.comboLeft = 0; g.path = null;
      log('Father Gascoigne clutches his head... "That tune..."', '#e0c0a0');
      fxText(g.x, g.y - 1, 'stunned', '#ffe060', 30);
    } else {
      log('The beast no longer remembers the melody.', '#a08080');
    }
  }
}

// ---------------------------------------------------------------------------
// interaction & pickups
// ---------------------------------------------------------------------------
function interact() {
  const p = G.p, m = G.map, fd = DIRS[p.facing];
  const cands = [];
  for (const l of m.lamps) if (l.active && cheb(l.x, l.y, p.x, p.y) <= 1) cands.push({ kind: 'lamp', x: l.x, y: l.y, lamp: l });
  for (const f of m.features) if (cheb(f.x, f.y, p.x, p.y) <= 1) cands.push({ kind: f.kind, x: f.x, y: f.y, feat: f });
  if (!cands.length) {
    const note = (m.items || []).find(it => it.kind === 'note' && it.x === p.x && it.y === p.y);
    if (note) { openNoteMenu(note); return; }
    fxText(p.x, p.y, '...', '#8a8a8a', 12);
    return;
  }
  let c = cands.find(q => q.x === p.x + fd[0] && q.y === p.y + fd[1]) || cands[0];
  faceToward(c.x, c.y);
  p.buffer = null;
  switch (c.kind) {
    case 'lamp': useLamp(c.lamp); break;
    case 'doll': openDollMenu(); break;
    case 'messenger': openShopMenu(); break;
    case 'workbench': openWorkbenchMenu(); break;
    case 'headstone': openTravelMenu('The Headstones'); break;
    case 'gehrman': openGehrmanMenu(); break;
    case 'window': openWindowMenu(); break;
    default: log(c.feat && c.feat.name ? c.feat.name : 'Nothing happens.', '#a09a8a');
  }
}

function onPlayerStep() {
  const p = G.p;
  pickupAt(p.x, p.y);
}
function pickupAt(x, y) {
  const m = G.map, s = G.save, p = G.p;
  for (const it of m.items || []) {
    if (it.x !== x || it.y !== y) continue;
    if (it.kind === 'note') {
      if (p.noteKey !== it.key) {
        p.noteKey = it.key;
        if (!s.taken[it.key]) s.taken[it.key] = 1;
        log(it.text || 'A blood-smeared message.', '#eadfb2');
      }
      continue;
    }
    if (s.taken[it.key]) continue;
    s.taken[it.key] = 1;
    gainItem(it.kind, x, y);
  }
  if (!(m.items || []).some(it => it.kind === 'note' && it.x === x && it.y === y)) p.noteKey = null;
  for (let i = G.drops.length - 1; i >= 0; i--) {
    const d = G.drops[i];
    if (d.x === x && d.y === y) { G.drops.splice(i, 1); gainItem(d.kind, x, y); }
  }
  const st = s.stain;
  if (st && st.area === m.id && st.x === x && st.y === y) {
    s.echoes += st.amount;
    log(`You recover your lost Blood Echoes (${st.amount}).`, '#f0d898');
    fxText(x, y, '+' + st.amount, '#f0d898', 30, true);
    s.stain = null;
    sfx('pickup');
    saveGame();
  }
}
function gainItem(kind, x, y) {
  const s = G.save;
  const g = ITEM_GLYPH[kind] || { name: kind, col: '#ffffff' };
  switch (kind) {
    case 'vial': s.vials = Math.min(MAX_VIALS, s.vials + 1); break;
    case 'bullets': s.bullets = Math.min(MAX_BULLETS, s.bullets + 4); break;
    case 'shard': s.shards++; break;
    case 'coldblood': {
      const n = Math.round(110 * areaMult().echo * ngMult());
      s.echoes += n;
      log(`You crush the Coldblood Dew: +${n} Blood Echoes.`, '#94bde4');
      break;
    }
    case 'cord':
      s.cords++; s.insight++;
      log(`One Third of Umbilical Cord (${s.cords}/3). Your eyes open to things unseen. +1 Insight`, '#d862a8');
      break;
    default: break;
  }
  if (kind !== 'coldblood' && kind !== 'cord') log(`Picked up: ${g.name}`, g.col);
  fxText(x, y, g.ch || '+', g.col, 18);
  sfx('pickup');
}

// ---------------------------------------------------------------------------
// player damage, death, respawn
// ---------------------------------------------------------------------------
function hurtPlayer(dmg, src, atk) {
  const p = G.p;
  if (!p || p.dead || G.mode !== 'play') return false;
  if (p.iframes > 0) return false;
  dmg = Math.max(1, Math.round(dmg));
  const mh = maxHp();
  p.hp -= dmg;
  p.rally = clamp(p.rally + dmg, 0, Math.max(0, mh - Math.max(0, p.hp)));
  p.rallyT = RALLY_WINDOW;
  G.flash = Math.min(1, G.flash + 0.55);
  G.shake = Math.max(G.shake, dmg >= 30 ? 6 : 4);
  sfx('hurt');
  bleed(p.x, p.y, 10);
  fxText(p.x, p.y, '-' + dmg, '#ff5a4a', 20);
  if (p.hp <= 0) { p.hp = 0; die(); return true; }
  p.act = Math.max(p.act, 3);
  p.buffer = null;
  if (atk && atk.knock && src) knockPlayer(src, atk.knock);
  return true;
}
function knockPlayer(src, n) {
  const p = G.p, [cx, cy] = bodyCenter(src);
  const dx = Math.sign(Math.round(p.x - cx)), dy = Math.sign(Math.round(p.y - cy));
  if (!dx && !dy) return;
  for (let i = 0; i < n; i++) {
    const nx = p.x + dx, ny = p.y + dy;
    if (!playerCanStand(nx, ny)) break;
    p.x = nx; p.y = ny;
  }
  onPlayerStep();
}

function die() {
  const p = G.p, s = G.save, m = G.map;
  p.dead = true; p.hp = 0; p.rally = 0; p.buffer = null;
  G.mode = 'dead';
  G.deadT = 70;
  s.deaths++;
  if (s.echoes > 0) s.stain = { area: m.id, x: p.x, y: p.y, amount: Math.floor(s.echoes) };
  else s.stain = null;
  s.echoes = 0;
  for (const e of G.enemies) { e.tiles = null; if (e.state === 'windup') { e.state = 'recover'; e.timer = 10; } }
  banner('YOU DIED', '#a8141c', 3600, 1.25, '');
  sfx('death');
  G.flash = 1; G.shake = 5;
  bleed(p.x, p.y, 30);
  log(s.stain ? 'Your Blood Echoes lie where you fell. Reclaim them before you die again.' : 'You died.', '#c04040');
  saveGame();
}

function respawn() {
  const s = G.save, p = G.p, m = G.map;
  let area = 'central', lamp = 'central:start';
  if (m && (m.id === 'field' || m.id === 'dream')) { area = 'dream'; lamp = 'dream'; }
  else if (s.lastLamp && (AREAS[s.lastLamp.area])) { area = s.lastLamp.area; lamp = s.lastLamp.id; }
  p.dead = false;
  p.hp = maxHp(); p.rally = 0; p.rallyT = 0; p.st = maxSt(); p.stDelay = 0; p.flashT = 0;
  p.form = p.form || 0;
  s.vials = Math.max(s.vials, VIAL_STOCK);
  s.bullets = MAX_BULLETS;
  loadArea(area, lamp);
  G.mode = 'play';
  p.iframes = 20;
  log(area === 'dream' ? 'You awaken in the Hunter\'s Dream.' : 'You awaken beside the lamp. The beasts have returned.', '#c8b88a');
  saveGame();
}

// ---------------------------------------------------------------------------
// main tick
// ---------------------------------------------------------------------------
function update() {
  if (G.mode === 'dead') {
    tickFx();
    if (--G.deadT <= 0) respawn();
    return;
  }
  if (G.mode !== 'play' || !G.map || !G.p || !G.save) return;
  G.tick++;
  G.save.playTicks++;
  runTimers();
  if (G.mode !== 'play') return;
  updatePlayer();
  if (G.mode === 'dead') { tickFx(); return; }
  checkArena();
  updateFlow();
  const p = G.p;
  for (const e of G.enemies.slice()) {
    if (e.dead) continue;
    if (!e.aware && !e.boss && cheb(e.x, e.y, p.x, p.y) > 40) continue;
    updateEnemy(e);
    if (G.mode === 'dead' || G.map === null) break;
  }
  if (G.enemies.some(e => e.dead)) G.enemies = G.enemies.filter(e => !e.dead);
  tickFx();
  if (G.map && G.p) computeFOV(G.map, G.p.x, G.p.y);
  if (G.tick % 600 === 0 && !G.bossBar && G.mode === 'play') saveGame();
}

function runTimers() {
  if (!G.timers.length) return;
  const due = G.timers.filter(t => t.at <= G.tick);
  if (!due.length) return;
  G.timers = G.timers.filter(t => t.at > G.tick);
  for (const t of due) t.fn();
}

function updatePlayer() {
  const p = G.p, mh = maxHp(), ms = maxSt();
  if (p.iframes > 0) p.iframes--;
  if (p.flashT > 0) p.flashT--;
  if (p.musicCd > 0) p.musicCd--;
  if (p.exhaustT > 0) p.exhaustT--;
  if (p.stDelay > 0) p.stDelay--;
  else if (p.st < ms) p.st = Math.min(ms, p.st + 2.2);
  if (p.rally > 0) {
    if (p.rallyT > 0) p.rallyT--;
    else p.rally = Math.max(0, p.rally - Math.max(0.6, mh * 0.008));
  }
  if (p.hp > mh) p.hp = mh;
  if (p.hp + p.rally > mh) p.rally = Math.max(0, mh - p.hp);
  if (p.act > 0) p.act--;
  if (p.moveCd > 0) p.moveCd--;
  if (p.bufferT > 0) p.bufferT--;
  else p.buffer = null;
  if (p.act === 0 && p.buffer) {
    const b = p.buffer;
    p.buffer = null;
    doAction(b);
    if (G.mode !== 'play') return;
  }
  if (p.act === 0 && p.moveCd === 0) {
    const d = heldDir();
    if (d) tryMove(d[0], d[1]);
  }
}

function tryMove(dx, dy) {
  const p = G.p;
  const fd = dirIndex(dx, dy);
  if (fd >= 0) p.facing = fd;
  const opts = dx && dy ? [[dx, dy], [dx, 0], [0, dy]] : [[dx, dy]];
  for (const [ox, oy] of opts) {
    const nx = p.x + ox, ny = p.y + oy;
    if (playerCanStand(nx, ny)) {
      p.x = nx; p.y = ny;
      p.moveCd = MOVE_CD;
      onPlayerStep();
      return true;
    }
  }
  p.moveCd = 1;
  return false;
}

// ---------------------------------------------------------------------------
// flow field (BFS from the player over enemy-walkable tiles)
// ---------------------------------------------------------------------------
function updateFlow() {
  const m = G.map, p = G.p;
  const key = p.y * m.w + p.x;
  if (G.flow && G.flowKey === key && G.flowMap === m) return;
  const n = m.w * m.h;
  if (!G.flow || G.flow.length !== n) { G.flow = new Int16Array(n); G.flowQ = new Int32Array(n); }
  const fl = G.flow, q = G.flowQ, W = m.w, H = m.h;
  fl.fill(-1);
  let h = 0, t = 0;
  fl[key] = 0; q[t++] = key;
  while (h < t) {
    const i = q[h++], d = fl[i];
    if (d >= 44) continue;
    const x = i % W, y = (i / W) | 0;
    for (let k = 0; k < 8; k++) {
      const nx = x + DIRS[k][0], ny = y + DIRS[k][1];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (fl[j] !== -1) continue;
      if (T_WALK_E[m.tiles[j]] !== 1) continue;
      fl[j] = d + 1;
      q[t++] = j;
    }
  }
  G.flowKey = key; G.flowMap = m;
}
function flowScore(e, x, y) {
  const m = G.map, p = G.p, fl = G.flow;
  let best = 1e9;
  for (let dy = 0; dy < e.size; dy++) {
    for (let dx = 0; dx < e.size; dx++) {
      const v = fl ? fl[(y + dy) * m.w + x + dx] : -1;
      if (v >= 0 && v < best) best = v;
    }
  }
  const cx = x + (e.size - 1) / 2, cy = y + (e.size - 1) / 2;
  const eu = Math.hypot(cx - p.x, cy - p.y);
  if (best === 1e9) best = 500 + eu;
  return best + eu * 0.01;
}
function stepToward(e) {
  const cur = flowScore(e, e.x, e.y);
  let best = null, bs = cur - 1e-6;
  const side = [];
  for (let d = 0; d < 8; d++) {
    const nx = e.x + DIRS[d][0], ny = e.y + DIRS[d][1];
    if (!canOccupy(e, nx, ny)) continue;
    const sc = flowScore(e, nx, ny);
    if (sc < bs) { bs = sc; best = [nx, ny, d]; }
    else if (sc < cur + 1.02) side.push([nx, ny, d]);
  }
  if (!best && side.length && R.chance(0.35)) best = R.pick(side);
  if (best) { e.x = best[0]; e.y = best[1]; e.facing = best[2]; return true; }
  return false;
}
function stepRandom(e) {
  const opts = [];
  for (let d = 0; d < 8; d++) {
    const nx = e.x + DIRS[d][0], ny = e.y + DIRS[d][1];
    if (canOccupy(e, nx, ny)) opts.push([nx, ny, d]);
  }
  if (!opts.length) return false;
  const o = R.pick(opts);
  e.x = o[0]; e.y = o[1]; e.facing = o[2];
  return true;
}

// ---------------------------------------------------------------------------
// enemy AI
// ---------------------------------------------------------------------------
function reactDelay(e) {
  if (e.boss) return e.phase === 2 ? R.int(1, 6) : R.int(3, 10);
  return R.int(4, 12);
}
function bark(e, force) {
  const d = e.d;
  if (!d.barks || !d.barks.length) return;
  if (!force && !R.chance(0.6)) return;
  const b = R.pick(d.barks);
  fxText(e.x, e.y, b, '#e0caa0', 44);
  if (R.chance(0.3)) log(`${e.name}: "${b}"`, '#a89878');
}
function aggro(e, alertOthers) {
  if (e.aware && e.state !== 'idle') return;
  e.aware = true;
  e.state = 'chase';
  e.lost = 0;
  e.readyAt = G.tick + R.int(5, 12);
  if (e.d.barks) bark(e);
  else if (!e.boss) fxText(e.x, e.y, '!', '#ff6a50', 16);
  if (alertOthers) {
    for (const o of G.enemies) {
      if (o === e || o.dead || o.boss || o.state !== 'idle') continue;
      if (cheb(o.x, o.y, e.x, e.y) <= 6) aggro(o, false);
    }
  }
}

function updateEnemy(e) {
  const p = G.p;
  if (e.flashT > 0) e.flashT--;
  switch (e.state) {
    case 'dormant': return;
    case 'idle': {
      if ((G.tick + e.uid) % 3 === 0) {
        const dist = footDist(e, p.x, p.y);
        if (dist <= e.d.sight && enemySeesPlayer(e)) aggro(e, true);
      }
      if (e.state === 'idle' && (e.d.erratic || R.chance(0.004)) && R.chance(0.02)) stepRandom(e);
      return;
    }
    case 'chase': enemyChase(e); return;
    case 'windup':
      e.timer--;
      if (e.timer <= 0) executeAttack(e);
      return;
    case 'recover':
      e.timer--;
      if (e.timer <= 0) { e.state = 'chase'; e.readyAt = G.tick + reactDelay(e); }
      return;
    case 'stagger':
      e.timer--;
      if (e.timer <= 0) { e.parried = false; e.state = 'recover'; e.timer = 6; }
      return;
    case 'transform':
      e.timer--;
      if (e.timer <= 0) { e.state = 'chase'; e.readyAt = G.tick + R.int(2, 6); }
      return;
    default:
      e.state = 'chase';
  }
}

function enemyChase(e) {
  const p = G.p;
  const dist = footDist(e, p.x, p.y);
  if (e.boss && e.phase === 1 && e.d.phase2 && e.hp <= e.maxHp * e.d.phase2.at) { bossPhase2(e); return; }
  if (!e.boss) {
    const fv = G.flow ? flowScore(e, e.x, e.y) : 999;
    if (fv >= 500 || dist > 32) {
      if (++e.lost > 140) { e.state = 'idle'; e.aware = false; e.lost = 0; return; }
    } else e.lost = 0;
    if (e.d.barks && R.chance(0.0035)) bark(e, true);
  }
  if (G.tick >= e.readyAt) {
    const a = pickAttack(e, dist);
    if (a) { startAttack(e, a); return; }
  }
  if (--e.moveT <= 0) {
    e.moveT = e.speed || e.d.speed || 4;
    if (e.d.erratic && R.chance(e.d.erratic)) stepRandom(e);
    else if (dist > 1 || e.boss) stepToward(e);
  }
}

function pickAttack(e, dist) {
  const opts = [];
  let los = null;
  for (const a of e.d.attacks) {
    if (a.ph && a.ph !== e.phase) continue;
    if ((e.cds[a.id] || 0) > G.tick) continue;
    if (a.shape === 'heal') {
      if (e.hp > e.maxHp * (a.hpBelow || 1) || e.healUses >= (a.uses || 99)) continue;
      opts.push([a, a.w || 1]);
      continue;
    }
    if (a.shape === 'blink') {
      // only useful when the hunter is not already in reach
      if (dist < (a.minRange || 2) || dist > a.range) continue;
    } else if (dist > a.range || dist < (a.minRange || 0)) continue;
    if (los === null) los = enemySeesPlayer(e);
    if (!los) continue;
    opts.push([a, a.w || 1]);
  }
  if (!opts.length) return null;
  return R.weighted(opts);
}

function startAttack(e, a, windup) {
  e.atkBase = a;
  e.comboLeft = a.combo || 0;
  if (a.cd) e.cds[a.id] = G.tick + a.cd;
  if (a.shape === 'heal') e.healUses++;
  startWindup(e, a, windup);
}
function startWindup(e, a, windup) {
  const p = G.p;
  const atk = Object.assign({}, a);
  if (windup) atk.windup = windup;
  e.atk = atk;
  e.state = 'windup';
  e.timer = atk.windup;
  e.healDmg = 0;
  e.path = null;
  const [cx, cy] = bodyCenter(e);
  const fd = dirIndex(Math.round(p.x - cx), Math.round(p.y - cy));
  if (fd >= 0) e.facing = fd;
  e.tiles = attackTiles(e, atk);
  if (a.say) log(a.say, '#e0a060');
  const dist = footDist(e, p.x, p.y);
  if (dist <= 12 && visibleToPlayer(e)) sfx(e.boss && atk.windup >= 16 ? 'roar' : 'enemyAtk');
}

function addAttackTile(set, e, x, y) {
  const m = G.map;
  if (!inb(m, x, y) || isOpaque(m, x, y)) return false;
  if (!inBody(e, x, y)) set.add(y * m.w + x);
  return true;
}
function attackTiles(e, a) {
  const m = G.map, p = G.p;
  const set = new Set();
  const [cx, cy] = bodyCenter(e);
  const [ix, iy] = bodyCenterI(e);
  const aim = Math.atan2(p.y - cy, p.x - cx);
  switch (a.shape) {
    case 'heal':
    case 'blink':
      return null;
    case 'ray': {
      const [sx, sy] = e.size > 1 ? nearestCell(e, p.x, p.y) : [e.x, e.y];
      for (const [x, y] of aimRay(sx, sy, p.x, p.y, a.len || 2)) if (!addAttackTile(set, e, x, y)) break;
      if (a.shot) {
        // tracer will be drawn on execution
      }
      break;
    }
    case 'lunge':
    case 'charge': {
      const path = [];
      const pts = aimRay(ix, iy, p.x, p.y, a.len || 2);
      for (const [x, y] of pts) {
        const nx = e.x + (x - ix), ny = e.y + (y - iy);
        if (!bodyWalkable(e, nx, ny) && !(x === p.x && y === p.y && walkP(m, x, y))) break;
        path.push([nx, ny]);
        for (let dy = 0; dy < e.size; dy++) for (let dx = 0; dx < e.size; dx++) addAttackTile(set, e, nx + dx, ny + dy);
        if (!bodyWalkable(e, nx, ny)) break;
      }
      e.path = path;
      break;
    }
    case 'cone': {
      const r = a.r || 1, half = (a.half || 60) * Math.PI / 180;
      for (let y = e.y - r; y < e.y + e.size + r; y++) {
        for (let x = e.x - r; x < e.x + e.size + r; x++) {
          const fd = footDist(e, x, y);
          if (fd < 1 || fd > r) continue;
          const ang = Math.atan2(y - cy, x - cx);
          if (Math.abs(angDiff(ang, aim)) > half + 1e-6) continue;
          if (!losClear(ix, iy, x, y)) continue;
          addAttackTile(set, e, x, y);
        }
      }
      break;
    }
    case 'ring': {
      const r = a.r || 1, r0 = a.rMin || 1;
      for (let y = e.y - r; y < e.y + e.size + r; y++) {
        for (let x = e.x - r; x < e.x + e.size + r; x++) {
          const fd = footDist(e, x, y);
          if (fd < r0 || fd > r) continue;
          if (!losClear(ix, iy, x, y)) continue;
          addAttackTile(set, e, x, y);
        }
      }
      break;
    }
    case 'leap': {
      const r = a.r || 1, half = e.size >> 1;
      let spot = [p.x - half, p.y - half];
      if (!canOccupy(e, spot[0], spot[1], e.size, true)) spot = findBodySpot(e, spot[0], spot[1], 3, e.size, true);
      if (!spot) spot = [e.x, e.y];
      e.path = [spot];
      const tcx = spot[0] + half, tcy = spot[1] + half;
      for (let y = tcy - r; y <= tcy + r; y++) for (let x = tcx - r; x <= tcx + r; x++) addAttackTile(set, e, x, y);
      for (let dy = 0; dy < e.size; dy++) for (let dx = 0; dx < e.size; dx++) addAttackTile(set, e, spot[0] + dx, spot[1] + dy);
      break;
    }
    case 'spread': {
      for (const off of [-0.38, 0, 0.38]) {
        for (const [x, y] of rayAngle(cx, cy, aim + off, a.len || 5)) if (!addAttackTile(set, e, x, y)) break;
      }
      break;
    }
    case 'wave': {
      const px = -Math.sin(aim), py = Math.cos(aim);
      for (const o of [-1, 0, 1]) {
        const sx = cx + px * o, sy = cy + py * o;
        if (o) addAttackTile(set, e, Math.round(sx), Math.round(sy));
        for (const [x, y] of rayAngle(sx, sy, aim, a.len || 9)) if (!addAttackTile(set, e, x, y)) break;
      }
      break;
    }
    case 'scatter': {
      const centers = [[p.x, p.y]];
      let tries = 0;
      while (centers.length < (a.n || 5) && tries++ < 60) {
        const x = p.x + R.int(-3, 3), y = p.y + R.int(-3, 3);
        if (!inb(m, x, y) || isOpaque(m, x, y)) continue;
        if (centers.some(c => Math.abs(c[0] - x) + Math.abs(c[1] - y) < 2)) continue;
        centers.push([x, y]);
      }
      for (const [x, y] of centers) {
        addAttackTile(set, e, x, y);
        for (let k = 0; k < 8; k += 2) addAttackTile(set, e, x + DIRS[k][0], y + DIRS[k][1]);
      }
      break;
    }
    default: {
      if (SHAPES[a.shape]) {
        for (const [ox, oy] of SHAPES[a.shape]) {
          const [rx, ry] = rotOff(ox, oy, e.facing);
          const x = ix + rx, y = iy + ry;
          if (!losClear(ix, iy, x, y)) continue;
          addAttackTile(set, e, x, y);
        }
      }
    }
  }
  return set;
}

function executeAttack(e) {
  const a = e.atk, p = G.p, m = G.map;
  if (!a) { e.state = 'chase'; return; }
  const pi = p.y * m.w + p.x;
  const hit = !!(e.tiles && e.tiles.has(pi));
  switch (a.shape) {
    case 'heal': {
      const amt = Math.round(e.maxHp * (a.amount || 0.2));
      e.hp = Math.min(e.maxHp, e.hp + amt);
      fxText(e.x + (e.size >> 1), e.y - 1, '+' + amt, '#e8d890', 30, true);
      log(`${e.name}'s prayer is answered. Her wounds close.`, '#e0c070');
      sfx('heal');
      break;
    }
    case 'blink': {
      blinkBehind(e);
      const next = e.d.attacks.find(q => q.id === a.next);
      if (next) { startAttack(e, next, 6); e.cds[next.id] = 0; return; }
      break;
    }
    case 'leap': {
      const spot = e.path && e.path[0];
      if (spot) {
        let land = spot;
        if (!canOccupy(e, land[0], land[1], e.size, true)) land = findBodySpot(e, spot[0], spot[1], 3, e.size, true);
        if (land) {
          fxGlyph(e.x + (e.size >> 1), e.y + (e.size >> 1), '*', '#8a7a6a', 6);
          e.x = land[0]; e.y = land[1];
        }
      }
      if (hit && a.dmg) hurtPlayer(scaleDmg(e, a.dmg), e, a);
      pushPlayerOut(e);
      G.shake = Math.max(G.shake, 5);
      break;
    }
    case 'lunge':
    case 'charge': {
      if (hit && a.dmg) hurtPlayer(scaleDmg(e, a.dmg), e, a);
      for (const [nx, ny] of e.path || []) {
        if (!canOccupy(e, nx, ny)) break;
        e.x = nx; e.y = ny;
      }
      break;
    }
    default: {
      if (a.special === 'bloodletting') {
        if (hit && p.iframes <= 0 && !p.dead) {
          const lost = Math.max(0, p.hp - 1);
          p.hp = 1;
          p.rally = Math.min(maxHp() - 1, p.rally + lost);
          p.rallyT = RALLY_WINDOW;
          G.flash = 1; G.shake = 7;
          sfx('hurt');
          bleed(p.x, p.y, 28);
          log('Your blood boils and bursts from your veins!', '#ff4060');
        }
      } else if (hit && a.dmg) hurtPlayer(scaleDmg(e, a.dmg), e, a);
    }
  }
  // the blow lands: brief flash on every target tile
  if (e.tiles && e.tiles.size) {
    const W = m.w, many = e.tiles.size > 40;
    const ch = a.shot ? '-' : a.special === 'bloodletting' ? '*' : a.shape === 'leap' ? '#' : '×';
    for (const i of e.tiles) {
      if (many && R.chance(0.5)) continue;
      fxGlyph(i % W, (i / W) | 0, ch, a.shot ? '#ffe6a0' : '#ff5a48', 3);
    }
  }
  if (a.shot) sfx('gun');
  e.tiles = null;
  if (G.mode !== 'play' || e.dead) return;
  if (e.comboLeft > 0 && e.state === 'windup' && e.atkBase) {
    e.comboLeft--;
    const base = e.atkBase, left = e.comboLeft;
    startWindup(e, base, Math.max(4, Math.round(base.windup * 0.6)));
    e.comboLeft = left;
    return;
  }
  e.state = 'recover';
  e.timer = a.rec || 8;
  e.path = null;
}
function scaleDmg(e, dmg) {
  const am = e.boss ? 1 : areaMult().dmg;
  return dmg * am * ngMult() * R.range(0.92, 1.08);
}

function blinkBehind(e) {
  const p = G.p;
  const [cx, cy] = bodyCenter(e);
  const dx = Math.sign(Math.round(p.x - cx)), dy = Math.sign(Math.round(p.y - cy));
  const tx = p.x + dx * (1 + (e.size >> 1)), ty = p.y + dy * (1 + (e.size >> 1));
  const spot = findFreeNear(tx - (e.size >> 1), ty - (e.size >> 1), 3, (x, y) => {
    if (!canOccupy(e, x, y)) return false;
    const fdx = Math.max(0, x - p.x, p.x - (x + e.size - 1)), fdy = Math.max(0, y - p.y, p.y - (y + e.size - 1));
    return Math.max(fdx, fdy) <= 2;
  });
  if (!spot) return;
  for (let i = 0; i < 6; i++) fxPart(cx + 0.5, cy + 0.5, R.range(-0.3, 0.3), R.range(-0.3, 0.3), '#c8d0ff', 12, 2);
  fxGlyph(Math.round(cx), Math.round(cy), e.ch || '?', '#606890', 6);
  e.x = spot[0]; e.y = spot[1];
}

function pushPlayerOut(e) {
  const p = G.p;
  if (!inBody(e, p.x, p.y)) return;
  const spot = findFreeNear(p.x, p.y, 5, (x, y) => playerCanStand(x, y) && !inBody(e, x, y));
  if (spot) { p.x = spot[0]; p.y = spot[1]; onPlayerStep(); }
}

// ---------------------------------------------------------------------------
// damaging enemies
// ---------------------------------------------------------------------------
function damageEnemy(e, dmg, opts) {
  opts = opts || {};
  if (e.dead) return;
  const p = G.p;
  dmg = Math.max(1, Math.round(dmg));
  e.hp -= dmg;
  e.flashT = 3;
  const [nx, ny] = nearestCell(e, p.x, p.y);
  fxText(nx, ny, dmg, opts.visceral ? '#ff6a4a' : opts.heavy ? '#ffd27a' : '#f0e6d6', 18, !!opts.visceral);
  bleed(nx, ny, opts.visceral ? 6 : opts.heavy ? 8 : 5);
  // rally: strike back to regain lost health
  if (p.rally > 0 && !p.dead) {
    const g = Math.round(Math.min(p.rally, dmg * 0.5));
    if (g >= 1) {
      p.hp = Math.min(maxHp(), p.hp + g);
      p.rally = Math.max(0, p.rally - g);
      fxText(p.x, p.y, '+' + g, '#f0a040', 16);
    }
  }
  if (e.state === 'idle') aggro(e, true);
  if (e.state === 'windup' && e.atk && e.atk.shape === 'heal') {
    e.healDmg += dmg;
    if (e.healDmg >= e.maxHp * 0.06 && e.hp > 0) {
      e.state = 'recover'; e.timer = 26; e.tiles = null; e.comboLeft = 0;
      log(`${e.name}'s prayer is broken!`, '#ffe080');
      fxText(e.x + (e.size >> 1), e.y - 1, 'INTERRUPTED', '#ffe060', 26, true);
      sfx('parry');
    }
  }
  if (e.hp <= 0) { killEnemy(e); return; }
  if (!e.boss && !opts.noPoise && !opts.visceral) {
    const po = e.d.poise || 0;
    if (po === 0 || (po === 1 && opts.heavy)) {
      if (e.state === 'windup' || e.state === 'chase') {
        e.state = 'recover'; e.timer = po === 0 ? 7 : 10; e.tiles = null; e.comboLeft = 0; e.path = null;
        if (e.state === 'recover' && opts.heavy && po === 0) {
          const dx = Math.sign(e.x - p.x), dy = Math.sign(e.y - p.y);
          if (canOccupy(e, e.x + dx, e.y + dy)) { e.x += dx; e.y += dy; }
        }
      }
    }
  }
}

function killEnemy(e) {
  const s = G.save, m = G.map;
  e.dead = true; e.hp = 0; e.tiles = null; e.state = 'dead';
  const [cx, cy] = bodyCenterI(e);
  bleed(cx, cy, e.boss ? 60 : 16);
  if (e.boss) { bossDefeated(e); return; }
  const ech = Math.round(e.d.echoes * areaMult().echo * ngMult());
  s.echoes += ech;
  fxText(e.x, e.y - 1, '+' + ech, '#d8c890', 26);
  const dr = Object.assign({ vial: 0.1, bullets: 0.12, shard: 0.03 }, e.d.drop || {});
  for (const k of ['vial', 'bullets', 'shard']) {
    if (R.chance(dr[k] || 0)) {
      let spot = [e.x, e.y];
      if (G.drops.some(d => d.x === spot[0] && d.y === spot[1])) {
        spot = findFreeNear(e.x, e.y, 2, (x, y) => walkE(m, x, y) && !G.drops.some(d => d.x === x && d.y === y)) || spot;
      }
      G.drops.push({ kind: k, x: spot[0], y: spot[1] });
    }
  }
  if (G.p.x === e.x && G.p.y === e.y) pickupAt(e.x, e.y);
}

// ---------------------------------------------------------------------------
// bosses
// ---------------------------------------------------------------------------
function inRectXY(r, x, y) { return !!r && x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h; }

function checkArena() {
  const m = G.map, p = G.p;
  if (!m.arena) return;
  if (!inRectXY(m.arena, p.x, p.y) || m.tiles[p.y * m.w + p.x] === T.FOG) return;
  const boss = G.enemies.find(e => e.boss && !e.dead && e.state === 'dormant');
  if (boss) wakeBoss(boss);
}
function wakeBoss(e) {
  const m = G.map, s = G.save, p = G.p;
  if (m.fog && m.fog.length && !s.bosses[m.bossId]) {
    m.fogLocked = true;
    for (const [fx, fy] of m.fog) if (fx === p.x && fy === p.y) { const sp = findFreeNear(p.x, p.y, 3, (x, y) => playerCanStand(x, y) && m.tiles[y * m.w + x] !== T.FOG); if (sp) { p.x = sp[0]; p.y = sp[1]; } }
  }
  e.state = 'transform';
  e.timer = 22;
  e.aware = true;
  e.readyAt = G.tick + 26;
  G.bossBar = e;
  sfx('boss');
  banner(e.name, '#d8c8a8', 2800, 0.62, '');
  log(e.d.intro || e.name, '#e0c8a0');
  const fl = 'seen_' + e.id;
  if (!s.flags[fl]) { s.flags[fl] = true; s.insight++; log('You have glimpsed a Great Thing. +1 Insight', '#b8c8f0'); }
}

function bossPhase2(e) {
  const ph = e.d.phase2;
  e.phase = 2;
  log(ph.msg, '#e07050');
  sfx('roar');
  G.shake = Math.max(G.shake, 6);
  if (ph.col) e.col = ph.col;
  if (ph.speed) e.speed = ph.speed;
  if (ph.size && ph.size !== e.size) {
    const spot = findBodySpot(e, e.x - (ph.size - e.size >> 1), e.y - (ph.size - e.size >> 1), 4, ph.size, false);
    if (spot) {
      e.x = spot[0]; e.y = spot[1]; e.size = ph.size;
      if (ph.art) e.art = ph.art;
    }
  } else if (ph.art) e.art = ph.art;
  e.state = 'transform';
  e.timer = 26;
  e.tiles = null; e.comboLeft = 0; e.atk = null; e.path = null;
  const [cx, cy] = bodyCenterI(e);
  fxText(cx, cy - 1, '!!', '#ff5040', 30, true);
  bleed(cx, cy, 20);
}

function bossDefeated(e) {
  const s = G.save, m = G.map;
  s.bosses[e.id] = true;
  if (G.bossBar === e) G.bossBar = null;
  const ech = Math.round((e.d.echoes || 0) * ngMult());
  s.echoes += ech;
  s.insight += 2;
  s.shards += 2;
  G.shake = 10;
  sfx('victory');
  banner(e.id === 'moon' ? 'NIGHTMARE SLAIN' : 'PREY SLAUGHTERED', '#d8b45a', 4200, 0.95, e.name);
  log(`${e.name} has fallen. +${ech} Blood Echoes, +2 Insight, +2 Blood Stone Shards.`, '#f0d898');
  // the fog lifts
  m.fogLocked = false;
  for (const [x, y] of m.fog || []) if (m.tiles[y * m.w + x] === T.FOG) setT(m, x, y, T.FLOOR);
  for (const o of G.enemies) if (!o.dead && o !== e && o.state !== 'idle') o.tiles = null;
  // the lamp
  const lamp = (m.lamps || []).find(l => l.id === m.id + ':boss');
  if (lamp) {
    const p = G.p;
    if (p.x === lamp.x && p.y === lamp.y) {
      const sp = findFreeNear(p.x, p.y, 3, (x, y) => playerCanStand(x, y) && !(x === lamp.x && y === lamp.y));
      if (sp) { p.x = sp[0]; p.y = sp[1]; }
    }
    lamp.active = true;
    setT(m, lamp.x, lamp.y, T.LAMP);
    computeLight(m);
    log(`A lamp flickers to life nearby: ${lamp.name}.`, '#e2b04c');
  }
  const def = AREAS[m.id];
  if (def && def.unlocks) {
    const id = def.unlocks + ':start';
    if (s.litLamps.indexOf(id) < 0) s.litLamps.push(id);
    log(`A new path opens: ${AREAS[def.unlocks].name}. Travel there from the Hunter's Dream.`, '#c8b88a');
  }
  if (e.id === 'amelia') {
    s.flags.moonRed = true;
    applyTint(m);
    log('The moon turns the colour of blood. The night nears its end... return to the Hunter\'s Dream.', '#e05050');
  }
  if (e.id === 'gehrman') {
    if (s.cords >= 3) {
      log('Gehrman falls... the sky shudders. Something vast descends from the moon.', '#e05050');
      schedule(70, spawnMoonPresence);
    } else {
      schedule(90, () => endGame('honor'));
    }
  }
  if (e.id === 'moon') schedule(90, () => endGame('childhood'));
  saveGame();
}

function spawnMoonPresence() {
  const m = G.map, p = G.p;
  if (!m || m.id !== 'field' || G.save.bosses.moon) return;
  const e = makeBoss('moon', 0, 0);
  const tx = clamp(p.x - 1, 1, m.w - 4), ty = clamp(p.y - 7, 1, m.h - 4);
  const spot = findBodySpot(e, tx, ty, 12, e.size, false, 4) || findBodySpot(e, m.bossSpawn.x - 1, m.bossSpawn.y - 2, 14, e.size, false, 2);
  if (!spot) { endGame('childhood'); return; }
  e.x = spot[0]; e.y = spot[1];
  G.enemies.push(e);
  G.flash = 0.8;
  wakeBoss(e);
}

// ---------------------------------------------------------------------------
// endings
// ---------------------------------------------------------------------------
function endGame(kind) {
  const s = G.save;
  if (!ENDINGS[kind]) kind = 'sunrise';
  uiClose();
  G.mode = 'ending';
  G.bossBar = null;
  s.flags.ending = kind;
  s.flags.endings = s.flags.endings || {};
  s.flags.endings[kind] = true;
  saveGame();
  sfx('victory');
  TINT = [1, 1, 1];
  openEndingMenu(kind);
}
function openEndingMenu(kind) {
  const end = ENDINGS[kind];
  uiOpen({
    closable: false, cls: 'ending',
    build: () => {
      const s = G.save;
      const mins = Math.floor((s.playTicks || 0) * TICK_MS / 60000);
      const html = end.text.split('\n\n').map(t => `<p>${esc(t)}</p>`).join('') +
        `<p class="dim">Level ${level()} · ${esc(curWeapon().name)}${s.upgrade ? ' +' + s.upgrade : ''} · ${s.deaths} deaths · ${mins} min${s.ng ? ' · NG+' + s.ng : ''}</p>`;
      return {
        title: end.title,
        html,
        options: [
          { label: `Begin the hunt anew (NG+${(s.ng || 0) + 1})`, sub: 'Keep your strength, weapon, echoes and insight. The beasts grow stronger.', action: () => startNGPlus() },
          { label: 'Return to title', action: () => { G.save.flags.ending = kind; saveGame(); toTitle(); } },
        ],
      };
    },
  });
}

// ---------------------------------------------------------------------------
// lamps, travel and the Hunter's Dream
// ---------------------------------------------------------------------------
function useLamp(lamp) {
  const s = G.save, m = G.map;
  if (lamp.id !== 'dream' && m.id !== 'dream' && s.litLamps.indexOf(lamp.id) < 0) {
    s.litLamps.push(lamp.id);
    banner('LAMP LIT', '#e2b04c', 2200, 0.7, lamp.name);
    log(`You light the lamp: ${lamp.name}.`, '#e2b04c');
  }
  sfx('lamp');
  if (lamp.id === 'dream' || m.id === 'dream') { openTravelMenu("Hunter's Dream"); return; }
  s.lastLamp = { area: m.id, id: lamp.id };
  saveGame();
  uiOpen({
    build: () => ({
      title: lamp.name,
      html: '<p>The lamp\'s warm glow holds the night at bay. From here, the Dream is but a breath away.</p>' +
        '<p class="dim">Resting carries you to the Hunter\'s Dream. The beasts of Yharnam will return.</p>',
      options: [
        { label: 'Travel to the Hunter\'s Dream', sub: 'Rest, level up, upgrade and resupply', action: () => { uiClose(); travelToLamp('dream'); } },
        { label: 'Leave', action: () => uiClose() },
      ],
    }),
  });
}

function travelToLamp(id) {
  const s = G.save, p = G.p;
  const area = id === 'dream' ? 'dream' : id.split(':')[0];
  if (area !== 'dream' && !AREAS[area]) return;
  if (area !== 'dream') s.lastLamp = { area, id };
  p.hp = maxHp(); p.rally = 0; p.st = maxSt(); p.stDelay = 0; p.dead = false;
  loadArea(area, id);
  G.mode = 'play';
  const m = G.map;
  sfx('lamp');
  banner(m.name, '#d8cfb8', 2600, 0.7, area === 'dream' ? '' : (LAMP_NAMES[id] || ''));
  if (area === 'dream') log('You awaken in the Hunter\'s Dream. Petals drift on a timeless wind.', '#c8c0d8');
  saveGame();
}

function lampListOptions() {
  const s = G.save, here = G.map ? G.map.id : '';
  const opts = [];
  for (const area of AREA_ORDER) {
    for (const kind of ['start', 'boss']) {
      const id = `${area}:${kind}`;
      if (s.litLamps.indexOf(id) < 0) continue;
      opts.push({
        label: LAMP_NAMES[id], sub: AREAS[area].name + (s.bosses[AREAS[area].boss] ? ' · cleansed' : ''),
        action: () => { uiClose(); travelToLamp(id); },
      });
    }
  }
  if (here !== 'dream') opts.push({ label: 'The Hunter\'s Dream', action: () => { uiClose(); travelToLamp('dream'); } });
  return opts;
}
function openTravelMenu(title) {
  uiOpen({
    build: () => ({
      title: title || 'Travel',
      html: '<p>The headstones bear the names of every lamp you have lit. Touch one, and wake there.</p>',
      options: lampListOptions().concat([{ label: 'Leave', action: () => uiClose() }]),
    }),
  });
}

const DOLL_LINES = [
  'Hello, good hunter. I am a Doll, here in this dream to look after you.',
  'Honourable hunter, pursue the echoes of blood, and I will channel them into your strength.',
  'Hunt your beasts, good hunter, and come back safely.',
  'May you find your worth in the waking world.',
];
function statPreview(k) {
  const s = G.save.stats, nx = Object.assign({}, s);
  nx[k]++;
  const f = curWeapon().forms[0];
  switch (k) {
    case 'vit': return `HP ${maxHp()} → ${60 + nx.vit * 8}`;
    case 'end': return `Stamina ${maxSt()} → ${60 + nx.end * 4}`;
    case 'str': return `Attack ${Math.round(f.dmg * weaponMult())} → ${Math.round(f.dmg * weaponMult(nx))}`;
    case 'skl': return `Attack ${Math.round(f.dmg * weaponMult())} → ${Math.round(f.dmg * weaponMult(nx))} · Visceral x${visceralMult().toFixed(1)} → x${visceralMult(nx).toFixed(1)}`;
    case 'blt': return `Gun ${Math.round(gunDmg())} → ${Math.round(gunDmg(nx))}`;
    default: return '';
  }
}
function levelUp(k) {
  const s = G.save, cost = levelCost();
  if (s.echoes < cost || !(k in s.stats) || s.stats[k] >= 99) return false;
  s.echoes -= cost;
  s.stats[k]++;
  if (G.p) {
    if (k === 'vit') G.p.hp = Math.min(maxHp(), G.p.hp + 8);
    if (k === 'end') G.p.st = maxSt();
  }
  sfx('pickup');
  log(`The Doll channels your echoes. ${STAT_DEFS.find(d => d.k === k).name} rises to ${s.stats[k]}. (Level ${level()})`, '#ecdfca');
  saveGame();
  return true;
}
function openDollMenu() {
  const line = R.pick(DOLL_LINES);
  uiOpen({
    build: () => {
      const s = G.save, cost = levelCost();
      const html = `<p class="say">"${esc(line)}"</p>` +
        `<p>Level <b>${level()}</b> · Blood Echoes <b>${Math.floor(s.echoes)}</b> · Next level costs <b>${cost}</b></p>`;
      const options = STAT_DEFS.map(d => ({
        label: `${d.name}  ${s.stats[d.k]} → ${s.stats[d.k] + 1}`,
        sub: statPreview(d.k),
        disabled: s.echoes < cost || s.stats[d.k] >= 99,
        action: () => levelUp(d.k),
      }));
      options.push({ label: 'Leave', action: () => uiClose() });
      return { title: 'The Doll', html, options };
    },
  });
}

function buy(costEchoes, costInsight, fn) {
  const s = G.save;
  if (s.echoes < costEchoes || s.insight < costInsight) return false;
  s.echoes -= costEchoes;
  s.insight -= costInsight;
  fn(s);
  sfx('pickup');
  saveGame();
  return true;
}
function openShopMenu() {
  uiOpen({
    build: () => {
      const s = G.save;
      const vialRoom = MAX_VIALS - s.vials;
      const html = '<p class="say">The Bath Messengers gurgle and hold out their tiny hands. "...Ahh, a hunter... buy, buy..."</p>' +
        `<p>Blood Echoes <b>${Math.floor(s.echoes)}</b> · Insight <b>${s.insight}</b> · Vials <b>${s.vials}/${MAX_VIALS}</b> · Shards <b>${s.shards}</b></p>`;
      return {
        title: 'Bath Messengers',
        html,
        options: [
          { label: 'Blood Vial', sub: '60 Blood Echoes', disabled: s.echoes < 60 || vialRoom < 1, action: () => buy(60, 0, q => { q.vials++; }) },
          { label: 'Blood Vial x5', sub: '280 Blood Echoes', disabled: s.echoes < 280 || vialRoom < 5, action: () => buy(280, 0, q => { q.vials += 5; }) },
          { label: 'Blood Stone Shard', sub: '300 Blood Echoes', disabled: s.echoes < 300, action: () => buy(300, 0, q => { q.shards++; }) },
          { label: 'Blood Vial x3', sub: '1 Insight', disabled: s.insight < 1 || vialRoom < 3, action: () => buy(0, 1, q => { q.vials += 3; }) },
          { label: 'Blood Stone Shard', sub: '2 Insight', disabled: s.insight < 2, action: () => buy(0, 2, q => { q.shards++; }) },
          { label: 'Leave', action: () => uiClose() },
        ],
      };
    },
  });
}

function openWorkbenchMenu() {
  uiOpen({
    build: () => {
      const s = G.save, w = curWeapon(), up = s.upgrade, cost = up + 1;
      const cur = w.forms.map(f => Math.round(f.dmg * weaponMult())).join(' / ');
      const nxt = w.forms.map(f => Math.round(f.dmg * weaponMult(null, up + 1))).join(' / ');
      const html = `<p>The workbench. Blood Stone Shards fuse with steel, and your weapon grows keener.</p>` +
        `<p><b>${esc(w.name)}${up ? ' +' + up : ''}</b> · Attack ${cur} · Shards <b>${s.shards}</b></p>`;
      const options = [];
      if (up >= 10) options.push({ label: `${w.name} +10`, sub: 'Fully reinforced', disabled: true, action: () => {} });
      else {
        options.push({
          label: `Reinforce to +${up + 1}`, sub: `${cost} Blood Stone Shard${cost > 1 ? 's' : ''} · Attack ${cur} → ${nxt}`,
          disabled: s.shards < cost,
          action: () => {
            if (s.shards < cost || s.upgrade >= 10) return;
            s.shards -= cost; s.upgrade++;
            sfx('trick');
            log(`${w.name} reinforced to +${s.upgrade}.`, '#d8c8a8');
            saveGame();
          },
        });
      }
      options.push({ label: 'Leave', action: () => uiClose() });
      return { title: 'Workbench', html, options };
    },
  });
}

function openGehrmanMenu() {
  const s = G.save;
  if (!s.bosses.amelia) {
    const i = (s.flags.gLine || 0) % GEHRMAN_LINES.length;
    s.flags.gLine = i + 1;
    let hint = '';
    if (!s.bosses.cleric) hint = 'The Cleric Beast prowls the Great Bridge at the end of Central Yharnam.';
    else if (!s.bosses.gascoigne) hint = 'Father Gascoigne waits in the Tomb of Oedon. His daughter waits for him, too.';
    else hint = 'The Healing Church\'s Vicar, Amelia, prays in the Grand Cathedral.';
    uiOpen({
      build: () => ({
        title: 'Gehrman',
        html: `<p class="say">${esc(GEHRMAN_LINES[i])}</p><p class="dim">${esc(hint)}</p>`,
        options: [{ label: 'Leave', action: () => uiClose() }],
      }),
    });
    return;
  }
  const fight = () => { uiClose(); s.flags.refused = true; goToField(); };
  if (!s.flags.refused) {
    uiOpen({
      closable: true,
      build: () => ({
        title: 'Gehrman, the First Hunter',
        html: '<p class="say">"Good hunter, you\'ve done well. The night is near its end. Now, I will show you mercy."</p>' +
          '<p class="say">"You will die, forget the dream, and awake under the morning sun. You will be freed... from this terrible hunter\'s dream..."</p>' +
          (s.cords >= 3 ? '<p class="dim">The three thirds of umbilical cord stir within you...</p>' : ''),
        options: [
          { label: 'Submit your life', sub: 'Wake under the morning sun', action: () => { uiClose(); endGame('sunrise'); } },
          { label: 'Refuse', sub: '"Ahh, you\'ve lost your mind..."', action: () => { log('Gehrman: "Ahh, you\'ve gone and lost your mind..."', '#9aa0b8'); fight(); } },
          { label: 'Not yet', action: () => uiClose() },
        ],
      }),
    });
  } else {
    uiOpen({
      build: () => ({
        title: 'Gehrman, the First Hunter',
        html: '<p class="say">"Tonight, Gehrman joins the hunt..." His chair is empty; his scythe waits among the flowers beyond.</p>',
        options: [
          { label: s.bosses.gehrman ? 'Return to the Flower Field' : 'Go to the Flower Field', sub: s.bosses.gehrman ? 'The Moon Presence awaits' : 'Face the First Hunter', action: fight },
          { label: 'Leave', action: () => uiClose() },
        ],
      }),
    });
  }
}
function goToField() {
  const p = G.p;
  p.hp = maxHp(); p.rally = 0; p.st = maxSt();
  loadArea('field', null);
  G.mode = 'play';
  banner('The Flower Field', '#e8e4dc', 2800, 0.7, 'Beneath the moon');
  log('White flowers sway beneath an enormous moon. Gehrman awaits, scythe in hand.', '#d8d4e8');
}

function openWindowMenu() {
  const s = G.save;
  let text, opts = [{ label: 'Leave', action: () => uiClose() }];
  if (s.bosses.gascoigne) {
    text = 'The window is dark. Somewhere inside, a little girl is quietly crying.';
  } else if (!s.flags.musicBox) {
    text = 'A small voice behind the lit window: "Are you a hunter? Please, my father never came back from the hunt... My mum went to find him. ' +
      'Take this music box - Father always remembered us when he heard it. Please..."';
    opts = [{
      label: 'Take the Tiny Music Box', action: () => {
        s.flags.musicBox = true;
        log('Obtained: Tiny Music Box. Play it with [M].', '#e8d0f0');
        sfx('music');
        saveGame();
        uiClose();
      },
    }];
  } else {
    text = '"Did you find my father? He\'ll know the tune... please play it for him."';
  }
  uiOpen({
    build: () => ({ title: 'A Lit Window', html: `<p class="say">${esc(text)}</p>`, options: opts }),
  });
}

function openNoteMenu(note) {
  uiOpen({
    build: () => ({
      title: 'A Message',
      html: `<p class="say">${esc(note.text || '...')}</p>`,
      options: [{ label: 'Close', action: () => uiClose() }],
    }),
  });
}
