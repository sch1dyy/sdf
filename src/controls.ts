import { clamp, damp } from './util/math';

export const DIST_MIN = 2.2;
export const DIST_MAX = 6.4;
const DIST_DEFAULT = 4.1;
const ELEV_MIN = -0.1;
const ELEV_MAX = 0.62;
const AUTO_AFTER = 4; // seconds of stillness before the sword turns by itself again

/** Drag to turn the sword, drag vertically to raise the camera, wheel or pinch to move closer. */
export class Controls {
  yaw = 0.65;
  yawVel = 0;
  elev = 0.05;
  dist = DIST_DEFAULT;
  enabled = false;
  /** Mouse position in -1..1, for a slight parallax. */
  pointerX = 0;
  pointerY = 0;
  onTap: () => void = () => {};
  onFirstDrag: () => void = () => {};

  private elevTarget = this.elev;
  private distTarget = this.dist;
  private dragging = false;
  private idle = 99;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinch = 0;
  private travel = 0;
  private downAt = 0;
  private lastMove = 0;
  private dragged = false;

  constructor(private readonly el: HTMLElement) {
    el.addEventListener('pointerdown', this.down);
    el.addEventListener('pointermove', this.move);
    el.addEventListener('pointerup', this.up);
    el.addEventListener('pointercancel', this.up);
    el.addEventListener('wheel', this.wheel, { passive: true });
    el.addEventListener('keydown', this.key);
    window.addEventListener(
      'pointermove',
      (e) => {
        if (e.pointerType !== 'mouse') return;
        this.pointerX = (e.clientX / window.innerWidth) * 2 - 1;
        this.pointerY = (e.clientY / window.innerHeight) * 2 - 1;
      },
      { passive: true },
    );
  }

  update(dt: number, autoSpeed: number): void {
    this.idle += dt;
    if (this.dragging) {
      // Holding still while pressed should not leave a stale spin behind.
      if (performance.now() - this.lastMove > 60) this.yawVel *= 1 - damp(12, dt);
    } else {
      const resting = this.idle > AUTO_AFTER;
      this.yawVel += ((resting ? autoSpeed : 0) - this.yawVel) * damp(resting ? 0.9 : 2.2, dt);
      this.yaw += this.yawVel * dt;
    }
    this.elev += (this.elevTarget - this.elev) * damp(7, dt);
    this.dist += (this.distTarget - this.dist) * damp(6, dt);
  }

  private down = (e: PointerEvent): void => {
    if (!this.enabled) return;
    // Capture keeps the drag alive when the pointer leaves the canvas; it is optional.
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      /* pointer already gone */
    }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.pinch = 0;
    if (this.pointers.size === 1) {
      this.dragging = true;
      this.travel = 0;
      this.downAt = this.lastMove = performance.now();
      this.yawVel = 0;
      this.el.classList.add('is-dragging');
    }
    this.idle = 0;
  };

  private move = (e: PointerEvent): void => {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    this.idle = 0;

    if (this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.pinch > 0 && d > 0) this.distTarget = clamp(this.distTarget * (this.pinch / d), DIST_MIN, DIST_MAX);
      this.pinch = d;
      this.travel += 100;
      return;
    }

    // A full-width drag is a little under one turn on desktop, a bit more on a phone.
    const perPixel = 5.5 / Math.max(window.innerWidth, 600);
    const now = performance.now();
    const elapsed = Math.max(8, now - this.lastMove) / 1000;
    this.lastMove = now;
    this.yaw += dx * perPixel;
    this.yawVel = clamp(this.yawVel * 0.6 + ((dx * perPixel) / elapsed) * 0.4, -14, 14);
    this.elevTarget = clamp(this.elevTarget + dy * 0.0035, ELEV_MIN, ELEV_MAX);
    this.travel += Math.abs(dx) + Math.abs(dy);
    if (!this.dragged && this.travel > 12) {
      this.dragged = true;
      this.onFirstDrag();
    }
  };

  private up = (e: PointerEvent): void => {
    if (!this.pointers.delete(e.pointerId)) return;
    this.pinch = 0;
    if (this.pointers.size > 0) return;
    this.dragging = false;
    this.el.classList.remove('is-dragging');
    const now = performance.now();
    if (now - this.lastMove > 90) this.yawVel = 0;
    if (e.type === 'pointerup' && this.travel < 6 && now - this.downAt < 350) this.onTap();
  };

  private wheel = (e: WheelEvent): void => {
    if (!this.enabled) return;
    this.distTarget = clamp(this.distTarget * Math.exp(e.deltaY * 0.0011), DIST_MIN, DIST_MAX);
    this.idle = Math.min(this.idle, AUTO_AFTER - 1.5);
  };

  private key = (e: KeyboardEvent): void => {
    if (!this.enabled) return;
    switch (e.key) {
      case 'ArrowLeft':
        this.yawVel = -1.7;
        break;
      case 'ArrowRight':
        this.yawVel = 1.7;
        break;
      case 'ArrowUp':
        this.elevTarget = clamp(this.elevTarget + 0.08, ELEV_MIN, ELEV_MAX);
        break;
      case 'ArrowDown':
        this.elevTarget = clamp(this.elevTarget - 0.08, ELEV_MIN, ELEV_MAX);
        break;
      case '+':
      case '=':
        this.distTarget = clamp(this.distTarget * 0.88, DIST_MIN, DIST_MAX);
        break;
      case '-':
        this.distTarget = clamp(this.distTarget / 0.88, DIST_MIN, DIST_MAX);
        break;
      default:
        return;
    }
    e.preventDefault();
    this.idle = 0;
  };
}
