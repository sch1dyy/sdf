import * as THREE from 'three';
import type { Music } from './audio/music';
import type { RetroPipeline } from './retro/pipeline';
import type { KatanaRig } from './scene/katana';
import * as tex from './scene/textures';
import { clamp, easeInOutCubic, lerp, smoothstep } from './util/math';

// When the sword is clicked it is drawn from the stone, hangs in a darkness of its own
// making, and cuts the screen in two. The whole sequence is a function of one clock, so
// the sword's pose can be worked out for any moment: the motion trail relies on that.

// Timeline, in seconds from the click.
const T_PULL = 1.3; // the camera has closed in and the sword starts to rise
const T_FREE = 4.9; // it leaves the stone
const T_SLASH = 6.7; // the cut begins
const SLASH = 0.17;
const T_IMPACT = T_SLASH + 0.11; // the white line opens
const T_RESET = 7.3; // unseen, everything is put back
const T_OPEN = 7.9; // the darkness starts to part along the cut
const T_CLEAR = 10.2;
const T_END = 10.8;
/** Moments in the pull, as fractions of it, where the blade slips against the stone. */
const JOLTS = [0.22, 0.45, 0.66];
const JOLT_STEP = 0.045;

const TRAIL_STEPS = 16;
const TRAIL_WINDOW = 0.085;
const MAX_PARTICLES = 260;
/** After the scenery and before the sword, which uses SWORD_RENDER_ORDER. */
const VOID_RENDER_ORDER = 5;
const UP = new THREE.Vector3(0, 1, 0);

const enum Kind {
  Dust,
  Spark,
  Mote,
}

/** A way of holding the sword, in camera space: where the grip is and how the sword is turned. */
interface Stance {
  grip: THREE.Vector3;
  quat: THREE.Quaternion;
}

/** `dir` runs from grip to tip; `edge` is the way the cutting edge faces. */
function stance(grip: number[], dir: number[], edge: number[]): Stance {
  const y = new THREE.Vector3(dir[0], dir[1], dir[2]).normalize().negate();
  const e = new THREE.Vector3(edge[0], edge[1], edge[2]);
  const z = e.addScaledVector(y, -e.dot(y)).normalize();
  const x = new THREE.Vector3().crossVectors(y, z);
  return {
    grip: new THREE.Vector3(grip[0], grip[1], grip[2]),
    quat: new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z)),
  };
}

// The camera looks down -Z. The sword hangs upright before it, draws back over the right
// shoulder, then comes round and down to the lower left, toward the viewer.
const HOVER = stance([0.3, -0.62, -3.9], [-0.32, 0.93, 0.18], [-0.9, -0.3, 0.3]);
const WINDUP = stance([0.66, -0.2, -4.1], [0.45, 0.85, -0.25], [-0.85, 0.45, 0.1]);
const END = stance([-0.7, -0.72, -1.45], [-0.75, -0.6, 0.3], [0.6, -0.75, 0.1]);
const SWEEP_MID = new THREE.Vector3(0.25, 0.05, -2.3);

const POINT_VERT = /* glsl */ `
attribute vec3 aColor;
attribute float aSize;
uniform float uScale;
varying vec3 vColor;
void main() {
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(aSize * uScale / -mv.z, 1.0, 10.0);
}`;

const POINT_FRAG = /* glsl */ `
varying vec3 vColor;
void main() {
  vec2 q = gl_PointCoord - 0.5;
  gl_FragColor = vec4(vColor * smoothstep(0.5, 0.0, abs(q.x) + abs(q.y)) * 2.0, 1.0);
}`;

export class Cinematic {
  active = false;
  /** Seconds since the click. */
  time = 0;
  /** Time scale; 0 holds the sequence on its current frame. */
  speed = 1;

  // Read by the frame loop.
  readonly camPos = new THREE.Vector3();
  readonly camLook = new THREE.Vector3();
  /** 0 leaves the camera to the scene, 1 hands it over entirely. */
  camWeight = 0;
  /** After the cut the camera eases home from a pose worked out from the scene's own rig. */
  returning = false;
  roll = 0;
  fovScale = 1;
  /** How much of the shrine's own haze and light shafts is left: 1 normally, 0 in the dark. */
  dim = 1;
  /** Extra brightness for the light over the sword. */
  pulse = 0;

