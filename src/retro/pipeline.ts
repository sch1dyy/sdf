import * as THREE from 'three';

/** Shorter screen edge in internal pixels, roughly a PS2 frame. */
const TARGET_LINES = 540;

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const PREFILTER = /* glsl */ `
uniform sampler2D tInput;
uniform float uThreshold;
varying vec2 vUv;
void main() {
  vec3 c = min(texture2D(tInput, vUv).rgb, vec3(6.0));
  float l = max(c.r, max(c.g, c.b));
  gl_FragColor = vec4(c * smoothstep(uThreshold, uThreshold * 2.5, l), 1.0);
}`;

const BLUR = /* glsl */ `
uniform sampler2D tInput;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tInput, vUv).rgb * 0.227027;
  c += (texture2D(tInput, vUv + uDir * 1.384615).rgb + texture2D(tInput, vUv - uDir * 1.384615).rgb) * 0.316216;
  c += (texture2D(tInput, vUv + uDir * 3.230769).rgb + texture2D(tInput, vUv - uDir * 3.230769).rgb) * 0.070270;
  gl_FragColor = vec4(c, 1.0);
}`;

const FINAL = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tBloomNear;
uniform sampler2D tBloomFar;
uniform vec2 uRes;
uniform float uPx;
uniform float uTime;
uniform float uFade;
uniform float uExposure;
uniform float uBloom;
uniform float uAspect;
uniform vec2 uShake;
uniform vec3 uCut;      // direction of the cut (aspect-corrected, y up) and its half length
uniform vec3 uSlash;    // brightness, half width, how far along it has travelled
uniform float uDark;
uniform float uOpen;
uniform float uFlash;
uniform float uBlur;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// The PlayStation's 4x4 ordered dither table.
float psxDither(vec2 p) {
  const float m[16] = float[16](
    -4.0,  0.0, -3.0,  1.0,
     2.0, -2.0,  3.0, -1.0,
    -3.0,  1.0, -4.0,  0.0,
     3.0, -1.0,  2.0, -2.0);
  return m[int(mod(p.y, 4.0)) * 4 + int(mod(p.x, 4.0))];
}

