import * as THREE from 'three';
import { mulberry32 } from '../util/math';
import { CHARACTER_POS } from './character';
import * as tex from './textures';

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const SKY_FRAG = /* glsl */ `
varying vec3 vDir;
uniform float uTime;
uniform vec3 uMoonDir;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) { s += a * noise(p); p *= 2.03; a *= 0.5; }
  return s;
}

void main() {
  vec3 d = normalize(vDir);
  float h = d.y;

  // Near-black overhead, a warm bruised glow where the sky meets the hills.
  vec3 c = mix(vec3(0.085, 0.014, 0.04), vec3(0.012, 0.004, 0.02), smoothstep(-0.02, 0.2, h));
  c = mix(c, vec3(0.004, 0.002, 0.008), smoothstep(0.14, 0.62, h));

  float cloud = fbm(d.xz / (abs(h) + 0.25) * 1.6 + vec2(uTime * 0.006, 0.0));
  cloud = smoothstep(0.42, 0.8, cloud) * smoothstep(0.0, 0.22, h);
  c += vec3(0.02, 0.005, 0.02) * cloud;

  vec2 cell = floor(vec2(atan(d.z, d.x), asin(clamp(h, -1.0, 1.0))) * 300.0);
  float r = hash21(cell);
  float star = step(0.992, r) * (0.55 + 0.45 * sin(uTime * (1.0 + r * 3.0) + r * 80.0));
  c += vec3(0.8, 0.7, 0.95) * star * smoothstep(0.03, 0.2, h) * (1.0 - cloud) * 0.55;

  float md = acos(clamp(dot(d, uMoonDir), -1.0, 1.0));
  float disc = smoothstep(0.058, 0.054, md);
  float mare = fbm((d - uMoonDir).xy * 55.0 + 3.0);
  c = mix(c, mix(vec3(0.3, 0.05, 0.1), vec3(0.62, 0.22, 0.3), mare), disc);
  c += vec3(0.3, 0.04, 0.12) * exp(-md * 8.0) * 0.4 * (1.0 - disc);

  gl_FragColor = vec4(c, 1.0);
}`;

export interface Environment {
  /** time in seconds; ignite 0..1+ is how brightly the light over the sword burns. */
  update(time: number, ignite: number): void;
}

