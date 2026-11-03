// =====================================================================
// LINE CUTTER — the game only. No hardware frame, no DOM input.
//
//   const game = LineCutter.create({ canvas });   // canvas optional; it's made 240x160
//   game.press('a');        // 'a' 'b' 'start' 'select' 'up' 'down' 'left' 'right'
//   game.canvas             // draw it, or use it as a WebGL texture
//   game.pause()            // open the pause menu (e.g. the player looked away); Start resumes
//   game.paused             // true while the pause menu is up
//
// Options:
//   canvas    an existing <canvas>/OffscreenCanvas to draw into (default: a new one)
//   autoLoop  true (default) runs its own requestAnimationFrame loop.
//             false: call game.tick(dtSeconds) from your own render loop.
//   onFrame   called after every rendered frame (e.g. set texture.needsUpdate = true)
//   audio     false to mute; or pass an AudioContext to share yours
//             (game.wake() starts audio + music from your own gesture, e.g. focusing the device)
//   music     false for no music
//   titleTrack URL of the looping title-screen song (default: title-loop.mp3 next to this
//             script); false to use the built-in chiptune title theme instead
//   matchTrack same for the on-the-line song (default: match-loop.mp3, bed left / top right)
// =====================================================================
(function (root) {
'use strict';
const SCRIPT_URL = (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) || '';
function create(opts = {}) {
const W = 240, H = 160;
const cv = opts.canvas || document.createElement('canvas');
cv.width = W; cv.height = H;
const ctx = cv.getContext('2d');
ctx.imageSmoothingEnabled = false;

// ---------- TUNING KNOBS ----------
const T = {
  ringR: 4.8,          // px per scoring ring (10 rings)
  arrowR: 0.6,         // arrow shaft radius, for line cutters
  crawlPx: 8,          // vertical px per crawl step off the true crawl (~1.7 rings: a wrong crawl loses matches)
  drawSpeed: 0.7,     // needle speed (meter units / s)
  tradDrawSpeed: 1.0,
  anchor: 0.9,         // anchor mark on the meter
  meterMax: 1.8,       // end of the meter: never anchor and it's a let down (anchor sits mid-bar)
  anchorHalf: 0.035,   // half-width of the gold anchor zone
  anchorErrPx: 200,    // px the point starts off-center per meter unit you miss the anchor by
  springZeta: 0.12,    // swing damping: higher = each swing reaches less far toward the X
  steadyTime: 2.5,     // seconds of steady hold before fatigue
  maxHold: 6,          // seconds before your arms give out
  floatBase: 4.6,      // px of point float when settled (novice; gear shrinks it)
  formSpread: 11,     // px random form error per shot (novice; gear shrinks it)
  pluckPre: 0.04,      // s before a heartbeat where a release plucks
  pluckPost: 0.13,     // s after a heartbeat (while the pulse kicks the bow)
  kickPx: 1.6,         // px the pulse kicks the point (scales with BPM + distance)
  windPx: 2.8,         // px arrow drift per wind unit (x distance factor)
  windSway: 0.9,       // px the wind pushes the bow (the point) per wind unit
  holdoffPx: 1.5,      // px per L/R aim-off step
};
// ---------- ARCHER'S-EYE VIEW (tweak freely) ----------
// Your eye focuses on the target, so the arrow and string are out of focus:
// translucent, soft-edged. GBA hardware had alpha blending, so this is legit.
const VIEW = {
  pointLen: 11,        // px, length of the steel point taper
  arrowWidth: 20,      // px, shaft width just behind the point
  arrowTaper: 0.15,    // how much wider the shaft gets toward your eye (0 = parallel)
  pointAlpha: 0.75,    // 1 = solid
  shaftAlpha: 0.5,
  edgeSoft: 3,         // px of soft falloff on each edge (blur)
  stringOffset: 14,    // px right of the aim point where the blurry string sits
  stringWidth: 9,      // px, width of the string blur
  stringAlpha: 0.22,
};
const TX = 120, TY = 64;  // target centre (high enough to leave a strip of ground below for the HUD)

const ROUNDS = [
  { name: 'ROUND OF 16', venue: 'COUNTY HALL', bg: 'hall', dist: 18, distK: 1.0, faceCm: 40, crawl: 8, spreadK: 1.0, match: true,
    wind: null, crowd: 4, gusty: false, panic: false, sub: 'INDOORS. LEAGUE NIGHT VIBES.',
    opp: { name: 'BRENDA', tag: 'LEAGUE NIGHT', icon: 'brenda', fixed: 5, blurb: 'Thirty years of league nights. Never missed one.' },
    tips: ['A: DRAW, A AGAIN: ANCHOR IN THE GOLD', 'LOOSE IN THE QUIET, NOT ON THE SPIKE', 'SET PLAY: WIN AN END +2.'] },
  { name: 'QUARTERFINAL', venue: 'FAIRGROUNDS', bg: 'fair', dist: 30, distK: 1.35, faceCm: 80, crawl: 4, spreadK: 1.1, match: true,
    wind: [-2, 2], crowd: 14, gusty: false, panic: false, sub: 'CROWD +14 BPM. STEADY WIND.',
    opp: { name: 'DALE', tag: 'THE TALKER', icon: 'dale', sd: 10.0, flier: 0.15, chatty: true, blurb: '61. Three bows. Has notes on yours.' },
    tips: ['AIM INTO THE WIND WITH L/R.'] },
  { name: 'SEMIFINAL', venue: 'FAIRGROUNDS', bg: 'fair', dist: 30, distK: 1.35, faceCm: 80, crawl: 4, spreadK: 1.1, match: true,
    wind: [-2, 2], crowd: 18, gusty: false, panic: false, sub: 'CROWD +18 BPM. HIS RIG HUMS.',
    opp: { name: 'CHAD', tag: 'CONTENT CREATOR', icon: 'chad', sd: 9.5, blurb: 'Has a YouTube channel. Eleven subscribers.' },
    tips: ['AIM INTO THE WIND WITH L/R.'] },
  { name: 'FINALS', venue: 'RIDGE FIELD', bg: 'ridge', dist: 50, distK: 1.8, faceCm: 122, crawl: 1, spreadK: 1.25, match: true,
    wind: [-3, 3], crowd: 8, gusty: true, panic: true, sub: 'GUSTS. TARGET PANIC.',
    opp: { name: 'THE KID', tag: 'PRODIGY', icon: 'kid', sd: 7.6, tilt: true, blurb: '14. Never misses. Until he does.' },
    tips: ['GUSTS SHIFT MID-HOLD.', 'THE GOLD MAKES YOUR HEART RACE.', 'WIN AN END BIG (28+, OR BY 4) AND HE TILTS.'] },
];
// Rivals: each bracket slot has its regular (above) plus rivals you unlock across runs, win or lose.
// Once unlocked they're shuffled into their slot on the draw sheet; one you've never faced is guaranteed a spot.
// how: the unlock, as shown on the RIVALS screen. news: its card, shown when the run ends.
const RIVALS = {
  hank:     { slot: 0, name: 'HANK', tag: 'TRAD GUY', icon: 'hank', sd: 15, flier: 0.12, thunk: true,
    blurb: 'Longbow. Cedar arrows. Done before you anchor.', how: 'WIN A MATCH', news: 'Word got around the hall. Hank wants a go.' },
  judy:     { slot: 1, name: 'JUDY', tag: 'THE JUDGE', icon: 'judy', sd: 12, judge: true,
    blurb: 'Range official. Also shooting. Calls every line.', how: 'LOSE TO DALE', news: 'Dale filed a complaint about you.' },
  viktor:   { slot: 2, name: 'VIKTOR', tag: 'THE COACH', icon: 'viktor', sd: 8.0, counts: true,
    blurb: 'Coached two Olympians. Counts your hold out loud.', how: 'WIN A SIDE BET', news: 'Somebody told Viktor you gamble.' },
  margaret: { slot: 3, name: 'MARGARET', tag: 'THE LEGEND', icon: 'margaret', sd: 9.4, lockin: true,
    blurb: "79. Munich, '72. Gets better when you do.", how: 'WIN THE OPEN', news: 'A legend read about you in the club newsletter.' },
};
const RIV_KEY = 'linecutter_rivals';
const RIV = (() => { try { return JSON.parse(localStorage.getItem(RIV_KEY)) || {}; } catch (e) { return {}; } })();
RIV.on = RIV.on || {}; RIV.met = RIV.met || {};
const saveRiv = () => { try { localStorage.setItem(RIV_KEY, JSON.stringify(RIV)); } catch (e) {} };
RIV.news = RIV.news || [];   // rivals unlocked this run, saved so a reload keeps them: a card each when the run ends
const NEWS = RIV.news; let newsT = 0;
function unlock(k) { if (RIV.on[k] || !RIVALS[k]) return; RIV.on[k] = true; NEWS.push(k); saveRiv(); }
const REGULAR = Object.fromEntries(ROUNDS.map(R => [R.opp.icon, R.opp]));
const oppDef = k => RIVALS[k] || REGULAR[k];
// Brenda always teaches the first run; after that each slot draws from its regular and its unlocked rivals.
function drawSheet(first) {
  return ROUNDS.map((R, i) => {
    if (first && i === 0) return R.opp.icon;
    const pool = Object.keys(RIVALS).filter(k => RIVALS[k].slot === i && RIV.on[k]), fresh = pool.filter(k => !RIV.met[k]);
    if (fresh.length) return fresh[0];
    const all = [R.opp.icon].concat(pool); return all[Math.floor(Math.random() * all.length)];
  });
}
const oppAt = i => (G && G.draw && oppDef(G.draw[i])) || ROUNDS[i].opp;
// ---------- rival scaling ----------
// Rivals are tuned by the average arrow they shoot (wind included), not by group size. The Open is two seasons of
// four: eight matches on one straight ramp up to 29 an end for the last final. No reset between
// seasons (you keep your kit, so they mustn't fall back). A rival's `avgK` nudges their slot target; fliers are part of the average.
// The first match of the Open sits RIVAL_OPEN under the ramp (Brenda shoots 15, not 18): steady reds win it on a bare
// kit and chasing the gold loses it, so the bar teaches the red before your gear makes gold worth it (tools/opener.js).
const SEASONS = 2, RIVAL_START = 6.0, RIVAL_END = 29 / 3;
const RIVAL_STEP = (RIVAL_END - RIVAL_START) / (SEASONS * 4 - 1), RIVAL_CAP = RIVAL_END, RIVAL_OPEN = 1.0;
const RIVAL_DRIFT = 0.25;   // how far a rival's whole group wanders end to end (x their spread): low keeps them steady, no freak 28s
const rivalTarget = (i, O) => { const m = ((G ? G.season : 1) - 1) * 4 + i;
  return Math.min(RIVAL_CAP, RIVAL_START + RIVAL_STEP * m + (O.avgK || 0) - (m === 0 ? RIVAL_OPEN : 0)); };
// Expected score per arrow for a group of per-axis spread S (plus that end's drift), with fliers at 2.5x.
function groupAvg(S, flier) {
  const e = sg => { let t = 0; for (let j = 1; j <= 10; j++) t += 1 - Math.exp(-Math.pow(j * T.ringR + T.arrowR, 2) / (2 * sg * sg)); return t; };
  return (1 - flier) * e(S * Math.sqrt(1 + RIVAL_DRIFT * RIVAL_DRIFT)) + flier * e(S * Math.sqrt(RIVAL_DRIFT * RIVAL_DRIFT + 6.25));
}
// The group size that shoots `target` on this range, after the range's typical wind has had its say.
// Better rivals read the wind better: below an 8 they eat all of it, at the cap only a third.
const windRead = target => clamp(1 - (target - 8) * 0.5, 0.35, 1);
function sdForAvg(target, R, flier = 0) {
  let lo = 0.3, hi = 60;
  for (let n = 0; n < 40; n++) { const m = (lo + hi) / 2; if (groupAvg(m, flier) > target) lo = m; else hi = m; }
  const wind = R.wind ? Math.max(Math.abs(R.wind[0]), Math.abs(R.wind[1])) / Math.sqrt(3) * (R.gusty ? 1.3 : 1) * 1.6 * R.distK * windRead(target) : 0;
  return Math.sqrt(Math.max(1, lo * lo - wind * wind));
}

// kind: 'gear' = equipment you buy, 'form' = technique you train; rituals bend the archery itself.
const RITUALS = {
  weights:  { kind: 'gear', name: 'Riser Weights', icon: 'weights', desc: 'Heavier bow. Less float. Spread -20%.' },
  routine:  { kind: 'form', name: 'Shot Routine', icon: 'clock', desc: 'Settles 2x faster. Spread -25%.' },
  backten:  { kind: 'form', name: 'Back Tension', icon: 'back', desc: 'Holds steady longer. Spread -20%.' },
  tuned:    { kind: 'gear', name: 'Tuned Arrows', icon: 'tuned', desc: 'Plucks hurt half. Spread -45%.' },
  anchor:   { kind: 'form', name: 'Deep Anchor', icon: 'anchor', desc: 'Anchor zone 2x wide. Spread -20%.' },
  plunger:  { kind: 'gear', name: 'Spring Plunger', icon: 'plunger', desc: 'L/R moves the arrow, not your aim. Spread -10%.' },
  grip:     { kind: 'gear', name: 'Grip Tape', icon: 'grip', desc: 'Pulse kicks 40% less. Spread -15%.' },
  fat:      { kind: 'gear', name: 'Fat Shafts', icon: 'fat', desc: 'Thick arrows. More line cutters.' },
  lucky:    { name: 'Lucky Tab', icon: 'tab', desc: 'One pluck per end is forgiven.' },
  breathe:  { kind: 'form', name: 'Breathe Out', icon: 'lungs', desc: '-12 BPM. Pulse kicks half as hard.' },
  notebook: { name: 'Notebook', icon: 'book', desc: 'Same crawl again: 12% tighter. Stacks.' },
  trad:     { name: 'Old Trad Guy', icon: 'hat', desc: 'No hold, fast draw. Spread -25%.' },
  inner:    { name: 'Inner Ten', icon: 'xring', desc: 'Your Xs count as 11.' },
  nolook:   { name: 'Never Look at the Scoreboard', icon: 'eye', desc: 'Scores hidden. -15 BPM.' },
  coach:    { name: "Coach's Voice", icon: 'coach', desc: 'Bad arrow? Next one is 40% tighter.' },
  ice:      { name: 'Ice Water', icon: 'ice', desc: 'At match point: -20 BPM, spread -25%.' },
  // These bend the rules and charge for it (`cost`, printed in red). Every shop shows at least one.
  clicker:  { kind: 'gear', name: 'Tab Groove', icon: 'clicker', desc: 'Release in the groove: spread -50%.', cost: 'Any other time: +30%.' },
  limbs:    { kind: 'gear', name: 'Heavy Limbs', icon: 'limbs', desc: 'Flat and fast. Wind drift -60%.', cost: 'Arms give out at 3.5s.' },
  earplugs: { kind: 'gear', name: 'Earplugs', icon: 'plugs', desc: 'No chatter, no crowd, no foot tapping.', cost: "Can't hear your heart." },
  instinct: { kind: 'form', name: 'Instinctive', icon: 'instinct', desc: 'Spread -30%.', cost: 'No spread ghost.' },
  closer:   { name: 'The Closer', icon: 'closer', desc: 'Last arrow of each end counts double.', cost: "First one counts 0. Heart +12." },
  // meters rituals (free practice prototype): only their icons are used from here
  redgold:  { name: 'Red Is Gold', icon: 'closer', desc: '' }, bullseye: { name: 'Bullseye', icon: 'xring', desc: '' },
  gamble:   { name: 'All or Nothing', icon: 'dice', desc: '' }, highstakes: { name: 'High Stakes', icon: 'dice', desc: '' }, grouping: { name: 'Grouping', icon: 'book', desc: '' },
  lastarrow:{ name: 'The Closer', icon: 'closer', desc: '' }, perfect: { name: 'Perfectionist', icon: 'eye', desc: '' },
  allin:    { name: 'All or Nothing', icon: 'dice', desc: 'Xs score 15.', cost: 'Under 8 scores 0.' },
};
// Side bets: a bale mate bets their gear against yours (or a set point) on how your next end goes.
// need(round) sets the bar when the bet is made; BET_LIM scales it to the distance so each is roughly a coin flip.
// Bets count real ring scores, not what your rituals make of them.
// With Spare Arrow an end has 4; bets (like the score) count your best 3 and ignore the one that drops.
const counted = arr => arr.length <= 3 ? arr : arr.slice().sort((a, b) => b.s.v - a.s.v).slice(0, 3);
const endSum = arr => counted(arr).reduce((s, a) => s + a.s.v, 0);
const BETS = [
  { id: 'ten',   need: () => 10,                card: () => 'HIT A 10 THIS END',        say: () => 'a ten this end',                     ok: arr => arr.some(a => a.s.v >= 10) },
  { id: 'red',   need: r => BET_LIM.red[r],     card: n => 'NO ARROW UNDER ' + n,       say: n => 'nothing under a ' + n + ' this end', ok: (arr, n) => counted(arr).every(a => a.s.v >= n) },
  { id: 'total', need: r => BET_LIM.total[r],   card: n => 'SHOOT ' + n + ' OR MORE',   say: n => n + ' or better this end',             ok: (arr, n) => endSum(arr) >= n },
  { id: 'last',  need: () => (G.myRaw || 0) + 1,      card: n => 'BEAT YOUR LAST END: ' + n + '+', say: n => 'better than your last end',     ok: (arr, n) => endSum(arr) >= n },
];
const BET_LIM = { red: [7, 6, 7, 6], total: [23, 22, 24, 23] };   // tuned with tools/sim.js: most land 40-60%; a ten is the long shot
const BET_RATE = { dale: 0.55, _: 0.3 };   // each rival offers at most one bet per run (G.betBy)
const BET_TALK = {
  brenda: { offer: (c, t, y) => ["Ooh, let's make it fun, hon. My " + t + ' says you can\'t get ' + c + '.', "If I win, I'm taking " + y + '.'],
    take: ["Oh, you're on!"], pass: ['Probably smart, hon.'], paid: ["Well, a deal's a deal. It's yours, hon."], took: ["Ooh. I'll take good care of it."], tookPt: ["That's a point for me, hon!"] },
  dale: { offer: (c, t, y) => ['Tell you what, friend. My ' + t + " says you don't get " + c + '.', "You miss, I'm taking " + y + '.'],
    take: ['Ha! Bold. I like bold.'], pass: ['Thought so. Smart. Sort of.'], paid: ["Huh. Fine. Take it. I've got three more at home."], took: ['Forty years, friend. Hand it over.'], tookPt: ["I'll take that point, friend."] },
  chad: { offer: (c, t, y) => ['Bro. Side bet. My ' + t + ' against ' + y + '.', 'You get ' + c + ", it's yours. Don't, and that's mine."],
    take: ["Let's gooo. I'm filming this."], pass: ["Content's dead, bro."], paid: ["Whatever. It's for the channel. Keep it."], took: ['Unboxing this tonight, bro.'], tookPt: ['Free point. Clip that.'] },
  kid: { offer: (c, t, y) => ["Bet you don't get " + c + '.', 'My ' + t + '. ' + y[0].toUpperCase() + y.slice(1) + '.'],
    take: ['Okay.'], pass: ['Okay.'], paid: ['...huh. Take it.'], took: ['Thanks.'], tookPt: ['Point.'] },
};
Object.assign(BET_TALK, {
  hank: { offer: (c, t, y) => ['Friendly wager? My ' + t + " says you don't get " + c + '.', 'Lose, and ' + y + ' comes home with me.'],
    take: ['Atta way.'], pass: ['Fair enough.'], paid: ["Shoot. Fair's fair."], took: ['Much obliged.'], tookPt: ["I'll take that point, thanks."] },
  judy: { offer: (c, t, y) => ['Strictly off the record. My ' + t + " says you don't get " + c + '.', "If you don't, " + y + ' is forfeit.'],
    take: ['Recorded.'], pass: ['Sensible.'], paid: ['Rules are rules. Take it.'], took: ['Forfeit. Thank you.'], tookPt: ['Point awarded. To me.'] },
  viktor: { offer: (c, t, y) => ['We make a bet. My ' + t + ' says you do not get ' + c + '.', 'You lose, I take ' + y + '.'],
    take: ['Good. Brave.'], pass: ['Smart. Boring.'], paid: ['Take it. You earned.'], took: ['Is mine now.'], tookPt: ['Point for me.'] },
  margaret: { offer: (c, t, y) => ['A little wager, dear? My ' + t + " says you won't get " + c + '.', "If I'm right, I'll take " + y + '.'],
    take: ['Good for you.'], pass: ['Wise.'], paid: ["Fair's fair, dear. Enjoy it."], took: ["I'll put it to good use."], tookPt: ['My point, I think.'] },
});
const BET_CHATTER = ['STILL WANT THAT BET?', 'GONNA MISS THAT GEAR?', 'NO PRESSURE, FRIEND.'];
const CHATTER = ['YOU SHOOTING CARBONS?', "I'D GO 3 UNDER, MAN", 'MY KID DOES THIS TOO', 'IS THAT A NEW RISER?',
  "YOU'RE CANTING, BUDDY", "WIND'S TRICKY, HUH?", 'I SHOT A 300 ONCE.', 'EVER SHOOT INSTINCTIVE?', 'STRING WALKING? WILD.', 'HOT IN HERE, HUH?'];

const C = {
  ink: '#16121f', dark: '#241c34', panel: '#2e2546', edge: '#6a5c96', text: '#f4ecd8', dim: '#a89cc8',
  gold: '#f4cf4a', red: '#e2553f', blue: '#4f9bd6', black: '#34323c', white: '#f2ead8', green: '#8fd46a',
  chip: '#5ab0f0', mult: '#f0584e', orange: '#f09a3e',
};
const NOCKS = ['#9cf26a', '#ff7ad0', '#6ae8f2'];

// Portraits: image-gen mockups crunched to native 64x64, ~22 colours, hard outline.
const PORTRAIT_SRC = {"dale": {"neutral": "data:image/png;base64,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", "defeat": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAQZElEQVR4nO2bbUxbV5rHf8bGHmNs4xfWxB5c8z4Q8ALFG4UwaVJppuyQNp2q0nZH6cx2q+18rDofOto3aVcZbdV+WWU/TrQd7TQaZbTZ2TKTTN2pNJN0SaIKEqcmgQYwoaYYLPwCJoYabLwfru/lGhwSsNP9sPOXLK6vzz33PP/znOftHOCP+CP+X0Pxf/lyl9melX+fiYW+8vGovuoXyoV2OJtpWF4HwGBQcRG+ckIeOwHbZ1lTaSeZSKEzaFAuJkFdDkAikUZTaZfa1bc6YHhYevZxkfFYCXCZ7dlWj4dEeFkQFnApy5nRKXCbtHToyqW2CmM5fbnr7PIGVycWSWodZKp1YpMslJ6Ix8KqOOvpTQtPm/QYDCpJ2Kvzaxw5oJXattdqC3cC3J5dYzS5QYeunKvza3ySWSd1P1RSEkquAS6zPevUOgBwW/NneTS5kSe8wli+43k52mu1MCu0+2GtliOza1ydV0MJtaGkBLjM9qym0o5LWS4JKs7gaHIjr63CWM5Bw8Nf316r5fbsGhhUtNdqaa/VYvhMRaDGBMPD2WJJKCvmYTlE4Q8p1Rw5oGU0uSEJPZrcIJFI52nDowgvQmEsZ1K5NdS//IaB6onFkoy7JBogF95gUO2Y7UQiXYrX5OHpw1a4DkBRWlC0BoiWXsSDhDVsm/E7eyDloEFFaiaZd68ps4nBoEJTad/haveCkiyBRHgZW0axQ0g55OpfKpSiz5IQoFxM4lLvbTDZ5Y2HN3oE2DLFOYKiCJCrvzj74l/5UniQZuxlGTwIbquW9KZl38ugaA0Y/WQal7pcElj8KwY/261/qSCSV2zfJQ+E5BowyoNnH3LL4BHcoegCb8+uoXHpWI+vl2wJPbZcYDfB5ZCHuw/DaHID7iwVObJ8lJSARCL9yIJfnV+Tro8c0Eph8W4BUjtCdCmqvz+0SiKRRmfQkLq/lYPsJS4oyoS6zPasmPCI2I0AOUFue8WeosHtWLWWYzZXEIutMhfP8PvrEWbWNwgrs3tKmEpGgFxw0RDOrG+tU3li9Kh5gAi5sAD3ptckGzBuqaAtvUFdvaAdg0NR3v88jqos+kgklFQDxBkQYTVX8vlMlOefMEkzvt31PYiIVeuWTbg3vcbQZ4k8QkVMJ78EoF73NVzqcgwGFT0Hqzg7lmAuOPFQEkpCgIiOQ/UA9LZWS/eujS8yPT4nJUkal46mzKZEhJwAUehpXwKFsZxz/qgkZL3ua7itWlROI23pDdQmNevxdc75o9LvAGFlFltGgdsqaMTF2aldSSiagOePPAlAOriMT1FG/7FGAKKBMJYGm0SCvCrktmpx2yt29OcPreKPrOUJ9KC2apMah0nJpWCaC/8zI7WX45TbwtBnCT5ennkgCfsmQBT+5U4DAPYaDb+5GOI/5r/EU6unv78RTaWCIV+CaCBMp17ByJ0lSUA5dAYNAMlESvpuyyg45bYwpipnwKni3vQaY6pyOvUKHCal9OxuBIBA4G42oSg32KlXcGMkij+0ysk+C8+esDPmXcTSYGN4cgUQNGHAqWIunsFtr0DlNOIOLvNRfDWvL6u5klMvdBINhLm7XkYivAwImoVTIOKDT+e52+rgu/E1SQNEZKp1kobJ4Y+s8YTLwlwwWlCGoghQ1Fnw3wmgchoZHIpiNlcw4FRxKRCmv79RIgEQBmvSoo5nuOU0YousyQueAHgvT0nXXdlN/KFVeg5WSfes5kpa1Jv897oGotBwJ4pPUcYXG0uocgLKK8viM7sZw6IIyN6L4rZXoNYr4GAVN0ai1NVrubtehmVyhWvji/yoUXiF6MYcJiUOEww4v85cPJPX362VLQ+SDi7Tc7BKmuV0cBkUZQzPrmCwGQEI1JgwAEwKz8zEQgrXtr2Fufu7B0ZFR4Ki/xVd1ZM9FhoWZvE8V080EEbMt0Qfvj14efk7NllvGd69Mi9ZcLmKJxJpunIu7tbKpkAI8FF8FZcmIwm51+pQUQSM3FnimdcauT0Wxx9a5enDVuw1GlROI17vFHfXyxjICW2v0RBaSGGvEQxee5sGh0nJe78N5/n37u4aOvVbMrS3mQgtCMZR5TRKGoTTwqVgGrbZkr2iKAI+iq/yykIKs7kCt32N9biwzdWpV/DLqEIwZI0mgDzhRTLa20y8nRNQ1AqHSYnZnO/27DUazO1CvHH6/S+k+93dNcUMHyjBEjhz7h6vn6qjrl7L4FCUJxdSOExKfmRCEj4WW6W9zZT3nEiCiLl4ho4GvXRfXDIiaQNOFYNDUf71r5ulZ0YDK3xQ5PiLLogEjGreu5XAbK7g719r3NOzonAAzxyx5n3fjvY2EyqnkVhsVfrIbcR+UbQG9B9rxHt5Slq3N0aiO3z0XDyDWbYE5Nh+78OrEdbj65JxlaMtvUF721aYLdeg/aJoAqKBMAabkbeG5rBdUTCd/JIXv+kSDFUODpOS0YAQE+w2yx9ejQDw7Al7QeHGVOU8+QAi94uiloDVXMnw7Aq9rdXUtzoIK7M8/4RJclFyOExKYrHVgoKFFlLcHosDsB5f58OrEckGyBG7Hc27PxpYKXqzdN8EtHo8irngBCAkOy3qTUBwVYU2R0QjWFCw2CpmcwUdDXrUJjXvXpnn9PtfMBpYIbSQkgiaWd/IC55GSlAe2/cS+ODDQVzmrbDT0mCDT+cBCubtoZy73E7A7bE4oaoqQptwfiQGKNC120mEl3n3yjyu6xGpT3HvQfQSQpKzXwkEFGUDcqqXjcQEIqzmStrSG9wEyafvht9cDDGmKsdSLrR7/TmhnjA8uUJUvcldm5FALiky2KoJhJd5Ovfs4FD0kas+u6FoIyjG36OfpPhiY4kfHDiI26pl5M4Sjj5LXlu58fpdKEu45ev0N+kZnlzB06TPa9vf3wjeKSzHGvE06QmHlggmq/nl+CKwsiOb3C9KsjU2EwspVGVRjlYJkVnPwSr8kbW8NtsDm/MjMUkwEGZd/Ijf766X5fIJAX1dBlrUm5wdS5Ri2ECJt8ddynLJf7utWi4F0ww4t14hhsNvexd5qccqqHogkpf/y2GwGbl5cwEQbEzQlxDS7LO+kh2VKZoAUfi70TCH/qRWuu+2V3Du5gKd+gMFbUEwqeTa+CLfLdtgoFGL+c8cBfsftRxg5M4S3tkVPLV6hosd8DbsmwBxE0JTacdqrtyxPV5Xr6VbVcPvr0cwt1sYcKqIxVax12jocls5P7LIX1iyPHNky5PIcwARHQ16Ohr09ARWODuWwENpsS8CXGZ71uFs5vOZKK2tDlrUm9xcTO4oXralN/AbVNy8uUA6qOVkn4XQQopv2zV8+znLjn5jsVXuTefbDjFJcpiUdGU3+eDT+ZKeFHtkAuTbz+lNCwabkRdr9cCm1EZtUkvXZnMFc/EMPSY13BEKGoNDUU72bQU+20Pa9jbTjqxRHjn6FGVf/TE5uaonEyk6DtXT21pNX5eB4EQcnz+CpcGGbr2MWyubUg5gr9FwYyTKkz3CTN9ayZIOLjM4FM3V+VYfKaYX0+NLwTQGm5G54P6FLYSCBMhnW1zjBpuRl3rM2OxVaCqFCbDZq7AkBQPX21rNR//5aZ7Rq6vXMhpY4ZkjVrga4ZbTSDq4zFtDIf78Tw8wF48IvxXA7bG4pA2jgRWhIhwN49II43ssS0B+whPgCZeF/lwgIgoNkLqfZXhyBacug1MHwxcDeE400N1dkxcAtbeZmMtleCIJI8AhpZqbNxe4CVIFSK4NoYUUc/EM7blrMeZvsdhIJlI84bJAiQ5LKgrNtii0cE8hCR0OLUkqLycldT+L1ztFf38jXq9Q2v5xf7UkDGwFQB9ejUjV33RwGX9kDZe6nL5vGAoO0B8SYv6nTXqpLDY8u8LnM9FcvV9IyPZLhKLF2ZMVT29bzZX84990FZxtEX1dhQcqtvM06Tl91se/PesouMZDCylujETJLm8wbqnII2I7xC2yj5cWONLUgKdWmJQut7Bszo/EGP1kuigiFC3OnuypFzpx6oQ00+ePSC8IJpU4dRls9iqAPGIeREI4tITNXsXFn97gZJ9lh1UHYX2L7m5MVfhkiEiK26qVttN++FeHCP9hAtvxZmlcolZ+8Om8tAmyFyLKAM796hb/8t4owaSS/v5GgkklPn8ET5MeZ7MJTaXiocKDQFAwZxRtx5t577fhggWQ9jYTapOaunptweIJCBXn7u6avKMzTl0GldMoaaGYR3S5rfzdyx0YbEZaPZ49HZ4sq291cOqFTupbHXgvT0lq3OW2Si/YCzyy7K7pZBtnzt0rSEJHg6DOrzxXm7cP0JYWagnfMgnbbBqXbsezAM5mE85mk6SdPn+E3tZqWtSbnHqhE4ezGZfZnn0YEWXvvPUKfV0GXn+untcG6rg2vojXO4WzWVDd4ER8TwRoKhUSCX1dBhabq3nj3Qmp5CVCvkfwzBErA05VHhEnc57kYTUFTaUCZ7OJky824dRl6HJbceoy9B9rRFNpf+gZQsXozfelHyOjHxOciHN+JEaLepP+/kZpTe+2BOQkbSfOZq/i9FkfIGx4nuyz5Lm90LYi5+2xeN7GyM9+PYvKaWR4doWfvNHN4IVJTr7YtCspQ74ETl2G8yMxeluruTa+yPjwcEG7kFcPsHYcxWavore1muHZrdx8t6UgEiZ+hnyJPCJAKJ17avXYjjdzKZjmzLl7vO1d3CE8CPbBXqMhFlvlzLl72I43C8WRbUjdzzJ4YZLBC5M7fvM06QkmlZLwb36vgVaPp6Am7IgEHYefAq5wbdzIuV/d4syPvykQMRHPm92fXrpH/7FGooEIva02KW448+tpyUg5m00M+RJ4mvScGV+kF3j1n18lMvoxAO9dmMzb7QWkukD/sUZe+ac6rB1HpfZynD7r4wcHhEMRolak7m/JF81t0XsvT2HtOMqb34N/EPrOiyILhsKOw0/xOvD6+FxegCMScH4kxk/e6CY4EefaehmML3JtXPgHBrE6LMKpy+D1TvFSjxWfP8zc9StoKhVYO47yasdRXi00ABkiox/zzi8CRGL3CU7EJRftqdXjz3kQ2/FmBnNkemr1WBps0phfG6jjzb/9Ge+89Qr9xxL8+88n8vp/YDLkOPwUp15YwXt5iq7QklCRyWlBb2s1gxcmSQeX6T3eLM2+uFTkNkHMF2x2PV2A1zuVpwUirB1Hdwhu7Tiaux/gW6YKKS4BOPlik6T+niY9py9P0X+skb4uA+/8IgAIVSSbXQ/EAHj++yeEiZL9q82u2aCnSY/3snDt1GWEASBEg//1hy0mtyJFZd7hKIBgLmfweqek2Ssk8HZs/912fGtTVLQz4nvE94taKI4XhEnpba1m7voVHIefore1mnFZWemhRVFPrZ7zI7E8ozbkS+A50YDnREMuIdr6dLmt9HUZpI84kC63lWBSiaXBxvs/v/iw10qYu35lh1DRQFi6lo9TJKFFvUkwqZQ+gJSjPP/9E3kGcVcCHIefwtJgY3p8jtT9rKAFE3GigTDBpBKbvUoKSJzNJnz+CD6/kP2l7mcZ8iUYvhjA549IAYu4XPZCgii82DcIGaickC63lZd6zNIZRacuQzQQJhoIC3HJ7FY+I+4/APwvm766pTyx5xsAAAAASUVORK5CYII=", "frustrated": "data:image/png;base64,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", "disappointed": "data:image/png;base64,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", "happy": "data:image/png;base64,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", "victory": "data:image/png;base64,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"}, "brenda": {"neutral": "data:image/png;base64,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", "defeat": "data:image/png;base64,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", "frustrated": "data:image/png;base64,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", "disappointed": "data:image/png;base64,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", "happy": "data:image/png;base64,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", "victory": "data:image/png;base64,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"}, "chad": {"neutral": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAPfElEQVR4nO2bf2yTd37HX8Rxbc/2k7OxE/IkIW4gYSHBQKFXECmJKo0rW7hWV0Srm5AmtHWsNw12mqqT1rtuhb+6bjeq29arqutJ7DqIuq4p6y800YQfI1yBgpuUXtJmCcH2ET953DyOz3Ydk/3x5PnaTkzaxG45aftIUZLn+X6/z/f7/n5+fz9f+H/6v03Lvq4P+dzyzGLaj6ihr2VuX8lHCi12YjoOgGQ24amQxHNlUgMQz4aVKJJDwpzMzBv3qwCl5AP63PJMRb0P5eaY/iAVp9FtY1mFDICqRrj1Oy481nKU5DRlv4mKvq1eHYSeT26gpTNIDokmeQVqxkwsEeXW+GTJQSjZYMauT0zHkcwmABrdNvG+btuuBfs/5K+mOxBesM2VixeIhW6WFISSDORzyzNpqwlScTpW14rnPZ/cwF1dz9P7HubQ0Xfz+vjX+8XfgasBAH6491vc2+QC4P3BKE++eAynzYV/vZ/A1QD+9X5OnXwTczJTMhDKih3A55ZnJqbjgtX7I5r4OfLXB9iw+T6efPHYvH5acFD8nQtG5w9epr7zAN2BME6bK69N4GqAB3b8AWWVFYtWqrejogAQO0+W3V2mNMqkxhvPfx/Qd3ddXXXeIgFGlOS88boDYdTwKOsb6glcDeDzWMUYkAXh2ccfIxgbLwkIRXOANqUJma9xLwfAXV0P6Avyr/cj1TShBQfngWAszKBjv3iJjtW1tHollOsfM6IkhTLNBaE7EMZqsxc7daAIAATro+++sfghNcGGzffNa78QCFpwkFvpBNt8VbQ1+wB0XTIZYjwS5lY6IdoalEzElzr1PCqKA5KJOJuqHAD0RzSh9B7yV/MXR17nXF9vXvu5IMQSUWKJKKcuXEINj+a1DaoTtHolrDY7I9eHGf50gFgiSqmpfCmdDNmvXJZ1aFymNArw9L6HATh14RKS2cSVixcER2jBQS4ODMHlK2jpDMlEnEpJEiAOqQnOXhvJ+9amKgc17uUE1QnIaLz+2r8BlEwElgQAwHgkzDZflWD9oDqBZ+XvAnD07V6SiTgNnlr4TZRTJ7oITkQxMcOK5W48FRIeAFzCEzQoqE4s+F1D32CxQwFvcbG0aAB8bnkmGBunUtJ335jwkJqA+BjdgTAXL19hbV0tyqSmL7ZCotFt49Ftm/LGOntthKApTTRjxmVKF/xeNGMmGtEAMwCeCjOtXon+iMbknQAAIJ3OzPruaYbUBI1uG1o6Q8PKOk6d6Jo1iWlcbhtDqsZTu9qQPTpgrS31OJ0WAB7p3EwslqJ/YJSQonH22gg9n9wQ3xlSb9Cxupa2Zh872tcB8J1DvwD0GMKMtYil67QkAEzMoExqKOgWYEjVtXQsEUVLZ3dlSE3kLb4QOZ0Wtm5pAhCL/CB6l3i/0fW5AAxg/3Y/h0+cXcq0C9KSdQDk+/q+lQ2MXB8GEFzR6LblLT539wuR8W67M/dpfnsx3p3SAQBl5nKx+CE1oe+6qiCZTSIW6I9oIrorJbW21NN09yoGQ78uyXhL8gNupaeJZsyC9b2yjDalKzxDKbZ6pS/U6Eshp9OCbEqVbLwlAZCZDSIb3TaRyJDMJqHJjYVHM2ZCSr6Zi8VSnO8b5HzfIKevL82V33O/n/HIwqHzl6WidADoGRyvbMtTfoZvMJf6B0bpOhPg2AXdpV0h17G5pZF962U2dHwTW/IzQAfJ0AfG37FYipO9H/JOcAqHpnArPV3s1IElAlAj1zKsRNlU5RCOSYPHBaTzHCNlMpHXr+tMgKA6wU/+6NvC5J26cEn3Gl9+i47VtTyzfxcnez8UFuFk74fIHokfvXY2z2kqXv3ptGgARtTQMp9bnkkm4kQzLrT0FFLkJimACgly5L7p7lVCa4cUjbZmH7JHjwPamn20Nft0Z0idYEhNcOyCDtCj2zYJDjh+7hJnhoK0NvjoWF3Lnvv9hBSNP//5G8WvniJFQJnU+NfHd5GWGzGHhnjilV6wmnO0f1ZZ5ZrDrjOBWTAk9tzvF8+Y4/TEYimG1ASdv/cAD9Y4kD0SIUXj+LlLrJDrSmIGi4oGN9+zAYCf/MuLABz5qz8GdPbvj2gF+3SdCRDKWHgnOMXuI8d4VXHwquJgStKjA9kj5fkKv55QeavnNP+NzKuKg3eCUwypiZKlxYpOiHSdCVDjXs6Pu98DwO32CvM4l1pb6tlzv5/vfbeTvTvbRTxxePdanj/wMG3NPlpb6kV7p9PCY/dl8weHd6/FoSmMa4XBXQoVDUBbs0+w8X8c/3cOdqwBmBfcbN3SJNzeja7P2b5yGR/89CB/3ykzHbnJlZ5fsqN9ndj9832D2fHvWctD/mreH4zyzP5dtK3fSNpqKklKrGgzaMhlrunLdZGBvF0FhFkzgiAgb/EAGzq+SYJsfJCNCSwc7FjD7iMfUOOsLHb6S+eAulWNXLx8hdaWeqHg2pp9bN3SRIVvTUExSFi/QcL6DSAbBD3SuZlHOjfPixFsyc+wJT/D6bTQ1R+m3Fsl3rW21N9ZP2BEDS3zwYw2nRE22whnZY/EvvUyD9Y45mV3AOHs3I5ynSCDZFOK6chNWCCQWiotmQNG1NCy5eV2nnytl/6BUWSPJBKaBssbNrt/QM/3LbT4WCwlxCIW082nwS3P7N/Fj144Ido6nRbKzEVLL1ACJSg5JJ54+S1CisYjnZtpbakXgEBWR3wZ+v4r528bMgfVCQHM+b7BO58TNMjt9jByXePwibN5LG9YBtBBON83KBIfuWQsyum08GCNg5O9H4px8pykHPrHnl/hlWVujU8WO/3izwZzc4TjmobVZkcym+ZlgkKKhuyR2LqlSbA6MA+UuSkywzX2+jex0fU5/QOjPPFKL263pyQHpSURpEpvNaT0FHfH6tqCeQDZIwnd0D8weltWN6zD+b5B9tzvz2sXi+lABkNjJfMEiwbACI6CMU14dqBnfHPFYC45nRb+5Kc9ODRFLDSXcv83xMQY1ylVFDttQSXhAAOEsYkQrK69bT5gLu1bL5OW2/nZ271Mdr+3YD8jSOq6/BE1zsqSHY+XxpbMkpEpamv28cLpAHvmvDdY39hdQ/63/2kHp6+3Lzj2RtfnpZyqoJICYGJG+AKQVXxzqZDsb1+pg2fEALlk6IFC74qlov2AvMFmnRPZI9HqlTh+7tK8Nob2vx21ttQTUjTxA1nAQoqmK9wSUkk4oFBU1tbs4/i5iYJcUMjdNcjptPBI5+aC77r6w2hTGsvLS+MEQYlKZIKxcYKx8bznskfi0W2bOH7u0jxH5ou44OukoktkJqbjwi1dW1ebt9sGCD2f3NAzQTku8fm+wTzzdqeoaA4wKjXS6UzBE17ZI4nToidf6+XH3e8JIH4bOKEkSlAymzCbTQXteGtLvbAM326uZ0hN8MLpgBCLhTjh6+CQ0phBi51Kr10cbed6gP0DoyKrc/baiOCGnk9u0B/R2L/dD7OcMNcbNPwG4+/B//m0ZEGQQUv2pgz5TybiwjRZJAepyE1xpm/oAyMAyo3pQQ9xz43cFDHEQtQf0YjdZSt5ueySa4TKKiuIfRzGbJSsACltCou3ijeujdIzFqWjzkVbs0+YPeMgJOss+ahxj9Af0ei6/FHBb1ltdpKJOHWrGn87aoWNAqnxSLZWzyh2wqL/b5Ec2MutovJr8z0b+IfvbqXcW8Vbr/5XwXGNHIABkgFIbuLzjlaLG85OMDaux/yOHOcmFReHo5JDwiI5WFeni8VwOMrI9WEkh8RTOzbi9W8iErjEjvZ1eVlhgwwgDACsNjvLy+1f2f2BLxSB3CrwuTstyGLH63Uw9ukQAF5JL3t7sMbBO0BD9SaGw1EOn/wATpwVafMd7euEAgQEGG3NProuf0Slt5pg6AYxNDGPUgNxWzPoc8szPrc845SrxGWHQou3SA7cbg/2cit1qxqRHBKRUIiLA0P880W9zHXvznb89gxP7dhI092ruG6SeOG0bga3bmli65Ymoe2f2a+X1VttdiyzQDoliWBsXByGlKpQ+rYAGEouGBsX7Cs58hefu3CD7OVW3G4PXlm/HPHxrz7k4sAQR9/uJZTRff+DHWuwl1uJ3WWbl+k1Dke6+ucXP1R6q7FIDkbUcMlOhaCADvC55Zn0siTBiShOSdLP/+csPHfRC1F8OklKmxIK07gBoiT1Qw01PMrp5/4sLzA63zfIE6/0CpNqVJTWrWoU5fPKzTEskkP4A8WIRV5HY/G51R5571c2LOkjBhDaVFbhGVxS73Dw0vd2CBD+8u9e5Y1ro3nAj0fC1K1qZNuWdnGz5NTJNxmPhKn0VheVHxRKMLf6O1fDG3KY0qaEOLjdnkV9xF5uxe7WxSM+rd8TiIRC+m/gZG91XhCVTMTxyo2C0wzgTp18Ey3YyN6d7Vy5mJ2DIRJLAWEZZBfvlWW2bWkXRc2F2P3LgmAs9IvERVUVxiNhnv/D32dH+zo2HPgJXlnO6zdyfVhwX5nZxq10QnCVp6oO5eaYyBMsFgTBATFN44H79FpeqaaJIzv1HN0/vfKfQmYhWxC5kC5QVYWOOhc9Y1FSTOnyrE0JbjKAiU8ncbs9WCSHqP6UzCYxbpnZVnD8MrMNppOQ0jnW7fboVWPOxSdKyoyEhlOS2LtTl7HcG1w//5u9PL3vYRqqs/d3vLIsWLgQddTpbZ/asZEmeQXPPv6Y+L1tSzvbtrSLsnoDDC2d0U3jrNw3VLt449Bj4m6Bqip5gDhtLrDYxY2StvUbmZiOL9o6lAFCQx86+i6Hjr7LvU0uDu9eS3cgzPuDUe5tcuXd8TF2SFUVIMvuuWQEQ0pymu5AGMnlpDsQ5lxfL+f6evnbn72e1963soFhJSpES6pp4v3BKA/5q3WFmZp/Q8QiOYR+ONixBslsWrSJLHfKVaTDo3isJoFm5w9eZsPm+3jIX829TS7eH4yKaysGSQ4JbUoT7G13Z8WhZyxKKGNBSY4Rn05mb46MZe17fDpZUISM51pwEPzVHHjuJR2U2foAtymNmjHP65eWG+lYXUvP2OJulSxzShUzz35Hl/ez10ZmJ67LvMdaTm3rJgJXA/MAUFUFbUrDK8uktKl5SrHMbMNtSiO58iqf80iLxvL0S3w6SSQUomFVC7fSCcFhAE3yCiSXk707s+cHh46+y0f9vxQmcrdHL7xazMFJeUybzAtRD3asIaRovBOcYjgcRbl4YV6nXJaPhEL5gREI7gEEB+VeiMylXFGwl1tJzYbXanhUXJ/1VNVR2+oXukkLDiLVNPHDvd/iwHNjpLQpAlcDXEknSN/Gh7kd/S/8IjPPR5Dc7wAAAABJRU5ErkJggg==", "defeat": "data:image/png;base64,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", "frustrated": "data:image/png;base64,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", "disappointed": "data:image/png;base64,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", "happy": "data:image/png;base64,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", "victory": "data:image/png;base64,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"}, "kid": {"neutral": "data:image/png;base64,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", "defeat": "data:image/png;base64,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", "frustrated": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAPzUlEQVR4nO2bfVBbV3rGfyBLCEm2ZCGCQDbIgYpMbCBsZjGwkPV00qbxNJ0Yp3Y29XaymW7iaZo0mcaZNM1s6sxOpo2zE2+22Um2nTbTdZtNNmbTjes0qSdNDQHjzBZjjLuoYD5shLCuZGRLQkgW6h+Xc5D4FFjOP5tnhkHi3nvQ+5z343nPOYKv8BW+wlf4DUbOl/FPnNaSZLbGGg54svqZbyoBwvCRgIac3FzM1gKKK+7C73Oz3l6NpaaRnDz9os9qIhMMnXhHvvcN9WHQ52HTh4DsEXFTCBCG55g2MxmJozPbsd9xH9oiB/GJMcLeEWzbtpIwFC07jiYygXKuD9u2rQAMnXiHWNALgHnGmxUSsk6A01qSNLj2MHr2OMbiCml4Tp4eTWSCKSWErrR8VWPGRgflM8IzDHE/ydDFGyYh90Yeng+ntSTpcDgZPXuc0uqdbL5nP7rScunmyrk+8m2mNY0dGx2UY2y+Zz8RbQFK1CS9zWktSab+ZDpuVgkA6BlUsNe2YGzYSXxiDE1kgtjoIMnpKMCKbr8YdKXlxMf6Gf3lYa55z5KTp2fL3d9CazBJEnJMm1GiJoK5dhwOZ8aJd92qP80ScFpLkkrURPm9TwPqjIW9I4TVkMW2ypkXhImckfB0EovE+frDzzExpI4dj4TQGkwEMWEBItFpymwbGRsbzjg0spIDhPEi5sPekQX32LZtzTj+NZEJrvb8Cr/PTXh8gELbRgB8yhW0BhPxSEj+bTISl0SYZ1S2V5MXsuYBkeg05UsYb7SXMaWEMhonNjqI98yHsuwJQ0cuqcYlI1M4S0sAlZBU5Jg2A+CEZKYk3DABTmtJMphrx2xd/r6wdwSjvWzZe5LTUeJj/YTHBzDo86gpt+EJJqShZZvsAAyPegCw2AqxGLSUmDVyjJ5BhZpyJ2RIQlY8IB4JYSyuWPL6Yl6xFPw+txrLm+x4gglGLnkxWwsom/WEErMGnyGfSHSaeCTEJCZJkNZgotC2EU8wQTDXjtO6MglZqwIFha5lr1tqGlckYl0iCEByZobhUY90+2DAz/CoRxoqwiISneb2Yv1cPlB8jFzy4lOuEAz4yTFtXrEaZMUDItFpYho9sWUMnOzpWHGcKSVELOilevfzgOo5ukQUv89NLOglGPDPurgNn5JHJDpNR+9FjIZ8Cm0b0UZEIoyDHpKhizgczpzhgGfJ/5lVHbBSjGcCndkuxZKlppENNXdiv+M+yvf8NbfV7SISncYTTKA1mEjOzJCTm0s4MoVPucLtxXocDiegVoJ/+NHzX04OEMkp32aSdX8+bNu2crXnV1IOC4iwMNrLCHtHiAW9KOf6MNrLiE+MEQcppTfU3Emhz81k0Es8EsJiK5TNlW+oj/PjqnawmDbjhOTdf/RnKxJwwzpAVAHR8CwW56luDGrSFIlO1HZQYz05M8OzXyuiPa7j/HgUndkuxxF5ZnzgpDqu2c56ezUA3u5WItFpDPo8AGz6UEZ6IGtVoLgiPQmmGi0MTs7MYDTkA6rXtOyopPWzfkrMGnoGFco22Xnt0Qa2V9lof+E4k4qPxmI9B/bWAdDmDvDW+6dSDPXCLAGR6DRmawHBgF+SkAnWTIDIrg6Hk9G+MdXY2ZkBdTYFzNYCDKjZ26dcoabcRn1tBevOnWfkkg+fotb8g889RG1xnLaOEXoGFZ79WhENLXU0N6q5ZXuVDYDXjvy3HMvf/wk6s53kzAzmGS+WTWoLzkxmwmtNBAi3txi0DEQs3NpwlzrjQHh8gHBkSmZmUOWqeF1o20iTNkZ79wCdfT7pCc/sdqFbHyd2LUxnazuPPVDPU7td6NYb5f/VrTfS7LLylj6Plh2VnOoeoKP3IjkBPxZbIcx4SYYuYjFtJpmZ/avLAWLWRcyvt1fL5DZ69rh0c0CuAAml5gkmANhjS/DUi/cD0NWrsO/l44Rn5e1rjzbI2V4KsWthXj3q5pndLg4f/IBDZ3zS9UstcYYDnhyntSRjKZwxAaLlnIzEKaj8XZm1/f2fSHdv2OqQ8Xro3dN09o1JSdszqABw5PmdaUbGroU5fPAD3vj1VbQGE//01F0Lrqd6QexaWL7u6lXY9cJRnKUlqtuz+pWijHSAcPmItoDK3U9jtJfhPfMh3u5WQFVuyZkZDuyto80dAODA3jpZHgHCkSnCkak0Q9o6RujqVWhoaeKxB+qJR0LseuEof/DnP6etYyTN2FT0hSx09Socevc0oDZKtxfriUcy9PsUrMjU/D7fe+bDBfdcHuzFaMjnyPM76Wxtpz2uk54gZkhk+v9754/pC1n47l/+lJYdlXzktjLl6WTkkldmb1EiX3u0AYDmxjJi18LS6M6+MQAMelUNiteiVc60BMIqkuBihoOa9HJyc6kpVzN0Q0sT190BDr17mgN763CWluBTrtCyo16SUlscp2VHJY9/70keB954KQCoSc0TTFBi1lBfWyGNh7l8AWqo1ddWcKp7gM6+MaknBHlBQ2aNUMYECKEyH7GgV12IMJjwBBOYtlSw1TRJZ2s7TVr1nhKzhuHRKZpd1rTYfma3i66fHaH6wX00u6zse/k4jz1QrxrtsrK9yiZjX4SCmGFV8alkiaRbaNtIMnSRuF69h8VX2xdgxRwwHPDkmGe8xIJzPwI6s13+DI96CA0NpD27vcpGkzYmxU/3uHbu2fVGmhvLyO/7DwAee6CeZpeVZ3a7pPGpOaDNHcBi0FJavZNHdm6jZ1Bh5JKXnNxcfMoV6QE2vRoCu3//7uxXgWCuXao6gfmq64O/f5LQ0ACdre089eL9Mm7f//5O+kIWALaaJtOIgLlZnv9eYGrr7/HtXU9SX1tBs8vK0z/plGsFqUtiq10mX5MOSEUw104w4Kdsk+oFjVWbef/7O+X1rl61/Jm2VPBK9y08W3s5jYDFMH/2548F8J3DJ5lUfJRZE4xOauWu0U0lYD6EV4DaDwgFWFOuuj6oSVGg+sF9XOg6JQkQhqb+Fphf72FOCgP81rf+WW6Tic+wFg9Y83qAEEag6v7UGt/ZN8ahMz4OnfHR2doOIPXBK923oFtvXGB0qvHz32+vsslxBEQYihy11q2yNRGQqgrjkRBlm+yUWRNp+l+gPa4D1Mz+0KH/5dnay/LafKNT0dYxwuGDH9DVq9DVq8hxQPUIs7VAvh8OeHLWukW2pmZoOODJcULSDLNLT3MKLHWp2qDPwxNM0OYO0Oyy8u97lQVjAVLkALICpJbMztZ2Duxtkl7T5g6sqtQthzW3w6mMS6kcnevFkzMzFNo2UmLWsO7ceXA1LYhzUGe6zR3g3ntUkfTq0dNSBwgFuL3q/rRQOdU9oGqTDFve5ZC1jZFgwI/ZWsAjO7fx1vunZE5o0sZoj+u4PpsDmhvTCTj07mmuGOt4/HuqCHp8u/q762dHAEV6j3iurWMETzCRte3xrCyKGlx7ckotccwzXo4eOyGzs9iwaNLGONU9QJs7sKC81ddW8PoTC/cUqh/cR/WD+9L+FrsW5tC7p2Xnlw1k9XyASI4lZg2dfWM8ve+bNLusMoO3x3XU11bMLn7MCZ5Xj7ppds1tLZm2zBHy4t/8K7/84R8C8PLb3bR+1p+VcwECWSNAdI2pOPL8nCASJLynaNhjS9DQ0rTo4sdSLbBohtYidpZDVnKASILGYlWQhMcHlmyg9tgSvKdoYJaQxUiYL3xulvGQpWVxoQlKv/lduUpkMWhp2VGZ5tqpYuaNX1+lptzGgb11aZ1fKkR4ZNvtU5FVAsRSGagbHomL/yV7e0FEKgnvKWqSFCExvwU+fPADfjI6k7WMvxiyToCAICI+1s/4wEluL9bLRY51587L+9rjOnoGlbQ+Qix2AKs67bEWZIUAh8PJ+fFoGgECRnsZ+TYTU0oozSsA2TABHDrjk3t9hVu24hvqk6u8N/oZl0NWkmBn3xi31e1CmKNLRIlpVJ2aek7IaC9DW/NXhCbG8J75kAHAEPdL+Sz2+rSOSnxDfdn4aCtizeym7hEIFZi6V5dKwnyI8NAWObj48Zv4hvpUAjV6dVN0rJ/Rszcn68/HqgcXhouabyyuoGbXwzxbe5knfzTA+MBJSURqQlwMwthNTY1UXT7Gvw2qZ3/8/Z+senV3rViVFBbxrtb8Cmn8m/tv5dbt9Rw7so+f//ARCgpdqhFj/eTbTEueGwh7R/D73PL9Ne9Z+ToSnU47CHmzkHEOSE12Ik5/8bdfX3DfK923oHVoKHVU4j3zIf4Tbux33LekN4hYv/eeOo58ri5768x27n74OaouH6P1s36ckITsnxSHDELgxL/8HX/yxMvyDEBBoYvXn6jg1tmuTeBC1yn+olUjDzOAeuprsqdDzqzID2nPdb5D4Rb1MHTqOaMNNXeyYX0ef2rpkDtAN6MkZrwzZK9twWgv4wctiTTjL3Sd4oWT5hUPQYqTo6luDuqu0u888wM6fvwCxuKKBcfoY6ODFG0pIPzxYXoGlS+3FxAav7T6LkhEF7j83Kyb0ZUufwZYV1qOrrQc46ia+ARSy11BoQvDvO8Q6ErLuXptgg33PEXNx4cZG7vxRZBULElA6tEXYEHPvv/NC1zovLTslx4Wg660HG2Rg3WJIFNKiNvqdlF1+RiXqneidVQuOlbCUMTVaxMMRSzEMjz/lymWrQKTio+CQhcbau5cEPMTQ355kEkcbM4UOXl6rmvMaIscaB2VHPlcYVNTY5pnzEfCUERBoWtNO8DLYVkCxJbWhvXpuz8Xuk6RbzOhLXIA6hnAtZCQk6dHV1pOQaGLqsvHVnwmptFjLK6YPQWanfK4aAiIxCd6+jf335p2/ZXuW7iumTMA1FOeiSWWaZPTUXkKdLHvC2gdlXzkXnr2BYz2MnSJKOMp+5M3iiU9QGswpR1RS8XEkD8tVvNtJpRzS2v3yP98yjem/pOhE+9w5fSnC67n20zc6wpwrysgvxmSiuR0VP5d66hc2po1YEkCggE/saCXKU8nb7z0+pIDxEYHua4xA3Dl9Kfyg4oPHRsdZEPNnZwIN9D58UsUXT3JldOfpoVMwlDER251vWCpPKA2VSPk29Tt79V8K2Q5LFsGHy3NBRJw7jxv7dnP9W23z15pkPeIb4KBKmWF4luXCOL/4m322BK0u3V4IxbeeKmTn/7idb6960kmemBj3W8Dc98OaXZZ+WhOGadB6Ieiq+pRvPPjUcxrMjkdCzxAlL+GrY4FN687d551585z9Yu3F8yiQKrUFX1/fW0Fb33HJTc/Dj73UJogysnTE9Po+fFkI36fe8mEaoj7adLGqCm3pZ1DvBEs6gFqqVm6tu+xJWDqBG9/fDat6wO1DRYGeIIJ3kND5HOFI58r7PtGgN7uW/ji7X9csHhitJdx9Zq64blUQt1jU4/aNWljdMyeDLlR/D9nzRHR5n6vqgAAAABJRU5ErkJggg==", "disappointed": "data:image/png;base64,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", "happy": "data:image/png;base64,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", "victory": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAARFUlEQVR4nO2bf0zbZ37HX1+CHYMJ2A642ARiArTAktCFK4ToWjXJUHRimbi2LGrHXZRdc1ubtcm0a5dV7RS1VdfrVbqmU7tJ6dpxx1qlybVoUVRFuaa99hantGSlyWJ2QEMgsX02sQ21gdiE7/748jzY2Pwm2x/rR7JC7MePn8/7+fx4fz7P84Vv5Vv5Vr6V/8ei3IpJHRa7eivmBegLuJX43xD/X6ykL8ei4sVhsavj1mqu/u4r1ty+EYOlHADLXdtRldnXqqgqI5c60NvWssKSx82An0zjDbydXXjOv4/ZUYEDVAD/SCajsXEcFru6FBDSFvvFVOKw2NXAigIA1m//MdaaXRiMJrJLq+ZUHkBVFDIrq4l6rnAz4MfXfpSRyEosd22n+I4q3N0XKF27jpjOCoAt17TkNS+bBQjlrWX3YrlrOwDjwUG5m/MVAVTPB4exlt0LQODzDxn19mLLNeFyhwkNhSm+o4rwgHPJ616WGOCw2FX/SCZmRwX2HftQFQVFVQl8/uG8TB808x8PDhLtfJ+gtxeAbyZ0ANz8JkhdRT4udxjPYAjQdj80FMbsqCDd17HoWLBkCxDK2zZ9X+78zYB/QXPcDPgZ7unE1/0xq9JiVNizcLq8RKIx0hRF7jzAto1rpr5oz8LpcmHKseKwsKhYsCQAhNnbNt1LdmmVtoOeKwDobWvnNYeiqvjaj+LuvkCGLp2KyZ2ORGMY9TpMOVly1zN06TiHwinn8Y9kLiogLhoAh8Wulq5dR9eomezSKqn4QmXkUgfD170A0sxDQ2EK8swAVNizACQIYgzANX+QNbdvBKA4X6+tC+eCQFhSFmi/egODpXzRygsJB/zSzK/5g4zGxgkNaUCABkKGLp1INIbT5ZXv/1FVIeUZQdJ9HYQHnIQHnOy7b9uCLGDJaTC7tCrl+wKU8eDgvObxDIbwDIZIUxQmVJXR2DijsXGcLi8udxhTjmYJkWiMSDQmLcLlDsu02BdwK0+80bqg9S87EYoXg9FE1HOFjBnSoKKqjEVC2Ms24NjaCEBUX4A+eg2AUI+X/i/buOb3UZBnxqjXsWKVGWvZvfi6P+bMV1fJ0KVLcBYjy0qEpovetpaxSAhFnZsZj0RWMhJZiaooRPUFRPUFZFZWU/q9/WSv1nbY7KgANGAFR4hEYwD0D+kXRcFvqQVMjw3TgRDuMXzdi6Gnc8Z5slfnM3zdS/a09ydUFYcphn8ozMQ8QE4ltxQA0HYLpng+wFgkhK/7YzkmHPDzV2lnaY8o/LpzgDRF4WBdAebyYgBOdQQ5E/ATDvjJ0KXT/2Ub2avz5ffzMkcw5Vgh5lvw+m45AKBR2bFAl8z1ppwsVqUhCc/BugIee+Z+/vG5X+HU69j/ndt47Jn7MWhEkIZaG/VPn2Z3mVGCNHx9Stm+gFv5PyFCq9Jis6bA0MA5hq97ZZrL0KVTV5FPjVGlpTuC0+WVygK0dEc41LyZhlqbVB7AXGTjwM71AOwAGfwAYjrzolkgLBGA0FCYjEhImrl8P05xmOLtQvkXndfk++byYoL9HgAO7FzPww9tSvodg06zAluJDU+vh2BXAYe/+L0kRTHd4qnwoouh+BpAAuA7T7+7P0FxIdf8QZ7asob2iJJQ1EyoKgV5ZnaXGXni2ftn/D1Pr4eTn3k41dEnvy8syunyYsrJQhfzLbgoWhIAovYHrWKL5+9CKuxZuNxhKuxZvPpoXcIcJz/z8MqJiwnK7Kh20NykWYFwg1+ci/HS4XfkOFEfZOjSGY2Ny39tuaYFg7BgFxC5VihfdGcj/V+2MRobB2A0No5pmvIANUYVc5Hm22Na6qZhclyw6zIt3RHOfHUVp0urC4QreHo9PPXs+4BWCe6odnCqo49r/iCmnCyK80sA6Hf3AzFK164D5u8OCwLAYbGrMZ0Vz2CIym2N6G1r6fngsAxyu8uMABz+4veMxsYTC5kyI8H+ZDMG5O4LwBpqbfI3T37moa5iKuUFuy4jDFerCXrRxXxYAG5Cz5WFWcC8maBQ/psJHZXb9gJa12b4ug9brokDO9fTvHsLjz1zP4eaNwMkFC6gRfNTHX3sqHbw5P4HydCl89M936X4jiq8E7dRY1Q5sHM9thJb0u8LyxDZA6ZYIGipULzmq9O8ARABTzEXsvGBv2QsEuLyp28ljXv8dSc/OPgeDbU2DtZNxYef7vku5vJiDDr45Yv3oV+3gcYH7qH47j088eanAJw89hPM5cUps4DLHeZQ82Z2Nu3EnF/CaGycNEXBqNcljV2ozImW2PmMknqyS6tk50Ywsau/+4qCPLPM08Guy7RHFHZUOzjUeo7R2DgX/7lJ+j9MRfQ/fXIfbcc/ofGBe9BfdsrPx6Y2lmC/h9P+XF46/A5P7n+Q6NcX+Nu3fiszjGcwRFFOdNEtsVktQCivmAsxGE342o8yFuiSyg9f95I22e9rqLXRUGuT9LWh1pbgu/HExlZio7lpE5HfvEd93iCR37yX9Nvx4+vzBjn9fD31eVOltS7mQxfzLbkzPKcLXPMHAY3cpBJ72QZCQ2FOfubBXJTouzuqHUkL9PR65A6bizRyI6zD0+tJGCeCphBzkS0hQPYF3Mpicn+8zAmAUa+TLavpIixhNDbOKycuEuz30FBrY0e1A9CsQLgGaKYdD5JggOIzW4lNgiOAaW7aRGvL2RnXd0tPhrQiw676v4HgN8GUYwQRAS0IvvpoXcIuxf8tOECw34OtxCajvfi/GANTcaKh1kZ7RKGZRMCWS+aFniA/ovUkxDxJQkQf3zMYknygPaJNvaPaIXl8vHh6PSnTHWggtR47r83ddRlzeTHNTZukm1T+xbs4TLEl7z7MkwhNHUiS0HUID/jwj2QmtK49gyFe8E9ZS41RhVrNtA3TslbT37zHq4/WJWQI0MY1N23SdnwaeCc/82gd40XU/qlkQUwwHnGHxa5mFdbh/+9OPIMhsix5rErTHFgETqNel2C+0xVxucPSv+Ozh61EA0SMF9YyFoNTHX2LKnpmkiWVw/3ufkZj4xTlROHmNfoDehkP0uKOw1pbzmokJw6Ahx/aRLDrMp9s+HP+7a8rAdBfdvJuRwz8U0TgxLET7GzayQ9LNBCdLi95mUtZdaIsGgDRhbHkTAXLCVWVx1lCaowq7RGFmq7LeHoTzfmxZ+6H594EXgYgWlxHY/HUb7Qd/wSAH27W/KO15Sx5mSPLtvuwxK7wdO6dpiis3/5jmftHY+Oa8pMdoNaWswm53qDTQHj3pddSkqHo1xdkCe3p9dDSHVnKclPKsiG5pnwn6b4OFSCrsI6LF74AtNObGqMWO1u6IxzYuT4pK4jUmEpEF+jx1530XPl6WXcflvFc4GrXCfm3UB4m+wCTAW53mZFXTlxMaQmC+MSLCHytLWdlX2G5ZdnQFFmh390vGaK7+wIH6wpo3r0FQEZ80RY7/Xx9UgqcLm+8fZ5XTlxcUOSf7YBk+hzL2hYPenuxltVjMJpSlsvm8mKCXZc1l7BnUf/0aSrsWbINNh2IN94+z6HWcwsKfOKOkrv7AqD1JUVjxjtxW9Lp8bJagKgcrTW7iHquEBo4hxocYHeZUboBiK6OJsIaxCJFHSHaZAvd+ZjOyoGd69Gv2wCQUEE+/roTlzucMOeyAtAX0rHm9o2YCrWOkLgk4Ws/SrDPJZueQsF4ie8WZ1nyCAf88uhrPgAI5SvsWfzyxftkUBX1RLzEB9T/lbNBU+FmrDW78Hqu0PL5eYLeXtk/FCLcQlBqe9kGgn0uIMZCRdQRokcxPePUGFVck2cJy2oB8ecEYykOTOKvzUy/EwTw684B+Xn2aivWsnsZ7T09pxs4LHZ1333baKi1yVb76efrZQoFZF+hoVbLNq3HtOC6bLfE+kI6uWgBAJAEQrwIQIZ7OvGcf1++b9v0fbJLq/C1HwWY9RaYMP14hR9/3SldDaaUjg+ynl4P9U+fXjwPcFjsqnj1D+kpyDNTdGcjvu6PCQ2cm1VxIcJFskurWLHKzAt/v5fiO6rknaPh6955X4FrbTkrmyo7qh28cuIiDbU2Hn5okyyuPL2eBP5RYc9a/MHIuLVadooq1xexd1cNjQ/cQ9vxdI4cbddAsJTLXZ7pEDXquSKtBSB0I4ppcmw44GdVrlWW4amAEDVJS7cVnvuVTLUV9iwtAJJo/kLMRTZqjOrCXEAch4UDfuxlGzAVbsZUmi+ruXhp2HeG/i/bAO30aDYgxGHqhf94lYaml8Gqtcb7v2yTJ0/Zq/NntAaR+8szgvLMIP4UWrjHdHnj7fPzs4CEjtAErKttwmA0cfK1bUlj/+znlxiJrERvW0upbT/DPZ2aAgP5mAo3o7etndEa2o5/olkASKvYuzWdxtdeZcvdj8hrMKlAMK3U43KH2f+d2wBon6yb5OlU71TTNr7umFd+jae4psLN2qIeuCdp8ccGchmJrCTdnJvwmbhAKTrLBkt5QowIDZwj2OeaugNkKWcs0IW1ZhegWc3erdpe/ewXv01pCSILTQGg4HR5JfeI5x3Nu7dgK7HxxtvnZwfg8As/5ecvH5bpDeCxP85NUl7sero5N+FesLgTJN4T94GHezoZC3QB2tnCzcmGa/Hde7j86VuYHRVYa3ZJIFVFkVfnmwoHeerZI0n0WGyU4BgiFohyXIAST7vnBCCe3Rks5Xz4r/cljWnYdwa9bW3CYucSeTF60hWEBfzhnr+j76M2rDW7Ut4wF/eMTKX5/Odb/5ASBBELxK7HU+34Bu1YDH5w8L2Z06CYLHu1FYOlnPyq8oTP245/QsO+MwBJOz+XqIqS4Camws3S/MV8M0lmZTXezi5WrDLL+8His76AW0n3deCduI1DrZq71RhVdpcZU3anXe7w7DzA3X2B7NX5GIymlJFeRPaRSx3zugsYL+LhCPES9cPwda+8TZbqO6CRq/hbYtMl6O1lNDbOi85rtHRHMJcXSzIk5N0OjWLPmgUydOnykZfpcuSjcTL+II9Mcy4jlzoYudRBZmU1oJnqfC1CjMusrCb08RGK7mxkLBIiY47vmQo3M3zdS38g+bEZz6B2+1QNDlBhz+JURx8wdSED4MQxJ6GhGSxA0EuAsUCXjMBCRLNSKCAUn01uBvzyNT04CgndiLJ3azqGyNdzWpTetlbeFk0lBks5irkQQMaDx1930tpyVhKj4juqZnYB8TQGkBT1jw3kkllZnaRIvCsoqpqghK/9KLvLrxHtfJ/A5x8mKagqirS20I3ojJes49+fiW5nTQZQg6Wcvow6aQFCTnX00TVqZsy4bmYXiERj0OfClJPFj3Y9wb8c/VnSGJGeQNsRUbzEP/UlxLG1kSMfeTl57CdsufsRAiQ+SaaoKgajiSNH23FsbWRklgZwaOAcpsnfydClE9OZJF2O6ayEB/2IQzyD0YTX+D3+HSAD+a91cr0zApCmKJJOgsqPdj0BwNjmPYR6vGRWajdAVljyGP2vL1I+ITLc04ljVHuwyTuhEZS24+mc/fSf2HL3I4wYTQnuo7etJeo7T1PhIC1dBUnzyXmvezFYQtB5PhmcoTD2sg2MBboS4ld8qoapBzWSXED4vy3XJAkEaOmkxqhyz4U3yR/8gMDnH0p/FvTWYClPuEcgniWoMars3VUjCyaAJ/c/mDB2ejyY6yGM0d7T/Mkq7aapeLhq3FqN2VEhFR8LdCUUWqqiyJfYsJQWIG51QupAVGNUqeEsLadOk1FSj+Wu7RoARhNjAW3xmeZchns6saAxMO/RdkI3onKOlw6/g3ljU4Li6eZcfDeiHBvIZSzSReYs2UTj+Nr6wgE/lhxQgwNklNQDU3Rae2kmD4ls1Fp2L/8DEPHYencIVCsAAAAASUVORK5CYII="}, "hank": {"defeat": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAP/UlEQVR4nO2ab2wb533HPz7pyFCiKeFIyab+MnIVS4iiCtlqNZisokth2LWF+EWAFJ1eZAUStRiGYsiCLdiyoECHoAgCrOiwzR4Q5IXXpUCGJZATB8acYJK8Ts5msIkEyrbMSKItWhJJUBRlhjzquBfH59EdSTmUYufN8gUEHXnP3T3f7+/v8xzha3yNr/E1vsb/X+x7EDcNaC2F3V6zkFh+IHP5Ity3h1pJ6y4/RiIBgKJpcozX1yiP47EkmdgaLl8TAGomCnz1QtyXhwW0loLu8pNduYOqOlA0Da+vEW9rFwAb6QwHWjysLKfY73axkc7Ia3PrUZsYaib6lYrwpR8U0FoKnvZe1q6HUTQN/6FeAPa7XbZxdR5VCgCmKEKM3Lpp/XgsiZFI4HRlga/GG5Qvc3FAaymkNmuJx5I0PdLFwNHBMuIb6Qx1HrXsWkFejI/HkuaENI3UZi2PHju9p1yyW+xZAEHe5WvCf6jX5u6lItxN6dxN6fL7Oo9qE0VcK3KEy9dEcHJ6r1PbFXYtwL++8SsCWkshm3HS1tPNI998HDBJ3U3p8ngnbKQzUhAr/Id6iceSZu7wNWIkEugu/wP3gl3HmLB8W083jgY/gC2uD7R45FhrzAtYx9xN6TaPuf67q3h9jTIcMrE1PPX5B5oLanczWCQ8PZbE0eAvy+hAmWUFhFcIDyiF9T5CBJevCY+vkQAUHpQIuw6BW3M3bPXcamGRzQGZ3TfSGTbSGVaWU6wsp2zfiWvEWKv1rc97kNiVBwgI17cifjtMPJYkHrsKbFvR3+CXwojrRO0XcnkrPMPqBToQ0B6MF1QtgHD/7PWw/G4jnSF6MyQn7D/Ua/MIR0Mxvt1d27FePPZbRBT3qASvr5FbczdQ63fFq2rsygNEvbdOWDQ+B1o8ZUntXrD1AUXhRCiUhsGDxJ5yAJjESy2+F5SWTG9rlyyFsN0gZTPOB1ISqxIgoLUUfH1/iJFI0NbTfV+IC5RWhNJqAOBUasgaW/fleaWo2gOiN0MomkZ77+GK5yuVtkplshqUhoBYUXrae++7F1QtgJFI4PU17pqoqACl5c+6CKoGTqXmgeSGqpOgomm2zs+6mtvvdpkE8RO9GcJKy0gktide/G8kEtKqjoaMvDa3HsXb2kXO0mcIND3S9UCqwa6qQOkKDszQyPkaWbseplGZxwP0BxrocKt0tnnZocoD8NalG9z97HesxdIoWrJ4LiwF81YQ4n5jT40QIC1tJBIc1pP0du3nh9//VsWxjz7aWfbd7OwiL3a1EwlHWLwVZ2h4gLMRJ5HQNbk5cj9cXuSMnZqoqgXIxNa26/S6SXy0X6Pz2920d7VLkrOzi0Bl0laUno+EI4yeHIFjvZy7GCJ6eZJMIkWq0VftFMsgdqq8xfUEbAsR0FoKC4nlfVUL4PI1ySbFk4wx2u9jaHhgR+Li870gxrYXPaEuFKRvbAyA1y5P8ifHDzM5d4cbqQIrsSROpQbIVztlAA4oOV45FuDli7B2PSw9wtPeSwAKVQsgenMjkeBUBfKRcIT2rnYb+bu9AwAcGR603evKhLnZ8cH4OMdHhpidXZQi9BXHdHv2sXgrDsCPjvh540qUFU2DTHWVQ7TurxwLALA8O0eHX2MpmqPDr0kZqxJgIbG8LwAFXGYV6Gzz8uijnTai3t4BCAVtlo+/N87irTjx98Zt9xNC1XW1Mzu7KO8lCB8ZHuS1V85ytMfL0twd2rva6Z67Q762kVSk+tJZm1jlbu9p6kJB/vj3DnJpOYeqOnjxZ89z7mKIYCxZfQ5YSCzvC2gUsjhZvBXng/EpvCdHTCKhIL9+/2MAjvYclNYUhACOjwzJ49nZRaYmgnS2eaUYYAo7c+YMfWNjKA9/E1ilw222yjdSBVKboao2R0Ts/+iIWW2mJoIspXW6PftoeOx7AJzQ53E36nurApeWc7w4NiItGwc63CoLnyWhxxwjiC3eijM5d4fFW+/aiI795CmbIFZcmZjm5UEnUxNmdYiEI7ueo9fXiPfkiM37QrVNvPR0P3WhIFeLxtmVAKYXtBQyCYN3Xv9njvYclJb9YHyKpbTO5Nwd/tZibYBOsFUKsCfN0nA6MjzIFWDp/Y+JhCO8cSVqesTMh184x4DWUtDqvfiLLfvirThLabN7femnZjgIjzj9wnN78wCX5qHDrTI5d4fJubcB0wM63Kp8mIAQaHZ2kQ/Gp6CCGFYcGR6k2d/MkeFB6kJB/vIf/gOX5iE282HVe4N5rZnRY70266cfM+chyB/tOUhdKLg3AfJaM51tNQxVqP9TE0HbWJHkxF+1aPY30zc2hnpxgZVYkp33mctRm1iVCXgprZN+bMgmyNGeg2b+CgX39l4gHksyOXdHuq6wbClB8fmD8Sk5phJEUhRJdTW6Cpgi/Pu/vYrX18jD3z5Z9UpwxXDIBHy05yDuT81nC0G8J0dk4t61AAuJ5X3iRaaw7vGRIVscz84u2hKbCIO/eu3tsoQneoih4QHp/s3+ZpsQL/30NPHbYXZCQGspWMXxJGMspXUuLec4O7/FjVSBq2feZCmt88Pvf4u6UJC/m1U42nNw72uBifAGHUV3F5aemghWbJBESexwq0xNBGXTJMIiEo5wt3dAEhdo9jdz/jfjnLsYojaxKneFrLlANDy1iVWAglbvpdu/j08W1vmbX/055y6GcH+6xqXlHK/84AgAZyNOfj8+zWR6j2UQoOe734P4VflZVAFryRLEhfKizb0yMU3EkqC8J0fKusXV6CrN/mZOPWOGxZ++/S49bgc3LSKIeq/Pz9MbaOAGXpaiCbo9XtRvfAOA8Ph79AcaWIom+PHff8hov8aJNi//+VmS7xw9tHcBAB4fe5apM2/Kzx1u1db8CPKnX3iOvqJ7Q7E1Hh7kwl/8NQAnxsbKrG8VAaDJaU71kBM+c/kJaObiJrtyB6/bAcCTLQ6WPF4mwhs8/tQQ5y6G6A808MnCOoNPP0UkdI3OthreunSDJw5rtHe17z4HiDpb51E5MjxIZ5tXWv3H//KPPD72LIu34izeitPZ5uX0C8+VWVfE+Ylf/HzH54gxIg90jZwkrhsAPLyZQKv3orv89LgdtLbuB2AprdPhVhnt14henuTquxe4kSrQNXKS0WNmmLx16QY/eLKboeEBfv3+x3vzgBXDgdjVF93WiV/8XLrskeFBueABbMcCp54ZuacIVusDRELXSBoK6AZ99bVEN9IYWcBpv070IaY37GcivIEfeO2VswDczMLZ+S2YXyAVjX25EBANCxb3FhYTddjcFSrHebZF2AniXmCWXl3P4XU7iOYM/A6FuJ5nLp0nvrCOV1WkJwAsfJZEaapntF/j/Ph7ACQNBacrSypivtfY1X6AFQeUHKPHem0TFBP+pz/6iVzkiKVuaX8wO7tI5L1xVi3ClUK4v/CeA0qOTDEP+B0K0ZwZDk3OWvoDDdy+vcEnC+sA9NXXojTVSyH6Aw3mnsLqOk7su0N7aoTy2vakrXX7ysQ0nW1ejo8MEQlHZPMjmiVrDyBcv1TEUhEEVgyHJG9Ff6ABgNbW/fQHGvCqCh8lPuf27Q0AKVS3Zx+B5oayZ+z69bju8rN2Pcy5iyFbchNE2otrfDDzQ19xTB8wc+aMXEaXhowVpd+9+st3zF0o33bAz2zmJXkrWlv3E19YZy6dI170CP/aJtGcQUY3ynJGVQKILiu1WcuBbAwU80XIlYlp2b3Bdnm7MjFNO9hKH0Df2Bh92C1rPbYStybO2sQqh+u3p3phXa9I3ljbZGYzz1o2j6o6WMuaGyAzm3lW8oWKP7b4whAQZS+d2seTDSp9xYmsf/rfZQREOJx6ZoS+CrXdGi6VUOncuYshMomUjfwThzW5UWKFIA/QqBj0uB00KgZJQ0HZ2pJ8rNfc0wMCWkvBlVWpM9L8WauZVIIZ80aZRMoWBpXI7gY7WX9lOSVFF+RlZSk2Wh1uld9eS+BVFbyqA79DYcBVY5svPMTUhoHf5wbLL0529ABBvq++lhMNJW9wVfOySOhaxRr/ZWC93+tvTrP5v5MoTfVEc4adfBGCvGiSAEleHIvPh5wQjaVt7xgrCiD301XFdjMws6p4mEiGYtJWK94ru69GV+V567GV/Ku/fIeF//oIr6pw+/ZGRfJgNj5z6RxgVgi/Q7FY3T7vEw0qQ/sV1q6HpQhlISDIe5IxUBUurOu20hPXDVbyBZStLYyaGoKT0zzfnmU1aia/U8+MlHVxpRDJs5Q0mDG/spxieXaOHreDuG7QH2goIy/WGZeuba89ZjbN+LdWC8AmSDRncMgJN6+Hcbp28IADSk66vlBXIGmYlxg1NShbW3iSMV6+uFDmBed/Y98KF1iNrspWuZKXRC9PcvvjyzbyR3sOlpEH+GRhnZ7iQmglX2AlX2AtmyeY2bL9TW0YzKVzXFg322S/Q6FRMfC091ZOgplECuqraxG8qkJ8fp7X35zmhWftawDRyYklrYAYI/6LDQqApWhCkj/V59vR8qLrExBZHrAlwJnNPLpuesZcOicFA7O82mqi+BHkkw0qA64azsWyrGXz9LgdMgxEqREeIG4Y1w0OfucYzz/dX1GonVy+LhTkZ29dYSlq/rxeLHt3Ig/w22sJ+V1cN+R8hBDf1R4CTHcv9WDBRfAr21nR5+dlDAkF++prparCjYCycjOzmSdpKPh9bvx/cJTRY70VxagLBTkbMZ8RvTxJNJamUSkm1myeJw97bXW+s80ryZ+ficmyCPbar6oODjnta4W4bvYBur5tfVHVgpmtcgEORxfKaqi1ElgTSmmFECKAmSsaFUPuzLT3HiYSusba9TC6blqlyVlrLm0tkxW/LbgX+dL5iNWhdU7W763nS+dtC3R9fl7GvpV8MLNVRnYniB7BC/gdtUQXzc3M8Pz8djjtN110ZjMv7xvNmTFvhSAvYr5SWYbyBZK4X2n/Ugm2K5OGqZZQD6hYU8UDSlFpcicaVE40qIz6nLZcIparn7gfkk0OmHVdbGpYs/1uUDrnSp4qUJbq47ohE8sc2LJmpaRidT2RNCUs14qxSlM9q52D+P7HfM0lmpzSN0qixT0/E7PNrRSiMROeN+CqkXmr0tibWcwQ1Ezha2G7+SFj9tM3s8isejOLTFCw/b2YkBBAqGo9X/pwv0Mx43txGgMzXITlK+H8TKwswwczdmJz6RxGTQ0r+S1ZCkWvIiA82mq8jxKf0+N22EPAStQKccNKFrBCWEGg0vjGOxv0pz+Xbm91eStEh6eqjrJzAqVhKMbqek6GsjCM36HI81YjSTkPKDkq/dJvW5Ri7BZb4L1CWKOS2wtcuhanyVmLV1VIZne+l9+hMLfDuZtZAEOOA5PLWsk4mz+JuInreZLU0KgYNquax7Vl461Jxmp16/kBVw0X1nVaW/fzRIW3yALW9lbA2uWVQlUd8me0up4jrtTKY5zmfUrLoLK1JRuu/wPrVPR0ivBltQAAAABJRU5ErkJggg==", "frustrated": "data:image/png;base64,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", "disappointed": "data:image/png;base64,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", "neutral": "data:image/png;base64,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", "happy": "data:image/png;base64,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", "victory": "data:image/png;base64,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"}, "judy": {"defeat": "data:image/png;base64,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", "frustrated": "data:image/png;base64,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", "disappointed": "data:image/png;base64,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", "neutral": "data:image/png;base64,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", "happy": "data:image/png;base64,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", "victory": "data:image/png;base64,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"}, "viktor": {"defeat": "data:image/png;base64,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", "frustrated": "data:image/png;base64,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", "disappointed": "data:image/png;base64,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", "neutral": "data:image/png;base64,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", "happy": "data:image/png;base64,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", "victory": "data:image/png;base64,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"}, "margaret": {"defeat": "data:image/png;base64,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", "frustrated": "data:image/png;base64,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", "disappointed": "data:image/png;base64,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", "neutral": "data:image/png;base64,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", "happy": "data:image/png;base64,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", "victory": "data:image/png;base64,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"}};
// Proportional dialogue font: 7px caps, lowercase, 2px descenders (9 rows).
const VF = {"A":[".###.","#...#","#...#","#####","#...#","#...#","#...#",".....","....."],"B":["####.","#...#","#...#","####.","#...#","#...#","####.",".....","....."],"C":[".###.","#...#","#....","#....","#....","#...#",".###.",".....","....."],"D":["####.","#...#","#...#","#...#","#...#","#...#","####.",".....","....."],"E":["####","#...","#...","###.","#...","#...","####","....","...."],"F":["####","#...","#...","###.","#...","#...","#...","....","...."],"G":[".###.","#...#","#....","#.###","#...#","#...#",".####",".....","....."],"H":["#...#","#...#","#...#","#####","#...#","#...#","#...#",".....","....."],"I":["###",".#.",".#.",".#.",".#.",".#.","###","...","..."],"J":["..##","...#","...#","...#","...#","#..#",".##.","....","...."],"K":["#...#","#..#.","#.#..","##...","#.#..","#..#.","#...#",".....","....."],"L":["#...","#...","#...","#...","#...","#...","####","....","...."],"M":["#...#","##.##","#.#.#","#.#.#","#...#","#...#","#...#",".....","....."],"N":["#...#","##..#","#.#.#","#..##","#...#","#...#","#...#",".....","....."],"O":[".###.","#...#","#...#","#...#","#...#","#...#",".###.",".....","....."],"P":["####.","#...#","#...#","####.","#....","#....","#....",".....","....."],"Q":[".###.","#...#","#...#","#...#","#.#.#","#..#.",".##.#",".....","....."],"R":["####.","#...#","#...#","####.","#.#..","#..#.","#...#",".....","....."],"S":[".###.","#...#","#....",".###.","....#","#...#",".###.",".....","....."],"T":["#####","..#..","..#..","..#..","..#..","..#..","..#..",".....","....."],"U":["#...#","#...#","#...#","#...#","#...#","#...#",".###.",".....","....."],"V":["#...#","#...#","#...#","#...#",".#.#.",".#.#.","..#..",".....","....."],"W":["#...#","#...#","#...#","#.#.#","#.#.#","##.##","#...#",".....","....."],"X":["#...#","#...#",".#.#.","..#..",".#.#.","#...#","#...#",".....","....."],"Y":["#...#","#...#",".#.#.","..#..","..#..","..#..","..#..",".....","....."],"Z":["#####","....#","...#.","..#..",".#...","#....","#####",".....","....."],"a":["....","....",".##.","...#",".###","#..#",".###","....","...."],"b":["#...","#...","###.","#..#","#..#","#..#","###.","....","...."],"c":["...","...",".##","#..","#..","#..",".##","...","..."],"d":["...#","...#",".###","#..#","#..#","#..#",".###","....","...."],"e":["....","....",".##.","#..#","####","#...",".###","....","...."],"f":[".##","#..","###","#..","#..","#..","#..","...","..."],"g":["....","....",".###","#..#","#..#","#..#",".###","...#",".##."],"h":["#...","#...","###.","#..#","#..#","#..#","#..#","....","...."],"i":["#",".","#","#","#","#","#",".","."],"j":[".#","..",".#",".#",".#",".#",".#",".#","#."],"k":["#...","#...","#..#","#.#.","##..","#.#.","#..#","....","...."],"l":["#.","#.","#.","#.","#.","#.",".#","..",".."],"m":[".....",".....","####.","#.#.#","#.#.#","#.#.#","#.#.#",".....","....."],"n":["....","....","###.","#..#","#..#","#..#","#..#","....","...."],"o":["....","....",".##.","#..#","#..#","#..#",".##.","....","...."],"p":["....","....","###.","#..#","#..#","#..#","###.","#...","#..."],"q":["....","....",".###","#..#","#..#","#..#",".###","...#","...#"],"r":["...","...","#.#","##.","#..","#..","#..","...","..."],"s":["....","....",".###","#...",".##.","...#","###.","....","...."],"t":[".#.",".#.","###",".#.",".#.",".#.","..#","...","..."],"u":["....","....","#..#","#..#","#..#","#..#",".###","....","...."],"v":[".....",".....","#...#","#...#",".#.#.",".#.#.","..#..",".....","....."],"w":[".....",".....","#...#","#...#","#.#.#","#.#.#",".#.#.",".....","....."],"x":["....","....","#..#","#..#",".##.","#..#","#..#","....","...."],"y":["....","....","#..#","#..#","#..#","#..#",".###","...#",".##."],"z":["....","....","####","..#.",".#..","#...","####","....","...."],"0":[".##.","#..#","#..#","#..#","#..#","#..#",".##.","....","...."],"1":[".#.","##.",".#.",".#.",".#.",".#.","###","...","..."],"2":[".##.","#..#","...#","..#.",".#..","#...","####","....","...."],"3":["###.","...#","...#",".##.","...#","...#","###.","....","...."],"4":["#..#","#..#","#..#","####","...#","...#","...#","....","...."],"5":["####","#...","#...","###.","...#","...#","###.","....","...."],"6":[".##.","#...","#...","###.","#..#","#..#",".##.","....","...."],"7":["####","...#","..#.","..#.",".#..",".#..",".#..","....","...."],"8":[".##.","#..#","#..#",".##.","#..#","#..#",".##.","....","...."],"9":[".##.","#..#","#..#",".###","...#","...#",".##.","....","...."]," ":["..","..","..","..","..","..","..","..",".."],".":[".",".",".",".",".",".","#",".","."],",":["..","..","..","..","..",".#",".#","#.",".."],"!":["#","#","#","#","#",".","#",".","."],"?":[".##.","#..#","...#","..#.",".#..","....",".#..","....","...."],"'":["#","#",".",".",".",".",".",".","."],"\"":["#.#","#.#","...","...","...","...","...","...","..."],"-":["...","...","...","###","...","...","...","...","..."],"+":["...","...",".#.","###",".#.","...","...","...","..."],":":[".",".","#",".",".","#",".",".","."],"/":["..#","..#",".#.",".#.",".#.","#..","#..","...","..."],"*":["...","...","#.#",".#.","#.#","...","...","...","..."],"(":[".#","#.","#.","#.","#.","#.",".#","..",".."],")":["#.",".#",".#",".#",".#",".#","#.","..",".."],"=":["...","...","###","...","###","...","...","...","..."],"<":["...","..#",".#.","#..",".#.","..#","...","...","..."],">":["...","#..",".#.","..#",".#.","#..","...","...","..."],"%":["#...#","#..#.","...#.","..#..",".#...",".#..#","#...#",".....","....."],"&":[".##..","#..#.",".##..","#.#.#","#..#.","#..#.",".##.#",".....","....."],"#":[".#.#.","#####",".#.#.",".#.#.",".#.#.","#####",".#.#.",".....","....."],"^":[".#.","#.#","...","...","...","...","...","...","..."],"~":[".....",".....",".#..#","#.##.",".....",".....",".....",".....","....."],"$":[".###.","#.#..","#.#..",".###.","..#.#","..#.#",".###.",".....","....."]};
// Portraits on a scale: defeat < frustrated < disappointed < neutral < happy < victory.
const PORT = {};
for (const k in PORTRAIT_SRC) { PORT[k] = {}; for (const m in PORTRAIT_SRC[k]) { const im = new Image(); im.src = PORTRAIT_SRC[k][m]; PORT[k][m] = im; } }
const face = (who, mood = 'neutral') => { const p = PORT[who]; return p && (p[mood] || p.neutral); };
// Which face goes with which moment.
// Brenda, Hank and Margaret mean it when they say well shot: they smile, they don't sulk.
const GOOD_SPORT = new Set(['brenda', 'hank', 'margaret']);
const MOOD = {
  intro: { brenda: 'happy', hank: 'happy', margaret: 'happy', _: 'neutral' }, call: { _: 'happy' }, lock: { _: 'frustrated' }, oppWin: { _: 'happy' }, oppLose: { brenda: 'happy', _: 'disappointed' }, tilt: { _: 'frustrated' },
  soff: { _: 'neutral' }, youWin: { brenda: 'happy', hank: 'happy', margaret: 'happy', _: 'defeat' }, youLose: { _: 'victory' },
};
// Losing an end mid-match they shrug off; losing the one that puts you on match point makes them mad.
const moodFor = (key, who) => {
  // ...except the good sports, who are pleased for you every time.
  if (key === 'oppLose' && G && G.match && G.sets[0] >= 4 && !GOOD_SPORT.has(who)) return 'frustrated';
  return (MOOD[key] && (MOOD[key][who] || MOOD[key]._)) || 'neutral';
};
// What the bale mates say. Keys match opp.icon / PORT.
const TALK = {
  brenda: { intro: ["Hi hon! I'm Brenda.", "Thirty years of league nights. Never missed one.", "We always shoot a practice end first."],
    oppWin: ["Oh! Would you look at that.", "Huh! Lucky me."], oppLose: ["Ooh, nice group, hon!", "Well, that's why they call it practice."],
    soff: ["Oh my heart. Okay. Okay!"], youWin: ["Nice shooting, hon!"], youLose: ["Good match, hon. Same time next week."],
    tutDraw: ["Tap A to draw.", "Tap A again to set your height."],
    tutHold: ["Now tap A to let it go.", "Mind your heartbeat, hon."],
    tutCrawl: ["High, huh? Up close, come down a few marks.", "Press DOWN to bring your tab down. Then shoot again."],
    tutTab: ["Tab first, hon. Press DOWN."],
    tutGo: ["Okay! Now it counts. Good luck, hon."] },
  dale: { intro: ["So you're string walking? Bold.", "Back in '89 we didn't need crawls. We had instinct."],
    oppWin: ["See, that's follow-through. Write that down.", "That's forty years of reps, friend."], oppLose: ["Wind got me. Wind's tricky out here.", "My tab's sticking. Happens."],
    soff: ["Shoot-off. My specialty, honestly."], youWin: ["Huh. Well. My tab's worn out, is all."], youLose: ["Don't feel bad. I've been doing this forty years."] },
  chad: { intro: ["Nice bow. Is that... last year's riser?", "This setup's four grand. Just so you know.", "Mind if I film you? Flash is on. It's fine."],
    oppWin: ["That's the carbon talking, bro.", "Can't buy that. Well. I did."], oppLose: ["My limbs need re-tuning, honestly.", "Gotta be the new string settling."],
    soff: ["Pressure's a privilege, bro."], youWin: ["I'm getting new limbs. Like, tomorrow."], youLose: ["Gear matters, bro. Gear matters."] },
  kid: { intro: ["...", "Let's just shoot."],
    oppWin: ["Mm.", "Okay."], oppLose: ["...", "Huh."],
    tilt: ["Wait. That's not... that's not right.", "Why is my release doing that?"],
    soff: ["Closest wins. Okay."], youWin: ["...good match. Seriously."], youLose: ["Good shooting. You'll get there."] },
};
Object.assign(TALK, {
  hank: { intro: ["Name's Hank. Don't mind me, I shoot quick.", 'Longbow, cedar arrows. No sight, no crawl, no clicker.', "Don't overthink it. Just feel it."],
    oppWin: ["Didn't even look. That's the trick.", "Instinct, friend. Can't teach it."], oppLose: ["Huh. Cedar's warped a hair.", "Too much thinkin' on my end."],
    soff: ["One arrow? Heck, that's my favorite kind."], youWin: ["Well I'll be. Good shootin'."], youLose: ["Quit aimin' so hard. You'll get there."] },
  judy: { intro: ["Judy. Range official. Yes, I'm also shooting. It's allowed.", 'Thirty meters. Your crawl should be well up from eighteen.', "And if it's on the line, I decide that."],
    call: ["That's not touching.", "Line's unbroken. Lower score.", "I'd need a magnifying glass for that one. I don't have one."],
    oppWin: ['Clean end. Unlike some.', 'Noted.'], oppLose: ["Hm. I'll allow it.", 'Wind. For the record.'],
    soff: ["Closest to center. I'll be measuring."], youWin: ['Fine. Your scorecard is correct. I checked it twice.'], youLose: ['Rules are rules. Sign here.'] },
  viktor: { intro: ['Viktor. I coached two Olympians. Neither listened.', 'You hold too long. Everybody holds too long.', 'So I count for you. You are welcome.'],
    oppWin: ['Good. Is how you do it.', 'Four seconds. Always four.'], oppLose: ['Wind. Not me.', 'Hm. I am old now.'],
    soff: ['One arrow. Do not think.'], youWin: ['...Acceptable. Hold shorter next time.'], youLose: ['You think too much. I said this.'] },
  margaret: { intro: ["Hello, dear. I'm Margaret.", "I shot in Munich in '72. Recurve, before all the gadgets.", "Don't go easy on me. I certainly won't."],
    lock: ["Alright, dear. Now we're shooting.", "Oh, you've woken me up."],
    oppWin: ['There it is.', 'Old habits, dear.'], oppLose: ['Oh, well shot.', "Now that's interesting."],
    soff: ["One arrow. I've done this before."], youWin: ["Well done, dear. Don't let it go to your head."], youLose: ['Lovely match, dear. Keep at it.'] },
});
// One-time teaching flags, remembered between runs.
const SEEN = (() => { try { return JSON.parse(localStorage.getItem('linecutter_seen')) || {}; } catch (e) { return {}; } })();
const seen = k => { if (SEEN[k]) return; SEEN[k] = true; try { localStorage.setItem('linecutter_seen', JSON.stringify(SEEN)); } catch (e) {} };
const VOICE = { brenda: 560, dale: 250, chad: 330, kid: 470, hank: 210, judy: 520, viktor: 190, margaret: 620 };

// ---------- helpers ----------
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, k) => a + (b - a) * k;
const rand = Math.random;
const randInt = (a, b) => a + Math.floor(rand() * (b - a + 1));
const gauss = () => { let u = 0, v = 0; while (!u) u = rand(); while (!v) v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(6.2832 * v); };
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const fr = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(Math.round(x), Math.round(y), w, h); };
function line(x0, y0, x1, y1, c, g = ctx) {
  x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let e = dx + dy; g.fillStyle = c;
  for (let n = 0; n < 500; n++) {
    g.fillRect(x0, y0, 1, 1);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * e;
    if (e2 >= dy) { e += dy; x0 += sx; }
    if (e2 <= dx) { e += dx; y0 += sy; }
  }
}
function rrect(x, y, w, h, c) { fr(x + 2, y, w - 4, 1, c); fr(x + 1, y + 1, w - 2, 1, c); fr(x, y + 2, w, h - 4, c); fr(x + 1, y + h - 2, w - 2, 1, c); fr(x + 2, y + h - 1, w - 4, 1, c); }
function rring(x, y, w, h, c) {
  fr(x + 2, y, w - 4, 1, c); fr(x + 2, y + h - 1, w - 4, 1, c); fr(x, y + 2, 1, h - 4, c); fr(x + w - 1, y + 2, 1, h - 4, c);
  fr(x + 1, y + 1, 1, 1, c); fr(x + w - 2, y + 1, 1, 1, c); fr(x + 1, y + h - 2, 1, 1, c); fr(x + w - 2, y + h - 2, 1, 1, c);
}
// Advance Wars-style frame: rounded, dark outline, coloured bevel ring, a glint on top.
function box(x, y, w, h, fill = C.panel, edge = C.edge) {
  rrect(x + 1, y + 1, w - 2, h - 2, fill); rring(x, y, w, h, '#0e0a16'); rring(x + 1, y + 1, w - 2, h - 2, edge);
  fr(x + 3, y + 2, w - 6, 1, 'rgba(255,255,255,0.2)');
}

// ---------- bitmap font (3x5) ----------
const GL = {};
const GSRC = {
  A: '.#. #.# ### #.# #.#', B: '##. #.# ##. #.# ##.', C: '.## #.. #.. #.. .##', D: '##. #.# #.# #.# ##.',
  E: '### #.. ##. #.. ###', F: '### #.. ##. #.. #..', G: '.## #.. #.# #.# .##', H: '#.# #.# ### #.# #.#',
  I: '### .#. .#. .#. ###', J: '..# ..# ..# #.# .#.', K: '#.# #.# ##. #.# #.#', L: '#.. #.. #.. #.. ###',
  M: '#.# ### ### #.# #.#', N: '##. #.# #.# #.# #.#', O: '.#. #.# #.# #.# .#.', P: '##. #.# ##. #.. #..',
  Q: '.#. #.# #.# ##. .##', R: '##. #.# ##. #.# #.#', S: '.## #.. .#. ..# ##.', T: '### .#. .#. .#. .#.',
  U: '#.# #.# #.# #.# ###', V: '#.# #.# #.# #.# .#.', W: '#.# #.# ### ### #.#', X: '#.# #.# .#. #.# #.#',
  Y: '#.# #.# .#. .#. .#.', Z: '### ..# .#. #.. ###',
  0: '### #.# #.# #.# ###', 1: '.#. ##. .#. .#. ###', 2: '##. ..# .#. #.. ###', 3: '##. ..# .#. ..# ##.',
  4: '#.# #.# ### ..# ..#', 5: '### #.. ##. ..# ##.', 6: '.## #.. ### #.# ###', 7: '### ..# .#. .#. .#.',
  8: '### #.# ### #.# ###', 9: '### #.# ### ..# ##.',
  '.': '... ... ... ... .#.', ',': '... ... ... .#. #..', '!': '.#. .#. .#. ... .#.', '?': '##. ..# .#. ... .#.',
  '-': '... ... ### ... ...', '+': '... .#. ### .#. ...', '*': '... #.# .#. #.# ...', ':': '... .#. ... .#. ...',
  '/': '..# ..# .#. #.. #..', "'": '.#. .#. ... ... ...', '"': '#.# #.# ... ... ...', '(': '.#. #.. #.. #.. .#.',
  ')': '.#. ..# ..# ..# .#.', '<': '..# .#. #.. .#. ..#', '>': '#.. .#. ..# .#. #..', '^': '.#. #.# ... ... ...',
  '=': '... ### ... ### ...', '%': '#.# ..# .#. #.. #.#',
};
for (const k in GSRC) GL[k] = GSRC[k].split(' ');
const OUTLINE = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1]];
const tw = (s, sc = 1) => String(s).length * 4 * sc - sc;
function text(s, x, y, col = C.text, sc = 1, sh = C.ink) {
  s = String(s).toUpperCase();
  if (sh) for (const [dx, dy] of OUTLINE) text(s, x + dx, y + dy, sh, sc, null);
  ctx.fillStyle = col;
  let cx = Math.round(x); const cy = Math.round(y);
  for (const ch of s) {
    const g = GL[ch];
    if (g) for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) if (g[r][c] === '#') ctx.fillRect(cx + c * sc, cy + r * sc, sc, sc);
    cx += 4 * sc;
  }
}
const ctext = (s, y, col, sc = 1, sh) => sc === 1 ? vtext(String(s).toUpperCase(), Math.round(W / 2 - vw(String(s).toUpperCase()) / 2), y, col, sh) : text(s, Math.round(W / 2 - tw(s, sc) / 2), y, col, sc, sh);
// Proportional font (VF): dialogue, cards, intro cards.
const vw = s => { let w = 0; for (const ch of String(s)) { const g = VF[ch]; w += (g ? g[0].length : 2) + 1; } return Math.max(0, w - 1); };
function vtext(s, x, y, col = C.text, sh = null) {
  s = String(s); if (sh) for (const [dx, dy] of OUTLINE) vtext(s, x + dx, y + dy, sh, null);
  ctx.fillStyle = col; let cx = Math.round(x); const cy = Math.round(y);
  for (const ch of s) {
    const g = VF[ch] || VF['?'];
    for (let r = 0; r < 9; r++) { const row = g[r]; for (let c = 0; c < row.length; c++) if (row[c] === '#') ctx.fillRect(cx + c, cy + r, 1, 1); }
    cx += g[0].length + 1;
  }
}
const vctext = (s, y, col, sh) => vtext(s, Math.round(W / 2 - vw(s) / 2), y, col, sh);
// HUD text: the dialogue font in caps (readable on a phone), and chunky 2x numbers for the readouts you glance at.
const hw = s => vw(String(s).toUpperCase());
const htext = (s, x, y, col = C.text, sh = null) => vtext(String(s).toUpperCase(), x, y, col, sh);
const hctext = (s, cx, y, col, sh) => htext(s, Math.round(cx - hw(s) / 2), y, col, sh);
const big = (s, x, y, col = C.text) => text(s, x, y, col, 2, C.ink);
const bigc = (s, cx, y, col) => big(s, Math.round(cx - tw(s, 2) / 2), y, col);
function vwrap(s, maxW) {
  const out = []; let cur = '';
  for (const w of String(s).split(' ')) { const t = cur ? cur + ' ' + w : w; if (vw(t) > maxW && cur) { out.push(cur); cur = w; } else cur = t; }
  if (cur) out.push(cur); return out;
}
function wrap(s, max) {
  const out = []; let cur = '';
  for (const w of s.split(' ')) { if ((cur + ' ' + w).trim().length > max) { if (cur) out.push(cur); cur = w; } else cur = (cur + ' ' + w).trim(); }
  if (cur) out.push(cur); return out;
}

