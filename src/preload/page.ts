// Preload for every page view. It runs in an isolated world before the page's
// own scripts, so it cannot see the page's objects directly. Instead it installs
// a hook in the page's main world that mirrors what the page gives away —
// navigator.mediaSession (players), getUserMedia tracks (calls) and
// Notification() (alerts) — to Chord, and executes the actions Chord sends back.
// Only the top frame reports.

import { contextBridge, ipcRenderer, webFrame } from 'electron';
import { installDevAdapter } from './dev.ts';

const REPORT_KEY = '__chordSmart';
const ACTION_KEY = '__chordSmartAction';

/**
 * Runs first in every page's main world. Chord patches a few browser functions
 * (media session, notifications, getUserMedia, WebAuthn) to see what pages do;
 * bot checks such as Cloudflare's read those functions' source text and expect
 * "[native code]", and expect window.chrome on anything that calls itself
 * Chrome. This keeps both true: patched functions answer toString() like the
 * originals they replace, and window.chrome exists like in Chrome.
 */
function stealthHook(): void {
  const KEY = Symbol.for('chord.native');
  const w = window as unknown as Window & { [k: symbol]: unknown; chrome?: unknown };
  if (w[KEY]) return;
  const reg = new WeakMap<Function, Function>();
  const origToString = Function.prototype.toString;
  // a method, not a function expression: natives have no .prototype and neither does this
  const patchedToString = {
    toString(this: Function) {
      return origToString.call(reg.get(this) ?? this);
    },
  }.toString;
  reg.set(patchedToString, origToString);
  try {
    Object.defineProperty(Function.prototype, 'toString', { value: patchedToString, writable: true, configurable: true });
  } catch {
    /* frozen */
  }
  const mark = <T extends Function>(patched: T, orig: Function): T => {
    reg.set(patched, orig);
    try {
      Object.defineProperty(patched, 'name', { value: orig.name, configurable: true });
      Object.defineProperty(patched, 'length', { value: orig.length, configurable: true });
    } catch {
      /* not configurable */
    }
    return patched;
  };
  Object.defineProperty(w, KEY, { value: Object.freeze({ mark }), enumerable: false, configurable: false, writable: false });
  if (!('chrome' in w)) {
    const noop = { f() {} }.f;
    const chrome = {
      app: { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' }, getDetails: mark({ getDetails() { return null; } }.getDetails, noop), getIsInstalled: mark({ getIsInstalled() { return false; } }.getIsInstalled, noop), runningState: mark({ runningState() { return 'cannot_run'; } }.runningState, noop) },
      csi: mark({ csi() { return { startE: Date.now(), onloadT: Date.now(), pageT: performance.now(), tran: 15 }; } }.csi, noop),
      loadTimes: mark({ loadTimes() { const t = performance.timing; return { requestTime: t.requestStart / 1000, startLoadTime: t.requestStart / 1000, commitLoadTime: t.responseStart / 1000, finishDocumentLoadTime: t.domContentLoadedEventEnd / 1000, finishLoadTime: t.loadEventEnd / 1000, firstPaintTime: t.responseEnd / 1000, firstPaintAfterLoadTime: 0, navigationType: 'Other', wasFetchedViaSpdy: true, wasNpnNegotiated: true, npnNegotiatedProtocol: 'h2', wasAlternateProtocolAvailable: false, connectionInfo: 'h2' }; } }.loadTimes, noop),
      runtime: { OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' }, PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' }, PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' }, RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' } },
    };
    Object.defineProperty(w, 'chrome', { value: chrome, writable: true, configurable: true, enumerable: true });
  }
}

