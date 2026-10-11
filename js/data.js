'use strict';
// ---------------------------------------------------------------------------
// Game content: weapons, enemies, bosses, areas, lore.
// ---------------------------------------------------------------------------

// Attack shapes, written facing East (+x). Rotated to the attacker's facing.
const SHAPES = {
  front: [[1, 0]],
  arc3: [[1, -1], [1, 0], [1, 1]],
  arc5: [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1]],
  ring1: [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]],
  sawLong: [[1, -1], [1, 0], [1, 1], [2, -1], [2, 0], [2, 1]],
  axeSpin: [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1], [2, 0], [2, 1], [2, -1]],
  caneWhip: [[1, 0], [2, 0], [3, 0], [2, -1], [2, 1], [3, -1], [3, 1]],
};

// Trick weapons: two forms each, switched with the transform key.
const WEAPONS = {
  saw: {
    name: 'Saw Cleaver',
    blurb: 'A serrated cleaver that folds out into a long saw. Quick, reliable, and especially cruel to beasts.',
    scale: { str: 0.035, skl: 0.03 }, beast: 1.25,
    forms: [
      { name: 'cleaver', shape: 'arc3', dmg: 20, rec: 6, stam: 12 },
      { name: 'long saw', shape: 'sawLong', dmg: 24, rec: 9, stam: 17 },
    ],
  },
  axe: {
    name: 'Hunter Axe',
    blurb: 'A brutal axe that extends into a halberd for wide, spinning sweeps. Slow, heavy, devastating.',
    scale: { str: 0.055, skl: 0.01 }, beast: 1,
    forms: [
      { name: 'axe', shape: 'arc3', dmg: 29, rec: 10, stam: 18 },
      { name: 'long axe', shape: 'axeSpin', dmg: 33, rec: 14, stam: 26 },
    ],
  },
  cane: {
    name: 'Threaded Cane',
    blurb: 'An elegant cane whose segments unravel into a bladed whip. Lightning thrusts and long reach. Scales with Skill.',
    scale: { str: 0.015, skl: 0.055 }, beast: 1,
    forms: [
      { name: 'cane', shape: 'front', dmg: 18, rec: 4, stam: 9 },
      { name: 'whip', shape: 'caneWhip', dmg: 21, rec: 9, stam: 15 },
    ],
  },
};

const GUN = { name: 'Hunter Pistol', dmg: 9, range: 9 };

const HUNTSMAN_BARKS = ['Beast! Beast!', 'Away with you!', "It's all your fault!", 'Die, you scum!', 'Burn, beast!', 'Out of my way!', 'Curse you!'];

