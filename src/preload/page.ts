// Preload for every page view. It runs in an isolated world before the page's
// own scripts, so it cannot see the page's objects directly. Instead it installs
// a hook in the page's main world that mirrors what the page gives away —
// navigator.mediaSession (players), getUserMedia tracks (calls) and
// Notification() (alerts) — to Chord, and executes the actions Chord sends back.
// Only the top frame reports.

import { contextBridge, ipcRenderer, webFrame } from 'electron';

const REPORT_KEY = '__chordSmart';
const ACTION_KEY = '__chordSmartAction';

/** Runs inside the page's main world. Must stay self-contained: no imports, no closures. */
function smartHook(reportKey: string, actionKey: string): void {
  const w = window as Window & { __chordHooked?: boolean; APP?: { conference?: Record<string, (...a: unknown[]) => unknown> } };
  if (w.__chordHooked) return;
  Object.defineProperty(w, '__chordHooked', { value: true });

  const post = (payload: unknown) => {
    try {
      window.postMessage({ [reportKey]: payload }, '*');
    } catch {
      /* page may have torn down */
    }
  };

  // ---- media session ----
  const nav = navigator as Navigator & { mediaSession?: MediaSession };
  const ms = nav.mediaSession;
  const handlers = new Map<string, (details: { action: string }) => void>();
  if (ms) {
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
  function mediaSnapshot() {
    const m = ms?.metadata;
    const state = ms?.playbackState;
    const playing = state === 'playing' || (state !== 'paused' && elementPlaying());
    if (!m && !playing) return null;
    return {
      title: m?.title ?? '',
      artist: m?.artist ?? '',
      album: m?.album ?? '',
      artwork: pickArtwork(m?.artwork),
      playing,
      actions: Array.from(handlers.keys()),
    };
  }

  // ---- calls: live microphone/camera tracks ----
  const streams = new Set<MediaStream>();
  const shares = new Set<MediaStream>();
  let callSince = 0;
  const md = navigator.mediaDevices;
  const wrap = (name: 'getUserMedia' | 'getDisplayMedia', into: Set<MediaStream>) => {
    if (!md || typeof md[name] !== 'function') return;
    const orig = md[name].bind(md) as (c?: unknown) => Promise<MediaStream>;
    (md as unknown as Record<string, unknown>)[name] = async (constraints?: unknown) => {
      const stream = await orig(constraints);
      into.add(stream);
      if (!callSince) callSince = Date.now();
      for (const t of stream.getTracks()) t.addEventListener('ended', schedule);
      schedule();
      return stream;
    };
  };
  wrap('getUserMedia', streams);
  wrap('getDisplayMedia', shares);
  const liveTracks = (set: Set<MediaStream>) => Array.from(set).flatMap((s) => s.getTracks()).filter((t) => t.readyState === 'live');
  const findButton = (re: RegExp): HTMLElement | undefined =>
    Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]')).find((b) => re.test(b.getAttribute('aria-label') || b.getAttribute('title') || b.getAttribute('data-tooltip') || ''));
  const jitsi = () => w.APP?.conference;
  function callSnapshot() {
    const live = liveTracks(streams);
    const sharing = liveTracks(shares).length > 0;
    if (live.length === 0 && !sharing) {
      callSince = 0;
      return null;
    }
    const audio = live.filter((t) => t.kind === 'audio');
    const video = live.filter((t) => t.kind === 'video');
    const j = jitsi();
    const muted = j && typeof j.isLocalAudioMuted === 'function' ? Boolean(j.isLocalAudioMuted()) : audio.length ? audio.every((t) => !t.enabled) : null;
    const cameraOff = j && typeof j.isLocalVideoMuted === 'function' ? Boolean(j.isLocalVideoMuted()) : video.length ? video.every((t) => !t.enabled) : true;
    return { since: callSince, muted, cameraOff, sharing, canLeave: true };
  }
  let lastCallKey = '';
  window.setInterval(() => {
    const c = callSnapshot();
    const key = c ? `${c.muted}|${c.cameraOff}|${c.sharing}` : '';
    if (key !== lastCallKey) {
      lastCallKey = key;
      schedule();
    }
  }, 1500);

  function callAction(action: string): void {
    const j = jitsi();
    if (action === 'mute') {
      if (j && typeof j.toggleAudioMuted === 'function') return void j.toggleAudioMuted();
      const btn = findButton(/^(mute|unmute)\b|microphone|\bmic\b/i);
      if (btn) return btn.click();
      const audio = liveTracks(streams).filter((t) => t.kind === 'audio');
      const on = audio.some((t) => t.enabled);
      for (const t of audio) t.enabled = !on;
    } else if (action === 'camera') {
      if (j && typeof j.toggleVideoMuted === 'function') return void j.toggleVideoMuted();
      const btn = findButton(/camera|^(start|stop) video|turn (on|off) video/i);
      if (btn) return btn.click();
      const video = liveTracks(streams).filter((t) => t.kind === 'video');
      const on = video.some((t) => t.enabled);
      for (const t of video) t.enabled = !on;
    } else if (action === 'leave') {
      if (j && typeof j.hangup === 'function') return void j.hangup();
      const btn = findButton(/leave( call| meeting)?$|hang ?up|end (call|meeting)/i);
      if (btn) return btn.click();
      for (const s of [...streams, ...shares]) for (const t of s.getTracks()) t.stop();
    }
    schedule();
  }

  // ---- notifications ----
  const g = w as unknown as { Notification?: typeof Notification };
  const OrigNotification = g.Notification;
  if (typeof OrigNotification === 'function') {
    const Wrapped = function (this: unknown, title: string, options?: NotificationOptions) {
      post({ kind: 'notification', title: String(title ?? ''), body: String(options?.body ?? '') });
      return new OrigNotification(title, options);
    } as unknown as typeof Notification;
    Wrapped.prototype = OrigNotification.prototype;
    Object.defineProperty(Wrapped, 'permission', { get: () => OrigNotification.permission });
    Object.defineProperty(Wrapped, 'maxActions', { get: () => (OrigNotification as unknown as { maxActions: number }).maxActions });
    Wrapped.requestPermission = OrigNotification.requestPermission.bind(OrigNotification);
    g.Notification = Wrapped;
  }

  // ---- reporting ----
  let timer = 0;
  function schedule(): void {
    clearTimeout(timer);
    timer = window.setTimeout(() => post({ kind: 'state', media: mediaSnapshot(), call: callSnapshot() }), 80);
  }
  for (const ev of ['play', 'playing', 'pause', 'ended', 'emptied']) document.addEventListener(ev, schedule, true);
  window.addEventListener('load', schedule);
  window.setInterval(() => {
    if (elementPlaying()) schedule();
  }, 5000);

  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window || !e.data || typeof e.data[actionKey] !== 'string') return;
    const [kind, action] = (e.data[actionKey] as string).split(':');
    if (kind === 'call') return callAction(action);
    if (kind !== 'media') return;
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
    if (typeof bridge.executeInMainWorld === 'function') bridge.executeInMainWorld({ func: smartHook, args: [REPORT_KEY, ACTION_KEY] });
    else void webFrame.executeJavaScript(`(${smartHook.toString()})(${JSON.stringify(REPORT_KEY)}, ${JSON.stringify(ACTION_KEY)})`);
  } catch (err) {
    console.warn('Chord page hook not installed', err);
  }

  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window || !e.data || typeof e.data !== 'object' || !(REPORT_KEY in e.data)) return;
    ipcRenderer.send('smart', e.data[REPORT_KEY]);
  });
  ipcRenderer.on('smart:action', (_event, action: string) => {
    window.postMessage({ [ACTION_KEY]: action }, '*');
  });
}
