// Connected spaces: a space several people keep together over MQTT.
//
// Every member's Chord talks to a broker (the one in Settings → Connected; HiveMQ's public
// broker by default) over TLS only, and the space itself travels sealed: the join link
// carries a random id (the topic) and a random key (AES-256-GCM), so the broker and anyone
// listening to it see ciphertext. The shared document is a small state-based CRDT: a set of
// pinned tabs keyed by URL with add/remove timestamps, plus last-writer-wins metadata. Two
// members changing the space at the same time both keep their changes.

import type { Space, State, Tab } from './types.ts';

export const DEFAULT_BROKER = 'mqtts://broker.hivemq.com:8883';
export const TOPIC_ROOT = 'chord/v1';
const MAX_TABS = 400;
const MAX_TOMBSTONES = 500;
const TOMBSTONE_TTL = 30 * 86_400_000;

export interface ConnectedSpace {
  /** topic id, 24 hex characters */
  id: string;
  /** base64url AES-256 key */
  key: string;
  /** broker URL, mqtts:// or wss:// */
  broker: string;
  since: number;
}

export interface SharedTab {
  url: string;
  title: string;
  name?: string;
  icon?: string;
  group?: string;
  /** when this URL was (last) added */
  at: number;
}

export interface SharedDoc {
  v: 1;
  name: string;
  icon?: string;
  color?: string;
  notes?: string;
  /** when name/icon/color/notes last changed */
  metaAt: number;
  tabs: SharedTab[];
  /** URL → when it was removed; wins over an older add */
  removed: Record<string, number>;
  at: number;
  by: string;
}

export const emptyDoc = (name = ''): SharedDoc => ({ v: 1, name, metaAt: 0, tabs: [], removed: {}, at: 0, by: '' });

/** Only TLS transports: the broker must speak mqtts:// or wss://. Returns the problem, or null when fine. */
export function brokerProblem(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return 'not a URL';
  }
  if (u.protocol !== 'mqtts:' && u.protocol !== 'wss:') return 'only encrypted brokers are allowed: use mqtts:// or wss://';
  if (!u.hostname) return 'the broker URL has no host';
  return null;
}

export function topicFor(id: string): string {
  return `${TOPIC_ROOT}/${id}`;
}

