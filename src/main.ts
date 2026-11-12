import './style.css';
import * as THREE from 'three';
import { Music } from './audio/music';
import { Cinematic } from './cinematic';
import { Controls, INSPECT_LIMITS, SCENE_LIMITS, SCENE_START, type Orbit } from './controls';
import { RetroPipeline } from './retro/pipeline';
import { createAtmosphere } from './scene/atmosphere';
import { createCharacter } from './scene/character';
import { createEnvMap } from './scene/envmap';
import { createEnvironment } from './scene/environment';
import { createKatana } from './scene/katana';
import { initUI } from './ui';
import { clamp, damp, easeInOutCubic, lerp, smoothstep } from './util/math';

const INTRO_SECONDS = 7.5;
const INSPECT_SECONDS = 1.4;
const MAX_PIXEL_RATIO = 2;
const INSPECT_START: Orbit = { yaw: 0.25, elev: 0.06, dist: 3.9 };

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
  const character = createCharacter(scene);
  const atmosphere = createAtmosphere(scene);

  const controls = new Controls(canvas);
  // On a tall, narrow screen start a little to one side, so the figure behind the sword is in view.
  const startOrbit: Orbit = window.innerWidth < window.innerHeight * 0.8 ? { ...SCENE_START, yaw: 0.36 } : { ...SCENE_START };
  controls.load(startOrbit, SCENE_LIMITS);
  const music = new Music();
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const motion = calm ? 0 : 1;

  let phase: 'title' | 'intro' | 'live' = 'title';
  let time = 0;
  let intro = 0;
  let enteredAt = 0;
  let loudness = 0;

  // Two camera rigs: one circling the sword, one circling the character. The controls
  // drive whichever is active; the other stays where it was left.
  let inspecting = false;
  let blend = 0; // 0 = scene view, 1 = inspecting
  let sceneOrbit: Orbit = { ...startOrbit };
  let inspectOrbit: Orbit = { ...INSPECT_START };
  let sharp = false;
  let baseFov = 34;

  // Clicking the sword hands the camera to a third party for ten seconds.
  const cinematic = new Cinematic(scene, camera, katana, pipeline, music, calm);
  cinematic.onReset = () => controls.load(startOrbit, SCENE_LIMITS);
  cinematic.onEnd = () => {
    controls.enabled = true;
    document.body.classList.remove('is-cinematic');
  };

  function drawSword(): void {
    if (phase !== 'live' || inspecting || blend > 0 || !cinematic.start()) return;
    controls.enabled = false;
    document.body.classList.add('is-cinematic');
  }

  function enterInspect(): void {
    if (inspecting || !controls.enabled) return;
    sceneOrbit = controls.save();
    controls.load(INSPECT_START, INSPECT_LIMITS);
    inspecting = true;
    ui.setInspecting(true);
  }

  function exitInspect(): void {
    if (!inspecting) return;
    inspectOrbit = controls.save();
    controls.load(sceneOrbit, SCENE_LIMITS);
    inspecting = false;
    ui.setInspecting(false);
    canvas.focus({ preventScroll: true });
  }

  const ui = initUI({
    onEnter(withSound) {
      phase = 'intro';
      enteredAt = time;
      if (withSound) ui.setMusic(music.setEnabled(true));
      canvas.focus({ preventScroll: true });
    },
    onToggleMusic: () => music.toggle(),
    onVolume: (volume) => music.setVolume(volume),
    onInspect: enterInspect,
    onExitInspect: exitInspect,
  });

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  /** What lies under a point on screen: whichever of the two is nearer along the ray. */
  function pick(x: number, y: number): 'character' | 'sword' | null {
    ndc.set((x / window.innerWidth) * 2 - 1, 1 - (y / window.innerHeight) * 2);
    raycaster.setFromCamera(ndc, camera);
    const figure = raycaster.intersectObject(character.hitTarget, false)[0];
    const sword = raycaster.intersectObject(katana.hitTarget, false)[0];
    if (figure && (!sword || figure.distance < sword.distance)) return 'character';
    return sword ? 'sword' : null;
  }

  controls.onFirstDrag = () => ui.dismissHint();
  controls.onTap = (x, y) => {
    if (inspecting) return;
    const target = pick(x, y);
    if (target === 'character') enterInspect();
    else if (target === 'sword') drawSword();
  };
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') exitInspect();
  });

  function resize(): void {
    const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    const width = Math.max(1, Math.round(window.innerWidth * ratio));
    const height = Math.max(1, Math.round(window.innerHeight * ratio));
    renderer.setSize(width, height, false);
    pipeline.setSize(width, height, sharp);

    const { x, y } = pipeline.internal;
    camera.aspect = x / y;
    // Widen the lens on tall screens so the stone the sword stands in stays in frame.
    const tan = clamp(0.21 / camera.aspect, Math.tan(THREE.MathUtils.degToRad(17)), Math.tan(THREE.MathUtils.degToRad(25)));
    baseFov = THREE.MathUtils.radToDeg(Math.atan(tan) * 2);
    atmosphere.setPixelScale(y / (2 * tan));
    cinematic.setPixelScale(y / (2 * tan));
  }
  window.addEventListener('resize', resize);
  resize();

  const scenePos = new THREE.Vector3();
  const sceneLook = new THREE.Vector3();
  const inspectPos = new THREE.Vector3();
  const inspectLook = new THREE.Vector3();
  const cinePos = new THREE.Vector3();
  const look = new THREE.Vector3();
  const anchor = new THREE.Vector3();

  // Nothing in the shrine moves for the camera's sake: only the camera does.
  function placeCamera(b: number): void {
    // Scene rig. The opening shot drifts in from down the approach onto the sword's axis.
    const s = inspecting ? sceneOrbit : controls;
    const e = easeInOutCubic(intro);
    const near = 1 - (s.dist - SCENE_LIMITS.distMin) / (SCENE_LIMITS.distMax - SCENE_LIMITS.distMin);
    const dist = lerp(11.5, s.dist, e);
    const elev = lerp(0.02, s.elev, e);
    const parallax = e * motion * (1 - b);
    // Dragging right swings the camera left, as if turning the scene by hand.
    const azimuth = lerp(0.42, 0, e) - s.yaw + Math.sin(time * 0.09) * 0.025 * motion + controls.pointerX * 0.03 * parallax;
    // Moving closer lifts the gaze from the whole sword to the guard and grip.
    const lookY = lerp(1.6, lerp(1.08, 1.62, smoothstep(0.45, 1, near)), e);
    sceneLook.set(0, lookY, 0);
    scenePos.set(
      Math.sin(azimuth) * Math.cos(elev) * dist,
      Math.max(0.3, lookY + Math.sin(elev) * dist - controls.pointerY * 0.05 * parallax),
      Math.cos(azimuth) * Math.cos(elev) * dist,
    );

    // Inspection rig, circling the character.
    const i = inspecting ? controls : inspectOrbit;
    const closeness = 1 - (i.dist - INSPECT_LIMITS.distMin) / (INSPECT_LIMITS.distMax - INSPECT_LIMITS.distMin);
    character.focus(smoothstep(0.25, 0.95, closeness), inspectLook);
    const around = character.facing - i.yaw;
    inspectPos.set(
      inspectLook.x + Math.sin(around) * Math.cos(i.elev) * i.dist,
      Math.max(0.4, inspectLook.y + Math.sin(i.elev) * i.dist),
      inspectLook.z + Math.cos(around) * Math.cos(i.elev) * i.dist,
    );

    camera.position.lerpVectors(scenePos, inspectPos, b);
    look.lerpVectors(sceneLook, inspectLook, b);
    // A slightly wider lens while inspecting fits his whole figure in at arm's length.
    let fov = baseFov * lerp(1, 1.18, b);

    const w = cinematic.camWeight;
    if (w > 0) {
      if (cinematic.returning) {
        // Home is wherever the scene's own rig now sits; come back to it from a little further off.
        cinePos.copy(scenePos).sub(sceneLook).multiplyScalar(1.3).add(sceneLook);
        cinePos.y += 0.35;
        look.copy(sceneLook);
      } else {
        cinePos.copy(cinematic.camPos);
        look.lerp(cinematic.camLook, w);
      }
      camera.position.lerp(cinePos, w);
      fov *= cinematic.fovScale;
    }

    camera.lookAt(look);
    if (cinematic.roll !== 0) camera.rotateZ(cinematic.roll);
    camera.fov = fov;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  }

  /** Pins the "click to inspect" label above the character, and shows what can be clicked. */
  function placeLabel(): void {
    const idle = phase === 'live' && !inspecting && blend < 0.05 && !cinematic.active;
    anchor.copy(character.labelAnchor).project(camera);
    const visible = idle && anchor.z < 1 && Math.abs(anchor.x) < 0.96 && anchor.y < 0.9 && anchor.y > -0.9;
    const over = idle && !controls.isDragging && controls.hover ? pick(controls.hover.x, controls.hover.y) : null;
    ui.placeLabel(((anchor.x + 1) / 2) * window.innerWidth, ((1 - anchor.y) / 2) * window.innerHeight, visible, over === 'character');
    canvas.classList.toggle('is-clickable', over !== null);
  }

  /** How brightly the light over the sword burns: dim on the title screen, then it rises. */
  function ignition(): number {
    if (phase === 'title') return 0.2;
    const rise = lerp(0.2, 1, smoothstep(0.3, 3.6, time - enteredAt));
    const breath = 1 + 0.04 * Math.sin(time * 0.7);
    return rise * breath + cinematic.pulse * 0.4 + loudness * 0.12;
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

    blend = clamp(blend + ((inspecting ? 1 : -1) * dt) / INSPECT_SECONDS, 0, 1);
    // The picture is rendered finer while he is being looked at closely.
    const wantSharp = inspecting || blend > 0.02;
    if (wantSharp !== sharp) {
      sharp = wantSharp;
      resize();
    }

    loudness += (music.level() - loudness) * damp(2, dt);

    controls.update(dt);
    cinematic.advance(dt);
    const ignite = ignition();
    katana.update(time, dt);
    environment.update(time, ignite);
    atmosphere.update(time, ignite, cinematic.dim);
    placeCamera(easeInOutCubic(blend));
    cinematic.apply();
    placeLabel();

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
  Object.assign(window, {
    __blade: {
      controls,
      music,
      katana,
      character,
      cinematic,
      pipeline,
      camera,
      scene,
      renderer,
      skip,
      state: () => ({ phase, intro, time, inspecting, blend }),
    },
  });
}

try {
  boot();
} catch (error) {
  console.error(error);
  document.body.classList.add('no-webgl');
}