// ---------- 8x8 icons ----------
const ICON_PAL = { k: '#1a1426', w: '#f2ead8', b: '#7a4a2a', B: '#c48a52', r: '#e2553f', y: '#f4cf4a', u: '#4f9bd6', g: '#b8b0c8', p: '#f08aa0' };
const ICONS = {
  tab:   ['..bbbb..', '.bBBBBb.', 'bBBBBBBb', 'bBkBBkBb', 'bBBBBBBb', 'bBBBBBBb', '.bBBBBb.', '..bbbb..'],
  lungs: ['...kk...', '...kk...', '.ppkkpp.', 'pppkkppp', 'ppp..ppp', 'ppp..ppp', 'pp....pp', '.p....p.'],
  book:  ['kkkkkkk.', 'kwwwwwk.', 'kwkkkwk.', 'kwwwwwk.', 'kwkkwwk.', 'kwwwwwkr', 'kwkkkwkr', 'kkkkkkk.'],
  hat:   ['........', '...bbb..', '..bBBBb.', '..bkkkb.', 'bbbbbbbb', '.bbbbbb.', '........', '........'],
  xring: ['..uuuu..', '.urrrru.', 'uryyyyru', 'uryykyru', 'urykyyru', 'uryyyyru', '.urrrru.', '..uuuu..'],
  eye:   ['........', '........', 'w......w', '.wwwwww.', '.w.w.w.w', '........', '........', '........'],
  chat:  ['.wwwwww.', 'wwwwwwww', 'wkwkwkww', 'wwwwwwww', '.wwwwww.', '..ww....', '.w......', '........'],
  bare:  ['.......g', '......g.', '.....g..', '....g...', '...g....', '..g.....', '.g......', 'k.......'],
  dale:  ['.rrrrr..', 'rrrrrrr.', '.BBBBB..', '.BkBkB..', '.BBBBB..', '.kkkkk..', '.BBBBB..', '..BBB...'],
  kid:   ['..uuuuu.', '.uuuuuuu', '.BBBBB..', '.BkBkB..', '.BBBBB..', '.BBkBB..', '..BBB...', '........'],
  brenda:  ['.pppppp.', 'pppppppp', 'pBBBBBBp', 'pBkBBkBp', '.BBBBBB.', '.BBrrBB.', '..BBBB..', '........'],
  chad:    ['.kkkkkk.', 'kkkkkkkk', '.BBBBBB.', 'kkkBBkkk', '.BBBBBB.', '.BwwwwB.', '..BBBB..', '........'],
  weights: ['........', '.g....g.', 'gg....gg', 'gggggggg', 'gggggggg', 'gg....gg', '.g....g.', '........'],
  clock:   ['..wwww..', '.wkwwww.', 'wwkwwwww', 'wwkkkwww', 'wwwwwwww', 'wwwwwwww', '.wwwwww.', '..wwww..'],
  back:    ['...BB...', '..BBBB..', '.BBBBBB.', 'BBB..BBB', 'BB....BB', 'BB....BB', '.B....B.', '........'],
  tuned:   ['r......r', '.r....r.', '..g..g..', '...gg...', '...gg...', '..g..g..', '.u....u.', 'u......u'],
  anchor:  ['...gg...', '..g..g..', '...gg...', '...gg...', 'g..gg..g', 'gg.gg.gg', '.gggggg.', '..gggg..'],
  chartic: ['wwwwwww.', 'wkwwkww.', 'wwwwwww.', 'wkwkkww.', 'wwwwwww.', 'wkkwkww.', 'wwwwwww.', '........'],
  plunger: ['g.......', 'gg......', '.gggggg.', '.gyyyygg', '.gggggg.', 'gg......', 'g.......', '........'],
  grip:    ['..bbbb..', '.bBBBBb.', '.bkkkkb.', '.bBBBBb.', '.bkkkkb.', '.bBBBBb.', '.bkkkkb.', '..bbbb..'],
  fat:     ['.....ggg', '....gggg', '...gggg.', '..gggg..', '.gggg...', 'rggg....', 'rrg.....', 'rr......'],
  coach:   ['......y.', '....yyy.', '..yyyyy.', 'yyyyyyy.', 'yyyyyyy.', '..yyyyy.', '....yyy.', '......y.'],
  ice:     ['.uuuuuu.', 'uwwuuuuu', 'uwuuuuuu', 'uuuuuuuu', 'uuuuuuuu', 'uuuuuwuu', 'uuuuuuuu', '.uuuuuu.'],
  clicker:  ['...g....', '...g....', '...g....', 'BBBgBBBw', '...g....', '..ggg...', '........', '........'],
  limbs:    ['wBB.....', 'w.BB....', 'w..BB...', 'w..BBk..', 'w..BBk..', 'w..BB...', 'w.BB....', 'wBB.....'],
  plugs:    ['........', '.yy..yy.', 'yyy..yyy', 'yyy..yyy', '.yy..yy.', '..g..g..', '..g..g..', '...gg...'],
  instinct: ['........', '........', 'w......w', '.w....w.', '..wwww..', '.w.w.w..', '........', '........'],
  closer:   ['........', 'yyy.....', '...y....', '.yy.....', 'y...r..r', 'yyyy.rr.', '.....rr.', '....r..r'],
  dice:     ['wwwwwww.', 'wkwwwkw.', 'wwwwwww.', 'wwwkwww.', 'wwwwwww.', 'wkwwwkw.', 'wwwwwww.', '........'],
  phone:    ['.kkkkk..', '.kuuuk..', '.kuwuk..', '.kuuuk..', '.kuuuk..', '.kkkkk..', '.kkwkk..', '........'],
  mug:      ['.wwwww..', '.yyyyyww', '.yyyyy.w', '.yyyyy.w', '.yyyyyww', '.yyyyy..', '.yyyyy..', '........'],
  heart: ['.rr.rr..', 'rrrrrrr.', 'rrrrrrr.', '.rrrrr..', '..rrr...', '...r....', '........', '........'],
};
function icon(name, x, y, s = 1) {
  const rows = ICONS[name]; if (!rows) return;
  for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) { const ch = rows[j][i]; if (ch !== '.') fr(x + i * s, y + j * s, s, s, ICON_PAL[ch]); }
}

