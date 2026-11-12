import * as THREE from 'three';
import { mulberry32 } from '../util/math';
import * as tex from './textures';

const MOTE_VERT = /* glsl */ `
attribute vec4 aSeed;
uniform float uTime;
uniform float uScale;
uniform float uGain;
uniform float uDim;
uniform vec3 uMin;
uniform vec3 uSize;
uniform vec3 uDrift;
uniform float uSway;
uniform float uPoint;
uniform float uMaxPoint;
uniform float uBase;
uniform float uBeam;
varying float vAlpha;
varying float vMix;

void main() {
  vec3 p = position + uDrift * uTime * (0.5 + aSeed.x);
  p.x += sin(uTime * (0.2 + aSeed.y * 0.3) + aSeed.z * 6.283) * uSway;
  p.z += cos(uTime * (0.17 + aSeed.x * 0.25) + aSeed.w * 6.283) * uSway;
  p.y += sin(uTime * (0.3 + aSeed.w * 0.2) + aSeed.y * 6.283) * uSway * 0.5;
  // Wrap inside the volume so the air never empties.
  p = mod(p - uMin, uSize) + uMin;

  // Motes drifting through the shaft of light catch it.
  float beamRadius = mix(1.9, 0.3, clamp(p.y / 9.0, 0.0, 1.0));
  float lit = 1.0 - smoothstep(beamRadius * 0.5, beamRadius * 1.4, length(p.xz));
  float twinkle = 0.6 + 0.4 * sin(uTime * (1.0 + aSeed.z * 2.5) + aSeed.x * 40.0);
  float e = (p.y - uMin.y) / uSize.y;
  float edge = smoothstep(0.0, 0.08, e) * smoothstep(1.0, 0.9, e);

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float haze = exp(-0.0009 * mv.z * mv.z);
  vAlpha = (uBase + uBeam * lit * uGain) * twinkle * edge * haze * uDim;
  vMix = aSeed.z;
  gl_PointSize = clamp(uPoint * (0.6 + aSeed.y * 0.8) * uScale / -mv.z, 1.0, uMaxPoint);
}`;

const MOTE_FRAG = /* glsl */ `
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform float uSoft;
varying float vAlpha;
varying float vMix;
void main() {
  vec2 q = gl_PointCoord - 0.5;
  float falloff = smoothstep(0.5, 0.0, abs(q.x) + abs(q.y));
  gl_FragColor = vec4(mix(uColorA, uColorB, vMix) * vAlpha * mix(1.0, falloff * 2.0, uSoft), 1.0);
}`;

const SHAFT_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vView;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vNormal = normalMatrix * normal;
  vView = -mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;

const SHAFT_FRAG = /* glsl */ `
uniform float uTime;
uniform float uGain;
uniform float uDim;
uniform vec3 uTop;
uniform vec3 uBottom;
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vView;

float hash(float n) { return fract(sin(n) * 43758.5453); }
float noise(float x) {
  float i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(hash(i), hash(i + 1.0), f);
}

void main() {
  // Thin where the cone turns edge-on, so it has no hard silhouette.
  float facing = abs(dot(normalize(vNormal), normalize(vView)));
  float body = smoothstep(0.0, 0.85, facing);
  float rays = 0.35 + 1.3 * noise(vUv.x * 30.0 + uTime * 0.05) * noise(vUv.x * 11.0 - uTime * 0.03 + 4.0);
  float h = vUv.y;
  float column = smoothstep(0.0, 0.1, h) * mix(0.3, 1.0, pow(h, 1.3));
  gl_FragColor = vec4(mix(uBottom, uTop, h) * body * body * rays * column * uGain, 1.0);
}`;

interface MoteOptions {
  seed: number;
  count: number;
  min: [number, number, number];
  max: [number, number, number];
  drift: [number, number, number];
  sway: number;
  /** World-space size and the cap in low-res pixels. */
  size: number;
  maxPixels: number;
  colors: [number, number];
  base: number;
  beam: number;
  soft?: boolean;
}

export interface Atmosphere {
  /** dim (0..1) fades the haze, motes and light shafts out, for when the shrine goes dark. */
  update(time: number, ignite: number, dim?: number): void;
  /** Low-res pixels per world unit at distance 1, so motes keep their apparent size. */
  setPixelScale(scale: number): void;
}