void main() {
  // Every screen pixel inside a block reads the same low-res texel.
  vec2 cell = floor(gl_FragCoord.xy / uPx);
  vec2 uv = (cell + 0.5) / uRes + uShake;

  vec3 c;
  if (uBlur > 0.0) {
    // Smear along the cut while the blade is moving.
    vec2 stride = vec2(uCut.x / uAspect, uCut.y) * uBlur / 3.0;
    c = vec3(0.0);
    for (int i = -3; i <= 3; i++) c += texture2D(tScene, uv + stride * float(i)).rgb;
    c /= 7.0;
  } else {
    c = texture2D(tScene, uv).rgb;
  }
  c += (texture2D(tBloomNear, uv).rgb * 0.6 + texture2D(tBloomFar, uv).rgb * 0.9) * uBloom;

  c = 1.0 - exp(-c * uExposure);
  c = pow(c, vec3(1.0 / 2.2));

  vec2 q = (uv - 0.5) * vec2(1.0, 1.12);
  c *= mix(0.1, 1.0, smoothstep(0.82, 0.24, length(q)));
  c = mix(c, c * c * (3.0 - 2.0 * c), 0.35);
  c += vec3(0.008, 0.002, 0.012) * (1.0 - c);
  c *= uFade;

  if (uDark > 0.0 || uSlash.x > 0.0) {
    vec2 sp = (uv - 0.5) * vec2(uAspect, 1.0);
    float along = dot(sp, uCut.xy) / uCut.z;
    float across = abs(dot(sp, vec2(-uCut.y, uCut.x)));

    // Darkness that parts along the cut, its edge breaking up in blocks.
    float ragged = 1.0 + (hash(floor(cell / 4.0) + 3.0) - 0.5) * 0.5 + (hash(cell + 9.0) - 0.5) * 0.12;
    c *= 1.0 - uDark * step(uOpen * ragged, across);

    // The cut itself: a white blade of light, pointed at both ends, drawn corner to corner.
    float taper = pow(max(0.0, 1.0 - along * along), 0.6);
    float w = uSlash.y * taper;
    float core = smoothstep(w, w * 0.35, across) * step(0.00001, w);
    float halo = exp(-across / (w * 5.0 + 0.004)) * 0.55 * taper;
    float drawn = step(along, mix(-1.05, 1.05, uSlash.z));
    c += (vec3(1.6) * core + vec3(1.0, 0.55, 0.85) * halo) * drawn * uSlash.x;
  }
  c += uFlash;

  // Film grain, stepped in time so it reads as grain rather than static.
  float tick = floor(uTime * 10.0);
  c += (hash(cell + tick * 7.13) - 0.5) * 0.014;

  // 15-bit colour, dithered.
  vec3 c8 = clamp(c * 255.0 + psxDither(cell), 0.0, 255.0);
  c = floor(c8 / 8.0) * 8.0 / 248.0;

  // Faint screen-door between the big pixels, as on an old display.
  if (uPx >= 3.0) {
    vec2 f = fract(gl_FragCoord.xy / uPx);
    float gap = 1.0 - 1.0 / uPx;
    c *= 1.0 - 0.05 * max(step(gap, f.x), step(gap, f.y));
  }

  gl_FragColor = vec4(c, 1.0);
}`;

function target(depth: boolean): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(4, 4, {
    type: THREE.HalfFloatType,
    depthBuffer: depth,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
}

function material(fragmentShader: string, uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader, uniforms, depthTest: false, depthWrite: false });
}

/**
 * Renders the scene at a PS2-like resolution, adds a soft bloom, then scales it up with
 * 15-bit dithered colour, grain and a vignette.
 */
export class RetroPipeline {
  readonly internal = new THREE.Vector2(480, 270);
  fade = 0;

  /** Screen-space effects for the drawing of the sword. All zero the rest of the time. */
  readonly fx = {
    /** Black laid over the picture. */
    dark: 0,
    /** How far that black has parted either side of the cut, in screen heights. */
    open: 0,
    /** Brightness of the white cut, its half width, and how far along it has been drawn. */
    slash: 0,
    slashWidth: 0,
    slashProgress: 0,
    flash: 0,
    /** Smear along the cut, in screen heights. */
    blur: 0,
    shake: new THREE.Vector2(),
  };

  private readonly sceneRT = target(true);
  private readonly half = [target(false), target(false)];
  private readonly quarter = [target(false), target(false)];
  private readonly fsScene = new THREE.Scene();
  private readonly fsCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quad: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;

  private readonly prefilter = material(PREFILTER, {
    tInput: { value: null },
    uThreshold: { value: 0.55 },
  });
  private readonly blur = material(BLUR, {
    tInput: { value: null },
    uDir: { value: new THREE.Vector2() },
  });
  private readonly final = material(FINAL, {
    tScene: { value: this.sceneRT.texture },
    tBloomNear: { value: this.half[0].texture },
    tBloomFar: { value: this.quarter[0].texture },
    uRes: { value: new THREE.Vector2(480, 270) },
    uPx: { value: 4 },
    uTime: { value: 0 },
    uFade: { value: 0 },
    uExposure: { value: 1.15 },
    uBloom: { value: 0.75 },
    uAspect: { value: 16 / 9 },
    uShake: { value: this.fx.shake },
    uCut: { value: new THREE.Vector3(-1, 0, 1) },
    uSlash: { value: new THREE.Vector3() },
    uDark: { value: 0 },
    uOpen: { value: 0 },
    uFlash: { value: 0 },
    uBlur: { value: 0 },
  });

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.final);
    this.quad.frustumCulled = false;
    this.fsScene.add(this.quad);
  }

  /** Sizes the internal buffers for a drawing buffer of the given size (in device pixels). */
  setSize(width: number, height: number, sharp = false): void {
    // "sharp" renders close to full resolution, for inspecting the character up close.
    const px = sharp ? Math.max(1, Math.round(Math.min(width, height) / 1000)) : Math.max(2, Math.round(Math.min(width, height) / TARGET_LINES));
    const w = Math.ceil(width / px);
    const h = Math.ceil(height / px);
    this.internal.set(w, h);
    this.sceneRT.setSize(w, h);
    for (const rt of this.half) rt.setSize(Math.ceil(w / 2), Math.ceil(h / 2));
    for (const rt of this.quarter) rt.setSize(Math.ceil(w / 4), Math.ceil(h / 4));
    this.final.uniforms.uRes.value.set(w, h);
    this.final.uniforms.uPx.value = px;

    // The cut runs from the upper right to the lower left, a little flatter than the
    // screen's own diagonal, and comes to a point just past the edges.
    const aspect = w / h;
    const angle = Math.atan2(1, aspect) * 0.8;
    const reach = Math.min(aspect / 2 / Math.cos(angle), 0.5 / Math.sin(angle)) * 1.04;
    this.final.uniforms.uAspect.value = aspect;
    this.final.uniforms.uCut.value.set(-Math.cos(angle), -Math.sin(angle), reach);
  }

  render(scene: THREE.Scene, camera: THREE.Camera, time: number): void {
    const r = this.renderer;
    r.setRenderTarget(this.sceneRT);
    r.render(scene, camera);

    this.prefilter.uniforms.tInput.value = this.sceneRT.texture;
    this.pass(this.prefilter, this.half[0]);
    this.blurPair(this.half, 1);
    this.blurInto(this.half[0], this.quarter[0], 0, 0);
    this.blurPair(this.quarter, 1);
    this.blurPair(this.quarter, 1.6);

    const u = this.final.uniforms;
    u.uTime.value = time;
    u.uFade.value = this.fade;
    u.uSlash.value.set(this.fx.slash, this.fx.slashWidth, this.fx.slashProgress);
    u.uDark.value = this.fx.dark;
    u.uOpen.value = this.fx.open;
    u.uFlash.value = this.fx.flash;
    u.uBlur.value = this.fx.blur;
    this.pass(this.final, null);
  }

  private blurPair(pair: THREE.WebGLRenderTarget[], spread: number): void {
    this.blurInto(pair[0], pair[1], spread / pair[0].width, 0);
    this.blurInto(pair[1], pair[0], 0, spread / pair[0].height);
  }

  private blurInto(from: THREE.WebGLRenderTarget, to: THREE.WebGLRenderTarget, dx: number, dy: number): void {
    this.blur.uniforms.tInput.value = from.texture;
    this.blur.uniforms.uDir.value.set(dx, dy);
    this.pass(this.blur, to);
  }

  private pass(mat: THREE.ShaderMaterial, to: THREE.WebGLRenderTarget | null): void {
    this.quad.material = mat;
    this.renderer.setRenderTarget(to);
    this.renderer.render(this.fsScene, this.fsCamera);
  }
}
