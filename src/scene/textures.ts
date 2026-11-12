import * as THREE from 'three';
import { hash2, mulberry32, vnoise } from '../util/math';

// Every texture in the scene is painted here at PS2-era sizes, so nothing has to be downloaded.

type RGBA = [number, number, number, number?];

interface TexOpts {
  repeat?: [number, number];
  /** Non-colour data (roughness and so on). */
  data?: boolean;
  smooth?: boolean;
  clamp?: boolean;
}

function makeCanvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return { c, ctx: c.getContext('2d')! };
}

function paint(ctx: CanvasRenderingContext2D, w: number, h: number, fn: (x: number, y: number) => RGBA): void {
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = fn(x, y);
      const i = (y * w + x) * 4;
      img.data[i] = c[0];
      img.data[i + 1] = c[1];
      img.data[i + 2] = c[2];
      img.data[i + 3] = c[3] ?? 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function finish(c: HTMLCanvasElement, o: TexOpts = {}): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  // Chunky texels up close, but filtered in the distance so surfaces do not shimmer.
  t.magFilter = o.smooth ? THREE.LinearFilter : THREE.NearestFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.anisotropy = 8;
  t.wrapS = t.wrapT = o.clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
  if (o.repeat) t.repeat.set(o.repeat[0], o.repeat[1]);
  t.colorSpace = o.data ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  return t;
}

/** A few short strokes on a small grid: reads as weathered calligraphy at this resolution. */
function glyph(ctx: CanvasRenderingContext2D, rand: () => number, strokes = 4): void {
  for (let s = 0; s < strokes; s++) {
    const p = Math.floor(rand() * 4) * 2 - 4;
    const len = 4 + Math.floor(rand() * 5);
    const off = -Math.floor(len / 2) + Math.floor(rand() * 3) - 1;
    if (rand() > 0.45) ctx.fillRect(off, p, len, 1);
    else ctx.fillRect(p, off, 1, len);
  }
}

// ── Ground and stone ───────────────────────────────────────

/** Courtyard paving: alternating warm and grey-green tiles, like an old checkerboard floor. */
export function stoneTiles(repeat: [number, number]): THREE.Texture {
  const S = 128;
  const T = 64;
  const { c, ctx } = makeCanvas(S, S);
  paint(ctx, S, S, (x, y) => {
    const lx = x % T;
    const ly = y % T;
    const n = hash2(x, y, 1);
    if (lx < 2 || ly < 2) {
      // Grout, with moss taking hold here and there.
      const g = 22 + n * 8;
      return vnoise(x * 0.09, y * 0.09, 17) > 0.6 && n > 0.35 ? [44, 62, 42] : [g, g * 0.86, g * 1.1];
    }
    const odd = ((x >> 6) + (y >> 6)) & 1;
    const m = vnoise(x * 0.07, y * 0.07, 2) - 0.5;
    const fine = vnoise(x * 0.31, y * 0.31, 3) - 0.5;
    let k = 1 + (n - 0.5) * 0.09 + m * 0.3 + fine * 0.14;
    if (lx < 4 || ly < 4) k -= 0.17; // shadowed edge
    else if (lx > 61 || ly > 61) k += 0.07; // worn, lighter edge
    // Hairline cracks and the odd pit.
    if (Math.abs(vnoise(x * 0.045, y * 0.045, 23) - 0.5) < 0.012 && vnoise(x * 0.02, y * 0.02, 29) > 0.52) k *= 0.55;
    if (n > 0.987) k *= 0.7;
    return odd ? [158 * k, 140 * k, 134 * k] : [128 * k, 134 * k, 128 * k];
  });
  return finish(c, { repeat });
}

/** Worn slabs of the approach leading to the torii. */
export function flagstones(repeat: [number, number]): THREE.Texture {
  const S = 128;
  const { c, ctx } = makeCanvas(S, S);
  paint(ctx, S, S, (x, y) => {
    const row = y >> 5;
    const sx = x + (row & 1) * 32;
    const n = hash2(x, y, 3);
    if ((sx & 63) < 2 || (y & 31) < 2) return n > 0.55 ? [48, 66, 44] : [28, 26, 31];
    const tone = hash2((sx >> 6) & 1, row, 4);
    let k = 0.84 + tone * 0.26 + (n - 0.5) * 0.1 + (vnoise(x * 0.1, y * 0.1, 5) - 0.5) * 0.26 + (vnoise(x * 0.33, y * 0.33, 6) - 0.5) * 0.1;
    if ((sx & 63) < 4 || (y & 31) < 4) k -= 0.14;
    return [150 * k, 146 * k, 152 * k];
  });
  return finish(c, { repeat });
}

