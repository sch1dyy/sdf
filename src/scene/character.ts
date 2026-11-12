import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../util/math';
import * as tex from './textures';

// A fan-made figure of Killua Zoldyck (Hunter x Hunter), sculpted entirely in code after the
// frame where he lifts two fingers to his brow: purple zip hoodie, hood down, head tilted,
// half a grin. Cel-shaded and ink-outlined, with smooth high-resolution textures, so he reads
// as a clean anime character against the rougher shrine around him.

/** Where he stands: behind the sword and to its right, outside the scene camera's orbit. */
export const CHARACTER_POS = new THREE.Vector3(2.9, 0, -4.4);
/** He faces the opening camera position. */
const FACING = -0.33;
/** The sword is built at about twice life size, so he is too. */
const SCALE = 1.45;
const HEAD_Y = 1.435;
const HEAD_R = 0.115;

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** Piecewise-linear lookup through [t, value] stops. */
function profile(stops: [number, number][]): (t: number) => number {
  return (t) => {
    for (let i = 1; i < stops.length; i++) {
      if (t <= stops[i][0]) return mix(stops[i - 1][1], stops[i][1], (t - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0]));
    }
    return stops[stops.length - 1][1];
  };
}

// ── Geometry helpers ───────────────────────────────────────

/** Skins a smooth surface over a stack of closed rings, with UVs and optional vertex colours. */
function skin(rings: THREE.Vector3[][], colour?: (ring: number) => THREE.Color): THREE.BufferGeometry {
  const n = rings[0].length;
  const pos: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  rings.forEach((ring, j) => {
    const c = colour?.(j);
    for (let i = 0; i <= n; i++) {
      const p = ring[i % n];
      pos.push(p.x, p.y, p.z);
      uv.push(i / n, j / (rings.length - 1));
      if (c) col.push(c.r, c.g, c.b);
    }
  });

  // Work out which way is outward, so callers need not care about ring direction.
  let facing = 0;
  const centre = new THREE.Vector3();
  const quad: number[] = [];
  for (let j = 0; j < rings.length - 1; j++) {
    centre.set(0, 0, 0);
    rings[j].forEach((p) => centre.add(p));
    centre.divideScalar(n);
    for (let i = 0; i < n; i++) {
      const a = rings[j][i];
      const b = rings[j][(i + 1) % n];
      const c = rings[j + 1][i];
      facing += b.clone().sub(a).cross(c.clone().sub(a)).dot(a.clone().sub(centre));
      const k = j * (n + 1) + i;
      quad.push(k, k + 1, k + n + 1, k + 1, k + n + 2, k + n + 1);
    }
  }
  if (facing < 0) for (let t = 0; t < quad.length; t += 3) [quad[t + 1], quad[t + 2]] = [quad[t + 2], quad[t + 1]];

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  if (colour) g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(quad);
  g.computeVertexNormals();
  // The first and last column are the same point; share their normal so no seam shows.
  const nrm = g.getAttribute('normal');
  const v = new THREE.Vector3();
  for (let j = 0; j < rings.length; j++) {
    const a = j * (n + 1);
    const b = a + n;
    v.set(nrm.getX(a) + nrm.getX(b), nrm.getY(a) + nrm.getY(b), nrm.getZ(a) + nrm.getZ(b)).normalize();
    nrm.setXYZ(a, v.x, v.y, v.z);
    nrm.setXYZ(b, v.x, v.y, v.z);
  }
  return g;
}

/** Horizontal elliptical sections [y, radiusX, radiusZ, offsetZ?]; the texture seam is at the back. */
function shell(sections: number[][], seg = 40): THREE.BufferGeometry {
  return skin(
    sections.map(([y, rx, rz, oz = 0]) =>
      Array.from({ length: seg }, (_, i) => {
        const a = (i / seg) * Math.PI * 2;
        return V(-Math.sin(a) * rx, y, -Math.cos(a) * rz + oz);
      }),
    ),
  );
}

/** A tube of varying radius swept along a smooth path: limbs, sleeves, cords. */
function sweep(points: THREE.Vector3[], radius: (t: number) => number, seg = 24, radial = 16): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.5);
  const frames = curve.computeFrenetFrames(seg, false);
  const rings: THREE.Vector3[][] = [];
  for (let j = 0; j <= seg; j++) {
    const t = j / seg;
    const p = curve.getPointAt(t);
    const r = radius(t);
    rings.push(
      Array.from({ length: radial }, (_, i) => {
        const a = (i / radial) * Math.PI * 2;
        return p.clone().addScaledVector(frames.normals[j], Math.cos(a) * r).addScaledVector(frames.binormals[j], Math.sin(a) * r);
      }),
    );
  }
  return skin(rings);
}

/** Collapses a hierarchy of meshes into one geometry, in the root's own space. */
function bake(root: THREE.Object3D): THREE.BufferGeometry {
  root.updateMatrixWorld(true);
  const inverse = root.matrixWorld.clone().invert();
  const parts: THREE.BufferGeometry[] = [];
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) parts.push(o.geometry.clone().applyMatrix4(inverse.clone().multiply(o.matrixWorld)));
  });
  return mergeGeometries(parts);
}

// ── Textures ───────────────────────────────────────────────