// Regular enemies. speed = ticks between steps (lower is faster).
// poise: 0 = any hit interrupts, 1 = heavy hits interrupt, 2+ = only a parry.
const ENEMIES = {
  huntsman: {
    name: 'Huntsman', ch: 'h', col: '#c9a46a', hp: 45, speed: 5, sight: 8, echoes: 20, poise: 1, barks: HUNTSMAN_BARKS,
    attacks: [{ id: 'swing', shape: 'arc3', range: 1, windup: 9, rec: 9, dmg: 17 }],
  },
  pitch: {
    name: 'Pitchfork Huntsman', ch: 'h', col: '#b58b55', hp: 48, speed: 5, sight: 8, echoes: 22, poise: 1, barks: HUNTSMAN_BARKS,
    attacks: [{ id: 'stab', shape: 'ray', len: 2, range: 2, windup: 10, rec: 9, dmg: 19 }],
  },
  torch: {
    name: 'Torch Huntsman', ch: 'h', col: '#ee8a3a', hp: 42, speed: 5, sight: 8, echoes: 22, poise: 1, barks: HUNTSMAN_BARKS,
    attacks: [{ id: 'burn', shape: 'arc3', range: 1, windup: 8, rec: 8, dmg: 16, combo: 1 }],
  },
  rifle: {
    name: 'Rifle Huntsman', ch: 'r', col: '#aaa08a', hp: 36, speed: 6, sight: 10, echoes: 26, poise: 1, barks: HUNTSMAN_BARKS,
    drop: { vial: 0.15, bullets: 0.3 },
    attacks: [
      { id: 'bash', shape: 'arc3', range: 1, windup: 8, rec: 8, dmg: 12 },
      { id: 'shot', shape: 'ray', len: 9, range: 8, minRange: 2, windup: 16, rec: 14, dmg: 22, cd: 30, shot: true },
    ],
  },
  dog: {
    name: 'Rabid Dog', ch: 'd', col: '#a06a45', hp: 30, speed: 2, sight: 9, echoes: 14, poise: 0, beast: true,
    attacks: [{ id: 'bite', shape: 'lunge', len: 2, range: 2, windup: 6, rec: 10, dmg: 13 }],
  },
  crow: {
    name: 'Carrion Crow', ch: 'v', col: '#7a7aa2', hp: 18, speed: 3, sight: 6, echoes: 7, poise: 0, erratic: 0.35,
    attacks: [{ id: 'peck', shape: 'front', range: 1, windup: 4, rec: 5, dmg: 8 }],
  },
  beast: {
    name: 'Scourge Beast', ch: 'B', col: '#b0a466', hp: 115, speed: 3, sight: 9, echoes: 80, poise: 2, beast: true,
    drop: { vial: 0.35 },
    attacks: [
      { id: 'swipe', shape: 'arc3', range: 1, windup: 7, rec: 6, dmg: 20, combo: 1 },
      { id: 'pounce', shape: 'lunge', len: 3, range: 3, minRange: 2, windup: 10, rec: 10, dmg: 24, cd: 30 },
    ],
  },
  patient: {
    name: 'Beast Patient', ch: 'p', col: '#a8b48e', hp: 42, speed: 3, sight: 7, echoes: 24, poise: 0, beast: true,
    attacks: [{ id: 'scratch', shape: 'arc3', range: 1, windup: 5, rec: 7, dmg: 12 }],
  },
  servant: {
    name: 'Church Servant', ch: 'S', col: '#e2dfea', hp: 115, speed: 6, sight: 8, echoes: 70, poise: 2,
    barks: ['...the Healing Church...', 'Hrrh...', 'Purge the beasts!'],
    attacks: [
      { id: 'sweep', shape: 'arc5', range: 1, windup: 12, rec: 10, dmg: 26 },
      { id: 'thrust', shape: 'ray', len: 3, range: 3, minRange: 2, windup: 11, rec: 10, dmg: 22 },
    ],
  },
  troll: {
    name: 'Brick Troll', ch: 'T', col: '#c07562', hp: 230, speed: 7, sight: 7, echoes: 140, poise: 3,
    drop: { vial: 0.4, shard: 0.25 },
    attacks: [{ id: 'quake', shape: 'ring1', range: 1, windup: 16, rec: 16, dmg: 34, knock: 2 }],
  },
  giant: {
    name: 'Church Giant', ch: 'G', col: '#d6ccb4', hp: 260, speed: 6, sight: 8, echoes: 170, poise: 3,
    drop: { vial: 0.4, shard: 0.3 },
    attacks: [
      { id: 'smash', shape: 'arc5', range: 1, windup: 14, rec: 12, dmg: 32 },
      { id: 'stomp', shape: 'ring1', range: 1, windup: 15, rec: 14, dmg: 30, knock: 1 },
    ],
  },
};