/** Generic speckled stone for lanterns, steps and rocks. */
export function stone(repeat: [number, number] = [1, 1]): THREE.Texture {
  const S = 64;
  const { c, ctx } = makeCanvas(S, S);
  paint(ctx, S, S, (x, y) => {
    const n = hash2(x, y, 6);
    const m = vnoise(x * 0.11, y * 0.11, 7);
    if (m > 0.72 && n > 0.4) return [70, 92, 66];
    const k = 0.8 + n * 0.14 + m * 0.3 + (vnoise(x * 0.4, y * 0.4, 8) - 0.5) * 0.12;
    return n < 0.03 ? [56, 52, 58] : [146 * k, 140 * k, 148 * k];
  });
  return finish(c, { repeat });
}

function drawSeal(ctx: CanvasRenderingContext2D, size: number, color: string): void {
  const c = size / 2;
  const u = size / 128;
  const rand = mulberry32(99);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  const ring = (r: number, w: number) => {
    ctx.lineWidth = w * u;
    ctx.beginPath();
    ctx.arc(c, c, r, 0, Math.PI * 2);
    ctx.stroke();
  };
  ring(size * 0.435, 1.6);
  ring(size * 0.3, 1.2);
  ring(size * 0.115, 1);
  ctx.lineWidth = u;
  for (let k = 0; k < 32; k++) {
    const a = (k / 32) * Math.PI * 2;
    const r0 = size * 0.3;
    const r1 = size * (k % 4 === 0 ? 0.337 : 0.318);
    ctx.beginPath();
    ctx.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0);
    ctx.lineTo(c + Math.cos(a) * r1, c + Math.sin(a) * r1);
    ctx.stroke();
  }
  for (let k = 0; k < 8; k++) {
    ctx.save();
    ctx.translate(c, c);
    ctx.rotate((k / 8) * Math.PI * 2 + Math.PI / 8);
    ctx.translate(0, -size * 0.385);
    ctx.scale(u, u);
    glyph(ctx, rand);
    ctx.restore();
  }
  ctx.restore();
}

/** Top of the stone the blade stands in: a carved seal, cracks, moss and fallen petals. */
export function daisTop(): { map: THREE.Texture; glow: THREE.Texture } {
  const S = 256;
  const H = S / 2;
  const top = makeCanvas(S, S);
  const glow = makeCanvas(S, S);
  const rand = mulberry32(41);

  paint(top.ctx, S, S, (x, y) => {
    const n = hash2(x, y, 5) - 0.5;
    const m = vnoise(x * 0.035, y * 0.035, 6) - 0.5;
    const m2 = vnoise(x * 0.15, y * 0.15, 8) - 0.5;
    const r = Math.hypot(x - H + 0.5, y - H + 0.5) / H;
    // Darker towards the middle, where the blade has stood: a painted-in occlusion.
    const k = (1 + n * 0.1 + m * 0.36 + m2 * 0.14) * (0.62 + 0.38 * Math.min(1, r * 4.5));
    const moss = vnoise(x * 0.055, y * 0.055, 12) * 0.7 + r * 0.7 > 0.98;
    return moss ? [74 * k, 96 * k, 68 * k] : [160 * k, 152 * k, 162 * k];
  });
  drawSeal(top.ctx, S, 'rgba(36, 30, 44, 0.9)');

  top.ctx.strokeStyle = 'rgba(16, 12, 18, 0.95)';
  top.ctx.lineWidth = 1.5;
  for (let i = 0; i < 7; i++) {
    let ang = rand() * Math.PI * 2;
    let x = H;
    let y = H;
    const len = 20 + rand() * 76;
    top.ctx.beginPath();
    top.ctx.moveTo(x, y);
    for (let s = 0; s < len; s += 7) {
      ang += (rand() - 0.5) * 0.9;
      x += Math.cos(ang) * 7;
      y += Math.sin(ang) * 7;
      top.ctx.lineTo(x, y);
    }
    top.ctx.stroke();
  }
  // The slit the blade sits in (texture x runs along the blade's width).
  top.ctx.fillStyle = '#08060a';
  top.ctx.fillRect(H - 7, H - 2, 14, 4);

  for (let i = 0; i < 34; i++) {
    const a = rand() * Math.PI * 2;
    const r = 24 + rand() * 96;
    top.ctx.fillStyle = rand() > 0.5 ? '#eba6c0' : '#c97390';
    top.ctx.fillRect(Math.round(H + Math.cos(a) * r), Math.round(H + Math.sin(a) * r), rand() > 0.6 ? 3 : 2, 2);
  }

  glow.ctx.fillStyle = '#000';
  glow.ctx.fillRect(0, 0, S, S);
  drawSeal(glow.ctx, S, '#fff');

  return { map: finish(top.c, { clamp: true }), glow: finish(glow.c, { clamp: true }) };
}

