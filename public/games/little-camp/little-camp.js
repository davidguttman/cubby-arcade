// LITTLE CAMP (working title): a D-pad-only camp game for kids who can't read yet.
// 240x160, 16px tiles. No text on screen: pictures and numerals only.
//
// LittleCamp.create({ canvas, autoLoop, audio, music, holds, save, makeCanvas, sprites, onFrame })
//   canvas     a 240x160 canvas (created if omitted)
//   autoLoop   false to drive tick(dt) yourself (tests, recorders)
//   audio      false to mute, or pass an AudioContext to share
//   music      false for no music
//   holds      true if the shell calls release(btn): the game repeats held directions itself.
//              Leave it off when the shell already auto-repeats presses (handheld-os input does).
//   save       { get(key), set(key, value) } JSON store (handheld-os host.saves); else localStorage
//   sprites    { key: dataURI } overrides for SPRITE_SRC (image-gen art drops in here)
// returns { press, release, tick, start, stop, wake, pause, reset, state, _debug }
(function (root) {
'use strict';

// Drop-in art: data URIs keyed like the baked sprites below. null = use the code-drawn placeholder.
// Images are drawn bottom-centre on their tile, at their natural size.
const SPRITE_SRC = {
  kid_down: null, kid_up: null, kid_side: null,   // side faces left; it is mirrored for right
  bear: null, bear_face: null,
  berry: null, heart: null, duck: null,
};

function create(opts = {}) {
const W = 240, H = 160, T = 16, STEP = 0.18, HOLD_GAP = 0.05;
const mkCanvas = opts.makeCanvas || ((w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; });
const cv = opts.canvas || mkCanvas(W, H); cv.width = W; cv.height = H;
const g = cv.getContext('2d'); g.imageSmoothingEnabled = false;
const rnd = Math.random;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
const hash = (x, y, s = 0) => { let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };

// ---------- palette (warm GBA, Line Cutter family) ----------
const C = {
  ink: '#20121a', bubble: '#fff8ec', ghost: '#e2d8c6', ghostLine: '#b8aa94', gold: '#ffd04a', goldDark: '#c8901e',
  grass: '#74c255', grass2: '#6ebd50', blade: '#559e42', bladeLight: '#96d86c', grassDark: '#3f7d39',
  path: '#dcb47c', pathDark: '#c29a62', pathEdge: '#c8a068',
  leaf: '#2f6b3a', leaf2: '#3f8a45', leafLight: '#5aa84f', leafInk: '#1d3d26', trunk: '#7a4a2a',
  water: '#4aa0d8', water2: '#3a88c4', foam: '#a8e0f8', wave: '#7cc8f0',
  stone: '#9a96a8', stoneDark: '#6c687c', flame: '#ff9a2a', flame2: '#ffd04a', flame3: '#e0502a',
  wood: '#8a5a34', woodDark: '#6a4226', woodEnd: '#e0b884', woodRing: '#b08850',
  tent: '#e8803a', tentDark: '#c0602a', tentDoor: '#5a3020',
  glow: '#fff6a0', shadow: 'rgba(20,40,20,0.28)',
};

// ---------- pixel sprites: strings -> canvases with a 1px dark outline ----------
const PAL = {
  k: C.ink, W: '#ffffff',
  // kid camper
  Y: '#f2c94c', O: '#e08a2a', S: '#f2c69c', H: '#6a3a22', P: '#f09a8a', R: '#d8483a', N: '#34508a', D: '#4a2a1a', A: '#c23a2e',
  // bear
  B: '#8a5a34', L: '#b07a48', M: '#e6c08e', E: '#5e3a22', I: '#f08a9a',
  // berry / heart / leaves
  r: '#e03a4a', w: '#ff9aa4', d: '#a8203a', G: '#4fae3c', g: '#2f7a2a',
  // duck
  y: '#ffe066', o: '#f08a1a', u: '#e8b830',
};
function bake(rows, outline = true, pal = PAL) {
  const h = rows.length, w = Math.max(...rows.map(r => r.length)), pad = outline ? 1 : 0;
  const c = mkCanvas(w + pad * 2, h + pad * 2), x = c.getContext('2d');
  const on = (i, j) => j >= 0 && j < h && i >= 0 && i < w && (rows[j][i] || '.') !== '.';
  if (outline) { x.fillStyle = C.ink; for (let j = -1; j <= h; j++) for (let i = -1; i <= w; i++) if (!on(i, j) && (on(i - 1, j) || on(i + 1, j) || on(i, j - 1) || on(i, j + 1))) x.fillRect(i + pad, j + pad, 1, 1); }
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const ch = rows[j][i]; if (ch && ch !== '.') { x.fillStyle = pal[ch] || '#f0f'; x.fillRect(i + pad, j + pad, 1, 1); } }
  return c;
}
function bakeGhost(rows) {   // the empty slot in a bubble: same silhouette, pale
  const p = {}; Object.keys(PAL).forEach(k => (p[k] = C.ghost));
  const c = bake(rows, false, p), out = mkCanvas(c.width + 2, c.height + 2), x = out.getContext('2d');
  const h = rows.length, w = c.width; const on = (i, j) => j >= 0 && j < h && i >= 0 && i < w && (rows[j][i] || '.') !== '.';
  x.fillStyle = C.ghostLine; for (let j = -1; j <= h; j++) for (let i = -1; i <= w; i++) if (!on(i, j) && (on(i - 1, j) || on(i + 1, j) || on(i, j - 1) || on(i, j + 1))) x.fillRect(i + 1, j + 1, 1, 1);
  x.drawImage(c, 1, 1); return out;
}
const KID_TOP = {
  down: ['....YYYYYY....', '...YYYYYYYY...', '..OOOOOOOOOO..', '.YYYYYYYYYYYY.', '..HSSSSSSSSH..', '..SSkSSSSkSS..', '..SSkSSSSkSS..',
         '..SPSSSSSSPS..', '...SSSkkSSS...', '....RRRRRR....', '..SRRRRRRRRS..', '..SRRRRRRRRS..', '....NNNNNN....'],
  up:   ['....YYYYYY....', '...YYYYYYYY...', '..OOOOOOOOOO..', '.YYYYYYYYYYYY.', '..HHHHHHHHHH..', '..HHHHHHHHHH..', '..HHHHHHHHHH..',
         '..SHHHHHHHHS..', '...SHHHHHHS...', '....RRRRRR....', '..SRRRRRRRRS..', '..SRRRRRRRRS..', '....NNNNNN....'],
  side: ['....YYYYYY....', '...YYYYYYYY...', '...OOOOOOOOO..', 'YYYYYYYYYYYY..', '..SSSSSSHHH...', '..SkSSSSHHH...', '..SkSSSSSHH...',
         '.SSSSSPSSH....', '..SSkSSSS.....', '....RRRRR.....', '....RRSRRR....', '....RRSRRR....', '....NNNNN.....'],
};
const KID_LEGS = {
  down: [['....SS..SS....', '....SS..SS....', '....DD..DD....'], ['....SS..SS....', '....DD..SS....', '........DD....'], ['....SS..SS....', '....SS..DD....', '....DD........']],
  up:   [['....SS..SS....', '....SS..SS....', '....DD..DD....'], ['....SS..SS....', '....DD..SS....', '........DD....'], ['....SS..SS....', '....SS..DD....', '....DD........']],
  side: [['.....SSS......', '.....SSS......', '....DDDD......'], ['...SS...SS....', '...SS...SS....', '..DDD...DDD...'], ['....SS.SS.....', '....SS.SS.....', '...DDD.DDD....']],
};
const BEAR = [
  '...EEE........EEE...', '..EBIBE......EBIBE..', '..EBBBEEEEEEEEBBBE..', '...EBBBBBBBBBBBBE...', '...BBBBBBBBBBBBBB...',
  '..BBBkkBBBBBBkkBBB..', '..BBBkWBBBBBBkWBBB..', '..BIIBBMMMMMMBBIIB..', '..BBBBMMMkkMMMBBBB..', '...BBBMMMkkMMMBBB...',
  '...EBBBMMkkMMBBBE...', '....EBBBBBBBBBBE....', '...BBBBLLLLLLBBBB...', '..BBBBLLLLLLLLBBBB..', '.BBEBBLLLLLLLLBBEBB.',
  '.BBEBBLLLLLLLLBBEBB.', '..BBBBBLLLLLLBBBBB..', '..MMMBBBBBBBBBBMMM..', '..MMM..........MMM..',
];
const BERRY = ['....GG..', '...Gg...', '..rrrr..', '.rrwrrr.', '.rwrrrr.', '.rrrrdr.', '..rddr..'];
const HEART = ['.rr...rr.', 'rrrr.rrrr', 'rwwrrrrrr', 'rwrrrrrrr', '.rrrrrrd.', '..rrrrd..', '...rrd...', '....r....'];
const DUCK = ['..yyy.....', '.yykyy....', 'oyyyyy....', '..yyyy..yy', '..yyyyyyyy', '..yuyyyyuy', '...yyyyyy.'];
const SPR = {};
['down', 'up', 'side'].forEach(d => KID_LEGS[d].forEach((legs, f) => (SPR[`kid_${d}_${f}`] = bake(KID_TOP[d].concat(legs)))));
SPR.bear = bake(BEAR); SPR.berry = bake(BERRY); SPR.berryGhost = bakeGhost(BERRY); SPR.heart = bake(HEART); SPR.duck = bake(DUCK);
SPR.bear_face = (() => { const c = mkCanvas(22, 14); c.getContext('2d').drawImage(SPR.bear, 0, 0); return c; })();
// image-gen overrides
const OVR = {};
const srcs = Object.assign({}, SPRITE_SRC, opts.sprites || {});
for (const k in srcs) if (srcs[k] && typeof Image !== 'undefined') { const im = new Image(); im.src = srcs[k]; OVR[k] = im; }
const art = (k, fallback) => { const o = OVR[k.replace(/_\d$/, '')]; return o && o.complete && o.width ? o : SPR[fallback || k]; };
function blit(im, x, y, flip = false) {   // x,y = bottom-centre
  x = Math.round(x - im.width / 2); y = Math.round(y - im.height);
  if (!flip) { g.drawImage(im, x, y); return; }
  g.save(); g.translate(x + im.width, y); g.scale(-1, 1); g.drawImage(im, 0, 0); g.restore();
}
// numerals: chunky 5x7
const DIG = {
  0: ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'], 1: ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'], 3: ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
  4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'], 5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  6: ['.###.', '#....', '#....', '####.', '#...#', '#...#', '.###.'], 7: ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  8: ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'], 9: ['.###.', '#...#', '#...#', '.####', '....#', '....#', '.###.'],
};
function digit(n, x, y, s, col, ol) {
  const rows = DIG[n]; x = Math.round(x); y = Math.round(y);
  const plot = (c, ox, oy) => { g.fillStyle = c; rows.forEach((r, j) => [...r].forEach((ch, i) => { if (ch === '#') g.fillRect(x + i * s + ox, y + j * s + oy, s, s); })); };
  if (ol) for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) if (ox || oy) plot(ol, ox, oy);
  plot(col, 0, 0);
}
function disc(x2, cx, cy, r, col) { x2.fillStyle = col; for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) if (i * i + j * j <= r * r + r * 0.6) x2.fillRect(cx + i, cy + j, 1, 1); }