// Bosses. `ph` restricts an attack to phase 1 or 2. `w` is selection weight.
const BOSSES = {
  cleric: {
    name: 'Cleric Beast', size: 3, art: ['Y^Y', '{O}', '/ \\'], col: '#dccba2', hp: 850, speed: 4, echoes: 1000, beast: true,
    intro: "A hulking, antlered thing - once a cleric - tears free of the bridge's shadows.",
    attacks: [
      { id: 'claw', shape: 'cone', r: 2, half: 65, range: 2, windup: 12, rec: 10, dmg: 26, w: 4 },
      { id: 'slam', shape: 'ring', r: 2, range: 2, windup: 17, rec: 14, dmg: 32, w: 2, knock: 2 },
      { id: 'leap', shape: 'leap', r: 1, range: 8, minRange: 3, windup: 18, rec: 16, dmg: 36, w: 3, cd: 70 },
      { id: 'frenzy', shape: 'cone', r: 3, half: 80, range: 3, windup: 10, rec: 14, dmg: 22, combo: 2, w: 3, ph: 2 },
    ],
    phase2: { at: 0.5, msg: 'The Cleric Beast shrieks, its flesh splitting and writhing!', speed: 3 },
  },
  gascoigne: {
    name: 'Father Gascoigne', size: 1, ch: 'G', col: '#93a5c0', hp: 950, speed: 3, echoes: 1800,
    intro: '"Beasts all over the shop... You\'ll be one of them, sooner or later..."',
    attacks: [
      { id: 'axe', shape: 'cone', r: 1, half: 70, range: 1, windup: 9, rec: 8, dmg: 24, combo: 2, w: 4, ph: 1 },
      { id: 'halberd', shape: 'cone', r: 2, half: 30, range: 2, windup: 12, rec: 10, dmg: 28, w: 3, ph: 1 },
      { id: 'blunder', shape: 'spread', len: 5, range: 5, minRange: 2, windup: 13, rec: 12, dmg: 22, w: 3, parry: false, cd: 50, ph: 1 },
      { id: 'rush', shape: 'charge', len: 5, width: 0, range: 6, minRange: 3, windup: 12, rec: 12, dmg: 26, w: 2, cd: 40, ph: 1 },
      { id: 'maul', shape: 'cone', r: 2, half: 75, range: 2, windup: 7, rec: 8, dmg: 26, combo: 3, w: 4, ph: 2 },
      { id: 'pounce', shape: 'leap', r: 1, range: 7, minRange: 2, windup: 12, rec: 12, dmg: 32, w: 3, cd: 40, ph: 2 },
      { id: 'howl', shape: 'ring', r: 2, range: 2, windup: 14, rec: 16, dmg: 30, w: 2, ph: 2 },
    ],
    phase2: { at: 0.5, msg: 'Father Gascoigne convulses - and the beast within tears free!', size: 2, art: ['/\\', 'WW'], col: '#b08f6a', speed: 2 },
  },
  amelia: {
    name: 'Vicar Amelia', size: 3, art: ['^ ^', '(o)', '/|\\'], col: '#efe7d6', hp: 1400, speed: 3, echoes: 3000, beast: true,
    intro: '"Seek the guidance of the Good Blood..." The Vicar\'s prayer turns to a howl.',
    attacks: [
      { id: 'claw', shape: 'cone', r: 2, half: 70, range: 2, windup: 10, rec: 9, dmg: 28, combo: 2, w: 4 },
      { id: 'slam', shape: 'ring', r: 2, range: 2, windup: 16, rec: 14, dmg: 34, w: 2, knock: 2 },
      { id: 'leap', shape: 'leap', r: 1, range: 8, minRange: 3, windup: 16, rec: 14, dmg: 38, w: 3, cd: 60 },
      { id: 'pray', shape: 'heal', range: 99, windup: 44, rec: 10, amount: 0.22, hpBelow: 0.6, uses: 3, cd: 260, w: 6, parry: false,
        say: 'Vicar Amelia clutches her pendant and prays... Interrupt her!' },
      { id: 'nova', shape: 'ring', r: 4, range: 3, windup: 20, rec: 18, dmg: 40, w: 2, ph: 2, cd: 80 },
    ],
    phase2: { at: 0.4, msg: "Vicar Amelia's fur bristles with a sickly golden glow!", speed: 2 },
  },
  gehrman: {
    name: 'Gehrman, the First Hunter', size: 1, ch: 'G', col: '#ccd0e6', hp: 1700, speed: 2, echoes: 6000,
    intro: '"Tonight, Gehrman joins the hunt..."',
    attacks: [
      { id: 'scythe', shape: 'cone', r: 2, half: 85, range: 2, windup: 9, rec: 9, dmg: 30, combo: 2, w: 4 },
      { id: 'dash', shape: 'charge', len: 6, width: 0, range: 7, minRange: 3, windup: 10, rec: 10, dmg: 28, w: 2, cd: 40 },
      { id: 'blink', shape: 'blink', range: 9, minRange: 2, windup: 6, rec: 0, w: 2, cd: 60, next: 'scythe', parry: false },
      { id: 'blunder', shape: 'spread', len: 5, range: 5, minRange: 2, windup: 12, rec: 12, dmg: 22, parry: false, w: 2, cd: 50 },
      { id: 'wave', shape: 'wave', len: 11, range: 9, minRange: 3, windup: 14, rec: 14, dmg: 30, parry: false, w: 3, cd: 45, ph: 2 },
      { id: 'nova', shape: 'ring', r: 3, range: 2, windup: 18, rec: 16, dmg: 36, w: 2, ph: 2, cd: 70 },
    ],
    phase2: { at: 0.5, msg: 'Gehrman: "The night blots out the moon... I am the First Hunter."', speed: 2, col: '#dfe4ff' },
  },
  moon: {
    name: 'Moon Presence', size: 3, art: ['\\|/', '=O=', '/|\\'], col: '#dd4a4a', hp: 2100, speed: 3, echoes: 0,
    intro: 'The Moon Presence descends from the blood-red sky.',
    attacks: [
      { id: 'claw', shape: 'cone', r: 2, half: 70, range: 2, windup: 10, rec: 10, dmg: 32, combo: 1, w: 4 },
      { id: 'letting', shape: 'ring', rMin: 2, r: 6, range: 9, windup: 28, rec: 16, dmg: 0, special: 'bloodletting', parry: false, w: 2, cd: 180,
        say: 'The Moon Presence raises its tendrils. Your blood begins to boil...' },
      { id: 'tendrils', shape: 'scatter', n: 7, range: 9, windup: 14, rec: 12, dmg: 30, parry: false, w: 3, cd: 30 },
      { id: 'leap', shape: 'leap', r: 1, range: 8, minRange: 3, windup: 16, rec: 14, dmg: 36, w: 2, cd: 50 },
    ],
  },
};