// ---------- target face (pre-rendered) ----------
const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const FACE = (() => {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'); const img = g.createImageData(W, H); const R = T.ringR;
  const cols = [C.gold, C.gold, C.red, C.red, C.blue, C.blue, C.black, C.black, C.white, C.white].map(hex);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const d = Math.hypot(i + 0.5 - TX, j + 0.5 - TY);
    if (d > 10 * R + 0.6) continue;
    const k = Math.min(9, Math.floor(d / R));
    let col = cols[k];
    const nearLine = Math.abs(d - Math.round(d / R) * R) < 0.42 || Math.abs(d - R / 2) < 0.32;
    if (nearLine) col = (k === 6 || k === 7) ? [140, 136, 150] : [70, 50, 64];
    if (d > 10 * R) col = [70, 50, 64];
    const p = (j * W + i) * 4; img.data[p] = col[0]; img.data[p + 1] = col[1]; img.data[p + 2] = col[2]; img.data[p + 3] = 255;
  }
  g.putImageData(img, 0, 0); return c;
})();

// ---------- venue backgrounds ----------
function makeBg(kind, butt = true, dist = 50) {
  const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
  const f = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x, y, w, h); };
  const dith = (x, y, w, h, a, b) => { f(x, y, w, h, a); g.fillStyle = b; for (let j = y; j < y + h; j++) for (let i = x + (j & 1); i < x + w; i += 2) g.fillRect(i, j, 1, 1); };
  let seed = 7; const sr = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  if (kind === 'hall') {
    f(0, 0, W, H, '#5d4b6e');
    for (let i = 0; i < W; i += 20) f(i, 12, 1, 92, '#4c3c5c');
    for (let i = 10; i < W; i += 40) { f(i, 13, 8, 2, '#fff3c0'); dith(i - 2, 15, 12, 3, '#5d4b6e', '#7a6a84'); }
    f(0, 104, W, 4, '#3e3050'); f(0, 108, W, 52, '#8a6440');
    for (let j = 112; j < H; j += 6) f(0, j, W, 1, '#76522f');
    for (let j = 108; j < H; j += 6) for (let i = (j * 7) % 30; i < W; i += 30) f(i, j, 1, 6, '#76522f');
  } else if (kind === 'fair') {
    f(0, 0, W, 44, '#7cc4ea'); dith(0, 44, W, 8, '#7cc4ea', '#a8daf2'); f(0, 52, W, 40, '#a8daf2');
    const tent = (cx, top, h, hw, a, b) => { for (let r = 0; r < h; r++) { const w = Math.round(hw * (r + 1) / h); for (let i = cx - w; i <= cx + w; i++) { g.fillStyle = (Math.floor((i - cx + 100) / 4) % 2) ? a : b; g.fillRect(i, top + r, 1, 1); } } f(cx - hw, top + h, hw * 2 + 1, 14, a); };
    tent(26, 54, 18, 22, '#e2553f', '#f2ead8'); tent(214, 50, 22, 26, '#4f9bd6', '#f2ead8'); tent(150, 62, 12, 14, '#f4cf4a', '#e2553f');
    f(0, 90, W, 70, '#5fa040'); dith(0, 90, W, 4, '#5fa040', '#7cbc58');
    for (let i = 0; i < 400; i++) f(Math.floor(sr() * W), 96 + Math.floor(sr() * 64), 1, 2, '#4e8a34');
    for (let i = 0; i < W; i += 8) { line(i, 10 + ((i / 8) % 2), i + 8, 10 + (((i / 8) + 1) % 2), '#3a2a2a', g); f(i + 2, 12, 3, 3, ['#e2553f', '#f4cf4a', '#4f9bd6'][(i / 8) % 3]); }
  } else {
    const bands = ['#2c2050', '#4a2a62', '#7a3a6a', '#b85a5a', '#e88a4a', '#f4b860'];
    bands.forEach((b, n) => { f(0, n * 14, W, 14, b); if (n) dith(0, n * 14, W, 3, bands[n - 1], b); });
    for (let j = -10; j <= 10; j++) for (let i = -10; i <= 10; i++) if (i * i + j * j <= 100) f(60 + i, 72 + j, 1, 1, '#ffe2a8');
    for (let x = 0; x < W; x++) { const h = Math.round(64 + 10 * Math.sin(x * 0.045) + 7 * Math.sin(x * 0.13 + 1)); f(x, h, 1, 100 - h, '#4a2c58'); }
    for (let x = 0; x < W; x++) { const h = Math.round(80 + 6 * Math.sin(x * 0.07 + 2) + 4 * Math.sin(x * 0.19)); f(x, h, 1, 100 - h, '#2e2244'); }
    f(0, 100, W, 60, '#3a6a38'); dith(0, 100, W, 3, '#2e2244', '#3a6a38');
    for (let i = 0; i < 300; i++) f(Math.floor(sr() * W), 104 + Math.floor(sr() * 56), 1, 2, '#2f5a2e');
  }
  if (!butt) return c;
  // straw butt + stand. The face is always drawn the same size (real faces subtend about the same
  // angle at every distance), so distance shows in the boss around it: up close at 18m the 40cm face
  // is a spot on a wall of straw; at 50m the 122cm face nearly fills a small, far-off boss.
  const bs = Math.round(dist <= 18 ? 168 : dist <= 30 ? 116 : 100), bx = TX - bs / 2, by = TY - bs / 2;
  if (dist > 30) { f(0, 98, W, 1, '#2a4a28'); for (const x of [-6, 228]) { f(x, 88, 16, 16, '#8a6a40'); f(x + 1, 89, 14, 14, '#b8925c'); f(x + 3, 104, 2, 4, '#5a3a22'); f(x + 11, 104, 2, 4, '#5a3a22'); } }   // neighbouring bales, far off
  f(bx, by, bs, bs, '#8a6a40'); f(bx + 1, by + 1, bs - 2, bs - 2, '#c9a36a');
  for (let i = 0; i < bs * 8; i++) f(bx + 1 + Math.floor(sr() * (bs - 3)), by + 1 + Math.floor(sr() * (bs - 2)), 2, 1, sr() < .5 ? '#b38c56' : '#dcb97e');
  const legH = dist > 30 ? 6 : 12, legY = by + bs;
  if (legY < H) { f(bx + 8, legY, 4, legH, '#5a3a22'); f(bx + bs - 12, legY, 4, legH, '#5a3a22'); }
  return c;
}
const TITLE_BG = makeBg('ridge', false);

