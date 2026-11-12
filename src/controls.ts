import { clamp, damp } from './util/math';

export interface Orbit {
  yaw: number;
  elev: number;
  dist: number;
}

export interface Limits {
  distMin: number;
  distMax: number;
  elevMin: number;
  elevMax: number;
}

/** Orbiting the sword. The far limit keeps the camera inside the ring where the figure stands. */
export const SCENE_LIMITS: Limits = { distMin: 2.2, distMax: 4.3, elevMin: -0.1, elevMax: 0.62 };
/** Orbiting the character while inspecting him. */
export const INSPECT_LIMITS: Limits = { distMin: 1.0, distMax: 4.2, elevMin: -0.12, elevMax: 0.9 };
export const SCENE_START: Orbit = { yaw: 0, elev: 0.05, dist: 4.1 };

/**
 * Orbit camera input: drag to circle the subject, drag vertically to raise the camera,
 * wheel or pinch to move closer. Nothing in the scene itself is moved.
 */
export class Controls {
  /** Angle of the camera around its subject, in radians. */
  yaw = SCENE_START.yaw;
  yawVel = 0;
  elev = SCENE_START.elev;
  dist = SCENE_START.dist;
  enabled = false;
  /** Mouse position in -1..1, for a slight parallax. */
  pointerX = 0;
  pointerY = 0;
  /** Last mouse position in client pixels, or null on touch screens. */
  hover: { x: number; y: number } | null = null;
  onTap: (x: number, y: number) => void = () => {};
  onFirstDrag: () => void = () => {};

  private limits = SCENE_LIMITS;
  private elevTarget = this.elev;
  private distTarget = this.dist;
  private dragging = false;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinch = 0;
  private travel = 0;
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
        this.hover = e.target === this.el ? { x: e.clientX, y: e.clientY } : null;
      },
      { passive: true },
    );
  }

  /** Where the camera is being steered to. */
  save(): Orbit {
    return { yaw: this.yaw, elev: this.elevTarget, dist: this.distTarget };
  }

  /** Points the controls at a different subject, with its own position and limits. */
  load(orbit: Orbit, limits: Limits): void {
    this.limits = limits;
    this.yaw = orbit.yaw;
    this.yawVel = 0;
    this.elev = this.elevTarget = orbit.elev;
    this.dist = this.distTarget = orbit.dist;
  }

  /** 0 at the far limit, 1 at the near one. */
  get closeness(): number {
    return 1 - (this.dist - this.limits.distMin) / (this.limits.distMax - this.limits.distMin);
  }

  get isDragging(): boolean {
    return this.dragging;
  }

  update(dt: number): void {
    if (this.dragging) {
      // Holding still while pressed should not leave a stale spin behind.
      if (performance.now() - this.lastMove > 60) this.yawVel *= 1 - damp(12, dt);
    } else {
      // After release the camera glides on and comes to rest.
      this.yaw += this.yawVel * dt;
      this.yawVel *= 1 - damp(2.4, dt);
    }
    this.elev += (this.elevTarget - this.elev) * damp(7, dt);
    this.dist += (this.distTarget - this.dist) * damp(6, dt);
  }

  private zoom(factor: number): void {
    this.distTarget = clamp(this.distTarget * factor, this.limits.distMin, this.limits.distMax);
  }

  private tilt(delta: number): void {
    this.elevTarget = clamp(this.elevTarget + delta, this.limits.elevMin, this.limits.elevMax);
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
      this.lastMove = performance.now();
      this.yawVel = 0;
      this.el.classList.add('is-dragging');
    }
  };

  private move = (e: PointerEvent): void => {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;

    if (this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.pinch > 0 && d > 0) this.zoom(this.pinch / d);
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
    this.yawVel = clamp(this.yawVel * 0.6 + ((dx * perPixel) / elapsed) * 0.4, -8, 8);
    this.tilt(dy * 0.0035);
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
    // A press that barely moved counts as a click, however long it was held; a drag never does.
    if (e.type === 'pointerup' && this.travel < 6) this.onTap(e.clientX, e.clientY);
  };

  private wheel = (e: WheelEvent): void => {
    if (this.enabled) this.zoom(Math.exp(e.deltaY * 0.0011));
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
        this.tilt(0.08);
        break;
      case 'ArrowDown':
        this.tilt(-0.08);
        break;
      case '+':
      case '=':
        this.zoom(0.88);
        break;
      case '-':
        this.zoom(1 / 0.88);
        break;
      default:
        return;
    }
    e.preventDefault();
  };
}