// Procedurally generated hunting grounds.
const AREAS = {
  central: {
    name: 'Central Yharnam', rooms: 7, ambient: 0.1, light: 7.5, mult: { hp: 1, dmg: 1, echo: 1 },
    wall: '#5f4f49', floor: '#6f665d', floorChars: '.....,`\'', grass: '#4d5c3c', grassChars: '",\'', grassPatches: 0,
    spawn: { base: 2, growth: 0.55 },
    spawnTable: [['huntsman', 6], ['pitch', 3], ['torch', 3], ['rifle', 2, 2], ['dog', 3], ['crow', 2], ['beast', 1, 4]],
    decor: [
      { ch: '=', col: '#71502f', block: true, w: 3 },        // abandoned carriage
      { ch: 'Ø', col: '#614634', block: true, w: 2 },        // coffin
      { ch: '^', col: '#ef7a26', block: true, light: 5, k: 0.85, flicker: true, w: 1.4 }, // burning pyre
      { ch: 'i', col: '#e2b04c', block: true, light: 4, k: 0.7, w: 1.2 }, // street lamp
      { ch: '%', col: '#80282a', block: false, w: 2 },       // corpse
      { ch: '¦', col: '#61616b', block: true, w: 1 },        // iron fence
    ],
    decorDensity: 0.03, items: { vial: 3, bullets: 2, shard: 2, coldblood: 2, cord: 1 },
    lamps: { start: 'Central Yharnam', boss: 'Great Bridge' },
    arena: { w: 30, h: 13, floor: '#7b7268', deco: { ch: '¦', col: '#6a6a74' } }, boss: 'cleric', unlocks: 'tomb',
    notes: [
      "A hunter's message: \"Fire your gun [L] the moment a foe winds up its blow - then strike [J] for a visceral attack.\"",
      'A scrawled note: "Seek paleblood to transcend the hunt."',
      'A message: "When struck, strike back! The orange part of your health can be regained by hitting foes quickly."',
      'A message: "Lamps carry you to the Hunter\'s Dream. There the Doll turns blood echoes into strength."',
      'A message: "Beware the Great Bridge. The Cleric Beast waits there - fear its leap."',
    ],
  },
  tomb: {
    name: 'Tomb of Oedon', rooms: 7, ambient: 0.13, light: 7.5, mult: { hp: 1.35, dmg: 1.25, echo: 1.6 },
    wall: '#4d4d57', floor: '#5f5a50', floorChars: '...,.`', grass: '#45583a', grassChars: '"",\'.', grassPatches: 10,
    spawn: { base: 2, growth: 0.6 },
    spawnTable: [['huntsman', 4], ['pitch', 2], ['rifle', 3], ['dog', 4], ['crow', 4], ['beast', 2, 2], ['troll', 1, 4]],
    decor: [
      { ch: '†', col: '#8a8a94', block: true, w: 4 },        // gravestone
      { ch: '♣', col: '#3e4a34', block: true, w: 2 },        // dead tree
      { ch: '+', col: '#6c6c74', block: false, w: 2 },       // grave marker
      { ch: '^', col: '#ef7a26', block: true, light: 5, k: 0.8, flicker: true, w: 1 },
      { ch: 'Ø', col: '#614634', block: true, w: 1.5 },
      { ch: '%', col: '#80282a', block: false, w: 1.5 },
    ],
    decorDensity: 0.035, items: { vial: 4, bullets: 2, shard: 3, coldblood: 2, cord: 1 },
    lamps: { start: 'Tomb of Oedon', boss: "Gascoigne's Grave" },
    arena: { w: 26, h: 18, floor: '#5d6450', deco: { ch: '+', col: '#7a7a84' } }, boss: 'gascoigne', unlocks: 'cathedral', window: true,
    notes: [
      'A message: "Father Gascoigne hunts among the graves. He has lost himself to the blood."',
      'A scrawled note: "Fear the old blood."',
      'A message: "A frightened girl waits by a lit window near the tomb gate."',
      'A message: "His family\'s music box... the melody calls him back, if only for a moment. [M]"',
    ],
  },
  cathedral: {
    name: 'Cathedral Ward', rooms: 8, ambient: 0.16, light: 7.5, mult: { hp: 1.8, dmg: 1.5, echo: 2.4 },
    wall: '#675d6d', floor: '#6c6c74', floorChars: '.....:\'', grass: '#4a5040', grassChars: '",', grassPatches: 0,
    spawn: { base: 2, growth: 0.6 },
    spawnTable: [['servant', 4], ['patient', 4], ['beast', 3], ['crow', 2], ['dog', 2], ['giant', 1, 3]],
    decor: [
      { ch: 'Ω', col: '#c4bfb6', block: true, w: 3 },        // statue
      { ch: '¡', col: '#f2d27a', block: false, light: 3, k: 0.6, flicker: true, w: 2 }, // candles
      { ch: 'i', col: '#e2b04c', block: true, light: 4, k: 0.7, w: 1.4 },
      { ch: 'I', col: '#8d8597', block: true, w: 2 },        // pillar
      { ch: '%', col: '#80282a', block: false, w: 1 },
    ],
    decorDensity: 0.03, items: { vial: 4, bullets: 2, shard: 3, coldblood: 3, cord: 1 },
    lamps: { start: 'Cathedral Ward', boss: 'Grand Cathedral' },
    arena: { w: 28, h: 18, floor: '#7a7480', deco: { ch: '¡', col: '#f2d27a', light: true } }, boss: 'amelia', unlocks: null,
    notes: [
      'A scrawled note: "We are born of the blood, made men by the blood, undone by the blood."',
      'A message: "The Healing Church guards its secrets within the Grand Cathedral."',
      'A message: "Vicar Amelia prays to mend her wounds. Strike hard while she prays, or your work is undone."',
      'A note: "Three thirds of an umbilical cord grant eyes to see... and something more, when the night ends."',
    ],
  },
  dream: {
    name: "Hunter's Dream", ambient: 0.55, light: 8, mult: { hp: 1, dmg: 1, echo: 1 },
    wall: '#5a5866', floor: '#8a8478', floorChars: '..', grass: '#5a6a4a', grassChars: '",\'',
  },
  field: {
    name: 'The Flower Field', ambient: 0.6, light: 8, mult: { hp: 1, dmg: 1, echo: 1 },
    wall: '#2c3328', wallCh: '♣', floor: '#8a8478', floorChars: '..', grass: '#5a6a4a', grassChars: '",\'',
  },
};
const AREA_ORDER = ['central', 'tomb', 'cathedral'];

