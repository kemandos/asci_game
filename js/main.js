'use strict';
// ---------------------------------------------------------------------------
// Boot, fixed-step game loop, keyboard routing.
// ---------------------------------------------------------------------------

const MAIN_ACTIONS = {
  KeyJ: 'light', KeyZ: 'light',
  KeyK: 'heavy', KeyX: 'heavy',
  KeyL: 'gun', KeyC: 'gun',
  Space: 'dodge', ShiftLeft: 'dodge', ShiftRight: 'dodge',
  KeyQ: 'trick', KeyV: 'trick',
  KeyR: 'heal',
  KeyE: 'interact', Enter: 'interact', NumpadEnter: 'interact',
  KeyB: 'bloodbullet',
  KeyM: 'music',
};
const MAIN_MOVE = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Numpad1', 'Numpad2', 'Numpad3', 'Numpad4', 'Numpad6', 'Numpad7', 'Numpad8', 'Numpad9', 'Home', 'End', 'PageUp', 'PageDown']);
const MAIN = { acc: 0, last: 0, errs: 0, gestured: false };

function mainGesture() {
  if (MAIN.gestured) return;
  MAIN.gestured = true;
  try { if (typeof Sound !== 'undefined') Sound.init(); } catch (e) { /* ignore */ }
}

function mainErr(e) {
  if (MAIN.errs++ < 12) console.error(e);
}

function mainKeyDown(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const code = e.code;
  mainGesture();
  const gameKey = MAIN_MOVE.has(code) || code in MAIN_ACTIONS || code === 'Escape' || code === 'Tab' ||
    code === 'KeyH' || code === 'KeyN' || code === 'KeyT' || code === 'Slash' || code === 'Backspace' || /^Digit\d$/.test(code);
  if (gameKey) e.preventDefault();

  if (typeof UI !== 'undefined' && UI.isOpen()) {
    UI.key(code);
    return;
  }
  if (typeof G === 'undefined') return;
  if (code === 'KeyN' && !e.repeat) {
    try {
      const muted = Sound.toggle();
      if (typeof log === 'function' && G.map) log(muted ? 'Sound muted.' : 'Sound on.', '#8a8a9a');
    } catch (err) { /* ignore */ }
    return;
  }
  if (G.mode !== 'play') return;
  if (MAIN_MOVE.has(code)) {
    G.keys.add(code);
    padNoteKey(code, true);
    return;
  }
  if (e.repeat) return;
  if (code === 'Escape') { openPause(); return; }
  if (code === 'KeyT') { if (typeof isoToggleView === 'function') isoToggleView(); return; }
  if (code === 'KeyH' || e.key === '?') { openHelp(null); return; }
  const act = MAIN_ACTIONS[code];
  if (act) {
    try { queueAction(act); } catch (err) { mainErr(err); }
  }
}

function mainKeyUp(e) {
  if (typeof G === 'undefined' || !G.keys) return;
  G.keys.delete(e.code);
  padNoteKey(e.code, false);
}

function mainLoop(now) {
  requestAnimationFrame(mainLoop);
  let dt = now - (MAIN.last || now);
  MAIN.last = now;
  if (dt > 250) dt = 250;
  try { padPoll(now); } catch (e) { mainErr(e); }
  MAIN.acc += dt;
  let n = 0;
  while (MAIN.acc >= TICK_MS && n < 5) {
    try { update(); } catch (e) { mainErr(e); }
    MAIN.acc -= TICK_MS;
    n++;
  }
  if (n >= 5 && MAIN.acc >= TICK_MS) MAIN.acc %= TICK_MS;
  try { renderFrame(now); } catch (e) { mainErr(e); }
}

function mainBoot() {
  initScreen();
  UI.init();
  padInit();
  window.addEventListener('keydown', mainKeyDown);
  window.addEventListener('keyup', mainKeyUp);
  window.addEventListener('mousedown', mainGesture);
  window.addEventListener('touchstart', mainGesture, { passive: true });
  window.addEventListener('blur', () => {
    if (typeof G !== 'undefined' && G.keys) G.keys.clear();
    padClearKeys();
  });
  openTitle();
  requestAnimationFrame(t => { MAIN.last = t; requestAnimationFrame(mainLoop); });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mainBoot);
else mainBoot();
