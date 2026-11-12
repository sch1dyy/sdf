import * as THREE from 'three';
import { lerp, mulberry32 } from '../util/math';
import * as tex from './textures';

type Ring = THREE.Vector3[];
type UV = [number, number];

// Proportions are a real katana at roughly twice scale, slightly thickened so it still reads
// at a few hundred lines of resolution.
const LENGTH = 1.46; // collar to tip
const KISSAKI = 0.12; // length of the point section
const YOKOTE = LENGTH - KISSAKI;
const WIDTH_BASE = 0.1;
const WIDTH_TIP = 0.074;
const THICK_BASE = 0.024;
const THICK_TIP = 0.016;
const SORI = 0.17; // how far the curve carries the tip back
const BURIED = 0.4;
const GROUND = LENGTH - BURIED; // distance along the blade where it meets the stone

export const DAIS_TOP = 0.3;
const TILT_X = -0.06;
const TILT_Z = 0.045;

interface LoftOptions {
  /** Hard edges between neighbouring ring points (a blade), instead of a smooth tube. */
  faceted?: boolean;
  capStart?: boolean;
  capEnd?: boolean;
  uv?: (ring: number, point: number) => UV;
}

/** Skins a surface over a stack of closed rings. Winding is worked out from the shape itself. */
function loft(rings: Ring[], o: LoftOptions = {}): THREE.BufferGeometry {
  const nR = rings.length;
  const nP = rings[0].length;
  const uv = o.uv ?? ((j: number, i: number): UV => [i / nP, j / (nR - 1)]);
  const pos: number[] = [];
  const uvs: number[] = [];
  const index: number[] = [];
  const centres = rings.map((ring) => ring.reduce((sum, p) => sum.add(p), new THREE.Vector3()).divideScalar(nP));

  const push = (p: THREE.Vector3, t: UV) => {
    pos.push(p.x, p.y, p.z);
    uvs.push(t[0], t[1]);
    return pos.length / 3 - 1;
  };
  const at = (i: number) => new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
  const emit = (tris: number[], outward: (centre: THREE.Vector3, tri: number) => THREE.Vector3) => {
    let facing = 0;
    for (let t = 0; t < tris.length; t += 3) {
      const a = at(tris[t]);
      const b = at(tris[t + 1]);
      const c = at(tris[t + 2]);
      const n = b.clone().sub(a).cross(c.clone().sub(a));
      facing += n.dot(outward(a.add(b).add(c).divideScalar(3), t / 3));
    }
    for (let t = 0; t < tris.length; t += 3) {
      if (facing < 0) index.push(tris[t], tris[t + 2], tris[t + 1]);
      else index.push(tris[t], tris[t + 1], tris[t + 2]);
    }
  };

  const side: number[] = [];
  const sideRing: number[] = [];
  if (o.faceted) {
    for (let i = 0; i < nP; i++) {
      const base = pos.length / 3;
      for (let j = 0; j < nR; j++) {
        push(rings[j][i], uv(j, i));
        push(rings[j][(i + 1) % nP], uv(j, i + 1));
      }
      for (let j = 0; j < nR - 1; j++) {
        const a = base + j * 2;
        side.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
        sideRing.push(j, j);
      }
    }
  } else {
    for (let j = 0; j < nR; j++) for (let i = 0; i <= nP; i++) push(rings[j][i % nP], uv(j, i));
    for (let j = 0; j < nR - 1; j++) {
      for (let i = 0; i < nP; i++) {
        const a = j * (nP + 1) + i;
        const c = a + nP + 1;
        side.push(a, c, a + 1, a + 1, c, c + 1);
        sideRing.push(j, j);
      }
    }
  }
  emit(side, (centre, tri) => centre.sub(centres[sideRing[tri]]));

  const cap = (j: number, inner: number) => {
    const tris: number[] = [];
    const hub = push(centres[j], uv(j, 0));
    const first = pos.length / 3;
    rings[j].forEach((p, i) => push(p, uv(j, i)));
    for (let i = 0; i < nP; i++) tris.push(hub, first + i, first + ((i + 1) % nP));
    const out = centres[j].clone().sub(centres[inner]);
    emit(tris, () => out);
  };
  if (o.capStart) cap(0, 1);
  if (o.capEnd) cap(nR - 1, nR - 2);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(index);
  g.computeVertexNormals();

  if (!o.faceted) {
    // The first and last column of each ring are the same point with different UVs.
    const nrm = g.getAttribute('normal');
    const n = new THREE.Vector3();
    for (let j = 0; j < nR; j++) {
      const a = j * (nP + 1);
      const b = a + nP;
      n.set(nrm.getX(a) + nrm.getX(b), nrm.getY(a) + nrm.getY(b), nrm.getZ(a) + nrm.getZ(b)).normalize();
      nrm.setXYZ(a, n.x, n.y, n.z);
      nrm.setXYZ(b, n.x, n.y, n.z);
    }
  }
  return g;
}