function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Face painted on an equirectangular map; the front of the head is the centre of the image. */
function faceTexture(): THREE.Texture {
  const W = 2048;
  const H = 1024;
  const k = W / 360; // pixels per degree
  const at = (lon: number, lat: number): [number, number] => [(0.5 + lon / 360) * W, (0.5 - lat / 180) * H];

  return canvasTexture(W, H, (ctx) => {
    ctx.fillStyle = '#f9e6da';
    ctx.fillRect(0, 0, W, H);
    // Shade under the fringe and beneath the jaw.
    const brow = ctx.createLinearGradient(0, at(0, 42)[1], 0, at(0, 14)[1]);
    brow.addColorStop(0, 'rgba(196,160,176,0.75)');
    brow.addColorStop(1, 'rgba(196,160,176,0)');
    ctx.fillStyle = brow;
    ctx.fillRect(0, 0, W, H / 2);
    const jaw = ctx.createLinearGradient(0, at(0, -34)[1], 0, at(0, -70)[1]);
    jaw.addColorStop(0, 'rgba(222,170,156,0)');
    jaw.addColorStop(1, 'rgba(222,170,156,0.8)');
    ctx.fillStyle = jaw;
    ctx.fillRect(0, H / 2, W, H / 2);

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const side of [-1, 1]) {
      const [bx, by] = at(side * 27, -19);
      const blush = ctx.createRadialGradient(bx, by, 0, bx, by, 9 * k);
      blush.addColorStop(0, 'rgba(240,140,150,0.2)');
      blush.addColorStop(1, 'rgba(240,140,150,0)');
      ctx.fillStyle = blush;
      ctx.fillRect(bx - 9 * k, by - 9 * k, 18 * k, 18 * k);

      // Wide, round, cat-like eyes under a heavy upper lash line.
      const [cx, cy] = at(side * 21, -7);
      const w = 13 * k;
      const h = 10.6 * k;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(side, 1);

      const upper = (p: Path2D | CanvasRenderingContext2D) => p.bezierCurveTo(-0.72 * w, -1.05 * h, 0.5 * w, -1.16 * h, w, -0.42 * h);
      const lid = new Path2D();
      lid.moveTo(-w, 0.08 * h);
      upper(lid);
      lid.bezierCurveTo(0.9 * w, 0.62 * h, -0.3 * w, 1.06 * h, -w, 0.08 * h);
      lid.closePath();

      ctx.save();
      ctx.clip(lid);
      ctx.fillStyle = '#fcfcff';
      ctx.fillRect(-w * 1.3, -h * 1.5, w * 2.6, h * 3);
      const iris = ctx.createLinearGradient(0, -h, 0, h);
      iris.addColorStop(0, '#222f66');
      iris.addColorStop(0.42, '#465fae');
      iris.addColorStop(0.8, '#8aa9e6');
      iris.addColorStop(1, '#b9d2f6');
      ctx.fillStyle = iris;
      ctx.beginPath();
      ctx.ellipse(0, -0.04 * h, 0.6 * w, 1.04 * h, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 0.075 * w;
      ctx.strokeStyle = '#19224f';
      ctx.stroke();
      // Fine rays in the lower iris, then the pupil.
      ctx.strokeStyle = 'rgba(214,232,255,0.45)';
      ctx.lineWidth = 0.02 * w;
      for (let r = 0; r < 9; r++) {
        const a = Math.PI * (0.18 + (0.64 * r) / 8);
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * 0.26 * w, -0.04 * h + Math.sin(a) * 0.5 * h);
        ctx.lineTo(Math.cos(a) * 0.5 * w, -0.04 * h + Math.sin(a) * 0.9 * h);
        ctx.stroke();
      }
      ctx.fillStyle = '#12173a';
      ctx.beginPath();
      ctx.ellipse(0, -0.06 * h, 0.21 * w, 0.42 * h, 0, 0, Math.PI * 2);
      ctx.fill();
      // Shadow cast by the lid, then the reflections.
      const shadow = ctx.createLinearGradient(0, -1.1 * h, 0, -0.25 * h);
      shadow.addColorStop(0, 'rgba(10,14,48,0.6)');
      shadow.addColorStop(1, 'rgba(10,14,48,0)');
      ctx.fillStyle = shadow;
      ctx.fillRect(-w * 1.3, -h * 1.5, w * 2.6, h * 1.4);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.ellipse(-0.24 * w * side, -0.46 * h, 0.17 * w, 0.2 * h, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.arc(0.27 * w * side, 0.44 * h, 0.075 * w, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.restore();

      ctx.strokeStyle = '#1b1722';
      ctx.lineWidth = 0.17 * w;
      ctx.beginPath();
      ctx.moveTo(-w, 0.08 * h);
      upper(ctx);
      ctx.lineTo(1.2 * w, -0.74 * h);
      ctx.stroke();
      ctx.lineWidth = 0.07 * w;
      ctx.beginPath();
      ctx.moveTo(0.86 * w, -0.66 * h);
      ctx.lineTo(1.14 * w, -0.4 * h);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(70,45,58,0.8)';
      ctx.lineWidth = 0.045 * w;
      ctx.beginPath();
      ctx.moveTo(w, -0.42 * h);
      ctx.bezierCurveTo(0.9 * w, 0.62 * h, -0.3 * w, 1.06 * h, -0.8 * w, 0.42 * h);
      ctx.stroke();
      // Crease of the lid and a fine, slightly raised brow.
      ctx.strokeStyle = 'rgba(150,110,120,0.6)';
      ctx.lineWidth = 0.035 * w;
      ctx.beginPath();
      ctx.moveTo(-0.7 * w, -1.12 * h);
      ctx.quadraticCurveTo(0.2 * w, -1.5 * h, 0.95 * w, -1.0 * h);
      ctx.stroke();
      ctx.strokeStyle = '#8c8fa8';
      ctx.lineWidth = 0.07 * w;
      ctx.beginPath();
      ctx.moveTo(-0.9 * w, -1.72 * h);
      ctx.quadraticCurveTo(0.1 * w, -2.12 * h, 1.05 * w, -1.78 * h);
      ctx.stroke();
      ctx.restore();
    }

    // Nose: a small wedge of shadow.
    const [nx, ny] = at(0, -19);
    ctx.fillStyle = 'rgba(206,150,140,0.85)';
    ctx.beginPath();
    ctx.moveTo(nx + 0.2 * k, ny - 1.6 * k);
    ctx.lineTo(nx + 1.5 * k, ny + 0.9 * k);
    ctx.lineTo(nx - 0.3 * k, ny + 0.5 * k);
    ctx.closePath();
    ctx.fill();

    // An open, lopsided grin.
    const [mx, my] = at(1, -30.5);
    const mouth = new Path2D();
    mouth.moveTo(mx - 7 * k, my - 0.2 * k);
    mouth.quadraticCurveTo(mx, my + 0.8 * k, mx + 7 * k, my - 1.7 * k);
    mouth.bezierCurveTo(mx + 6 * k, my + 4.6 * k, mx - 4.2 * k, my + 5.2 * k, mx - 7 * k, my - 0.2 * k);
    mouth.closePath();
    ctx.save();
    ctx.clip(mouth);
    ctx.fillStyle = '#7a2831';
    ctx.fillRect(mx - 8 * k, my - 3 * k, 16 * k, 9 * k);
    ctx.fillStyle = '#e0808a';
    ctx.beginPath();
    ctx.ellipse(mx + 0.4 * k, my + 4.5 * k, 4.2 * k, 2.2 * k, -0.08, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5 * k;
    ctx.beginPath();
    ctx.moveTo(mx - 7 * k, my - 0.2 * k);
    ctx.quadraticCurveTo(mx, my + 0.8 * k, mx + 7 * k, my - 1.7 * k);
    ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = '#5c262e';
    ctx.lineWidth = 3.2;
    ctx.stroke(mouth);
    ctx.strokeStyle = 'rgba(190,130,125,0.7)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(mx - 2.2 * k, my + 6.6 * k);
    ctx.quadraticCurveTo(mx, my + 7.1 * k, mx + 2.2 * k, my + 6.5 * k);
    ctx.stroke();
  });
}

/**
 * Hoodie body. u = 0.5 is the front, v runs hem to collar. The open collar above the zip is
 * cut away with transparency so the shirt beneath shows through.
 */
function hoodieTexture(): THREE.Texture {
  const S = 1024;
  const t = canvasTexture(S, S, (ctx) => {
    const y = (v: number) => (1 - v) * S;
    ctx.fillStyle = '#857abf';
    ctx.fillRect(0, 0, S, S);

    // Folds: soft dark creases with a lit edge beside each, gathering toward the waist.
    const rand = mulberry32(31);
    const fold = (x0: number, y0: number, x1: number, y1: number, width: number, alpha: number) => {
      for (const [dx, style] of [[0, `rgba(58,48,112,${alpha})`], [width * 0.9, `rgba(176,166,226,${alpha * 0.7})`]] as const) {
        ctx.strokeStyle = style;
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(x0 + dx, y0);
        ctx.quadraticCurveTo((x0 + x1) / 2 + dx + (rand() - 0.5) * 30, (y0 + y1) / 2, x1 + dx, y1);
        ctx.stroke();
      }
    };
    ctx.lineCap = 'round';
    ctx.filter = 'blur(5px)';
    for (let i = 0; i < 26; i++) {
      const x = rand() * S;
      const top = y(0.2 + rand() * 0.55);
      fold(x, top, x + (rand() - 0.5) * 90, top + 110 + rand() * 170, 9 + rand() * 9, 0.34);
    }
    // Creases pulled from each armpit toward the zip.
    for (const side of [-1, 1]) {
      for (let i = 0; i < 4; i++) fold(S * (0.5 + side * 0.24), y(0.74 - i * 0.05), S * (0.5 + side * 0.07), y(0.6 - i * 0.07), 10, 0.36);
    }
    // Bunching just above the ribbed hem, and shade beneath the hood.
    for (let i = 0; i < 44; i++) fold((i / 44) * S + rand() * 12, y(0.17), (i / 44) * S + rand() * 12, y(0.085), 6, 0.3);
    ctx.filter = 'none';
    const hood = ctx.createLinearGradient(0, y(1), 0, y(0.8));
    hood.addColorStop(0, 'rgba(50,40,100,0.55)');
    hood.addColorStop(1, 'rgba(50,40,100,0)');
    ctx.fillStyle = hood;
    ctx.fillRect(0, 0, S, y(0.8));

    // Ribbed hem.
    ctx.fillStyle = '#7469ae';
    ctx.fillRect(0, y(0.075), S, S);
    ctx.fillStyle = 'rgba(52,44,104,0.5)';
    for (let x = 0; x < S; x += 9) ctx.fillRect(x, y(0.075), 3, S);
    ctx.fillRect(0, y(0.08), S, 4);

    // Pocket openings either side of the zip.
    ctx.strokeStyle = 'rgba(52,44,104,0.75)';
    ctx.lineWidth = 4;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(S * (0.5 + side * 0.07), y(0.34));
      ctx.lineTo(S * (0.5 + side * 0.19), y(0.11));
      ctx.stroke();
    }

    // Zip: placket seams, tape, metal teeth.
    const zipTop = y(0.7);
    ctx.fillStyle = 'rgba(52,44,104,0.6)';
    ctx.fillRect(S / 2 - 21, zipTop, 3, S);
    ctx.fillRect(S / 2 + 18, zipTop, 3, S);
    ctx.fillStyle = '#6a5fa3';
    ctx.fillRect(S / 2 - 8, zipTop, 16, S);
    ctx.fillStyle = '#d9dae6';
    for (let yy = zipTop; yy < S; yy += 9) ctx.fillRect(S / 2 - 4, yy, 8, 5);

    // Cut the open collar out.
    const open = new Path2D();
    open.moveTo(S * 0.33, 0);
    open.lineTo(S * 0.67, 0);
    open.lineTo(S * 0.5, zipTop);
    open.closePath();
    ctx.strokeStyle = '#6a5fa3';
    ctx.lineWidth = 22;
    ctx.lineJoin = 'round';
    ctx.stroke(open);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fill(open);
  });
  return t;
}

/** Yellow skateboard deck with his red arrow. */
function deckTexture(): THREE.Texture {
  return canvasTexture(256, 64, (ctx) => {
    ctx.fillStyle = '#f0bf2c';
    ctx.fillRect(0, 0, 256, 64);
    ctx.fillStyle = '#d2362c';
    ctx.fillRect(70, 24, 90, 16);
    ctx.beginPath();
    ctx.moveTo(156, 8);
    ctx.lineTo(206, 32);
    ctx.lineTo(156, 56);
    ctx.closePath();
    ctx.fill();
  });
}

// ── Hair ───────────────────────────────────────────────────

const direction = (lonDeg: number, latDeg: number) => {
  const lon = (lonDeg * Math.PI) / 180;
  const lat = (latDeg * Math.PI) / 180;
  return V(Math.sin(lon) * Math.cos(lat), Math.sin(lat), Math.cos(lon) * Math.cos(lat));
};

const HAIR_ROOT = new THREE.Color(0xa9a5d8);
const HAIR_TIP = new THREE.Color(0xf1eeff);

/**
 * One lock of hair: a flattened, leaf-shaped tuft following a curve from the scalp to a point.
 * `out` is the direction away from the head, which the flat side faces.
 */
function lock(root: THREE.Vector3, bend: THREE.Vector3, tip: THREE.Vector3, width: number, out: THREE.Vector3): THREE.BufferGeometry {
  const SEG = 10;
  const RADIAL = 8;
  const rings: THREE.Vector3[][] = [];
  const tangent = new THREE.Vector3();
  const thin = new THREE.Vector3();
  const wide = new THREE.Vector3();
  for (let j = 0; j <= SEG; j++) {
    const t = j / SEG;
    const p = root.clone().multiplyScalar((1 - t) * (1 - t)).addScaledVector(bend, 2 * (1 - t) * t).addScaledVector(tip, t * t);
    tangent.copy(bend).sub(root).multiplyScalar(1 - t).addScaledVector(tip.clone().sub(bend), t).normalize();
    thin.copy(out).addScaledVector(tangent, -out.dot(tangent)).normalize();
    wide.crossVectors(tangent, thin);
    // Swells quickly from the root, then tapers to a point.
    const r = width * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.62)), 0.85);
    rings.push(
      Array.from({ length: RADIAL }, (_, i) => {
        const a = (i / RADIAL) * Math.PI * 2;
        return p.clone().addScaledVector(wide, Math.cos(a) * r).addScaledVector(thin, Math.sin(a) * r * 0.5);
      }),
    );
  }
  const c = new THREE.Color();
  return skin(rings, (j) => c.copy(HAIR_ROOT).lerp(HAIR_TIP, ease(0.05, 0.75, j / SEG)).clone());
}

