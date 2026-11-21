import { InputRouter, gamepadButtons, directions } from './input.js';
import { createReadiness } from './readiness.js';
import { watchResource } from './resources.js';
export { InputRouter } from './input.js';
const styles = new WeakMap();
const KEYS = { ArrowUp:'up', ArrowDown:'down', ArrowLeft:'left', ArrowRight:'right', KeyW:'up', KeyS:'down', KeyA:'left', KeyD:'right', KeyZ:'a', Space:'a', KeyX:'b', Enter:'start', KeyP:'start', KeyM:'select', ShiftRight:'select', Escape:'select' };
const asset = name => new URL('../assets/' + name, import.meta.url).href;

/** Mount before loading a game; setGame then ready after the first game render. */
export function mountShell({ canvas, content = canvas, game: initialGame, pixelWidth = canvas?.width || 640, integerScale = false, parent = content?.ownerDocument.body || globalThis.document?.body, onMenu, buttonMap = {}, keyboard = true, gamepad = true, loadingSteps = [] } = {}) {
  if (!content || !parent) throw new TypeError('mountShell requires canvas/content and a parent');
  if (!Array.isArray(loadingSteps) || loadingSteps.some(id => typeof id !== 'string' || !id.trim()) || new Set(loadingSteps).size !== loadingSteps.length) throw new TypeError('loadingSteps must be an array of unique nonempty strings');
  loadingSteps = [...loadingSteps];
  const remainingSteps = new Set(loadingSteps);
  const doc = parent.ownerDocument, win = doc.defaultView;
  let sheet = styles.get(doc);
  if (!sheet) {
    const link = doc.createElement('link'); link.rel = 'stylesheet'; link.href = new URL('./shell.css', import.meta.url).href;
    sheet = { link, count: 0, resource: watchResource(link, () => !!link.sheet, win) }; styles.set(doc, sheet);
    doc.head.append(link);
  }
  sheet.count++;
  const root = doc.createElement('div'); root.className = 'cubby-shell';
  root.style.visibility = 'hidden';
  root.innerHTML = `<div class="cubby-device"><div class="cubby-screen"><div class="cubby-boot" role="status" aria-label="Cubby Arcade is starting"><img src="${asset('boot.png')}" width="640" height="480" alt="" fetchpriority="high"><picture class="cubby-stars"><source media="(prefers-reduced-motion:reduce)" srcset="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs="><img src="${asset('boot.webp')}" width="640" height="480" alt=""></picture><div class="cubby-track" aria-hidden="true"><div class="cubby-fill"></div></div></div></div><div class="cubby-pad cubby-dpad" aria-label="Directional pad"></div><div class="cubby-pad cubby-stick" aria-label="Left stick"></div><button type="button" class="cubby-hit cubby-a" data-button="a" aria-label="A"></button><button type="button" class="cubby-hit cubby-b" data-button="b" aria-label="B"></button><button type="button" class="cubby-hit cubby-start" data-button="start" aria-label="Start"></button><button type="button" class="cubby-hit cubby-menu" data-button="select" aria-label="Menu"></button></div>`;
  const marker = doc.createComment('cubby-content'); content.before(marker);
  const hadClass = content.classList.contains('cubby-content'); content.classList.add('cubby-content');
  root.querySelector('.cubby-screen').prepend(content); parent.append(root);
  const device = root.querySelector('.cubby-device'), boot = root.querySelector('.cubby-boot');
  let game = initialGame, destroyed = false, started = false, focused = true, frame;
  const track = root.querySelector('.cubby-track'), fill = root.querySelector('.cubby-fill');
  const totalSteps = 4 + loadingSteps.length + 1; // stylesheet, three images, adapter steps, final paint gate
  let completedSteps = 0, finishAdapterSteps;
  const adapterReady = new Promise(resolve => { finishAdapterSteps = resolve; });
  if (!remainingSteps.size) finishAdapterSteps(true);
  track.removeAttribute('aria-hidden');
  track.setAttribute('role', 'progressbar'); track.setAttribute('aria-label', 'Loading');
  track.setAttribute('aria-valuemin', '0'); track.setAttribute('aria-valuemax', String(totalSteps));
  function updateProgress() {
    track.setAttribute('aria-valuenow', String(completedSteps));
    track.setAttribute('aria-valuetext', `${completedSteps} of ${totalSteps} loading steps complete`);
    root.dataset.loadingCompleted = String(completedSteps); root.dataset.loadingTotal = String(totalSteps);
    fill.style.width = `${completedSteps / totalSteps * 100}%`;
  }
  function resourceStep(promise) {
    return promise.then(success => { if (success && !destroyed) { completedSteps++; updateProgress(); } return success; });
  }
  updateProgress();
  const cleanups = [], pointers = new Map(), padArmed = new Map();
  const images = [...boot.querySelectorAll('img')];
  const photograph = new win.Image();
  const resources = [...images, photograph].map(image => watchResource(image, () => image.complete && image.naturalWidth > 0, win));
  photograph.src = asset('cubby-buddy.webp');
  const resourceReady = Promise.all([sheet.resource.ready, ...resources.map(resource => resource.ready)].map(resourceStep)).then(results => {
    const success = results.every(Boolean);
    if (!destroyed) {
      root.dataset.resourceState = success ? 'ready' : 'error';
      if (success) root.style.visibility = '';
    }
    return success;
  });
  const active = () => !destroyed && started && focused && !doc.hidden;
  const input = new InputRouter((button, down) => {
    if (button === 'select' && onMenu) onMenu(down);
    else game?.[down ? 'press' : 'release']?.(button);
  }, buttonMap);
  function listen(target, type, fn, options) { target.addEventListener(type, fn, options); cleanups.push(() => target.removeEventListener(type, fn, options)); }
  function reset() {
    input.clear(); pointers.clear(); padArmed.clear();
    root.querySelectorAll('.pressed,.on').forEach(el => el.classList.remove('pressed', 'on'));
  }
  const gate = createReadiness({ resources: resourceReady.then(success => success ? adapterReady : false), requestFrame: fn => win.requestAnimationFrame(fn), cancelFrame: id => win.cancelAnimationFrame(id), reveal() { completedSteps++; updateProgress(); boot.hidden = true; started = true; if (!active()) game?.stop?.(); } });
  function fit() {
    const bounds = parent === doc.body ? { width: win.innerWidth, height: win.innerHeight } : parent.getBoundingClientRect();
    const width = Math.max(0, Math.min(bounds.width - 16, (bounds.height - 16) * 242 / 352));
    const wholeScale = integerScale ? Math.floor(width * .76446 / pixelWidth) : 0;
    const useIntegerScale = wholeScale >= 2;
    const fitted = useIntegerScale ? wholeScale * pixelWidth / .76446 : Math.floor(width / 2) * 2;
    device.style.setProperty('--cubby-width', fitted + 'px');
    device.style.setProperty('--cubby-pixel-width', pixelWidth + 'px');
    device.style.setProperty('--cubby-pixel-height', pixelWidth * 3 / 4 + 'px');
    device.style.setProperty('--cubby-scale', String(useIntegerScale ? wholeScale : fitted * .76446 / pixelWidth));
  }
  listen(win, 'resize', fit); fit();
  if (win.ResizeObserver && parent !== doc.body) { const observer = new win.ResizeObserver(fit); observer.observe(parent); cleanups.push(() => observer.disconnect()); }
  if (keyboard) {
    listen(win, 'keydown', e => { const b = KEYS[e.code]; if (!b || ((e.code === 'Enter' || e.code === 'Space') && e.target?.closest?.('button')) || e.ctrlKey || e.metaKey || e.altKey || e.target?.closest?.('input,textarea,select,[contenteditable="true"]')) return; e.preventDefault(); if (active() && !e.repeat) input.set('key:' + e.code, [b]); });
    listen(win, 'keyup', e => { if (KEYS[e.code]) {
      if (!((e.code === 'Enter' || e.code === 'Space') && e.target?.closest?.('button'))) e.preventDefault();
      input.set('key:' + e.code, []);
    } });
  }
  for (const el of root.querySelectorAll('.cubby-hit,.cubby-pad')) {
    const button = el.dataset.button;
    function update(e) {
      if (button) input.set('pointer:' + e.pointerId, [button]);
      else { const r = el.getBoundingClientRect(); const buttons = directions(e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2, r.width); input.set('pointer:' + e.pointerId, buttons); el.classList.toggle('on', buttons.length > 0); }
    }
    listen(el, 'pointerdown', e => {
      e.preventDefault(); if (!active() || (e.button !== undefined && e.button !== 0)) return;
      pointers.set(e.pointerId, el); if (button) el.classList.add('pressed');
      try { el.setPointerCapture(e.pointerId); } catch {} update(e);
    });
    listen(el, 'pointermove', e => { if (active() && pointers.get(e.pointerId) === el) update(e); });
    const end = e => { if (pointers.get(e.pointerId) !== el) return; pointers.delete(e.pointerId); input.set('pointer:' + e.pointerId, []); if (![...pointers.values()].includes(el)) el.classList.remove('pressed', 'on'); };
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) listen(el, type, end);
    // Keyboard activation of the real buttons (including assistive technology).
    if (button) listen(el, 'click', e => { if (e.detail === 0 && active()) { input.set('activation', [button]); input.set('activation', []); } });
  }
  function lifecycle() { reset(); if (!started) return; if (active()) game?.wake?.(); else game?.stop?.(); }
  listen(win, 'blur', () => {
    // Entering the hosted screen blurs the parent window, not the browser.
    // Still release parent-held controls before the iframe takes keyboard input.
    focused = content.tagName === 'IFRAME' && doc.activeElement === content && doc.hasFocus();
    lifecycle();
  });
  listen(win, 'focus', () => { focused = true; lifecycle(); });
  listen(doc, 'visibilitychange', lifecycle);
  listen(root, 'contextmenu', e => e.preventDefault());
  if (gamepad) {
    const poll = () => {
      if (destroyed) return;
      const present = new Set();
      if (active()) {
        let pads; try { pads = win.navigator.getGamepads?.() || []; } catch { pads = []; }
        for (const pad of pads) {
          if (!pad || pad.connected === false) continue;
          const key = 'gamepad:' + pad.index + ':' + pad.id; present.add(key);
          const buttons = gamepadButtons(pad);
          if (!buttons.length) padArmed.set(key, true);
          if (padArmed.get(key)) input.set(key, buttons);
        }
      }
      for (const key of [...input.sources.keys()]) if (key.startsWith('gamepad:') && !present.has(key)) { input.set(key, []); padArmed.delete(key); }
      for (const key of padArmed.keys()) if (!present.has(key)) padArmed.delete(key);
      frame = win.requestAnimationFrame(poll);
    };
    frame = win.requestAnimationFrame(poll);
    listen(win, 'gamepaddisconnected', e => {
      if (!e.gamepad) return;
      const key = 'gamepad:' + e.gamepad.index + ':' + e.gamepad.id;
      input.set(key, []); padArmed.delete(key);
    });
  }
  return {
    element: root, screen: root.querySelector('.cubby-screen'), canvas,
    setGame(next) { if (destroyed) throw new Error('Shell is destroyed'); reset(); game?.stop?.(); game = next; if (started && !active()) game?.stop?.(); },
    ready: () => gate.ready(),
    completeLoadingStep(id) {
      if (destroyed) return false;
      if (!loadingSteps.includes(id)) throw new RangeError('Unknown loading step: ' + id);
      if (!remainingSteps.delete(id)) return false;
      completedSteps++; updateProgress();
      if (!remainingSteps.size) finishAdapterSteps(true);
      return true;
    },
    destroy() {
      if (destroyed) return; reset(); game?.stop?.(); destroyed = true; gate.destroy(); win.cancelAnimationFrame(frame);
      finishAdapterSteps(false);
      resources.forEach(resource => resource.destroy());
      cleanups.splice(0).forEach(cleanup => cleanup());
      if (marker.parentNode) marker.replaceWith(content); else content.remove();
      if (!hadClass) content.classList.remove('cubby-content'); root.remove();
      if (--sheet.count === 0) { sheet.resource.destroy(); sheet.link.remove(); styles.delete(doc); }
    }
  };
}