const b64u = {
  encode(bytes: Uint8Array): string {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(text: string): Uint8Array<ArrayBuffer> | null {
    try {
      const s = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
      const out = new Uint8Array(new ArrayBuffer(s.length));
      for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
      return out;
    } catch {
      return null;
    }
  },
};

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export function newConnected(broker: string, now: number): ConnectedSpace {
  const id = hex(crypto.getRandomValues(new Uint8Array(12)));
  const key = b64u.encode(crypto.getRandomValues(new Uint8Array(32)));
  return { id, key, broker, since: now };
}

export function isConnectedSpace(v: unknown): v is ConnectedSpace {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  return typeof c.id === 'string' && /^[0-9a-f]{24}$/.test(c.id) && typeof c.key === 'string' && /^[\w-]{43}$/.test(c.key) && typeof c.broker === 'string' && brokerProblem(c.broker) === null && typeof c.since === 'number';
}

/** chord://join/?id=…&k=…&b=… */
export function joinLink(c: ConnectedSpace): string {
  const p = new URLSearchParams({ id: c.id, k: c.key, b: c.broker });
  return `chord://join/?${p}`;
}

export function parseJoinLink(link: string, now = Date.now()): ConnectedSpace | null {
  let u: URL;
  try {
    u = new URL(link.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'chord:' || u.hostname !== 'join') return null;
  const c = { id: u.searchParams.get('id') ?? '', key: u.searchParams.get('k') ?? '', broker: u.searchParams.get('b') ?? DEFAULT_BROKER, since: now };
  return isConnectedSpace(c) ? c : null;
}

// ---- the document ----

const groupNameOf = (s: State, sp: Space, tab: Tab): string | undefined => {
  if (!tab.groupId) return undefined;
  const g = sp.groups?.find((x) => x.id === tab.groupId);
  return g && !g.live ? g.name : undefined;
};

const isLiveMember = (sp: Space, tab: Tab): boolean => Boolean(tab.groupId && sp.groups?.some((g) => g.id === tab.groupId && g.live));

/** The pinned tabs a space shares: every pinned tab that is not filled in by a live folder. */
export function sharedTabsOf(s: State, sp: Space): Tab[] {
  return sp.pinned.map((id) => s.tabs[id]).filter((t): t is Tab => Boolean(t) && /^https?:/i.test(t.homeUrl ?? t.url) && !isLiveMember(sp, t));
}

const metaOf = (sp: Space) => ({ name: sp.name, icon: sp.icon, color: sp.color, notes: sp.notes || undefined });

/**
 * The document that describes the space as it is now. `prev` is the last document this member
 * knew: tabs keep their original add time, tabs that were in `prev` and are gone become
 * tombstones, metadata gets a new timestamp only when it changed.
 */
export function docFromSpace(s: State, sp: Space, prev: SharedDoc | undefined, now: number, by: string): SharedDoc {
  const before = new Map((prev?.tabs ?? []).map((t) => [t.url, t]));
  const tabs: SharedTab[] = [];
  const seen = new Set<string>();
  for (const t of sharedTabsOf(s, sp)) {
    const url = t.homeUrl ?? t.url;
    if (seen.has(url)) continue;
    seen.add(url);
    const old = before.get(url);
    const removedAt = prev?.removed[url] ?? 0;
    const at = old ? old.at : Math.max(now, removedAt + 1);
    const st: SharedTab = { url, title: (t.title || url).slice(0, 300), at };
    if (t.name) st.name = t.name.slice(0, 100);
    if (t.icon) st.icon = t.icon.slice(0, 8);
    const group = groupNameOf(s, sp, t);
    if (group) st.group = group.slice(0, 100);
    tabs.push(st);
  }
  const removed: Record<string, number> = { ...(prev?.removed ?? {}) };
  for (const [url, old] of before) if (!seen.has(url)) removed[url] = Math.max(now, old.at + 1);
  for (const url of seen) delete removed[url];
  const meta = metaOf(sp);
  const metaChanged = !prev || prev.name !== meta.name || prev.icon !== meta.icon || prev.color !== meta.color || (prev.notes ?? undefined) !== meta.notes;
  return prune({ v: 1, ...meta, metaAt: metaChanged ? now : prev.metaAt, tabs: tabs.slice(0, MAX_TABS), removed, at: now, by }, now);
}

function prune(doc: SharedDoc, now: number): SharedDoc {
  const entries = Object.entries(doc.removed).filter(([, at]) => now - at < TOMBSTONE_TTL).sort((a, b) => b[1] - a[1]).slice(0, MAX_TOMBSTONES);
  doc.removed = Object.fromEntries(entries);
  return doc;
}

/** Merge two documents: adds and removes both win by timestamp, metadata by last writer, order from the newer document. */
export function mergeDocs(a: SharedDoc, b: SharedDoc, now = Date.now()): SharedDoc {
  const [newer, older] = a.at >= b.at ? [a, b] : [b, a];
  const added = new Map<string, SharedTab>();
  for (const t of [...newer.tabs, ...older.tabs]) {
    const cur = added.get(t.url);
    if (!cur || t.at > cur.at) added.set(t.url, cur ? { ...t } : { ...t });
  }
  const removed: Record<string, number> = {};
  for (const src of [a.removed, b.removed]) for (const [url, at] of Object.entries(src)) if (typeof at === 'number' && at > (removed[url] ?? 0)) removed[url] = at;
  const tabs: SharedTab[] = [];
  const placed = new Set<string>();
  for (const t of [...newer.tabs, ...older.tabs]) {
    if (placed.has(t.url)) continue;
    placed.add(t.url);
    const best = added.get(t.url)!;
    if (best.at > (removed[t.url] ?? 0)) tabs.push(best);
  }
  for (const url of Object.keys(removed)) if (added.has(url) && added.get(url)!.at > removed[url]) delete removed[url];
  const metaSrc = a.metaAt >= b.metaAt ? a : b;
  return prune({ v: 1, name: metaSrc.name, icon: metaSrc.icon, color: metaSrc.color, notes: metaSrc.notes, metaAt: metaSrc.metaAt, tabs: tabs.slice(0, MAX_TABS), removed, at: Math.max(a.at, b.at), by: newer.by }, now);
}

/** Same content, ignoring who wrote it and when. */
export function sameDoc(a: SharedDoc, b: SharedDoc): boolean {
  const sig = (d: SharedDoc) => JSON.stringify([d.name, d.icon ?? '', d.color ?? '', d.notes ?? '', d.tabs.map((t) => [t.url, t.title, t.name ?? '', t.icon ?? '', t.group ?? '', t.at]), Object.entries(d.removed).sort()]);
  return sig(a) === sig(b);
}

/** Cheap fingerprint of what a space shares, to notice local edits. */
export function spaceSignature(s: State, sp: Space): string {
  return JSON.stringify([sp.name, sp.icon ?? '', sp.color, sp.notes ?? '', sharedTabsOf(s, sp).map((t) => [t.homeUrl ?? t.url, t.name ?? '', t.icon ?? '', groupNameOf(s, sp, t) ?? '', t.awake ? '' : t.title])]);
}

export function isSharedDoc(v: unknown): v is SharedDoc {
  if (typeof v !== 'object' || v === null) return false;
  const d = v as Record<string, unknown>;
  return d.v === 1 && typeof d.name === 'string' && typeof d.metaAt === 'number' && Array.isArray(d.tabs) && d.tabs.every((t) => typeof t === 'object' && t !== null && typeof (t as SharedTab).url === 'string' && typeof (t as SharedTab).at === 'number') && typeof d.removed === 'object' && d.removed !== null && typeof d.at === 'number';
}

/** Drop anything odd from a document that came over the wire. */
export function sanitizeDoc(d: SharedDoc): SharedDoc {
  const tabs: SharedTab[] = [];
  const seen = new Set<string>();
  for (const t of d.tabs) {
    if (!/^https?:\/\//i.test(t.url) || t.url.length > 2000 || seen.has(t.url)) continue;
    seen.add(t.url);
    const st: SharedTab = { url: t.url, title: String(t.title ?? '').slice(0, 300), at: t.at };
    if (typeof t.name === 'string' && t.name) st.name = t.name.slice(0, 100);
    if (typeof t.icon === 'string' && t.icon) st.icon = t.icon.slice(0, 8);
    if (typeof t.group === 'string' && t.group) st.group = t.group.slice(0, 100);
    tabs.push(st);
    if (tabs.length >= MAX_TABS) break;
  }
  const removed: Record<string, number> = {};
  for (const [url, at] of Object.entries(d.removed)) if (typeof at === 'number' && typeof url === 'string') removed[url] = at;
  return {
    v: 1,
    name: d.name.slice(0, 100),
    icon: typeof d.icon === 'string' && d.icon ? d.icon.slice(0, 8) : undefined,
    color: typeof d.color === 'string' && /^#[0-9a-f]{6}$/i.test(d.color) ? d.color : undefined,
    notes: typeof d.notes === 'string' && d.notes ? d.notes.slice(0, 50_000) : undefined,
    metaAt: d.metaAt,
    tabs,
    removed,
    at: d.at,
    by: typeof d.by === 'string' ? d.by.slice(0, 40) : '',
  };
}

// ---- sealing: AES-256-GCM with the key from the join link ----

async function importKey(key: string): Promise<CryptoKey | null> {
  const raw = b64u.decode(key);
  if (!raw || raw.length !== 32) return null;
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** iv (12 bytes) followed by the ciphertext; null when the key is malformed. */
export async function seal(key: string, value: unknown): Promise<Uint8Array | null> {
  const k = await importKey(key);
  if (!k) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, new TextEncoder().encode(JSON.stringify(value))));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return out;
}

/** The JSON value sealed with `key`, or null when the bytes are not ours or were tampered with. */
export async function unseal(key: string, bytes: Uint8Array): Promise<unknown | null> {
  if (bytes.length < 13) return null;
  const k = await importKey(key);
  if (!k) return null;
  try {
    const copy = new Uint8Array(new ArrayBuffer(bytes.length));
    copy.set(bytes);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: copy.subarray(0, 12) }, k, copy.subarray(12));
    return JSON.parse(new TextDecoder().decode(pt)) as unknown;
  } catch {
    return null;
  }
}
