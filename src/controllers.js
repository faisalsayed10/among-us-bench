// ========================
// CONTROLLERS
// ========================
// A controller decides the per-tick movement intent for a Player.
// Keeping this out of Player lets the same entity be driven by a human,
// a scripted wander loop, or (later) an LLM agent.

// ------------------------
// Human (keyboard)
// ------------------------

export class HumanController {
  constructor(player) {
    this.player = player;
    this.keys = { w: false, a: false, s: false, d: false };
    this._bind();
  }

  _bind() {
    window.addEventListener('keydown', (e) => {
      // Ignore movement keys while the user is typing (e.g. meeting chat).
      if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
      const k = e.key.toLowerCase();
      if (k in this.keys) { this.keys[k] = true; e.preventDefault(); }
      if (e.key === 'ArrowLeft') this.keys.a = true;
      if (e.key === 'ArrowRight') this.keys.d = true;
      if (e.key === 'ArrowUp') this.keys.w = true;
      if (e.key === 'ArrowDown') this.keys.s = true;
    });
    window.addEventListener('keyup', (e) => {
      const k = e.key.toLowerCase();
      if (k in this.keys) this.keys[k] = false;
      if (e.key === 'ArrowLeft') this.keys.a = false;
      if (e.key === 'ArrowRight') this.keys.d = false;
      if (e.key === 'ArrowUp') this.keys.w = false;
      if (e.key === 'ArrowDown') this.keys.s = false;
    });
    window.addEventListener('blur', () => {
      this.keys = { w: false, a: false, s: false, d: false };
    });
  }

  update(/* dt */) {
    let dx = 0, dy = 0;
    if (this.keys.a) dx -= 1;
    if (this.keys.d) dx += 1;
    if (this.keys.w) dy -= 1;
    if (this.keys.s) dy += 1;
    this.player.setIntent(dx, dy);
  }
}

