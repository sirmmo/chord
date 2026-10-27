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
  // ---- per-tab volume set from Chord's sidebar ----
  let tabVolume = 1;
  const applyVolume = () => {
    if (tabVolume >= 1) return;
    for (const el of mediaEls()) if (Math.abs(el.volume - tabVolume) > 0.001) el.volume = tabVolume;
  };
  document.addEventListener('play', applyVolume, true);
  document.addEventListener('loadedmetadata', applyVolume, true);
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
      video: Array.from(document.querySelectorAll('video')).some((v) => v.readyState >= 2 && v.videoWidth > 0),
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

  // ---- middle click and modifier click on links: the browser opens the tab, not the page's scripts ----
  const linkOf = (target: EventTarget | null): string | null => {
    const a = target instanceof Element ? target.closest('a[href]') : null;
    if (!a) return null;
    const href = (a as HTMLAnchorElement).href;
    return /^(https?|ftp):\/\//i.test(href) ? href : null;
  };
  const openLink = (e: MouseEvent, background: boolean) => {
    const href = linkOf(e.target);
    if (!href) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    post({ kind: 'open', url: href, background });
  };
  window.addEventListener('auxclick', (e) => { if (e.button === 1) openLink(e, true); }, true);
  window.addEventListener('mousedown', (e) => { if (e.button === 1 && linkOf(e.target)) e.stopImmediatePropagation(); }, true);
  window.addEventListener('mouseup', (e) => { if (e.button === 1 && linkOf(e.target)) e.stopImmediatePropagation(); }, true);
  window.addEventListener('click', (e) => {
    const mod = navigator.platform.startsWith('Mac') ? e.metaKey : e.ctrlKey;
    if (e.button === 0 && mod && !e.altKey) openLink(e, !e.shiftKey);
  }, true);

  // ---- WebMCP: tools the page offers to browser agents (navigator.modelContext) ----
  const mcpTools = new Map<string, { name: string; description?: string; inputSchema?: unknown; execute?: (input: unknown) => unknown }>();
  const reportTools = () => post({ kind: 'webmcp', tools: Array.from(mcpTools.values()).map((t) => ({ name: t.name, description: t.description ?? '', inputSchema: safeJson(t.inputSchema) })) });
  const safeJson = (v: unknown): unknown => {
    try {
      return JSON.parse(JSON.stringify(v ?? null));
    } catch {
      return null;
    }
  };
  const ctxApi = {
    registerTool(tool: { name: string }) {
      if (tool && typeof tool.name === 'string') mcpTools.set(tool.name, tool);
      reportTools();
    },
    unregisterTool(name: string) {
      mcpTools.delete(name);
      reportTools();
    },
    provideContext(ctx?: { tools?: { name: string }[] }) {
      mcpTools.clear();
      for (const t of ctx?.tools ?? []) if (t && typeof t.name === 'string') mcpTools.set(t.name, t);
      reportTools();
    },
    clearContext() {
      mcpTools.clear();
      reportTools();
    },
  };
  const navAny = navigator as unknown as Record<string, unknown>;
  const native = navAny.modelContext as Record<string, (...a: unknown[]) => unknown> | undefined;
  if (native && typeof native === 'object') {
    // Chromium ships its own: observe what the page registers without taking it over.
    for (const m of ['registerTool', 'unregisterTool', 'provideContext', 'clearContext'] as const) {
      const orig = typeof native[m] === 'function' ? native[m].bind(native) : null;
      if (orig) native[m] = (...a: unknown[]) => {
        (ctxApi[m] as (...x: unknown[]) => void)(...a);
        return orig(...a);
      };
    }
  } else {
    try {
      Object.defineProperty(navigator, 'modelContext', { value: ctxApi, configurable: true });
    } catch {
      /* not writable */
    }
  }
  async function runPageTool(callId: string, name: string, args: unknown): Promise<void> {
    const tool = mcpTools.get(name);
    if (!tool || typeof tool.execute !== 'function') return post({ kind: 'webmcp:result', callId, error: 'tool not found' });
    try {
      const result = await tool.execute(args);
      post({ kind: 'webmcp:result', callId, result: safeJson(result) });
    } catch (e) {
      post({ kind: 'webmcp:result', callId, error: String(e instanceof Error ? e.message : e) });
    }
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

  // ---- navigator.chord: a page may open and close tabs of its own (a subspace) ----
  const pageCalls = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const chordEvents = new EventTarget();
  let callSeq = 0;
  const call = (method: string, args?: Record<string, unknown>): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const callId = `${Date.now().toString(36)}-${++callSeq}`;
      pageCalls.set(callId, { resolve, reject });
      post({ kind: 'pagetabs', callId, method, args });
      setTimeout(() => {
        if (pageCalls.delete(callId)) reject(new Error('Chord did not answer'));
      }, 120_000);
    });
  const chordApi = {
    version: 1,
    /** Ask once; resolves true when this origin may manage tabs in the space. */
    requestTabs: () => call('request').then((r) => Boolean((r as { granted?: boolean })?.granted)),
    /** Whether the permission was already granted, without asking. */
    tabsGranted: () => call('status').then((r) => Boolean((r as { granted?: boolean })?.granted)),
    openTab: (opts: { url: string; activate?: boolean }) => call('open', { url: opts?.url, activate: opts?.activate === true }),
    closeTab: (id: string) => call('close', { id }).then(() => undefined),
    focusTab: (id: string) => call('focus', { id }).then(() => undefined),
    navigateTab: (id: string, url: string) => call('navigate', { id, url }).then(() => undefined),
    listTabs: () => call('list'),
    setSubspaceName: (name: string) => call('name', { name }).then(() => undefined),
    addEventListener: chordEvents.addEventListener.bind(chordEvents),
    removeEventListener: chordEvents.removeEventListener.bind(chordEvents),
  };
  Object.freeze(chordApi);
  try {
    Object.defineProperty(navigator, 'chord', { value: chordApi, configurable: false, enumerable: false, writable: false });
  } catch {
    /* already defined */
  }

  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window || !e.data || typeof e.data[actionKey] !== 'string') return;
    const raw = e.data[actionKey] as string;
    const sep = raw.indexOf(':');
    const kind = raw.slice(0, sep);
    const action = raw.slice(sep + 1);
    if (kind === 'pagetabs') {
      try {
        const r = JSON.parse(action) as { callId: string; ok: boolean; result?: unknown; error?: string };
        const p = pageCalls.get(r.callId);
        pageCalls.delete(r.callId);
        if (!p) return;
        if (r.ok) p.resolve(r.result);
        else p.reject(new Error(r.error ?? 'failed'));
      } catch {
        /* malformed */
      }
      return;
    }
    if (kind === 'pagetabsevent') {
      try {
        const ev = JSON.parse(action) as { type: string } & Record<string, unknown>;
        chordEvents.dispatchEvent(new CustomEvent(ev.type, { detail: ev }));
      } catch {
        /* malformed */
      }
      return;
    }
    if (kind === 'webmcp') {
      try {
        const { callId, name, args } = JSON.parse(action) as { callId: string; name: string; args: unknown };
        void runPageTool(callId, name, args);
      } catch {
        /* malformed */
      }
      return;
    }
    if (kind === 'volume') {
      tabVolume = Math.max(0, Math.min(1, Number(action)));
      if (tabVolume >= 1) for (const el of mediaEls()) el.volume = 1;
      else applyVolume();
      return;
    }
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
    const payload = e.data[REPORT_KEY] as { kind?: string; callId?: string; method?: string; args?: unknown } | null;
    if (payload && payload.kind === 'pagetabs') {
      const callId = String(payload.callId ?? '');
      ipcRenderer
        .invoke('pagetabs', { method: payload.method, args: payload.args })
        .then((r: { ok: boolean; result?: unknown; error?: string }) => window.postMessage({ [ACTION_KEY]: `pagetabs:${JSON.stringify({ callId, ...r })}` }, '*'))
        .catch((err: Error) => window.postMessage({ [ACTION_KEY]: `pagetabs:${JSON.stringify({ callId, ok: false, error: err.message })}` }, '*'));
      return;
    }
    ipcRenderer.send('smart', payload);
  });
  ipcRenderer.on('smart:action', (_event, action: string) => {
    window.postMessage({ [ACTION_KEY]: action }, '*');
  });
  ipcRenderer.on('pagetabs:event', (_event, ev: unknown) => {
    window.postMessage({ [ACTION_KEY]: `pagetabsevent:${JSON.stringify(ev)}` }, '*');
  });

  // ---- installable spaces: a site declares <link rel="chord-space" href="…"> ----
  const reportManifest = () => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="chord-space"][href]');
    if (link && /^https:/i.test(link.href)) ipcRenderer.send('smart', { kind: 'manifest', url: link.href });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', reportManifest);
  else reportManifest();

  // ---- passwords: capture on submit and fill on focus, from the isolated world (page scripts never see the bridge) ----
  if (location.protocol === 'https:' || location.hostname === 'localhost') {
    const passwordFields = () => Array.from(document.querySelectorAll<HTMLInputElement>('input[type="password"]')).filter((i) => !i.disabled && i.offsetParent !== null);
    const usernameFor = (pw: HTMLInputElement): HTMLInputElement | null => {
      const scope: ParentNode = pw.form ?? document;
      const explicit = scope.querySelector<HTMLInputElement>('input[autocomplete="username"], input[autocomplete="email"]');
      if (explicit) return explicit;
      const inputs = Array.from(scope.querySelectorAll<HTMLInputElement>('input')).filter((i) => ['text', 'email', 'tel', ''].includes(i.type) && !i.disabled && !i.hidden);
      const before = inputs.filter((i) => i.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING);
      return before[before.length - 1] ?? inputs[0] ?? null;
    };
    const capture = (pw: HTMLInputElement) => {
      if (!pw.value) return;
      const user = usernameFor(pw);
      ipcRenderer.send('passwords:captured', { host: location.host, username: user?.value ?? '', password: pw.value });
    };
    document.addEventListener('submit', (e) => {
      const form = e.target instanceof HTMLFormElement ? e.target : null;
      const pw = form ? form.querySelector<HTMLInputElement>('input[type="password"]') : null;
      if (pw) capture(pw);
    }, true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target instanceof HTMLInputElement && e.target.type === 'password') capture(e.target);
    }, true);
    document.addEventListener('click', (e) => {
      const btn = e.target instanceof Element ? e.target.closest('button, input[type="submit"], [role="button"]') : null;
      if (!btn) return;
      const scope = btn.closest('form') ?? document;
      const pw = scope.querySelector<HTMLInputElement>('input[type="password"]');
      if (pw && pw.value) capture(pw);
    }, true);

    let filled = false;
    const fill = async () => {
      if (filled) return;
      const pw = passwordFields()[0];
      if (!pw || pw.value) return;
      const creds = (await ipcRenderer.invoke('passwords:lookup', location.host)) as { username: string; password: string }[];
      if (!creds.length) return;
      filled = true;
      const user = usernameFor(pw);
      const set = (el: HTMLInputElement | null, value: string) => {
        if (!el || el.value) return;
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      set(user, creds[0].username);
      set(pw, creds[0].password);
    };
    document.addEventListener('focusin', (e) => {
      if (e.target instanceof HTMLInputElement && (e.target.type === 'password' || passwordFields().some((p) => (p.form ?? document) === ((e.target as HTMLInputElement).form ?? document)))) void fill();
    }, true);
    window.addEventListener('load', () => {
      if (passwordFields().length) void fill();
    });
  }
}