// ---------- the world ----------
const MW = 40, MH = 26;
const map = [];
for (let y = 0; y < MH; y++) map.push(Array(MW).fill('T'));
const rect = (x0, y0, x1, y1, ch) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) map[y][x] = ch; };
rect(4, 9, 15, 18, '.');          // camp clearing
rect(15, 12, 21, 14, '.');        // lane east
rect(21, 6, 35, 20, '.');         // berry patch
rect(9, 4, 10, 9, '.');           // lane north, behind the log
rect(4, 1, 18, 5, '.');           // pond clearing (next area: stub)
rect(7, 1, 15, 3, 'w');
for (let x = 7; x <= 22; x++) map[13][x] = '=';
for (let y = 4; y <= 13; y++) map[y][9] = '=';
// ragged forest edge: nibble boundary tiles, never near a path
const nearPath = (x, y) => { for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) if ((map[y + j] || [])[x + i] === '=') return true; return false; };
const edge = [];
for (let y = 1; y < MH - 1; y++) for (let x = 1; x < MW - 1; x++) if (map[y][x] === '.' && !nearPath(x, y)) {
  const n = [map[y - 1][x], map[y + 1][x], map[y][x - 1], map[y][x + 1]].filter(c => c === 'T').length;
  if (n >= 1 && hash(x, y, 3) < (n >= 2 ? 0.6 : 0.28)) edge.push([x, y]);
}
const KEEP = new Set(['15,13', '17,13', '19,13', '24,10', '27,14', '30,11', '25,17', '32,17', '11,12', '8,12', '6,13', '6,10']);
edge.forEach(([x, y]) => { if (!KEEP.has(x + ',' + y)) map[y][x] = 'T'; });
[[26, 8], [33, 8], [22, 18], [29, 16], [34, 14], [28, 11], [5, 16], [14, 10]].forEach(([x, y]) => (map[y][x] = 'b'));
for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) if (map[y][x] === '.' && hash(x, y, 9) < 0.09) map[y][x] = ',';
const FIRE = { x: 8, y: 12 };
map[FIRE.y][FIRE.x] = 'f';
const LOG = { x: 9, y: 7, w: 2, gone: false, roll: 0 };
const TENT = { x: 6, y: 10, shown: false, pop: 0 };
const solidCh = ch => ch === 'T' || ch === 'w' || ch === 'b' || ch === 'f' || ch === 't';
function solid(x, y) {
  if (x < 0 || y < 0 || x >= MW || y >= MH) return true;
  if (solidCh(map[y][x])) return true;
  if (!LOG.gone && y === LOG.y && x >= LOG.x && x < LOG.x + LOG.w) return true;
  if (x === BEARP.x && y === BEARP.y) return true;
  return false;
}

// ---------- static ground layer ----------
const ground = mkCanvas(MW * T, MH * T), gx = ground.getContext('2d');
function drawGround() {
  for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) {
    const ch = map[y][x], X = x * T, Y = y * T;
    gx.fillStyle = ch === 'T' ? C.grassDark : (x + y) % 2 ? C.grass : C.grass2; gx.fillRect(X, Y, T, T);
    if (ch === '.' || ch === ',' || ch === 'b' || ch === 'f') {
      for (let k = 0; k < 4; k++) { const bx = Math.floor(hash(x, y, k) * 14), by = Math.floor(hash(x, y, k + 7) * 13); gx.fillStyle = k === 3 ? C.bladeLight : C.blade; gx.fillRect(X + bx, Y + by, 1, 2); gx.fillRect(X + bx + 1, Y + by + 1, 1, 1); }
    }
    if (ch === ',') {
      const fx = X + 3 + Math.floor(hash(x, y, 1) * 9), fy = Y + 3 + Math.floor(hash(x, y, 2) * 9), pc = ['#ffffff', '#ffb0c8', '#a8c8ff', '#fff0a0'][Math.floor(hash(x, y, 5) * 4)];
      gx.fillStyle = pc; gx.fillRect(fx - 1, fy, 3, 1); gx.fillRect(fx, fy - 1, 1, 3); gx.fillStyle = '#f0b020'; gx.fillRect(fx, fy, 1, 1);
    }
    if (ch === '=') {
      gx.fillStyle = C.path; gx.fillRect(X, Y, T, T);
      const isP = (i, j) => (map[j] || [])[i] === '=';
      gx.fillStyle = C.pathEdge;
      if (!isP(x, y - 1)) gx.fillRect(X, Y, T, 2); if (!isP(x, y + 1)) gx.fillRect(X, Y + T - 2, T, 2);
      if (!isP(x - 1, y)) gx.fillRect(X, Y, 2, T); if (!isP(x + 1, y)) gx.fillRect(X + T - 2, Y, 2, T);
      gx.fillStyle = C.pathDark; for (let k = 0; k < 3; k++) gx.fillRect(X + 3 + Math.floor(hash(x, y, k + 20) * 10), Y + 3 + Math.floor(hash(x, y, k + 30) * 10), 2, 1);
    }
    if (ch === 'w') {
      gx.fillStyle = C.water; gx.fillRect(X, Y, T, T);
      const isW = (i, j) => (map[j] || [])[i] === 'w' || j < 0;
      gx.fillStyle = C.foam;
      if (!isW(x, y + 1)) gx.fillRect(X, Y + T - 3, T, 3); if (!isW(x - 1, y)) gx.fillRect(X, Y, 2, T); if (!isW(x + 1, y)) gx.fillRect(X + T - 2, Y, 2, T);
    }
  }
  // bushes and trees, top row first so lower canopies overlap upper ones
  for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) {
    const ch = map[y][x], X = x * T, Y = y * T;
    if (ch === 'b') { disc(gx, X + 8, Y + 9, 7, C.leafInk); disc(gx, X + 8, Y + 9, 6, C.leaf2); disc(gx, X + 6, Y + 7, 3, C.leafLight); gx.fillStyle = C.leaf; gx.fillRect(X + 10, Y + 11, 2, 2); gx.fillRect(X + 5, Y + 12, 2, 1); }
    if (ch === 'T') {
      const open = (map[y + 1] || [])[x] !== 'T';
      if (open) { gx.fillStyle = C.ink; gx.fillRect(X + 5, Y + 9, 6, 7); gx.fillStyle = C.trunk; gx.fillRect(X + 6, Y + 9, 4, 6); }
      const ox = Math.floor(hash(x, y, 11) * 3) - 1;
      disc(gx, X + 8 + ox, Y + 6, 9, C.leafInk); disc(gx, X + 8 + ox, Y + 6, 8, C.leaf); disc(gx, X + 6 + ox, Y + 4, 5, C.leaf2);
      gx.fillStyle = C.leafLight; gx.fillRect(X + 4 + ox, Y + 2, 2, 1); gx.fillRect(X + 3 + ox, Y + 3, 1, 1); gx.fillRect(X + 9 + ox, Y + 1, 2, 1);
    }
  }
}
drawGround();