// ── Architecture ───────────────────────────────────────────

/** Faded vermilion lacquer of the torii, streaked and chipped. */
export function vermilion(): THREE.Texture {
  const { c, ctx } = makeCanvas(64, 128);
  paint(ctx, 64, 128, (x, y) => {
    if (hash2(x >> 2, y >> 2, 9) > 0.95) return [74, 44, 40];
    const streak = vnoise(x * 0.45, y * 0.04, 3);
    let k = 0.76 + streak * 0.32 + hash2(x, y, 10) * 0.06;
    const grime = Math.max(0, (y - 96) / 32);
    k *= 1 - grime * 0.55;
    return [176 * k, 48 * k + grime * 16, 36 * k + grime * 6];
  });
  return finish(c);
}

export function wood(): THREE.Texture {
  const { c, ctx } = makeCanvas(64, 64);
  paint(ctx, 64, 64, (x, y) => {
    const plank = x % 16 === 0 ? 0.6 : 1;
    const k = (0.74 + vnoise(x * 0.7, y * 0.05, 13) * 0.44 + hash2(x, y, 14) * 0.06) * plank;
    return [74 * k, 52 * k, 46 * k];
  });
  return finish(c);
}

export function roofTiles(repeat: [number, number]): THREE.Texture {
  const { c, ctx } = makeCanvas(64, 64);
  paint(ctx, 64, 64, (x, y) => {
    const row = y >> 4;
    const lx = (x + (row & 1) * 8) & 15;
    const ly = y & 15;
    const k = (ly < 2 ? 0.45 : ly < 4 ? 1.25 : 1) * (lx < 2 ? 0.6 : 1) * (0.92 + hash2(x, y, 15) * 0.16);
    return [62 * k, 64 * k, 88 * k];
  });
  return finish(c, { repeat });
}

/** A paper screen with a lamp somewhere behind it. */
export function lattice(): THREE.Texture {
  const { c, ctx } = makeCanvas(64, 64);
  paint(ctx, 64, 64, (x, y) => {
    if (x % 16 < 2 || y % 16 < 2) return [26, 12, 10];
    const k = Math.max(0.25, 1 - Math.hypot(x - 32, y - 40) / 44) * (0.92 + hash2(x, y, 16) * 0.16);
    return [255 * k, 170 * k, 92 * k];
  });
  return finish(c, { clamp: true });
}

/** Name tablet hung on the torii. */
export function plaque(): THREE.Texture {
  const { c, ctx } = makeCanvas(32, 48);
  ctx.scale(2, 2);
  ctx.fillStyle = '#b08a3e';
  ctx.fillRect(0, 0, 16, 24);
  ctx.fillStyle = '#181014';
  ctx.fillRect(1.5, 1.5, 13, 21);
  ctx.fillStyle = '#c9a14e';
  const rand = mulberry32(5);
  for (const y of [8, 16]) {
    ctx.save();
    ctx.translate(8, y);
    ctx.scale(0.8, 0.7);
    glyph(ctx, rand, 5);
    ctx.restore();
  }
  return finish(c, { clamp: true });
}

// ── The katana ─────────────────────────────────────────────

/** One diamond of the silk handle wrap over ray skin. Tiles twice around and along the grip. */
export function tsukaWrap(repeat: [number, number]): THREE.Texture {
  const S = 32;
  const { c, ctx } = makeCanvas(S, S);
  paint(ctx, S, S, (x, y) => {
    const a = (x + 0.5) / S;
    const b = (y + 0.5) / S;
    const d = Math.abs(a - 0.5) / 0.23 + Math.abs(b - 0.5) / 0.44;
    if (d < 1) {
      // Ray skin showing through the opening, shadowed where the cord overhangs.
      const v = 206 + hash2(x, y, 7) * 30 - ((x + y) % 2 === 0 ? 30 : 0) - (d > 0.74 ? 70 : 0);
      return [v, v * 0.95, v * 0.84];
    }
    // The two crossing straps catch the light differently, with a woven rib along each.
    const over = (b > 0.5 ? 1 : 0) ^ (a < 0.5 ? 1 : 0);
    const rib = (x + (over ? y : S - y)) % 4 === 0 ? 0.82 : 1;
    const k = (over ? 1 : 0.72) * (d < 1.3 ? 0.6 : 1) * rib * (0.92 + hash2(x, y, 3) * 0.16);
    return [136 * k, 26 * k, 46 * k];
  });
  return finish(c, { repeat });
}