/** The whole head of hair, relative to the centre of the head. */
function hairGeometry(): THREE.BufferGeometry {
  const rand = mulberry32(204);
  const locks: THREE.BufferGeometry[] = [];
  const scalp = HEAD_R * 0.9;

  // The fluffy mass: tufts fanning up from the crown, out at the sides, down at the back.
  const N = 150;
  for (let i = 0; i < N; i++) {
    const y = 1 - (2 * (i + 0.5)) / N;
    const r = Math.sqrt(1 - y * y);
    const phi = i * 2.39996;
    const d = V(Math.cos(phi) * r, y, Math.sin(phi) * r);
    const lat = (Math.asin(y) * 180) / Math.PI;
    const lon = Math.abs((Math.atan2(d.x, d.z) * 180) / Math.PI);
    const jitter = V(rand() - 0.5, rand() - 0.5, rand() - 0.5);
    const length = rand();
    const width = 0.036 + rand() * 0.014;

    if (lat < -22) continue; // below the nape
    if (lon < 66 && lat < 40) continue; // the face
    if (lon < 104 && lat < -4) continue; // cheeks and ears

    const flow = d.clone();
    let len: number;
    if (lat > 46) {
      flow.add(V(Math.sign(d.x) * 0.35, 0.3, -0.1));
      len = 0.125 + length * 0.05;
    } else if (lon < 122) {
      flow.add(V(Math.sign(d.x) * 0.1, -0.6, 0.05));
      len = 0.115 + length * 0.05;
    } else {
      flow.add(V(0, -0.6, 0));
      len = 0.11 + length * 0.05;
    }
    flow.addScaledVector(jitter, 0.3).normalize();
    const root = d.clone().multiplyScalar(scalp);
    const bend = root.clone().addScaledVector(d, len * 0.5).addScaledVector(flow, len * 0.12).addScaledVector(jitter, 0.02);
    const tip = root.clone().addScaledVector(flow, len).add(V(0, -0.025, 0));
    locks.push(lock(root, bend, tip, width, d));
  }

  // The fringe: strands that fall across the brow, the longest ones between the eyes.
  const fringe: [number, number, number, number][] = [
    // [longitude at the tip, latitude at the tip, sideways drift from the root, width]
    [-58, 2, -8, 0.026],
    [-46, 13, -4, 0.027],
    [-35, -3, -6, 0.028],
    [-24, 14, 3, 0.026],
    [-14, -1, -5, 0.027],
    [-5, -14, -3, 0.024],
    [4, -6, 5, 0.022],
    [13, 11, 2, 0.026],
    [23, -2, 6, 0.028],
    [33, 13, 3, 0.026],
    [44, 1, 7, 0.028],
    [56, 8, 6, 0.026],
  ];
  for (const [lon, lat, drift, width] of fringe) {
    const rootLat = 50 + rand() * 12;
    const root = direction(lon - drift, rootLat).multiplyScalar(scalp);
    const bend = direction(lon - drift * 0.4, (rootLat + lat) / 2 + 12).multiplyScalar(HEAD_R * 1.34);
    const tip = direction(lon, lat).multiplyScalar(HEAD_R * 1.1);
    locks.push(lock(root, bend, tip, width, direction(lon, 25)));
  }
  // Strands in front of each ear, reaching the jaw.
  for (const side of [-1, 1]) {
    for (const [lon, top, bottom, width] of [[70, 34, -24, 0.024], [84, 38, -30, 0.026], [97, 30, -34, 0.024]]) {
      const root = direction(side * lon, top).multiplyScalar(scalp);
      const bend = direction(side * (lon + 6), (top + bottom) / 2).multiplyScalar(HEAD_R * 1.3);
      const tip = direction(side * (lon - 4), bottom).multiplyScalar(HEAD_R * 1.08);
      locks.push(lock(root, bend, tip, width, direction(side * lon, 0)));
    }
  }
  return mergeGeometries(locks);
}