// ---------- state ----------
const ASKS = [
  { need: 3, spots: [[15, 13], [17, 13], [19, 13]] },                         // straight right of camp
  { need: 5, spots: [[24, 10], [27, 14], [30, 11], [25, 17], [32, 17]] },     // around the patch: up and down too
];
const BEARP = { x: 11, y: 12, dance: 0, bounce: 0, talkCd: 0, blink: 2, hop: 0 };
const VOICE = { bear: { lo: 130, hi: 250, wave: 'triangle' }, duck: { lo: 520, hi: 820, wave: 'square' }, kid: { lo: 420, hi: 700, wave: 'square' } };
let P, Q, berries, trail, hist, flying, busy, timers, parts, pops, cam, camTarget, idleT, time, queued, held, holdT, lastDir,
  visitedPond, heartShown, hintCache, dirty, saveT, introDone, duck;
function newState() {
  P = { x: 6, y: 13, fx: 6, fy: 13, t: 1, moving: false, dir: 'right', frame: 0, steps: 0, hop: 0, wave: 0, spin: 0, bonk: 0, bonkDir: null, lastBonk: -9 };
  Q = { ask: 0, given: 0 };
  berries = []; ASKS.forEach((a, ai) => a.spots.forEach(([x, y], k) => berries.push({ id: ai * 10 + k, ask: ai, x, y, state: 'ground', px: x * T, py: y * T, join: 0, spawn: 0 })));
  trail = []; hist = []; flying = []; busy = false; timers = []; parts = []; pops = []; idleT = 0; time = 0; queued = null; held = new Set(); holdT = 0; lastDir = null;
  visitedPond = false; heartShown = 0; hintCache = null; dirty = false; saveT = 0; introDone = false;
  LOG.gone = false; LOG.roll = 0; TENT.shown = false; TENT.pop = 0;
  cam = { x: P.x * T + 8 - W / 2, y: P.y * T + 8 - H / 2 }; camTarget = null;
  duck = { x: 9.5, y: 2, vx: 0.6, t: 0 };
}
newState();
const after = (t, fn) => timers.push({ t, fn });

// ---------- saves ----------
const store = opts.save || (() => { try { const ls = root.localStorage; return ls ? { get: k => { const v = ls.getItem('littlecamp_' + k); return v ? JSON.parse(v) : null; }, set: (k, v) => ls.setItem('littlecamp_' + k, JSON.stringify(v)), remove: k => ls.removeItem('littlecamp_' + k) } : null; } catch (e) { return null; } })();
function save() {
  if (!store) return;
  try { store.set('camp', { v: 1, ask: Q.ask, given: Q.given, taken: berries.filter(b => b.state !== 'ground').map(b => b.id), carried: trail.map(b => b.id), x: P.x, y: P.y, dir: P.dir, pond: visitedPond }); } catch (e) {}
}
function load() {
  let s = null; try { s = store && store.get('camp'); } catch (e) {}
  if (!s || s.v !== 1) return;
  Q.ask = s.ask; Q.given = s.given; P.x = P.fx = s.x; P.y = P.fy = s.y; P.dir = s.dir || 'down'; visitedPond = !!s.pond; introDone = true;
  berries.forEach(b => { if (s.taken.includes(b.id) || b.ask < Q.ask) b.state = 'given'; });
  s.carried.forEach(id => { const b = berries.find(q => q.id === id); if (b) { b.state = 'trail'; b.join = 1; trail.push(b); } });
  if (Q.ask >= 2) { LOG.gone = true; TENT.shown = true; TENT.pop = 1; map[TENT.y][TENT.x] = 't'; }
  cam = { x: P.x * T + 8 - W / 2, y: P.y * T + 8 - H / 2 };
}
load();

// ---------- audio ----------
let AC = null, master = null, musicBus = null, noiseBuf = null;
function ensureAudio() {
  if (opts.audio === false) return;
  if (!AC && opts.audio && opts.audio.createOscillator) AC = opts.audio;
  if (!AC || !master) {
    try {
      AC = AC || new (root.AudioContext || root.webkitAudioContext)();
      master = AC.createGain(); master.gain.value = 0.7; master.connect(AC.destination);
      noiseBuf = AC.createBuffer(1, AC.sampleRate, AC.sampleRate);
      const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = rnd() * 2 - 1;
    } catch (e) { AC = null; }
  }
  if (AC && AC.state === 'suspended') AC.resume();
}
function tone(f, d, type = 'square', v = 0.05, f2 = null, delay = 0) {
  if (!AC || !master) return; const t = AC.currentTime + delay;
  const o = AC.createOscillator(), gn = AC.createGain(); o.type = type;
  o.frequency.setValueAtTime(f, t); if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + d);
  gn.gain.setValueAtTime(v, t); gn.gain.exponentialRampToValueAtTime(0.0001, t + d);
  o.connect(gn); gn.connect(master); o.start(t); o.stop(t + d + 0.03);
}
function noise(d, v = 0.08, freq = 2000, type = 'lowpass', delay = 0) {
  if (!AC || !master) return; const t = AC.currentTime + delay;
  const s = AC.createBufferSource(); s.buffer = noiseBuf; const fl = AC.createBiquadFilter(); fl.type = type; fl.frequency.value = freq;
  const gn = AC.createGain(); gn.gain.setValueAtTime(v, t); gn.gain.exponentialRampToValueAtTime(0.0001, t + d);
  s.connect(fl); fl.connect(gn); gn.connect(master); s.start(t, rnd() * 0.5); s.stop(t + d + 0.03);
}
// babble: no words, just tone. ask = rising "hmm?", happy = quick climb, hi = two chirps
function babble(who, mood = 'ask') {
  const v = VOICE[who], span = v.hi - v.lo, vol = who === 'bear' ? 0.07 : 0.03;
  const seq = mood === 'ask' ? [0.35, 0.2, 0.55] : mood === 'happy' ? [0.2, 0.45, 0.7, 1] : [0.5, 0.75];
  seq.forEach((k, i) => { const f = v.lo + span * (k + (rnd() - 0.5) * 0.12); const last = i === seq.length - 1;
    tone(f, last ? 0.16 : 0.07, v.wave, vol, last && mood !== 'hi' ? f * (mood === 'ask' ? 1.35 : 1.5) : null, i * 0.1); });
}
const SCALE = [523, 587, 659, 784, 880, 1047, 1175];
const SFX = {
  step: () => tone(P.steps % 2 ? 210 : 180, 0.03, 'triangle', 0.025),
  bonk: () => { tone(200, 0.13, 'triangle', 0.08, 120); tone(760, 0.05, 'square', 0.018, null, 0.1); tone(920, 0.06, 'square', 0.018, null, 0.16); },
  pick: i => { tone(SCALE[i % 7], 0.12, 'triangle', 0.08); tone(SCALE[i % 7] * 2, 0.08, 'square', 0.015, null, 0.03); },
  give: i => { const f = SCALE[Math.min(6, i)]; tone(f, 0.2, 'triangle', 0.09); tone(f * 2, 0.12, 'sine', 0.04, null, 0.03); tone(f * 1.5, 0.1, 'square', 0.012, null, 0.06); },
  pop: () => tone(380, 0.07, 'sine', 0.07, 900),
  fanfare: () => [523, 659, 784, 1047, 784, 1047].forEach((f, i) => { tone(f, i === 5 ? 0.5 : 0.12, 'square', 0.035, null, i * 0.12); tone(f / 2, i === 5 ? 0.5 : 0.12, 'triangle', 0.06, null, i * 0.12); }),
  roll: () => { noise(1.4, 0.08, 260, 'lowpass'); tone(90, 1.2, 'triangle', 0.07, 55); },
  thud: () => { tone(80, 0.25, 'sine', 0.18, 40); noise(0.2, 0.08, 500); },
  hop: () => tone(260, 0.16, 'sine', 0.08, 640),
  wave: () => { tone(880, 0.06, 'square', 0.02); tone(1175, 0.08, 'square', 0.02, null, 0.08); },
  spin: () => [1047, 1319, 1568, 2093].forEach((f, i) => tone(f, 0.07, 'square', 0.018, null, i * 0.05)),
  sparkle: () => [1568, 2093, 1760].forEach((f, i) => tone(f, 0.06, 'sine', 0.03, null, i * 0.07)),
  tada: () => [784, 988, 1175, 1568].forEach((f, i) => tone(f, 0.12, 'triangle', 0.06, null, i * 0.09)),
};