/**
 * Blade surface. u runs from the collar (0) to the tip (1), v from the back (0) to the edge (1).
 * Returns the colour map and a roughness (G) / metalness (B) map.
 */
export function blade(groundU: number): { map: THREE.Texture; orm: THREE.Texture } {
  const W = 512;
  const H = 64;
  const col = makeCanvas(W, H);
  const orm = makeCanvas(W, H);
  const rough = new Float32Array(W * H);
  const metal = new Float32Array(W * H);

  paint(col.ctx, W, H, (x, y) => {
    const u = x / W;
    const v = 1 - (y + 0.5) / H;
    const n = hash2(x, y, 11);
    const i = y * W + x;
    // The temper line wanders in irregular waves, as a clay-hardened edge does.
    const hamon = 0.71 + 0.05 * Math.sin(u * 70) + 0.035 * Math.sin(u * 163 + 1.3) + 0.02 * Math.sin(u * 31 + 0.5);
    let c: RGBA;
    let r: number;
    let m = 1;
    if (v > hamon) {
      const e = (v - hamon) / (1 - hamon);
      const g = 206 + 40 * e + n * 8;
      c = v - hamon < 0.03 ? [250, 250, 255] : [g, g, g + 4];
      r = 0.42 - 0.14 * e;
      m = 0.55;
    } else if (v > 0.45) {
      // Folded-steel grain in the flat of the blade.
      const g = 150 + n * 12 + 16 * vnoise(x * 0.075, y * 0.45, 5);
      c = [g * 0.92, g * 0.98, g * 1.1];
      r = 0.2;
    } else if (v > 0.17 && v < 0.34 && u > 0.012 && u < 0.6) {
      // The groove cut along the back half, bright along its lips.
      const lip = v < 0.195 || v > 0.315 || u > 0.594;
      const g = (lip ? 176 : 92) + n * 8;
      c = [g * 0.94, g * 0.97, g * 1.1];
      r = lip ? 0.14 : 0.3;
    } else {
      const g = (v > 0.12 ? 122 : 134) + n * 8;
      c = [g * 0.95, g * 0.97, g * 1.08];
      r = v > 0.12 ? 0.1 : 0.16;
    }
    if (hash2(0, y, 21) > 0.8 && vnoise(x * 0.025, y, 4) > 0.62) c = [c[0] + 14, c[1] + 14, c[2] + 16];

    // Centuries in the ground: rust creeping up from where the steel meets the stone.
    const near = Math.exp(-Math.pow((u - groundU) / 0.075, 2));
    if (vnoise(x * 0.11, y * 0.25, 9) < near * 0.72 + (u > groundU ? 0.5 : 0.05)) {
      const k = 0.8 + n * 0.4;
      c = [96 * k, 54 * k, 36 * k];
      r = 0.9;
      m = 0.25;
    }
    rough[i] = r;
    metal[i] = m;
    return c;
  });
  paint(orm.ctx, W, H, (x, y) => [0, rough[y * W + x] * 255, metal[y * W + x] * 255]);

  return { map: finish(col.c, { clamp: true }), orm: finish(orm.c, { clamp: true, data: true }) };
}

/** Iron guard with a gold rim and a chrysanthemum of inlaid lines. */
export function tsubaFace(): THREE.Texture {
  const S = 128;
  const { c, ctx } = makeCanvas(S, S);
  paint(ctx, S, S, (x, y) => {
    const cx = ((x + 0.5) / S) * 2 - 1;
    const cy = ((y + 0.5) / S) * 2 - 1;
    const r = Math.hypot(cx, cy);
    const n = hash2(x, y, 18);
    const gold: RGBA = [186 + n * 30, 146 + n * 24, 64 + n * 14];
    if (r > 0.9 || (r > 0.4 && r < 0.44)) return gold;
    if (r > 0.47 && r < 0.86) {
      const f = (((Math.atan2(cy, cx) / (Math.PI * 2)) * 16) % 1 + 1) % 1;
      if (f < 0.07 || f > 0.93) return [gold[0] * 0.82, gold[1] * 0.82, gold[2] * 0.82];
      // A small gold dot between each pair of petals.
      if (Math.abs(f - 0.5) < 0.09 && Math.abs(r - 0.78) < 0.025) return gold;
    }
    const g = 30 + n * 12 + vnoise(x * 0.15, y * 0.15, 19) * 14;
    return [g, g * 0.93, g];
  });
  return finish(c, { clamp: true });
}

