interface Handlers {
  onEnter(withSound: boolean): void;
  onToggleMusic(): boolean;
}

export interface UI {
  setMusic(on: boolean): void;
  /** Reveals the title, hint and details once the camera has settled. */
  showHud(): void;
  dismissHint(): void;
}

export function initUI(handlers: Handlers): UI {
  const title = document.getElementById('title')!;
  const hint = document.getElementById('hint')!;
  const music = document.getElementById('music') as HTMLButtonElement;
  const musicState = document.getElementById('music-state')!;
  const choices = [...title.querySelectorAll<HTMLButtonElement>('.menu__item')];

  const setMusic = (on: boolean) => {
    music.setAttribute('aria-pressed', String(on));
    musicState.textContent = on ? 'ON' : 'OFF';
  };

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

  music.addEventListener('click', () => setMusic(handlers.onToggleMusic()));
  window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'm' && document.body.classList.contains('is-entered')) setMusic(handlers.onToggleMusic());
  });

  return {
    setMusic,
    showHud: () => document.body.classList.add('is-live'),
    dismissHint: () => hint.classList.add('is-done'),
  };
}