// ---------- music: a tiny tracker (from Line Cutter): "NOTE:len" in 16ths ----------
const NOTE_IX = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };
const midiOf = n => { const m = n.match(/^([A-G]#?)(-?\d)$/); return NOTE_IX[m[1]] + (+m[2] + 1) * 12; };
const hz = m => 440 * Math.pow(2, (m - 69) / 12);
function track(inst, str) { const ev = []; let t = 0; for (const tok of str.trim().split(/\s+/)) { const [n, d] = tok.split(':'); if (n !== 'r') ev.push({ t, inst, m: midiOf(n), len: +d }); t += +d; } return ev; }
function comp(inst, chords, rhythm) {
  const ev = [], hits = []; [...rhythm].forEach((c, s) => { if (c === 'x') hits.push(s); });
  chords.forEach((ch, bar) => { const [a, b] = ch.split('|'); hits.forEach((s, k) => { const end = k + 1 < hits.length ? hits[k + 1] : 16; (b && s >= 8 ? b : a).split(' ').forEach(n => ev.push({ t: bar * 16 + s, inst, m: midiOf(n), len: end - s })); }); });
  return ev;
}
function drums(bar) { const ev = []; for (let b = 0; b < 8; b++) [...bar].forEach((c, s) => { if (c !== '.') ev.push({ t: b * 16 + s, inst: c, m: 0, len: 1 }); }); return ev; }
function song(bpm, swing, parts2) { const at = {}; parts2.flat().forEach(e => (at[e.t] = at[e.t] || []).push(e)); return { bpm, swing, at, len: 128 }; }
const SONGS = {
  // Camp: a lazy C major lullaby on vibes. C | Am | F | G | C | Em | F G | C
  camp: song(88, 0.18, [
    track('vib', 'E5:4 D5:2 C5:2 G4:8  A4:4 C5:2 E5:2 D5:8  F5:4 E5:2 D5:2 C5:4 A4:4  B4:4 D5:4 G5:8 ' +
                 'E5:4 G5:2 E5:2 C5:8  B4:4 C5:2 D5:2 E5:4 G4:4  A4:4 C5:4 B4:2 A4:2 G4:4  C5:16'),
    track('bass', 'C3:8 G2:8  A2:8 E2:8  F2:8 C3:8  G2:8 D3:8  C3:8 G2:8  E2:8 B2:8  F2:8 G2:8  C3:8 G2:8'),
    comp('ep', ['C4 E4 G4', 'A3 C4 E4', 'F3 A3 C4', 'G3 B3 D4', 'C4 E4 G4', 'E3 G3 B3', 'F3 A3 C4|G3 B3 D4', 'C4 E4 G4'], 'x.......x.......'),
    drums('k.......c...h...'),
  ]),
};
const MUSIC = { cur: null, step: 0, next: 0 };
function nz(t, out, type, freq, q, v, att, dec) {
  const s = AC.createBufferSource(), f = AC.createBiquadFilter(), gn = AC.createGain();
  s.buffer = noiseBuf; f.type = type; f.frequency.value = freq; f.Q.value = q;
  gn.gain.setValueAtTime(0.0001, t); gn.gain.linearRampToValueAtTime(v, t + att); gn.gain.exponentialRampToValueAtTime(0.0001, t + att + dec);
  s.connect(f); f.connect(gn); gn.connect(out); s.start(t, rnd() * 0.5); s.stop(t + att + dec + 0.02);
}
function osc(type, f, t) { const o = AC.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, t); return o; }
function env(gn, t, v, att, dec, sus, end, rel) {
  gn.gain.setValueAtTime(0.0001, t); gn.gain.exponentialRampToValueAtTime(v, t + att);
  const sv = Math.max(0.0001, v * sus), st = Math.max(t + att + 0.01, Math.min(end, t + att + dec));
  gn.gain.exponentialRampToValueAtTime(sv, st); if (end > st) gn.gain.setValueAtTime(sv, end); gn.gain.setTargetAtTime(0.0001, Math.max(end, st), rel);
}
function playNote(e, t, spb) {
  const out = musicBus, end = t + e.len * spb * 0.95;
  if (e.inst === 'k') { const o = osc('sine', 100, t), gn = AC.createGain(); o.frequency.exponentialRampToValueAtTime(45, t + 0.12); gn.gain.setValueAtTime(0.18, t); gn.gain.exponentialRampToValueAtTime(0.001, t + 0.16); o.connect(gn); gn.connect(out); o.start(t); o.stop(t + 0.2); return; }
  if (e.inst === 'c') { nz(t, out, 'bandpass', 2600, 0.8, 0.035, 0.03, 0.18); return; }   // brush
  if (e.inst === 'h') { nz(t, out, 'highpass', 7000, 0.7, 0.025, 0.001, 0.03); return; }
  const f = hz(e.m), gn = AC.createGain(); gn.connect(out);
  if (e.inst === 'ep') {
    const car = osc('sine', f, t), mod = osc('sine', f, t), mi = AC.createGain();
    mi.gain.setValueAtTime(f * 1.6, t); mi.gain.exponentialRampToValueAtTime(f * 0.25, t + 0.6);
    mod.connect(mi); mi.connect(car.frequency); car.connect(gn); env(gn, t, 0.03, 0.006, 0.9, 0.4, end, 0.15);
    [car, mod].forEach(o => { o.start(t); o.stop(end + 0.7); }); return;
  }
  if (e.inst === 'bass') {
    const o1 = osc('triangle', f, t), o2 = osc('sine', f, t), lp = AC.createBiquadFilter(), mix = AC.createGain();
    lp.type = 'lowpass'; lp.frequency.setValueAtTime(900, t); lp.frequency.exponentialRampToValueAtTime(300, t + 0.2);
    o1.connect(lp); o2.connect(mix); lp.connect(mix); mix.connect(gn); env(gn, t, 0.07, 0.015, 0.3, 0.6, end, 0.06);
    [o1, o2].forEach(o => { o.start(t); o.stop(end + 0.4); }); return;
  }
  // vib: vibraphone, pure tone + overtone, slow tremolo
  const o1 = osc('sine', f, t), o2 = osc('sine', f * 4, t), og = AC.createGain(), trem = osc('sine', 4.6, t), tg = AC.createGain(), am = AC.createGain();
  og.gain.setValueAtTime(0.3, t); og.gain.exponentialRampToValueAtTime(0.01, t + 0.25);
  tg.gain.value = 0.25; am.gain.value = 0.75; trem.connect(tg); tg.connect(am.gain);
  o1.connect(am); o2.connect(og); og.connect(am); am.connect(gn); env(gn, t, 0.1, 0.003, 1.4, 0.25, end, 0.3);
  [o1, o2, trem].forEach(o => { o.start(t); o.stop(end + 1.3); });
}
let musicDuck = 0, paused = false;
function musicTick() {
  if (!AC || !master || opts.music === false) return;
  if (!musicBus) { musicBus = AC.createGain(); musicBus.gain.value = 0; musicBus.connect(master); }
  if (MUSIC.cur !== 'camp') { MUSIC.cur = 'camp'; MUSIC.step = 0; MUSIC.next = AC.currentTime + 0.1; }
  musicBus.gain.setTargetAtTime(paused ? 0 : musicDuck > 0 ? 0.12 : 0.5, AC.currentTime, 0.3);
  const sg = SONGS.camp, spb = 60 / sg.bpm / 4;
  if (MUSIC.next < AC.currentTime) MUSIC.next = AC.currentTime + 0.02;
  while (MUSIC.next < AC.currentTime + 0.15) {
    const st = MUSIC.step % sg.len, sw = sg.swing && st % 4 === 2 ? spb * sg.swing : 0;
    (sg.at[st] || []).forEach(e => playNote(e, MUSIC.next + sw, spb));
    MUSIC.next += spb; MUSIC.step++;
  }
}

// ---------- rules ----------
const ask = () => ASKS[Q.ask];
const carried = () => trail.length;
const fullHands = () => Q.ask < 2 && carried() > 0 && carried() + Q.given >= ask().need;
const nearBear = (x, y) => Math.max(Math.abs(x - BEARP.x), Math.abs(y - BEARP.y)) <= 1 && !(x === BEARP.x && y === BEARP.y);
const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

function tryStep(dir) {
  if (busy) return;
  if (P.moving) { queued = dir; return; }
  P.dir = dir;
  const [dx, dy] = DIRS[dir], nx = P.x + dx, ny = P.y + dy;
  if (nx === BEARP.x && ny === BEARP.y) { talkBear(true); return; }
  if (solid(nx, ny)) {
    P.bonk = 0.2; P.bonkDir = dir;
    if (time - P.lastBonk > 0.45) { SFX.bonk(); P.lastBonk = time; }
    return;
  }
  hist.unshift({ x: P.x, y: P.y }); if (hist.length > 14) hist.length = 14;
  P.fx = P.x; P.fy = P.y; P.x = nx; P.y = ny; P.t = 0; P.moving = true; P.steps++; SFX.step();
}
function arrive() {
  P.moving = false; P.t = 1;
  // pick up
  const b = berries.find(q => q.state === 'ground' && q.ask === Q.ask && q.x === P.x && q.y === P.y);
  if (b) {
    if (carried() + Q.given < ask().need) {
      b.state = 'trail'; b.join = 0; b.jx = b.x * T; b.jy = b.y * T; trail.push(b); SFX.pick(carried() - 1); burst(b.x * T + 8, b.y * T + 8, 6, ['#ffffff', C.gold, '#ff9aa4']); dirty = true;
    } else b.nope = 0.4;   // hands are full: it just wiggles
  }
  dirty = true;
  if (nearBear(P.x, P.y)) talkBear(false);
  if (!visitedPond && LOG.gone && P.y <= 5) { visitedPond = true; SFX.tada(); after(0.3, () => babble('duck', 'happy')); burst(P.x * T + 8, P.y * T, 10, ['#ffffff', C.gold, C.wave]); dirty = true; }
  if (queued) { const d = queued; queued = null; tryStep(d); }
  else if (opts.holds && lastDir && held.has(lastDir)) holdT = HOLD_GAP;
}
function talkBear(bumped) {
  if (busy) return;
  if (Q.ask >= 2) { if (BEARP.talkCd <= 0) { babble('bear', 'happy'); BEARP.hop = 0.35; BEARP.talkCd = 1; } return; }
  if (carried() > 0) { startGive(); return; }
  if (BEARP.talkCd > 0) return;
  babble('bear', 'ask'); BEARP.bounce = 0.4; BEARP.talkCd = bumped ? 0.6 : 1.5;
}
function startGive() {
  busy = true; queued = null;
  const list = trail.slice(); trail = [];
  list.forEach((b, i) => { b.state = 'fly'; b.flyT = -i * 0.32; b.fromX = b.px; b.fromY = b.py; b.slot = Q.given + i; flying.push(b); });
  BEARP.bounce = 0.3; babble('bear', 'hi');
}
function landed(b) {
  b.state = 'given'; Q.given++; SFX.give(Q.given - 1); BEARP.bounce = 0.3; BEARP.hop = 0.25;
  const L = bubbleLayout(); if (L) { const s = L.slots[b.slot]; pops.length = 0; pops.push({ n: Q.given, x: s.x + 5, y: s.y - 2, t: 0 }); burst(s.x + 5, s.y + 4, 5, [C.gold, '#ffffff']); }
  if (!flying.length) {
    if (Q.given >= ask().need) after(0.35, celebrate);
    else { after(0.3, () => babble('bear', 'happy')); busy = false; dirty = true; }
  }
}
function celebrate() {
  SFX.fanfare(); musicDuck = 2.6; BEARP.dance = 2.6; heartShown = 0.001;
  confetti();
  after(0.8, () => babble('bear', 'happy'));
  if (Q.ask === 0) {
    after(2.8, () => {
      Q.ask = 1; Q.given = 0; heartShown = 0; SFX.pop(); babble('bear', 'ask'); BEARP.bounce = 0.4;
      berries.filter(b => b.ask === 1).forEach((b, i) => { b.spawn = -0.15 * i; after(0.15 * i + 0.2, SFX.sparkle); });
      busy = false; dirty = true;
    });
  } else {
    after(2.6, () => { TENT.shown = true; TENT.pop = 0; map[TENT.y][TENT.x] = 't'; SFX.thud(); burst(TENT.x * T + 8, TENT.y * T + 12, 12, ['#ffffff', '#e8d8b8']); });
    after(3.6, () => { camTarget = { x: LOG.x * T + 16 - W / 2, y: LOG.y * T + 8 - H / 2 }; });
    after(4.8, () => { LOG.roll = 0.0001; SFX.roll(); });
    after(6.2, () => { LOG.gone = true; SFX.sparkle(); burst((LOG.x + 1) * T, LOG.y * T + 8, 14, ['#ffffff', C.gold, C.bladeLight]); });
    after(7.0, () => { camTarget = null; });
    after(7.8, () => { Q.ask = 2; Q.given = 0; busy = false; idleT = 3; dirty = true; });
  }
}
function burst(x, y, n, cols) { for (let i = 0; i < n; i++) { const a = rnd() * Math.PI * 2, s = 20 + rnd() * 40; parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 30, life: 0.5 + rnd() * 0.4, t: 0, col: cols[i % cols.length], sz: 1 + (rnd() < 0.4 ? 1 : 0), grav: 60 }); } }
function confetti() {
  const cols = ['#e03a4a', '#ffd04a', '#4aa0d8', '#74c255', '#ffffff', '#f08a9a'];
  for (let i = 0; i < 60; i++) parts.push({ screen: true, x: rnd() * W, y: -rnd() * 60, vx: (rnd() - 0.5) * 30, vy: 30 + rnd() * 40, life: 3, t: rnd() * 0.3, col: cols[i % cols.length], sz: 2, grav: 10, wob: rnd() * 6 });
}

