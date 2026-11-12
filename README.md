# 忘れられた刃 — The Forgotten Blade

An interactive piece of digital art: a lone katana left standing in the stone of an abandoned
shrine, rendered like a late-90s console game. Drag to turn the sword, and let it play.

Built with [Three.js](https://threejs.org/), TypeScript and Vite. Everything on screen and
everything you hear is generated in the browser — there are no model, texture or audio files.

## Run it

```bash
npm install
npm run dev      # development server
npm run build    # type-check and build to dist/
npm run preview  # serve the production build
```

## Controls

| Input | Action |
| --- | --- |
| Drag / swipe | Turn the katana (it keeps spinning with a little inertia) |
| Drag up / down | Raise or lower the camera |
| Wheel / pinch | Move closer to the guard and grip, or back out |
| Tap / click | Strike the blade: it rings and the seal flares |
| Arrow keys, `+` `-` | Keyboard equivalents |
| `M` or the 音楽 button | Music on / off |

Music never starts by itself: the title screen asks whether to enter with sound or in silence.

## How it is put together

| Path | What it does |
| --- | --- |
| `src/main.ts` | Boots the scene, runs the frame loop, the opening camera move and the lighting "ignition" |
| `src/scene/katana.ts` | The sword, built procedurally: ridged blade with temper line, collar, pierced guard, wrapped grip, talisman, bell, scabbard and the carved stone it stands in |
| `src/scene/environment.ts` | Sky, moon, mountains, torii, lanterns, shrine, pagoda, sakura and the lights |
| `src/scene/atmosphere.ts` | Dust, embers and petals, the shaft of light and drifting mist |
| `src/scene/textures.ts` | Every texture, painted onto small canvases at start-up |
| `src/scene/envmap.ts` | The dark "studio" the steel reflects |
| `src/retro/pipeline.ts` | Low-resolution render target, bloom, 15-bit colour with the PlayStation dither table, grain and vignette |
| `src/retro/psx.ts` | Vertex snapping, for the characteristic PS1 wobble |
| `src/audio/music.ts` | Generative score: Karplus-Strong koto, synthesised shakuhachi, drone, wind and bells |
| `src/controls.ts` | Mouse, touch and keyboard input |

### Fonts

The two typefaces (Shippori Mincho and DotGothic16) are shipped as tiny subsets containing only
the glyphs used on the page. After changing any on-screen text, regenerate them:

```bash
npm run fonts
```