// ---------- audio ----------
let AC = null, master = null, noiseBuf = null;
// Returns true when this call is what woke the audio up (first gesture).
function ensureAudio() {
  if (opts.audio === false) return false;
  const wasLive = !!(AC && master && AC.state === 'running');
  if (!AC && opts.audio && opts.audio.createOscillator) AC = opts.audio;
  if (!AC || !master) {
    try {
      AC = AC || new (window.AudioContext || window.webkitAudioContext)();
      master = AC.createGain(); master.gain.value = 0.7; master.connect(AC.destination);
      noiseBuf = AC.createBuffer(1, AC.sampleRate, AC.sampleRate);
      const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = rand() * 2 - 1;
    } catch (e) { AC = null; }
  }
  if (AC && AC.state === 'suspended') AC.resume();
  return !wasLive && !!AC;
}
function tone(f, d, type = 'square', v = 0.05, f2 = null, delay = 0) {
  if (!AC || SILENT) return; const t = AC.currentTime + delay;
  const o = AC.createOscillator(), g = AC.createGain(); o.type = type;
  o.frequency.setValueAtTime(f, t); if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + d);
  g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
  o.connect(g); g.connect(master); o.start(t); o.stop(t + d + 0.03);
}
function noise(d, v = 0.08, freq = 2000, type = 'lowpass', delay = 0) {
  if (!AC || SILENT) return; const t = AC.currentTime + delay;
  const s = AC.createBufferSource(); s.buffer = noiseBuf; const fl = AC.createBiquadFilter(); fl.type = type; fl.frequency.value = freq;
  const g = AC.createGain(); g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
  s.connect(fl); fl.connect(g); g.connect(master); s.start(t, rand() * 0.5); s.stop(t + d + 0.03);
}
// ---------- music: a tiny tracker with Pilotwings-style voices ----------
// FM electric piano, fretless bass, soft synth brass, vibes, brushes and rim.
// Notation: "NOTE:len" in 16th-note steps, "r:len" rests. Every song is 8 bars and loops.
const NOTE_IX = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };
const midiOf = n => { const m = n.match(/^([A-G]#?)(-?\d)$/); return NOTE_IX[m[1]] + (+m[2] + 1) * 12; };
const hz = m => 440 * Math.pow(2, (m - 69) / 12);
function track(inst, str) {
  const ev = []; let t = 0;
  for (const tok of str.trim().split(/\s+/)) { const [n, d] = tok.split(':'); if (n !== 'r') ev.push({ t, inst, m: midiOf(n), len: +d }); t += +d; }
  return ev;
}
// Chord comping: one chord per bar ("A|B" switches chord halfway). Each 'x' in the 16-step
// rhythm strikes the chord and holds it until the next hit (or the next '-' rest).
function comp(inst, chords, rhythm) {
  const ev = [], hits = [];
  [...rhythm].forEach((c, s) => { if (c === 'x') hits.push(s); });
  chords.forEach((ch, bar) => {
    const [a, b] = ch.split('|');
    hits.forEach((s, k) => {
      let end = k + 1 < hits.length ? hits[k + 1] : 16; const r = rhythm.indexOf('-', s); if (r > s && r < end) end = r;
      const notes = (b && s >= 8 ? b : a).split(' ');
      notes.forEach(n => ev.push({ t: bar * 16 + s, inst, m: midiOf(n), len: end - s }));
    });
  });
  return ev;
}
function drums(bar) { const ev = []; for (let b = 0; b < 8; b++) [...bar].forEach((c, s) => { if (c !== '.') ev.push({ t: b * 16 + s, inst: c, m: 0, len: 1 }); }); return ev; }
function song(bpm, swing, parts) {
  const at = {}; parts.flat().forEach(e => (at[e.t] = at[e.t] || []).push(e));
  return { bpm, swing, at, len: 128 };
}
const SONGS = {
  // Title: breezy F major, the sky over the range. Fmaj9 | Em7 A7 | Dm9 | Gm7 C9sus | Bbmaj7 | Am7 D7 | Gm9 | C13sus
  title: song(100, 0.12, [
    track('lead', 'r:2 A4:2 C5:2 E5:4 G5:2 E5:4  D5:3 C5:3 E5:2 r:2 C#5:2 E5:2 A4:2  F5:6 E5:2 D5:2 C5:2 A4:4  A#4:4 D5:2 F5:2 G5:4 F5:2 E5:2 ' +
                  'F5:2 A5:4 G5:2 F5:2 D5:2 F5:4  E5:4 C5:2 A4:2 F#5:4 D5:2 C5:2  A#4:2 D5:2 F5:2 A5:6 G5:4  E5:2 F5:2 G5:4 C5:8'),
    track('bass', 'F2:6 C3:4 E2:2 F2:2 G2:2  E2:6 B2:2 A1:6 C#2:2  D2:6 A2:4 C3:2 D3:2 A2:2  G1:6 D2:2 C2:6 E2:2 ' +
                  'A#1:6 F2:4 A2:2 A#2:2 C3:2  A1:6 E2:2 D2:6 F#2:2  G1:6 D2:4 F2:2 G2:2 A2:2  C2:6 G2:4 A#2:2 C3:2 E2:2'),
    comp('ep', ['A3 C4 E4 G4', 'G3 B3 D4 E4|G3 C#4 F#4', 'F3 A3 C4 E4', 'F3 A#3 D4|A#3 D4 F4 G4',
                'A3 D4 F4 A4', 'G3 C4 E4|F#3 C4 E4', 'A#3 D4 F4 A4', 'A#3 E4 A4'], 'x.....x...x....-'),
    drums('k.c.r.c.k.ckr.c.'),
  ]),
  // Pro shop: a slow lounge in Eb, vibes over brushes. Ebmaj9 Cm9 Fm9 Bb13 | Abmaj7 Gm7 Cm9 F9 Bb13
  shop: song(84, 0.3, [
    track('vib', 'G4:4 A#4:4 D5:6 C5:2  A#4:8 r:2 G4:2 A#4:2 C5:2  D#5:4 D5:2 C5:2 G#4:8  G4:6 F4:2 G4:4 r:4 ' +
                 'G5:4 D#5:4 C5:6 A#4:2  A#4:4 D5:2 F5:2 D5:8  D#5:4 D5:2 C5:2 A#4:4 G4:4  A4:4 C5:4 D5:8'),
    track('bass', 'D#2:4 G2:4 A#2:4 D3:4  C2:4 D#2:4 G2:4 A#2:4  F2:4 G#2:4 C3:4 D#3:4  A#1:4 D2:4 F2:4 A2:4 ' +
                  'G#1:4 C2:4 D#2:4 G2:4  G1:4 A#1:4 D2:4 F2:4  C2:4 D#2:4 G2:4 A#2:4  F1:4 A1:4 A#1:4 D2:4'),
    comp('ep', ['G3 A#3 D4 F4', 'D#3 G3 A#3 D4', 'G#3 C4 D#4 G4', 'G#3 D4 G4',
                'G3 C4 D#4', 'F3 A#3 D4', 'D#3 G3 A#3 D4', 'D#3 A3 D4|G#3 D4 G4'], '..x.....-.x.....'),
    drums('k...c.c.b...r.c.'),
  ]),
  // On the line: a sparse D minor groove that leaves room to breathe. Dm9 Dm9 Bbmaj9 Am7 | Dm9 Dm9 Gm9 A7sus A7
  match: song(100, 0.08, [
    // one 3-3-2 rising motif, answered, climbed higher, and finally resolved by the A7 (sus4 D -> C#)
    track('lead', 'D5:3 E5:3 F5:2 A5:6 r:2  G5:2 F5:2 E5:2 C5:4 D5:4 r:2  D5:3 E5:3 F5:2 A5:4 C6:2 A5:2  G5:6 E5:2 C5:4 r:4 ' +
                  'D5:3 E5:3 F5:2 A5:6 r:2  C6:2 A5:2 G5:2 F5:4 E5:4 r:2  F5:3 G5:3 A5:2 A#5:4 A5:2 G5:2  E5:6 D5:2 C#5:6 r:2'),
    track('bass', 'D2:3 D2:3 A2:2 r:2 C3:2 D3:2 A2:2  D2:3 D2:3 A2:2 r:2 C3:2 D3:2 A2:2  A#1:3 A#1:3 F2:2 r:2 A2:2 A#2:2 F2:2  A1:3 A1:3 E2:2 r:2 G2:2 A2:2 E2:2 ' +
                  'D2:3 D2:3 A2:2 r:2 C3:2 D3:2 A2:2  D2:3 D2:3 A2:2 r:2 C3:2 D3:2 A2:2  G1:3 G1:3 D2:2 r:2 F2:2 G2:2 D2:2  A1:3 A1:3 E2:2 r:2 G2:2 A2:2 C#3:2'),
    comp('ep', ['F3 A3 C4 E4', 'F3 A3 C4 E4', 'A3 C4 D4 F4', 'G3 C4 E4', 'F3 A3 C4 E4', 'F3 A3 C4 E4', 'A#3 D4 F4 A4', 'G3 D4 E4|G3 C#4 E4'], 'x.....-....x...-'),
    drums('k.c.r.c.c.kcr.c.'),
  ]),
};
let musicBus = null;
// The title and the match play recorded loops (fetched up front, decoded once audio exists).
// The match loop is two layers in one stereo file, bed (drums) left and top (synth) right, so they
// stay sample-locked; at full draw the top drops out. It loops bars 1-32 of a 34-bar file at 134 BPM
// (see tools/match-loop.py).
function recLoop(url, gain, extra) {
  const r = { url, bytes: null, buf: null, src: null, failed: false, gain, ...extra };
  if (r.url && typeof fetch === 'function') fetch(r.url).then(x => x.ok ? x.arrayBuffer() : Promise.reject(x.status)).then(ab => { r.bytes = ab; decodeRec(r); }).catch(() => { r.failed = true; });
  else r.failed = true;
  return r;
}
const nextTo = (opt, file) => { try { return opt === false ? null : opt || (SCRIPT_URL ? new URL(file, SCRIPT_URL).href : null); } catch (e) { return null; } };
const MATCH_BAR = 4 * 60 / 134;
const TITLE = recLoop(nextTo(opts.titleTrack, 'title-loop.mp3'), 0.4);
const MATCH = recLoop(nextTo(opts.matchTrack, 'match-loop.mp3'), 0.35, { layers: true, loopStart: MATCH_BAR, loopEnd: MATCH_BAR * 33 });
function decodeRec(r) {
  if (!AC || !r.bytes || r.buf) return;
  const ab = r.bytes; r.bytes = null;
  AC.decodeAudioData(ab).then(b => { r.buf = b; }).catch(() => { r.failed = true; });
}
function startRec(r) {
  const src = AC.createBufferSource(), g = AC.createGain(); src.buffer = r.buf; src.loop = true; g.gain.value = r.gain;
  if (r.loopEnd) { src.loopStart = r.loopStart; src.loopEnd = r.loopEnd; }
  if (r.layers) { const sp = AC.createChannelSplitter(2), top = AC.createGain(); src.connect(sp); sp.connect(g, 0); sp.connect(top, 1); top.connect(g); r.top = top; }
  else src.connect(g);
  g.connect(musicBus); src.start(AC.currentTime + 0.05); r.src = src; r.g = g;
}
function stopRec(r) {   // fade the recorded loop out rather than cutting it
  if (!r.src) return; const now = AC.currentTime;
  try { r.g.gain.setTargetAtTime(0, now, 0.3); r.src.stop(now + 1.5); } catch (e) {}
  r.src = null; r.top = null;
}
const MUSIC = { cur: null, step: 0, next: 0, muted: (() => { try { return localStorage.getItem('linecutter_music') === 'off'; } catch (e) { return false; } })() };
const RHYTHM = { bass: 1, k: 1, c: 1, r: 1, b: 1, s: 1, h: 1 };   // what keeps playing while you're at full draw
function nz(t, out, type, freq, q, v, att, dec) {
  const s = AC.createBufferSource(), f = AC.createBiquadFilter(), g = AC.createGain();
  s.buffer = noiseBuf; f.type = type; f.frequency.value = freq; f.Q.value = q;
  g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(v, t + att); g.gain.exponentialRampToValueAtTime(0.0001, t + att + dec);
  s.connect(f); f.connect(g); g.connect(out); s.start(t, rand() * 0.5); s.stop(t + att + dec + 0.02);
}
function osc(type, f, t) { const o = AC.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, t); return o; }
// amp envelope: attack, decay to a sustain level, hold until `end`, release
function env(g, t, v, att, dec, sus, end, rel) {
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(v, t + att);
  const sv = Math.max(0.0001, v * sus), st = Math.max(t + att + 0.01, Math.min(end, t + att + dec));
  g.gain.exponentialRampToValueAtTime(sv, st);
  if (end > st) g.gain.setValueAtTime(sv, end);   // pin the hold level so the release starts from it
  g.gain.setTargetAtTime(0.0001, Math.max(end, st), rel);
}
function playNote(e, t, spb) {
  const out = musicBus, end = t + e.len * spb * 0.95;
  switch (e.inst) {
    case 'k': { const o = osc('sine', 110, t), g = AC.createGain(); o.frequency.exponentialRampToValueAtTime(42, t + 0.12); g.gain.setValueAtTime(0.3, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.18); o.connect(g); g.connect(out); o.start(t); o.stop(t + 0.2); return; }
    case 'c': nz(t, out, 'bandpass', 7500, 1.2, 0.035, 0.002, 0.07); return;              // soft ride tick
    case 'r': nz(t, out, 'bandpass', 2400, 6, 0.16, 0.001, 0.035); { const o = osc('sine', 1650, t), g = AC.createGain(); g.gain.setValueAtTime(0.05, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.03); o.connect(g); g.connect(out); o.start(t); o.stop(t + 0.04); } return;
    case 'b': nz(t, out, 'bandpass', 2800, 0.8, 0.05, 0.05, 0.22); return;                // brush swish
    case 's': nz(t, out, 'bandpass', 1800, 1, 0.09, 0.001, 0.09); return;
    case 'h': nz(t, out, 'highpass', 7000, 0.7, 0.05, 0.001, 0.03); return;
  }
  const f = hz(e.m), g = AC.createGain(); g.connect(out);
  if (e.inst === 'ep') {                     // FM Rhodes: a bell-bright attack that mellows out
    const car = osc('sine', f, t), mod = osc('sine', f, t), mi = AC.createGain(), tine = osc('sine', f * 14, t), ti = AC.createGain();
    mi.gain.setValueAtTime(f * 2.2, t); mi.gain.exponentialRampToValueAtTime(f * 0.35, t + 0.6);
    ti.gain.setValueAtTime(f * 0.9, t); ti.gain.exponentialRampToValueAtTime(1, t + 0.04);
    mod.connect(mi); mi.connect(car.frequency); tine.connect(ti); ti.connect(car.frequency); car.connect(g);
    env(g, t, 0.045, 0.004, 0.9, 0.4, end, 0.12);
    [car, mod, tine].forEach(o => { o.start(t); o.stop(end + 0.6); }); return;
  }
  if (e.inst === 'bass') {                   // fretless: round, with a little growl on the attack
    const o1 = osc('triangle', f, t), o2 = osc('sine', f, t), lp = AC.createBiquadFilter(), mix = AC.createGain();
    o1.frequency.setValueAtTime(f * 0.985, t); o1.frequency.exponentialRampToValueAtTime(f, t + 0.05);   // slides into the note
    lp.type = 'lowpass'; lp.Q.value = 3; lp.frequency.setValueAtTime(1100, t); lp.frequency.exponentialRampToValueAtTime(320, t + 0.18);
    mix.gain.value = 1; o1.connect(lp); o2.connect(mix); lp.connect(mix); mix.connect(g);
    env(g, t, 0.085, 0.012, 0.3, 0.6, end, 0.05);
    [o1, o2].forEach(o => { o.start(t); o.stop(end + 0.4); }); return;
  }
  if (e.inst === 'vib') {                    // vibraphone: pure tone + overtone, slow tremolo
    const o1 = osc('sine', f, t), o2 = osc('sine', f * 4, t), og = AC.createGain(), trem = osc('sine', 4.8, t), tg = AC.createGain(), am = AC.createGain();
    og.gain.setValueAtTime(0.35, t); og.gain.exponentialRampToValueAtTime(0.01, t + 0.25);
    tg.gain.value = 0.25; am.gain.value = 0.75; trem.connect(tg); tg.connect(am.gain);
    o1.connect(am); o2.connect(og); og.connect(am); am.connect(g);
    env(g, t, 0.13, 0.003, 1.4, 0.25, end, 0.25);
    [o1, o2, trem].forEach(o => { o.start(t); o.stop(end + 1.2); }); return;
  }
  // 'lead': soft synth brass, two detuned saws through a swelling filter, late vibrato
  const o1 = osc('sawtooth', f, t), o2 = osc('sawtooth', f, t), lp = AC.createBiquadFilter(), lfo = osc('sine', 5.2, t), lg = AC.createGain();
  o1.detune.value = -6; o2.detune.value = 6;
  lg.gain.setValueAtTime(0, t); lg.gain.linearRampToValueAtTime(0, t + 0.2); lg.gain.linearRampToValueAtTime(f * 0.006, t + 0.45);
  lfo.connect(lg); lg.connect(o1.frequency); lg.connect(o2.frequency);
  lp.type = 'lowpass'; lp.Q.value = 1; lp.frequency.setValueAtTime(500, t); lp.frequency.exponentialRampToValueAtTime(2300, t + 0.07); lp.frequency.exponentialRampToValueAtTime(1300, t + 0.4);
  o1.connect(lp); o2.connect(lp); lp.connect(g);
  env(g, t, 0.065, 0.035, 0.4, 0.7, end, 0.07);
  [o1, o2, lfo].forEach(o => { o.start(t); o.stop(end + 0.5); });
}
// Called every frame: picks the song for the current screen, schedules ~0.15s ahead, thins out during a shot.
function musicTick() {
  if (!AC || SILENT || opts.music === false) return;
  if (!musicBus) { musicBus = AC.createGain(); musicBus.gain.value = 0; musicBus.connect(master); }
  const want = S === 'bracket' ? MUSIC.cur || 'title' : S === 'title' || S === 'win' || S === 'pset' || S === 'mgear' || S === 'mshop' ? 'title' : S === 'shop' || S === 'roundEnd' ? 'shop' : S === 'over' ? null : 'match';
  if (want !== MUSIC.cur) { MUSIC.cur = want; MUSIC.step = 0; MUSIC.next = AC.currentTime + 0.08; stopRec(TITLE); stopRec(MATCH); }
  const focus = (S === 'draw' || S === 'hold' || S === 'mv' || S === 'mh' || S === 'flight') && !DLG;   // on the bars, the top drops out
  const dip = FADE && FADE.k === 'out' && FADE.dip;
  const vol = MUSIC.muted || !MUSIC.cur || dip ? 0 : PAUSE ? 0.15 : focus ? 0.4 : 0.55;   // at full draw it thins to bass and brushes (see RHYTHM); paused, it plays low
  musicBus.gain.setTargetAtTime(vol, AC.currentTime, dip ? 0.15 : focus ? 0.15 : 0.4);
  if (!MUSIC.cur) return;
  const rec = MUSIC.cur === 'title' ? TITLE : MUSIC.cur === 'match' ? MATCH : null;
  if (rec && !rec.failed) {           // recorded loop; silent until it's decoded, the synth song if it can't load
    decodeRec(rec);
    if (rec.buf && !rec.src) startRec(rec);
    if (rec.top) rec.top.gain.setTargetAtTime(focus ? 0 : 1, AC.currentTime, focus ? 0.15 : 0.4);
    return;
  }
  const sg = SONGS[MUSIC.cur], spb = 60 / sg.bpm / 4;
  if (MUSIC.next < AC.currentTime) MUSIC.next = AC.currentTime + 0.02;     // tab was asleep: don't burst
  while (MUSIC.next < AC.currentTime + 0.15) {
    const st = MUSIC.step % sg.len, sw = sg.swing && st % 4 === 2 ? spb * sg.swing : 0;
    (sg.at[st] || []).forEach(e => { if (!focus || RHYTHM[e.inst]) playNote(e, MUSIC.next + sw, spb); });
    MUSIC.next += spb; MUSIC.step++;
  }
}
const SFX = {
  sel: () => tone(660, 0.04, 'square', 0.03),
  move: () => tone(440, 0.03, 'square', 0.02),
  draw: () => tone(160, 0.9, 'sawtooth', 0.012, 380),
  anchor: () => { tone(880, 0.05, 'square', 0.04); tone(1320, 0.09, 'square', 0.03, null, 0.05); },
  bad: () => tone(220, 0.16, 'square', 0.04, 110),
  release: () => { noise(0.18, 0.09, 2500, 'bandpass'); tone(300, 0.05, 'triangle', 0.05, 120); },
  thunk: (d = 0) => { tone(95, 0.14, 'sine', 0.3, 45, d); noise(0.06, 0.14, 700, 'lowpass', d); },   // d: sound takes ~0.15s to come back from 50m
  beat: bpm => { const v = clamp(0.12 + (bpm - 70) * 0.004, 0.1, 0.35); tone(58, 0.1, 'sine', v, 40); tone(52, 0.09, 'sine', v * 0.7, 38, 0.14); },
  x: () => [0, 4, 7, 12].forEach((s, i) => tone(660 * Math.pow(2, s / 12), 0.09, 'square', 0.035, null, i * 0.05)),
  cheer: () => { noise(0.9, 0.05, 1400, 'bandpass'); noise(0.6, 0.03, 2600, 'bandpass', 0.1); },
  tick: i => tone(440 * Math.pow(1.06, i), 0.06, 'square', 0.035),
  mult: i => tone(330 * Math.pow(1.1, i), 0.11, 'triangle', 0.09),
  xmult: () => { tone(220, 0.25, 'square', 0.05, 660); tone(330, 0.25, 'square', 0.03, 990, 0.04); },
  slam: () => { tone(110, 0.35, 'square', 0.07, 55); noise(0.25, 0.12, 500); },
  count: () => tone(990, 0.025, 'square', 0.015),
  fanfare: () => [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(f, i === 5 ? 0.4 : 0.11, 'square', 0.04, null, i * 0.11)),
  fail: () => [392, 330, 262, 196].forEach((f, i) => tone(f, 0.22, 'triangle', 0.08, null, i * 0.18)),
  gust: () => noise(1.1, 0.06, 450, 'bandpass'),
  blip: () => tone(300 + rand() * 350, 0.045, 'square', 0.018),
  letdown: () => tone(300, 0.3, 'triangle', 0.05, 150),
  click: () => { tone(2600, 0.015, 'square', 0.05); noise(0.02, 0.08, 4000, 'highpass'); },
  charge: () => tone(900, 0.45, 'sine', 0.02, 3200),                     // the flash whining up
  snap: () => { noise(0.08, 0.16, 3000, 'highpass'); tone(1800, 0.05, 'square', 0.03, 600); },
  tap: () => tone(70, 0.04, 'triangle', 0.08, 50),                        // Brenda's foot
  bet: () => [392, 523].forEach((f, i) => tone(f, 0.08, 'square', 0.04, null, i * 0.07)),
  betWon: () => [523, 784, 1047, 1319].forEach((f, i) => tone(f, 0.08, 'square', 0.04, null, i * 0.06)),
  betLost: () => [330, 311, 294, 262].forEach((f, i) => tone(f, 0.14, 'triangle', 0.07, null, i * 0.12)),
};

// ---------- input ----------
const Q = [];
function press(b) {
  ensureAudio();   // any press wakes the sound; the title menu plays its song while you choose
  Q.push(b);
}

// ---------- game state ----------
let S = 'title', sT = 0, G = null, time = 0, shake = 0, flashT = 0, BG = TITLE_BG;
const pops = [], parts = [];
const store = (() => { try { return window.localStorage; } catch (e) { return null; } })();
let best = +((store && store.getItem('linecutter_best')) || 0);
const setState = s => { S = s; sT = 0; if (!G) return; if (s === 'over') clearRun(); else if (REST.has(s)) saveRun(); };

// ---------- save ----------
// The run saves itself at every resting point (aiming, the shop, the draw sheet, round results),
// so quitting or closing the page never loses progress. Losing a match ends the run and deletes it.
const RUN_KEY = 'linecutter_run', REST = new Set(['aim', 'shop', 'bracket', 'roundEnd', 'win']);
let SILENT = false;
function saveRun() {
  if (!store || G.free) return;   // free practice never touches the tournament save
  const drop = new Set(['R', 'fl', 'tally', 'review']);
  try { store.setItem(RUN_KEY, JSON.stringify({ v: 1, S, r: ROUNDS.indexOf(G.R), G }, function (k, v) { return this === G && drop.has(k) ? undefined : v; })); } catch (e) {}
}
function loadRun() {
  try { const s = store && JSON.parse(store.getItem(RUN_KEY)); return s && s.v === 1 && REST.has(s.S) && ROUNDS[s.G.round] ? s : null; } catch (e) { return null; }
}
function clearRun() { try { store && store.removeItem(RUN_KEY); } catch (e) {} }
function continueRun() {
  const s = loadRun(); if (!s) { newGame(); return; }
  DLG = null; G = s.G; G.panicNow = false; G.build = G.build || {}; refreshStrip();
  if (s.r >= 0) { G.R = ROUNDS[s.r]; BG = makeBg(G.R.bg, true, G.R.dist); }
  setState(s.S);
  if (S === 'aim') pop(G.practice ? 'PRACTICE END' : endLabel(), 120, 22, G.practice ? C.green : C.text, 1, 1.6, 0);
}
// Quitting mid-shot finishes that shot (silently, off-screen) before saving, so quitting can't undo an arrow.
function settle() {
  SILENT = true; FADE = null;
  if (S === 'draw' || S === 'hold' || S === 'mv' || S === 'mh') { G.panicNow = false; setState('aim'); }
  for (let n = 0; n < 4000 && S !== 'over' && (DLG || FADE || !REST.has(S)); n++) {
    if (DLG || ['intro', 'soIntro', 'review', 'tally', 'opp'].includes(S)) Q.push('a');
    else if (S === 'bet') Q.push('b');   // walking away is passing on the bet
    update(0.05);
  }
  SILENT = false;
}
// The title says PRESS ANY BUTTON (that press also wakes the sound), then shows the menu:
// CONTINUE (only when a run is saved), NEW GAME (asks twice over a save), FREE PRACTICE, MUSIC.
let TMENU = null;
function openTitle(open = false, sel = 0) { const s = loadRun(); TMENU = { open, save: s, items: (s ? ['continue'] : []).concat('new', 'practice', 'rivals', 'music'), sel, sure: false }; }
function titleUpdate(pr, P) {
  const M = TMENU;
  if (!M.open) { if (P.size) { M.open = true; SFX.sel(); } return; }
  const n = M.items.length;
  if (pr('up') || pr('down')) { M.sel = (M.sel + (pr('up') ? n - 1 : 1)) % n; M.sure = false; SFX.move(); }
  if (pr('b')) M.sure = false;
  if (!pr('a')) return;
  const it = M.items[M.sel];
  if (it === 'continue') { SFX.sel(); fadeTo(continueRun, false, 0.5); }
  else if (it === 'music') { toggleMusic(); SFX.sel(); }
  else if (it === 'practice') { SFX.sel(); M.sure = false; openPractice(); }
  else if (it === 'rivals') { SFX.sel(); M.sure = false; setState('rivals'); }
  else if (M.save && !M.sure) { M.sure = true; SFX.bad(); }
  else { SFX.sel(); clearRun(); fadeTo(newGame, false, 0.5); }
}
const has = id => !!G && G.rituals.includes(id);
function pop(t, x, y, col = C.text, sc = 1, life = 0.9, vy = -14) {
  const w = sc === 1 ? hw(t) : tw(t, sc);
  x = clamp(x - w / 2, 2, W - w - 2); y = clamp(y, 15, 124);
  pops.push({ t, x, y, col, sc, age: 0, life, vy });
}
function feedback(t, col) { for (let i = pops.length - 1; i >= 0; i--) if (pops[i].fb) pops.splice(i, 1); pop(t, 120, 26, col, 1, 1.1, 0); pops[pops.length - 1].fb = true; }
function burst(x, y, col, n = 8, sp = 30) { for (let i = 0; i < n; i++) { const a = rand() * 6.283, v = sp * (0.4 + rand()); parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 10, life: 0.4 + rand() * 0.4, age: 0, col }); } }

function newGame() {
  DLG = null;
  G = { season: 1, round: 0, rituals: [], build: {}, crawl: null, thisAvg: 0, lastAvg: 0, total: 0, xCount: 0, bestEnd: 0,
    bpm: 68, beatPh: 0, lastBeat: 0, beatFlash: 0, kickDir: 1, wind: 0, windTarget: 0, chat: { talking: false, timer: 3, line: '', blipT: 0 } };
  G.draw = drawSheet(!SEEN.tutorial);
  toBracket();                         // first upgrade comes after you beat Brenda
}
// ---------- free practice ----------
// No bracket, no bale mate, no crowd: pick a range and how wide your arrows group, then shoot ends forever.
// The range brings its own wind (and the ridge its gusts); today's true crawl and tune you still find yourself.
const PRAC_RANGES = [
  { r: 0, label: '18M  COUNTY HALL', sub: 'INDOORS. NO WIND.' },
  { r: 1, label: '30M  FAIRGROUNDS', sub: 'STEADY WIND.' },
  { r: 3, label: '50M  RIDGE FIELD', sub: 'GUSTS SHIFT MID-HOLD.' },
];
// spread: form error multiplier (like gear does); float: how much the point wanders in the hold.
const PRAC_SPREADS = [
  { label: 'LOW', spread: 0.4, float: 0.7, sub: 'TUNED KIT. GROOVED FORM.' },
  { label: 'MEDIUM', spread: 0.7, float: 0.85, sub: 'A FEW UPGRADES IN.' },
  { label: 'HIGH', spread: 1, float: 1, sub: 'DAY ONE. NO GEAR.' },
];
// ---------- METERS (prototype, free practice only) ----------
// Megaton Punch for archery. Two gauges off to the side of the target, no dice: the bar on the left sweeps
// up and down, A locks your height; then the bar along the bottom sweeps across, A lets it go.
// The gauges aren't a picture of the face. Each one is a strip of rings, centre outward:
//   X 10 1 2 9 3 4 6 8 7 5  (mirrored: 5 7 8 6 4 3 9 2 1 10 X 10 1 2 9 3 4 6 8 7 5)
// The 10 sits right against the 1, and the 9 is walled in by 2 and 3: chase the gold and you can blank.
// The 8 and 7 out near the ends are the safe play; the end of the bar, where it turns, is a dependable 5.
// Every zone lands you in that ring on its axis; the loose can't score better than your height (Shot Routine adds rings).
// Wind slides the bottom gauge: the gold moves upwind and you chase it.
// The strip is your build. You start with the bare strip; every slot of kit (riser, limbs, arrows...) rewrites it.
// Each slot has types. The first time you're offered a slot you pick a type (the fork: what kind of archer
// you are); after that the slot only ever offers that type's upgrade, II then III. The shop deals three offers.
//   period  seconds for one pass end to end (before range)
//   slow    bar speed inside X/10/9 (1 = no drag)
//   w       zone widths, centre outward, a fraction of half the gauge (renormalised to add to 1 after gear)
const METER_BASE = { period: 0.75, slow: 1,
  k: ['X', 10, 1, 2, 9, 3, 4, 6, 8, 7, 5],
  w: [0.006, 0.012, 0.06, 0.06, 0.08, 0.06, 0.06, 0.13, 0.16, 0.15, 0.222] };   // day one: a tiny 10/X, a real 9, walled by wider white and black.
