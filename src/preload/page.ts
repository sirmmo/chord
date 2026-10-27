// Preload for every page view. It runs in an isolated world before the page's
// own scripts, so it cannot see the page's Media Session handlers directly.
// Instead it installs a small hook in the page's main world that mirrors
// navigator.mediaSession (metadata, playback state, registered actions) to
// Chord and executes the actions Chord sends back. Only the top frame reports.

import { contextBridge, ipcRenderer, webFrame } from 'electron';

const MEDIA_KEY = '__chordMedia';
const ACTION_KEY = '__chordMediaAction';

/** Runs inside the page's main world. Must stay self-contained: no imports, no closures. */
function mediaHook(mediaKey: string, actionKey: string): void {
  const nav = navigator as Navigator & { mediaSession?: MediaSession };
  const ms = nav.mediaSession;
  const w = window as Window & { __chordHooked?: boolean };
  if (!ms || w.__chordHooked) return;
  Object.defineProperty(w, '__chordHooked', { value: true });

  const handlers = new Map<string, (details: { action: string }) => void>();
  const proto = Object.getPrototypeOf(ms) as MediaSession;
  const origSet = proto.setActionHandler;
  proto.setActionHandler = function (this: MediaSession, name: MediaSessionAction, fn: MediaSessionActionHandler | null) {
    if (fn) handlers.set(name, fn as (details: { action: string }) => void);
    else handlers.delete(name);
    const r = origSet.call(this, name, fn);
    schedule();
    return r;
  };
  for (const prop of ['metadata', 'playbackState'] as const) {
    const d = Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.set || !d.get) continue;
    const { get, set } = d;
    Object.defineProperty(proto, prop, {
      configurable: true,
      enumerable: d.enumerable,
      get,
      set(this: MediaSession, v: unknown) {
        set.call(this, v);
        schedule();
      },
    });
  }

  const mediaEls = () => Array.from(document.querySelectorAll<HTMLMediaElement>('audio, video'));
  const elementPlaying = () => mediaEls().some((el) => !el.paused && !el.ended && el.readyState > 2);

  function pickArtwork(list: ReadonlyArray<MediaImage> | undefined): string {
    if (!list || list.length === 0) return '';
    let best = list[0];
    let bestScore = Infinity;
    for (const img of list) {
      const m = /(\d+)x(\d+)/.exec(img.sizes ?? '');
      const size = m ? Number(m[1]) : 0;
      const score = size >= 96 ? size - 96 : 10_000 - size;
      if (score < bestScore) {
        best = img;
        bestScore = score;
      }
    }
    return best.src;
  }

  function snapshot() {
    const m = ms.metadata;
    const state = ms.playbackState;
    return {
      title: m?.title ?? '',
      artist: m?.artist ?? '',
      album: m?.album ?? '',
      artwork: pickArtwork(m?.artwork),
      playing: state === 'playing' || (state !== 'paused' && elementPlaying()),
      actions: Array.from(handlers.keys()),
    };
  }

  let timer = 0;
  function schedule(): void {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      try {
        window.postMessage({ [mediaKey]: snapshot() }, '*');
      } catch {
        /* page may have torn down */
      }
    }, 80);
  }

  for (const ev of ['play', 'playing', 'pause', 'ended', 'emptied']) document.addEventListener(ev, schedule, true);
  window.addEventListener('load', schedule);
  window.setInterval(() => {
    if (elementPlaying()) schedule();
  }, 5000);

  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window || !e.data || typeof e.data[actionKey] !== 'string') return;
    const action = e.data[actionKey] as string;
    const fn = handlers.get(action);
    if (fn) {
      try {
        fn({ action });
      } catch {
        /* handler threw */
      }
      schedule();
      return;
    }
    const els = mediaEls();
    const el = els.find((x) => !x.paused) ?? els[0];
    if (!el) return;
    if (action === 'play') el.play().catch(() => {});
    else if (action === 'pause') el.pause();
    schedule();
  });
}

if (process.isMainFrame) {
  try {
    const bridge = contextBridge as typeof contextBridge & { executeInMainWorld?: (script: { func: (...args: string[]) => void; args?: string[] }) => unknown };
    if (typeof bridge.executeInMainWorld === 'function') bridge.executeInMainWorld({ func: mediaHook, args: [MEDIA_KEY, ACTION_KEY] });
    else void webFrame.executeJavaScript(`(${mediaHook.toString()})(${JSON.stringify(MEDIA_KEY)}, ${JSON.stringify(ACTION_KEY)})`);
  } catch (err) {
    console.warn('Chord media hook not installed', err);
  }

  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window || !e.data || typeof e.data !== 'object' || !(MEDIA_KEY in e.data)) return;
    ipcRenderer.send('media', e.data[MEDIA_KEY]);
  });
  ipcRenderer.on('media:action', (_event, action: string) => {
    window.postMessage({ [ACTION_KEY]: action }, '*');
  });
}