const LAMP_NAMES = {};
for (const id of AREA_ORDER) {
  LAMP_NAMES[id + ':start'] = AREAS[id].lamps.start;
  LAMP_NAMES[id + ':boss'] = AREAS[id].lamps.boss;
}

const ITEM_GLYPH = {
  vial: { ch: '!', col: '#e3303e', name: 'Blood Vial' },
  bullets: { ch: ':', col: '#ccd4e0', name: 'Quicksilver Bullets' },
  shard: { ch: '◊', col: '#b8b8ff', name: 'Blood Stone Shard' },
  coldblood: { ch: '°', col: '#94bde4', name: 'Coldblood Dew' },
  cord: { ch: '∞', col: '#d862a8', name: 'One Third of Umbilical Cord' },
  note: { ch: '?', col: '#eadfb2', name: 'Message' },
};

const GEHRMAN_LINES = [
  'Gehrman: "Ahh, you must be the new hunter. Welcome to the Hunter\'s Dream. This will be your home now."',
  'Gehrman: "You\'ll find a Doll by the stairs. She will help you turn blood echoes into strength."',
  'Gehrman: "The headstones will carry you to any lamp you have lit. Hunt the beasts... it\'s what hunters do."',
  'Gehrman: "The Bath Messengers by the fountain trade in blood echoes. Make use of them."',
  'Gehrman: "Bring Blood Stone Shards to the workbench, and your weapon will grow sharper."',
  'Gehrman: "Ahh... the night is long. But even the longest night must end..."',
];

