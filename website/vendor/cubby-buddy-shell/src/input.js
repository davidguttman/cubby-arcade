/** OR-combine physical sources. A release never cancels another held source. */
export class InputRouter {
  constructor(emit, buttonMap = {}) { this.emit = emit; this.buttonMap = new Map(Object.entries(buttonMap)); this.sources = new Map(); this.held = new Set(); }
  set(source, buttons) {
    const next = new Set(Array.from(buttons, button => this.buttonMap.get(button) ?? button));
    if (next.size) this.sources.set(source, next); else this.sources.delete(source);
    const combined = new Set([...this.sources.values()].flatMap(value => [...value]));
    for (const button of this.held) if (!combined.has(button)) this.emit(button, false);
    for (const button of combined) if (!this.held.has(button)) this.emit(button, true);
    this.held = combined;
  }
  removePrefix(prefix) { for (const key of [...this.sources.keys()]) if (key.startsWith(prefix)) this.set(key, []); }
  clear() { this.sources.clear(); for (const button of this.held) this.emit(button, false); this.held.clear(); }
}

export function directions(x, y, width) {
  if (Math.hypot(x, y) <= width * 0.12) return [];
  const angle = Math.atan2(y, x) * 180 / Math.PI;
  const near = center => Math.abs(((angle - center + 540) % 360) - 180) <= 67.5;
  return [[0, 'right'], [180, 'left'], [90, 'down'], [-90, 'up']].filter(([center]) => near(center)).map(([, button]) => button);
}

export function gamepadButtons(pad) {
  if (!pad || pad.connected === false) return [];
  const mapping = { 0: 'a', 1: 'b', 8: 'select', 9: 'start', 12: 'up', 13: 'down', 14: 'left', 15: 'right' };
  const buttons = new Set(Object.entries(mapping).filter(([index]) => pad.buttons?.[index]?.pressed).map(([, button]) => button));
  if (pad.axes?.[0] < -0.5) buttons.add('left');
  if (pad.axes?.[0] > 0.5) buttons.add('right');
  if (pad.axes?.[1] < -0.5) buttons.add('up');
  if (pad.axes?.[1] > 0.5) buttons.add('down');
  return [...buttons];
}