// ── Hands ──────────────────────────────────────────────────

/**
 * A hand with jointed fingers. Wrist at the origin, fingers along +Y, back of the hand
 * toward +Z. `curl` is 0 (straight) to 1 (fist) for thumb, index, middle, ring, little.
 */
function handGeometry(curl: [number, number, number, number, number]): THREE.BufferGeometry {
  const root = new THREE.Group();
  const blank = new THREE.MeshBasicMaterial();
  const part = (parent: THREE.Object3D, geo: THREE.BufferGeometry) => {
    const m = new THREE.Mesh(geo, blank);
    parent.add(m);
    return m;
  };

  const palm = part(root, new THREE.SphereGeometry(1, 18, 14));
  palm.scale.set(0.037, 0.043, 0.0145);
  palm.position.set(0, 0.043, 0);
  const heel = part(root, new THREE.SphereGeometry(1, 14, 10));
  heel.scale.set(0.028, 0.022, 0.016);
  heel.position.set(0, 0.014, 0);

  const digit = (x: number, y: number, length: number, radius: number, amount: number, splay: number) => {
    let parent: THREE.Object3D = root;
    const bones = [length * 0.46, length * 0.3, length * 0.24];
    const bend = [-1.35, -1.6, -1.1];
    bones.forEach((len, i) => {
      const joint = new THREE.Group();
      joint.position.set(i === 0 ? x : 0, i === 0 ? y : bones[i - 1], 0);
      joint.rotation.x = bend[i] * amount;
      if (i === 0) joint.rotation.z = splay;
      parent.add(joint);
      const r = radius * (1 - i * 0.1);
      part(joint, new THREE.CapsuleGeometry(r, len, 5, 10)).position.y = len / 2;
      parent = joint;
    });
  };
  digit(0.027, 0.078, 0.07, 0.0088, curl[1], -0.03);
  digit(0.0085, 0.083, 0.077, 0.009, curl[2], 0.0);
  digit(-0.0095, 0.08, 0.071, 0.0086, curl[3], 0.04);
  digit(-0.0265, 0.071, 0.056, 0.0076, curl[4], 0.09);

  // The thumb folds across the palm as it curls.
  const thumb = new THREE.Group();
  thumb.position.set(0.031, 0.026, -0.004);
  thumb.rotation.set(-0.5 * curl[0] - 0.2, 0, mix(-0.75, 0.35, curl[0]));
  root.add(thumb);
  part(thumb, new THREE.CapsuleGeometry(0.0105, 0.034, 5, 10)).position.y = 0.017;
  const tip = new THREE.Group();
  tip.position.y = 0.034;
  tip.rotation.z = 0.5 + curl[0] * 0.5;
  thumb.add(tip);
  part(tip, new THREE.CapsuleGeometry(0.0092, 0.028, 5, 10)).position.y = 0.014;

  return bake(root);
}