// Gold grows outward like the rings on a face: X and 10 are pinpricks, the 9 is the gold you can actually aim at.
// Day one the white (1+2) and the black (3+4) are each half again as wide as the 9, so you can see that going for gold
// is a gamble; gear grows the gold into them (Fat Aluminums, Foam Core) or cuts them (Stiff Spring).
// The red band (8+7) is the widest colour run: the steady play until your kit makes gold worth chasing.
const sSwap = (st, a, b) => { const i = st.k.indexOf(a), j = st.k.indexOf(b); if (i < 0 || j < 0) return; [st.k[i], st.k[j]] = [st.k[j], st.k[i]]; [st.w[i], st.w[j]] = [st.w[j], st.w[i]]; };
// remove zones; each removed zone's width goes to its better-scoring neighbour (or to `to`, if given), so cutting a
// zone never quietly fattens the whole strip
const ringVal = k => k === 'XX' || k === 'X' ? 10.5 : k === 'M' ? 0 : k;
function sKeep(st, f, to) {
  for (let i = 0; i < st.k.length; i++) {
    if (f(st.k[i])) continue;
    const w = st.w[i]; st.k.splice(i, 1); st.w.splice(i, 1); i--;
    let j = to != null ? st.k.indexOf(to) : -1;
    if (j < 0) { const a = i, b = i + 1; j = a < 0 ? b : b >= st.k.length ? a : ringVal(st.k[a]) >= ringVal(st.k[b]) ? a : b; }
    if (j >= 0 && j < st.w.length) st.w[j] += w;
  }
}
// drop: remove zones outright; buildStrip's renormalise spreads their width over everything that's left
const sDrop = (st, f) => { for (let i = st.k.length - 1; i >= 0; i--) if (f(st.k[i])) { st.k.splice(i, 1); st.w.splice(i, 1); } };
// recolour: a zone now lands you in another ring (and wears its colour). Duplicates are fine.
const sRecolor = (st, from, to) => { const i = st.k.indexOf(from); if (i >= 0) st.k[i] = to; };
// grow: add real width (the day-one slivers are too thin for a multiplier to matter)
const sGrow = (st, k, add) => { const i = st.k.indexOf(k); if (i >= 0) st.w[i] += add; };
// split: every zone k becomes two halves, the inner (centre-side) half wearing `to`
const sSplitAll = (st, k, to) => { for (let i = st.k.length - 1; i >= 0; i--) if (st.k[i] === k) { const w = st.w[i] / 2; st.k.splice(i, 1, to, k); st.w.splice(i, 1, w, w); } };
const sWiden = (st, k, x) => { const i = st.k.indexOf(k); if (i >= 0) st.w[i] *= x; };
const tier = (n, a) => a[n - 1];   // a = [I, II, III]
// Every piece does one thing, and leans toward one of three paths: GOLD (grow the gold and hit it), RED (make the
// red pay like gold) or LOWER (make the big outer band count). Most pieces are one and done; a few train up (II, III).
// `rar` is how often the shop deals it. Gear changes what's on the bar: which rings, how wide.
// (slot order is build order: the tab grows the 10 before the arrows can turn it into X)
const SLOTS = [
  { id: 'riser', name: 'RISER', types: [
    { id: 'redriser', name: 'WOOD RISER', rar: 'uncommon', desc: 'THE 9 AND THE 6 TURN RED.', mod: st => { sRecolor(st, 9, 8); sRecolor(st, 6, 7); } },
    { id: 'blueriser', name: 'CAST RISER', rar: 'rare', desc: 'THE BLACK (4 AND 3) TURNS BLUE.', mod: st => { sRecolor(st, 4, 6); sRecolor(st, 3, 5); } } ] },
  { id: 'limbs', name: 'LIMBS', types: [
    { id: 'foam', name: 'FOAM CORE LIMBS', rar: 'uncommon', desc: 'CUTS THE BLACK (4 AND 3) OUT.', mod: st => sKeep(st, k => k !== 4 && k !== 3) },
    { id: 'carbonl', name: 'CARBON LIMBS', rar: 'rare', desc: 'THE INNER HALF OF YOUR 8 TURNS GOLD.', mod: st => sSplitAll(st, 8, 9) },
    { id: 'woodcore', name: 'WOOD CORE LIMBS', rar: 'uncommon', desc: 'THE BLUE (6 AND 5) TURNS BLACK.', mod: st => { sRecolor(st, 6, 4); sRecolor(st, 5, 3); } } ] },   // the junk build: a wide black to land in   // half, not all: the 8 is the widest band and gold should stay hard
  { id: 'tab', name: 'TAB', types: [
    { id: 'calf', name: 'CALF HAIR TAB', rar: 'rare', desc: 'A WIDER 10.', mod: st => sGrow(st, 10, 0.02) },
    { id: 'cordovan', name: 'CORDOVAN TAB', rar: 'uncommon', desc: 'THE RED (8 AND 7) GROWS.', mod: st => { sWidenAll(st, 8, 1.3); sWidenAll(st, 7, 1.3); } } ] },   // gold is a cliff: at sharp timing +0.08 alone was ~30 an end (tools/ramp.js build)
  { id: 'arrows', name: 'ARROWS', types: [
    { id: 'fat', name: 'FAT ALUMINUMS', rar: 'uncommon', desc: 'THE 9 SWALLOWS THE WHITE BESIDE IT.', mod: st => sRecolor(st, 2, 9) } ] },   // fat shafts catch the line
  { id: 'fletch', name: 'FLETCHING', types: [
    { id: 'spiral', name: 'SPIRAL VANES', rar: 'uncommon', desc: 'THE 9 AND THE 6 GROW.', mod: st => { sGrow(st, 9, 0.04); sWidenAll(st, 6, 1.25); } },
    { id: 'feathers', name: 'FEATHER FLETCH', rar: 'uncommon', desc: 'THE 7 TURNS BLUE.', mod: st => sRecolor(st, 7, 6) } ] },   // the blue build: a band of blue to stack
  { id: 'plunger', name: 'PLUNGER', types: [
    { id: 'stiff', name: 'STIFF SPRING', rar: 'uncommon', desc: 'CUTS THE WHITE (2 AND 1) OUT.', mod: st => sDrop(st, k => k === 2 || k === 1) },
    { id: 'soft', name: 'SOFT SPRING', rar: 'uncommon', desc: 'THE WHITE (2 AND 1) GROWS.', mod: st => { sWidenAll(st, 2, 1.6); sWidenAll(st, 1, 1.6); } } ] },   // the white's room is shared out across the bar, not handed to the gold beside it
];
// Form is how you shoot, never what's on the bar. Your loose can't beat your height until Shot Routine lets it, a ring a level.
const FORM_SLOTS = [
  { id: 'routine', name: 'ROUTINE', form: true, types: [
    { id: 'shotroutine', name: 'SHOT ROUTINE', rar: 'common', max: 3,
      desc: n => 'YOUR LOOSE CAN SCORE ' + n + (n > 1 ? ' RINGS' : ' RING') + ' OVER YOUR HEIGHT.',
      fx: (D, n) => { D.lift = Math.max(D.lift, n); } } ] },
  { id: 'heart', name: 'HEART', form: true, types: [
    { id: 'still', name: 'TUNNEL VISION', rar: 'uncommon', desc: 'PANIC AND CROWDS SHAKE YOU LESS.', fx: D => { D.defOps.steadyhand = true; } } ] },
];
// Rituals bend the scoring by colour: a bonus on every arrow in that colour (a ring gear turned red counts as red).
// Bonuses add up, but no arrow pays over 10. Buy once.
const sWidenAll = (st, k, x) => st.k.forEach((z, i) => { if (z === k) st.w[i] *= x; });
const ringColor = v => v >= 9 ? 'gold' : v >= 7 ? 'red' : v >= 5 ? 'blue' : v >= 3 ? 'black' : 'white';
const colorUp = (D, cols, n) => cols.forEach(c => { D.colorPlus[c] = (D.colorPlus[c] || 0) + n; });
const floorUp = (D, f) => { const v = Math.max(f, D.defOps.floor ? D.defOps.floor.floor : 0); D.defOps.floor = { threshold: v, floor: v }; };
const M_RITUALS = [
  { id: 'crimson', icon: 'heart', name: 'PLAY THE RED', rar: 'common', desc: '+1 FOR EVERY RED.', fx: D => colorUp(D, ['red'], 1) },
  { id: 'scarlet', icon: 'heart', name: 'RED IS GOLD', rar: 'uncommon', needs: 'crimson', desc: '+2 MORE FOR EVERY RED.', fx: D => colorUp(D, ['red'], 2) },
  { id: 'lowtide', icon: 'ice', name: 'PLAY THE BLUE', rar: 'common', desc: '+1 FOR EVERY BLUE.', fx: D => colorUp(D, ['blue'], 1) },
  { id: 'deep', icon: 'ice', name: 'STACK THE BLUE', rar: 'uncommon', needs: 'lowtide', desc: 'EACH BLUE: +1 PER OTHER BLUE THAT END.', fx: D => { D.convOps.deep = 1; } },   // the flush: blues pay for company
  { id: 'deepblue', icon: 'ice', name: 'DEEP BLUE', rar: 'uncommon', needs: 'lowtide', desc: '+2 MORE FOR EVERY BLUE.', fx: D => colorUp(D, ['blue'], 2) },
  { id: 'halo', icon: 'xring', name: 'AIM SMALL', rar: 'uncommon', desc: '+1 FOR EVERY GOLD.', fx: D => colorUp(D, ['gold'], 1) },
  { id: 'seep', icon: 'mug', name: 'EVERY ARROW COUNTS', rar: 'common', desc: '+3 FOR EVERY BLACK OR WHITE.', fx: D => colorUp(D, ['black', 'white'], 3) },
  // David's: a good miss turns into a bonus. One an end: two made it a free retry every build wants (tools/paths.js).
  { id: 'pile', icon: 'mug', name: 'KEEP SHOOTING', rar: 'uncommon', desc: '1 BLACK OR WHITE AN END IS A FREE ARROW.', fx: D => { D.convOps.junkFree = 1; } },
  { id: 'scrap', icon: 'mug', name: 'NOTHING WASTED', rar: 'uncommon', needs: 'seep', desc: '+3 MORE FOR EVERY BLACK OR WHITE.', fx: D => colorUp(D, ['black', 'white'], 3) },
  { id: 'echo', icon: 'chat', name: 'NEXT ARROW', rar: 'uncommon', desc: 'BLACK OR WHITE COPIES THE NEXT ARROW.', fx: D => { D.convOps.echo = true; } },   // don't let a bad one tilt you; no help on the last arrow
  { id: 'extra', icon: 'fat', name: 'SPARE ARROW', rar: 'uncommon', desc: 'SHOOT 4 AN END. YOUR WORST ONE DROPS.', fx: D => { D.convOps.extraArrows = 1; } },
];
// What your kit does beyond the bar: what each ring pays, how your two bars combine, and the odd rule.
function runFx(build, rituals) {
  const D = { colorPlus: {}, lift: 0, defOps: {}, convOps: {} };
  ALL_SLOTS.forEach(sl => { const b = build[sl.id], ty = b && slotType(sl, b.t); if (ty && ty.fx) ty.fx(D, b.n); });
  M_RITUALS.forEach(r => { if (r.fx && rituals.includes(r.id)) r.fx(D); });
  return D;
}
function applyFx(build, rituals) { const D = runFx(build, rituals); G.colorPlus = D.colorPlus; G.lift = D.lift; G.defOps = D.defOps; G.convOps = D.convOps; }
const ritIcon = id => (M_RITUALS.find(r => r.id === id) || RITUALS[id] || {}).icon || 'dice';
const tyDesc = (ty, n) => typeof ty.desc === 'function' ? ty.desc(n || 1) : ty.desc;
const ALL_SLOTS = SLOTS.concat(FORM_SLOTS);
const slotType = (sl, t) => sl.types.find(x => x.id === t);
const ROMAN = ['', '', ' II', ' III'];
// build: { riser: { t: 'weighted', n: 2 }, ... }; an empty slot is missing
// Your strip for this round: gear + form + rituals. Rebuilt whenever the kit changes.
function refreshStrip() { if (!G) return; G.strip = buildStrip(G.build || {}, G.rituals || []); applyFx(G.build || {}, G.rituals || []); G.stripCur = G.strip; G.grow = {}; G.mWind = G.mWind || 0; }
function buildStrip(build, rituals = []) {
  const st = { period: METER_BASE.period, slow: METER_BASE.slow, k: METER_BASE.k.slice(), w: METER_BASE.w.slice(),
    pv: 1, ph: 1, slowV: 1, slowH: 1, surge: 1, tire: 1, steady: 0, wind: 1, windLag: 0, fat: 0,
    letdownBpm: 1, bpmDrop: 0, kick: 1 };
  ALL_SLOTS.forEach(sl => { const b = build[sl.id], ty = b && slotType(sl, b.t); if (ty && ty.mod) ty.mod(st, b.n); });
  M_RITUALS.forEach(r => { if (r.strip && rituals.includes(r.id)) r.strip(st); });
  const t = st.w.reduce((a, b) => a + b, 0); st.w = st.w.map(x => x / t);
  return st;
}
const cleanRituals = r => Array.isArray(r) ? r.filter(id => M_RITUALS.some(x => x.id === id)) : [];
const cleanBuild = b => { const o = {}; if (b && typeof b === 'object') ALL_SLOTS.forEach(sl => { const v = b[sl.id]; if (v && slotType(sl, v.t)) o[sl.id] = { t: v.t, n: clamp(v.n | 0, 1, slotType(sl, v.t).max || 1) }; }); return o; };
// The shop's rule: an empty slot offers its types (a fork); a filled one offers its next level if it has one;
// rituals you don't have yet are offers too. Four offers a visit, rarer pieces dealt less often.
function allOffers(build, rituals) {
  const c = [];
  ALL_SLOTS.forEach(sl => { const b = build[sl.id];
    if (!b) sl.types.forEach(ty => c.push({ slot: sl.id, t: ty.id, n: 1 }));
    else { const ty = slotType(sl, b.t); if (ty && b.n < (ty.max || 1)) c.push({ slot: sl.id, t: b.t, n: b.n + 1 }); } });
  M_RITUALS.forEach(r => { if (!rituals.includes(r.id) && (!r.needs || rituals.includes(r.needs))) c.push({ rit: r.id }); });   // `needs`: only once you own it
  return c;
}
const RAR_W = { rare: 1, uncommon: 2, common: 4 };
const offerW = f => RAR_W[(offerRit(f) || slotType(offerSlot(f), f.t)).rar] || 2;
// Gear is what scales a run, so every visit deals at least one piece of it (while there's any left to offer).
const isGear = f => !!f.slot && SLOTS.some(sl => sl.id === f.slot);
function shopDeal(build, rituals) {
  const pool = shuffle(allOffers(build, rituals)), deal = [];
  while (deal.length < 4 && pool.length) {
    let r = rand() * pool.reduce((t, f) => t + offerW(f), 0), i = 0;
    while (i < pool.length - 1 && (r -= offerW(pool[i])) > 0) i++;
    deal.push(pool.splice(i, 1)[0]);
  }
  if (!deal.some(isGear)) { const pick = pool.find(isGear); if (pick) deal[randInt(0, deal.length - 1)] = pick; }
  return deal;
}
const SLOT_ICON = { riser: 'weights', limbs: 'limbs', arrows: 'fat', fletch: 'tuned', tab: 'tab', plunger: 'plunger',
  tempo: 'clock', expand: 'back', routine: 'anchor', back: 'back', heart: 'lungs' };
const offerRit = f => f.rit && M_RITUALS.find(r => r.id === f.rit);
const offerSlot = f => f.slot && ALL_SLOTS.find(x => x.id === f.slot);
function offerName(f) { const r = offerRit(f); if (r) return r.name; const sl = offerSlot(f); return slotType(sl, f.t).name + ROMAN[f.n]; }
function offerDesc(f) { const r = offerRit(f); if (r) return r; const ty = slotType(offerSlot(f), f.t); return { desc: tyDesc(ty, f.n), cost: ty.cost }; }
const offerIcon = f => f.rit ? ritIcon(f.rit) : SLOT_ICON[f.slot] || 'tab';
function takeOffer(f) { if (f.rit) { if (!G.rituals.includes(f.rit)) G.rituals.push(f.rit); } else G.build[f.slot] = { t: f.t, n: f.n }; refreshStrip(); }
// What you'd lose on a bet: a ritual goes, a slot drops a tier (tier I comes off entirely).
function loseItem(f) {
  if (f.rit) G.rituals = G.rituals.filter(k => k !== f.rit);
  else { const b = G.build[f.slot]; if (b && b.n > 1) b.n--; else delete G.build[f.slot]; }
  refreshStrip();
}
const ownedItems = () => Object.keys(G.build || {}).map(slot => ({ slot, t: G.build[slot].t, n: G.build[slot].n })).concat(G.rituals.filter(k => M_RITUALS.some(r => r.id === k)).map(rit => ({ rit })));
// where each ring lands you on the face, px from centre, kept clear of the lines so the colour you stop on
// is the score you get (the shaft is 0.6px; a line cutter scores up)
// XX is the dead centre (an X inside the X: still a 10, counts as two Xs). M lands off the face.
const ZONE_PX = k => k === 'XX' ? [0, 0.5] : k === 'X' ? [1.3, 2.9] : k === 'M' ? [49.5, 52] : [(10 - k) * T.ringR + 0.7, (11 - k) * T.ringR + 0.5];
const GOLDS = new Set(['XX', 'X', 10, 9]);
// The gauge only shows the colour; which ring of that colour you get stays hidden (it still scores exactly).
// Gauge colours: a deeper, warmer gold and a cooler white than the face, so the two never blur together at speed.
const GAUGE_GOLD = '#f2a516', GAUGE_WHITE = '#e9edf2';
const ZONE_COL = { XX: GAUGE_GOLD, M: '#16121f', X: GAUGE_GOLD, 10: GAUGE_GOLD, 9: GAUGE_GOLD, 8: C.red, 7: C.red, 6: C.blue, 5: C.blue,
  4: C.black, 3: C.black, 2: GAUGE_WHITE, 1: GAUGE_WHITE };
// Draw a gauge strip along one axis, with a 1px seam wherever the colour changes.
// (the seam is the frame's purple, not dark: dark would read as a sliver of black, which is a scoring colour)
const mixHex = (a, b, t) => t <= 0 ? a : t >= 1 ? b : '#' + [1, 3, 5].map(i => Math.round(parseInt(a.substr(i, 2), 16) * (1 - t) + parseInt(b.substr(i, 2), 16) * t).toString(16).padStart(2, '0')).join('');
const GAUGE_SEAM = null;   // no seam (set a colour like '#8c7cb4' to bring one back)
function gaugeRun(n, at, col) { let prev = null; for (let i = 0; i < n; i++) { const c = col(i); at(i, GAUGE_SEAM && prev !== null && c !== prev ? GAUGE_SEAM : c); prev = c; } }
const METER_RANGE_K = d => 1;              // range never speeds the bars: distance hurts through the wind (and rivals, and bosses)
const METER_WIND = 0.06;                   // gauge units the gold slides per wind unit (x distK)
const METER_VARY = 0.05;                   // each bar runs up to this much faster or slower than the last
const METER_TIRE = 0.35;                   // past steady (green arms bar), the bars speed up this much per second
const METER_SURGE = 0;                     // heartbeats never speed the bar up (only tiring does); kept as a knob
const METER_LOOSE = 1.0;                   // loose bar pace vs the height bar (the gauge is only a bit longer on screen now)
const METER_KICK = 0.02;                    // a heartbeat just nudges the bar this far ahead (gauge units; more at a higher BPM)
const meters = () => !!G && (G.free ? !!G.free.meters : true);   // the tournament always shoots meters; classic lives on in Free Practice
let PSET = null;
function openPractice() {
  let saved = {}; try { saved = JSON.parse(store.getItem('linecutter_practice')) || {}; } catch (e) {}
  PSET = { row: 3, range: clamp(saved.range | 0, 0, PRAC_RANGES.length - 1), spread: clamp(saved.spread == null ? 1 : saved.spread | 0, 0, PRAC_SPREADS.length - 1),
    meters: saved.meters !== false, build: cleanBuild(saved.build), rituals: cleanRituals(saved.rituals) };
  setState('pset');
}
function psetUpdate(pr) {
  const P = PSET;
  if (pr('b')) { SFX.sel(); setState('title'); return; }
  if (pr('up') || pr('down')) { P.row = (P.row + (pr('up') ? 4 : 1)) % 5; SFX.move(); }
  const d = pr('left') ? -1 : pr('right') ? 1 : 0;
  if (d && P.row === 0) { P.range = (P.range + d + PRAC_RANGES.length) % PRAC_RANGES.length; SFX.move(); }
  if (d && P.row === 1 && !P.meters) { P.spread = (P.spread + d + PRAC_SPREADS.length) % PRAC_SPREADS.length; SFX.move(); }
  if (d && P.row === 2) { P.meters = !P.meters; SFX.move(); }
  if (!pr('a')) return;
  if (P.row === 4) { SFX.sel(); setState('title'); return; }
  if (P.row === 1 && P.meters) { SFX.sel(); P.gsel = 0; setState('mgear'); return; }
  savePset();
  SFX.sel(); fadeTo(() => startFree(P.range, P.spread, P.meters, P.build, P.rituals), true, 0.6);
}
function savePset() { const P = PSET; try { store.setItem('linecutter_practice', JSON.stringify({ range: P.range, spread: P.spread, meters: P.meters, build: P.build, rituals: P.rituals })); } catch (e) {} }
// Gear picker: one row per slot. Left/right walks none -> type A I, II, III -> type B ...; the strip updates live.
// START deals a mock shop: three offers under the real rule (new type for an empty slot, else the next tier).
const pickRows = () => [{ hdr: 'GEAR' }].concat(SLOTS.map(sl => ({ sl })), [{ hdr: 'FORM' }], FORM_SLOTS.map(sl => ({ sl })), [{ hdr: 'RITUALS' }], M_RITUALS.map(r => ({ r })));
const slotOpts = sl => [null].concat(...sl.types.map(ty => Array.from({ length: ty.max || 1 }, (_, i) => ({ t: ty.id, n: i + 1 }))));
function mgearUpdate(pr) {
  const P = PSET, rows = pickRows().filter(r => !r.hdr), n = rows.length;
  if (pr('b')) { SFX.sel(); savePset(); setState('pset'); return; }
  if (pr('start')) { P.offers = shopDeal(P.build, P.rituals); P.osel = 0; SFX.sel(); setState('mshop'); return; }
  if (pr('up') || pr('down')) { P.gsel = (P.gsel + (pr('up') ? n - 1 : 1)) % n; SFX.move(); }
  const d = pr('left') ? -1 : pr('right') || pr('a') ? 1 : 0, row = rows[P.gsel];
  if (d && row.r) { const id = row.r.id; P.rituals = P.rituals.includes(id) ? P.rituals.filter(x => x !== id) : P.rituals.concat(id); SFX.move(); }
  else if (d) {
    const sl = row.sl, o = slotOpts(sl), b = P.build[sl.id];
    const i = b ? o.findIndex(x => x && x.t === b.t && x.n === b.n) : 0, nx = o[(i + d + o.length) % o.length];
    if (nx) P.build[sl.id] = nx; else delete P.build[sl.id];
    SFX.move();
  }
}
function mshopUpdate(pr) {
  const P = PSET, o = P.offers;
  if (pr('b') || !o.length) { SFX.sel(); setState('mgear'); return; }
  if (pr('up') || pr('down')) { P.osel = (P.osel + (pr('up') ? o.length - 1 : 1)) % o.length; SFX.move(); }
  if (pr('a')) { const f = o[P.osel]; if (f.rit) P.rituals = P.rituals.concat(f.rit); else P.build[f.slot] = { t: f.t, n: f.n }; savePset(); SFX.sel(); setState('mgear'); }
}
function startFree(ri, si, mt, build = {}, rituals = []) {
  DLG = null;
  const base = ROUNDS[PRAC_RANGES[ri].r];
  G = { season: 1, round: 0, rituals: [], crawl: null, thisAvg: 0, lastAvg: 0, total: 0, xCount: 0, bestEnd: 0,
    bpm: 68, beatPh: 0, lastBeat: 0, beatFlash: 0, kickDir: 1, wind: 0, windTarget: 0, chat: { talking: false, timer: 3, line: '', blipT: 0 },
    free: { range: ri, spread: si, meters: !!mt, build: cleanBuild(build) } };
  if (mt) { G.rituals = cleanRituals(rituals); G.strip = buildStrip(G.free.build, G.rituals); applyFx(G.free.build, G.rituals); G.stripCur = G.strip; G.mWind = 0; }
  const R = { ...base, name: 'FREE PRACTICE', crowd: 0, panic: false, match: false, opp: null, target: 0 };
  G.R = R; G.roundScore = 0; G.disp = 0; G.end = 0; G.endArrows = []; G.arrow = 0; G.letdowns = 0; G.luckyUsed = false; G.prevCrawl = null;
  G.trueCrawl = clamp(R.crawl + randInt(-2, 2), 0, 9); G.crawl = 5; G.holdoff = 0; G.lastRel = '';
  G.practice = false; G.trail = null; G.nbStack = 0; G.coachNext = false; G.roundVals = [];
  G.windTarget = R.wind ? randInt(R.wind[0], R.wind[1]) : 0; G.wind = G.windTarget; G.gustT = 3;
  G.tuneBias = randInt(-2, 2); G.target = 0; G.match = false; G.maxEnds = 0; G.shootoff = false; G.sets = [0, 0]; G.opp = null;
  G.bet = null; G.idleT = 0; G.cam = null; G.startleT = -9; G.betsLeft = 0;
  BG = makeBg(R.bg, true, R.dist);
  setState('aim'); pop('FREE PRACTICE', 120, 22, C.green, 1, 1.6, 0);
}
// The draw sheet: a breath between screens that shows where you are in the tournament.
function toBracket() { G.bracketFrom = Math.max(0, G.round - 1); setState('bracket'); }
// Screen changes dip to black and back. `dip` also fades the music out (when the next screen changes song).
let FADE = null;
function fadeTo(fn, dip = false, dur = 0.4) { if (FADE && FADE.k === 'out') return; FADE = { k: 'out', t: 0, dur, fn, dip }; }
function fadeUpdate(dt) {
  if (!FADE) return false;
  FADE.t += dt;
  if (FADE.k === 'out') { if (FADE.t >= FADE.dur) { const f = FADE.fn; FADE = { k: 'in', t: 0, dur: FADE.dur }; f(); } return true; }
  if (FADE.t >= FADE.dur) FADE = null;
  return false;
}
// The Old Trad Guy never holds, so a clicker never clicks for him: never offer both.
const CLASH = { trad: 'clicker', clicker: 'trad' };
const canGet = k => !G.rituals.includes(k) && !(CLASH[k] && G.rituals.includes(CLASH[k]));
function openShop(header) {
  if (meters()) {
    G.offer = shopDeal(G.build, G.rituals);
    if (!G.offer.length) { toBracket(); return; }
    G.sel = 0; G.shopHeader = header; setState('shop'); return;
  }
  const avail = Object.keys(RITUALS).filter(canGet);
  if (G.rituals.length >= 6 || !avail.length) { toBracket(); return; }
  G.offer = shuffle(avail).slice(0, 3);
  const bends = avail.filter(k => RITUALS[k].cost && !G.offer.includes(k));   // always one card that bends the rules
  if (!G.offer.some(k => RITUALS[k].cost) && bends.length && G.offer.length === 3) G.offer[randInt(0, 2)] = bends[randInt(0, bends.length - 1)];
  G.sel = Math.min(1, G.offer.length - 1); G.shopHeader = header;
  setState('shop');
}
function startRound(i) {
  const R = ROUNDS[i]; G.R = R; G.round = i;
  G.roundScore = 0; G.disp = 0; G.end = 0; G.endArrows = []; G.arrow = 0; G.letdowns = 0; G.luckyUsed = false; G.prevCrawl = null;
  G.trueCrawl = clamp(R.crawl + randInt(-2, 2), 0, 9);       // today's conditions: practice tells you
  G.crawl = G.crawl == null ? 5 : G.crawl; G.holdoff = 0; G.lastRel = '';
  G.practice = true; G.trail = null; G.nbStack = 0; G.coachNext = false; G.roundVals = [];
  G.windTarget = R.wind ? randInt(R.wind[0], R.wind[1]) : 0; G.wind = G.windTarget; G.gustT = 3;
  G.tuneBias = randInt(-2, 2);                              // arrows fly a bit left/right today: practice shows it
  G.target = Math.round((R.target || 0) * (1 + 0.7 * (G.season - 1)));
  G.match = !!R.match; G.maxEnds = G.match ? 5 : 3; G.shootoff = false; G.sets = [0, 0];
  G.bet = null; G.idleT = 0; G.cam = null; G.startleT = -9;
  const O = oppAt(i);
  G.betsLeft = O ? 1 : 0;
  const tgt = O ? rivalTarget(i, O) : 0;   // Brenda shoots the same ring every arrow: the target, rounded
  G.opp = O ? { ...O, target: tgt, sd: O.fixed ? 0 : sdForAvg(tgt, R, O.flier || 0), fixed: O.fixed ? clamp(Math.round(tgt), 1, 10) : 0, tiltLeft: 0 } : null;
  G.called = 0; G.vCount = 0;
  refreshStrip();
  if (O && RIVALS[O.icon] && !G.free) { RIV.met[O.icon] = true; saveRiv(); }
  BG = makeBg(R.bg, true, R.dist);
  setState('intro');
}
// Without a plunger, L/R aims off (the point leaves the X). With one, L/R tunes the spring: the point stays on.
const aimX = () => TX + (has('plunger') ? 0 : G.holdoff * T.holdoffPx);
function fl(a, t) {
  const p = G.fp;
  return { x: a * (0.62 * Math.sin(t * 1.9 + p[0]) + 0.38 * Math.sin(t * 3.7 + p[1])),
           y: a * (0.62 * Math.sin(t * 1.5 + p[2]) + 0.38 * Math.sin(t * 3.1 + p[3])) };
}
const steadyTime = () => T.steadyTime + (has('backten') ? 1.5 : 0) - (has('limbs') ? 1 : 0);
const maxHold = () => has('limbs') ? 3.5 : T.maxHold;
const SPREAD_GEAR = { plunger: 0.9, weights: 0.8, routine: 0.75, backten: 0.8, tuned: 0.55, anchor: 0.8, grip: 0.85, trad: 0.75, instinct: 0.7 };
// The clicker clicks once per hold; the release counts as "on the click" for CLICK_WIN seconds after.
const CLICK_WIN = 0.5;
const clickState = () => !has('clicker') || G.clickAt == null ? null : G.holdT < G.clickAt ? 'early' : G.holdT <= G.clickAt + CLICK_WIN ? 'on' : 'late';
const plugged = () => has('earplugs');
// Boss moves. Brenda finished her end ages ago and taps her foot while you dither; Chad films your hold.
const bossIs = k => !!(G && G.match && G.opp && G.opp.icon === k && !G.practice);
const tapping = () => bossIs('brenda') && !plugged() && S === 'aim' && G.idleT > 4;
// Chad's flash: a startle that jolts the point and spikes your heart for a moment.
// Hank's arrows thunking home mid-hold and Viktor's "TOO LONG" are smaller ones (startK).
const STARTLE = 0.6;
function camKick() {
  const t = time - G.startleT; if (!G.cam || t < 0 || t > STARTLE) return { x: 0, y: 0 };
  const e = Math.exp(-t / 0.18) * 7 * Math.sqrt(G.R.distK) * (G.startK || 1);
  return { x: G.cam.dx * e, y: G.cam.dy * e };
}
const matchPoint = () => G.match && (G.shootoff || G.sets[0] >= 4 || G.sets[1] >= 4);
function spreadMul() {
  let m = G.rituals.reduce((m, r) => m * (SPREAD_GEAR[r] || 1), 1);
  if (has('notebook')) m *= Math.pow(0.88, G.nbStack || 0);
  if (has('coach') && G.coachNext) m *= 0.6;
  if (has('ice') && matchPoint()) m *= 0.75;
  const cs = clickState(); if (cs) m *= cs === 'on' ? 0.5 : 1.3;
  if (G.free) m *= PRAC_SPREADS[G.free.spread].spread;
  return m;
}
const anchorHalf = () => T.anchorHalf * (has('anchor') ? 2 : 1);
function floatAmp() {
  let a = T.floatBase * G.R.distK;
  a *= 1 + (has('routine') ? 0.3 : 0.6) * Math.exp(-G.holdT * (has('routine') ? 5 : 2.2));   // settling in (the spring does the rest)
  a *= 1 + Math.max(0, G.holdT - steadyTime()) * (has('backten') ? 0.4 : 0.8);                // fatigue
  if (has('weights')) a *= 0.6;
  if (G.panicNow) a *= G.defOps && G.defOps.steadyhand ? 1.05 : 1.35;
  if (!has('plunger')) a *= 1 + Math.min(0.4, Math.abs(G.holdoff) * 0.07);   // holding off a reference is shakier
  if (G.free) a *= PRAC_SPREADS[G.free.spread].float;
  return a;
}
const tradAmp = () => T.floatBase * G.R.distK * 1.3 * (has('weights') ? 0.6 : 1) * (G.panicNow ? (G.defOps && G.defOps.steadyhand ? 1.05 : 1.35) : 1) * (G.free ? PRAC_SPREADS[G.free.spread].float : 1);
// Each heartbeat kicks the bow: a quick jump of the point that settles back.
function pulseKick() {
  const t = time - G.lastBeat; if (t > 0.4) return { x: 0, y: 0 };
  const amp = T.kickPx * (0.8 + (G.bpm - 60) * 0.035) * G.R.distK * (has('breathe') ? 0.5 : 1) * (has('grip') ? 0.6 : 1);
  const e = t < 0.03 ? t / 0.03 : Math.exp(-(t - 0.03) / 0.07);
  return { x: G.kickDir * amp * 0.5 * e, y: -amp * e };
}
const chatOn = () => !!(G.match && G.opp && G.opp.chatty) && !plugged();
// Drawing, the point drops in from above and passes the X at the anchor mark: stop early and you
// anchor high, overdraw and you anchor low. In the hold the point springs back toward centre and
// overshoots; the further off you anchored, the faster and wilder the swing.
// Smooth S-curve: steep (anchorErrPx px per unit) around the anchor mark, easing out to +/-40px.
const anchorCurve = e => 40 * Math.tanh(e * T.anchorErrPx / 40);
const faceR = () => 10 * T.ringR;   // outer edge of the target face
// While drawing, the point and its spread ghost fall at a near-steady pace from fully above the top of the
// screen, picking up a little speed through the X. Overdrawn, the point bottoms out at the face's lower edge.
const drawGhostR = () => 2 * Math.hypot(T.formSpread * G.R.spreadK * spreadMul(), T.floatBase * G.R.distK * 1.5 * (G.free ? PRAC_SPREADS[G.free.spread].float : 1));
const drawOffset = p => {
  const e = p - T.anchor, start = TY + drawGhostR() + 4;
  return Math.min(faceR(), (start - 15) / T.anchor * e + 15 * Math.tanh(e * 5));
};
// Where the hold starts if you anchor at p: a clean anchor starts you nearly on the X, a miss where the point
// is, but never further out than the top or bottom edge of the face.
const holdStart = p => { const e = p - T.anchor; return Math.abs(e) <= anchorHalf() ? anchorCurve(e * 0.25) : clamp(drawOffset(p), -faceR(), faceR()); };
// Swing centred on where you anchored, reaching toward the X: it starts at the anchor, swings out to the X
// (slightly past it on the first swing), back to the anchor, and each swing reaches less far. Waiting gets
// you a shot at the X near each peak, where the point is slowest; wait too long and it dies at the anchor.
function springY(t) {
  const y0 = G.y0 || 0, w = 3.0 + Math.min(40, Math.abs(y0)) * 0.08, z = T.springZeta;
  const k = 1.12 * Math.exp(z * Math.PI);            // first peak overshoots the X by ~12%
  return y0 * (1 - k * Math.exp(-z * w * t) * (1 - Math.cos(w * t)) / 2);
}
const windSway = () => { const w = G.windNow || 0; return w * T.windSway * G.R.distK * (0.6 + 0.4 * Math.sin(time * 1.7)); };
function pointPos() {
  const ax = aimX() + (S === 'draw' || S === 'hold' ? windSway() : 0);
  if (S === 'draw') {
    const f = fl(has('trad') ? tradAmp() : T.floatBase * G.R.distK * 1.5 * (G.free ? PRAC_SPREADS[G.free.spread].float : 1), G.drawT);
    const k = pulseKick(), c = camKick();
    return { x: ax + f.x + k.x + c.x, y: TY + f.y + k.y + c.y + drawOffset(G.p) };
  }
  if (S === 'hold') {
    const f = fl(floatAmp(), G.holdT + G.drawT);
    const k = pulseKick(), c = camKick();
    return { x: ax + f.x + k.x + c.x, y: TY + f.y + k.y + c.y + springY(G.holdT) };
  }
  return { x: ax, y: TY };
}
function targetBpm() {
  const R = G.R; let b = 68 + (plugged() ? 0 : R.crowd || 0);
  if (G.match) { if (G.sets[1] >= 4) b += 10; if (G.sets[0] >= 4) b += 6; if (G.shootoff) b += 16; }
  if (has('closer') && !G.practice && !G.shootoff && G.arrow === 2) b += 12;
  if (G.bet) b += 8;                                                        // there's gear riding on it
  if (tapping()) b += Math.min(16, (G.idleT - 4) * 3);
  if (time - G.startleT < 2.5) b += 18 * (G.startK || 1) * (1 - (time - G.startleT) / 2.5);   // the flash made you jump
  if (!G.match && !G.free) { if (G.end === 2 && G.arrow === 2) b += 12; if (G.end === 2 && G.roundScore < G.target) b += 8; }
  b += G.letdowns * 5 * (G.strip ? G.strip.letdownBpm : 1);
  if (S === 'draw' || S === 'hold' || S === 'mv' || S === 'mh') b += 6;
  if (S === 'hold' || S === 'mv' || S === 'mh') b += Math.max(0, G.holdT - 1.5) * 6;
  if (chatOn() && G.chat.talking) b += 14;
  if (G.panicNow) b += G.defOps && G.defOps.steadyhand ? 8 : 20;
  if (has('breathe')) b -= 12;
  if (G.strip) b -= G.strip.bpmDrop;
  if (has('nolook')) b -= 15;
  if (has('ice') && matchPoint()) b -= 20;
  return clamp(b, 50, 170);
}
function heartUpdate(dt) {
  G.bpm += (targetBpm() - G.bpm) * Math.min(1, dt * 1.2);
  G.beatPh += G.bpm / 60 * dt;
  if (G.beatPh >= 1) { G.beatPh -= 1; G.lastBeat = time; G.beatFlash = 0.12; G.kickDir = (rand() < .5 ? -1 : 1) * (0.4 + rand() * 0.6); if ((S === 'draw' || S === 'hold' || S === 'mv' || S === 'mh') && !plugged()) SFX.beat(G.bpm); }
  if (G.beatFlash > 0) G.beatFlash -= dt;
  if (chatOn() && ['aim', 'draw', 'hold', 'mv', 'mh'].includes(S)) {
    const c = G.chat; c.timer -= dt;
    // Dale saves his best material for your hold.
    if ((S === 'hold' || S === 'mv' || S === 'mh') && !c.talking && !G.chatHold && time > (c.quietUntil || 0)) { G.chatHold = true; if (rand() < 0.5) c.timer = 0.3 + rand() * 0.6; }
    if (c.timer <= 0) { c.talking = !c.talking; c.timer = c.talking ? 2 + rand() * 2 : 5 + rand() * 4;
      if (!c.talking) c.quietUntil = time + 6 + rand() * 3;   // after a bit he gives you a shot or two in peace
      if (c.talking) c.line = G.bet && rand() < 0.5 ? BET_CHATTER[randInt(0, BET_CHATTER.length - 1)] : CHATTER[randInt(0, CHATTER.length - 1)]; }
    if (c.talking) { c.blipT -= dt; if (c.blipT <= 0) { SFX.blip(); c.blipT = 0.08 + rand() * 0.05; } }
  }
  if (S === 'aim' && !DLG) {                        // Brenda's foot
    G.idleT = (G.idleT || 0) + dt;
    if (tapping()) { const n = Math.floor((G.idleT - 4) / 0.5); if (n !== G.tapN) { G.tapN = n; SFX.tap(); } }
  }
  if ((S === 'hold' || S === 'mv' || S === 'mh') && G.cam && G.cam.at != null) {  // Chad's phone: it whines, then flashes
    if (!G.cam.warned && G.holdT >= G.cam.at - 0.8) { G.cam.warned = true; SFX.charge(); }
    if (G.holdT >= G.cam.at && G.cam.thunk) { G.cam.at = null; G.startleT = time; G.startK = 0.55; SFX.thunk(); shake = 0.08; pop('THUNK', 212, 48, '#dcb97e'); }
    else if (G.holdT >= G.cam.at) { G.cam.at = null; G.startleT = time; G.startK = 0.7; G.camFlash = 0.3; G.blindUntil = time + 0.8; SFX.snap(); pop('SNAP!', 212, 48, C.white); }
  }
  if ((S === 'hold' || S === 'mv' || S === 'mh') && bossIs('viktor') && !plugged()) {   // Viktor counts your hold. Past four, he tells you.
    const n = Math.floor(G.holdT);
    if (n >= 1 && n !== G.vCount) { G.vCount = n;
      if (n < 4) { pop(['ONE', 'TWO', 'THREE'][n - 1], 212, 48, C.dim); tone(VOICE.viktor * (1 + n * 0.06), 0.07, 'square', 0.03); }
      else if (n === 4) { pop('TOO LONG.', 206, 48, C.red); tone(VOICE.viktor * 0.8, 0.18, 'square', 0.04); G.startleT = time; G.startK = 0.7; }
    }
  }
  if (G.camFlash > 0) G.camFlash -= dt;
  if (G.R.gusty && ['aim', 'draw', 'hold', 'mv', 'mh'].includes(S)) {
    G.gustT -= dt;
    if (G.gustT < 1 && !G.gustWarned) { G.gustWarned = true; noise(0.5, 0.03, 300, 'bandpass'); }   // the flag tells you first
    if (G.gustT <= 0) { G.windTarget = randInt(-3, 3); G.gustT = 2.5 + rand() * 3; G.gustWarned = false; SFX.gust(); pop('GUST!', 209, 48, C.orange); }
  }
  G.wind += (G.windTarget - G.wind) * Math.min(1, dt * 2);
  // what you actually feel: the base wind plus flutter (none indoors)
  G.windNow = G.R.wind ? G.wind + 0.35 * Math.sin(time * 0.9) + 0.2 * Math.sin(time * 2.3 + 1) : 0;
  if (G.strip) G.mWind = (G.mWind || 0) + (G.windNow - (G.mWind || 0)) * Math.min(1, dt / Math.max(0.05, G.strip.windLag));   // spiral vanes: the gold follows the wind lazily
}

