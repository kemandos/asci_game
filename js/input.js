'use strict';
// ---------------------------------------------------------------------------
// Gamepad support (standard mapping, Xbox / PlayStation layout).
// Polled once per animation frame from main.js. Movement is fed into G.keys
// as synthetic WASD codes so game.js's heldDir() works unchanged; buttons are
// edge-triggered into queueAction() / the UI.
// ---------------------------------------------------------------------------

const PAD = {
  prev: [],              // previous pressed state per button index (merged over pads)
  codes: new Set(),      // movement codes currently injected into G.keys by the pad
  kb: new Set(),         // codes physically held on the keyboard (from main.js)
  menuDir: 0, menuAt: 0,
  lastHp: null, lastShake: 0,
  names: new Map(),      // index -> id of connected pads
};
const PAD_DEAD = 0.35;
// button index -> game action
const PAD_ACTIONS = { 5: 'light', 7: 'heavy', 6: 'gun', 4: 'trick', 1: 'dodge', 2: 'heal', 0: 'interact', 3: 'bloodbullet', 8: 'music' };

function padInit() {
  try {
    window.addEventListener('gamepadconnected', e => {
      PAD.names.set(e.gamepad.index, e.gamepad.id);
      padLog(`Controller connected: ${e.gamepad.id}`, '#b8c8f0');
    });
    window.addEventListener('gamepaddisconnected', e => {
      PAD.names.delete(e.gamepad.index);
      padLog('Controller disconnected.', '#8a8a9a');
      padSetMove(0, 0);
      PAD.prev = [];
    });
  } catch (e) { /* no gamepad API */ }
}

function padLog(text, col) {
  try { if (typeof log === 'function' && typeof G !== 'undefined') log(text, col); } catch (e) { /* ignore */ }
}

// Called by main.js keyboard handlers so the pad never releases a key the
// keyboard is still holding.
function padNoteKey(code, down) {
  if (down) PAD.kb.add(code); else PAD.kb.delete(code);
}
function padClearKeys() { PAD.kb.clear(); PAD.codes.clear(); }

function padSetMove(dx, dy) {
  if (typeof G === 'undefined' || !G.keys) return;
  const want = new Set();
  if (dx < 0) want.add('KeyA'); else if (dx > 0) want.add('KeyD');
  if (dy < 0) want.add('KeyW'); else if (dy > 0) want.add('KeyS');
  for (const c of PAD.codes) if (!want.has(c) && !PAD.kb.has(c)) G.keys.delete(c);
  for (const c of want) G.keys.add(c);
  PAD.codes = want;
}

function padGetAll() {
  try {
    if (!navigator.getGamepads) return [];
    return Array.from(navigator.getGamepads() || []).filter(p => p && p.connected !== false);
  } catch (e) { return []; }
}

function padPoll(now) {
  const pads = padGetAll();
  if (!pads.length) {
    if (PAD.codes.size) padSetMove(0, 0);
    PAD.prev = [];
    return;
  }
  // merge every connected pad
  const pressed = [];
  let ax = 0, ay = 0;
  for (const gp of pads) {
    if (!PAD.names.has(gp.index)) {
      PAD.names.set(gp.index, gp.id);
      padLog(`Controller connected: ${gp.id}`, '#b8c8f0');
    }
    (gp.buttons || []).forEach((b, i) => {
      const on = typeof b === 'object' ? (b.pressed || b.value > 0.5) : b > 0.5;
      if (on) pressed[i] = true;
    });
    const x = gp.axes[0] || 0, y = gp.axes[1] || 0;
    if (Math.hypot(x, y) > Math.hypot(ax, ay)) { ax = x; ay = y; }
  }
  const edge = i => pressed[i] && !PAD.prev[i];
  if (pressed.some(Boolean)) { try { if (typeof Sound !== 'undefined') Sound.init(); } catch (e) { /* ignore */ } }

  // direction: d-pad wins, else 8-way stick
  let dx = 0, dy = 0;
  if (pressed[12]) dy = -1; else if (pressed[13]) dy = 1;
  if (pressed[14]) dx = -1; else if (pressed[15]) dx = 1;
  if (!dx && !dy && Math.hypot(ax, ay) > PAD_DEAD) {
    const d = DIRS[dirIndex(ax, ay)];
    dx = d[0]; dy = d[1];
  }

  const uiOpen = typeof UI !== 'undefined' && UI.isOpen();
  const g = typeof G !== 'undefined' ? G : null;
  if (uiOpen) {
    padSetMove(0, 0);
    const v = dy;
    if (v !== 0) {
      if (v !== PAD.menuDir) { UI.key(v < 0 ? 'ArrowUp' : 'ArrowDown'); PAD.menuAt = now + 360; }
      else if (now >= PAD.menuAt) { UI.key(v < 0 ? 'ArrowUp' : 'ArrowDown'); PAD.menuAt = now + 120; }
    }
    PAD.menuDir = v;
    if (edge(0)) UI.key('Enter');
    else if (edge(1)) UI.key('Escape');
    else if (edge(9)) UI.key(g && g.mode === 'menu' ? 'Escape' : 'Enter');
  } else {
    PAD.menuDir = 0;
    if (g && g.mode === 'play') {
      padSetMove(dx, dy);
      if (edge(9)) { if (typeof openPause === 'function') openPause(); }
      else {
        for (const k in PAD_ACTIONS) {
          if (edge(+k) && typeof queueAction === 'function') queueAction(PAD_ACTIONS[k]);
        }
      }
    } else padSetMove(0, 0);
  }
  PAD.prev = pressed;
  padRumbleCheck(pads, g);
}

function padRumbleCheck(pads, g) {
  if (!g || !g.p || g.mode !== 'play' && g.mode !== 'dead') { PAD.lastHp = null; return; }
  const hp = g.p.hp, sh = +g.shake || 0;
  let strong = 0, weak = 0, dur = 0;
  if (PAD.lastHp !== null && hp < PAD.lastHp - 0.5) { strong = 0.75; weak = 0.4; dur = 140; }
  else if (sh > PAD.lastShake + 2.5) { strong = 0.35; weak = 0.6; dur = 110; }
  PAD.lastHp = hp; PAD.lastShake = sh;
  if (!dur) return;
  for (const gp of pads) {
    try {
      const va = gp.vibrationActuator;
      if (va && va.playEffect) va.playEffect('dual-rumble', { startDelay: 0, duration: dur, strongMagnitude: strong, weakMagnitude: weak }).catch(() => {});
    } catch (e) { /* unsupported */ }
  }
}
