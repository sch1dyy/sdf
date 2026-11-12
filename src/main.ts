import './style.css';
import * as THREE from 'three';
import { Music } from './audio/music';
import { Controls, DIST_MAX, DIST_MIN } from './controls';
import { RetroPipeline } from './retro/pipeline';
import { createAtmosphere } from './scene/atmosphere';
import { createEnvMap } from './scene/envmap';
import { createEnvironment } from './scene/environment';
import { createKatana } from './scene/katana';
import { initUI } from './ui';
import { clamp, damp, easeInOutCubic, lerp, smoothstep } from './util/math';

const INTRO_SECONDS = 7.5;
const MAX_PIXEL_RATIO = 2;

function boot(): void {
  const canvas = document.getElementById('scene') as HTMLCanvasElement;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 16 / 9, 0.2, 1500);
  const pipeline = new RetroPipeline(renderer);

  const katana = createKatana(createEnvMap(renderer));
  scene.add(katana.group);
  const environment = createEnvironment(scene);
  const atmosphere = createAtmosphere(scene);

  const controls = new Controls(canvas);
  const music = new Music();
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 1;

  let phase: 'title' | 'intro' | 'live' = 'title';
  let time = 0;
  let intro = 0;
  let enteredAt = 0;
  let pulse = 0;
  let loudness = 0;

  const ui = initUI({
    onEnter(withSound) {
      phase = 'intro';
      enteredAt = time;
      if (withSound) ui.setMusic(music.setEnabled(true));
      canvas.focus({ preventScroll: true });
    },
    onToggleMusic: () => music.toggle(),
    onVolume: (volume) => music.setVolume(volume),
  });

  controls.onFirstDrag = () => ui.dismissHint();
  controls.onTap = () => {
    katana.strike();
    music.chime();
    pulse = 1;
  };

  function resize(): void {
    const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    const width = Math.max(1, Math.round(window.innerWidth * ratio));
    const height = Math.max(1, Math.round(window.innerHeight * ratio));
    renderer.setSize(width, height, false);
    pipeline.setSize(width, height);

    const { x, y } = pipeline.internal;
    camera.aspect = x / y;
    // Widen the lens on tall screens so the stone the sword stands in stays in frame.
    const tan = clamp(0.21 / camera.aspect, Math.tan(THREE.MathUtils.degToRad(17)), Math.tan(THREE.MathUtils.degToRad(25)));
    camera.fov = THREE.MathUtils.radToDeg(Math.atan(tan) * 2);
    camera.updateProjectionMatrix();
    atmosphere.setPixelScale(y / (2 * tan));
  }
  window.addEventListener('resize', resize);
  resize();

  // The sword and the shrine never move: only the camera circles them.
  function placeCamera(): void {
    // The opening shot drifts in from far down the approach, arcing onto the sword's axis.
    const e = easeInOutCubic(intro);
    const closeness = 1 - (controls.dist - DIST_MIN) / (DIST_MAX - DIST_MIN);
    const dist = lerp(11.5, controls.dist, e);
    const elev = lerp(0.02, controls.elev, e);
    const breathe = Math.sin(time * 0.09) * 0.025 * motion;
    // Dragging right swings the camera left, as if turning the scene by hand.
    const azimuth = lerp(0.42, 0, e) - controls.yaw + breathe + controls.pointerX * 0.03 * e * motion;
    // Moving closer lifts the gaze from the whole sword to the guard and grip.
    const lookY = lerp(1.6, lerp(1.08, 1.62, smoothstep(0.45, 1, closeness)), e);

    camera.position.set(
      Math.sin(azimuth) * Math.cos(elev) * dist,
      Math.max(0.3, lookY + Math.sin(elev) * dist - controls.pointerY * 0.05 * e * motion),
      Math.cos(azimuth) * Math.cos(elev) * dist,
    );
    camera.lookAt(0, lookY, 0);
  }

  /** How brightly the light over the sword burns: dim on the title screen, then it rises. */
  function ignition(): number {
    if (phase === 'title') return 0.2;
    const rise = lerp(0.2, 1, smoothstep(0.3, 3.6, time - enteredAt));
    const breath = 1 + 0.04 * Math.sin(time * 0.7);
    return rise * breath + pulse * 0.3 + loudness * 0.12;
  }

  let previous = performance.now();
  function frame(): void {
    requestAnimationFrame(frame);
    const now = performance.now();
    const dt = Math.min((now - previous) / 1000, 0.1);
    previous = now;
    time += dt;

    if (phase === 'intro') {
      intro = Math.min(1, intro + dt / INTRO_SECONDS);
      // Hand over control a little before the camera stops, so an eager drag is not ignored.
      if (intro > 0.62) controls.enabled = true;
      if (intro > 0.8) ui.showHud();
      if (intro >= 1) phase = 'live';
    }

    pulse *= Math.exp(-dt * 2.2);
    loudness += (music.level() - loudness) * damp(2, dt);

    controls.update(dt);
    const ignite = ignition();
    katana.update(time, dt);
    environment.update(time, ignite);
    atmosphere.update(time, ignite);
    placeCamera();

    pipeline.fade = Math.min(1, pipeline.fade + dt / 1.8);
    pipeline.render(scene, camera, time);
  }
  frame();

  // Handle for jumping past the opening shot while working on or testing the scene.
  const skip = () => {
    phase = 'intro';
    intro = 0.999;
    enteredAt = time - 10;
    document.getElementById('title')!.classList.add('is-leaving');
    document.body.classList.add('is-entered');
  };
  Object.assign(window, { __blade: { controls, music, katana, pipeline, camera, scene, renderer, skip, state: () => ({ phase, intro, time }) } });
}

try {
  boot();
} catch (error) {
  console.error(error);
  document.body.classList.add('no-webgl');
}