/**
 * Cross-section of the blade at distance s from the collar: a ridged back, the two shinogi
 * ridges and the edge. The sword hangs along -Y with its edge towards +Z.
 */
function bladeRing(s: number, inflate = 0): Ring {
  const t = s / LENGTH;
  let width = lerp(WIDTH_BASE, WIDTH_TIP, Math.min(s / YOKOTE, 1));
  let thick = lerp(THICK_BASE, THICK_TIP, t);
  if (s > YOKOTE) {
    const k = (s - YOKOTE) / KISSAKI;
    width *= 1 - Math.pow(k, 1.8);
    thick *= 1 - 0.75 * k;
  }
  width = Math.max(width, 0.0006);
  const back = -WIDTH_BASE / 2 - SORI * t * t;
  const half = thick / 2 + inflate;
  const ridge = back + width * 0.36;
  const shoulder = back + Math.min(0.007, width * 0.2) - inflate * 0.5;
  return [
    new THREE.Vector3(0, -s, back - inflate),
    new THREE.Vector3(half * 0.72, -s, shoulder),
    new THREE.Vector3(half, -s, ridge),
    new THREE.Vector3(0, -s, back + width + inflate),
    new THREE.Vector3(-half, -s, ridge),
    new THREE.Vector3(-half * 0.72, -s, shoulder),
  ];
}

/** v coordinate (back → edge) of each point of the blade section. */
const BLADE_V = [0, 0.12, 0.45, 1, 0.45, 0.12, 0];

function ellipse(y: number, rx: number, rz: number, n: number, zc = 0): Ring {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return new THREE.Vector3(Math.sin(a) * rx, y, zc + Math.cos(a) * rz);
  });
}

/** Round guard pierced with two half-moon openings and four small ones. */
function tsubaGeometry(): THREE.BufferGeometry {
  const R = 0.118;
  const shape = new THREE.Shape();
  const N = 28;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const r = R * (1 + 0.03 * Math.cos(a * 4));
    if (i) shape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    else shape.moveTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  shape.closePath();

  const hole = (pts: UV[]) => {
    const p = new THREE.Path();
    pts.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y)));
    p.closePath();
    shape.holes.push(p);
  };
  for (const sign of [-1, 1]) {
    const pts: UV[] = [];
    for (let i = 0; i <= 6; i++) {
      const a = -Math.PI / 2 + (i / 6) * Math.PI;
      pts.push([sign * (0.04 + Math.cos(a) * 0.024), Math.sin(a) * 0.034]);
    }
    hole(pts);
  }
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + (k * Math.PI) / 2;
    const cx = Math.cos(a) * 0.082;
    const cy = Math.sin(a) * 0.082;
    hole(Array.from({ length: 6 }, (_, i): UV => {
      const b = (i / 6) * Math.PI * 2;
      return [cx + Math.cos(b) * 0.012, cy + Math.sin(b) * 0.012];
    }));
  }

  const g = new THREE.ExtrudeGeometry(shape, {
    depth: 0.012,
    bevelEnabled: true,
    bevelThickness: 0.004,
    bevelSize: 0.004,
    bevelSegments: 1,
    curveSegments: 4,
  });
  g.translate(0, 0, -0.006);
  // Planar UVs so the painted face (and its gold rim) lines up with the disc.
  const p = g.getAttribute('position');
  const uv = g.getAttribute('uv');
  const span = (R * 1.03 + 0.004) * 2;
  for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / span + 0.5, p.getY(i) / span + 0.5);
  g.rotateX(-Math.PI / 2);
  return g;
}

