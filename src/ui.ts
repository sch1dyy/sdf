interface Handlers {
  onEnter(withSound: boolean): void;
  onToggleMusic(): boolean;
  /** volume is 0..1 */
  onVolume(volume: number): void;
  onInspect(): void;
  onExitInspect(): void;
}

export interface UI {
  setMusic(on: boolean): void;
  /** Reveals the title, hint and details once the camera has settled. */
  showHud(): void;
  dismissHint(): void;
  setInspecting(on: boolean): void;
  /** Moves the "click to inspect" label to a point on screen, in CSS pixels. */
  placeLabel(x: number, y: number, visible: boolean, hot: boolean): void;
}

const VOLUME_KEY = 'forgotten-blade:volume';
const DEFAULT_VOLUME = 70;

/** The chosen volume survives reloads and moving around the site. */
function storedVolume(): number {
  try {
    const raw = localStorage.getItem(VOLUME_KEY);
    const value = raw === null ? NaN : Number(raw);
    return Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : DEFAULT_VOLUME;
  } catch {
    return DEFAULT_VOLUME; // storage can be unavailable, for instance in private modes
  }
}

export function initUI(handlers: Handlers): UI {
  const title = document.getElementById('title')!;
  const hint = document.getElementById('hint')!;
  const music = document.getElementById('music') as HTMLButtonElement;
  const musicState = document.getElementById('music-state')!;
  const slider = document.getElementById('volume') as HTMLInputElement;
  const volumeValue = document.getElementById('volume-value')!;
  const choices = [...title.querySelectorAll<HTMLButtonElement>('.menu__item')];

  const setMusic = (on: boolean) => {
    music.setAttribute('aria-pressed', String(on));
    musicState.textContent = on ? 'ON' : 'OFF';
  };

  const setVolume = (percent: number, save = true) => {
    const value = Math.min(100, Math.max(0, Math.round(percent)));
    slider.value = String(value);
    slider.style.setProperty('--level', `${value}%`);
    volumeValue.textContent = String(value);
    handlers.onVolume(value / 100);
    if (!save) return;
    try {
      localStorage.setItem(VOLUME_KEY, String(value));
    } catch {
      /* not persisted this time */
    }
  };
  setVolume(storedVolume(), false);

  slider.addEventListener('input', () => setVolume(Number(slider.value)));
  document.getElementById('volume-down')!.addEventListener('click', () => setVolume(Number(slider.value) - 10));
  document.getElementById('volume-up')!.addEventListener('click', () => setVolume(Number(slider.value) + 10));

  for (const choice of choices) {
    choice.addEventListener('click', () => {
      choices.forEach((c) => (c.disabled = true));
      title.classList.add('is-leaving');
      document.body.classList.add('is-entered');
      handlers.onEnter(choice.dataset.sound === 'on');
    });
  }
  // Like a console title screen, the first option starts out selected.
  choices[0]?.focus({ preventScroll: true });

  const tag = document.getElementById('inspect-tag') as HTMLButtonElement;
  tag.addEventListener('click', () => handlers.onInspect());
  document.getElementById('inspect-back')!.addEventListener('click', () => handlers.onExitInspect());

  music.addEventListener('click', () => setMusic(handlers.onToggleMusic()));
  window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'm' && document.body.classList.contains('is-entered')) setMusic(handlers.onToggleMusic());
  });

  return {
    setMusic,
    showHud: () => document.body.classList.add('is-live'),
    dismissHint: () => hint.classList.add('is-done'),
    setInspecting: (on) => document.body.classList.toggle('is-inspecting', on),
    placeLabel(x, y, visible, hot) {
      tag.classList.toggle('is-shown', visible);
      tag.classList.toggle('is-hot', hot);
      if (visible) tag.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -100%)`;
    },
  };
}