// ── The figure ─────────────────────────────────────────────

export interface Character {
  /** Point the camera looks at: the middle of the body from afar, the face up close. */
  focus(closeness: number, out: THREE.Vector3): THREE.Vector3;
  /** Direction he faces, as an angle about the vertical. */
  facing: number;
  /** A point just above his head, for the on-screen label. */
  labelAnchor: THREE.Vector3;
  /** Invisible volume used for click tests. */
  hitTarget: THREE.Object3D;
}

export function createCharacter(scene: THREE.Scene): Character {
  const root = new THREE.Group();
  root.position.copy(CHARACTER_POS);
  root.rotation.y = FACING;
  root.scale.setScalar(SCALE);
  scene.add(root);

  // Flat bands of light and shade, as in cel animation; skin gets a gentler step.
  const ramp = (levels: number[]) => {
    const t = new THREE.DataTexture(new Uint8Array(levels), levels.length, 1, THREE.RedFormat);
    t.minFilter = t.magFilter = THREE.NearestFilter;
    t.needsUpdate = true;
    return t;
  };
  const clothRamp = ramp([105, 160, 215, 255]);
  const skinRamp = ramp([190, 232, 255]);

  interface ToonOptions {
    map?: THREE.Texture;
    side?: THREE.Side;
    soft?: boolean;
    vertexColors?: boolean;
    cutout?: boolean;
  }
  const toon = (color: number, o: ToonOptions = {}) =>
    new THREE.MeshToonMaterial({
      color: o.map || o.vertexColors ? 0xffffff : color,
      ...(o.map ? { map: o.map, emissiveMap: o.map } : {}),
      gradientMap: o.soft ? skinRamp : clothRamp,
      vertexColors: o.vertexColors ?? false,
      // A little self-light keeps his colours true under the shrine's pink lamps.
      emissive: o.map ? 0xffffff : color,
      emissiveIntensity: o.soft ? 0.1 : 0.08,
      side: o.side ?? THREE.FrontSide,
      alphaTest: o.cutout ? 0.5 : 0,
    });

  const ink = new THREE.MeshBasicMaterial({ color: 0x1a1230, side: THREE.BackSide });
  ink.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n  transformed += normalize(normal) * 0.0022;',
    );
  };

  const add = (parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, outlined = true) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    if (outlined) m.add(new THREE.Mesh(geo, ink));
    parent.add(m);
    return m;
  };

  const skinMat = toon(0xf9e6da, { soft: true });
  const hoodie = toon(0x857abf);
  const hoodieDark = toon(0x7469ae);
  const shorts = toon(0x2b2d4d, { side: THREE.DoubleSide });
  const shoe = toon(0x4d3fa6);
  const white = toon(0xf0eef6);

  // ── Legs: weight on his right, the left set out a little ─
  const legs = [
    { hip: V(-0.076, 0.76, 0), knee: V(-0.083, 0.44, 0.014), ankle: V(-0.09, 0.1, -0.004), turn: 0.1 },
    { hip: V(0.076, 0.76, 0), knee: V(0.104, 0.44, 0.04), ankle: V(0.132, 0.1, 0.034), turn: -0.34 },
  ];
  for (const { hip, knee, ankle, turn } of legs) {
    const calf = profile([[0, 0.05], [0.14, 0.05], [0.42, 0.054], [0.75, 0.041], [1, 0.035]]);
    add(root, sweep([knee.clone().lerp(hip, 0.2), knee, knee.clone().lerp(ankle, 0.5).add(V(0, 0, -0.012)), ankle], calf, 20, 16), skinMat);
    // Baggy shorts to the knee, with a turned hem.
    const hem = knee.clone().lerp(hip, 0.06);
    const leg = profile([[0, 0.094], [0.5, 0.096], [0.93, 0.094], [0.96, 0.099], [1, 0.097]]);
    add(root, sweep([hip, hip.clone().lerp(hem, 0.5), hem], leg, 14, 22), shorts);

    const foot = new THREE.Group();
    foot.position.set(ankle.x, 0, ankle.z);
    foot.rotation.y = turn;
    root.add(foot);
    const upper: THREE.Vector3[][] = [];
    for (let j = 0; j <= 14; j++) {
      const t = j / 14;
      const p = Math.pow(Math.sin(Math.PI * mix(0.04, 0.97, t)), 0.5);
      const rx = 0.048 * p * mix(0.92, 1, Math.sin(Math.PI * t));
      const ry = 0.043 * p * mix(1.05, 0.62, t);
      upper.push(
        Array.from({ length: 18 }, (_, i) => {
          const a = (i / 18) * Math.PI * 2;
          return V(Math.cos(a) * rx, 0.016 + ry + Math.sin(a) * ry, -0.062 + 0.19 * t);
        }),
      );
    }
    add(foot, skin(upper), shoe);
    const sole = add(foot, new THREE.CylinderGeometry(1, 1, 0.02, 24), white);
    sole.scale.set(0.05, 1, 0.1);
    sole.position.set(0, 0.011, 0.033);
    add(foot, new THREE.CylinderGeometry(0.043, 0.047, 0.07, 18), shoe).position.set(0, 0.105, -0.004);
    const cuff = add(foot, new THREE.TorusGeometry(0.043, 0.008, 8, 20), white);
    cuff.rotation.x = Math.PI / 2;
    cuff.position.set(0, 0.14, -0.004);
    const toe = add(foot, new THREE.SphereGeometry(1, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), white, false);
    toe.scale.set(0.04, 0.03, 0.04);
    toe.position.set(0, 0.03, 0.092);
  }

  // ── Hips ─────────────────────────────────────────────────
  add(root, shell([[0.6, 0.12, 0.1], [0.66, 0.152, 0.112], [0.74, 0.154, 0.113], [0.8, 0.14, 0.1]]), shorts);
  const seat = add(root, new THREE.SphereGeometry(1, 20, 12), shorts, false);
  seat.scale.set(0.13, 0.06, 0.1);
  seat.position.y = 0.63;

  // ── Torso: white tee, then the hoodie over it ────────────
  add(root, shell([[1.0, 0.146, 0.104], [1.1, 0.15, 0.103], [1.17, 0.154, 0.094], [1.22, 0.134, 0.083], [1.262, 0.08, 0.066], [1.275, 0.058, 0.054]]), white, false);
  add(
    root,
    shell([
      [0.715, 0.15, 0.111],
      [0.75, 0.153, 0.114],
      [0.775, 0.166, 0.125],
      [0.86, 0.163, 0.122],
      [0.98, 0.157, 0.114],
      [1.09, 0.16, 0.112],
      [1.165, 0.164, 0.102],
      [1.22, 0.142, 0.09],
      [1.262, 0.1, 0.076],
      [1.285, 0.072, 0.064],
    ]),
    toon(0x857abf, { map: hoodieTexture(), side: THREE.DoubleSide, cutout: true }),
  );

  // Neck and collarbones.
  add(root, sweep([V(0, 1.25, -0.004), V(0, 1.31, 0), V(0, 1.37, 0.006)], profile([[0, 0.05], [0.4, 0.041], [1, 0.04]]), 8, 16), skinMat, false);

  // The hood, lying in a thick roll round the neck and down the back.
  const hoodPath: THREE.Vector3[] = [];
  const hoodAt = (deg: number) => {
    const a = (deg * Math.PI) / 180;
    const back = (1 - Math.cos(a)) / 2;
    return { a, back };
  };
  for (let deg = 28; deg <= 332; deg += 16) {
    const { a, back } = hoodAt(deg);
    hoodPath.push(V(Math.sin(a) * mix(0.085, 0.118, back), 1.268 - 0.05 * Math.pow(back, 1.6), Math.cos(a) * 0.09 - 0.012 - 0.05 * back));
  }
  add(root, sweep(hoodPath, (t) => 0.014 + 0.05 * Math.pow(Math.sin(Math.PI * t), 0.8), 40, 14), hoodie);
  // Its inner fold, a shade darker.
  const lining = add(root, new THREE.SphereGeometry(1, 20, 12), hoodieDark, false);
  lining.scale.set(0.085, 0.05, 0.06);
  lining.position.set(0, 1.235, -0.095);

  // Drawstrings and the zip pull.
  for (const side of [-1, 1]) {
    const cord = sweep(
      [V(side * 0.046, 1.262, 0.068), V(side * 0.05, 1.2, 0.094), V(side * 0.046, 1.11, 0.117), V(side * 0.05, 1.02, 0.121)],
      () => 0.0042,
      18,
      6,
    );
    add(root, cord, white, false);
    add(root, new THREE.CylinderGeometry(0.0055, 0.0055, 0.022, 8), white).position.set(side * 0.05, 1.011, 0.1215);
  }
  const pull = add(root, new THREE.BoxGeometry(0.012, 0.03, 0.006), toon(0xd9dae6));
  pull.position.set(0, 1.097, 0.114);

  // ── Head ─────────────────────────────────────────────────
  const head = new THREE.Group();
  head.position.y = HEAD_Y;
  // Tilted toward the raised hand, chin slightly down.
  head.rotation.set(0.05, -0.1, 0.13);
  root.add(head);

  // phiStart puts the texture seam at the back of the head.
  const skull = new THREE.SphereGeometry(HEAD_R, 72, 56, -Math.PI / 2);
  const sp = skull.getAttribute('position');
  const nose = direction(0, -17);
  const p = new THREE.Vector3();
  for (let i = 0; i < sp.count; i++) {
    p.fromBufferAttribute(sp, i);
    const unit = p.clone().normalize();
    if (p.y < 0) {
      // Full cheeks narrowing to a small, soft chin.
      const t = -p.y / HEAD_R;
      const taper = 1 - 0.4 * Math.pow(t, 1.9) - 0.05 * t;
      p.x *= taper;
      p.z = p.z > 0 ? p.z * (1 - 0.22 * Math.pow(t, 1.7)) + 0.012 * t : p.z * (1 - 0.3 * t);
      p.y *= 1.1;
    }
    // Slightly flattened face with the nose raised from it.
    if (unit.z > 0) p.z -= 0.006 * ease(0.55, 1, unit.z);
    p.addScaledVector(unit, 0.009 * ease(0.985, 0.999, unit.dot(nose)));
    sp.setXYZ(i, p.x, p.y, p.z);
  }
  add(head, skull, toon(0xf9e6da, { map: faceTexture(), soft: true }));

  for (const side of [-1, 1]) {
    const ear = new THREE.Group();
    ear.position.set(side * 0.108, -0.018, -0.004);
    ear.rotation.set(0, side * 0.5, side * -0.12);
    head.add(ear);
    add(ear, new THREE.SphereGeometry(1, 16, 12), skinMat).scale.set(0.011, 0.03, 0.02);
    const hollow = add(ear, new THREE.SphereGeometry(1, 12, 10), toon(0xe2b7a8, { soft: true }), false);
    hollow.scale.set(0.006, 0.019, 0.011);
    hollow.position.set(side * 0.008, -0.002, 0.004);
  }

  // A cap under the locks, tipped back so it reaches the nape and clears the brow.
  const cap = add(head, new THREE.SphereGeometry(HEAD_R * 1.07, 36, 18, 0, Math.PI * 2, 0, Math.PI * 0.56), toon(0xb9b6e2), false);
  cap.rotation.x = -0.5;
  add(head, hairGeometry(), toon(0xffffff, { vertexColors: true }));

  // ── Arms ─────────────────────────────────────────────────
  const sleeve = (points: THREE.Vector3[], creaseAt: number) =>
    sweep(
      points,
      (t) => {
        const base = profile([[0, 0.066], [0.25, 0.06], [0.5, 0.057], [0.86, 0.053], [0.93, 0.049], [0.95, 0.04], [1, 0.039]])(t);
        // Cloth bunching where the arm bends.
        const crease = Math.exp(-Math.pow((t - creaseAt) / 0.16, 2));
        return base * (1 + 0.07 * crease * Math.sin(t * 95));
      },
      56,
      18,
    );
  const placeHand = (wrist: THREE.Vector3, fingers: THREE.Vector3, back: THREE.Vector3, curl: [number, number, number, number, number]) => {
    const y = fingers.clone().normalize();
    const z = back.clone().addScaledVector(y, -back.dot(y)).normalize();
    const x = new THREE.Vector3().crossVectors(y, z);
    const m = add(root, handGeometry(curl), skinMat);
    m.matrixAutoUpdate = false;
    m.matrix.makeBasis(x, y, z).setPosition(wrist);
    return m;
  };

  // His right arm, raised: index and middle finger laid against the hair above his temple.
  head.updateMatrix();
  const temple = direction(-58, 33).multiplyScalar(HEAD_R * 1.24).applyMatrix4(head.matrix);
  const point = V(1, 0.3, -0.12).normalize();
  const wristR = temple.clone().addScaledVector(point, -0.156);
  const elbowR = V(-0.385, 1.2, 0.035);
  const shoulderR = V(-0.15, 1.172, 0);
  add(
    root,
    sleeve([shoulderR.clone().add(V(0.03, 0.005, 0)), shoulderR.clone().lerp(elbowR, 0.5).add(V(0, -0.012, 0)), elbowR, elbowR.clone().lerp(wristR, 0.55), wristR.clone().addScaledVector(point, -0.012)], 0.5),
    hoodie,
  );
  placeHand(wristR.clone().addScaledVector(point, -0.022), point, V(0, 0.72, -0.6), [1, 0, 0, 0.95, 1]);

  // His left arm hangs loose, fingers lightly curled.
  const shoulderL = V(0.15, 1.172, 0);
  const elbowL = V(0.208, 0.94, -0.022);
  const wristL = V(0.214, 0.715, 0.03);
  add(root, sleeve([shoulderL.clone().add(V(-0.03, 0.005, 0)), shoulderL.clone().lerp(elbowL, 0.5).add(V(0.012, 0, 0)), elbowL, elbowL.clone().lerp(wristL, 0.5), wristL], 0.52), hoodie);
  const left = placeHand(wristL.clone().add(V(0, 0.016, 0)), V(-0.04, -1, 0.14), V(1, 0, 0.1), [0.25, 0.28, 0.34, 0.4, 0.46]);
  left.matrix.scale(V(-1, 1, 1)); // mirror, so the thumb sits forward

  // ── His skateboard, set down beside him ──────────────────
  const board = new THREE.Group();
  board.position.set(0.5, 0, 0.16);
  board.rotation.y = -0.45;
  root.add(board);
  const outline = new THREE.Shape();
  outline.absarc(-0.19, 0, 0.07, Math.PI / 2, (Math.PI * 3) / 2);
  outline.absarc(0.19, 0, 0.07, -Math.PI / 2, Math.PI / 2);
  outline.closePath();
  const deckGeo = new THREE.ExtrudeGeometry(outline, { depth: 0.014, bevelEnabled: false, curveSegments: 10 });
  const dp = deckGeo.getAttribute('position');
  const duv = deckGeo.getAttribute('uv');
  for (let i = 0; i < dp.count; i++) duv.setXY(i, dp.getX(i) / 0.52 + 0.5, dp.getY(i) / 0.14 + 0.5);
  const deck = add(board, deckGeo, toon(0xf0bf2c, { map: deckTexture() }));
  deck.rotation.x = -Math.PI / 2;
  deck.position.y = 0.062;
  for (const x of [-0.15, 0.15]) {
    for (const z of [-0.05, 0.05]) {
      const w = add(board, new THREE.CylinderGeometry(0.024, 0.024, 0.022, 14), white);
      w.rotation.x = Math.PI / 2;
      w.position.set(x, 0.024, z);
    }
    add(board, new THREE.BoxGeometry(0.03, 0.02, 0.09), shorts, false).position.set(x, 0.05, 0);
  }

  // ── His own light ────────────────────────────────────────
  const centre = CHARACTER_POS.clone().setY(1.4);
  const lamp = new THREE.SpotLight(0xf4e4ff, 58, 16, 0.32, 0.85, 2);
  lamp.position.set(CHARACTER_POS.x + 0.2, 6.4, CHARACTER_POS.z + 5);
  lamp.target.position.copy(centre);
  lamp.castShadow = true;
  lamp.shadow.mapSize.set(1024, 1024);
  lamp.shadow.camera.near = 3;
  lamp.shadow.camera.far = 12;
  lamp.shadow.bias = -0.0015;
  lamp.shadow.normalBias = 0.02;
  scene.add(lamp, lamp.target);

  // Pink from behind and a violet fill from the far side, like the lamps around the sword.
  const rim = new THREE.PointLight(0xff5a94, 7, 6, 2);
  rim.position.set(CHARACTER_POS.x + 1.1, 2.7, CHARACTER_POS.z - 1.5);
  const fill = new THREE.PointLight(0x9a7cff, 4, 6, 2);
  fill.position.set(CHARACTER_POS.x - 1.8, 1.6, CHARACTER_POS.z + 1.2);
  scene.add(rim, fill);

  const shade = new THREE.Mesh(
    new THREE.PlaneGeometry(1.8, 1.8),
    new THREE.MeshBasicMaterial({ map: tex.contact(0.25), transparent: true, opacity: 0.6, depthWrite: false }),
  );
  shade.rotation.x = -Math.PI / 2;
  shade.position.copy(CHARACTER_POS).setY(0.022);
  shade.renderOrder = 1;
  scene.add(shade);

  const hitTarget = new THREE.Mesh(
    new THREE.CylinderGeometry(0.62, 0.46, 2.7, 12),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  hitTarget.position.copy(CHARACTER_POS).setY(1.35);
  scene.add(hitTarget);

  const bodyY = 1.22;
  const faceY = HEAD_Y * SCALE;
  return {
    facing: FACING,
    labelAnchor: CHARACTER_POS.clone().setY(2.84),
    hitTarget,
    focus: (closeness, out) => out.copy(CHARACTER_POS).setY(bodyY + (faceY - bodyY) * closeness),
  };
}