// ---------- shot flow ----------
function startDraw() {
  G.p = 0; G.drawT = 0; G.holdT = 0; G.y0 = 0; G.fp = [0, 0, 0, 0].map(() => rand() * 6.283); G.panicNow = false;
  G.clickAt = null; G.chatHold = false; G.idleT = 0; G.tapN = -1; G.cam = null; G.vCount = 0;
  SFX.draw(); setState('draw');
}
const mShift = () => -(G.strip && G.strip.windLag ? G.mWind : (G.windNow || 0)) * METER_WIND * (G.strip ? G.strip.wind : 1) * G.R.distK;   // the gold slides upwind
// Which zone a gauge position (-1..1, already wind-corrected) is in, and how far through it (0 inner edge, 1 outer).
function mZone(p, st = G.stripCur || G.strip) {
  const d = Math.abs(p), w = st.w; let a = 0;
  for (let i = 0; i < w.length; i++) { if (d < a + w[i]) return { k: st.k[i], f: (d - a) / w[i] }; a += w[i]; }
  return { k: st.k[w.length - 1], f: 1 };
}
const mOffset = p => { const z = mZone(p), b = ZONE_PX(z.k); return (p < 0 ? -1 : 1) * (b[0] + z.f * (b[1] - b[0])); };
// Each bar starts somewhere random, heading a random way, so you track it instead of counting a beat.
// Every bar gets its own pace, so muscle memory from the last shot won't quite fit.
const newBar = () => ({ pos: rand() * 2 - 1, dir: rand() < .5 ? -1 : 1, k: 1 + (rand() * 2 - 1) * METER_VARY });
// Your pulse shoves the bar: a quick surge on every beat that dies away. The calmer you are, the gentler and rarer.
function beatSurge() {
  const t = time - G.lastBeat; if (t > 0.4) return 0;
  const e = t < 0.03 ? t / 0.03 : Math.exp(-(t - 0.03) / 0.1);
  return METER_SURGE * (G.strip ? G.strip.surge : 1) * (0.8 + (G.bpm - 60) * 0.02) * e;
}
// Tiring out: one clock runs across both bars (the arms bar). Steady through the green,
// then faster every second you hang on. Dither on the height and you'll loose tired.
const tired = () => Math.max(0, G.holdT - steadyTime() - (G.strip ? G.strip.steady : 0));
const holdPace = () => 1 + tired() * METER_TIRE * (G.strip ? G.strip.tire : 1);
const chatJitter = () => chatOn() && G.chat.talking ? 1 + 0.35 * Math.sin(time * 13) * Math.sin(time * 4.1) : 1;   // Dale talking through your shot
const barSpeed = m => chatJitter() * m.k * holdPace() * (1 + beatSurge());   // within a bar, only tiring and heartbeats change the speed (no wobble, settle or ease-in)
function startMeters() {
  if (G.arrow === 0) { G.grow = {}; G.stripCur = G.strip; G.perfUsed = false; }   // a fresh end: grouping and redos reset
  G.holdT = 0; G.drawT = 0; G.idleT = 0; G.tapN = -1; G.cam = null; G.blindUntil = 0; G.panicNow = false; G.chatHold = false; G.vCount = 0;
  bossSetup(0.55);
  G.mv = newBar(); G.mh = null; G.mLock = null;
  SFX.draw(); setState('mv');
}
function sweep(m, dt, shift = 0) {
  const L = G.strip, vert = m === G.mv, v0 = 2 / (L.period * (vert ? L.pv : L.ph * METER_LOOSE)) * METER_RANGE_K(G.R.distK) * barSpeed(m) * (has('instinct') ? 0.85 : 1) * (has('coach') && G.coachNext ? 0.7 : 1) * (has('lastarrow') ? (G.arrow === 2 ? 0.6 : G.arrow === 0 ? 1.3 : 1) : 1);
  const drag = L.slow * (vert ? L.slowV : L.slowH);
  const n = Math.ceil(dt / 0.002), h = dt / n;
  for (let i = 0; i < n; i++) {
    const zk = mZone(m.pos - shift).k;
    m.pos += m.dir * v0 * (GOLDS.has(zk) ? drag : (zk === 8 || zk === 7) ? (vert ? L.slowV : L.slowH) : 1) * h;   // form drags through gold and red; gold drag from gear only in gold
    if (m.pos > 1) { m.pos = 2 - m.pos; m.dir = -1; } else if (m.pos < -1) { m.pos = -2 - m.pos; m.dir = 1; }
  }
}
const badStop = k => k === 'M' || (typeof k === 'number' && k <= 4);
function luckyRedo(m, k) {
  if (has('lucky') && !G.luckyUsed && badStop(k)) { G.luckyUsed = true; G.holdT = 0; /* a fresh start: the tiredness clock resets too */ Object.assign(m, newBar()); feedback('LUCKY TAB: AGAIN', C.gold); SFX.sel(); return true; }
  if (has('perfect') && !G.perfUsed && !GOLDS.has(k)) { G.perfUsed = true; G.bpm += 14; Object.assign(m, newBar()); feedback('NOT GOOD ENOUGH. AGAIN.', C.orange); SFX.sel(); return true; }
  return false;
}
// Grouping: the ring you just hit grows for the rest of the end (both bars).
function groupHit(k) {
  if (!has('grouping') || !G.strip) return;
  G.grow[k] = (G.grow[k] || 1) * 1.35;
  const st = { ...G.strip, k: G.strip.k.slice(), w: G.strip.w.slice() };
  Object.keys(G.grow).forEach(z => sWidenAll(st, isNaN(z) ? z : +z, G.grow[z]));
  const t = st.w.reduce((a, b) => a + b, 0); st.w = st.w.map(x => x / t); G.stripCur = st;
}
function meterLock() {
  if (luckyRedo(G.mv, mZone(G.mv.pos).k)) return;
  G.mLock = G.mv.pos; GOLDS.has(mZone(G.mLock).k) ? SFX.anchor() : SFX.move();
  G.mh = newBar();
  setState('mh');
  if (teaching() && !G.saidHold) { G.saidHold = true; oppSay('tutHold', () => {}); }
}
// The arrow goes out at the angle the two stops make. The loose can't beat your height: it scores at most your height's
// ring, plus G.lift rings from Shot Routine. A loose worse than your height just counts.
const looseCap = (zv, lift) => ringVal(zv) + (lift || 0);
const capRing = v => v <= 0 ? 'M' : v >= 10.5 ? 'X' : Math.min(10, Math.floor(v));
function meterRelease() {
  if (luckyRedo(G.mh, mZone(G.mh.pos - mShift()).k)) return;
  G.coachNext = false;
  const ox = mOffset(G.mh.pos - mShift()), oy = mOffset(G.mLock), zv = mZone(G.mLock).k, zh = mZone(G.mh.pos - mShift()).k, cap = looseCap(zv, G.lift);
  const within = ringVal(zh) <= cap, cr = capRing(cap), b = ZONE_PX(cr);
  const r = within ? Math.abs(ox) : ringVal(zv) >= ringVal(cr) ? Math.abs(oy) : (b[0] + b[1]) / 2;   // capped: land mid-ring at the cap
  groupHit(within ? zh : cr);   // the ring that scored
  const up = within ? Math.min(10, Math.floor(ringVal(zh))) - Math.min(10, Math.floor(ringVal(zv))) : 0;   // Shot Routine at work: the loose beat your height
  const t = Math.atan2(oy, ox), a = r ? { x: TX + Math.cos(t) * r, y: TY + Math.sin(t) * r } : { x: TX, y: TY };
  G.trail = { base: a, parts: [] }; G.lastRel = 'CLEAN';
  SFX.release();
  G.fl = { t: 0, from: { x: TX, y: TY }, a: { x: a.x, y: a.y, crawl: G.crawl, routine: up > 0 ? up : 0 } };
  setState('flight');
}
function letDown(msg = 'LET DOWN') { G.letdowns++; SFX.letdown(); feedback(msg, C.dim); G.panicNow = false; setState('aim'); }
// Boss moves for this shot. k scales when they land (the meters shot is quicker than a classic hold).
function bossSetup(k) {
  // never in your first moment: the whine always comes once you're settled, so you can let down
  if (bossIs('chad') && rand() < 0.4) { const a = rand() * 6.283; G.cam = { at: (1.1 + rand() * 1.8) * k, warned: false, dx: Math.cos(a), dy: Math.sin(a) }; }
  // Hank shoots fast: his arrows land while you're still holding. No warning.
  if (bossIs('hank') && !plugged() && rand() < 0.5) { const a = rand() * 6.283; G.cam = { at: (0.4 + rand() * 1.8) * k, warned: true, thunk: true, dx: Math.cos(a), dy: Math.sin(a) }; }
  // Viktor needs a target to kick even when there's no flash coming.
  if (bossIs('viktor') && !G.cam) { const a = rand() * 6.283; G.cam = { at: null, dx: Math.cos(a), dy: Math.sin(a) }; }
}
function anchor(p) {
  const err = p - T.anchor; const good = Math.abs(err) <= anchorHalf();
  G.y0 = holdStart(p);
  if (good) { SFX.anchor(); feedback('ANCHOR', C.gold); }
  else { SFX.bad(); feedback(err < 0 ? 'SHORT: ANCHORED HIGH' : 'OVERDRAWN: LOW', C.red); }
  if (good) seen('anchor');
  if (has('clicker')) G.clickAt = 1.0 + rand() * 0.6;   // a little different every shot: the hold bar marks it
  bossSetup(1);
  if (has('trad')) release(); else { G.holdT = 0; setState('hold'); if (teaching() && !G.saidHold) { G.saidHold = true; oppSay('tutHold', () => {}); } }
}
const inPluck = () => { const since = time - G.lastBeat, until = (1 - G.beatPh) / (G.bpm / 60); return since < T.pluckPost || until < T.pluckPre; };
// The spread ghost: ~86% of arrows land inside this circle right now. Gear shrinks it; float, fatigue and
// the pulse grow it; it flashes red in a pluck window. Centred on where you're pointing (plus plunger offset).
// Time of flight (~65 m/s arrow) and how far the arrow visibly rises above the line before dropping in.
const flightTime = () => G.R.dist / 65;
const flightArc = () => Math.pow(G.R.dist / 12.5, 2);
const pluckPx = () => 11 * Math.sqrt(G.R.distK) * (has('tuned') ? 0.5 : 1);
function spreadGhost() {
  let sd = T.formSpread * G.R.spreadK * spreadMul(), p, dy = 0;
  if (S === 'hold') { sd = Math.hypot(sd, floatAmp() * 0.6); p = pointPos(); }
  else if (S === 'draw') {      // where you'd start the hold if you anchored right now
    sd = drawGhostR() / 2; p = { x: aimX(), y: TY };   // rides with the point (holdStart snaps it onto the face if you anchor above it)
    dy = Math.abs(G.p - T.anchor) <= anchorHalf() ? holdStart(G.p) : drawOffset(G.p);
  } else p = { x: aimX(), y: TY };
  const danger = S === 'hold' && inPluck() && !(has('lucky') && !G.luckyUsed) && !plugged();   // earplugs: you can't hear it coming
  // on a heartbeat spike the ghost stretches sideways by the pluck it would cause
  return { x: p.x + (has('plunger') ? G.holdoff * T.holdoffPx : 0), y: p.y + dy, r: 2 * sd, rx: 2 * sd + (danger ? pluckPx() : 0), danger };
}
function release() {
  const R = G.R, dk = R.distK; let base;
  let drawDy;
  if (S === 'draw') { const f = fl(tradAmp(), G.drawT); base = { x: aimX() + f.x, y: TY + f.y }; drawDy = G.y0; }
  else { base = pointPos(); drawDy = springY(G.holdT); base.y -= drawDy; }
  // Every error source is kept separately so the trail can show why the arrow went where it did.
  const parts = [];
  const add = (k, dx, dy) => parts.push({ k, dx, dy });
  add('crawl', 0, (G.crawl - G.trueCrawl) * T.crawlPx);
  add('draw', 0, drawDy);
  add('wind', (G.windNow || 0) * T.windPx * dk * (has('limbs') ? 0.4 : 1) + G.tuneBias * T.holdoffPx + (has('plunger') ? G.holdoff * T.holdoffPx : 0), 0);
  let rel = 'CLEAN';
  if (!inPluck()) seen('loose');
  if (inPluck()) {
    if (has('lucky') && !G.luckyUsed) { G.luckyUsed = true; rel = 'LUCKY TAB!'; }
    else { rel = 'PLUCK!'; add('pluck', (rand() < .5 ? -1 : 1) * (8 + rand() * 6) * Math.sqrt(dk) * (has('tuned') ? 0.5 : 1), (rand() - .5) * 3); }
  }
  G.nbStack = G.prevCrawl === G.crawl ? Math.min(3, (G.nbStack || 0) + 1) : 0; G.prevCrawl = G.crawl;
  const sp = T.formSpread * R.spreadK * spreadMul(); add('form', gauss() * sp, gauss() * sp);
  let ix = base.x, iy = base.y; parts.forEach(q => { ix += q.dx; iy += q.dy; });
  G.trail = { base, parts };
  G.coachNext = false;
  const cs = clickState();
  if (cs && rel === 'CLEAN') rel = cs === 'on' ? 'IN THE GROOVE!' : cs === 'early' ? 'NOT THERE YET' : 'PAST IT';
  G.lastRel = rel; feedback(rel, rel === 'PLUCK!' || (cs && cs !== 'on') ? C.red : rel === 'CLEAN' ? C.green : C.gold);
  SFX.release();
  G.fl = { t: 0, from: base, a: { x: ix, y: iy, crawl: G.crawl } };
  G.panicNow = false;
  setState('flight');
}
function scoreArrow(a, ar = T.arrowR) {
  const R = T.ringR, d = Math.hypot(a.x - TX, a.y - TY), de = Math.max(0, d - ar);
  if (de > 10 * R) return { v: 0, label: 'M', miss: true };
  const ring = 10 - Math.floor(de / R), ringNo = 10 - Math.floor(d / R);
  const x = de < R / 2, xNo = d < R / 2;
  return { v: ring, x, de, lc: ring !== ringNo || (x && !xNo), label: x ? 'X' : String(ring) };
}
function land() {
  const a = G.fl.a; a.s = scoreArrow(a, has('fat') ? 1.8 : G.strip && G.strip.fat ? G.strip.fat : T.arrowR); G.endArrows.push(a); G.arrow++;
  // Judy: if it's on the line, it isn't. Scored by where the shaft's centre is.
  const callIt = bossIs('judy') && a.s.lc;
  if (callIt) { a.s = scoreArrow(a, 0); a.s.called = true; G.called++; }
  if (has('highstakes') && a.s.x && a.s.de < T.ringR / 4) { a.s.xx = true; a.s.label = 'XX'; }   // High Stakes: the X has an X (two in the X count)
  a.val = (G.colorPlus && !a.s.miss ? Math.min(10, a.s.v + (G.colorPlus[ringColor(a.s.v)] || 0)) : a.s.v) + (has('inner') && a.s.x ? 1 : 0);   // colour bonuses, never past 10
  if (has('allin')) a.val = a.s.x ? 15 : a.s.v < 8 ? 0 : a.val;
  if (has('closer') && !G.shootoff) a.val = G.arrow === 1 ? 0 : G.arrow === 3 ? a.val * 2 : a.val;   // G.arrow already counts this one
  if (G.defOps && G.defOps.floor && !a.s.miss) a.val = Math.max(a.val, G.defOps.floor.floor);
  a.plus = G.colorPlus ? a.val - a.s.v - (has('inner') && a.s.x ? 1 : 0) : 0;   // what your kit added on top of the ring
  if (has('coach') && a.s.v < 8) G.coachNext = true;
  if (!G.practice) G.roundVals.push(a.s.v);
  // Keep Shooting: a black or white scores as usual and hands the arrow back (once an end)
  if (G.convOps && G.convOps.junkFree && !G.shootoff && !a.s.miss && ['black', 'white'].includes(ringColor(a.s.v)) && G.endArrows.filter(e => e.free).length < G.convOps.junkFree) a.free = true;
  SFX.thunk(G.R.dist / 343); shake = 0.12; burst(a.x, a.y, '#dcb97e', 6, 20);
  const hide = has('nolook') && !G.practice;
  if (a.s.miss) { pop('MISS', a.x, a.y - 8, C.red); SFX.bad(); }
  else {
    pop(hide ? '?' : a.s.label, a.x, a.y - 8, a.s.x && !hide ? C.gold : C.text, a.s.x && !hide ? 2 : 1);
    if (a.plus > 0 && !hide) pop('+' + a.plus, a.x + hw(a.s.label) / 2 + 6, a.y - 3, C.green, 1, 1.1, -10);   // the ring, then your bonus
    if (a.free && !hide) pop('FREE ARROW', a.x, a.y + 6, C.green, 1, 1.1);
    if (a.routine && !hide) pop('ROUTINE +' + a.routine, a.x, a.y - 18, C.green, 1, 1.1);   // your loose beat your height
    if (a.s.x) { SFX.x(); burst(a.x, a.y, C.gold, 14, 45); if (!G.practice) G.xCount += a.s.xx ? 2 : 1; if (G.R.crowd) SFX.cheer(); }
  }
  setState('land');
  if (callIt) {
    tone(2600, 0.25, 'square', 0.03); tone(2500, 0.2, 'square', 0.03, null, 0.28);   // the whistle
    pop('CALLED OUT', a.x, a.y - 18, C.orange, 1, 1.4);
    if (G.called === 1 || rand() < 0.3) oppSay('call', () => {});
  }
}

// ---------- tally: real end totals, archery moments ----------
function groupOf(arr) {
  const ok = arr.filter(a => !a.s.miss); if (ok.length < 2) return null;
  const cx = ok.reduce((s, a) => s + a.x, 0) / ok.length, cy = ok.reduce((s, a) => s + a.y, 0) / ok.length;
  return { cx, cy, r: Math.max(...ok.map(a => Math.hypot(a.x - cx, a.y - cy))) };
}
const arrowsUsed = () => G.endArrows.filter(a => !a.free).length;   // Keep Shooting's free arrow doesn't count
function startTally() {
  const arr = G.endArrows, steps = [];
  if (G.convOps && G.convOps.echo) {   // Shake It Off: a black or white takes the next arrow's own score (never lowers it, never chains)
    const own = arr.map(a => a.val);
    arr.forEach((a, i) => { const c = ringColor(a.s.v); if (i + 1 < arr.length && !a.s.miss && (c === 'black' || c === 'white') && own[i + 1] > a.val) { a.val = own[i + 1]; a.echo = true; } });
  }
  const drop = G.convOps && G.convOps.extraArrows && arr.length > 3 ? arr.reduce((w, a, i) => a.val < arr[w].val ? i : w, 0) : -1;   // Extra Arrow: the worst one doesn't count
  arr.forEach((a, i) => { if (i !== drop) steps.push({ k: 'arrow', i }); });
  if (arr.every(a => a.s.x)) steps.push({ k: 'big', l: 'XXX!!!' });
  else if (arr.every(a => a.s.v === 10)) steps.push({ k: 'big', l: 'PERFECT 30!' });
  if (G.convOps && G.convOps.deep) {
    const blues = arr.filter((a, i) => i !== drop && !a.s.miss && ringColor(a.s.v) === 'blue'), add = blues.reduce((t, a) => t + Math.min((blues.length - 1) * G.convOps.deep, 10 - a.val), 0);
    if (add > 0) steps.push({ k: 'big', l: blues.length + ' BLUES +' + add, add });
  }
  G.tally = { steps, i: 0, t: -0.25, total: 0, xs: 0, phase: 'steps', hi: -1, fast: false, ct: 0, grp: groupOf(arr) };
  setState('tally');
}
function applyStep(s, n) {
  const tl = G.tally, hide = has('nolook');
  if (s.k === 'arrow') {
    const a = G.endArrows[s.i]; tl.hi = s.i; tl.total = Math.min(30, tl.total + a.val); tl.xs += a.s.xx ? 2 : a.s.x ? 1 : 0;
    if (a.s.lc && !a.s.miss) { pop('LINE! JUDGE: IN', a.x, a.y - 16, C.gold); SFX.mult(n + 4); }
    pop(hide ? '?' : (a.s.miss ? 'M' : '+' + a.val), a.x, a.y - 8, a.s.x ? C.gold : C.text); SFX.tick(a.val);
    if (a.echo && !hide) pop('NEXT ARROW', a.x, a.y - 16, C.green, 1, 1.1);
  } else { tl.total = Math.min(30, tl.total + (s.add || 0)); pop(s.l, 120, 44, C.gold, 2, 1.4, -8); SFX.fanfare(); burst(120, 50, C.gold, 30, 70); shake = 0.15; }
}
function tallyUpdate(dt, a) {
  const tl = G.tally; if (a) tl.fast = true;
  tl.t += dt * (tl.fast ? 3.5 : 1);
  if (tl.phase === 'steps') {
    if (tl.t >= 0.32) { tl.t = 0; if (tl.i < tl.steps.length) { applyStep(tl.steps[tl.i], tl.i); tl.i++; }
      else { tl.phase = 'slam'; tl.hi = -1; SFX.slam(); shake = 0.15; } }
  } else if (tl.phase === 'slam') {
    if (tl.t >= 0.9) { tl.phase = 'count'; tl.t = 0; tl.start = G.roundScore; }
  } else if (tl.phase === 'count') {
    const k = Math.min(1, tl.t / 0.5); G.disp = Math.round(tl.start + tl.total * k);
    tl.ct -= dt; if (tl.ct <= 0 && k < 1) { SFX.count(); tl.ct = 0.04; }
    if (k >= 1) { G.roundScore = tl.start + tl.total; G.disp = G.roundScore; tl.phase = 'done'; tl.t = 0; }
  } else if (tl.phase === 'done' && tl.t > 0.35) finishEnd();
}
function finishEnd() {
  const tl = G.tally; G.bestEnd = Math.max(G.bestEnd, tl.total); G.myEnd = tl.total; G.myXs = tl.xs; G.myRaw = endSum(G.endArrows); G.tally = null;
  const go = () => G.match ? startOppTurn() : nextEnd();
  if (G.bet) settleBet(go); else go();
}

// ---------- side bets ----------
// At the start of an end your bale mate may bet a piece of their gear against one of yours (a set point if
// you have nothing they want). Take it (A) or pass (B). It's settled on your arrows before they shoot.
const itemName = k => !k ? '' : typeof k === 'string' ? (RITUALS[k] || M_RITUALS.find(r => r.id === k) || {}).name : offerName(k);
const gearPhrase = k => k ? 'your ' + itemName(k) : 'a set point';
function maybeOfferBet() {
  const o = G.opp;
  G.betBy = G.betBy || {};
  if (!G.match || G.practice || G.shootoff || G.end < 1 || !(G.betsLeft > 0) || G.betBy[o.icon]) return false;
  if (rand() >= (BET_RATE[o.icon] || BET_RATE._)) return false;
  // they stake a piece of kit you could buy; you stake one you own (it drops a tier), or a set point
  if (meters() && !ownedItems().length) return false;   // nothing to stake yet: no bets until you've got some kit
  const wants = allOffers(G.build, G.rituals); if (!wants.length) return false;
  const b = BETS[randInt(0, BETS.length - 1)], need = b.need(G.round);
  const mine = ownedItems(), yours = mine.length ? mine[randInt(0, mine.length - 1)] : null;
  // Worth the risk: their stake is never rarer-is-worse than yours, and fits your build when anything does
  // (an upgrade to a piece you own, or a bonus on a colour you already play).
  const rank = f => ({ common: 0, uncommon: 1, rare: 2 })[(offerRit(f) || slotType(offerSlot(f), f.t)).rar] || 0;
  const plus = runFx(G.build, G.rituals).colorPlus;
  const fits = f => { if (f.slot) return !!G.build[f.slot]; const np = runFx(G.build, G.rituals.concat(f.rit)).colorPlus; return Object.keys(plus).some(c => plus[c] && np[c] > plus[c]); };
  let pool = yours ? wants.filter(f => rank(f) >= rank(yours)) : wants;
  if (o.icon === 'chad') { const g = pool.filter(f => f.slot && !offerSlot(f).form); if (g.length) pool = g; }   // Chad bets gear
  if (!pool.length) return false;
  const good = pool.filter(fits), from = good.length ? good : pool, theirs = from[randInt(0, from.length - 1)];
  G.betsLeft--; G.betBy[o.icon] = true;
  G.offerBet = { id: b.id, need, theirs, yours }; G.betSel = 0;
  const L = BET_TALK[o.icon] || BET_TALK.dale;
  SFX.bet();
  say(o.icon, o.name, L.offer(b.say(need), itemName(theirs), gearPhrase(yours)), () => setState('bet'), 'happy');
  return true;
}
const betDef = id => BETS.find(b => b.id === id);
function answerBet(take) {
  const o = G.opp, L = BET_TALK[o.icon] || BET_TALK.dale, ob = G.offerBet; G.offerBet = null;
  if (take) { G.bet = ob; SFX.anchor(); } else SFX.sel();
  setState('aim');
  say(o.icon, o.name, [pickLine(take ? L.take : L.pass)], () => pop(endLabel(), 120, 22, C.text, 1, 1.4, 0), take ? 'happy' : 'neutral');
}
function settleBet(then) {
  const o = G.opp, L = BET_TALK[o.icon] || BET_TALK.dale, b = G.bet; G.bet = null;
  const won = betDef(b.id).ok(G.endArrows, b.need);
  if (won) {
    takeOffer(b.theirs);
    unlock('viktor'); SFX.betWon(); burst(212, 30, C.gold, 20, 50); pop('WON ' + itemName(b.theirs), 120, 40, C.gold, 1, 2, -6);
  } else {
    if (b.yours) loseItem(b.yours); else G.sets[1] += 1;
    SFX.betLost(); shake = 0.2; pop(b.yours ? 'LOST ' + itemName(b.yours) : 'SET POINT TO ' + o.name, 120, 40, C.red, 1, 2, -6);
  }
  say(o.icon, o.name, [pickLine(won ? L.paid : b.yours ? L.took : L.tookPt)], then, won ? (GOOD_SPORT.has(o.icon) ? 'happy' : 'disappointed') : 'victory');
}
const endLabel = () => 'END ' + (G.end + 1) + (G.match || G.free ? '' : ' OF 3');
function noteAvg() { const v = G.roundVals; G.lastAvg = G.thisAvg; G.thisAvg = v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0; }
function endPractice() {
  G.trail = null;
  G.practice = false; G.endArrows = []; G.arrow = 0; G.end = 0; G.letdowns = 0; G.luckyUsed = false;
  setState('aim'); pop(endLabel(), 120, 22, C.text, 1, 1.4, 0);
}
function nextEnd() {
  G.end++; G.endArrows = []; G.arrow = 0; G.luckyUsed = false; G.letdowns = 0;
  if (!G.free && !G.match && G.end >= 3) {
    G.total += G.roundScore; G.pass = G.roundScore >= G.target; noteAvg();
    if (G.pass) { SFX.fanfare(); burst(120, 60, C.gold, 30, 70); setState('roundEnd'); }
    else { SFX.fail(); saveBest(); setState('over'); }
    return;
  }
  if (G.R.wind && !G.R.gusty) G.windTarget = clamp(G.windTarget + randInt(-1, 1), G.R.wind[0], G.R.wind[1]);
  setState('aim'); if (!maybeOfferBet()) pop(endLabel(), 120, 22, C.text, 1, 1.4, 0);
}

// ---------- bale mate ----------
function oppArrows(n) {
  const o = G.opp, R = T.ringR;
  if (o.fixed) {                                   // Brenda: always the same ring. Always.
    const k = 10 - o.fixed;
    return Array.from({ length: n }, () => { const d = k * R + 0.9 + rand() * (R - 1.2), t = rand() * 6.283; const a = { x: TX + Math.cos(t) * d, y: TY + Math.sin(t) * d }; a.s = scoreArrow(a); return a; });
  }
  // rattled: his group opens way up. Bale mates shoot in the same wind and don't read it perfectly either.
  const sd = Math.hypot(o.sd * (o.tiltLeft > 0 ? 2.2 : 1) * (o.locked ? 0.7 : 1), Math.abs(G.windNow || 0) * 1.6 * G.R.distK * (o.target ? windRead(o.target) : 1));
  const gx = gauss() * sd * RIVAL_DRIFT, gy = gauss() * sd * RIVAL_DRIFT;   // that end's group drift
  return Array.from({ length: n }, () => { const f = o.flier && rand() < o.flier ? 2.5 : 1; const a = { x: TX + gx + gauss() * sd * f, y: TY + gy + gauss() * sd * f }; a.s = scoreArrow(a); return a; });
}
// No freak ends: a rival never shoots more than RIVAL_HOT over their usual end (re-shot quietly if they would).
const RIVAL_HOT = 5;
// Rivals track their target: each end they aim to make up for how far their match average has strayed from it
// (RIVAL_PULL of the gap per end), so a hot start cools off and a cold one comes back. Shoot-offs aren't steered.
const RIVAL_PULL = 1.0;
function steerRival(o, n) {
  if (!o.target || o.fixed || n !== 3) return;
  const err = o.n ? o.sum / o.n - o.target : 0;
  o.sd = sdForAvg(clamp(o.target - RIVAL_PULL * err, 1.5, 9.8), G.R, o.flier || 0);
}
function rivalEnd(n) {
  steerRival(G.opp, n);
  const o = G.opp, cap = o.target && !o.fixed && n === 3 ? Math.min(30, Math.round(o.target * 3 + RIVAL_HOT)) : 10 * n;   // shoot-offs stay wild
  let a = oppArrows(n);
  for (let k = 0; k < 8 && a.reduce((s, x) => s + x.s.v, 0) > cap; k++) a = oppArrows(n);
  return a;
}
function startOppTurn() {
  const o = G.opp; o.arrows = rivalEnd(G.shootoff ? 1 : 3); o.shown = 0; o.t = -0.3; o.fast = false; o.phase = 'shoot'; o.tiltNews = false; o.lockNews = false;
  o.total = o.arrows.reduce((s, a) => s + a.s.v, 0); o.xs = o.arrows.filter(a => a.s.x).length;
  if (!G.shootoff) { o.sum = (o.sum || 0) + o.total; o.n = (o.n || 0) + o.arrows.length; }   // their running average this match
  setState('opp');
}
function resolveSet() {
  const o = G.opp;
  if (G.shootoff) {
    const me = G.endArrows[0]; o.dm = Math.hypot(me.x - TX, me.y - TY); o.dop = Math.hypot(o.arrows[0].x - TX, o.arrows[0].y - TY);
    o.res = o.dm <= o.dop ? 'win' : 'lose';
  } else {
    o.res = G.myEnd > o.total ? 'win' : G.myEnd < o.total ? 'lose' : 'tie';
    o.onX = o.res === 'tie' && (G.myXs || 0) !== o.xs;   // a tied end goes to whoever has more Xs; level on Xs too, split it
    if (o.onX) o.res = G.myXs > o.xs ? 'win' : 'lose';
    G.sets[0] += o.res === 'win' ? 2 : o.res === 'tie' ? 1 : 0;
    G.sets[1] += o.res === 'lose' ? 2 : o.res === 'tie' ? 1 : 0;
    // You put him on tilt by winning an end big. It lasts his next two ends.
    if (o.tiltLeft > 0) o.tiltLeft--;
    if (o.tilt && o.res === 'win' && (G.myEnd >= 28 || G.myEnd - o.total >= 4)) { o.tiltLeft = 2; o.tiltNews = true; }
    // Margaret is the opposite: beat her on an end and she locks in for the next one.
    if (o.lockin) { const was = o.locked; o.locked = o.res === 'win'; o.lockNews = o.locked && !was; }
  }
  if (o.res === 'win') { SFX.anchor(); } else if (o.res === 'lose') SFX.bad(); else SFX.sel();
}
function afterSet() {
  const o = G.opp, over = G.shootoff || G.sets[0] >= 6 || G.sets[1] >= 6;
  if (!over && o.tiltNews) { oppSay('tilt', decideNext); return; }
  if (!over && o.lockNews) { oppSay('lock', decideNext); return; }
  if (!over && rand() < 0.45) { oppSay(o.res === 'lose' ? 'oppWin' : o.res === 'win' ? 'oppLose' : 'oppWin', decideNext); return; }
  decideNext();
}
function decideNext() {
  const o = G.opp;
  if (G.shootoff) { o.res === 'win' ? matchWon() : matchLost(); return; }
  if (G.sets[0] >= 6) matchWon();
  else if (G.sets[1] >= 6) matchLost();
  else if (G.sets[0] === 5 && G.sets[1] === 5) { G.shootoff = true; G.end++; G.endArrows = []; G.arrow = 0; G.luckyUsed = false; G.letdowns = 0; SFX.xmult(); setState('soIntro'); }
  else nextEnd();
}
function oppUpdate(dt, a) {
  const o = G.opp; if (a) o.fast = true; o.t += dt * (o.fast ? 3.5 : 1);   // one tap of A hurries the rest of their turn
  if (o.phase === 'shoot') {
    if (o.t >= 0.5) { o.t = 0;
      if (o.shown < o.arrows.length) { const ar = o.arrows[o.shown++]; SFX.thunk(); if (ar.s.x) SFX.x(); }
      else { o.phase = 'score'; if (!G.shootoff) SFX.slam(); } }
  } else if (o.phase === 'score') { if (o.t >= 0.9) { o.t = 0; o.phase = 'result'; resolveSet(); } }
  else if (o.phase === 'result' && o.t >= 1.8) afterSet();
}
function matchWon() { unlock('hank'); noteAvg(); G.total += G.roundScore; G.pass = true; SFX.fanfare(); burst(120, 60, C.gold, 30, 70); oppSay('youWin', () => setState('roundEnd')); }
function matchLost() { if (G.opp.icon === 'dale') unlock('judy'); noteAvg(); G.total += G.roundScore; G.pass = false; SFX.fail(); saveBest(); oppSay('youLose', () => setState('over')); }
// ---------- dialogue (Advance Wars-style) ----------
let DLG = null;
const pickLine = a => a[randInt(0, a.length - 1)];
function say(who, name, lines, then, mood) {
  const pages = []; lines.forEach(l => { const w = vwrap(l, 154); for (let k = 0; k < w.length; k += 2) pages.push(w.slice(k, k + 2)); });
  DLG = { who, name, pages, i: 0, chars: 0, then, blip: 0, mood: mood || 'neutral' };
}
function dlgUpdate(dt, a) {
  const d = DLG, len = d.pages[d.i].join(' ').length;
  if (d.chars < len) { d.chars += dt * 45; d.blip -= dt; if (d.blip <= 0) { tone((VOICE[d.who] || 400) * (0.9 + rand() * 0.25), 0.04, 'square', 0.02); d.blip = 0.075; } }
  if (!a) return;
  if (d.chars < len) { d.chars = len; return; }
  d.i++; d.chars = 0; SFX.move();
  if (d.i >= d.pages.length) { const t = d.then; DLG = null; if (t) t(); }
}
function drawDialog() {
  const d = DLG, page = d.pages[d.i]; if (!page) return;
  box(0, 113, W, 47, '#f8ecd4', '#c8a070');
  const im = face(d.who, d.mood); if (im && im.complete) ctx.drawImage(im, 4, 96);
  const nw = vw(d.name) + 12; box(72, 104, nw, 14, '#a83a4a', '#e88a7a'); vtext(d.name, 78, 106, '#fff4e0', '#3a1020');
  let n = Math.floor(d.chars);
  page.forEach((ln, k) => { vtext(ln.slice(0, Math.max(0, n)), 78, 122 + k * 12, '#3a2418'); n -= ln.length + 1; });
  if (d.chars >= page.join(' ').length && Math.floor(time * 3) % 2) { fr(226, 148, 5, 1, '#a83a4a'); fr(227, 149, 3, 1, '#a83a4a'); fr(228, 150, 1, 1, '#a83a4a'); }
}
const teaching = () => G && G.match && G.round === 0 && G.season === 1 && G.opp.icon === 'brenda' && !SEEN.tutorial && G.practice;
const oppSay = (key, then) => { const o = G.opp, L = TALK[o.icon] && TALK[o.icon][key]; if (L) say(o.icon, o.name, key === 'intro' ? L : [pickLine(L)], then, moodFor(key, o.icon)); else then(); };
function saveBest() { if (G.total > best) { best = G.total; store && store.setItem('linecutter_best', best); } }

// ---------- update ----------
function toggleMusic() {
  MUSIC.muted = !MUSIC.muted; try { localStorage.setItem('linecutter_music', MUSIC.muted ? 'off' : 'on'); } catch (e) {}
  if (!PAUSE && !(S === 'title' && TMENU && TMENU.open)) pop(MUSIC.muted ? 'MUSIC OFF' : 'MUSIC ON', 120, 22, C.dim, 1, 1.2, 0);   // the pause menu shows it itself
}