  /** Called in the dark, once the sword is back: the place to reset the camera's orbit. */
  onReset: () => void = () => {};
  onEnd: () => void = () => {};

  private prev = 0;
  private step = 0;
  private azimuth = 0;
  private narrow = 1;
  private shake = 0;
  private readonly axis = new THREE.Vector3();
  private readonly travel: number;

  private readonly pos = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly posA = new THREE.Vector3();
  private readonly quatA = new THREE.Quaternion();
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  private readonly euler = new THREE.Euler();
  private readonly sweep: Stance = { grip: new THREE.Vector3(), quat: new THREE.Quaternion() };

  private readonly darkness: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly glow: THREE.Sprite;
  private readonly light: THREE.PointLight;
  private readonly trail: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private readonly points: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;

  private readonly pPos = new Float32Array(MAX_PARTICLES * 3);
  private readonly pVel = new Float32Array(MAX_PARTICLES * 3);
  private readonly pBase = new Float32Array(MAX_PARTICLES * 3);
  private readonly pColor = new Float32Array(MAX_PARTICLES * 3);
  private readonly pSize = new Float32Array(MAX_PARTICLES);
  private readonly pLife = new Float32Array(MAX_PARTICLES);
  private readonly pSpan = new Float32Array(MAX_PARTICLES);
  private readonly pKind = new Uint8Array(MAX_PARTICLES);
  private cursor = 0;
  private dustDebt = 0;
  private moteDebt = 0;

