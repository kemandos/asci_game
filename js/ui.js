'use strict';
// ---------------------------------------------------------------------------
// HTML overlay menus (title, weapon select, pause, help, and every in-game
// menu built by game.js through UI.open). Keyboard, mouse and gamepad.
// ---------------------------------------------------------------------------

const UI_STATE = { el: null, cur: null, opts: [], sel: 0 };

function uiEl() {
  if (!UI_STATE.el) UI_STATE.el = document.getElementById('overlay');
  return UI_STATE.el;
}

function uiSound(name) {
  try { if (typeof Sound !== 'undefined' && Sound.play) Sound.play(name); } catch (e) { /* silent */ }
}

const UI = {
  init() {
    const el = uiEl();
    if (!el || el._uiBound) return;
    el._uiBound = true;
    el.addEventListener('mousemove', ev => {
      const li = ev.target.closest && ev.target.closest('li[data-i]');
      if (!li) return;
      const i = +li.dataset.i;
      if (i !== UI_STATE.sel && !UI_STATE.opts[i].disabled) uiSelect(i);
    });
    el.addEventListener('click', ev => {
      const li = ev.target.closest && ev.target.closest('li[data-i]');
      if (li) { uiChoose(+li.dataset.i); return; }
    });
  },

  open(spec) {
    UI.init();
    UI_STATE.cur = { spec };
    UI_STATE.sel = 0;
    if (typeof G !== 'undefined' && G.mode === 'play') G.mode = 'menu';
    UI.render();
  },

  close() {
    const cur = UI_STATE.cur;
    if (!cur) return;
    UI_STATE.cur = null;
    UI_STATE.opts = [];
    const el = uiEl();
    if (el) { el.className = ''; el.innerHTML = ''; }
    if (typeof G !== 'undefined' && G.mode === 'menu') G.mode = 'play';
    if (cur.spec.onClose) {
      try { cur.spec.onClose(); } catch (e) { console.error(e); }
    }
  },

  isOpen() { return !!UI_STATE.cur; },

  // Returns true when the key was consumed by the menu.
  key(code) {
    const cur = UI_STATE.cur;
    if (!cur) return false;
    switch (code) {
      case 'ArrowUp': case 'KeyW': case 'Numpad8':
        uiMove(-1); return true;
      case 'ArrowDown': case 'KeyS': case 'Numpad2': case 'Tab':
        uiMove(1); return true;
      case 'Enter': case 'NumpadEnter': case 'Space': case 'KeyE': case 'KeyJ':
        uiChoose(UI_STATE.sel); return true;
      case 'Escape': case 'Backspace':
        uiBack(); return true;
      default:
        if (/^Digit[1-9]$/.test(code)) {
          const i = +code.slice(5) - 1;
          if (i < UI_STATE.opts.length) { uiSelect(i); uiChoose(i); }
          return true;
        }
        return true; // swallow everything else while a menu is up
    }
  },

  render() {
    const cur = UI_STATE.cur, el = uiEl();
    if (!cur || !el) return;
    let d;
    try { d = cur.spec.build() || {}; } catch (e) { console.error(e); d = { title: 'Error', html: esc(e.message), options: [{ label: 'Close', action: () => UI.close() }] }; }
    const opts = d.options || [];
    UI_STATE.opts = opts;
    let sel = clamp(UI_STATE.sel, 0, Math.max(0, opts.length - 1));
    if (opts.length && opts[sel].disabled) {
      const n = opts.findIndex(o => !o.disabled);
      sel = n >= 0 ? n : sel;
    }
    UI_STATE.sel = sel;
    const closable = cur.spec.closable !== false;
    // menus also get a class from their title (e.g. "t-the-doll") so styles can follow the game's places
    const slug = d.title ? ' t-' + String(d.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : '';
    const cls = (cur.spec.cls || '') + slug;
    let h = `<div class="panel ${esc(cls)}">`;
    if (d.title) h += `<div class="ptitle">${esc(d.title)}</div><div class="orn">⸻ † ⸻</div>`;
    if (d.html) h += `<div class="pbody">${d.html}</div>`;
    if (opts.length) {
      h += '<ul class="opts">';
      opts.forEach((o, i) => {
        h += `<li data-i="${i}" class="${i === sel ? 'sel' : ''}${o.disabled ? ' dis' : ''}">` +
          `<span class="mk">${i === sel ? '▸' : ''}</span><span class="lb">${esc(o.label)}</span>` +
          (o.sub ? `<span class="sub">${esc(o.sub)}</span>` : '') + '</li>';
      });
      h += '</ul>';
    }
    const back = cur.spec.back || closable;
    h += `<div class="phint">↑↓ choose · Enter select${back ? ' · Esc back' : ''}</div></div>`;
    el.className = 'show ' + cls;
    el.innerHTML = h;
  },
};

function uiSelect(i) {
  const el = uiEl();
  UI_STATE.sel = i;
  if (!el) return;
  el.querySelectorAll('li[data-i]').forEach(li => {
    const on = +li.dataset.i === i;
    li.classList.toggle('sel', on);
    const mk = li.querySelector('.mk');
    if (mk) mk.textContent = on ? '▸' : '';
  });
}

function uiMove(dir) {
  const opts = UI_STATE.opts;
  if (!opts.length) return;
  let i = UI_STATE.sel;
  for (let n = 0; n < opts.length; n++) {
    i = (i + dir + opts.length) % opts.length;
    if (!opts[i].disabled) break;
  }
  if (i !== UI_STATE.sel) uiSound('menu');
  uiSelect(i);
  const li = uiEl() && uiEl().querySelector(`li[data-i="${i}"]`);
  if (li && li.scrollIntoView) li.scrollIntoView({ block: 'nearest' });
}

function uiChoose(i) {
  const cur = UI_STATE.cur;
  const o = UI_STATE.opts[i];
  if (!cur || !o) return;
  if (o.disabled) return;
  uiSound('menu');
  UI_STATE.sel = i;
  try {
    if (o.action) o.action();
    else UI.close();
  } catch (e) { console.error(e); }
  // menus rebuild live after every action (unless the action closed/replaced it)
  if (UI_STATE.cur === cur) UI.render();
}

function uiBack() {
  const cur = UI_STATE.cur;
  if (!cur) return;
  if (cur.spec.back) { uiSound('menu'); cur.spec.back(); return; }
  if (cur.spec.closable !== false) { uiSound('menu'); UI.close(); }
}

// --- block-letter logo -------------------------------------------------------------------------
const UI_FONT5 = {
  B: ['████ ', '█   █', '████ ', '█   █', '████ '],
  L: ['█    ', '█    ', '█    ', '█    ', '█████'],
  O: [' ███ ', '█   █', '█   █', '█   █', ' ███ '],
  D: ['████ ', '█   █', '█   █', '█   █', '████ '],
  R: ['████ ', '█   █', '████ ', '█  █ ', '█   █'],
  N: ['█   █', '██  █', '█ █ █', '█  ██', '█   █'],
  E: ['█████', '█    ', '████ ', '█    ', '█████'],
  A: [' ███ ', '█   █', '█████', '█   █', '█   █'],
  S: [' ████', '█    ', ' ███ ', '    █', '████ '],
  C: [' ████', '█    ', '█    ', '█    ', ' ████'],
  I: ['█████', '  █  ', '  █  ', '  █  ', '█████'],
  ' ': ['   ', '   ', '   ', '   ', '   '],
};
function uiBlockText(text) {
  const rows = ['', '', '', '', ''];
  for (const ch of text.toUpperCase()) {
    const g = UI_FONT5[ch] || UI_FONT5[' '];
    for (let r = 0; r < 5; r++) rows[r] += g[r] + ' ';
  }
  return rows.map(r => r.replace(/\s+$/, '')).join('\n');
}
function uiLogo() {
  return `<pre class="logo">${uiBlockText('BLOODBORNE')}</pre><div class="logosub">A S C I I</div>`;
}

// --- built-in screens ----------------------------------------------------------------------------
function uiSaveSummary() {
  try {
    const key = typeof SAVE_KEY !== 'undefined' ? SAVE_KEY : 'bloodborne-ascii-save-v1';
    const raw = localStorage.getItem(key);
    if (!raw) return '';
    const s = JSON.parse(raw);
    const st = s.stats || {};
    const lv = (st.vit || 0) + (st.end || 0) + (st.str || 0) + (st.skl || 0) + (st.blt || 0) - 40;
    const area = s.lastLamp && s.lastLamp.id && typeof LAMP_NAMES !== 'undefined' ? (LAMP_NAMES[s.lastLamp.id] || "Hunter's Dream") : 'Iosefka\'s Clinic';
    const w = typeof WEAPONS !== 'undefined' && WEAPONS[s.weapon] ? WEAPONS[s.weapon].name : '';
    return `Lv ${lv} · ${w}${s.ng ? ` · NG+${s.ng}` : ''} · ${area}`;
  } catch (e) { return ''; }
}

function uiSoundLabel() {
  const muted = typeof Sound !== 'undefined' && Sound.muted;
  return `Sound: ${muted ? 'off' : 'on'}`;
}
function uiToggleSound() {
  try { if (typeof Sound !== 'undefined') { Sound.init && Sound.init(); Sound.toggle(); } } catch (e) { /* ignore */ }
}

function openTitle() {
  UI.open({
    closable: false, cls: 'title',
    build: () => {
      const has = typeof hasSave === 'function' && hasSave();
      return {
        html: uiLogo() + '<div class="tagline">"Fear the old blood."</div>',
        options: [
          { label: 'Continue the Hunt', sub: has ? uiSaveSummary() : 'No hunt in progress', disabled: !has,
            action: () => { UI.close(); continueGame(); } },
          { label: 'New Hunt', sub: 'Awaken in Iosefka\'s clinic', action: () => {
            if (has) uiConfirm('Begin anew?', 'Your current hunt — its echoes, lamps and slain beasts — will be lost to the night.', 'Forsake it', () => openWeaponSelect(), openTitle);
            else openWeaponSelect();
          } },
          { label: 'Hunter\'s Notes', sub: 'Controls & the ways of the hunt', action: () => openHelp(openTitle) },
          { label: uiSoundLabel(), sub: 'Toggle with N at any time', action: () => uiToggleSound() },
        ],
      };
    },
  });
}

function uiConfirm(title, text, yes, onYes, onNo) {
  UI.open({
    closable: false, cls: 'confirm', back: onNo,
    build: () => ({
      title, html: `<p>${esc(text)}</p>`,
      options: [
        { label: 'Return', action: onNo },
        { label: yes, action: onYes },
      ],
    }),
  });
}

function openWeaponSelect() {
  UI.open({
    closable: false, cls: 'weapons', back: openTitle,
    build: () => {
      const ids = Object.keys(WEAPONS);
      return {
        title: 'Choose Your Trick Weapon',
        html: '<p class="flavor">"Oh, you\'ve found yourself a hunter... Then choose. Every hunter needs a weapon - and the Hunter Pistol for the brave."</p>',
        options: ids.map(id => {
          const w = WEAPONS[id];
          return {
            label: w.name,
            sub: `${w.blurb}  [${w.forms[0].name} / ${w.forms[1].name}]`,
            action: () => openIntro(id),
          };
        }).concat([{ label: 'Back', action: openTitle }]),
      };
    },
  });
}

function openIntro(weaponId) {
  UI.open({
    closable: false, cls: 'intro', back: openWeaponSelect,
    build: () => ({
      title: 'Yharnam',
      html: INTRO_TEXT.map((t, i) => `<p class="${i === 1 ? 'voice' : ''}">${esc(t)}</p>`).join(''),
      options: [
        { label: 'Begin the Hunt', action: () => { UI.close(); newGame(weaponId); } },
        { label: 'Back', action: openWeaponSelect },
      ],
    }),
  });
}

function uiStatSheet() {
  try {
    const s = G.save || {}, st = s.stats || {};
    const w = WEAPONS[s.weapon];
    const row = (k, v) => `<tr><td>${k}</td><td>${v}</td></tr>`;
    const area = G.map ? (G.map.name || '') : '';
    const mins = Math.floor((s.playTicks || 0) * TICK_MS / 60000);
    return '<table class="sheet">' +
      row('Location', esc(area)) +
      row('Level', typeof level === 'function' ? level() : '-') +
      row('Blood Echoes', Math.floor(s.echoes || 0)) +
      row('Insight', s.insight || 0) +
      row('Vitality / Endurance', `${st.vit} / ${st.end}`) +
      row('Strength / Skill', `${st.str} / ${st.skl}`) +
      row('Bloodtinge', st.blt) +
      row('Weapon', w ? esc(w.name) + (s.upgrade ? ' +' + s.upgrade : '') : '-') +
      row('Deaths', s.deaths || 0) +
      row('Time', `${mins} min`) +
      '</table>';
  } catch (e) { return ''; }
}

function openPause() {
  UI.open({
    closable: true, cls: 'pause',
    build: () => ({
      title: 'The Hunt Pauses',
      html: uiStatSheet(),
      options: [
        { label: 'Resume', action: () => UI.close() },
        { label: 'Hunter\'s Notes', sub: 'Controls & tips', action: () => openHelp(openPause) },
        { label: uiSoundLabel(), action: () => uiToggleSound() },
        { label: 'Save & Return to Title', sub: 'Progress is also saved at every lamp', action: () => {
          try { if (typeof saveGame === 'function') saveGame(); } catch (e) { console.error(e); }
          UI.close();
          try { if (typeof toTitle === 'function') toTitle(); } catch (e) { console.error(e); }
          if (!UI.isOpen()) openTitle();
        } },
      ],
    }),
  });
}

const UI_HELP_HTML = `
<div class="cols">
<table class="keys">
<tr><th colspan="3">Keyboard</th></tr>
<tr><td>Move</td><td>WASD · Arrows · Numpad (diagonals)</td></tr>
<tr><td>Light attack</td><td>J · Z</td></tr>
<tr><td>Heavy attack</td><td>K · X</td></tr>
<tr><td>Fire gun / parry</td><td>L · C</td></tr>
<tr><td>Quickstep dodge</td><td>Space · Shift</td></tr>
<tr><td>Transform weapon</td><td>Q · V</td></tr>
<tr><td>Blood Vial</td><td>R</td></tr>
<tr><td>Interact / rest</td><td>E · Enter</td></tr>
<tr><td>Blood Bullets</td><td>B</td></tr>
<tr><td>Music Box</td><td>M</td></tr>
<tr><td>Pause · Help · Sound</td><td>Esc · H · N</td></tr>
</table>
<table class="keys">
<tr><th colspan="3">Controller</th></tr>
<tr><td>Move</td><td>Left stick · D-pad</td></tr>
<tr><td>Light attack</td><td>R1 / RB</td></tr>
<tr><td>Heavy attack</td><td>R2 / RT</td></tr>
<tr><td>Fire gun / parry</td><td>L2 / LT</td></tr>
<tr><td>Transform weapon</td><td>L1 / LB</td></tr>
<tr><td>Quickstep dodge</td><td>Circle / B</td></tr>
<tr><td>Blood Vial</td><td>Square / X</td></tr>
<tr><td>Interact / confirm</td><td>Cross / A</td></tr>
<tr><td>Blood Bullets</td><td>Triangle / Y</td></tr>
<tr><td>Music Box</td><td>Select / Back</td></tr>
<tr><td>Pause</td><td>Start / Options</td></tr>
</table>
</div>
<ul class="tips">
<li><b class="r">Red tiles</b> are a foe's blow about to land. Step out of them - or quickstep through, untouchable for an instant.</li>
<li>Fire your gun while a winding-up foe <b class="r">flashes white-hot</b>: it <b class="y">staggers</b> (pulsing yellow). Strike it then for a <b class="r">visceral attack</b>.</li>
<li>When hurt, part of your health turns <b class="o">orange</b>. Strike back quickly to regain it - this is the <i>rally</i>.</li>
<li>The faint shade before you shows your weapon's reach. Transform it for a different shape.</li>
<li>Death drops your Blood Echoes as a bloodstain <b class="r">§</b>. Reach it to reclaim them - die first, and they are lost.</li>
<li>Light lamps <b class="g">¥</b> to rest and travel to the Hunter's Dream. The Doll turns echoes into strength.</li>
</ul>`;

function openHelp(back) {
  UI.open({
    closable: true, cls: 'help', back: back || undefined,
    build: () => ({
      title: 'Hunter\'s Notes',
      html: UI_HELP_HTML,
      options: [{ label: 'Back', action: () => (back ? back() : UI.close()) }],
    }),
  });
}