// ---------- hints ----------
function hintTarget() {
  if (Q.ask >= 2) return visitedPond ? null : { tiles: [[9, 5], [8, 5], [10, 5]], key: 'pond' };
  if (!fullHands()) {
    const left = berries.filter(b => b.ask === Q.ask && b.state === 'ground' && b.spawn >= 1);
    if (left.length && carried() + Q.given < ask().need) return { tiles: left.map(b => [b.x, b.y]), key: 'b' + left.map(b => b.id).join() };
  }
  if (carried() > 0) { const t = []; for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) if (i || j) t.push([BEARP.x + i, BEARP.y + j]); return { tiles: t, key: 'bear' }; }
  return null;
}
function findPath(tgt) {
  const key = `${P.x},${P.y},${tgt.key}`; if (hintCache && hintCache.key === key) return hintCache.path;
  const goal = new Set(tgt.tiles.map(([x, y]) => x + ',' + y)), prev = new Map([[P.x + ',' + P.y, null]]), qq = [[P.x, P.y]];
  let end = null;
  while (qq.length) { const [x, y] = qq.shift(); if (goal.has(x + ',' + y)) { end = [x, y]; break; }
    for (const [dx, dy] of Object.values(DIRS)) { const nx = x + dx, ny = y + dy, k = nx + ',' + ny; if (!prev.has(k) && !solid(nx, ny)) { prev.set(k, [x, y]); qq.push([nx, ny]); } } }
  const path = []; for (let c = end; c && !(c[0] === P.x && c[1] === P.y); c = prev.get(c[0] + ',' + c[1])) path.unshift(c);
  hintCache = { key, path }; return path;
}