/** Runs in the page's main world on accounts.google.com: make navigator agree with the User-Agent header Chord sends there. */
function identityHook(userAgent: string, firefox: string): void {
  const nativeMark = ((window as unknown as { [k: symbol]: { mark: <T extends Function>(p: T, o: Function) => T } | undefined })[Symbol.for('chord.native')]?.mark ?? (<T extends Function>(p: T) => p)) as <T extends Function>(p: T, o: Function) => T;
  const define = (obj: object, key: string, value: unknown) => {
    try {
      const orig = Object.getOwnPropertyDescriptor(obj, key)?.get;
      const getter = { get() { return value; } }.get;
      Object.defineProperty(obj, key, { get: orig ? nativeMark(getter, orig) : getter, configurable: true });
    } catch {
      /* not configurable */
    }
  };
  const proto = Object.getPrototypeOf(navigator) as object;
  define(proto, 'userAgent', userAgent);
  define(proto, 'appVersion', userAgent.replace(/^Mozilla\//, ''));
  if (firefox === '1') {
    define(proto, 'userAgentData', undefined);
    define(proto, 'vendor', '');
    define(proto, 'productSub', '20100101');
  }
}

/**
 * Runs in the page's main world when Chord answers passkeys: navigator.credentials
 * asks Chord first (consent, Touch ID, the authenticator for this one call) and
 * then runs the real WebAuthn call, which Chromium routes to Chord's authenticator.
 */
function passkeyHook(reportKey: string, actionKey: string): void {
  const GUARD = Symbol.for('chord.passkeys');
  const w = window as unknown as Window & { [k: symbol]: unknown };
  if (w[GUARD]) return;
  Object.defineProperty(w, GUARD, { value: true });
  const pending = new Map<string, { resolve: (v: { ok: boolean; passthrough?: boolean; error?: string }) => void }>();
  let seq = 0;
  const ask = (method: string, args: Record<string, unknown>) =>
    new Promise<{ ok: boolean; passthrough?: boolean; error?: string }>((resolve) => {
      const callId = `pk-${Date.now().toString(36)}-${++seq}`;
      pending.set(callId, { resolve });
      window.postMessage({ [reportKey]: { kind: 'passkey', callId, method, args } }, '*');
      setTimeout(() => {
        if (pending.delete(callId)) resolve({ ok: false, error: 'Chord did not answer.' });
      }, 180_000);
    });
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window || !e.data || typeof e.data[actionKey] !== 'string') return;
    const raw = e.data[actionKey] as string;
    if (!raw.startsWith('passkey:')) return;
    try {
      const r = JSON.parse(raw.slice(8)) as { callId: string; ok: boolean; passthrough?: boolean; error?: string };
      const p = pending.get(r.callId);
      pending.delete(r.callId);
      p?.resolve(r);
    } catch {
      /* malformed */
    }
  });
  const b64 = (buf: unknown): string => {
    const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : ArrayBuffer.isView(buf) ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : new Uint8Array(0);
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const fail = (error?: string) => new DOMException(error || 'The operation either timed out or was not allowed.', 'NotAllowedError');
  const proto = (window as unknown as { CredentialsContainer?: { prototype: CredentialsContainer } }).CredentialsContainer?.prototype;
  const nativeMark = ((window as unknown as { [k: symbol]: { mark: <T extends Function>(p: T, o: Function) => T } | undefined })[Symbol.for('chord.native')]?.mark ?? (<T extends Function>(p: T) => p)) as <T extends Function>(p: T, o: Function) => T;
  if (proto) {
    const origCreate = proto.create;
    const origGet = proto.get;
    proto.create = nativeMark({ async create(this: CredentialsContainer, options?: CredentialCreationOptions) {
      const pk = options?.publicKey;
      if (!pk) return origCreate.call(this, options);
      const sel = pk.authenticatorSelection ?? {};
      const r = await ask('create', { rpId: pk.rp?.id ?? '', rpName: pk.rp?.name ?? '', userName: pk.user?.name ?? '', userDisplayName: pk.user?.displayName ?? '', residentKey: sel.residentKey ?? '', attachment: sel.authenticatorAttachment ?? '' });
      if (!r.ok) {
        if (r.passthrough) return origCreate.call(this, options);
        throw fail(r.error);
      }
      try {
        return await origCreate.call(this, options);
      } finally {
        void ask('done', {});
      }
    } }.create, origCreate);
    proto.get = nativeMark({ async get(this: CredentialsContainer, options?: CredentialRequestOptions) {
      const pk = options?.publicKey;
      if (!pk) return origGet.call(this, options);
      const r = await ask('get', { rpId: pk.rpId ?? '', allow: (pk.allowCredentials ?? []).map((c) => b64(c.id)), conditional: options?.mediation === 'conditional' });
      if (!r.ok) {
        if (r.passthrough) return origGet.call(this, options);
        throw fail(r.error);
      }
      try {
        return await origGet.call(this, options);
      } finally {
        void ask('done', {});
      }
    } }.get, origGet);
  }
  const PKC = (window as unknown as { PublicKeyCredential?: Record<string, unknown> }).PublicKeyCredential;
  if (PKC) {
    try {
      const o1 = PKC.isUserVerifyingPlatformAuthenticatorAvailable as Function;
      const o2 = PKC.isConditionalMediationAvailable as Function;
      PKC.isUserVerifyingPlatformAuthenticatorAvailable = nativeMark({ isUserVerifyingPlatformAuthenticatorAvailable() { return Promise.resolve(true); } }.isUserVerifyingPlatformAuthenticatorAvailable, o1 ?? { f() {} }.f);
      PKC.isConditionalMediationAvailable = nativeMark({ isConditionalMediationAvailable() { return Promise.resolve(false); } }.isConditionalMediationAvailable, o2 ?? { f() {} }.f);
    } catch {
      /* frozen */
    }
  }
}

