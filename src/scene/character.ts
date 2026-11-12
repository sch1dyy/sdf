import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../util/math';
import * as tex from './textures';

// A fan-made parody figure: Killua Zoldyck (Hunter x Hunter) reimagined as the GIGACHAD meme.
// Sculpted entirely in code: a V-shaped torso, slab jaw and bare arms under a hoodie whose
// sleeves did not survive, still giving his two-finger salute. Cel-shaded and ink-outlined,
// with smooth high-resolution textures, so he stands out from the rougher shrine around him.

/** Where he stands: behind the sword and to its right, outside the scene camera's orbit. */
export const CHARACTER_POS = new THREE.Vector3(2.9, 0, -4.4);
/** He faces the opening camera position. */
const FACING = -0.33;
const SCALE = 1.3;
const HEAD_Y = 1.76;
const HEAD_R = 0.115;
/** The hoodie runs from the hem to the collar between these heights. */
const TORSO_BOTTOM = 0.96;
const TORSO_TOP = 1.61;

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
function shell(sections: number[][], seg = 48): THREE.BufferGeometry {
  return skin(
    sections.map(([y, rx, rz, oz = 0]) =>
      Array.from({ length: seg }, (_, i) => {
        const a = (i / seg) * Math.PI * 2;
        return V(-Math.sin(a) * rx, y, -Math.cos(a) * rz + oz);
      }),
    ),
  );
}