export function createEnvironment(scene: THREE.Scene): Environment {
  const rand = mulberry32(7);
  const matte = (params: THREE.MeshLambertMaterialParameters) => new THREE.MeshLambertMaterial(params);
  const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[], x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    return m;
  };

  scene.fog = new THREE.FogExp2(0x0a0410, 0.026);

  // ── Light ────────────────────────────────────────────────
  scene.add(new THREE.HemisphereLight(0x4a2c66, 0x100609, 0.5));

  const moonlight = new THREE.DirectionalLight(0xa860f0, 0.5);
  moonlight.position.set(-7, 8, -12);
  scene.add(moonlight);

  // The one light that matters: a pink-red shaft falling on the sword.
  const key = new THREE.SpotLight(0xff6fa6, 380, 24, 0.36, 1, 2);
  key.position.set(0.9, 8.2, 3.6);
  key.target.position.set(0, 0.5, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 3;
  key.shadow.camera.far = 14;
  key.shadow.bias = -0.0015;
  key.shadow.normalBias = 0.02;
  scene.add(key, key.target);

  const fill = new THREE.PointLight(0xff5a94, 5, 5, 2);
  fill.position.set(0.3, 1.9, 1.7);
  scene.add(fill);

  // The sword's glow reaching the gate behind it.
  const wash = new THREE.SpotLight(0xff4a7a, 70, 30, 0.42, 1, 2);
  wash.position.set(0, 2.2, -0.5);
  wash.target.position.set(0, 3.2, -11);
  scene.add(wash, wash.target);

  // Cool moonlit rim from behind, so the sword separates from the dark.
  const rim = new THREE.PointLight(0x8a6cff, 9, 7, 2);
  rim.position.set(-1.5, 2.4, -2.2);
  scene.add(rim);

  // ── Sky, moon and mountains ──────────────────────────────
  const skyUniforms = {
    uTime: { value: 0 },
    uMoonDir: { value: new THREE.Vector3(-0.16, 0.2, -1).normalize() },
  };
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(600, 32, 16),
    new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms: skyUniforms,
      side: THREE.BackSide,
      depthWrite: false,
    }),
  );
  sky.renderOrder = -10;
  scene.add(sky);

  const range = (radius: number, base: number, amp: number, seed: number, top: number, bottom: number) => {
    const N = 96;
    const pos: number[] = [];
    const col: number[] = [];
    const index: number[] = [];
    const cTop = new THREE.Color(top);
    const cBottom = new THREE.Color(bottom);
    const ridge = (x: number) => 1 - Math.abs(Math.sin(x));
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      const h = base + amp * (0.5 * ridge(a * 3 + seed) + 0.3 * ridge(a * 7 + seed * 2.3) + 0.2 * ridge(a * 17 + seed * 5.1));
      pos.push(Math.cos(a) * radius, -4, Math.sin(a) * radius, Math.cos(a) * radius, h, Math.sin(a) * radius);
      col.push(cBottom.r, cBottom.g, cBottom.b, cTop.r, cTop.g, cTop.b);
      if (i < N) index.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(index);
    scene.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide })));
  };
  // Three ridgelines, each darker as it nears.
  range(330, 6, 50, 0.4, 0x1c0a1c, 0x2c0c22);
  range(240, 4, 30, 2.1, 0x10060f, 0x1a0817);
  range(160, 2, 15, 4.4, 0x070308, 0x0d050b);

  // A lone snow-capped cone on the horizon.
  {
    const rows: [number, number, number][] = [[0, 78, 0x2c0e28], [16, 44, 0x260c24], [32, 22, 0x200a20], [41, 12, 0x6a3f5e], [50, 6, 0x7a4a6a]];
    const N = 12;
    const pos: number[] = [];
    const col: number[] = [];
    const index: number[] = [];
    const c = new THREE.Color();
    rows.forEach(([y, r, hex], j) => {
      for (let i = 0; i <= N; i++) {
        const a = (i / N) * Math.PI * 2;
        const jag = j === 3 ? (i % 2 ? 3.5 : -2.5) : 0; // ragged snowline
        pos.push(Math.cos(a) * r, y + jag, Math.sin(a) * r);
        c.set(hex).multiplyScalar(0.75 + 0.25 * Math.cos(a + 2.4));
        col.push(c.r, c.g, c.b);
        if (j < rows.length - 1 && i < N) {
          const p = j * (N + 1) + i;
          index.push(p, p + N + 1, p + 1, p + 1, p + N + 1, p + N + 2);
        }
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(index);
    const fuji = mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide }), 70, -2, -285);
    scene.add(fuji);
  }

  // ── Courtyard ────────────────────────────────────────────
  const ground = mesh(new THREE.PlaneGeometry(400, 400), matte({ map: tex.stoneTiles([166, 166]) }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const path = mesh(new THREE.PlaneGeometry(2.4, 27), matte({ map: tex.flagstones([1, 11]) }), 0, 0.012, -15.6);
  path.rotation.x = -Math.PI / 2;
  scene.add(path);

  const stoneMat = matte({ map: tex.stone(), flatShading: true });
  const vermilion = matte({ map: tex.vermilion() });
  const black = matte({ color: 0x16121a });
  const woodMat = matte({ map: tex.wood() });
  const straw = matte({ color: 0xa8935a, flatShading: true });
  const paper = matte({ color: 0x9c9298, side: THREE.DoubleSide });
  const lamp = new THREE.MeshBasicMaterial({ color: 0xffa050 });

  const streamers: THREE.Object3D[] = [];
  const shide = () => {
    const g = new THREE.Group();
    [[0, -0.09], [0.07, -0.25], [0, -0.41]].forEach(([x, y]) => g.add(mesh(new THREE.PlaneGeometry(0.15, 0.17), paper, x, y, 0)));
    streamers.push(g);
    return g;
  };

  const torii = (z: number, scale: number, lean = 0) => {
    const g = new THREE.Group();
    const bow = (geo: THREE.BufferGeometry, half: number, lift: number) => {
      const p = geo.getAttribute('position');
      for (let i = 0; i < p.count; i++) p.setY(i, p.getY(i) + lift * Math.pow(Math.abs(p.getX(i)) / half, 2.2));
      geo.computeVertexNormals();
      return geo;
    };
    for (const side of [-1, 1]) {
      const post = mesh(new THREE.CylinderGeometry(0.2, 0.25, 4.5, 8), vermilion, side * 2.1, 2.25, 0);
      post.rotation.z = side * 0.035;
      g.add(post);
      g.add(mesh(new THREE.CylinderGeometry(0.275, 0.285, 0.55, 8), black, side * 2.17, 0.55, 0));
      g.add(mesh(new THREE.CylinderGeometry(0.36, 0.42, 0.28, 8), stoneMat, side * 2.18, 0.14, 0));
      g.add(mesh(new THREE.BoxGeometry(0.1, 0.14, 0.34), vermilion, side * 1.72, 3.56, 0));
    }
    g.add(mesh(new THREE.BoxGeometry(5.3, 0.26, 0.2), vermilion, 0, 3.55, 0));
    g.add(mesh(new THREE.BoxGeometry(0.22, 0.66, 0.16), vermilion, 0, 4.0, 0));
    g.add(mesh(bow(new THREE.BoxGeometry(5.7, 0.24, 0.36, 10, 1, 1), 2.85, 0.3), vermilion, 0, 4.62, 0));
    g.add(mesh(bow(new THREE.BoxGeometry(6.5, 0.3, 0.5, 10, 1, 1), 3.25, 0.4), vermilion, 0, 4.9, 0));
    g.add(mesh(bow(new THREE.BoxGeometry(6.7, 0.09, 0.64, 10, 1, 1), 3.35, 0.42), black, 0, 5.1, 0));
    g.add(mesh(new THREE.BoxGeometry(0.52, 0.76, 0.07), matte({ map: tex.plaque() }), 0, 4.02, 0.12));

    // Sacred rope and its paper streamers.
    const sag = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-1.95, 3.32, 0.17),
      new THREE.Vector3(-1, 3.02, 0.22),
      new THREE.Vector3(0, 2.92, 0.24),
      new THREE.Vector3(1, 3.02, 0.22),
      new THREE.Vector3(1.95, 3.32, 0.17),
    ]);
    g.add(mesh(new THREE.TubeGeometry(sag, 12, 0.075, 5), straw));
    for (const t of [0.2, 0.4, 0.6, 0.8]) {
      const s = shide();
      s.position.copy(sag.getPoint(t)).y -= 0.06;
      g.add(s);
    }
    g.position.z = z;
    g.rotation.z = lean;
    g.scale.setScalar(scale);
    scene.add(g);
  };
  torii(-11, 1);
  torii(-19.5, 0.92, 0.022);
  torii(-27, 0.86, -0.012);

  const lamps: { light: THREE.PointLight; phase: number }[] = [];
  const lantern = (x: number, z: number, lit: number) => {
    const g = new THREE.Group();
    g.add(mesh(new THREE.CylinderGeometry(0.32, 0.4, 0.18, 6), stoneMat, 0, 0.09, 0));
    g.add(mesh(new THREE.CylinderGeometry(0.11, 0.15, 0.96, 6), stoneMat, 0, 0.66, 0));
    g.add(mesh(new THREE.CylinderGeometry(0.31, 0.2, 0.14, 6), stoneMat, 0, 1.21, 0));
    g.add(mesh(new THREE.BoxGeometry(0.34, 0.32, 0.34), stoneMat, 0, 1.44, 0));
    g.add(mesh(new THREE.ConeGeometry(0.52, 0.3, 6), stoneMat, 0, 1.75, 0));
    g.add(mesh(new THREE.OctahedronGeometry(0.09, 0), stoneMat, 0, 1.96, 0));
    if (lit > 0) {
      for (let i = 0; i < 4; i++) {
        const w = mesh(new THREE.PlaneGeometry(0.2, 0.2), lamp);
        w.position.set(Math.sin((i * Math.PI) / 2) * 0.172, 1.44, Math.cos((i * Math.PI) / 2) * 0.172);
        w.rotation.y = (i * Math.PI) / 2;
        g.add(w);
      }
      const light = new THREE.PointLight(0xff7a3a, lit, 9, 2);
      light.position.set(0, 1.44, 0);
      g.add(light);
      lamps.push({ light, phase: rand() * 10 });
    }
    g.position.set(x, 0, z);
    g.rotation.y = rand() * 0.5;
    scene.add(g);
  };
  lantern(-3.4, -8.4, 7);
  lantern(3.4, -8.4, 7);
  lantern(-3, -15.4, 0);
  lantern(3, -15.4, 0);

  // One lantern long since fallen.
  {
    const g = new THREE.Group();
    const post = mesh(new THREE.CylinderGeometry(0.11, 0.15, 0.96, 6), stoneMat, 0, 0.13, 0);
    post.rotation.set(0, 0.4, Math.PI / 2);
    const cap = mesh(new THREE.ConeGeometry(0.52, 0.3, 6), stoneMat, 0.9, 0.2, 0.5);
    cap.rotation.set(1.2, 0, 0.5);
    const box = mesh(new THREE.BoxGeometry(0.34, 0.32, 0.34), stoneMat, -0.2, 0.16, 0.7);
    box.rotation.y = 0.7;
    g.add(post, cap, box, mesh(new THREE.CylinderGeometry(0.32, 0.4, 0.18, 6), stoneMat, -0.9, 0.09, -0.2));
    g.position.set(-3.6, 0, -1.4);
    scene.add(g);
  }

  for (let i = 0; i < 16; i++) {
    const size = 0.12 + rand() * 0.3;
    const side = rand() > 0.5 ? 1 : -1;
    const rock = mesh(new THREE.DodecahedronGeometry(size, 0), stoneMat, side * (2.4 + rand() * 7), size * 0.4, 2 - rand() * 22);
    rock.rotation.set(rand() * 3, rand() * 3, rand() * 3);
    rock.scale.y = 0.6;
    // Keep the spot where the figure stands clear.
    if (Math.hypot(rock.position.x - CHARACTER_POS.x, rock.position.z - CHARACTER_POS.z) > 1.6) scene.add(rock);
  }

  // ── Shrine at the end of the approach ────────────────────
  {
    const g = new THREE.Group();
    const steps = matte({ map: tex.stone([4, 1]) });
    g.add(mesh(new THREE.BoxGeometry(12, 1.6, 9), steps, 0, 0.8, 0));
    for (let i = 0; i < 6; i++) g.add(mesh(new THREE.BoxGeometry(4.6, 0.27, 0.56), steps, 0, 0.135 + i * 0.27, 7.6 - i * 0.52));
    g.add(mesh(new THREE.BoxGeometry(4.8, 3.4, 5.6), woodMat, 0, 3.3, 0));
    const door = mesh(new THREE.PlaneGeometry(2.2, 2.3), new THREE.MeshBasicMaterial({ map: tex.lattice(), color: 0xb8805a }), 0, 2.9, 2.82);
    g.add(door);
    for (const x of [-2.2, 2.2]) g.add(mesh(new THREE.CylinderGeometry(0.16, 0.18, 3.4, 6), vermilion, x, 3.3, 3.1));

    // Steep gabled roof facing the approach, with the crossed finials of a Shinto hall.
    const half = 5.4;
    const rise = 3.4;
    const line = (x: number) => {
      const t = Math.min(1, Math.abs(x) / half);
      return rise * Math.pow(1 - t, 1.7) + 0.4 * Math.pow(t, 5);
    };
    const shape = new THREE.Shape();
    const N = 12;
    for (let i = 0; i <= N; i++) {
      const x = -half + (2 * half * i) / N;
      if (i) shape.lineTo(x, line(x));
      else shape.moveTo(x, line(x));
    }
    for (let i = N; i >= 0; i--) {
      const x = (-half + (2 * half * i) / N) * 0.97;
      shape.lineTo(x, line(x) - 0.42);
    }
    shape.closePath();
    const roofGeo = new THREE.ExtrudeGeometry(shape, { depth: 8.4, bevelEnabled: false });
    roofGeo.translate(0, 0, -4.2);
    g.add(mesh(roofGeo, matte({ map: tex.roofTiles([0.6, 0.6]), flatShading: true }), 0, 4.5, 0));

    const gable = new THREE.Shape();
    gable.moveTo(-2.4, 0);
    gable.lineTo(2.4, 0);
    gable.lineTo(0, 2.7);
    gable.closePath();
    g.add(mesh(new THREE.ShapeGeometry(gable), woodMat, 0, 5, 2.78));
    for (const z of [3.9, -3.9]) {
      for (const tilt of [-0.55, 0.55]) {
        const beam = mesh(new THREE.BoxGeometry(0.18, 2.8, 0.18), black, 0, 8.2, z);
        beam.rotation.z = tilt;
        g.add(beam);
      }
    }
    g.position.set(0, 0, -41);
    scene.add(g);
  }

  // Five-storey pagoda off to one side, mostly silhouette.
  {
    const g = new THREE.Group();
    const dark = matte({ color: 0x1c1218, flatShading: true });
    let y = 0;
    let w = 4.4;
    for (let i = 0; i < 5; i++) {
      g.add(mesh(new THREE.BoxGeometry(w, 1.8, w), dark, 0, y + 0.9, 0));
      const roof = mesh(new THREE.CylinderGeometry(w * 0.42, w * 1.08, 0.75, 4), dark, 0, y + 2.15, 0);
      roof.rotation.y = Math.PI / 4;
      g.add(roof);
      y += 2.5;
      w *= 0.84;
    }
    g.add(mesh(new THREE.CylinderGeometry(0.06, 0.14, 4.2, 5), dark, 0, y + 2, 0));
    g.position.set(19, 0, -56);
    scene.add(g);
  }

  // ── Sakura ───────────────────────────────────────────────
  const bark = matte({ color: 0x1e1418, flatShading: true });
  const blossom = [0x9a5074, 0x7a3c62, 0xb26688].map((color) => matte({ color, flatShading: true, emissive: 0x220b18 }));
  const sakura = (x: number, z: number, seed: number, scale: number) => {
    const r = mulberry32(seed);
    const g = new THREE.Group();
    const limb = (pts: THREE.Vector3[], radius: number) =>
      g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 6, radius, 5), bark));
    const top = new THREE.Vector3((r() - 0.5) * 1.2, 2.6 + r() * 0.6, (r() - 0.5) * 0.8);
    limb([new THREE.Vector3(), new THREE.Vector3((r() - 0.5) * 0.5, 1.2, (r() - 0.5) * 0.4), top], 0.2);
    const puff = (at: THREE.Vector3, size: number, i: number) => {
      const m = new THREE.Mesh(new THREE.IcosahedronGeometry(size, 0), blossom[i % 3]);
      m.position.copy(at);
      m.rotation.set(r() * 3, r() * 3, r() * 3);
      m.scale.y = 0.66;
      g.add(m);
    };
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + r();
      const len = 1.5 + r() * 1.2;
      const end = top.clone().add(new THREE.Vector3(Math.cos(a) * len, 0.6 + r(), Math.sin(a) * len));
      const mid = top.clone().lerp(end, 0.5).add(new THREE.Vector3(0, 0.35, 0));
      limb([top.clone(), mid, end], 0.08);
      puff(end.clone().add(new THREE.Vector3(0, 0.3, 0)), 0.8 + r() * 0.5, i);
      puff(mid.clone().add(new THREE.Vector3((r() - 0.5) * 0.6, 0.5, (r() - 0.5) * 0.6)), 0.7 + r() * 0.4, i + 1);
    }
    puff(top.clone().add(new THREE.Vector3(0, 1, 0)), 1.2, 2);
    g.position.set(x, 0, z);
    g.scale.setScalar(scale);
    scene.add(g);
  };
  sakura(-6.6, -7.5, 11, 1.25);
  sakura(7, -9.5, 12, 1.35);
  sakura(-9.5, -17, 13, 1.5);
  sakura(10.5, -20, 14, 1.5);
  sakura(-6, -25, 15, 1.3);
  sakura(6.5, -31, 16, 1.4);

  // The courtyard continues behind the opening view, for when the camera circles round.
  torii(17, 0.95, 0.03);
  lantern(-4.4, 8, 0);
  lantern(4.4, 8, 0);
  sakura(-8.5, 9.5, 17, 1.3);
  sakura(9, 12, 18, 1.45);
  sakura(-13, 1, 19, 1.5);
  sakura(13.5, -2, 20, 1.5);

  // Painted-in occlusion: soft dark pools where heavy things meet the paving.
  const shade = (x: number, z: number, size: number, opacity: number, map: THREE.Texture) => {
    const m = mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshBasicMaterial({ map, transparent: true, opacity, depthWrite: false }),
      x,
      0.02,
      z,
    );
    m.rotation.x = -Math.PI / 2;
    m.renderOrder = 1;
    scene.add(m);
  };
  const ringShade = tex.contact(0.62);
  const footShade = tex.contact(0.3);
  shade(0, 0, 5.6, 0.7, ringShade);
  for (const [x, z] of [[-3.4, -8.4], [3.4, -8.4], [-3, -15.4], [3, -15.4], [-4.4, 8], [4.4, 8]]) shade(x, z, 1.9, 0.6, footShade);
  for (const [z, s] of [[-11, 1], [-19.5, 0.92], [-27, 0.86], [17, 0.95]]) {
    for (const side of [-1, 1]) shade(side * 2.18 * s, z, 2.1 * s, 0.6, footShade);
  }

  return {
    update(time, ignite) {
      skyUniforms.uTime.value = time;
      // The key light breathes, and drifts between pink and a deeper red-violet.
      key.intensity = 380 * ignite;
      key.color.setHSL(0.935 + 0.02 * Math.sin(time * 0.21), 1, 0.72);
      fill.intensity = 5 * ignite;
      wash.intensity = 70 * Math.min(ignite, 1.2);
      for (const { light, phase } of lamps) {
        const t = time * 3 + phase;
        light.intensity = 7 * (0.82 + 0.12 * Math.sin(t) + 0.06 * Math.sin(t * 2.7 + 1));
      }
      streamers.forEach((s, i) => {
        s.rotation.z = Math.sin(time * 0.9 + i * 1.7) * 0.12;
        s.rotation.x = Math.sin(time * 0.7 + i) * 0.1;
      });
    },
  };
}