/** Runs inside the page's main world. Must stay self-contained: no imports, no closures. */
function smartHook(reportKey: string, actionKey: string): void {
  const GUARD = Symbol.for('chord.smart');
  const w = window as unknown as Window & { [k: symbol]: unknown; APP?: { conference?: Record<string, (...a: unknown[]) => unknown> } };
  if (w[GUARD]) return;
  Object.defineProperty(w, GUARD, { value: true });

  const post = (payload: unknown) => {
    try {
      window.postMessage({ [reportKey]: payload }, '*');
    } catch {
      /* page may have torn down */
    }
  };
  const nativeMark = ((window as unknown as { [k: symbol]: { mark: <T extends Function>(p: T, o: Function) => T } | undefined })[Symbol.for('chord.native')]?.mark ?? (<T extends Function>(p: T) => p)) as <T extends Function>(p: T, o: Function) => T;

  // ---- media session ----
  const nav = navigator as Navigator & { mediaSession?: MediaSession };
  const ms = nav.mediaSession;
  const handlers = new Map<string, (details: { action: string }) => void>();
  if (ms) {
    const proto = Object.getPrototypeOf(ms) as MediaSession;
    const origSet = proto.setActionHandler;
    proto.setActionHandler = nativeMark({ setActionHandler(this: MediaSession, name: MediaSessionAction, fn: MediaSessionActionHandler | null) {
      if (fn) handlers.set(name, fn as (details: { action: string }) => void);
      else handlers.delete(name);
      const r = origSet.call(this, name, fn);
      schedule();
      return r;
    } }.setActionHandler, origSet);
    for (const prop of ['metadata', 'playbackState'] as const) {
      const d = Object.getOwnPropertyDescriptor(proto, prop);
      if (!d || !d.set || !d.get) continue;
      const { get, set } = d;
      Object.defineProperty(proto, prop, {
        configurable: true,
        enumerable: d.enumerable,
        get,
        set: nativeMark({ set(this: MediaSession, v: unknown) {
          set.call(this, v);
          schedule();
        } }.set, set),
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
  const mdProto = md ? (Object.getPrototypeOf(md) as Record<string, unknown>) : null;
  const wrap = (name: 'getUserMedia' | 'getDisplayMedia', into: Set<MediaStream>) => {
    if (!md || !mdProto || typeof mdProto[name] !== 'function') return;
    const origFn = mdProto[name] as (this: MediaDevices, c?: unknown) => Promise<MediaStream>;
    const wrapped = {
      async f(this: MediaDevices, constraints?: unknown) {
        const stream = await origFn.call(this, constraints);
        into.add(stream);
        if (!callSince) callSince = Date.now();
        for (const t of stream.getTracks()) t.addEventListener('ended', schedule);
        schedule();
        return stream;
      },
    }.f;
    try {
      Object.defineProperty(wrapped, 'name', { value: name, configurable: true });
      Object.defineProperty(mdProto, name, { value: nativeMark(wrapped, origFn), writable: true, configurable: true, enumerable: true });
    } catch {
      /* not configurable */
    }
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
      Object.defineProperty(Object.getPrototypeOf(navigator) as object, 'modelContext', { get: nativeMark({ modelContext() { return ctxApi; } }.modelContext, { f() {} }.f), configurable: true, enumerable: true });
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
    const Wrapped = nativeMark(function Notification(this: unknown, title: string, options?: NotificationOptions) {
      post({ kind: 'notification', title: String(title ?? ''), body: String(options?.body ?? '') });
      return new OrigNotification(title, options);
    }, OrigNotification) as unknown as typeof Notification;
    Wrapped.prototype = OrigNotification.prototype;
    try {
      Object.defineProperty(OrigNotification.prototype, 'constructor', { value: Wrapped, writable: true, configurable: true, enumerable: false });
    } catch {
      /* frozen */
    }
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
    // ---- deeper integration, for boosted sites and granted origins ----
    /** A card in Chord's sidebar, shown from every space, with up to four actions. */
    card: {
      set: (card: { title: string; subtitle?: string; state?: string; badge?: number; actions?: { id: string; label: string }[] }) => call('card', { card }).then(() => undefined),
      clear: () => call('card', { card: null }).then(() => undefined),
      /** fn(actionId) when the user presses one of the card's buttons */
      onAction: (fn: (id: string) => void) => chordEvents.addEventListener('cardaction', (e) => fn((e as CustomEvent<{ id: string }>).detail.id)),
    },
    /** Badge on the tab and the space dot; null goes back to reading the title. */
    setUnread: (count: number | null) => call('unread', { count }).then(() => undefined),
    /** Counted like a web notification: the bell in the title bar, a badge on the tab. */
    notify: (title: string, body = '') => call('notify', { title, body }).then(() => undefined),
    /** Bookmark a page (this one by default) into the tab's space. */
    bookmark: (opts: { url?: string; title?: string; note?: string; tags?: string[]; public?: boolean } = {}) => call('bookmark', opts).then(() => undefined),
    /** Append Markdown to the space's notes. */
    addNote: (text: string) => call('note', { text }).then(() => undefined),
    /** Subscribe the reader to a feed (this page's, discovered, by default), tagged with the space. */
    subscribe: (url?: string) => call('subscribe', url ? { url } : {}),
    /** Open a page in the space (a plain tab, not part of the page's subspace). */
    open: (url: string, opts: { background?: boolean } = {}) => call('openUrl', { url, background: opts.background === true }).then(() => undefined),
    /** Open a page in a Little window. */
    openLittle: (url: string) => call('little', { url }).then(() => undefined),
    /** The space this tab is in and Chord's look: { space: { id, name, color, icon }, accent, dark, font }. Also CSS variables --chord-space, --chord-accent and data-chord-theme on <html>, and a "theme" event. */
    theme: () => call('theme'),
    addEventListener: chordEvents.addEventListener.bind(chordEvents),
    removeEventListener: chordEvents.removeEventListener.bind(chordEvents),
  };
  const applyTheme = (t: { space: { color: string }; accent: string; dark: boolean }) => {
    const root = document.documentElement;
    root.style.setProperty('--chord-space', t.space.color);
    root.style.setProperty('--chord-accent', t.accent);
    root.dataset.chordTheme = t.dark ? 'dark' : 'light';
    chordEvents.dispatchEvent(new CustomEvent('theme', { detail: t }));
  };
  Object.freeze(chordApi);
  try {
    Object.defineProperty(Object.getPrototypeOf(navigator) as object, 'chord', { get: nativeMark({ chord() { return chordApi; } }.chord, { f() {} }.f), configurable: true, enumerable: false });
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
    if (kind === 'card') {
      chordEvents.dispatchEvent(new CustomEvent('cardaction', { detail: { id: action } }));
      return;
    }
    if (kind === 'theme') {
      try {
        applyTheme(JSON.parse(action));
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

const bridge = contextBridge as typeof contextBridge & { executeInMainWorld?: (script: { func: (...args: string[]) => void; args?: string[] }) => unknown };
const runInMainWorld = (func: (...args: string[]) => void, args: string[]) => {
  if (typeof bridge.executeInMainWorld === 'function') bridge.executeInMainWorld({ func, args });
  else void webFrame.executeJavaScript(`(${func.toString()})(${args.map((a) => JSON.stringify(a)).join(', ')})`);
};

// First: patched functions must look native and window.chrome must exist (bot checks).
try {
  runInMainWorld(stealthHook, []);
} catch (err) {
  console.warn('Chord stealth hook not installed', err);
}

let pageHooks = true;
try {
  pageHooks = ipcRenderer.sendSync('page:hooks') !== false;
} catch {
  /* main not ready */
}

// Google's sign-in pages get a different identity (see main/identity.ts); the page must see the same one.
if (pageHooks && /^(accounts\.google\.com|accounts\.youtube\.com)$/.test(location.host)) {
  try {
    const ident = ipcRenderer.sendSync('identity') as { mode: string; userAgent: string } | undefined;
    if (ident && ident.mode !== 'off' && ident.userAgent) runInMainWorld(identityHook, [ident.userAgent, ident.mode === 'firefox' ? '1' : '0']);
  } catch (err) {
    console.warn('Chord identity hook not installed', err);
  }
}

if (process.isMainFrame) {
  // Sources mode runs its page script in this isolated world; clicks on its marks come back through here.
  (window as Window & { __chordSourceror?: { select(kind: string, id: string): void } }).__chordSourceror = {
    select: (kind: string, id: string) => ipcRenderer.send('sourceror', { kind: String(kind), id: String(id) }),
  };
  if (pageHooks) {
    try {
      runInMainWorld(smartHook, [REPORT_KEY, ACTION_KEY]);
    } catch (err) {
      console.warn('Chord page hook not installed', err);
    }
  }
  // GitHub and VS Code are read from this world, which sees the DOM but not the page's scripts.
  const dev = installDevAdapter();
  // Two-finger horizontal swipe on a page that cannot scroll sideways: back and forward.
  let gestureX = 0;
  let gestureTimer = 0;
  let gestureDone = false;
  const canScrollX = (start: EventTarget | null, dx: number): boolean => {
    let el = start instanceof Element ? start : null;
    while (el) {
      if (el.scrollWidth > el.clientWidth + 1) {
        const ox = getComputedStyle(el).overflowX;
        const scrolls = el === document.documentElement || el === document.body ? ox !== 'hidden' : ox === 'auto' || ox === 'scroll' || ox === 'overlay';
        if (scrolls && (dx > 0 ? el.scrollLeft + el.clientWidth < el.scrollWidth - 1 : el.scrollLeft > 0)) return true;
      }
      el = el.parentElement;
    }
    return false;
  };
  window.addEventListener('wheel', (e) => {
    if (e.deltaMode !== 0 || e.ctrlKey) return; // pixel deltas only: a touchpad, not a mouse wheel
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      gestureX = 0;
      return;
    }
    if (canScrollX(e.target, e.deltaX)) {
      gestureX = 0;
      return;
    }
    gestureX += e.deltaX;
    window.clearTimeout(gestureTimer);
    gestureTimer = window.setTimeout(() => {
      gestureX = 0;
      gestureDone = false;
    }, 300);
    if (!gestureDone && Math.abs(gestureX) > 240) {
      gestureDone = true;
      ipcRenderer.send('nav:gesture', gestureX > 0 ? 'forward' : 'back');
    }
  }, { passive: true, capture: true });

  // Passkeys: when Chord is the authenticator, the page asks it before every WebAuthn call.
  if (pageHooks && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    try {
      if (ipcRenderer.sendSync('passkey:mode') === 'chord') runInMainWorld(passkeyHook, [REPORT_KEY, ACTION_KEY]);
    } catch (err) {
      console.warn('Chord passkey hook not installed', err);
    }
  }

  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window || !e.data || typeof e.data !== 'object' || !(REPORT_KEY in e.data)) return;
    const payload = e.data[REPORT_KEY] as { kind?: string; callId?: string; method?: string; args?: unknown } | null;
    if (payload && payload.kind === 'passkey') {
      const callId = String(payload.callId ?? '');
      ipcRenderer
        .invoke('passkey', { method: payload.method, ...(typeof payload.args === 'object' && payload.args !== null ? payload.args : {}) })
        .then((r: { ok: boolean; passthrough?: boolean; error?: string }) => window.postMessage({ [ACTION_KEY]: `passkey:${JSON.stringify({ callId, ...r })}` }, '*'))
        .catch((err: Error) => window.postMessage({ [ACTION_KEY]: `passkey:${JSON.stringify({ callId, ok: false, error: err.message })}` }, '*'));
      return;
    }
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
    if (action.startsWith('dev:')) return dev.act(action.slice(4));
    window.postMessage({ [ACTION_KEY]: action }, '*');
  });
  ipcRenderer.on('pagetabs:event', (_event, ev: unknown) => {
    window.postMessage({ [ACTION_KEY]: `pagetabsevent:${JSON.stringify(ev)}` }, '*');
  });

  // ---- installable spaces: a site declares <link rel="chord-space" href="…"> ----
  const reportManifest = () => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="chord-space"][href]');
    if (link && /^https:/i.test(link.href)) ipcRenderer.send('smart', { kind: 'manifest', url: link.href });
    // feeds the page advertises, for the reader's subscribe button
    const feeds = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="alternate"][type][href]'))
      .filter((l) => /(rss|atom|feed\+json)/i.test(l.type) || (/json/i.test(l.type) && /feed/i.test(l.href)))
      .map((l) => ({ title: l.title || '', url: l.href }));
    if (feeds.length) ipcRenderer.send('smart', { kind: 'feeds', feeds });
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

    // Filling: as soon as a sign-in form shows up when the user allows it (Settings →
    // Passwords), otherwise when they click into one. Username-first flows get the
    // username; the password follows on the next screen.
    type Lookup = { auto: boolean; entries: { username: string; password: string }[] };
    let lookup: Promise<Lookup> | null = null;
    const creds = (): Promise<Lookup> => (lookup ??= (ipcRenderer.invoke('passwords:lookup', location.host) as Promise<Lookup>).catch(() => ({ auto: false, entries: [] })));
    let filledPw: HTMLInputElement | null = null;
    let filledUser: HTMLInputElement | null = null;
    const set = (el: HTMLInputElement | null, value: string) => {
      if (!el || el.value || !value) return;
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const looksLikeUsername = (i: HTMLInputElement): boolean => {
      if (i.disabled || i.readOnly || i.offsetParent === null) return false;
      const ac = (i.getAttribute('autocomplete') ?? '').toLowerCase();
      if (ac === 'username' || ac === 'email') return true;
      if (ac === 'off' && i.type !== 'email') return false;
      if (!['text', 'email', 'tel', ''].includes(i.type)) return false;
      if (i.form?.getAttribute('role') === 'search' || i.form?.querySelector('input[type="search"]')) return false;
      return i.type === 'email' || /user|email|e-mail|login|account|identifier/i.test(`${i.name} ${i.id} ${i.placeholder} ${i.getAttribute('aria-label') ?? ''}`);
    };
    const fill = async (trigger: 'auto' | 'focus', target?: HTMLInputElement) => {
      const { auto, entries } = await creds();
      if (!entries.length || (trigger === 'auto' && !auto)) return;
      const pw = passwordFields().find((p) => !p.value) ?? passwordFields()[0];
      if (pw) {
        if (pw.value || filledPw === pw) return;
        filledPw = pw;
        set(usernameFor(pw), entries[0].username);
        set(pw, entries[0].password);
        return;
      }
      // no password field: a username-first page
      const user = target && looksLikeUsername(target) ? target : Array.from(document.querySelectorAll<HTMLInputElement>('input')).find(looksLikeUsername) ?? null;
      if (!user || user.value || filledUser === user) return;
      filledUser = user;
      set(user, entries[0].username);
    };
    document.addEventListener('focusin', (e) => {
      const t = e.target;
      if (!(t instanceof HTMLInputElement)) return;
      if (t.type === 'password' || passwordFields().some((p) => (p.form ?? document) === (t.form ?? document)) || looksLikeUsername(t)) void fill('focus', t);
    }, true);
    let mutationTimer = 0;
    const onChange = () => {
      window.clearTimeout(mutationTimer);
      mutationTimer = window.setTimeout(() => {
        if (filledPw && !filledPw.isConnected) filledPw = null;
        if (filledUser && !filledUser.isConnected) filledUser = null;
        void fill('auto');
      }, 250);
    };
    const observe = () => new MutationObserver(onChange).observe(document.documentElement, { childList: true, subtree: true });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observe);
    else observe();
    window.addEventListener('load', () => void fill('auto'));
    window.addEventListener('popstate', onChange);
  }
}