// ---------- input ----------
function press(b) {
  ensureAudio();
  if (!introDone) { introDone = true; after(0.4, () => { SFX.pop(); babble('bear', 'ask'); BEARP.bounce = 0.4; }); }
  idleT = 0;
  if (DIRS[b]) { lastDir = b; if (opts.holds) held.add(b); tryStep(b); return; }
  if (b === 'a') { if (P.hop <= 0) { P.hop = 0.4; SFX.hop(); } if (!busy && nearBear(P.x, P.y)) talkBear(true); }
  else if (b === 'b') { P.wave = 0.6; SFX.wave(); parts.push({ x: P.px + 8, y: P.py - 6, vx: 0, vy: -20, life: 0.8, t: 0, heart: true, grav: 0 }); }
  else if (b === 'start') { P.spin = 0.6; SFX.spin(); burst(P.px + 8, P.py + 4, 8, [C.gold, '#ffffff']); }
  else if (b === 'select') { SFX.sparkle(); burst(P.px + 8, P.py, 5, ['#a8c8ff', '#ffffff']); }
}
function release(b) { held.delete(b); }

// ---------- update ----------
function update(dt) {
  time += dt;
  for (let i = timers.length - 1; i >= 0; i--) { timers[i].t -= dt; if (timers[i].t <= 0) { const f = timers[i].fn; timers.splice(i, 1); f(); } }
  if (P.moving) { P.t += dt / STEP; if (P.t >= 1) arrive(); }
  else if (opts.holds && holdT > 0) { holdT -= dt; if (holdT <= 0 && lastDir && held.has(lastDir)) tryStep(lastDir); }
  const pt = ease(Math.min(1, P.t));
  P.px = lerp(P.fx * T, P.x * T, P.moving ? pt : 1); P.py = lerp(P.fy * T, P.y * T, P.moving ? pt : 1);
  if (!P.moving) { P.fx = P.x; P.fy = P.y; }
  ['hop', 'wave', 'spin', 'bonk'].forEach(k => (P[k] = Math.max(0, P[k] - dt)));
  // trail: item k follows k+1 steps behind the player along the path walked
  const chain = [{ x: P.x, y: P.y }].concat(hist);
  trail.forEach((b, k) => {
    const a = chain[k + 2] || chain[chain.length - 1], c = chain[k + 1] || chain[chain.length - 1];
    let tx = lerp(a.x, c.x, P.moving ? pt : 1) * T, ty = lerp(a.y, c.y, P.moving ? pt : 1) * T;
    if (b.join < 1) { b.join = Math.min(1, b.join + dt / 0.3); tx = lerp(b.jx, tx, ease(b.join)); ty = lerp(b.jy, ty, ease(b.join)) - Math.sin(b.join * Math.PI) * 10; }
    b.px = tx; b.py = ty;
  });
  // berries flying into the bubble
  const L = bubbleLayout();
  for (let i = flying.length - 1; i >= 0; i--) {
    const b = flying[i]; b.flyT += dt / 0.36;
    if (b.flyT >= 1) { flying.splice(i, 1); landed(b); continue; }
    if (b.flyT > 0 && L) { const s = L.slots[b.slot], e = ease(b.flyT); b.sx = lerp(b.fromX - cam.x + 8, s.x + 5, e); b.sy = lerp(b.fromY - cam.y + 10, s.y + 9, e) - Math.sin(b.flyT * Math.PI) * 18; }
  }
  berries.forEach(b => { if (b.spawn < 1) b.spawn = Math.min(1, b.spawn + dt / 0.5); if (b.nope > 0) b.nope -= dt; });
  BEARP.bounce = Math.max(0, BEARP.bounce - dt); BEARP.talkCd = Math.max(0, BEARP.talkCd - dt); BEARP.dance = Math.max(0, BEARP.dance - dt); BEARP.hop = Math.max(0, BEARP.hop - dt);
  BEARP.blink -= dt; if (BEARP.blink < -0.12) BEARP.blink = 2 + rnd() * 3;
  if (heartShown > 0) heartShown += dt; musicDuck = Math.max(0, musicDuck - dt);
  if (TENT.shown && TENT.pop < 1) TENT.pop = Math.min(1, TENT.pop + dt / 0.5);
  if (LOG.roll > 0 && LOG.roll < 1) LOG.roll = Math.min(1, LOG.roll + dt / 1.4);
  duck.t += dt; duck.x += duck.vx * dt; if (duck.x > 14.2 || duck.x < 8) duck.vx *= -1;
  // camera
  const tgt = camTarget || { x: P.px + 8 - W / 2, y: P.py + 8 - H / 2 };
  const k = Math.min(1, dt * (camTarget ? 3 : 7));
  cam.x = clamp(lerp(cam.x, tgt.x, k), 0, MW * T - W); cam.y = clamp(lerp(cam.y, tgt.y, k), 0, MH * T - H);
  for (let i = parts.length - 1; i >= 0; i--) { const p = parts[i]; p.t += dt; if (p.t >= p.life) { parts.splice(i, 1); continue; } p.vy += (p.grav || 0) * dt; p.x += p.vx * dt + (p.wob ? Math.sin(p.t * 5 + p.wob) * 0.4 : 0); p.y += p.vy * dt; }
  for (let i = pops.length - 1; i >= 0; i--) { pops[i].t += dt; if (pops[i].t > 1) pops.splice(i, 1); }
  if (!busy && !P.moving) idleT += dt;
  saveT -= dt; if (dirty && saveT <= 0) { save(); dirty = false; saveT = 1; }
  musicTick();
}