const INTRO_TEXT = [
  'You wake on a blood-stained clinic table. A rasping voice:',
  '"Oh, you\'ve found yourself a hunter... Paleblood, hmm? Seek paleblood to transcend the hunt."',
  'Outside, the city of Yharnam burns on the night of the hunt. Its people have turned to beasts, and its huntsmen to madness.',
  'Light the lamps. Gather blood echoes. Survive the night.',
];

const ENDINGS = {
  sunrise: {
    title: 'YHARNAM SUNRISE',
    text: 'You kneel among the white flowers. Gehrman\'s blade is swift and merciful.\n\nYou wake in Yharnam as the sun rises over the spires. The night of the hunt has ended, and of the Dream you remember nothing at all - only that it was a long, long night.',
  },
  honor: {
    title: 'HONORING WISHES',
    text: 'Gehrman, the First Hunter, falls among the flowers. "The night... and the dream... were long..."\n\nThe Moon Presence descends and embraces you gently. You take the old man\'s place, bound to the Hunter\'s Dream - a new caretaker for the hunters yet to come.',
  },
  childhood: {
    title: "CHILDHOOD'S BEGINNING",
    text: 'The Moon Presence crumples into the flowers. Silence.\n\nThe Doll lifts something small and wriggling from the petals - an infant Great One. "Ah, the dreamless sleep... and morning will come." She cradles you, and humanity takes its first step into childhood.',
  },
};