/** A tube of varying radius swept along a smooth path: limbs, muscles, cloth rolls. */
function sweep(points: THREE.Vector3[], radius: (t: number) => number, seg = 24, radial = 18): THREE.BufferGeometry {
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
    const jaw = ctx.createLinearGradient(0, at(0, -50)[1], 0, at(0, -66)[1]);
    jaw.addColorStop(0, 'rgba(214,160,148,0)');
    jaw.addColorStop(1, 'rgba(214,160,148,0.9)');
    ctx.fillStyle = jaw;
    ctx.fillRect(0, H / 2, W, H / 2);

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const soft = (blur: number, draw: () => void) => {
      ctx.filter = `blur(${blur}px)`;
      draw();
      ctx.filter = 'none';
    };

    for (const side of [-1, 1]) {
      // The hollow under each cheekbone and the hard line of the jaw.
      soft(16, () => {
        ctx.strokeStyle = 'rgba(206,160,160,0.42)';
        ctx.lineWidth = 30;
        ctx.beginPath();
        ctx.moveTo(...at(side * 58, -12));
        ctx.quadraticCurveTo(...at(side * 40, -22), ...at(side * 25, -40));
        ctx.stroke();
      });
      soft(7, () => {
        ctx.strokeStyle = 'rgba(186,140,140,0.4)';
        ctx.lineWidth = 7;
        ctx.beginPath();
        ctx.moveTo(...at(side * 78, -22));
        ctx.quadraticCurveTo(...at(side * 62, -47), ...at(side * 30, -55));
        ctx.stroke();
      });
      // Deep-set sockets.
      const [sx, sy] = at(side * 20, -1);
      const socket = ctx.createRadialGradient(sx, sy, 0, sx, sy, 15 * k);
      socket.addColorStop(0, 'rgba(170,120,140,0.4)');
      socket.addColorStop(1, 'rgba(170,120,140,0)');
      ctx.fillStyle = socket;
      ctx.fillRect(sx - 15 * k, sy - 15 * k, 30 * k, 30 * k);

      // Narrowed, level eyes; +x is the outer corner.
      const [cx, cy] = at(side * 20, -5);
      const w = 11 * k;
      const h = 4.6 * k;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(side, 1);

      const upper = (p: Path2D | CanvasRenderingContext2D) => p.bezierCurveTo(-0.5 * w, -0.95 * h, 0.5 * w, -1.05 * h, w, -0.5 * h);
      const lid = new Path2D();
      lid.moveTo(-w, 0.1 * h);
      upper(lid);
      lid.bezierCurveTo(0.8 * w, 0.75 * h, -0.4 * w, 0.95 * h, -w, 0.1 * h);
      lid.closePath();

      ctx.save();
      ctx.clip(lid);
      ctx.fillStyle = '#fcfcff';
      ctx.fillRect(-w * 1.3, -h * 2, w * 2.6, h * 4);
      const iris = ctx.createLinearGradient(0, -1.3 * h, 0, 1.2 * h);
      iris.addColorStop(0, '#1d2a60');
      iris.addColorStop(0.5, '#3f5cb4');
      iris.addColorStop(1, '#a5c8f8');
      ctx.fillStyle = iris;
      ctx.beginPath();
      ctx.ellipse(-0.04 * w, -0.1 * h, 0.44 * w, 1.3 * h, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 0.07 * w;
      ctx.strokeStyle = '#141d4a';
      ctx.stroke();
      ctx.fillStyle = '#0e1233';
      ctx.beginPath();
      ctx.ellipse(-0.04 * w, -0.1 * h, 0.17 * w, 0.62 * h, 0, 0, Math.PI * 2);
      ctx.fill();
      const shadow = ctx.createLinearGradient(0, -1.05 * h, 0, 0);
      shadow.addColorStop(0, 'rgba(10,14,48,0.7)');
      shadow.addColorStop(1, 'rgba(10,14,48,0)');
      ctx.fillStyle = shadow;
      ctx.fillRect(-w * 1.3, -h * 2, w * 2.6, h * 2);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.ellipse(-0.04 * w - 0.2 * w * side, -0.3 * h, 0.11 * w, 0.3 * h, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      ctx.strokeStyle = '#1b1722';
      ctx.lineWidth = 0.17 * w;
      ctx.beginPath();
      ctx.moveTo(-w, 0.1 * h);
      upper(ctx);
      ctx.lineTo(1.2 * w, -0.8 * h);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(70,45,58,0.85)';
      ctx.lineWidth = 0.05 * w;
      ctx.beginPath();
      ctx.moveTo(w, -0.5 * h);
      ctx.bezierCurveTo(0.8 * w, 0.75 * h, -0.4 * w, 0.95 * h, -0.85 * w, 0.4 * h);
      ctx.stroke();

      // Heavy, low brows that drop toward the nose.
      const browShape = new Path2D();
      browShape.moveTo(-1.12 * w, -1.5 * h);
      browShape.quadraticCurveTo(0.1 * w, -3.0 * h, 1.3 * w, -2.35 * h);
      browShape.quadraticCurveTo(0.2 * w, -2.1 * h, -1.0 * w, -0.95 * h);
      browShape.closePath();
      ctx.fillStyle = '#9092ae';
      ctx.fill(browShape);
      ctx.strokeStyle = '#5c5e7c';
      ctx.lineWidth = 0.05 * w;
      ctx.stroke(browShape);
      ctx.restore();
    }

    // A long, straight nose: shadow down one side and under the tip.
    ctx.strokeStyle = 'rgba(196,140,134,0.8)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(...at(2.6, -4));
    ctx.lineTo(...at(3.2, -19));
    ctx.stroke();
    ctx.fillStyle = 'rgba(186,128,124,0.85)';
    ctx.beginPath();
    ctx.moveTo(...at(-3.6, -21.5));
    ctx.quadraticCurveTo(...at(0, -19.5), ...at(3.8, -21.5));
    ctx.quadraticCurveTo(...at(0, -24), ...at(-3.6, -21.5));
    ctx.fill();

    // A closed, one-sided smirk.
    const [mx, my] = at(0.5, -33);
    ctx.strokeStyle = '#6a3038';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(mx - 7 * k, my + 0.5 * k);
    ctx.quadraticCurveTo(mx + 1 * k, my + 0.9 * k, mx + 7 * k, my - 1.3 * k);
    ctx.lineTo(mx + 8.2 * k, my - 2.4 * k);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(190,130,125,0.75)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(mx - 3.4 * k, my + 3.3 * k);
    ctx.quadraticCurveTo(mx, my + 4 * k, mx + 3.6 * k, my + 3 * k);
    ctx.stroke();
    // The cleft of the chin.
    ctx.strokeStyle = 'rgba(186,128,124,0.8)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(...at(0, -43));
    ctx.lineTo(...at(0, -49));
    ctx.stroke();
  });
}