// ---------- render ----------
const sx = x => Math.round(x - cam.x), sy = y => Math.round(y - cam.y);
const bearOnScreen = () => { const bx = BEARP.x * T + 8 - cam.x, by = BEARP.y * T + 8 - cam.y; return bx > -12 && bx < W + 12 && by > -10 && by < H + 30; };
function bubbleLayout() {
  if (Q.ask >= 2 && heartShown <= 0) return null;
  if (!bearOnScreen() && !flying.length) return null;
  const bx = sx(BEARP.x * T + 8), by = sy(BEARP.y * T - 8);
  if (heartShown > 0 || Q.ask >= 2) { const w = 22, h = 18; return { heart: true, x: clamp(bx - w / 2, 2, W - w - 2), y: by - h - 6, w, h, tailX: bx }; }
  const n = ask().need, w = 6 + n * 11 + 4 + 12, h = 20;
  const x = clamp(bx - w / 2, 2, W - w - 2), y = Math.max(2, by - h - 6);
  const slots = []; for (let i = 0; i < n; i++) slots.push({ x: x + 4 + i * 11, y: y + 4 });
  return { x, y, w, h, tailX: clamp(bx, x + 6, x + w - 6), slots, digitX: x + w - 15 };
}
function drawBubble() {
  const L = bubbleLayout(); if (!L) return;
  const pulse = BEARP.bounce > 0 ? Math.sin(BEARP.bounce / 0.4 * Math.PI) * 3 : 0;
  const x = L.x, y = Math.round(L.y - pulse), w = L.w, h = L.h;
  // box with rounded corners, dark outline, and a tail pointing at the bear
  g.fillStyle = C.ink; g.fillRect(x + 1, y - 1, w - 2, h + 2); g.fillRect(x - 1, y + 1, w + 2, h - 2); g.fillRect(x, y, w, h);
  g.fillStyle = C.bubble; g.fillRect(x + 1, y, w - 2, h); g.fillRect(x, y + 1, w, h - 2);
  const tx = Math.round(L.tailX);
  g.fillStyle = C.ink; g.fillRect(tx - 4, y + h, 9, 1); g.fillRect(tx - 3, y + h + 1, 7, 1); g.fillRect(tx - 2, y + h + 2, 5, 1); g.fillRect(tx - 1, y + h + 3, 3, 1); g.fillRect(tx, y + h + 4, 1, 1);
  g.fillStyle = C.bubble; g.fillRect(tx - 3, y + h - 1, 7, 1); g.fillRect(tx - 2, y + h, 5, 1); g.fillRect(tx - 1, y + h + 1, 3, 1); g.fillRect(tx, y + h + 2, 1, 1);
  if (L.heart) { const s = 1 + Math.max(0, Math.sin(time * 6)) * 0.0; blit(art('heart'), x + w / 2, y + h - 4 - Math.round(Math.sin(time * 5))); return; }
  L.slots.forEach((s, i) => {
    const filled = i < Q.given;
    blit(filled ? art('berry') : SPR.berryGhost, s.x + 5, s.y + 12 - (filled && i === Q.given - 1 && BEARP.bounce > 0 ? 2 : 0));
  });
  digit(ask().need, L.digitX, y + 3, 2, C.ink);
  // the counter: how many so far, in a gold chip under the bubble's left edge
  if (Q.given > 0) {
    const bump = pops.length && pops[pops.length - 1].t < 0.25 ? 1 : 0, cx = x + 3 - bump, cy = y + h + 2 - bump, cw = 13 + bump * 2, ch = 15 + bump * 2;
    g.fillStyle = C.ink; g.fillRect(cx, cy, cw, ch); g.fillStyle = C.gold; g.fillRect(cx + 1, cy + 1, cw - 2, ch - 2);
    g.fillStyle = C.goldDark; g.fillRect(cx + 1, cy + ch - 3, cw - 2, 2);
    digit(Q.given, cx + Math.round((cw - 5) / 2), cy + Math.round((ch - 9) / 2), 1, C.ink);
  }
}
function drawKid() {
  let dir = P.dir; if (P.spin > 0) dir = ['down', 'left', 'up', 'right'][Math.floor(P.spin * 10) % 4];
  const base = dir === 'left' || dir === 'right' ? 'side' : dir;
  const f = P.moving ? (P.steps % 2 ? 1 : 2) : 0;
  let x = P.px + 8, y = P.py + 15;
  if (P.bonk > 0) { const [dx, dy] = DIRS[P.bonkDir]; const k = Math.sin(P.bonk / 0.2 * Math.PI) * 3; x += dx * k; y += dy * k; }
  const hop = P.hop > 0 ? Math.sin(P.hop / 0.4 * Math.PI) * 7 : 0, bob = P.moving && P.t > 0.25 && P.t < 0.75 ? 1 : 0;
  g.fillStyle = C.shadow; g.fillRect(sx(x - 5), sy(P.py + 13), 10, 3);
  blit(art(`kid_${base}`, `kid_${base}_${f}`), sx(x), sy(y - hop - bob), dir === 'right');
  if (P.wave > 0 && Math.floor(P.wave * 10) % 2) { g.fillStyle = PAL.S; g.fillRect(sx(x + 6), sy(y - 14), 2, 3); }
}
function drawBear() {
  const x = BEARP.x * T + 8, y = BEARP.y * T + 16;
  let bob = 0, flip = false;
  if (BEARP.dance > 0) { const ph = Math.floor(BEARP.dance * 4); flip = ph % 2 === 0; bob = Math.abs(Math.sin(BEARP.dance * 4 * Math.PI)) * 5; }
  else if (BEARP.hop > 0) bob = Math.sin(BEARP.hop / 0.35 * Math.PI) * 4;
  else bob = Math.sin(time * 2) > 0.95 ? 1 : 0;
  g.fillStyle = C.shadow; g.fillRect(sx(x - 9), sy(y - 3), 18, 4);
  const im = art('bear'); blit(im, sx(x), sy(y - bob), flip);
  if (im === SPR.bear && BEARP.blink < 0 && BEARP.dance <= 0) { const ox = sx(x) - 11, oy = sy(y - bob) - 22; g.fillStyle = PAL.B; g.fillRect(ox + 6, oy + 7, 2, 2); g.fillRect(ox + 14, oy + 7, 2, 2); g.fillStyle = C.ink; g.fillRect(ox + 6, oy + 8, 2, 1); g.fillRect(ox + 14, oy + 8, 2, 1); }
}
function drawFire() {
  const X = sx(FIRE.x * T), Y = sy(FIRE.y * T);
  [[2, 12], [6, 14], [11, 13], [13, 9], [1, 8]].forEach(([i, j]) => { disc(g, X + i, Y + j, 2, C.stoneDark); disc(g, X + i, Y + j - 1, 1, C.stone); });
  g.fillStyle = C.ink; g.fillRect(X + 3, Y + 10, 10, 4); g.fillStyle = C.wood; g.fillRect(X + 4, Y + 11, 8, 2);
  const fl = k => Math.round(Math.sin(time * 9 + k) * 1.5 + Math.sin(time * 13 + k * 2));
  const flame = (cx, h, col) => { g.fillStyle = col; for (let j = 0; j < h; j++) { const wdt = Math.max(1, Math.round((h - j) * 0.55)); g.fillRect(X + cx - (wdt >> 1), Y + 11 - j, wdt, 1); } };
  flame(8, 10 + fl(0), C.flame3); flame(6, 7 + fl(1), C.flame); flame(10, 7 + fl(2), C.flame); flame(8, 5 + fl(3), C.flame2);
  if (Math.floor(time * 6) % 3 === 0) { g.fillStyle = C.flame2; g.fillRect(X + 7 + fl(4), Y - 2 + fl(5), 1, 1); }
}
function drawLog() {
  if (LOG.gone) return;
  const r = LOG.roll, X = sx(LOG.x * T + r * 46), Y = sy(LOG.y * T) + 2;
  g.globalAlpha = r > 0.7 ? 1 - (r - 0.7) / 0.3 : 1;
  g.fillStyle = C.shadow; g.fillRect(X + 2, Y + 11, 28, 3);
  g.fillStyle = C.ink; g.fillRect(X + 1, Y - 1, 30, 14); g.fillStyle = C.wood; g.fillRect(X + 2, Y, 28, 12);
  g.fillStyle = C.woodDark; for (let i = 0; i < 4; i++) { const ph = ((i * 7 + r * 60) % 28); g.fillRect(X + 2 + ph, Y + 2 + (i % 2) * 5, 5, 1); }
  disc(g, X + 29, Y + 6, 6, C.ink); disc(g, X + 29, Y + 6, 5, C.woodEnd); disc(g, X + 29, Y + 6, 2, C.woodRing);
  g.fillStyle = C.ink; const a = r * 12; g.fillRect(X + 29 + Math.round(Math.cos(a) * 3), Y + 6 + Math.round(Math.sin(a) * 3), 1, 1);
  g.globalAlpha = 1;
}
function drawTent() {
  if (!TENT.shown) return;
  const s = TENT.pop < 1 ? 0.4 + Math.sin(TENT.pop * Math.PI * 0.75) * 0.75 : 1;
  const X = sx(TENT.x * T + 8), Y = sy(TENT.y * T + 15), h = Math.round(18 * s), w = Math.round(13 * s);
  for (let j = 0; j <= h; j++) { const half = Math.round(w * j / h); g.fillStyle = C.ink; g.fillRect(X - half - 1, Y - h + j, half * 2 + 3, 1); g.fillStyle = j > 1 ? C.tent : C.ink; g.fillRect(X - half, Y - h + j, half, 1); g.fillStyle = j > 1 ? C.tentDark : C.ink; g.fillRect(X, Y - h + j, half + 1, 1); }
  g.fillStyle = C.tentDoor; const dh = Math.round(h * 0.55); for (let j = 0; j < dh; j++) { const half = Math.round(4 * s * j / dh); g.fillRect(X - half, Y - dh + j, half * 2 + 1, 1); }
  g.fillStyle = C.gold; g.fillRect(X, Y - h - 4, 1, 4); g.fillRect(X + 1, Y - h - 4, 3, 2);
}
function drawBerry(b) {
  if (b.state === 'ground') {
    if (b.ask !== Q.ask || b.spawn <= 0) return;
    const s = b.spawn, wig = b.nope > 0 ? Math.round(Math.sin(b.nope * 40) * 1.5) : 0;
    const bob = Math.round(Math.sin(time * 3 + b.id) * 1.2) + (s < 1 ? Math.round((1 - s) * 12) : 0);
    g.fillStyle = C.shadow; g.fillRect(sx(b.x * T + 4), sy(b.y * T + 12), 8, 2);
    blit(art('berry'), sx(b.x * T + 8 + wig), sy(b.y * T + 12 - bob));
    if (Math.floor(time * 2 + b.id) % 5 === 0) { g.fillStyle = '#ffffff'; g.fillRect(sx(b.x * T + 11), sy(b.y * T + 2 - bob), 1, 1); }
  } else if (b.state === 'trail') {
    const k = trail.indexOf(b), bob = Math.round(Math.abs(Math.sin(time * 6 + k)) * 2);
    g.fillStyle = C.shadow; g.fillRect(sx(b.px + 4), sy(b.py + 12), 8, 2);
    blit(art('berry'), sx(b.px + 8), sy(b.py + 12 - bob));
  }
}
function drawHint() {
  if (busy || idleT < 5) return;
  const tgt = hintTarget(); if (!tgt) return;
  const path = findPath(tgt).slice(0, 8); if (!path.length) return;
  path.forEach(([x, y], i) => {
    const a = 0.3 + 0.7 * Math.max(0, Math.sin(time * 4 - i * 0.7)); g.globalAlpha = a;
    const prev = i ? path[i - 1] : [P.x, P.y], horiz = prev[1] === y, side = i % 2 ? 1 : -1;
    const fx = sx(x * T + 8 + (horiz ? 0 : side * 3)) - 2, fy = sy(y * T + 8 + (horiz ? side * 3 : 0)) - 2, fw = horiz ? 5 : 4, fh = horiz ? 4 : 5;
    g.fillStyle = C.grassDark; g.fillRect(fx, fy + 1, fw, fh);
    g.fillStyle = C.glow; g.fillRect(fx, fy, fw, fh); g.fillStyle = '#ffffff'; g.fillRect(fx + 1, fy + 1, fw - 2, fh - 2);
  });
  g.globalAlpha = 1;
  const [nx, ny] = path[0], dir = nx > P.x ? 'right' : nx < P.x ? 'left' : ny < P.y ? 'up' : 'down';
  if (!P.moving) P.dir = dir;
  drawPad(dir);
}
function drawPad(dir) {   // small D-pad, bottom-left, the arm to press glows
  const X = 6, Y = H - 26, on = Math.sin(time * 6) > -0.2;
  g.fillStyle = C.ink; g.fillRect(X + 6, Y - 1, 8, 22); g.fillRect(X - 1, Y + 6, 22, 8);
  g.fillStyle = '#4a4458'; g.fillRect(X + 7, Y, 6, 20); g.fillRect(X, Y + 7, 20, 6);
  g.fillStyle = '#3a3448'; g.fillRect(X + 8, Y + 8, 4, 4);
  const arm = { up: [X + 7, Y, 6, 7], down: [X + 7, Y + 13, 6, 7], left: [X, Y + 7, 7, 6], right: [X + 13, Y + 7, 7, 6] }[dir];
  g.fillStyle = on ? C.gold : '#6a6478'; g.fillRect(...arm);
}
function drawEdge() {   // hands full and the bear is off screen: the bear's face at the edge, pointing home
  if (!fullHands() || busy) return;
  if (bearOnScreen()) return;
  const bx = BEARP.x * T + 8 - cam.x, by = BEARP.y * T + 4 - cam.y;
  const cx = clamp(bx, 16, W - 16), cy = clamp(by, 16, H - 16), pul = Math.round(Math.sin(time * 6) * 1.5);
  const ang = Math.atan2(by - cy, bx - cx), ax = cx + Math.cos(ang) * (14 + pul), ay = cy + Math.sin(ang) * (14 + pul);
  g.fillStyle = C.ink; for (let i = 0; i < 5; i++) { const w = 5 - i; g.fillRect(Math.round(ax - Math.cos(ang) * i - w / 2), Math.round(ay - Math.sin(ang) * i - w / 2), w, w); }
  g.fillStyle = C.gold; for (let i = 1; i < 4; i++) { const w = 4 - i; g.fillRect(Math.round(ax - Math.cos(ang) * (i + 1) - w / 2), Math.round(ay - Math.sin(ang) * (i + 1) - w / 2), w, w); }
  disc(g, cx, cy, 12, C.ink); disc(g, cx, cy, 11, C.bubble);
  const f = art('bear_face'); g.drawImage(f, Math.round(cx - f.width / 2), Math.round(cy - f.height / 2) + 1);
}
function render() {
  g.drawImage(ground, -Math.round(cam.x), -Math.round(cam.y));
  // water sparkle + pond duck
  for (let y = 1; y <= 3; y++) for (let x = 7; x <= 15; x++) if (map[y][x] === 'w' && Math.floor(time * 1.5 + hash(x, y, 4) * 6) % 6 === 0) { g.fillStyle = C.wave; g.fillRect(sx(x * T + 3 + hash(x, y, 8) * 8), sy(y * T + 5 + hash(x, y, 6) * 6), 4, 1); }
  blit(art('duck'), sx(duck.x * T), sy(duck.y * T + 12 + Math.round(Math.sin(duck.t * 3))), duck.vx > 0);
  drawHint();
  // depth-sorted things
  const things = [];
  berries.forEach(b => { if (b.state === 'ground') things.push([b.y * T + 1, () => drawBerry(b)]); });
  trail.forEach(b => things.push([b.py + 2, () => drawBerry(b)]));
  things.push([P.py + 3, drawKid], [BEARP.y * T + 4, drawBear], [FIRE.y * T, drawFire], [LOG.y * T, drawLog], [TENT.y * T + 4, drawTent]);
  things.sort((a, b) => a[0] - b[0]).forEach(t => t[1]());
  parts.forEach(p => { if (p.screen) return; if (p.heart) { g.globalAlpha = 1 - p.t / p.life; blit(art('heart'), sx(p.x), sy(p.y)); g.globalAlpha = 1; return; } g.fillStyle = p.col; g.fillRect(sx(p.x), sy(p.y), p.sz, p.sz); });
  drawBubble();
  flying.forEach(b => { if (b.flyT > 0) blit(art('berry'), Math.round(b.sx), Math.round(b.sy)); });
  pops.forEach(p => { const a = p.t < 0.7 ? 1 : 1 - (p.t - 0.7) / 0.3; g.globalAlpha = a; digit(p.n, p.x - 5, p.y - 16 - p.t * 14, 2, '#ffffff', C.ink); g.globalAlpha = 1; });
  parts.forEach(p => { if (!p.screen || p.t < 0) return; g.fillStyle = p.col; g.fillRect(Math.round(p.x), Math.round(p.y), p.sz, p.sz + (Math.sin(p.t * 9 + (p.wob || 0)) > 0 ? 1 : 0)); });
  drawEdge();
}