/** The sword draws after everything else solid, so the scene can be blacked out behind it. */
export const SWORD_RENDER_ORDER = 6;

export interface KatanaRig {
  /** The stone, the sword and its scabbard. */
  group: THREE.Group;
  /** Invisible volume around the sword, for click tests. */
  hitTarget: THREE.Object3D;
  /** Where the sword sits while it is in the stone, in world space. */
  rest: { position: THREE.Vector3; quaternion: THREE.Quaternion };
  /** Landmarks on the sword, relative to the pose given to setPose. */
  points: { grip: THREE.Vector3; collar: THREE.Vector3; tip: THREE.Vector3 };
  /** Length of blade inside the stone. */
  buried: number;
  update(time: number, dt: number): void;
  /** Takes the sword out of the stone's keeping and puts it at a world-space pose. */
  setPose(position: THREE.Vector3, quaternion: THREE.Quaternion): void;
  /** Puts the sword back in the stone. */
  release(): void;
  setVisible(visible: boolean): void;
  /** A highlight on the blade at `along` (0 at the collar, 1 at the point). */
  setGleam(along: number, strength: number): void;
  /** The seal carved in the stone flares, then fades. */
  flare(amount: number): void;
}

export function createKatana(envMap: THREE.Texture): KatanaRig {
  const rand = mulberry32(3);
  const group = new THREE.Group();
  // A fixed pose: the opening view looks onto the flat of the blade rather than its edge.
  group.rotation.y = 1.15;

  const metal = (color: number, roughness: number, metalness = 1) =>
    new THREE.MeshStandardMaterial({ color, roughness, metalness, envMap, envMapIntensity: 1.3 });
  const matte = (params: THREE.MeshLambertMaterialParameters) => new THREE.MeshLambertMaterial(params);
  const gold = metal(0xc9a14e, 0.34);
  const copper = metal(0xc0824a, 0.3);
  const shakudo = metal(0x1c1a26, 0.3, 0.9);
  const cord = matte({ color: 0x9a2136 });
  const rock = matte({ map: tex.stone(), flatShading: true });

  const add = <T extends THREE.Object3D>(parent: THREE.Object3D, child: T, shadow = true): T => {
    child.castShadow = shadow;
    parent.add(child);
    return child;
  };

  // ── Stone dais ───────────────────────────────────────────
  const seal = tex.daisTop();
  const sealMat = matte({ map: seal.map, emissiveMap: seal.glow, emissive: 0xff3f86, emissiveIntensity: 0.3 });
  const sideMat = matte({ map: tex.flagstones([8, 0.5]) });
  const plainTop = matte({ map: tex.stone([6, 6]) });
  const step = add(group, new THREE.Mesh(new THREE.CylinderGeometry(1.62, 1.74, 0.1, 8, 1, false, Math.PI / 8), [sideMat, plainTop, plainTop]));
  step.position.y = 0.05;
  const dais = add(group, new THREE.Mesh(new THREE.CylinderGeometry(1.24, 1.34, DAIS_TOP - 0.1, 8, 1, false, Math.PI / 8), [sideMat, sealMat, plainTop]));
  dais.position.y = (DAIS_TOP + 0.1) / 2;
  step.receiveShadow = dais.receiveShadow = true;

  for (let i = 0; i < 9; i++) {
    const a = rand() * Math.PI * 2;
    const r = i < 6 ? 0.07 + rand() * 0.14 : 0.8 + rand() * 0.35;
    const size = i < 6 ? 0.018 + rand() * 0.026 : 0.04 + rand() * 0.05;
    const chip = add(group, new THREE.Mesh(new THREE.DodecahedronGeometry(size, 0), rock));
    chip.position.set(Math.cos(a) * r, DAIS_TOP + size * 0.5, Math.sin(a) * r);
    chip.rotation.set(rand() * 3, rand() * 3, rand() * 3);
  }

  // ── Sword ────────────────────────────────────────────────
  // The pivot sits where the steel meets the stone, so the whole sword can quiver about it.
  const pivot = new THREE.Group();
  pivot.position.y = DAIS_TOP;
  pivot.rotation.set(TILT_X, 0, TILT_Z);
  group.add(pivot);

  const sword = new THREE.Group();
  const entry = bladeRing(GROUND);
  sword.position.set(0, GROUND, -(entry[0].z + entry[3].z) / 2);
  pivot.add(sword);

  const glint = { value: new THREE.Vector2(-1, 0) };
  const steel = tex.blade(GROUND / LENGTH);
  const bladeMat = new THREE.MeshStandardMaterial({
    map: steel.map,
    roughnessMap: steel.orm,
    metalnessMap: steel.orm,
    roughness: 1,
    metalness: 1,
    envMap,
    envMapIntensity: 2.1,
  });
  bladeMat.onBeforeCompile = (shader) => {
    shader.uniforms.uGlint = glint;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec2 uGlint;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          // A slow gleam that travels down the hardened edge now and then.
          float band = smoothstep(0.07, 0.0, abs(vMapUv.x - uGlint.x));
          totalEmissiveRadiance += vec3(1.0, 0.75, 0.88) * band * smoothstep(0.4, 1.0, vMapUv.y) * uGlint.y;
        }`,
      );
  };

  const stations: number[] = [];
  for (let i = 0; i <= 32; i++) stations.push((YOKOTE * i) / 32);
  for (let i = 1; i <= 6; i++) stations.push(YOKOTE + (KISSAKI * i * 0.999) / 6);
  add(sword, new THREE.Mesh(
    loft(stations.map((s) => bladeRing(s)), { faceted: true, uv: (j, i) => [stations[j] / LENGTH, BLADE_V[i]] }),
    bladeMat,
  ));

  // Habaki: the wedge-shaped collar that locks the blade into the scabbard.
  const collar: UV[] = [[0, 0.002], [0.004, 0.0065], [0.088, 0.0065], [0.094, 0.003]];
  add(sword, new THREE.Mesh(loft(collar.map(([s, inflate]) => bladeRing(s, inflate)), { faceted: true, capEnd: true }), copper));

  // Guard and its washers.
  const tsuba = add(sword, new THREE.Mesh(
    tsubaGeometry(),
    new THREE.MeshStandardMaterial({ map: tex.tsubaFace(), metalness: 0.85, roughness: 0.42, envMap, envMapIntensity: 1.3 }),
  ));
  tsuba.position.y = 0.01;
  const oval = (rx: number, rz: number, h: number, y: number, mat: THREE.Material) => {
    const m = add(sword, new THREE.Mesh(new THREE.CylinderGeometry(1, 1, h, 14), mat));
    m.scale.set(rx, 1, rz);
    m.position.y = y;
    return m;
  };
  oval(0.04, 0.066, 0.006, -0.003, gold);
  oval(0.04, 0.066, 0.006, 0.023, gold);

  // Grip: collar, wrapped handle, ornaments, pommel.
  oval(0.037, 0.056, 0.044, 0.048, shakudo);
  oval(0.039, 0.058, 0.006, 0.029, gold);
  oval(0.039, 0.058, 0.006, 0.068, gold);

  const GRIP_START = 0.07;
  const GRIP_LEN = 0.49;
  const gripRings: Ring[] = [];
  for (let j = 0; j <= 8; j++) {
    const t = j / 8;
    const waist = Math.sin(Math.PI * t);
    gripRings.push(ellipse(GRIP_START + GRIP_LEN * t, 0.032 * (1 - 0.08 * waist), 0.05 * (1 - 0.1 * waist), 18));
  }
  add(sword, new THREE.Mesh(loft(gripRings), new THREE.MeshLambertMaterial({ map: tex.tsukaWrap([2, 9]) })));

  for (const [side, y] of [[1, 0.25], [-1, 0.4]]) {
    const menuki = add(sword, new THREE.Mesh(new THREE.OctahedronGeometry(1, 0), gold));
    menuki.scale.set(0.008, 0.036, 0.013);
    menuki.position.set(side * 0.032, y, 0);
  }

  const POMMEL = GRIP_START + GRIP_LEN;

  // Bamboo pegs that pin the blade's tang inside the grip.
  const bamboo = matte({ color: 0xd9cdae });
  for (const y of [0.16, 0.47]) {
    const peg = add(sword, new THREE.Mesh(new THREE.CylinderGeometry(0.0055, 0.0055, 0.068, 6), bamboo));
    peg.rotation.z = Math.PI / 2;
    peg.position.y = y;
  }
  // A thin gold line where the back of the blade leaves the collar.
  add(sword, new THREE.Mesh(loft([0.094, 0.1].map((s) => bladeRing(s, 0.0035)), { faceted: true }), gold));
  oval(0.036, 0.054, 0.03, POMMEL + 0.015, shakudo);
  oval(0.038, 0.056, 0.006, POMMEL + 0.001, gold);
  const dome = add(sword, new THREE.Mesh(new THREE.SphereGeometry(1, 14, 4, 0, Math.PI * 2, 0, Math.PI / 2), shakudo));
  dome.scale.set(0.036, 0.018, 0.054);
  dome.position.y = POMMEL + 0.03;

  // A cord tied below the pommel carries a paper talisman and a small bell.
  const tie = add(sword, new THREE.Mesh(new THREE.TorusGeometry(1, 0.11, 4, 14), cord));
  tie.rotation.x = Math.PI / 2;
  tie.scale.set(0.036, 0.054, 0.05);
  tie.position.y = POMMEL - 0.03;

  const talisman = new THREE.Group();
  talisman.position.set(0.006, POMMEL - 0.03, 0.058);
  sword.add(talisman);
  const string1 = add(talisman, new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.05, 0.004), cord));
  string1.position.y = -0.025;
  const paper = add(talisman, new THREE.Mesh(
    new THREE.PlaneGeometry(0.07, 0.2),
    new THREE.MeshLambertMaterial({ map: tex.ofuda(), color: 0xcfc6c4, side: THREE.DoubleSide }),
  ));
  paper.rotation.y = Math.PI / 2;
  paper.position.set(0, -0.15, 0.03);

  const bell = new THREE.Group();
  bell.position.set(-0.038, POMMEL - 0.03, 0.012);
  sword.add(bell);
  const string2 = add(bell, new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.13, 0.004), cord));
  string2.position.y = -0.065;
  const suzu = add(bell, new THREE.Mesh(new THREE.IcosahedronGeometry(0.024, 0), gold));
  suzu.position.y = -0.15;
  const tassel = add(bell, new THREE.Mesh(new THREE.ConeGeometry(0.014, 0.07, 5), cord));
  tassel.position.y = -0.21;

  // ── Scabbard, laid on the stone beside the blade ─────────
  const SAYA = 1.5;
  const sayaCurve = (s: number) => -SORI * Math.pow(s / SAYA, 2);
  const sayaRing = (s: number, grow = 0, n = 10) => {
    const taper = lerp(1, 0.84, s / SAYA);
    return ellipse(-s, 0.028 * taper + grow, 0.054 * taper + grow, n, sayaCurve(s));
  };
  const saya = new THREE.Group();
  saya.position.set(0.05, DAIS_TOP + 0.031, 0.68);
  saya.rotation.y = 0.22;
  group.add(saya);
  const lay = new THREE.Group(); // tips the scabbard onto its side
  lay.rotation.z = Math.PI / 2;
  lay.position.x = -SAYA / 2;
  saya.add(lay);

  const sayaStations = Array.from({ length: 15 }, (_, i) => (SAYA * i) / 14);
  add(lay, new THREE.Mesh(
    loft(sayaStations.map((s) => sayaRing(s)), { capStart: true }),
    new THREE.MeshStandardMaterial({ map: tex.lacquer(), roughness: 0.28, metalness: 0.15, envMap, envMapIntensity: 1.1 }),
  ));
  add(lay, new THREE.Mesh(loft([-0.004, 0, 0.04, 0.045].map((s, i) => sayaRing(Math.max(s, 0), i === 0 || i === 3 ? 0.002 : 0.005).map((p) => p.setY(-s)))), gold));
  const mouth = add(lay, new THREE.Mesh(new THREE.CircleGeometry(1, 10), new THREE.MeshBasicMaterial({ color: 0x050306 })), false);
  mouth.rotation.x = -Math.PI / 2;
  mouth.scale.set(0.024, 0.05, 1);
  mouth.position.y = 0.0045;
  add(lay, new THREE.Mesh(
    loft(
      [[SAYA - 0.085, 0.002], [SAYA - 0.08, 0.005], [SAYA - 0.012, 0.005], [SAYA, 0]].map(([s, grow]) => sayaRing(s, grow)),
      { capEnd: true },
    ),
    gold,
  ));

  const knob = add(lay, new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.06, 0.03), shakudo));
  knob.position.set(0.034, -0.225, sayaCurve(0.225));
  for (const s of [0.2, 0.225, 0.25]) {
    const wrap = add(lay, new THREE.Mesh(new THREE.TorusGeometry(1, 0.12, 4, 12), cord));
    wrap.rotation.x = Math.PI / 2;
    wrap.scale.set(0.031, 0.057, 0.05);
    wrap.position.set(0, -s, sayaCurve(s));
  }

  // The loose end of the cord trails across the stone.
  group.updateMatrixWorld(true);
  const k = knob.getWorldPosition(new THREE.Vector3());
  const lie = DAIS_TOP + 0.008;
  const trail = new THREE.CatmullRomCurve3([
    k,
    new THREE.Vector3(k.x + 0.03, lie + 0.02, k.z + 0.07),
    new THREE.Vector3(k.x + 0.14, lie, k.z + 0.15),
    new THREE.Vector3(k.x + 0.3, lie, k.z + 0.1),
    new THREE.Vector3(k.x + 0.41, lie, k.z + 0.2),
  ]);
  add(group, new THREE.Mesh(new THREE.TubeGeometry(trail, 14, 0.007, 4), cord));

  // ── Motion ───────────────────────────────────────────────
  const hitTarget = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.76, 0.4), new THREE.MeshBasicMaterial({ visible: false }));
  hitTarget.position.set(0, 0.86, 0.02);
  pivot.add(hitTarget);
  pivot.traverse((o) => (o.renderOrder = SWORD_RENDER_ORDER));

  group.updateMatrixWorld(true);
  const rest = {
    position: pivot.getWorldPosition(new THREE.Vector3()),
    quaternion: pivot.getWorldQuaternion(new THREE.Quaternion()),
  };
  const toGroup = group.quaternion.clone().invert();
  const points = {
    grip: new THREE.Vector3(0, GROUND + GRIP_START + GRIP_LEN / 2, sword.position.z),
    collar: new THREE.Vector3(0, GROUND, sword.position.z),
    tip: new THREE.Vector3(0, GROUND - LENGTH, sword.position.z + bladeRing(LENGTH * 0.999)[0].z),
  };

  let sealFlare = 0;
  let gleam: [number, number] | null = null;

  return {
    group,
    hitTarget,
    rest,
    points,
    buried: BURIED,

    update(time, dt) {
      // Talisman and bell hang and stir in the air.
      talisman.rotation.x = Math.sin(time * 1.1) * 0.05;
      talisman.rotation.z = Math.sin(time * 0.83 + 1) * 0.06;
      talisman.rotation.y = Math.sin(time * 0.6) * 0.25;
      bell.rotation.z = Math.sin(time * 1.3 + 2) * 0.04;
      bell.rotation.x = Math.sin(time * 0.95) * 0.05;

      sealFlare *= Math.exp(-dt * 1.7);
      sealMat.emissiveIntensity = 0.26 + 0.1 * Math.sin(time * 0.8) + sealFlare * 1.8;

      // Left alone, a gleam runs down the blade every so often.
      const cycle = time % 11;
      if (gleam) glint.value.set(gleam[0], gleam[1]);
      else if (cycle < 1.8) glint.value.set(lerp(-0.06, GROUND / LENGTH, cycle / 1.8), Math.sin((Math.PI * cycle) / 1.8) * 0.9);
      else glint.value.y = 0;
    },

    setPose(position, quaternion) {
      pivot.position.copy(position).sub(group.position).applyQuaternion(toGroup);
      pivot.quaternion.copy(toGroup).multiply(quaternion);
    },

    release() {
      pivot.position.set(0, DAIS_TOP, 0);
      pivot.rotation.set(TILT_X, 0, TILT_Z);
      pivot.visible = true;
      gleam = null;
    },

    setVisible(visible) {
      pivot.visible = visible;
    },

    setGleam(along, strength) {
      gleam = [along, strength];
    },

    flare(amount) {
      sealFlare = Math.max(sealFlare, amount);
    },
  };
}