// ---------- pause ----------
// Start pauses a run (on the title, game-over and win screens it still means "go").
// Embedders call game.pause() when the player looks away; Start (or B) resumes.
let PAUSE = null;
const canPause = () => !!G && !['title', 'over', 'win', 'pset', 'mgear', 'mshop', 'rivals'].includes(S);
function pause(sound = false) {
  if (PAUSE || !canPause()) return false;
  PAUSE = { sel: 0, t: 0 }; if (sound) SFX.sel();
  render(); if (opts.onFrame) opts.onFrame(cv);   // show it now, even if the host has stopped ticking
  return true;
}
function resume() { if (!PAUSE) return; PAUSE = null; SFX.sel(); }
function quitRun() {
  PAUSE = null; settle(); SFX.sel();
  if (S === 'over') return;   // that last arrow lost the match: show it, don't hide it behind the title
  saveRun();
  fadeTo(() => { G = null; DLG = null; BG = TITLE_BG; pops.length = 0; parts.length = 0; setState('title'); openTitle(true); }, true, 0.5);
}
// Free practice: no save, and a way back to the range picker.
const pauseItems = () => G && G.free ? ['resume', 'music', 'setup', 'quit'] : meters() ? ['resume', 'kit', 'music', 'quit'] : ['resume', 'music', 'quit'];
function pauseUpdate(dt, P) {
  PAUSE.t += dt;
  if (PAUSE.kit) {   // the kit screen: browse what you own, B or START goes back to the menu
    const n = Math.max(1, ownedItems().length);
    if (P.has('up') || P.has('down')) { PAUSE.kit.sel = (PAUSE.kit.sel + (P.has('up') ? n - 1 : 1)) % n; SFX.move(); }
    if (P.has('b') || P.has('start') || P.has('a')) { PAUSE.kit = null; SFX.sel(); }
    return;
  }
  if (P.has('start') || P.has('b')) { resume(); return; }
  const items = pauseItems(), n = items.length;
  if (P.has('up') || P.has('down')) { PAUSE.sel = (PAUSE.sel + (P.has('up') ? n - 1 : 1)) % n; SFX.move(); }
  if (!P.has('a')) return;
  const it = items[PAUSE.sel];
  if (it === 'resume') resume();
  else if (it === 'music') { toggleMusic(); SFX.sel(); }
  else if (it === 'kit') { PAUSE.kit = { sel: 0 }; SFX.sel(); }
  else if (it === 'setup') { PAUSE = null; SFX.sel(); fadeTo(() => { G = null; DLG = null; BG = TITLE_BG; pops.length = 0; parts.length = 0; openPractice(); }, true, 0.5); }
  else quitRun();
}

function update(dt) {
  const P = new Set(Q); Q.length = 0;
  if (P.has('select') && !(S === 'title' && TMENU && !TMENU.open)) toggleMusic();   // PRESS ANY BUTTON: that press only opens the menu
  if (!PAUSE && P.has('start') && canPause()) { pause(true); P.delete('start'); }
  if (PAUSE) { pauseUpdate(dt, P); musicTick(); return; }   // the world holds still: no clock, no heartbeat, no wind
  time += dt; sT += dt;
  const pr = b => P.has(b) || (b === 'a' && P.has('start'));
  musicTick();
  if (shake > 0) shake -= dt; if (flashT > 0) flashT -= dt;
  for (let i = pops.length - 1; i >= 0; i--) { const p = pops[i]; p.age += dt; p.y += p.vy * dt; p.vy *= 0.95; if (p.age > p.life) pops.splice(i, 1); }
  for (let i = parts.length - 1; i >= 0; i--) { const p = parts[i]; p.age += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 80 * dt; if (p.age > p.life) parts.splice(i, 1); }
  if (fadeUpdate(dt)) return;
  if (DLG) { dlgUpdate(dt, pr('a')); return; }
  if (showNews()) { if (!newsT) SFX.betWon(); newsT += dt; if (pr('a') && newsT > 0.8) { NEWS.shift(); saveRiv(); newsT = 0; SFX.sel(); } return; }
  if (G && G.R && ['aim', 'draw', 'hold', 'mv', 'mh', 'flight', 'land', 'tally', 'opp'].includes(S)) heartUpdate(dt);

  switch (S) {
    case 'title': titleUpdate(pr, P); break;
    case 'pset': psetUpdate(pr); break;
    case 'mgear': mgearUpdate(pr); break;
    case 'mshop': mshopUpdate(pr); break;
    case 'rivals': if ((pr('a') || pr('b')) && sT > 0.2) { SFX.sel(); setState('title'); openTitle(true, TMENU.items.indexOf('rivals')); } break;
    case 'shop':
      if (pr('left') || pr('up')) { G.sel = (G.sel + G.offer.length - 1) % G.offer.length; SFX.move(); }
      if (pr('right') || pr('down')) { G.sel = (G.sel + 1) % G.offer.length; SFX.move(); }
      if (pr('a') && sT > 0.25) { if (meters()) takeOffer(G.offer[G.sel]); else G.rituals.push(G.offer[G.sel]); SFX.anchor(); fadeTo(toBracket); }
      break;
    case 'bracket':
      if (sT > 0.9 && sT - dt <= 0.9) SFX.anchor();                    // your marker lands on today's opponent
      if ((pr('a') && sT > 0.4) || sT > 4.5) { if (!FADE) SFX.sel(); fadeTo(() => startRound(G.round), true, 0.7); }
      break;
    case 'intro':
      if ((pr('a') && sT > 0.3) || sT > 2.6) {
        SFX.sel(); setState('aim'); const go = () => pop('PRACTICE END', 120, 22, C.green, 1, 1.6, 0);
        if (teaching()) oppSay('intro', () => oppSay('tutDraw', go)); else if (G.match) oppSay('intro', go); else go();
      }
      break;
    case 'soIntro': if (pr('a') && sT > 0.5) { SFX.sel(); setState('aim'); oppSay('soff', () => {}); } break;
    case 'bet':
      if (pr('up') || pr('down')) { G.betSel = G.betSel ? 0 : 1; SFX.move(); }   // look at what you'd win, or what you'd lose
      if (sT > 0.4) { if (pr('a')) answerBet(true); else if (pr('b')) answerBet(false); }
      break;
    case 'opp': oppUpdate(dt, pr('a')); break;
    case 'aim':
      if (meters()) { if (pr('a')) startMeters(); break; }
      if (pr('up')) { G.crawl = clamp(G.crawl - 1, 0, 9); SFX.move(); }
      if (pr('down')) { G.crawl = clamp(G.crawl + 1, 0, 9); SFX.move(); }
      if (pr('left')) { G.holdoff = clamp(G.holdoff - 1, -8, 8); SFX.move(); }
      if (pr('right')) { G.holdoff = clamp(G.holdoff + 1, -8, 8); SFX.move(); }
      if (pr('a')) {
        // Brenda's practice end: at 18m you have to crawl down before she lets you keep shooting high
        if (!meters() && teaching() && G.practice && G.arrow >= 1 && G.crawl <= G.tutCrawlFrom) { G.tabNudge = true; SFX.bad(); oppSay('tutTab', () => {}); }
        else { G.tabNudge = false; startDraw(); }
      }
      break;
    case 'draw':
      G.drawT += dt; G.p += (has('trad') ? T.tradDrawSpeed : T.drawSpeed) * dt;
      if (has('trad') && G.R.panic) { const pp = pointPos(); G.panicNow = Math.hypot(pp.x - TX, pp.y - TY) < 2 * T.ringR; }
      if (pr('b')) { letDown(); break; }
      if (pr('a')) anchor(G.p); else if (G.p >= T.meterMax) letDown('NO ANCHOR: LET DOWN');
      break;
    case 'hold': {
      G.holdT += dt;
      if (G.clickAt != null && G.holdT >= G.clickAt && G.holdT - dt < G.clickAt) SFX.click();
      const pp = pointPos(); G.panicNow = G.R.panic && Math.hypot(pp.x - TX, pp.y - TY) < 2 * T.ringR;
      if (pr('b')) letDown();
      else if (pr('a')) release();
      else if (G.holdT >= maxHold()) letDown('ARMS GAVE OUT');
      break;
    }
    // Meters: the press lands on the frame you saw, then the bar moves on. Both bars share one hold clock.
    case 'mv': case 'mh':
      G.holdT += dt;
      if (pr('b')) letDown();
      else if (pr('a')) { if (S === 'mv') meterLock(); else meterRelease(); }
      else if (G.holdT >= maxHold()) letDown('ARMS GAVE OUT');
      else {
        const m = S === 'mv' ? G.mv : G.mh;
        if (m.beat !== G.lastBeat) {   // the pulse jolts the bar the way it's already going
          if (m.beat != null) { m.pos += m.dir * METER_KICK * G.strip.surge * G.strip.kick * (0.8 + (G.bpm - 60) * 0.02); if (m.pos > 1) { m.pos = 2 - m.pos; m.dir = -1; } else if (m.pos < -1) { m.pos = -2 - m.pos; m.dir = 1; } }
          m.beat = G.lastBeat;
        }
        if (m.startle !== G.startleT) {   // a flash, a thunk, TOO LONG: you flinch and the bar lurches
          if (m.startle != null && time - G.startleT < 0.2) { m.pos += m.dir * METER_KICK * 5 * (G.startK || 1); if (m.pos > 1) { m.pos = 2 - m.pos; m.dir = -1; } else if (m.pos < -1) { m.pos = -2 - m.pos; m.dir = 1; } }
          m.startle = G.startleT;
        }
        sweep(m, dt, S === 'mh' ? mShift() : 0);
      }
      break;
    case 'flight': if (pr('a')) G.fl.fast = true; G.fl.t += dt * (G.fl.fast ? 3 : 1); if (G.fl.t >= flightTime()) land(); break;   // A hurries it along
    case 'land':
      if (sT > 0.55 || (pr('a') && sT > 0.12)) {
        if (G.shootoff) { G.myEnd = 0; startOppTurn(); }
        else if (arrowsUsed() < 3 + (G.convOps && G.convOps.extraArrows || 0)) { setState('aim'); if (!meters() && teaching() && G.arrow === 1) { G.tutCrawlFrom = G.endArrows[0].crawl; if (G.endArrows[0].y < TY - 2.5) { G.tabNudge = true; oppSay('tutCrawl', () => {}); } else G.tutCrawlFrom = -1; } }
        else if (G.practice) { G.tally = null; G.review = groupOf(G.endArrows); setState('review'); if (teaching()) { seen('tutorial'); oppSay('tutGo', () => {}); } }
        else startTally();
      }
      break;
    case 'review': if ((pr('a') && sT > 0.4) || sT > 4) endPractice(); break;
    case 'tally': tallyUpdate(dt, pr('a')); break;
    case 'roundEnd':
      if (pr('a') && sT > 0.8) {
        if (G.round < ROUNDS.length - 1) { G.round++; fadeTo(() => openShop((G.match ? 'MATCH WON.' : 'MADE THE CUT.') + ' PICK ONE.')); }
        else { saveBest(); unlock('margaret'); SFX.fanfare(); setState('win'); }
      }
      break;
    case 'over': if (pr('a') && sT > 0.8) { SFX.sel(); fadeTo(newGame); } break;
    case 'win':
      if (rand() < 0.3) burst(rand() * W, -4, [C.gold, C.red, C.blue, C.green][randInt(0, 3)], 1, 10);
      if (pr('a') && sT > 1) { if (G.season >= SEASONS) { clearRun(); fadeTo(newGame, true, 0.6); }   // the Open is won: a fresh run
        else fadeTo(() => { G.season++; G.round = 0; G.draw = drawSheet(false); openShop('SEASON ' + G.season + '. PICK ONE.'); }, true, 0.6); }
      break;
  }
}