function tick(dt) { update(Math.min(0.05, Math.max(0, dt))); render(); if (opts.onFrame) opts.onFrame(cv); }
let running = false, last = 0, raf = 0;
function frame(now) { if (!running) return; tick((now - last) / 1000); last = now; raf = requestAnimationFrame(frame); }
function start() { if (running) return; running = true; paused = false; last = performance.now(); raf = requestAnimationFrame(frame); }
function stop() { running = false; paused = true; cancelAnimationFrame(raf); if (musicBus && AC) musicBus.gain.setTargetAtTime(0, AC.currentTime, 0.05); held.clear(); }
function wake() { ensureAudio(); paused = false; }
function reset() { try { store && store.remove && store.remove('camp'); } catch (e) {} map[TENT.y][TENT.x] = '.'; newState(); }
if (opts.autoLoop !== false) start(); else render();
return { canvas: cv, width: W, height: H, press, release, tick, start, stop, wake, reset,
  pause: () => { paused = true; save(); },
  get state() { return busy ? 'busy' : Q.ask >= 2 ? 'done' : 'ask' + Q.ask; },
  _debug: code => eval(code) };
}
const LittleCamp = { create, SPRITE_SRC };
if (typeof module !== 'undefined' && module.exports) module.exports = LittleCamp;
root.LittleCamp = LittleCamp;
})(typeof window !== 'undefined' ? window : globalThis);