/** Black scabbard lacquer: crimson band at the mouth, gold lines, scattered sakura. */
export function lacquer(): THREE.Texture {
  const W = 64;
  const H = 512;
  const { c, ctx } = makeCanvas(W, H);
  const rand = mulberry32(17);
  const flowers = Array.from({ length: 10 }, (_, i) => ({
    x: 10 + rand() * 44,
    y: 20 + i * 38 + rand() * 16,
    r: 6 + rand() * 3.2,
    rot: rand() * Math.PI * 2,
  }));
  paint(ctx, W, H, (x, y) => {
    const t = 1 - (y + 0.5) / H; // 0 at the mouth
    const n = hash2(x, y, 31);
    if (Math.abs(t - 0.2) < 0.004 || Math.abs(t - 0.03) < 0.004) return [196, 156, 74];
    if (t < 0.2) {
      const k = 0.88 + n * 0.24;
      return [132 * k, 26 * k, 44 * k];
    }
    for (const f of flowers) {
      const dx = x - f.x;
      const dy = y - f.y;
      const d = Math.hypot(dx, dy);
      if (d > f.r + 1) continue;
      if (d < 1.6) return [220, 176, 84];
      if (d < f.r * (0.5 + 0.5 * Math.abs(Math.cos((Math.atan2(dy, dx) + f.rot) * 2.5)))) return [186, 90, 120];
    }
    if (n > 0.985) return [96, 58, 92];
    const k = 16 + n * 6;
    return [k, k * 0.6, k * 1.05];
  });
  return finish(c);
}

/** Paper talisman tied to the grip. */
export function ofuda(): THREE.Texture {
  const { c, ctx } = makeCanvas(32, 96);
  paint(ctx, 32, 96, (x, y) => {
    const k = 0.92 + hash2(x, y, 23) * 0.08;
    const border = ((x === 4 || x === 27) && y >= 4 && y <= 91) || ((y === 4 || y === 91) && x >= 4 && x <= 27);
    return border ? [176, 38, 52] : [232 * k, 220 * k, 198 * k];
  });
  const rand = mulberry32(8);
  ctx.fillStyle = '#17121a';
  for (const y of [20, 42, 64]) {
    ctx.save();
    ctx.translate(16, y);
    ctx.scale(1.6, 1.8);
    glyph(ctx, rand, 5);
    ctx.restore();
  }
  ctx.fillStyle = '#b52238';
  ctx.fillRect(12, 78, 8, 8);
  return finish(c, { clamp: true });
}

// ── Atmosphere ─────────────────────────────────────────────

/** A soft-edged bank of mist. */
export function mist(seed: number): THREE.Texture {
  const W = 128;
  const H = 48;
  const { c, ctx } = makeCanvas(W, H);
  const rand = mulberry32(seed);
  ctx.save();
  ctx.scale(2.4, 1);
  for (let i = 0; i < 16; i++) {
    const x = (8 + rand() * (W - 16)) / 2.4;
    const y = 14 + rand() * (H - 28);
    const r = 7 + rand() * 9;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,0.32)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  ctx.restore();
  // Fade to nothing at the borders so the quad itself never shows.
  ctx.globalCompositeOperation = 'destination-in';
  const edge = ctx.createLinearGradient(0, 0, W, 0);
  edge.addColorStop(0, 'rgba(0,0,0,0)');
  edge.addColorStop(0.22, 'rgba(0,0,0,1)');
  edge.addColorStop(0.78, 'rgba(0,0,0,1)');
  edge.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, W, H);
  const rim = ctx.createLinearGradient(0, 0, 0, H);
  rim.addColorStop(0, 'rgba(0,0,0,0)');
  rim.addColorStop(0.3, 'rgba(0,0,0,1)');
  rim.addColorStop(0.7, 'rgba(0,0,0,1)');
  rim.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = rim;
  ctx.fillRect(0, 0, W, H);
  return finish(c, { smooth: true, clamp: true });
}

/** Round falloff for halos and soft contact shadows. */
export function glow(): THREE.Texture {
  const { c, ctx } = makeCanvas(64, 64);
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.45)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.1)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return finish(c, { smooth: true, clamp: true });
}

/** Dark ring for grounding round objects: densest at the object's foot, gone by the border. */
export function contact(inner: number): THREE.Texture {
  const { c, ctx } = makeCanvas(64, 64);
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(0,0,0,1)');
  g.addColorStop(inner, 'rgba(0,0,0,1)');
  g.addColorStop(inner + (1 - inner) * 0.35, 'rgba(0,0,0,0.4)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return finish(c, { smooth: true, clamp: true });
}