/**
 * The hoodie, hanging open over a tight white tee. u = 0.5 is the front, v runs hem to collar.
 */
function torsoTexture(): THREE.Texture {
  const S = 1024;
  return canvasTexture(S, S, (ctx) => {
    const X = (u: number) => u * S;
    const Y = (v: number) => (1 - v) * S;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.fillStyle = '#857abf';
    ctx.fillRect(0, 0, S, S);

    const rand = mulberry32(31);
    const crease = (x0: number, y0: number, x1: number, y1: number, width: number, alpha: number) => {
      for (const [d, style] of [[0, `rgba(58,48,112,${alpha})`], [width * 0.9, `rgba(176,166,226,${alpha * 0.7})`]] as const) {
        ctx.strokeStyle = style;
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(x0, y0 + d);
        ctx.quadraticCurveTo((x0 + x1) / 2, (y0 + y1) / 2 + d + (rand() - 0.5) * 24, x1, y1 + d);
        ctx.stroke();
      }
    };
    ctx.filter = 'blur(5px)';
    // Cloth pulled taut across the back and round the ribs.
    for (let i = 0; i < 22; i++) {
      const x = rand() * S;
      const y = Y(0.2 + rand() * 0.6);
      crease(x, y, x + 90 + rand() * 120, y + (rand() - 0.5) * 50, 8 + rand() * 8, 0.3);
    }
    for (const side of [-1, 1]) {
      for (let i = 0; i < 5; i++) crease(X(0.5 + side * 0.27), Y(0.74 - i * 0.05), X(0.5 + side * 0.16), Y(0.62 - i * 0.08), 10, 0.36);
    }
    for (let i = 0; i < 44; i++) crease((i / 44) * S, Y(0.15), (i / 44) * S + rand() * 10, Y(0.1), 6, 0.3);
    ctx.filter = 'none';
    const hood = ctx.createLinearGradient(0, Y(1), 0, Y(0.84));
    hood.addColorStop(0, 'rgba(50,40,100,0.55)');
    hood.addColorStop(1, 'rgba(50,40,100,0)');
    ctx.fillStyle = hood;
    ctx.fillRect(0, 0, S, Y(0.84));

    // Ribbed hem.
    ctx.fillStyle = '#7469ae';
    ctx.fillRect(0, Y(0.09), S, S);
    ctx.fillStyle = 'rgba(52,44,104,0.5)';
    for (let x = 0; x < S; x += 9) ctx.fillRect(x, Y(0.09), 3, S);
    ctx.fillRect(0, Y(0.095), S, 4);

    // The open front, showing the tee stretched over chest and stomach.
    const open = new Path2D();
    open.moveTo(X(0.3), Y(1));
    open.lineTo(X(0.355), Y(0.62));
    open.lineTo(X(0.43), Y(0));
    open.lineTo(X(0.57), Y(0));
    open.lineTo(X(0.645), Y(0.62));
    open.lineTo(X(0.7), Y(1));
    open.closePath();

    ctx.save();
    ctx.clip(open);
    ctx.fillStyle = '#f0eef6';
    ctx.fillRect(0, 0, S, S);
    ctx.filter = 'blur(3px)';
    ctx.strokeStyle = 'rgba(136,134,184,0.6)';
    ctx.lineWidth = 7;
    // Line between the pectorals and down the middle of the stomach.
    ctx.beginPath();
    ctx.moveTo(X(0.5), Y(0.8));
    ctx.lineTo(X(0.5), Y(0.12));
    ctx.stroke();
    for (const side of [-1, 1]) {
      // Under each pectoral, then the outer edge of the abdominals.
      ctx.beginPath();
      ctx.moveTo(X(0.5), Y(0.555));
      ctx.quadraticCurveTo(X(0.5 + side * 0.08), Y(0.52), X(0.5 + side * 0.15), Y(0.6));
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(X(0.5 + side * 0.075), Y(0.5));
      ctx.quadraticCurveTo(X(0.5 + side * 0.07), Y(0.3), X(0.5 + side * 0.045), Y(0.14));
      ctx.stroke();
    }
    for (const v of [0.425, 0.315, 0.21]) {
      ctx.beginPath();
      ctx.moveTo(X(0.43), Y(v));
      ctx.lineTo(X(0.57), Y(v));
      ctx.stroke();
    }
    ctx.filter = 'none';
    // Crew neck.
    ctx.strokeStyle = '#cfcce0';
    ctx.lineWidth = 12;
    ctx.beginPath();
    ctx.moveTo(X(0.3), Y(0.94));
    ctx.quadraticCurveTo(X(0.5), Y(0.86), X(0.7), Y(0.94));
    ctx.stroke();
    ctx.restore();

    // Zip tape and teeth down both open edges.
    ctx.strokeStyle = '#6a5fa3';
    ctx.lineWidth = 24;
    ctx.stroke(open);
    ctx.strokeStyle = '#d9dae6';
    ctx.lineWidth = 6;
    ctx.lineCap = 'butt';
    ctx.setLineDash([5, 5]);
    ctx.stroke(open);
    ctx.setLineDash([]);
  });
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
      flow.add(V(Math.sign(d.x) * 0.45, -0.1, -0.35));
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

  // The fringe: strands across the brow, kept clear of the eyes.
  const fringe: [number, number, number, number][] = [
    // [longitude at the tip, latitude at the tip, sideways drift from the root, width]
    [-58, 8, -8, 0.026],
    [-46, 16, -4, 0.027],
    [-35, 10, -6, 0.028],
    [-24, 17, 3, 0.026],
    [-14, 11, -5, 0.027],
    [-5, 6, -3, 0.024],
    [4, 9, 5, 0.022],
    [13, 15, 2, 0.026],
    [23, 10, 6, 0.028],
    [33, 16, 3, 0.026],
    [44, 9, 7, 0.028],
    [56, 12, 6, 0.026],
  ];
  for (const [lon, lat, drift, width] of fringe) {
    const rootLat = 50 + rand() * 12;
    const root = direction(lon - drift, rootLat).multiplyScalar(scalp);
    const bend = direction(lon - drift * 0.4, (rootLat + lat) / 2 + 12).multiplyScalar(HEAD_R * 1.34);
    const tip = direction(lon, lat).multiplyScalar(HEAD_R * 1.12);
    locks.push(lock(root, bend, tip, width, direction(lon, 25)));
  }
  // Strands in front of each ear.
  for (const side of [-1, 1]) {
    for (const [lon, top, bottom, width] of [[74, 36, 6, 0.022], [88, 38, 2, 0.024], [100, 30, -4, 0.022]]) {
      const root = direction(side * lon, top).multiplyScalar(scalp);
      const bend = direction(side * (lon + 6), (top + bottom) / 2).multiplyScalar(HEAD_R * 1.3);
      const tip = direction(side * (lon - 2), bottom).multiplyScalar(HEAD_R * 1.12);
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
  palm.scale.set(0.039, 0.043, 0.017);
  palm.position.set(0, 0.043, 0);
  const heel = part(root, new THREE.SphereGeometry(1, 14, 10));
  heel.scale.set(0.031, 0.024, 0.019);
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
  digit(0.027, 0.078, 0.07, 0.0098, curl[1], -0.03);
  digit(0.0085, 0.083, 0.077, 0.01, curl[2], 0.0);
  digit(-0.0095, 0.08, 0.071, 0.0096, curl[3], 0.04);
  digit(-0.0265, 0.071, 0.056, 0.0086, curl[4], 0.09);

  // The thumb folds across the palm as it curls.
  const thumb = new THREE.Group();
  thumb.position.set(0.031, 0.026, -0.004);
  thumb.rotation.set(-0.5 * curl[0] - 0.2, 0, mix(-0.75, 0.35, curl[0]));
  root.add(thumb);
  part(thumb, new THREE.CapsuleGeometry(0.0115, 0.034, 5, 10)).position.y = 0.017;
  const tip = new THREE.Group();
  tip.position.y = 0.034;
  tip.rotation.z = 0.5 + curl[0] * 0.5;
  thumb.add(tip);
  part(tip, new THREE.CapsuleGeometry(0.01, 0.028, 5, 10)).position.y = 0.014;

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

  // Flat bands of light and shade, as in cel animation. Skin gets a firm step too, so the
  // muscles read.
  const ramp = (levels: number[]) => {
    const t = new THREE.DataTexture(new Uint8Array(levels), levels.length, 1, THREE.RedFormat);
    t.minFilter = t.magFilter = THREE.NearestFilter;
    t.needsUpdate = true;
    return t;
  };
  const clothRamp = ramp([105, 160, 215, 255]);
  const skinRamp = ramp([130, 195, 255]);

  interface ToonOptions {
    map?: THREE.Texture;
    side?: THREE.Side;
    soft?: boolean;
    vertexColors?: boolean;
  }
  const toon = (color: number, o: ToonOptions = {}) =>
    new THREE.MeshToonMaterial({
      color: o.map || o.vertexColors ? 0xffffff : color,
      ...(o.map ? { map: o.map, emissiveMap: o.map } : {}),
      gradientMap: o.soft ? skinRamp : clothRamp,
      vertexColors: o.vertexColors ?? false,
      // A little self-light keeps his colours true under the shrine's pink lamps.
      emissive: o.map ? 0xffffff : color,
      emissiveIntensity: o.soft ? 0.06 : 0.07,
      side: o.side ?? THREE.FrontSide,
    });

  const ink = new THREE.MeshBasicMaterial({ color: 0x1a1230, side: THREE.BackSide });
  ink.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n  transformed += normalize(normal) * 0.0026;',
    );
  };

  const add = (parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, outlined = true) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    if (outlined) m.add(new THREE.Mesh(geo, ink));
    parent.add(m);
    return m;
  };
  const ball = (at: THREE.Vector3, sx: number, sy: number, sz: number, mat: THREE.Material, outlined = true) => {
    const m = add(root, new THREE.SphereGeometry(1, 24, 16), mat, outlined);
    m.scale.set(sx, sy, sz);
    m.position.copy(at);
    return m;
  };
  /** A straight muscle or bone between two points, with a radius profile along it. */
  const limb = (a: THREE.Vector3, b: THREE.Vector3, stops: [number, number][], mat: THREE.Material) =>
    add(root, sweep([a, a.clone().lerp(b, 0.5), b], profile(stops), 22, 20), mat);

  const skinMat = toon(0xf9e6da, { soft: true });
  const hoodie = toon(0x857abf);
  const hoodieDark = toon(0x7469ae);
  const shorts = toon(0x2b2d4d, { side: THREE.DoubleSide });
  const shoe = toon(0x4d3fa6);
  const white = toon(0xf0eef6);

  // ── Legs: a wide, planted stance ─────────────────────────
  for (const side of [-1, 1]) {
    const hip = V(side * 0.1, 0.98, 0);
    const knee = V(side * 0.135, 0.52, 0.02);
    const ankle = V(side * 0.165, 0.14, 0);
    limb(knee.clone().lerp(hip, 0.25), knee, [[0, 0.092], [0.6, 0.082], [1, 0.07]], skinMat);
    // Calves like upturned bottles.
    add(
      root,
      sweep([knee, knee.clone().lerp(ankle, 0.4).add(V(0, 0, -0.022)), ankle], profile([[0, 0.068], [0.3, 0.084], [0.5, 0.08], [0.8, 0.052], [1, 0.046]]), 22, 20),
      skinMat,
    );
    ball(knee.clone().add(V(0, 0, 0.012)), 0.066, 0.07, 0.066, skinMat);
    // Shorts strained round the thighs, with a turned hem.
    const hem = knee.clone().lerp(hip, 0.14);
    add(root, sweep([hip, hip.clone().lerp(hem, 0.5).add(V(side * 0.012, 0, 0.012)), hem], profile([[0, 0.118], [0.5, 0.128], [0.9, 0.118], [0.94, 0.125], [1, 0.123]]), 16, 24), shorts);

    const foot = new THREE.Group();
    foot.position.set(ankle.x, 0, ankle.z);
    foot.rotation.y = side * 0.22;
    foot.scale.setScalar(1.3);
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
  add(root, shell([[0.84, 0.15, 0.11], [0.9, 0.205, 0.128], [0.99, 0.2, 0.126], [1.04, 0.165, 0.11]]), shorts);
  ball(V(0, 0.88, 0), 0.17, 0.075, 0.115, shorts, false);

  // ── Torso: shoulders three heads wide over a narrow waist ─
  add(
    root,
    shell([
      [TORSO_BOTTOM, 0.155, 0.112],
      [1.0, 0.16, 0.116],
      [1.03, 0.172, 0.126],
      [1.1, 0.158, 0.11],
      [1.2, 0.182, 0.118],
      [1.3, 0.235, 0.136, 0.004],
      [1.4, 0.288, 0.15, 0.008],
      [1.48, 0.302, 0.146, 0.004],
      [1.54, 0.27, 0.122],
      [1.585, 0.17, 0.094],
      [TORSO_TOP, 0.095, 0.078],
    ]),
    toon(0x857abf, { map: torsoTexture() }),
  );
  // Chest and stomach pushing the tee out.
  for (const side of [-1, 1]) {
    const pec = ball(V(side * 0.103, 1.415, 0.107), 0.112, 0.086, 0.07, white);
    pec.rotation.z = side * 0.18;
    [1.275, 1.2, 1.13].forEach((y, row) => ball(V(side * 0.043, y, 0.106 - row * 0.011), 0.04, 0.032, 0.014, white, false));
  }

  // Trapezius rising to a neck as wide as his jaw.
  for (const side of [-1, 1]) {
    add(root, sweep([V(side * 0.03, 1.66, -0.025), V(side * 0.13, 1.615, -0.02), V(side * 0.26, 1.555, -0.005)], profile([[0, 0.045], [0.5, 0.058], [1, 0.05]]), 14, 16), hoodie, false);
  }
  add(root, sweep([V(0, 1.55, -0.012), V(0, 1.63, -0.002), V(0, 1.71, 0.006)], profile([[0, 0.088], [0.5, 0.074], [1, 0.072]]), 10, 20), skinMat);
  // Tendons of the neck.
  for (const side of [-1, 1]) {
    limb(V(side * 0.062, 1.715, -0.02), V(side * 0.022, 1.585, 0.06), [[0, 0.016], [0.5, 0.018], [1, 0.012]], skinMat);
  }

  // The hood, lying in a thick roll behind the neck.
  const hoodPath: THREE.Vector3[] = [];
  for (let deg = 62; deg <= 298; deg += 14) {
    const a = (deg * Math.PI) / 180;
    const back = (1 - Math.cos(a)) / 2;
    hoodPath.push(V(Math.sin(a) * mix(0.115, 0.165, back), 1.63 - 0.06 * Math.pow(back, 1.6), Math.cos(a) * 0.1 - 0.03 - 0.07 * back));
  }
  add(root, sweep(hoodPath, (t) => 0.016 + 0.05 * Math.pow(Math.sin(Math.PI * t), 0.8), 40, 14), hoodie);
  ball(V(0, 1.565, -0.135), 0.1, 0.055, 0.06, hoodieDark, false);

  // ── Head ─────────────────────────────────────────────────
  const head = new THREE.Group();
  head.position.y = HEAD_Y;
  // Chin lifted, turned a little toward the raised hand.
  head.rotation.set(-0.07, -0.16, 0.07);
  root.add(head);

  // phiStart puts the texture seam at the back of the head.
  const skull = new THREE.SphereGeometry(HEAD_R, 96, 72, -Math.PI / 2);
  const sp = skull.getAttribute('position');
  const p = new THREE.Vector3();
  const bump = (unit: THREE.Vector3, lon: number, lat: number, from: number, to: number) =>
    Math.max(ease(from, to, unit.dot(direction(lon, lat))), ease(from, to, unit.dot(direction(-lon, lat))));
  for (let i = 0; i < sp.count; i++) {
    p.fromBufferAttribute(sp, i);
    const unit = p.clone().normalize();
    const lat = (Math.asin(unit.y) * 180) / Math.PI;
    if (p.y < 0) {
      // The jaw: it stays nearly as wide as the skull, drops a long way, and ends in a
      // broad chin cut off flat.
      const t = -p.y / HEAD_R;
      p.x *= (1 - 0.1 * t * t) * (1 + 0.14 * ease(0.15, 0.55, t)) * (1 - 0.24 * ease(0.55, 0.8, t));
      p.z = p.z > 0 ? p.z * (1 - 0.08 * t * t) + 0.024 * t : p.z * (1 - 0.35 * t);
      p.y = Math.max(p.y, -0.8 * HEAD_R) * 1.55;
    }
    // Slightly flattened face, with brow ridge, cheekbones, hollow cheeks and a strong nose.
    if (unit.z > 0) p.z -= 0.005 * ease(0.55, 1, unit.z);
    p.addScaledVector(unit, 0.007 * ease(0.3, 0.6, unit.z) * Math.exp(-Math.pow((lat - 11) / 6, 2)));
    p.addScaledVector(unit, 0.008 * bump(unit, 40, -7, 0.94, 0.995));
    p.addScaledVector(unit, -0.007 * bump(unit, 42, -34, 0.94, 0.99));
    p.addScaledVector(unit, 0.013 * Math.max(ease(0.988, 0.999, unit.dot(direction(0, -11))), ease(0.986, 0.999, unit.dot(direction(0, -19)))));
    sp.setXYZ(i, p.x, p.y, p.z);
  }
  skull.computeVertexNormals();
  add(head, skull, toon(0xf9e6da, { map: faceTexture(), soft: true }));

  for (const side of [-1, 1]) {
    const ear = new THREE.Group();
    ear.position.set(side * 0.11, -0.028, -0.004);
    ear.rotation.set(0, side * 0.5, side * -0.1);
    head.add(ear);
    add(ear, new THREE.SphereGeometry(1, 16, 12), skinMat).scale.set(0.012, 0.034, 0.022);
    const hollow = add(ear, new THREE.SphereGeometry(1, 12, 10), toon(0xe2b7a8, { soft: true }), false);
    hollow.scale.set(0.006, 0.021, 0.012);
    hollow.position.set(side * 0.008, -0.002, 0.004);
  }

  // A cap under the locks, tipped back so it reaches the nape and clears the brow.
  const cap = add(head, new THREE.SphereGeometry(HEAD_R * 1.07, 36, 18, 0, Math.PI * 2, 0, Math.PI * 0.56), toon(0xa9a5d8), false);
  cap.rotation.x = -0.5;
  add(head, hairGeometry(), toon(0xffffff, { vertexColors: true }));

  // ── Arms: bare, the sleeves long gone ────────────────────
  const HAND = 1.28;
  const placeHand = (wrist: THREE.Vector3, fingers: THREE.Vector3, back: THREE.Vector3, curl: [number, number, number, number, number], mirror = false) => {
    const y = fingers.clone().normalize();
    const z = back.clone().addScaledVector(y, -back.dot(y)).normalize();
    const x = new THREE.Vector3().crossVectors(y, z);
    const m = add(root, handGeometry(curl), skinMat);
    m.matrixAutoUpdate = false;
    m.matrix.makeBasis(x, y, z).setPosition(wrist).scale(V(mirror ? -HAND : HAND, HAND, HAND));
  };
  const arm = (side: number, shoulder: THREE.Vector3, elbow: THREE.Vector3, wrist: THREE.Vector3, flexed: boolean) => {
    // Deltoid, with the torn armhole of the hoodie round it.
    ball(shoulder.clone().add(V(side * 0.012, 0.004, 0)), 0.108, 0.1, 0.104, skinMat);
    const rag = add(root, new THREE.TorusGeometry(0.094, 0.015, 8, 28), hoodieDark);
    rag.position.copy(shoulder).add(V(side * -0.05, -0.012, 0));
    rag.rotation.set(0, Math.PI / 2, 0);
    rag.rotateX(side * -0.28);
    limb(shoulder, elbow, flexed ? [[0, 0.08], [0.25, 0.086], [0.55, 0.1], [0.82, 0.078], [1, 0.062]] : [[0, 0.08], [0.3, 0.092], [0.6, 0.09], [1, 0.062]], skinMat);
    ball(elbow, 0.064, 0.064, 0.064, skinMat);
    limb(elbow, wrist, [[0, 0.062], [0.22, 0.08], [0.55, 0.066], [0.85, 0.046], [1, 0.041]], skinMat);
    ball(wrist, 0.042, 0.042, 0.042, skinMat, false);
  };

  // His right arm, raised and flexed: index and middle finger against the hair at his temple.
  head.updateMatrix();
  const temple = direction(-58, 33).multiplyScalar(HEAD_R * 1.22).applyMatrix4(head.matrix);
  const point = V(1, 0.3, -0.12).normalize();
  const wristR = temple.clone().addScaledVector(point, -0.156 * HAND - 0.012);
  arm(-1, V(-0.31, 1.53, 0), V(-0.585, 1.63, 0.04), wristR, true);
  placeHand(wristR, point, V(0, 0.72, -0.6), [1, 0, 0, 0.95, 1]);

  // His left arm hangs wide of the body, the way arms do when the lats are in the way.
  const wristL = V(0.445, 0.985, 0.05);
  arm(1, V(0.31, 1.53, 0), V(0.415, 1.25, -0.03), wristL, false);
  placeHand(wristL, V(0.02, -1, 0.12), V(1, 0, 0.1), [0.85, 1, 1, 1, 1], true);

  // ── His skateboard, set down beside him ──────────────────
  const board = new THREE.Group();
  board.position.set(0.72, 0, 0.22);
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
  const centre = CHARACTER_POS.clone().setY(1.6);
  const lamp = new THREE.SpotLight(0xf4e4ff, 36, 16, 0.36, 0.85, 2);
  lamp.position.set(CHARACTER_POS.x + 0.9, 6.6, CHARACTER_POS.z + 4.6);
  lamp.target.position.copy(centre);
  lamp.castShadow = true;
  lamp.shadow.mapSize.set(1024, 1024);
  lamp.shadow.camera.near = 3;
  lamp.shadow.camera.far = 12;
  lamp.shadow.bias = -0.0015;
  lamp.shadow.normalBias = 0.02;
  scene.add(lamp, lamp.target);

  // Pink from behind and a violet fill from the far side, like the lamps around the sword.
  const rim = new THREE.PointLight(0xff5a94, 6, 6, 2);
  rim.position.set(CHARACTER_POS.x + 1.2, 2.9, CHARACTER_POS.z - 1.5);
  const fill = new THREE.PointLight(0x9a7cff, 4, 6, 2);
  fill.position.set(CHARACTER_POS.x - 1.9, 1.7, CHARACTER_POS.z + 1.2);
  scene.add(rim, fill);

  const shade = new THREE.Mesh(
    new THREE.PlaneGeometry(2.2, 2.2),
    new THREE.MeshBasicMaterial({ map: tex.contact(0.25), transparent: true, opacity: 0.6, depthWrite: false }),
  );
  shade.rotation.x = -Math.PI / 2;
  shade.position.copy(CHARACTER_POS).setY(0.022);
  shade.renderOrder = 1;
  scene.add(shade);

  const hitTarget = new THREE.Mesh(
    new THREE.CylinderGeometry(0.76, 0.5, 2.75, 12),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  hitTarget.position.copy(CHARACTER_POS).setY(1.375);
  scene.add(hitTarget);

  const bodyY = 1.36;
  const faceY = (HEAD_Y - 0.03) * SCALE;
  return {
    facing: FACING,
    labelAnchor: CHARACTER_POS.clone().setY(2.86),
    hitTarget,
    focus: (closeness, out) => out.copy(CHARACTER_POS).setY(bodyY + (faceY - bodyY) * closeness),
  };
}