export function createAtmosphere(scene: THREE.Scene): Atmosphere {
  const uTime = { value: 0 };
  const uScale = { value: 440 };
  const uGain = { value: 1 };
  const uDim = { value: 1 };

  const motes = (o: MoteOptions) => {
    const rand = mulberry32(o.seed);
    const pos = new Float32Array(o.count * 3);
    const seed = new Float32Array(o.count * 4);
    for (let i = 0; i < o.count; i++) {
      for (let a = 0; a < 3; a++) pos[i * 3 + a] = o.min[a] + rand() * (o.max[a] - o.min[a]);
      for (let a = 0; a < 4; a++) seed[i * 4 + a] = rand();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
    const points = new THREE.Points(
      geo,
      new THREE.ShaderMaterial({
        vertexShader: MOTE_VERT,
        fragmentShader: MOTE_FRAG,
        uniforms: {
          uTime,
          uScale,
          uGain,
          uDim,
          uMin: { value: new THREE.Vector3(...o.min) },
          uSize: { value: new THREE.Vector3(o.max[0] - o.min[0], o.max[1] - o.min[1], o.max[2] - o.min[2]) },
          uDrift: { value: new THREE.Vector3(...o.drift) },
          uSway: { value: o.sway },
          uPoint: { value: o.size },
          uMaxPoint: { value: o.maxPixels },
          uBase: { value: o.base },
          uBeam: { value: o.beam },
          uSoft: { value: o.soft ? 1 : 0 },
          uColorA: { value: new THREE.Color(o.colors[0]) },
          uColorB: { value: new THREE.Color(o.colors[1]) },
        },
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
      }),
    );
    points.frustumCulled = false;
    scene.add(points);
  };

  // Dust through the whole courtyard, and thicker inside the shaft of light.
  motes({ seed: 1, count: 520, min: [-8, 0, -10], max: [8, 6.5, 5.5], drift: [0.02, 0.035, 0.01], sway: 0.25, size: 0.02, maxPixels: 2, colors: [0xffffff, 0xffc0d8], base: 0.32, beam: 1.3 });
  motes({ seed: 2, count: 180, min: [-1.7, 0.2, -1.7], max: [1.7, 7, 1.7], drift: [0.01, 0.05, 0.01], sway: 0.18, size: 0.017, maxPixels: 2, colors: [0xffffff, 0xff9cc0], base: 0.15, beam: 1.9 });
  // Slow glowing embers, like fireflies or spirits.
  motes({ seed: 3, count: 46, min: [-5.5, 0.25, -8], max: [5.5, 3.6, 3.5], drift: [0, 0.015, 0], sway: 0.9, size: 0.06, maxPixels: 7, colors: [0xff4f92, 0xff7a3c], base: 1.5, beam: 0.6, soft: true });
  // Sakura petals falling across the light.
  motes({ seed: 4, count: 70, min: [-8, 0, -11], max: [8, 7, 4.5], drift: [0.12, -0.22, 0.03], sway: 0.5, size: 0.03, maxPixels: 3, colors: [0xff9fc0, 0xffd0e0], base: 0.3, beam: 1.2 });

  // ── Shaft of light ───────────────────────────────────────
  const shaft = (top: number, bottom: number, gain: number, colorTop: number, colorBottom: number) => {
    const uniforms = {
      uTime,
      uGain: { value: gain },
      uTop: { value: new THREE.Color(colorTop) },
      uBottom: { value: new THREE.Color(colorBottom) },
    };
    const cone = new THREE.Mesh(
      new THREE.CylinderGeometry(top, bottom, 9.4, 28, 1, true),
      new THREE.ShaderMaterial({
        vertexShader: SHAFT_VERT,
        fragmentShader: SHAFT_FRAG,
        uniforms,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
      }),
    );
    cone.position.y = 4.7;
    scene.add(cone);
    return { uniforms, gain };
  };
  const shafts = [shaft(0.5, 2.2, 0.4, 0xff5a9c, 0x7a2a9a), shaft(0.18, 1.05, 0.45, 0xff86b4, 0xc04a9a)];

  const halo = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: tex.glow(),
      color: 0xff3f8a,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      fog: false,
    }),
  );
  halo.position.set(0, 1.75, -0.35);
  halo.scale.setScalar(2.8);
  scene.add(halo);

  // ── Mist ─────────────────────────────────────────────────
  const rand = mulberry32(21);
  const banks: { mesh: THREE.Mesh; speed: number; phase: number; opacity: number; y: number }[] = [];
  const maps = [tex.mist(31), tex.mist(32), tex.mist(33)];
  for (let i = 0; i < 12; i++) {
    // The first two banks sit between the camera and the sword, barely there.
    const z = i < 2 ? 1.6 + i * 1.2 : -1.5 - rand() * 30;
    const opacity = i < 2 ? 0.02 : 0.035 + rand() * 0.05;
    const material = new THREE.MeshBasicMaterial({
      map: maps[i % 3],
      color: i % 2 ? 0x5a2a66 : 0x3e1c52,
      transparent: true,
      opacity,
      side: THREE.DoubleSide,
      depthWrite: false,
      fog: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(16 + rand() * 8, 2.6 + rand() * 1.6), material);
    const y = 0.5 + rand() * 1.1;
    mesh.position.set((rand() - 0.5) * 24, y, z);
    scene.add(mesh);
    banks.push({ mesh, speed: (0.08 + rand() * 0.14) * (i % 2 ? 1 : -1), phase: rand() * 10, opacity, y });
  }

  let last = 0;

  return {
    update(time, ignite, dim = 1) {
      const dt = Math.min(time - last, 0.05);
      last = time;
      uTime.value = time;
      uGain.value = ignite;
      uDim.value = dim;
      for (const s of shafts) s.uniforms.uGain.value = s.gain * ignite * dim;
      (halo.material as THREE.SpriteMaterial).opacity = 0.13 * ignite * dim * (0.9 + 0.1 * Math.sin(time * 0.9));
      for (const b of banks) {
        const m = b.mesh;
        m.position.x += b.speed * dt;
        if (m.position.x > 20) m.position.x = -20;
        else if (m.position.x < -20) m.position.x = 20;
        m.position.y = b.y + Math.sin(time * 0.13 + b.phase) * 0.12;
        // Fade near the wrap point so a bank never pops in or out.
        const fadeEdge = Math.min(1, (20 - Math.abs(m.position.x)) / 4);
        (m.material as THREE.MeshBasicMaterial).opacity = b.opacity * fadeEdge * dim * (0.8 + 0.2 * Math.sin(time * 0.2 + b.phase));
      }
    },

    setPixelScale(scale) {
      uScale.value = scale;
    },
  };
}