  constructor(
    scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly katana: KatanaRig,
    private readonly pipeline: RetroPipeline,
    private readonly music: Music,
    /** Reduced motion: no shake, and a much gentler flash. */
    private readonly calm: boolean,
  ) {
    // Far enough for the point to clear the stone.
    this.travel = katana.buried + 0.1;

    // A black veil over the scenery. It sits in the solid pass, drawn after everything but
    // the sword, so the sword alone stays lit.
    this.darkness = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        uniforms: { uAmount: { value: 0 } },
        vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: 'uniform float uAmount; void main() { gl_FragColor = vec4(0.0, 0.0, 0.0, uAmount); }',
        blending: THREE.CustomBlending,
        blendSrc: THREE.ZeroFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.darkness.frustumCulled = false;
    this.darkness.renderOrder = VOID_RENDER_ORDER;
    this.darkness.visible = false;

    this.glow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: tex.glow(),
        color: 0xe04ab8,
        blending: THREE.AdditiveBlending,
        transparent: true,
        opacity: 0,
        depthTest: false,
        depthWrite: false,
        fog: false,
      }),
    );
    this.glow.scale.setScalar(2.8);
    // After the shrine's own see-through pieces, which would otherwise dim it.
    this.glow.renderOrder = 20;
    this.glow.visible = false;

    this.light = new THREE.PointLight(0xff6ab8, 0, 8, 2);

    const trail = new THREE.BufferGeometry();
    trail.setAttribute('position', new THREE.BufferAttribute(new Float32Array((TRAIL_STEPS + 1) * 6), 3));
    trail.setAttribute('color', new THREE.BufferAttribute(new Float32Array((TRAIL_STEPS + 1) * 6), 3));
    const index: number[] = [];
    for (let i = 0; i < TRAIL_STEPS; i++) index.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    trail.setIndex(index);
    this.trail = new THREE.Mesh(
      trail,
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      }),
    );
    this.trail.frustumCulled = false;
    this.trail.renderOrder = 21;
    this.trail.visible = false;

    const cloud = new THREE.BufferGeometry();
    cloud.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    cloud.setAttribute('aColor', new THREE.BufferAttribute(this.pColor, 3));
    cloud.setAttribute('aSize', new THREE.BufferAttribute(this.pSize, 1));
    this.points = new THREE.Points(
      cloud,
      new THREE.ShaderMaterial({
        uniforms: { uScale: { value: 440 } },
        vertexShader: POINT_VERT,
        fragmentShader: POINT_FRAG,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
      }),
    );
    this.points.frustumCulled = false;
    this.points.renderOrder = 21;
    this.points.visible = false;

    scene.add(this.darkness, this.glow, this.light, this.trail, this.points);
  }

  /** Low-res pixels per world unit at distance 1, so sparks keep their apparent size. */
  setPixelScale(scale: number): void {
    this.points.material.uniforms.uScale.value = scale;
  }

  /** Begins the sequence. Returns false if it is already running. */
  start(): boolean {
    if (this.active) return false;
    this.active = true;
    this.time = this.prev = 0;
    this.returning = false;
    this.shake = this.pulse = 0;
    this.azimuth = Math.atan2(this.camera.position.x, this.camera.position.z);
    // On a tall screen the stances are drawn in toward the middle.
    this.narrow = clamp(this.camera.aspect / 1.3, 0.55, 1);
    this.axis.copy(UP).applyQuaternion(this.katana.rest.quaternion);
    this.points.visible = true;
    this.music.duck(0.3, 0.6);
    this.music.sfx('focus');
    return true;
  }

  /** Advances the clock and decides where the camera goes. Call before placing the camera. */
  advance(dt: number): void {
    if (!this.active) return;
    this.step = Math.min(dt, 0.05) * this.speed;
    this.prev = this.time;
    this.time += this.step;
    const t = this.time;

    if (t >= T_RESET) {
      this.returning = true;
      this.roll = 0;
      this.fovScale = 1;
      this.camWeight = 1 - easeInOutCubic(clamp((t - T_OPEN) / (T_END - T_OPEN), 0, 1));
      return;
    }

    // Close in low while the sword is drawn, then fall back to take in the whole blade.
    const pull = smoothstep(0, T_FREE, t);
    const free = easeInOutCubic(clamp((t - T_FREE) / 1.1, 0, 1));
    const az = this.azimuth + 0.3 * pull + 0.1 * free;
    const dist = lerp(lerp(2.9, 2.4, pull), 4.05, free);
    this.camPos.set(Math.sin(az) * dist, lerp(lerp(1.12, 1.3, pull), 1.75, free), Math.cos(az) * dist);
    this.camLook.set(0, lerp(lerp(0.98, 1.2, pull), 1.9, free), 0);

    // The camera is carried a little way along the cut.
    const follow = smoothstep(T_SLASH, T_SLASH + SLASH, t);
    this.camLook.x -= Math.cos(az) * 0.35 * follow;
    this.camLook.z += Math.sin(az) * 0.35 * follow;
    this.camLook.y -= 0.22 * follow;
    this.roll = 0.09 * follow;
    this.fovScale = 1 + 0.07 * follow;
    this.camWeight = easeInOutCubic(clamp(t / T_PULL, 0, 1));
  }

  /** Moves the sword and drives the effects. Call once the camera has been placed. */
  apply(): void {
    if (!this.active) return;
    const k = this.katana;
    const t = this.time;
    const dt = this.step;
    const crossed = (at: number) => this.prev < at && t >= at;
    const slit = k.rest.position;

    if (crossed(T_PULL)) this.music.sfx('scrape', T_FREE - T_PULL);
    for (const j of JOLTS) {
      if (!crossed(T_PULL + j * (T_FREE - T_PULL))) continue;
      this.emit(Kind.Spark, slit, 9);
      this.emit(Kind.Dust, slit, 8);
      this.pulse = 0.5;
      this.shake = Math.max(this.shake, 0.0025);
      this.music.sfx('jolt');
    }
    if (crossed(T_FREE)) {
      this.emit(Kind.Spark, slit, 42);
      this.emit(Kind.Dust, slit, 30, 0.12);
      this.pulse = 1.4;
      this.shake = 0.008;
      k.flare(1);
      this.music.sfx('draw');
    }
    if (crossed(T_FREE + 0.15)) this.music.sfx('riser', T_SLASH - T_FREE - 0.3);
    if (crossed(T_IMPACT)) {
      this.shake = 0.03;
      this.music.sfx('slash');
    }
    if (crossed(T_RESET)) this.reset();
    if (crossed(T_OPEN)) {
      k.flare(0.8);
      this.music.sfx('return');
      this.music.duck(1, 2.5);
    }
    if (t >= T_END) {
      this.finish();
      return;
    }

    // ── The sword ──────────────────────────────────────────
    const before = t < T_RESET;
    const shown = t < T_IMPACT + 0.06; // after that it is lost in the flash
    let veil = 0;
    if (before) {
      this.poseAt(t, this.pos, this.quat);
      k.setPose(this.pos, this.quat);
      k.setVisible(shown);

      if (t > T_FREE && t < T_FREE + 0.6) {
        const g = (t - T_FREE) / 0.6;
        k.setGleam(1 - g, Math.sin(Math.PI * g) * 1.5);
      } else if (t > T_SLASH - 0.34 && t < T_SLASH) {
        const g = (t - T_SLASH + 0.34) / 0.34;
        k.setGleam(g * 1.05, Math.sin(Math.PI * g) * 1.8);
      } else {
        k.setGleam(0, 0);
      }

      // The shrine sinks into the dark as the blade comes up.
      if (t < T_PULL) veil = 0.3 * smoothstep(0, T_PULL, t);
      else if (t < T_FREE) veil = lerp(0.3, 0.9, Math.pow((t - T_PULL) / (T_FREE - T_PULL), 1.7));
      else veil = lerp(0.9, 1, smoothstep(T_FREE, T_FREE + 0.5, t));
    }
    this.darkness.material.uniforms.uAmount.value = veil;
    this.darkness.visible = veil > 0;
    this.dim = 1 - veil;

    // Its own pink-violet light, once the lamps are gone.
    const lit = before && shown ? smoothstep(0.25, 1, veil) : 0;
    this.glow.visible = lit > 0;
    if (lit > 0) {
      const collar = this.tmp.copy(k.points.collar).applyQuaternion(this.quat).add(this.pos);
      const tip = this.tmp2.copy(k.points.tip).applyQuaternion(this.quat).add(this.pos);
      this.glow.position.lerpVectors(collar, tip, 0.4);
      this.glow.material.opacity = 0.15 * lit;
      this.light.position.copy(this.glow.position).lerp(this.camera.position, 0.25);
      this.light.position.y += 0.3;

      if (t > T_FREE) {
        this.moteDebt += dt * 34;
        while (this.moteDebt >= 1) {
          this.moteDebt -= 1;
          this.emit(Kind.Mote, this.posA.lerpVectors(collar, tip, Math.random()), 1, 0.16);
        }
      }
    }
    this.light.intensity = 8 * lit;

    if (t > T_PULL && t < T_FREE) {
      this.dustDebt += dt * 16;
      while (this.dustDebt >= 1) {
        this.dustDebt -= 1;
        this.emit(Kind.Dust, slit, 1);
      }
    }
    this.simulate(dt);
    this.drawTrail(t);

    // ── The screen ─────────────────────────────────────────
    const fx = this.pipeline.fx;
    const since = t - T_IMPACT;
    this.shake *= Math.exp(-dt * 7);
    this.pulse *= Math.exp(-dt * 3);
    const shake = this.calm ? 0 : this.shake;
    fx.shake.set(Math.sin(t * 91.7) * shake, Math.cos(t * 77.3) * shake);
    fx.blur = t > T_SLASH && since < 0.06 ? 0.05 * smoothstep(T_SLASH, T_IMPACT, t) : 0;

    if (since < 0) {
      fx.flash = fx.dark = fx.open = fx.slash = 0;
    } else {
      const flash = since < 0.045 ? since / 0.045 : Math.exp(-(since - 0.045) * 8);
      fx.flash = flash * (this.calm ? 0.25 : 1);
      // Black from the peak of the flash until the opening has cleared the corners.
      fx.dark = since >= 0.045 && t < T_CLEAR ? 1 : 0;
      fx.open = 1.3 * Math.pow(clamp((t - T_OPEN) / (T_CLEAR - T_OPEN), 0, 1), 1.8);
      fx.slashProgress = clamp(since / 0.08, 0, 1);
      fx.slashWidth = 0.0035 + 0.03 * Math.exp(-since * 3.4);
      fx.slash = 1.5 * (1 - smoothstep(T_OPEN, T_OPEN + 1.4, t));
    }
  }

  /**
   * Where the sword is at moment t, in world space. From the moment it floats free this
   * depends on where the camera currently is.
   */
  private poseAt(t: number, pos: THREE.Vector3, quat: THREE.Quaternion): void {
    const rest = this.katana.rest;

    // Rising out of the stone: a slow strain, three slips, then it gives.
    const u = clamp((t - T_PULL) / (T_FREE - T_PULL), 0, 1);
    let rise = 0.42 * u + (0.58 - JOLT_STEP * JOLTS.length) * Math.pow(clamp((u - 0.78) / 0.22, 0, 1), 2);
    for (const j of JOLTS) rise += JOLT_STEP * smoothstep(j, j + 0.035, u);
    const after = Math.max(0, t - T_FREE);
    pos.copy(rest.position).addScaledVector(this.axis, rise * this.travel).addScaledVector(UP, 0.5 * (1 - Math.exp(-after * 2.4)));

    // It shudders against the stone, harder the nearer it is to coming free.
    const strain = t > T_PULL && t < T_FREE ? 0.003 + 0.011 * u : 0;
    this.euler.set(strain * (Math.sin(t * 47) + Math.sin(t * 31.7 + 1)) * 0.5, 0, strain * (Math.sin(t * 53 + 2) + Math.sin(t * 29.3)) * 0.5);
    quat.setFromEuler(this.euler).multiply(rest.quaternion);
    if (t <= T_FREE) return;

    // Free: it drifts up to hang before the camera, then draws back.
    const v = clamp((t - T_FREE) / (T_SLASH - T_FREE), 0, 1);
    this.toWorld(HOVER, this.posA, this.quatA);
    const hover = easeInOutCubic(clamp(v / 0.62, 0, 1));
    pos.lerp(this.posA, hover);
    quat.slerp(this.quatA, hover);
    const draw = smoothstep(0.7, 0.94, v);
    if (draw > 0) {
      this.toWorld(WINDUP, this.posA, this.quatA);
      pos.lerp(this.posA, draw);
      quat.slerp(this.quatA, draw);
    }
    if (t <= T_SLASH) return;

    // The cut: the grip arcs toward the viewer while the blade swings through half a turn.
    const s = clamp((t - T_SLASH) / SLASH, 0, 1);
    const p = s * s * (3 - 2 * s);
    const q = 1 - p;
    this.sweep.grip.copy(WINDUP.grip).multiplyScalar(q * q).addScaledVector(SWEEP_MID, 2 * q * p).addScaledVector(END.grip, p * p);
    this.sweep.quat.copy(WINDUP.quat).slerp(END.quat, p);
    this.toWorld(this.sweep, pos, quat);
  }

  private toWorld(s: Stance, pos: THREE.Vector3, quat: THREE.Quaternion): void {
    quat.copy(this.camera.quaternion).multiply(s.quat);
    this.tmp.copy(s.grip);
    this.tmp.x *= this.narrow;
    this.tmp.applyMatrix4(this.camera.matrixWorld);
    pos.copy(this.katana.points.grip).applyQuaternion(quat).negate().add(this.tmp);
  }

  /** The smear behind the blade: the surface it has swept over the last few hundredths of a second. */
  private drawTrail(t: number): void {
    const on = t > T_SLASH && t < T_IMPACT + 0.06;
    this.trail.visible = on;
    if (!on) return;
    const position = this.trail.geometry.getAttribute('position') as THREE.BufferAttribute;
    const color = this.trail.geometry.getAttribute('color') as THREE.BufferAttribute;
    const { collar, tip } = this.katana.points;
    for (let i = 0; i <= TRAIL_STEPS; i++) {
      const age = i / TRAIL_STEPS;
      this.poseAt(Math.max(T_SLASH, t - age * TRAIL_WINDOW), this.pos, this.quat);
      this.tmp.copy(collar).applyQuaternion(this.quat).add(this.pos);
      this.tmp2.copy(tip).applyQuaternion(this.quat).add(this.pos);
      position.setXYZ(i * 2, this.tmp.x, this.tmp.y, this.tmp.z);
      position.setXYZ(i * 2 + 1, this.tmp2.x, this.tmp2.y, this.tmp2.z);
      // White at the blade, falling away to pink; brightest along the path of the point.
      const fade = Math.pow(1 - age, 1.6) * 1.8;
      color.setXYZ(i * 2, fade * 0.45, fade * 0.45 * lerp(1, 0.5, age), fade * 0.45 * lerp(1, 0.8, age));
      color.setXYZ(i * 2 + 1, fade, fade * lerp(1, 0.5, age), fade * lerp(1, 0.8, age));
    }
    position.needsUpdate = true;
    color.needsUpdate = true;
    // The loop above borrowed the pose scratch; put the present pose back.
    this.poseAt(t, this.pos, this.quat);
  }

  private emit(kind: Kind, at: THREE.Vector3, count: number, spread = 0.06): void {
    for (let n = 0; n < count; n++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % MAX_PARTICLES;
      const a = Math.random() * Math.PI * 2;
      const r = Math.random();
      const rnd = Math.random;
      this.pKind[i] = kind;
      this.pPos[i * 3] = at.x + Math.cos(a) * spread * r;
      this.pPos[i * 3 + 1] = at.y + (kind === Kind.Mote ? (rnd() - 0.5) * spread : 0.012);
      this.pPos[i * 3 + 2] = at.z + Math.sin(a) * spread * r;
      let speed = 0;
      let lift = 0;
      let span = 1;
      if (kind === Kind.Dust) {
        speed = 0.1 + r * 0.35;
        lift = 0.15 + rnd() * 0.45;
        span = 1.3 + rnd();
        this.pSize[i] = 0.035 + rnd() * 0.03;
        this.pBase.set([0.44, 0.3, 0.42], i * 3);
      } else if (kind === Kind.Spark) {
        speed = 0.6 + rnd() * 1.8;
        lift = 0.9 + rnd() * 2.2;
        span = 0.35 + rnd() * 0.5;
        this.pSize[i] = 0.016 + rnd() * 0.01;
        this.pBase.set([2.2, 1.3 + rnd() * 0.6, 0.9 + rnd() * 0.5], i * 3);
      } else {
        speed = rnd() * 0.07;
        lift = 0.06 + rnd() * 0.2;
        span = 1.2 + rnd();
        this.pSize[i] = 0.022 + rnd() * 0.02;
        this.pBase.set(rnd() < 0.5 ? [1.6, 0.5, 1.0] : [0.9, 0.6, 1.7], i * 3);
      }
      this.pVel[i * 3] = Math.cos(a) * speed;
      this.pVel[i * 3 + 1] = lift;
      this.pVel[i * 3 + 2] = Math.sin(a) * speed;
      this.pLife[i] = this.pSpan[i] = span;
    }
  }

  private simulate(dt: number): void {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (this.pLife[i] <= 0) continue;
      this.pLife[i] -= dt;
      const j = i * 3;
      if (this.pLife[i] <= 0) {
        this.pColor[j] = this.pColor[j + 1] = this.pColor[j + 2] = 0;
        continue;
      }
      const kind = this.pKind[i];
      const gravity = kind === Kind.Spark ? -4.5 : kind === Kind.Dust ? -0.12 : 0.03;
      const keep = 1 - Math.min(1, (kind === Kind.Spark ? 0.6 : 1.4) * dt);
      this.pVel[j] *= keep;
      this.pVel[j + 1] = this.pVel[j + 1] * keep + gravity * dt;
      this.pVel[j + 2] *= keep;
      this.pPos[j] += this.pVel[j] * dt;
      this.pPos[j + 1] += this.pVel[j + 1] * dt;
      this.pPos[j + 2] += this.pVel[j + 2] * dt;

      const left = this.pLife[i] / this.pSpan[i];
      const fade = kind === Kind.Spark ? Math.sqrt(left) : kind === Kind.Dust ? Math.min(1, (1 - left) * 6) * left : Math.sin(Math.PI * left);
      this.pColor[j] = this.pBase[j] * fade;
      this.pColor[j + 1] = this.pBase[j + 1] * fade;
      this.pColor[j + 2] = this.pBase[j + 2] * fade;
    }
    const g = this.points.geometry;
    g.getAttribute('position').needsUpdate = true;
    g.getAttribute('aColor').needsUpdate = true;
    g.getAttribute('aSize').needsUpdate = true;
  }

  /** Puts the shrine back as it was, behind the black. */
  private reset(): void {
    this.katana.release();
    this.pLife.fill(0);
    this.pColor.fill(0);
    this.trail.visible = false;
    this.glow.visible = false;
    this.light.intensity = 0;
    this.dustDebt = this.moteDebt = 0;
    this.onReset();
  }

  private finish(): void {
    const fx = this.pipeline.fx;
    fx.dark = fx.open = fx.slash = fx.flash = fx.blur = 0;
    fx.shake.set(0, 0);
    this.active = false;
    this.returning = false;
    this.camWeight = 0;
    this.dim = 1;
    this.pulse = 0;
    this.points.visible = false;
    this.darkness.visible = false;
    this.onEnd();
  }
}