// ---------- render ----------
// The archer's-eye arrow: you only see the front of it, nearly parallel to your
// line of sight, so it's a soft translucent strip that moves with the bow.
// The very top pixel of the point is the aiming reference. Shape lives in VIEW.
function drawPoint(px, py, s = 1) {
  const V = VIEW, yb = Math.round(py + (133 - py) * s);
  const L = Math.max(2, Math.round(V.pointLen * s)), SW = V.arrowWidth * s;
  const steel = ['#f4f4fa', '#b8b8c4', '#6a6a78'], carbon = ['#6a6a7a', '#34343e', '#1c1c24'];
  const soft = Math.max(1, Math.round(V.edgeSoft * s));
  for (let y = py; y <= yb; y++) {
    const dy = y - py, isPoint = dy < L;
    const w = isPoint ? Math.max(1, (SW - 1) * Math.sqrt((dy + 1) / L)) : SW * (1 + V.arrowTaper * (dy - L) / Math.max(1, yb - py - L));
    const left = Math.round(px - w / 2), right = Math.round(px + w / 2), span = Math.max(1, right - left);
    const pal = isPoint ? steel : carbon, base = isPoint ? V.pointAlpha : V.shaftAlpha;
    for (let x = left; x <= right; x++) {
      const q = (x - left) / span, e = Math.min(x - left, right - x);
      ctx.globalAlpha = e < soft && span > 3 ? base * (e + 1) / (soft + 1) : base;
      ctx.fillStyle = dy === L ? '#8a8a96' : q < 0.22 ? pal[0] : q > 0.72 ? pal[2] : pal[1];
      ctx.fillRect(x, y, 1, 1);
    }
  }
  ctx.globalAlpha = 1;
}
// The string, inches from your eye: a wide, faint blur. It's anchored to your
// face, so it stays put while the bow (and point) floats against it.
function drawString(alpha = 1) {
  const V = VIEW, cx = aimX() + V.stringOffset, hw = V.stringWidth / 2;
  for (let x = Math.floor(cx - hw); x <= Math.ceil(cx + hw); x++) {
    const k = 1 - Math.abs(x - cx) / (hw + 0.5); if (k <= 0) continue;
    ctx.globalAlpha = V.stringAlpha * k * alpha; fr(x, 12, 1, 121, '#ece4d4');
  }
  ctx.globalAlpha = 1;
}
function drawArrows(list) {
  const far = G.R.dist > 30, mid = G.R.dist > 18;   // a 7mm arrow is ~3x smaller against a 122cm face than a 40cm one
  list.forEach((a, i) => {
    if (mid) {
      const x = Math.floor(a.x), y = Math.floor(a.y);
      if (!far) { fr(x - 1, y, 4, 2, '#1a1426'); fr(x, y - 1, 2, 4, '#1a1426'); }
      fr(x, y, 2, 2, NOCKS[i % 3]); if (!far) fr(x, y, 1, 1, '#ffffff');
      if (G.tally && G.tally.hi === i && Math.floor(time * 10) % 2) { fr(x - 3, y - 3, 8, 1, C.text); fr(x - 3, y + 4, 8, 1, C.text); fr(x - 3, y - 3, 1, 8, C.text); fr(x + 4, y - 3, 1, 8, C.text); }
      return;
    }
    const x = Math.floor(a.x) - 1, y = Math.floor(a.y) - 1;   // 18m: 3px nock, end-on, with its fletching around it
    fr(x - 1, y, 5, 3, '#1a1426'); fr(x, y - 1, 3, 5, '#1a1426');
    fr(x - 2, y - 2, 1, 1, '#f2ead8'); fr(x + 4, y - 2, 1, 1, '#f2ead8'); fr(x + 1, y + 4, 1, 1, '#f2ead8');  // vanes
    fr(x, y, 3, 3, NOCKS[i % 3]); fr(x, y, 1, 1, '#ffffff');
    if (G.tally && G.tally.hi === i && Math.floor(time * 10) % 2) { fr(x - 3, y - 3, 9, 1, C.text); fr(x - 3, y + 5, 9, 1, C.text); fr(x - 3, y - 3, 1, 9, C.text); fr(x + 5, y - 3, 1, 9, C.text); }
  });
}
function drawTopBar() {
  fr(0, 0, W, 13, C.ink); fr(0, 13, W, 1, C.edge);
  const R = G.R;
  htext((G.season > 1 ? 'S' + G.season + ' ' : '') + R.name + '  ' + R.dist + 'M', 4, 3, C.dim);
  if (G.free) {
    const v = G.roundVals, s = v.length ? 'AVG ' + (v.reduce((t, x) => t + x, 0) / v.length).toFixed(1) + (G.bestEnd ? '  BEST ' + G.bestEnd : '') : meters() ? ((Object.keys(G.free.build).length + G.rituals.length) ? (Object.keys(G.free.build).length + G.rituals.length) + ' PICKS' : 'NO GEAR') : PRAC_SPREADS[G.free.spread].label + ' SPREAD';
    htext(s, W - hw(s) - 4, 3, C.text);
    return;
  }
  if (G.match) {
    const s = 'YOU ' + G.sets[0] + '-' + G.sets[1] + ' ' + G.opp.name;
    htext(s, W - hw(s) - 4, 3, G.sets[0] > G.sets[1] ? C.green : G.sets[0] < G.sets[1] ? C.red : C.text);
    return;
  }
  const sc = has('nolook') && ['aim', 'draw', 'hold', 'mv', 'mh', 'flight', 'land', 'tally', 'review'].includes(S) ? '???' : String(G.disp);
  const s = sc + ' / ' + G.target;
  htext(s, W - hw(s) - 4, 3, G.disp >= G.target && sc !== '???' ? C.green : C.text);
}
// The HUD floats over the venue: small dark chips behind each readout, one even row along the ground.
const ofr = (x, y, w, h, c) => { fr(x - 1, y - 1, w + 2, h + 2, C.ink); fr(x, y, w, h, c); };
const chip = (x, y, w, h) => rrect(x, y, w, h, 'rgba(16,12,24,0.62)');
function iconO(name, x, y, s = 1) {   // icon with a dark outline so it reads on any background
  const rows = ICONS[name]; if (!rows) return;
  for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) if (rows[j][i] !== '.') fr(x + i * s + dx, y + j * s + dy, s, s, C.ink);
  icon(name, x, y, s);
}
const ROW = 120;   // baseline row of the ground strip: 7px caps from ROW, 8px icons from ROW - 1
function drawLeft() {
  if (meters()) { drawEndChip(); return; }
  // crawl ruler: the string and the tab
  const top = 22, step = 8, rowY = k => top + k * step;
  chip(4, top - 5, 42, 10 * step + 6);
  ofr(15, top - 3, 2, 10 * step + 1, '#e8e0d0');        // string
  ofr(13, top - 2, 6, 2, C.red);                        // nock point
  for (let k = 0; k <= 9; k++) {
    const y = rowY(k), on = k === G.crawl;
    fr(21, y + 3, k % 2 ? 3 : 5, 1, on ? C.gold : k % 2 ? '#8c7cb4' : '#d8d0f0');   // tick on the digit's middle row
    if (on || (k % 2 === 0 && Math.abs(k - G.crawl) > 1)) htext(String(k), 28, y, on ? C.gold : '#d8d0f0');
  }
  const ty = rowY(G.crawl) - 1;                         // tab, centred on the tick (y + 3)
  fr(6, ty - 1, 16, 10, C.ink); fr(7, ty, 14, 8, '#5a3a22'); fr(8, ty + 1, 12, 6, '#c48a52'); fr(8, ty + 4, 12, 1, '#8a5a34');
  if (G.tabNudge && Math.floor(time * 3) % 2) { const y = ty + 11; fr(10, y, 7, 1, C.gold); fr(11, y + 1, 5, 1, C.gold); fr(12, y + 2, 3, 1, C.gold); fr(13, y + 3, 1, 1, C.gold); }   // "press down"
  drawEndChip();
}
// ground strip, left: which end, and the arrows you have left
function drawEndChip() {
  const lbl = G.shootoff ? 'S-OFF' : G.practice ? 'PRAC' : G.free ? 'END ' + (G.end + 1) : 'END ' + Math.min(G.maxEnds, G.end + 1) + (G.match ? '' : '/3');
  const n = G.shootoff ? 1 : 3 + (G.convOps && G.convOps.extraArrows || 0), w = 4 + hw(lbl) + 4 + n * 6 + 2;
  chip(3, ROW - 4, w, 15);
  htext(lbl, 7, ROW, G.shootoff ? C.red : G.practice ? C.green : C.text);
  const used = G.shootoff ? G.arrow : arrowsUsed();
  for (let i = 0; i < n; i++) fr(11 + hw(lbl) + i * 6, ROW, 4, 7, i >= used ? NOCKS[i % 3] : '#3a3050');
}
// the end's group, while the review/tally is showing it
function shownGroup() { return S === 'review' ? G.review : S === 'tally' && G.tally && G.tally.phase !== 'steps' ? G.tally.grp : null; }
function drawRight() {
  // your kit, top right: gear and form first, then rituals (the tournament's meters kit; classic still shows rituals only)
  const kit = meters() && !G.free ? ownedItems().map(offerIcon) : G.rituals.map(ritIcon);
  kit.forEach((ic, i) => { const x = 236 - 17 * (3 - (i % 3)), y = 17 + Math.floor(i / 3) * 17; fr(x - 1, y - 1, 18, 18, C.ink); icon(ic, x, y, 2); });
  if (G.panicNow && Math.floor(time * 8) % 2) hctext('PANIC', 212, Math.max(56, 22 + Math.ceil(kit.length / 3) * 17), C.red, C.ink);
  // boss tells, under the gear: Chad's phone (REC blinks; it goes white as the flash charges), Brenda's foot
  if (bossIs('chad')) {
    const charging = G.cam && G.cam.warned && G.cam.at != null && (S === 'hold' || S === 'mv' || S === 'mh');
    if (charging && Math.floor(time * 16) % 2) { fr(220, 72, 12, 12, C.ink); fr(221, 73, 10, 10, '#ffffff'); }
    else { iconO('phone', 222, 74); if (Math.floor(time * 2) % 2) fr(229, 73, 2, 2, C.red); }
  }
  if (tapping() && G.tapN % 2 === 0) hctext('TAP', 222, 76, C.orange, C.ink);
  if (G.bet) iconO('mug', 222, 88);
  if (G.holdoff) hctext((has('plunger') ? 'SPR ' : 'AIM ') + (G.holdoff < 0 ? '<' : '') + Math.abs(G.holdoff) + (G.holdoff > 0 ? '>' : ''), 212, 100, C.gold, C.ink);
  // ground strip, centre: heart and BPM (the group size takes the slot while you look at your arrows)
  const grp = shownGroup();
  if (grp) {
    const lb = 'GROUP ' + Math.max(1, Math.round(grp.r * 2 * G.R.faceCm / 96)) + 'CM', gw = hw(lb), gx = Math.round(TX - gw / 2);
    chip(gx - 4, ROW - 4, gw + 8, 15); htext(lb, gx, ROW, C.text);
  } else {
    const beat = G.beatFlash > 0, bpm = String(Math.round(G.bpm)), hwid = 9 + 3 + hw(bpm), hx = Math.round(TX - hwid / 2);
    chip(hx - 4, ROW - 4, hwid + 8, 15);
    const jump = beat && !plugged();                       // earplugs: no beat cue at all, only the number
    icon('heart', hx, ROW - (jump ? 2 : 1), 1); if (jump) fr(hx + 1, ROW - 1, 2, 1, '#ffd0d0');   // the heart jumps on each beat
    htext(bpm, hx + 12, ROW, G.bpm > 100 ? C.red : C.text);
  }
  // ground strip, right: a little range flag and the wind reading
  const w = G.windNow || 0, calm = Math.abs(w) < 0.25, warn = G.R.gusty && G.gustT < 1;
  const len = calm ? 0 : Math.round(Math.abs(w) * 5), lead = w < 0 ? len : 0;   // a flag blowing left needs room left of the pole
  const txt = calm ? 'CALM' : (w > 0 ? '' : '<') + Math.abs(w).toFixed(1) + (w > 0 ? '>' : ''), cw = 4 + lead + 2 + 4 + hw(txt) + 4, cx = 237 - cw, px = cx + 4 + lead;
  chip(cx, ROW - 4, cw, 15);
  fr(px, ROW - 3, 2, 12, '#d8d0c0');                    // flag pole
  if (!calm) {
    const dir = w > 0 ? 1 : -1, x0 = dir > 0 ? px + 2 : px - 1;
    for (let i = 0; i < len; i++) { const wy = Math.round(Math.sin(time * (warn ? 22 : 9) + i * 0.6) * (warn ? 1.5 : 0.8)); fr(x0 + i * dir, ROW - 3 + wy, 1, 5, i % 4 < 2 ? C.red : C.white); }
  }
  if (warn && Math.floor(time * 8) % 2) htext('!', cx - 6, ROW, C.orange, C.ink);
  htext(txt, px + 6, ROW, C.text);
  if (chatOn() && G.chat.talking && ['aim', 'draw', 'hold', 'mv', 'mh'].includes(S)) {
    const t = G.chat.line, bw = hw(t) + 6, bx = 236 - bw;
    box(bx, 15, bw, 12, C.white, C.ink); fr(226, 27, 3, 2, C.white); htext(t, bx + 3, 17, C.ink);
  }
}
// ECG waveform: px offset from baseline (negative = up), dt = s from the beat.
function ecg(dt) {
  if (dt > -0.2 && dt < -0.1) return -Math.sin((dt + 0.2) / 0.1 * Math.PI);              // P
  if (dt >= -0.03 && dt < 0) return (dt + 0.03) / 0.03 * 1.5;                            // Q
  if (dt >= 0 && dt < 0.025) return 1.5 - dt / 0.025 * 7;                                // R
  if (dt >= 0.025 && dt < 0.05) return -5.5 + (dt - 0.025) / 0.025 * 8;                  // S
  if (dt >= 0.05 && dt < 0.07) return 2.5 - (dt - 0.05) / 0.02 * 2.5;
  if (dt > 0.16 && dt < 0.32) return -1.5 * Math.sin((dt - 0.16) / 0.16 * Math.PI);     // T
  return 0;
}
const TRAIL_COL = { crawl: '#c88aff', draw: '#f4cf4a', wind: '#6ae8f2', pluck: '#ff4a4a', form: '#d8d0e8' };
// Draw the last shot as a chain of segments: aim -> crawl -> draw -> wind -> pluck -> form -> arrow.
function drawTrail() {
  const tr = G.trail; if (!tr) return;
  let x = tr.base.x, y = tr.base.y;
  fr(x - 1, y, 3, 1, '#ffffff'); fr(x, y - 1, 1, 3, '#ffffff');
  tr.parts.forEach(q => {
    if (Math.hypot(q.dx, q.dy) < 0.6) { x += q.dx; y += q.dy; return; }
    const off = Math.abs(q.dx) < 0.5 ? (q.k === 'crawl' ? -2 : 2) : 0;   // vertical causes sit side by side
    line(x + off + 1, y + 1, x + off + q.dx + 1, y + q.dy + 1, '#16121f');
    line(x + off, y, x + off + q.dx, y + q.dy, TRAIL_COL[q.k]);
    x += q.dx; y += q.dy;
  });
}
function btnA(x, y) {
  if (Math.floor(time * 3) % 2) return;
  for (let j = -5; j <= 5; j++) for (let i = -5; i <= 5; i++) { const d = i * i + j * j; if (d <= 30) fr(x + i, y + j, 1, 1, d > 19 ? '#3a0a14' : '#d84a5a'); }
  htext('A', x - 2, y - 3, '#fff4e0');
}
// Meters: the height gauge stands left of the target, the loose gauge runs along the bottom panel.
const VG = { x: 22, y: 16, w: 9, h: 96 }, HG = { x: 56, y: 137, w: 128, h: 8 };
const flashBlind = () => !!G && G.blindUntil > time && (S === 'mv' || S === 'mh');   // Chad's flash: the gauges burn white a beat past the flash
function gaugeCol(p, shift, st) { return !st && flashBlind() ? GAUGE_WHITE : !st && has('instinct') && (S === 'mv' || S === 'mh') ? '#3a3448' : ZONE_COL[mZone(p - shift, st).k]; }
const ptrCol = c => c === C.black ? '#5c5868' : c === '#16121f' ? '#3a3448' : c;   // black on the ink outline needs a lift
function drawGauges() {
  const v = VG, hg = HG, shift = mShift();
  // left: height. Top of the gauge is high on the face.
  const beat = G.beatFlash > 0 && !plugged(), hot = beat ? '#ff3a3a' : '#ffffff';
  fr(v.x - 2, v.y - 2, v.w + 4, v.h + 4, beat && S === 'mv' ? '#ff3a3a' : C.ink);
  fr(v.x - 1, v.y - 1, v.w + 2, v.h + 2, S === 'mv' ? (beat ? '#ff3a3a' : C.gold) : C.edge);
  gaugeRun(v.h, (i, c) => fr(v.x, v.y + i, v.w, 1, c), i => gaugeCol((i + 0.5) / v.h * 2 - 1, 0));
  const vp = S === 'mv' ? G.mv.pos : G.mLock;
  if (vp != null) { const y = Math.round(v.y + (vp + 1) / 2 * v.h), col = ptrCol(gaugeCol(vp, 0));   // the pointer wears the colour it's over
    fr(v.x - 4, y - 2, v.w + 8, 4, C.ink); fr(v.x - 3, y - 1, v.w + 6, 2, col);   // a fat line across the gauge
    pointer(v.x + v.w + 4, y, 'left', col); }                                       // and an arrowhead pointing in
  // bottom: the loose. Wind slides its zones. It stays dark until your height is locked, then shows the truth: the
  // loose can't beat your height (plus a ring per Shot Routine level), so anything past that wears the colour it'll score.
  fr(hg.x - 2, hg.y - 2, hg.w + 4, hg.h + 4, beat && S === 'mh' ? '#ff3a3a' : C.ink); fr(hg.x - 1, hg.y - 1, hg.w + 2, hg.h + 2, S === 'mh' ? (beat ? '#ff3a3a' : C.gold) : C.edge);
  const hz = G.mLock != null ? mZone(G.mLock).k : null, cap = hz != null ? looseCap(hz, G.lift) : 99;
  const looseCol = p => { const c = gaugeCol(p, shift), v = ringVal(mZone(p - shift).k); return flashBlind() ? c : v > cap ? ZONE_COL[capRing(cap)] : c; };   // shows what it'll score
  // Shot Routine: the rings past your height that it lets you score get a green edge, so you can see the card working
  const ringOf = v => Math.min(10, Math.floor(v));
  const lifted = p => !flashBlind() && G.lift > 0 && hz != null && Math.min(ringOf(ringVal(mZone(p - shift).k)), ringOf(cap)) > ringOf(ringVal(hz));
  if (S === 'mh') {
    gaugeRun(hg.w, (i, c) => fr(hg.x + i, hg.y, 1, hg.h, c), i => looseCol((i + 0.5) / hg.w * 2 - 1));
    for (let i = 0; i < hg.w; i++) if (lifted((i + 0.5) / hg.w * 2 - 1)) { fr(hg.x + i, hg.y, 1, 1, C.green); fr(hg.x + i, hg.y + hg.h - 1, 1, 1, C.green); }
  } else fr(hg.x, hg.y, hg.w, hg.h, '#0c0a12');
  if (S === 'mh') { const x = Math.round(hg.x + (G.mh.pos + 1) / 2 * hg.w), col = ptrCol(looseCol(G.mh.pos));
    fr(x - 2, hg.y - 4, 4, hg.h + 8, C.ink); fr(x - 1, hg.y - 3, 2, hg.h + 6, col);
    pointer(x, hg.y - 4, 'down', col); }
}
// A chunky arrowhead (ink-outlined) whose tip sits at x,y, pointing 'left' or 'down'.
function pointer(x, y, dir, col) {
  for (let i = 0; i < 6; i++) {          // i = distance back from the tip; the head widens as it goes
    const h = Math.min(i, 4);
    if (dir === 'left') { fr(x + i, y - h - 1, 1, 2 * h + 3, C.ink); if (i < 5) fr(x + i, y - h, 1, 2 * h + 1, col); }
    else { fr(x - h - 1, y - i, 2 * h + 3, 1, C.ink); if (i < 5) fr(x - h, y - i, 2 * h + 1, 1, col); }
  }
}
function drawMeter() {
  fr(0, 133, W, 27, C.ink); fr(0, 133, W, 1, C.edge);
  const bx = 16, bw = 208;
  const aimInfo = () => {
    let info = '';
    if (!G.match && G.end === 2 && !has('nolook') && G.roundScore < G.target) info = 'NEED ' + (G.target - G.roundScore) + ' TO MAKE THE CUT';
    if (G.match && G.sets[1] >= 4) info = 'MATCH POINT: ' + G.opp.name;
    if (G.match && G.sets[0] >= 4 && G.sets[1] < 4) info = 'YOUR MATCH POINT';
    if (G.shootoff) info = 'SHOOT-OFF: CLOSEST WINS';
    if (G.bet) info = 'BET: ' + betDef(G.bet.id).card(G.bet.need);
    else if (tapping()) info = G.opp.name + ' IS WAITING ON YOU';
    return info;
  };
  if (S === 'aim' && meters()) {          // the gauges are up before you draw, so you can read the wind
    G.mLock = null; drawGauges(); const info = aimInfo();
    htext(info || 'A: DRAW', 6, 151, G.bet ? C.gold : tapping() ? C.orange : info ? C.text : C.dim);
  } else if (S === 'aim' || S === 'intro') {
    const info = aimInfo();
    htext(info, 6, 143, G.bet ? C.gold : tapping() ? C.orange : C.dim);
  } else if (S === 'draw' || (S === 'flight' && !G.tally)) {
    const p = S === 'draw' ? G.p : 1, top = 137, bh = 11;
    fr(bx - 1, top - 1, bw + 2, bh + 2, C.edge); fr(bx, top, bw, bh, '#0c0a12');
    fr(bx, top, Math.round(bw * Math.min(T.meterMax, p) / T.meterMax), bh, '#5a4a7a');
    const zx = bx + Math.round(bw * (T.anchor - anchorHalf()) / T.meterMax), zw = Math.max(3, Math.round(bw * 2 * anchorHalf() / T.meterMax));
    fr(zx, top, zw, bh, C.gold);
    fr(bx + Math.round(bw * T.anchor / T.meterMax), top - 2, 1, bh + 4, C.text);
    if (S === 'draw') { const nx = bx + Math.round(bw * Math.min(T.meterMax, p) / T.meterMax); fr(nx - 2, top - 3, 5, bh + 6, C.ink); fr(nx - 1, top - 3, 3, bh + 6, '#ffffff'); }
    if (!SEEN.anchor && S === 'draw') btnA(zx + zw / 2, 154);
  } else if (S === 'hold') {
    const steady = steadyTime();
    const mh = maxHold(), k = 1 - G.holdT / mh;
    fr(bx, 136, bw, 3, '#0c0a12');
    fr(bx, 136, Math.round(bw * k), 3, G.holdT < steady ? C.green : G.holdT < steady + 1.5 ? C.orange : C.red);
    if (G.clickAt != null) {   // the clicker window: the bar burns down into it
      const x1 = bx + bw * (1 - G.clickAt / mh), x0 = bx + bw * (1 - (G.clickAt + CLICK_WIN) / mh), on = clickState() === 'on';
      fr(x0, 134, Math.max(2, Math.round(x1 - x0)), 1, on ? '#ffffff' : C.gold); fr(x1, 133, 1, 7, on ? '#ffffff' : C.gold);
    }
    if (plugged()) {           // earplugs: no monitor, no beat. Watch the point.
      fr(bx, 141, bw, 18, '#0c0a12'); hctext('EARPLUGS IN', 120, 146, '#4a3e6e');
      return;
    }
    // ER-style monitor. NOW is the centre line: trace on the left is what just
    // happened, the dim trace on the right is the beats coming. Spikes kick the bow.
    const cx0 = 120, pxs = 50, ly = 152, ival = 60 / G.bpm, since = time - G.lastBeat;
    fr(bx, 141, bw, 18, '#06120a');
    for (let x = bx; x < bx + bw; x += 6) fr(x, ly, 1, 1, '#0e2a16');
    let prev = null;
    for (let x = bx; x < bx + bw; x++) {
      let d = ((x - cx0) / pxs + since) % ival; if (d < 0) d += ival; if (d > ival / 2) d -= ival;   // time from nearest beat
      const y = Math.round(ly + ecg(d) * 1.5), danger = d > -T.pluckPre && d < T.pluckPost, past = x <= cx0;
      const col = danger ? (past ? '#ff5a5a' : '#8a2a30') : (past ? '#6aff8a' : '#2a7040');
      if (prev !== null) { line(x - 1, prev, x, y, col); line(x - 1, prev + 1, x, y + 1, col); } prev = y;   // 2px trace
    }
    fr(cx0, 140, 1, 20, '#ffffff'); fr(cx0 - 2, 140, 5, 1, '#ffffff'); fr(cx0 - 2, 159, 5, 1, '#ffffff');
    if (!SEEN.loose && !inPluck()) btnA(cx0, 128);
  } else if (S === 'mv' || S === 'mh') {
    drawGauges();
    const k = 1 - G.holdT / maxHold();
    fr(bx, 148, Math.round(bw * k), 1, G.holdT < steadyTime() ? C.green : G.holdT < steadyTime() + 1.5 ? C.orange : C.red);
    htext(S === 'mv' ? '1  HEIGHT' : '2  LOOSE', 6, 151, S === 'mv' ? '#ffffff' : C.gold);
    const hint = S === 'mv' ? 'A: LOCK   B: LET DOWN' : 'A: LOOSE   B: LET DOWN';
    htext(hint, 234 - hw(hint), 151, C.dim);
  } else if (S === 'tally' && G.tally) {
    const tl = G.tally, hide = has('nolook');
    G.endArrows.forEach((a, i) => {
      const si = tl.steps.findIndex(s => s.k === 'arrow' && s.i === i), drop = si < 0;   // Extra Arrow's worst one has no step
      const shown = tl.phase !== 'steps' || (drop ? tl.i >= tl.steps.length : tl.i > si), v = a.s.miss ? 'M' : a.s.x ? 'X' : String(a.val);
      box(30 + i * 30, 136, 26, 15, drop ? '#16121f' : a.s.x ? '#5a4a12' : '#241c34', drop ? '#2a2240' : a.s.x ? C.gold : C.edge);
      if (shown) vtext(hide ? '?' : v, 43 + i * 30 - vw(hide ? '?' : v) / 2, 139, drop ? '#4a3e6e' : a.s.x ? C.gold : C.text);
    });
    if (tl.phase !== 'steps') { const t = hide ? '= ?' : '= ' + tl.total + (tl.xs ? '  (' + tl.xs + 'X)' : ''); vtext(t, Math.max(124, 34 + G.endArrows.length * 30), 139, C.gold, C.ink); }
  } else if (S === 'review') {
    htext('PRACTICE DONE', 6, 143, C.green); btnA(226, 146);
  } else if (S === 'land') {
    htext('...', 6, 143, C.dim);
  }
}
function drawShop() {
  if (meters()) { drawOfferShop(G.build, G.rituals, G.offer, G.sel, G.shopHeader, 'A: TAKE IT'); return; }
  fr(0, 0, W, H, '#1c1630');
  for (let j = 0; j < H; j += 4) fr(0, j, W, 1, '#211a38');
  ctext(G.shopHeader, 8, C.gold, 1);
  G.offer.forEach((k, i) => {
    const r = RITUALS[k], sel = i === G.sel; const x = 6 + i * 78, y = sel ? 20 : 24;
    box(x, y, 72, 118, sel ? '#f8ecd4' : '#cfc3ae', sel ? C.gold : '#8a7a9a');
    fr(x + 23, y + 5, 26, 26, '#2e2546'); icon(r.icon, x + 24, y + 6, 3);
    const kind = r.kind === 'gear' ? 'GEAR' : r.kind === 'form' ? 'FORM' : 'RITUAL'; htext(kind, x + 36 - hw(kind) / 2, y + 108, r.kind === 'gear' ? '#2a6aa8' : r.kind === 'form' ? '#3a8a3a' : '#a83a4a');
    let yy = y + 35; vwrap(r.name, 64).forEach(l => { vtext(l, x + 36 - vw(l) / 2, yy, '#2a1a22'); yy += 10; });
    yy += 3; fr(x + 6, yy - 2, 60, 1, '#a89c8a');
    vwrap(r.desc, 64).forEach(l => { if (yy <= y + 96) vtext(l, x + 4, yy, '#5a4a62'); yy += 10; });   // never run into the tag
    if (r.cost) { yy += 2; vwrap(r.cost, 64).forEach(l => { if (yy <= y + 96) vtext(l, x + 4, yy, '#b8322a'); yy += 10; }); }   // the price, in red
  });
  ctext('<  >  CHOOSE     A: TAKE IT', 146, C.dim, 1);
}
function drawIntro() {
  const R = G.R, o = G.opp, k = Math.min(1, sT * 4), e = 1 - Math.pow(1 - k, 3), im = o && face(o.icon);
  fr(0, 0, W, H, 'rgba(10,8,18,0.55)');
  fr(0, 44, W, 72, 'rgba(22,18,31,0.94)'); fr(0, 44, W, 1, C.gold); fr(0, 115, W, 1, C.gold);
  const px = Math.round(lerp(-70, 12, e)), tx = Math.round(lerp(250, 86, e));
  fr(px - 1, 47, 66, 66, '#0e0a16'); fr(px, 48, 64, 64, '#3a2f5a'); if (im && im.complete) ctx.drawImage(im, px, 48);
  htext('R' + (G.round + 1) + '/' + ROUNDS.length + '  ' + R.venue + '  ' + R.dist + 'M', tx, 49, C.dim);
  if (o) {
    text(o.name, tx, 60, '#ff8a7a', 2, C.ink); vtext(o.tag, tx, 74, C.dim, C.ink);
    let by = 86; vwrap(o.blurb, 146).slice(0, 2).forEach(l => { vtext(l, tx, by, C.text, C.ink); by += 10; });
  }
  btnA(230, 108);
}
function drawOpp() {
  const o = G.opp, mx = 104, my = 26, sc = 0.8;
  const mood = o.phase === 'result' ? (o.res === 'lose' ? 'happy' : o.res === 'win' ? moodFor('oppLose', o.icon) : 'neutral')
    : o.tiltLeft > 0 || o.locked ? 'frustrated' : 'neutral';
  const im = face(o.icon, mood);
  fr(0, 0, W, H, 'rgba(10,8,18,0.55)');
  box(28, 13, 184, 124, '#1c1630', C.edge);
  vtext(G.shootoff ? o.name + ' - shoot-off arrow' : o.name + "'s end", 34, 17, C.text, C.ink);
  fr(33, 33, 66, 66, '#0e0a16'); fr(34, 34, 64, 64, '#3a2f5a'); if (im && im.complete) ctx.drawImage(im, 34, 34);
  ctx.drawImage(FACE, TX - 50, TY - 50, 100, 100, mx, my, 80, 80);
  const P = a => [Math.floor(mx + (a.x - (TX - 50)) * sc), Math.floor(my + (a.y - (TY - 50)) * sc)];
  const nock = ([x, y], c) => { fr(x - 1, y - 1, 1, 1, '#f2ead8'); fr(x + 2, y - 1, 1, 1, '#f2ead8'); fr(x, y + 2, 2, 1, '#f2ead8'); fr(x + 1, y + 1, 2, 2, '#1a1426'); fr(x, y, 2, 2, c); };
  if (G.shootoff) nock(P(G.endArrows[0]), NOCKS[0]);
  o.arrows.slice(0, o.shown).forEach((a, i) => { nock(P(a), '#ffb030'); htext(a.s.miss ? 'M' : a.s.label, 190, 33 + i * 9, a.s.x ? C.gold : C.text); });
  if (o.tiltLeft > 0 || o.tiltNews) htext(o.tiltNews ? 'IN HIS HEAD!' : 'TILTED (' + o.tiltLeft + ')', 34, 100, C.orange, C.ink);
  else if (o.locked) htext('LOCKED IN', 34, 100, C.red, C.ink);
  if (o.phase === 'shoot') return;
  if (G.shootoff) {
    const mm = d => Math.round(d * G.R.faceCm * 10 / 96);
    ctext('YOU ' + mm(o.dm || Math.hypot(G.endArrows[0].x - TX, G.endArrows[0].y - TY)) + 'MM    ' + o.name + ' ' + mm(o.dop || Math.hypot(o.arrows[0].x - TX, o.arrows[0].y - TY)) + 'MM', 112, C.text);
    if (o.phase === 'result') ctext(o.res === 'win' ? 'YOU ARE CLOSER!' : o.name + ' IS CLOSER', 124, o.res === 'win' ? C.green : C.red, 1);
    return;
  }
  ctext(o.name + ': ' + o.total + (o.xs ? '  (' + o.xs + 'X)' : ''), 111, C.text);
  if (o.phase === 'result') {
    ctext('YOU ' + G.myEnd + (G.myXs ? ' (' + G.myXs + 'X)' : '') + '  VS  ' + o.total + '   ' + (o.onX ? (o.res === 'win' ? 'WON ON Xs +2' : 'LOST ON Xs') : o.res === 'win' ? 'END WON +2' : o.res === 'tie' ? 'TIE +1' : 'END LOST'), 120, o.res === 'win' ? C.green : o.res === 'tie' ? C.gold : C.red);
    ctext('SETS ' + G.sets[0] + ' - ' + G.sets[1], 129, C.text);
  }
}
function drawBet() {
  const b = G.offerBet; if (!b) return;
  fr(0, 0, W, H, 'rgba(10,8,18,0.6)');
  box(20, 8, 200, 144, '#1c1630', C.gold);
  iconO('mug', 34, 15, 2); iconO('mug', 190, 15, 2);
  ctext('SIDE BET', 16, C.gold, 2);
  ctext(betDef(b.id).card(b.need), 36, C.text);
  const row = (lbl, k, y, col, on) => {
    if (on) { fr(26, y - 3, 188, 22, '#3a2f5a'); htext('>', 30, y + 4, C.gold); }
    htext(lbl, 40, y + 4, col);
    fr(77, y - 1, 18, 18, C.ink);
    if (k) icon(offerIcon(k), 78, y, 2); else bigc('+1', 86, y + 3, C.red);
    htext(k ? itemName(k) : 'A SET POINT FOR ' + G.opp.name, 100, y + 4, col);
  };
  row('WIN', b.theirs, 50, C.green, !G.betSel);
  row('LOSE', b.yours, 72, C.red, !!G.betSel);
  // the selected piece, as the shop would describe it
  const k = G.betSel ? b.yours : b.theirs, r = k && offerDesc(k);
  fr(30, 96, 180, 1, C.edge);
  let yy = 100;
  if (r) vwrap(r.desc, 176).slice(0, 1).forEach(l => { vtext(l, 32, yy, C.text); yy += 10; });
  else vtext('Lose and ' + G.opp.name + ' gets a set point.', 32, yy, C.text);
  // your bar now, and how it'd look if this happens (a lost piece drops a level, or goes)
  if (meters() && k) {
    let build = Object.assign({}, G.build), rits = G.rituals.slice();
    if (!G.betSel) { if (k.rit) rits.push(k.rit); else build[k.slot] = { t: k.t, n: k.n }; }
    else if (k.rit) rits = rits.filter(x => x !== k.rit);
    else { const cur = build[k.slot]; if (cur && cur.n > 1) build[k.slot] = { t: cur.t, n: cur.n - 1 }; else delete build[k.slot]; }
    drawStrip(buildStrip(G.build, G.rituals), 30, 113, 180, 3); drawStrip(buildStrip(build, rits), 30, 120, 180, 6);
    htext('NOW', 30, 128, '#4a3e6e'); const lab = G.betSel ? 'IF YOU LOSE' : 'IF YOU WIN'; htext(lab, 210 - hw(lab), 128, G.betSel ? C.red : C.green);
  }
  htext('^v LOOK', 30, 140, C.dim);
  if (Math.floor(time * 2) % 2) htext('A: TAKE IT  B: PASS', 210 - hw('A: TAKE IT  B: PASS'), 140, C.text);
}
function drawSOIntro() {
  fr(0, 0, W, H, 'rgba(10,8,18,0.7)');
  box(30, 34, 180, 84, '#1c1630', C.red);
  ctext('SHOOT-OFF', 42, C.red, 2);
  ctext('SETS 5-5 VS ' + G.opp.name, 60, C.text);
  ctext('ONE ARROW EACH.', 72, C.text);
  ctext('CLOSEST TO CENTER WINS.', 81, C.text);
  if (Math.floor(time * 2) % 2) ctext('PRESS A', 102, C.text);
}
function drawTitle() {
  ctx.drawImage(TITLE_BG, 0, 0);
  fr(0, 0, W, H, 'rgba(20,10,30,0.35)');
  ctext('LINE CUTTER', 22, C.gold, 3, '#3a1a2a');
  ctext('A BAREBOW TOURNAMENT ROGUELIKE', 46, C.text);
  // a tiny arrow across the title
  const k = clamp((time % 4) / 0.6, 0, 1), ax = lerp(-20, 186, k);
  const ay = 63;   // under the subtitle, clear of the menu
  line(ax, ay, ax + 18, ay, '#e0c898'); fr(ax + 18, ay - 1, 2, 3, '#ffffff'); fr(ax - 2, ay - 2, 3, 2, C.red); fr(ax - 2, ay + 1, 3, 2, C.red);
  const fx = 196, fy = ay; [[8, C.white], [6, C.black], [4, C.blue], [3, C.red], [1.5, C.gold]].forEach(([r, c]) => {
    for (let j = -8; j <= 8; j++) for (let i = -8; i <= 8; i++) if (i * i + j * j <= r * r) fr(fx + i, fy + j, 1, 1, c); });
  const M = TMENU;
  if (!M.open) {
    if (Math.floor(time * 2) % 2) ctext('PRESS ANY BUTTON', 96, C.text, 1, C.ink);
    if (best) ctext('BEST TOTAL ' + best, 118, C.gold, 1, C.ink);
  } else {
    const label = { continue: 'CONTINUE', new: M.sure ? 'NEW GAME? PRESS A' : 'NEW GAME', practice: 'FREE PRACTICE', rivals: 'RIVALS', music: MUSIC.muted ? 'MUSIC: OFF' : 'MUSIC: ON' };
    const gap = M.items.length >= 5 ? 11 : 13, y0 = M.items.length >= 5 ? 66 : M.items.length === 4 ? 69 : 76;
    M.items.forEach((it, i) => {
      const y = y0 + i * gap, on = i === M.sel;
      if (on) { fr(56, y - 3, 128, 12, 'rgba(22,18,31,0.85)'); if (Math.floor(time * 3) % 2 === 0) htext('>', 60, y, C.gold); }
      ctext(label[it], y, on ? (it === 'new' && M.sure ? C.red : '#ffffff') : C.dim, 1, C.ink);
    });
    const g = M.save && M.save.G;
    if (g && M.items[M.sel] === 'continue') ctext((g.season > 1 ? 'SEASON ' + g.season + '  ' : '') + ROUNDS[g.round].name + '   TOTAL ' + g.total, 126, C.gold, 1, C.ink);
    else if (M.items[M.sel] === 'rivals') { const n = Object.keys(RIVALS).filter(k => RIV.on[k]).length; ctext(n + ' / ' + Object.keys(RIVALS).length + ' UNLOCKED', 126, C.gold, 1, C.ink); }
    else if (best) ctext('BEST TOTAL ' + best, 126, C.gold, 1, C.ink);
  }
  ctext('Z/SPACE = A    X = B    ARROWS = D-PAD', 146, C.dim);
}
function drawPractice() {
  const P = PSET, rg = PRAC_RANGES[P.range], sp = PRAC_SPREADS[P.spread];
  ctx.drawImage(TITLE_BG, 0, 0); fr(0, 0, W, H, 'rgba(14,10,24,0.72)');
  ctext('FREE PRACTICE', 10, C.gold, 2, C.ink);
  ctext('NO BRACKET. NO BALE MATE. JUST ENDS.', 28, C.dim);
  const blink = Math.floor(time * 3) % 2 === 0;
  const row = (i, y, title, val, sub) => {
    const on = P.row === i;
    box(24, y, 192, 26, on ? '#3a2f5a' : 'rgba(22,18,31,0.9)', on ? C.gold : C.edge);
    htext(title, 30, y + 4, on ? C.gold : C.dim);
    const vx = 120 - hw(val) / 2;
    htext(val, vx, y + 4, on ? '#ffffff' : C.text);
    if (on) { htext('<', vx - 12, y + 4, blink ? C.gold : C.dim); htext('>', vx + hw(val) + 6, y + 4, blink ? C.gold : C.dim); }
    htext(sub, 120 - hw(sub) / 2, y + 15, C.dim);
  };
  const gn = Object.keys(P.build).length + P.rituals.length, gv = gn ? gn + (gn > 1 ? ' PIECES' : ' PIECE') : 'NONE';
  row(0, 36, 'RANGE', rg.label, rg.sub);
  row(1, 64, P.meters ? 'GEAR' : 'SPREAD', P.meters ? gv : sp.label, P.meters ? 'A: PICK. IT REWRITES THE BARS.' : sp.sub);
  row(2, 92, 'SHOT', P.meters ? 'METERS' : 'CLASSIC', P.meters ? 'TWO STOPS. NO DICE.' : 'DRAW, ANCHOR, HOLD.');
  ['START', 'BACK'].forEach((l, k) => {
    const i = 3 + k, y = 123 + k * 11, on = P.row === i;
    if (on) { fr(76, y - 3, 88, 12, 'rgba(22,18,31,0.85)'); if (blink) htext('>', 80, y, C.gold); }
    ctext(l, y, on ? '#ffffff' : C.dim, 1, C.ink);
  });
  ctext('</> CHANGE    A: START    B: BACK', 148, C.dim);
}
// a strip, drawn flat: what your bars look like with this gear
function drawStrip(st, x, y, w, h) {
  fr(x - 2, y - 2, w + 4, h + 4, C.ink); fr(x - 1, y - 1, w + 2, h + 2, C.edge);
  gaugeRun(w, (i, c) => fr(x + i, y, 1, h, c), i => gaugeCol((i + 0.5) / w * 2 - 1, 0, st));
}
const optName = (sl, b) => b ? slotType(sl, b.t).name + ROMAN[b.n] : '-';
function drawGearPick() {
  const P = PSET, rows = pickRows(), sel = rows.filter(r => !r.hdr)[P.gsel], VIS = 9;
  ctx.drawImage(TITLE_BG, 0, 0); fr(0, 0, W, H, 'rgba(14,10,24,0.85)');
  ctext('YOUR KIT', 4, C.gold, 1, C.ink);
  const si = rows.indexOf(sel), top = clamp(si - 4, 0, Math.max(0, rows.length - VIS));
  rows.slice(top, top + VIS).forEach((row, i) => {
    const y = 15 + i * 10;
    if (row.hdr) { htext(row.hdr, 16, y, C.orange); fr(20 + hw(row.hdr), y + 3, 204 - hw(row.hdr), 1, '#3a2f5a'); return; }
    const on = row === sel; if (on) fr(14, y - 2, 212, 10, '#3a2f5a');
    if (row.r) { const have = P.rituals.includes(row.r.id); htext(row.r.name, 18, y, on ? C.gold : C.dim); const v = have ? 'ON' : '-'; htext(v, 222 - hw(v), y, have ? C.gold : '#4a3e6e'); return; }
    const b = P.build[row.sl.id]; htext(row.sl.name, 18, y, on ? C.gold : C.dim);
    const v = optName(row.sl, b); htext(v, 222 - hw(v), y, on ? '#ffffff' : b ? C.text : '#4a3e6e');
  });
  if (top > 0) htext('^', 230, 15, C.dim);
  if (top + VIS < rows.length) htext('v', 230, 95, C.dim);
  if (sel.r) { hctext(sel.r.desc, 120, 106, C.dim); if (sel.r.cost) hctext(sel.r.cost, 120, 114, C.red); }
  else { const b = P.build[sel.sl.id]; hctext(b ? tyDesc(slotType(sel.sl, b.t), b.n) : sel.sl.types.map(t => t.name).join(' / '), 120, 106, C.dim); }
  drawStrip(buildStrip(P.build, P.rituals), 16, 125, 208, 6);
  ctext('</> PICK   START: SHOP   B: DONE', 140, C.dim);
}
function drawMockShop() { const P = PSET; drawOfferShop(P.build, P.rituals, P.offers, P.osel, 'PRO SHOP', 'A: BUY   B: WALK AWAY'); }
// Three offers, your strip now and after. Gear and form show NEW <SLOT> (a fork) or UPGRADE; rituals show their price.
function drawOfferShop(build, rituals, o, osel, title, foot) {
  ctx.drawImage(TITLE_BG, 0, 0); fr(0, 0, W, H, 'rgba(14,10,24,0.85)');
  ctext(title, 4, C.gold, 1, C.ink);
  o.forEach((f, i) => {
    const y = 14 + i * 24, sel = osel === i, d = offerDesc(f), rar = (offerRit(f) || slotType(offerSlot(f), f.t)).rar;
    box(16, y, 208, 22, sel ? '#3a2f5a' : 'rgba(22,18,31,0.9)', sel ? C.gold : C.edge);
    fr(20, y + 5, 3, 3, rar === 'rare' ? C.gold : rar === 'uncommon' ? C.orange : C.dim);
    htext(offerName(f), 26, y + 3, sel ? '#ffffff' : C.text);
    const sl = offerSlot(f), tag = f.rit ? 'RITUAL' : f.n > 1 ? 'UPGRADE' : 'NEW ' + (sl.form ? 'FORM' : sl.name);
    htext(tag, 218 - hw(tag), y + 3, f.rit ? '#c08aff' : f.n > 1 ? C.green : C.orange);
    const lines = hwrap(d.desc, 198).map(l => [l, C.dim]).concat(d.cost ? hwrap(d.cost, 198).map(l => [l, C.red]) : []);
    lines.slice(0, 1).forEach(([l, col]) => htext(l, 22, y + 12, col));
  });
  if (!o.length) ctext('NOTHING LEFT TO SELL YOU.', 50, C.dim);
  else { const f = o[osel], after = f.rit ? build : Object.assign({}, build, { [f.slot]: { t: f.t, n: f.n } });
    drawStrip(buildStrip(build, rituals), 16, 113, 208, 4); drawStrip(buildStrip(after, f.rit ? rituals.concat(f.rit) : rituals), 16, 121, 208, 7);
    htext('NOW', 16, 131, '#4a3e6e'); htext('AFTER', 224 - hw('AFTER'), 131, C.gold); }
  ctext(foot, 148, C.dim);
}
// Opponents you haven't reached yet are shown as dark silhouettes (cached per portrait).
const SIL = {};
function silhouette(key, im) {
  if (SIL[key] || !im || !im.complete || !im.width) return SIL[key];
  const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d');
  g.drawImage(im, 0, 0); g.globalCompositeOperation = 'source-in'; g.fillStyle = '#120e1c'; g.fillRect(0, 0, c.width, c.height);
  return (SIL[key] = c);
}
function drawBracket() {
  ctx.drawImage(TITLE_BG, 0, 0); fr(0, 0, W, H, 'rgba(14,10,24,0.72)');
  ctext(G.season > 1 ? 'COUNTY OPEN  SEASON ' + G.season : 'THE COUNTY OPEN', 8, C.gold, 1, C.ink);
  ctext('BAREBOW DRAW SHEET', 19, C.dim);
  const rowY = i => 128 - i * 28, cur = G.round;
  fr(30, rowY(ROUNDS.length - 1) + 12, 2, rowY(0) - rowY(ROUNDS.length - 1), '#4a3e6e');   // the ladder rail
  ROUNDS.forEach((R, i) => {
    const y = rowY(i), done = i < cur, now = i === cur, o = oppAt(i);
    const hi = now && Math.floor(time * 3) % 2;
    box(40, y, 176, 24, now ? '#3a2f5a' : 'rgba(22,18,31,0.9)', now ? (hi ? C.gold : '#b8962e') : C.edge);
    fr(27, y + 9, 8, 8, done ? C.green : now ? C.gold : '#4a3e6e');                        // rung
    htext(R.name, 46, y + 3, done ? '#6a5c86' : now ? C.text : C.dim);
    htext(R.dist + 'M', 46, y + 13, done ? '#6a5c86' : C.dim);
    const later = i > cur, raw = o && face(o.icon, done ? 'defeat' : 'neutral'), im = later ? silhouette(o && o.icon, raw) : raw;
    fr(150, y + 2, 20, 20, later ? '#4a3e6e' : '#0e0a16');
    if (im && (im.complete || later)) { ctx.save(); ctx.globalAlpha = done ? 0.45 : 1; ctx.drawImage(im, 0, 0, im.width || 64, im.height || 64, 150, y + 2, 20, 20); ctx.restore(); }
    if (o) htext(later ? '???' : o.name, 174, y + 8, done ? '#6a5c86' : now ? '#ff8a7a' : C.dim);
    if (done) { fr(160, y + 14, 6, 6, C.ink); fr(161, y + 16, 1, 2, C.green); fr(162, y + 17, 1, 2, C.green); fr(163, y + 15, 1, 3, C.green); fr(164, y + 14, 1, 2, C.green); }   // beaten: check on the portrait
  });
  // your marker climbs from the last rung to today's
  const k = clamp((sT - 0.2) / 0.7, 0, 1), e = 1 - Math.pow(1 - k, 3), my = Math.round(lerp(rowY(G.bracketFrom || 0), rowY(cur), e)) + 6;
  box(2, my - 1, 22, 13, '#5ab0f0', C.ink); htext('YOU', 4, my + 1, C.ink);
  if (sT > 1) btnA(228, 150);
}
// New rivals on the draw sheet: held until the run ends, then shown over CHAMPION or the defeat screen.
const showNews = () => NEWS.length > 0 && ['over', 'win'].includes(S) && !DLG && !FADE && sT > 0.6;
function drawNews() {
  const k = NEWS[0], o = RIVALS[k], im = face(k, 'neutral'), e = 1 - Math.pow(1 - Math.min(1, newsT * 4), 3);
  fr(0, 0, W, H, 'rgba(10,8,18,0.75)');
  const y = Math.round(lerp(-120, 24, e));
  box(24, y, 192, 112, '#1c1630', C.gold);
  ctext('NEW RIVAL', y + 6, C.gold, 2, C.ink);
  fr(33, y + 27, 66, 66, '#0e0a16'); fr(34, y + 28, 64, 64, '#3a2f5a'); if (im && im.complete) ctx.drawImage(im, 34, y + 28);
  text(o.name, 106, y + 29, '#ff8a7a', 2, C.ink); vtext(o.tag, 106, y + 43, C.dim, C.ink);
  let by = y + 56; vwrap(o.news, 104).slice(0, 3).forEach(l => { vtext(l, 106, by, C.text, C.ink); by += 10; });
  ctext('NOW ON THE DRAW SHEET', y + 98, C.green);
  if (newsT > 0.8) btnA(204, y + 98);
}
// RIVALS (title menu): the four regulars, and under each the rival who can take their slot.
const hwrap = (t, w) => t.split(' ').reduce((L, wd) => { const l = L[L.length - 1]; if (l && hw(l + ' ' + wd) <= w) L[L.length - 1] = l + ' ' + wd; else L.push(wd); return L; }, []);
function drawRivals() {
  ctx.drawImage(TITLE_BG, 0, 0); fr(0, 0, W, H, 'rgba(14,10,24,0.78)');
  ctext('RIVALS', 5, C.gold, 2, C.ink);
  ROUNDS.forEach((R, i) => {
    const x = 4 + i * 58, cx = x + 29, rk = Object.keys(RIVALS).find(k => RIVALS[k].slot === i), rv = RIVALS[rk], on = RIV.on[rk];
    htext(R.dist + 'M', cx - hw(R.dist + 'M') / 2, 23, C.dim);
    const tile = (k, y, lit, lines, cols) => {
      const raw = face(k, 'neutral'), im = lit ? raw : silhouette(k, raw);
      fr(cx - 17, y, 34, 34, '#0e0a16'); fr(cx - 16, y + 1, 32, 32, lit ? '#3a2f5a' : '#2a2340');
      if (im && (im.complete || !lit)) ctx.drawImage(im, 0, 0, im.width || 64, im.height || 64, cx - 16, y + 1, 32, 32);
      lines.forEach((l, n) => htext(l, cx - hw(l) / 2, y + 37 + n * 9, cols[Math.min(n, cols.length - 1)]));
    };
    tile(R.opp.icon, 33, true, [R.opp.name], [C.text]);
    // locked: how to get them. Unlocked but never faced: green, they're guaranteed on your next draw sheet.
    tile(rk, 82, on, on ? [rv.name].concat(hwrap(rv.tag, 54)) : ['???'].concat(hwrap(rv.how, 54)),
      on ? [RIV.met[rk] ? C.text : C.green, C.dim] : [C.dim, C.orange]);
  });
  ctext('A / B: BACK', 148, C.dim);
}
function drawRoundEnd() {
  fr(0, 0, W, H, 'rgba(10,8,18,0.55)');
  box(30, 34, 180, 86, '#1c1630', C.gold);
  if (G.match) { ctext(G.shootoff ? 'WON THE SHOOT-OFF!' : 'MATCH WON!', 42, C.green, 2); ctext('SETS ' + G.sets[0] + '-' + G.sets[1] + ' VS ' + G.opp.name, 62, C.text); }
  else { ctext('MADE THE CUT!', 42, C.green, 2); ctext(G.roundScore + ' / ' + G.target, 60, C.text, 2); }
  ctext('AVG ' + G.thisAvg.toFixed(1) + ' PER ARROW' + (G.lastAvg ? '   (LAST ROUND ' + G.lastAvg.toFixed(1) + ')' : ''), 80, G.lastAvg && G.thisAvg > G.lastAvg ? C.green : C.text);
  ctext('X COUNT ' + G.xCount + '    BEST END ' + G.bestEnd, 90, C.dim);
  ctext(G.round < ROUNDS.length - 1 ? 'A: NEXT ROUND' : 'A: ...', 104, Math.floor(time * 2) % 2 ? C.text : C.dim);
}
function drawOver() {
  fr(0, 0, W, H, 'rgba(10,8,18,0.7)');
  box(24, 30, 192, 96, '#1c1630', C.red);
  if (G.match) {
    ctext('KNOCKED OUT', 38, C.red, 2);
    ctext('R' + (G.round + 1) + ' ' + G.R.name + '   BY ' + G.opp.name, 58, C.text);
    ctext(G.shootoff ? 'LOST THE SHOOT-OFF' : 'SETS ' + G.sets[0] + '-' + G.sets[1], 68, C.orange);
  } else {
    ctext('MISSED THE CUT', 38, C.red, 2);
    ctext('R' + (G.round + 1) + ' ' + G.R.name + '   ' + G.roundScore + ' / ' + G.target, 58, C.text);
    ctext('SHORT BY ' + (G.target - G.roundScore), 68, C.orange);
  }
  ctext('TOTAL ' + G.total + '   X COUNT ' + G.xCount + '   BEST END ' + G.bestEnd, 82, C.dim);
  ctext('BEST TOTAL ' + best, 92, C.gold);
  ctext('A: SHOOT AGAIN', 110, Math.floor(time * 2) % 2 ? C.text : C.dim);
}
function drawWin() {
  ctx.drawImage(TITLE_BG, 0, 0);
  fr(0, 0, W, H, 'rgba(20,10,30,0.4)');
  ctext('CHAMPION', 26, C.gold, 3, '#3a1a2a');
  ctext(G.season >= SEASONS ? 'THE COUNTY OPEN IS YOURS' : 'SEASON ' + G.season + ' COMPLETE', 52, C.text);
  ctext('TOTAL ' + G.total + '    X COUNT ' + G.xCount, 66, C.text);
  ctext('BEST END ' + G.bestEnd + '    BEST EVER ' + best, 76, C.dim);
  G.rituals.forEach((r, i) => icon(ritIcon(r), 120 - G.rituals.length * 10 + i * 20, 90, 2));
  if (Math.floor(time * 2) % 2) ctext(G.season >= SEASONS ? 'A: NEW RUN' : 'A: NEXT SEASON (HARDER)', 124, C.text);
}
function render() {
  fr(0, 0, W, H, C.ink);
  ctx.save();
  if (shake > 0) ctx.translate(Math.round((rand() - .5) * 2), Math.round((rand() - .5) * 2));
  if (S === 'title') drawTitle();
  else if (S === 'bracket') drawBracket();
  else if (S === 'pset') drawPractice();
  else if (S === 'mgear') drawGearPick();
  else if (S === 'mshop') drawMockShop();
  else if (S === 'rivals') drawRivals();
  else if (S === 'shop') drawShop();
  else if (S === 'win') drawWin();
  else if (G && G.R) {
    ctx.drawImage(BG, 0, 0); ctx.drawImage(FACE, 0, 0);
    drawArrows(G.endArrows);
    const grp = shownGroup();
    if (grp) {
      const r = grp.r + 2.5;
      for (let k = 0; k < 48; k++) if (k % 2 === 0) { const t = k / 48 * 6.283; fr(grp.cx + Math.cos(t) * r, grp.cy + Math.sin(t) * r, 1, 1, '#ffffff'); }
    }
    if (['aim', 'draw', 'hold'].includes(S) && !has('instinct') && !meters()) {
      const gh = spreadGhost(), r = Math.max(1.5, gh.r), n = Math.max(24, Math.round(r * 6));
      ctx.globalAlpha = 0.13; ctx.fillStyle = gh.danger ? C.red : '#ffffff';
      const rx = Math.max(1.5, gh.rx);
      ctx.beginPath(); ctx.ellipse(gh.x, gh.y, rx, r, 0, 0, 6.2832); ctx.fill(); ctx.globalAlpha = 0.75;
      for (let k = 0; k < n; k++) { const t = k / n * 6.2832; fr(gh.x + Math.cos(t) * (rx + 1), gh.y + Math.sin(t) * (r + 1), 1, 1, '#16121f'); }   // dark rim so it reads on any ring
      for (let k = 0; k < n; k++) { if (k % 3 === 2) continue; const t = k / n * 6.2832; fr(gh.x + Math.cos(t) * rx, gh.y + Math.sin(t) * r, 1, 1, gh.danger ? '#ff4a4a' : '#ffffff'); }
      ctx.globalAlpha = 1;
    }
    if (S === 'aim' || S === 'draw' || S === 'hold') { const ax = Math.round(TX + G.holdoff * T.holdoffPx); const c = Math.floor(time * 3) % 2 ? '#ffffff' : '#1a1426';
      fr(ax - 6, TY, 3, 1, c); fr(ax + 4, TY, 3, 1, c); fr(ax, TY - 6, 1, 3, c); fr(ax, TY + 4, 1, 3, c); }
    if (S === 'draw' || S === 'hold') { const p = pointPos(); drawPoint(Math.round(p.x), Math.round(p.y)); drawString(S === 'hold' ? 1 : clamp((G.p - 0.4) / 0.5, 0, 1)); }
    if (S === 'flight') {
      // The point leaves your eye fast; then the arrow is a speck riding its arc down to the boss.
      const f = G.fl, a = f.a, path = k => ({ x: lerp(f.from.x, a.x, k), y: lerp(f.from.y, a.y, k) - flightArc() * Math.sin(Math.PI * k) });
      const k = Math.min(1, f.t / flightTime()), near = Math.min(1, f.t / 0.14), sc = Math.pow(1 - near, 1.6);
      if (sc > 0.04) { const p = path(k); drawPoint(Math.round(p.x), Math.round(p.y), sc); }
      if (f.t > 0.07 && k < 1) {
        [0.12, 0.06].forEach((lag, n) => { const q = path(Math.max(0, k - lag)); ctx.globalAlpha = 0.25 + n * 0.2; fr(Math.round(q.x), Math.round(q.y), 1, 1, '#f2ead8'); });   // motion streak
        ctx.globalAlpha = 1; const p = path(k), x = Math.round(p.x), y = Math.round(p.y), r = k < 0.5 ? 2 : 1;
        fr(x - r, y, 2 * r + 1, 1, '#1a1426'); fr(x, y - r, 1, 2 * r + 1, '#1a1426'); fr(x, y, 1, 1, NOCKS[G.endArrows.length % 3]);
      }
    }
    drawLeft(); drawRight(); drawTopBar(); drawMeter();
    if (S === 'intro') drawIntro();
    if (S === 'opp') drawOpp();
    if (S === 'soIntro') drawSOIntro();
    if (S === 'bet') drawBet();
    if (G.camFlash > 0) { ctx.globalAlpha = Math.min(1, G.camFlash / 0.3) * 0.92; fr(0, 0, W, H, '#ffffff'); ctx.globalAlpha = 1; }   // Chad's flash
    if (S === 'roundEnd') drawRoundEnd();
    if (S === 'over') drawOver();
    if (showNews()) drawNews();
    if (DLG) drawDialog();
  }
  if (S === 'win' && showNews()) drawNews();
  parts.forEach(p => fr(p.x, p.y, 1, 1, p.col));
  pops.forEach(p => { if (p.age < p.life) { if (p.sc === 1) htext(p.t, p.x, p.y, p.col, C.ink); else text(p.t, p.x, p.y, p.col, p.sc); } });
  if (flashT > 0) fr(0, 0, W, H, 'rgba(255,255,255,0.35)');
  if (FADE) { const k = clamp(FADE.t / FADE.dur, 0, 1); ctx.globalAlpha = FADE.k === 'out' ? k : 1 - k; fr(0, 0, W, H, '#0a0812'); ctx.globalAlpha = 1; }
  ctx.restore();
  if (PAUSE) drawPause();
}
function drawKit() {
  fr(0, 0, W, H, 'rgba(10,8,18,0.86)');
  box(8, 4, 224, 152, '#1c1630', C.gold);
  ctext('YOUR KIT', 9, C.gold, 1, C.ink);
  const own = ownedItems(), sel = PAUSE.kit.sel;
  htext('SEASON ' + G.season + '  ' + (G.R ? G.R.name : ''), 16, 21, C.dim);
  if (!own.length) { ctext('NOTHING YET. WIN A MATCH.', 70, C.dim); ctext('B: BACK', 144, C.dim); return; }
  own.forEach((f, i) => {
    const y = 32 + i * 11, on = i === sel, rar = (offerRit(f) || slotType(offerSlot(f), f.t)).rar;
    if (on) fr(14, y - 2, 212, 11, C.panel);
    fr(18, y + 1, 3, 3, rar === 'rare' ? C.gold : rar === 'uncommon' ? C.orange : C.dim);
    htext(offerName(f), 25, y, on ? '#ffffff' : C.text);
    const sl = offerSlot(f), tag = f.rit ? 'RITUAL' : sl.form ? 'FORM' : sl.name;
    htext(tag, 222 - hw(tag), y, f.rit ? '#c08aff' : C.orange);
  });
  const d = offerDesc(own[Math.min(sel, own.length - 1)]);
  fr(14, 118, 212, 1, C.edge);
  hwrap(d.desc, 208).slice(0, 2).forEach((l, k) => htext(l, 16, 122 + k * 8, C.text));
  ctext('^V LOOK   B: BACK', 144, C.dim);
}
function drawPause() {
  if (PAUSE.kit) { drawKit(); return; }
  fr(0, 0, W, H, 'rgba(10,8,18,0.72)');
  box(56, 30, 128, 100, '#1c1630', C.gold);
  ctext('PAUSED', 38, C.gold, 2);
  const name = { resume: 'RESUME', kit: 'YOUR KIT', music: MUSIC.muted ? 'MUSIC: OFF' : 'MUSIC: ON', setup: 'CHANGE RANGE', quit: G && G.free ? 'QUIT' : 'SAVE & QUIT' };
  const items = pauseItems().map(k => name[k]), y0 = items.length === 4 ? 56 : 64;
  items.forEach((l, i) => {
    const y = y0 + i * 14, on = i === PAUSE.sel, col = on ? '#ffffff' : C.dim;
    if (on) { fr(66, y - 3, 108, 13, C.panel); if (Math.floor(PAUSE.t * 3) % 2 === 0) htext('>', 70, y, C.gold); }
    ctext(l, y, col);
  });
  ctext('START: RESUME', 114, C.dim);
}

function tick(dt) { update(Math.min(0.05, Math.max(0, dt))); render(); if (opts.onFrame) opts.onFrame(cv); }
let running = false, last = 0, raf = 0;
function frame(now) { if (!running) return; tick((now - last) / 1000); last = now; raf = requestAnimationFrame(frame); }
function start() { if (running) return; running = true; last = performance.now(); raf = requestAnimationFrame(frame); }
function stop() { running = false; cancelAnimationFrame(raf); }
openTitle();
if (opts.autoLoop !== false) start(); else render();
// wake(): start audio (and so the music) without pressing anything. Call it from a user gesture,
// e.g. when the player picks up or focuses the handheld.
function wake() { ensureAudio(); }
return { canvas: cv, width: W, height: H, press, tick, start, stop, wake, pause: () => pause(),
  get state() { return S; },
  get paused() { return !!PAUSE; },
  _debug: code => eval(code) };   // test/sim hook: read internal state
}
const LineCutter = { create };
if (typeof module !== 'undefined' && module.exports) module.exports = LineCutter;
root.LineCutter = LineCutter;
})(typeof window !== 'undefined' ? window : globalThis);
