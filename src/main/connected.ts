import { app, ipcMain } from 'electron';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { connect, type IClientOptions, type MqttClient } from 'mqtt';
import type { ConnectedStatus, Space, SpaceId, State } from '../shared/types.ts';
import { brokerProblem, docFromSpace, isSharedDoc, mergeDocs, sameDoc, sanitizeDoc, seal, spaceSignature, topicFor, unseal, type SharedDoc } from '../shared/connected.ts';
import { Store } from './store.ts';
import type { Controller } from './controller.ts';

/**
 * Connected spaces: every member's Chord keeps a sealed copy of the space's document on the
 * broker (a retained message per space) and announces itself with a heartbeat. Documents merge
 * (see shared/connected.ts), so members changing the space at the same time all keep their
 * changes. One MQTT client per broker; TLS is required by brokerProblem().
 */

interface File {
  clientId: string;
  docs: Record<SpaceId, SharedDoc>;
}

interface Link {
  client: MqttClient;
  key: string;
  state: 'connecting' | 'online' | 'offline' | 'error';
  error?: string;
  topics: Set<string>;
}

const HEARTBEAT_MS = 60_000;
const PEER_TTL = 150_000;
const PUBLISH_DELAY = 600;

export class ConnectedManager {
  private readonly c: Controller;
  private readonly store: Store<File>;
  private clientId = '';
  private docs: Record<SpaceId, SharedDoc> = {};
  private links = new Map<string, Link>();
  private peers = new Map<string, Map<string, number>>();
  private signatures = new Map<SpaceId, string>();
  private publishTimers = new Map<SpaceId, NodeJS.Timeout>();
  private lastSync = new Map<SpaceId, number>();
  private heartbeat: NodeJS.Timeout | null = null;
  private statusTimer: NodeJS.Timeout | null = null;

  constructor(c: Controller) {
    this.c = c;
    this.store = new Store(join(app.getPath('userData'), 'connected.json'));
  }

  init(): void {
    const raw = this.store.load() as Partial<File> | null;
    this.clientId = raw && typeof raw.clientId === 'string' && /^[\w-]{8,40}$/.test(raw.clientId) ? raw.clientId : randomUUID().replace(/-/g, '').slice(0, 20);
    if (raw && typeof raw.docs === 'object' && raw.docs) for (const [id, d] of Object.entries(raw.docs)) if (isSharedDoc(d)) this.docs[id] = sanitizeDoc(d);
    this.persist();
    ipcMain.handle('connected', (event) => (this.c.trustedEvent(event) ? this.status() : null));
    for (const sp of this.spaces()) this.signatures.set(sp.id, spaceSignature(this.c.state, sp));
    this.sync();
    this.heartbeat = setInterval(() => this.tick(), HEARTBEAT_MS);
    this.heartbeat.unref();
    app.on('before-quit', () => this.shutdown());
  }

  private persist(): void {
    this.store.save({ clientId: this.clientId, docs: this.docs });
  }

  /** Connected spaces that may talk: not private. */
  private spaces(s: State = this.c.state): Space[] {
    return s.spaces.filter((sp) => sp.connected && !sp.lock);
  }

  private linkKey(broker: string): string {
    const m = this.c.state.settings.mqtt;
    return `${broker}|${m.username ?? ''}|${m.password ?? ''}`;
  }

  status(): ConnectedStatus {
    const out: ConnectedStatus = { spaces: {} };
    for (const sp of this.spaces()) {
      const link = this.links.get(this.linkKey(sp.connected!.broker));
      const seen = this.peers.get(sp.connected!.id);
      const now = Date.now();
      let peers = 0;
      if (seen) for (const [cid, at] of seen) if (cid !== this.clientId && now - at < PEER_TTL) peers++;
      out.spaces[sp.id] = { state: link?.state ?? 'offline', peers, error: link?.error, lastSync: this.lastSync.get(sp.id) ?? 0, broker: sp.connected!.broker };
    }
    return out;
  }

  private broadcast(): void {
    if (this.statusTimer) return;
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      this.c.sendAll('connected', this.status());
    }, 50);
  }

  /** Called after every state change. */
  diff(prev: State, next: State): void {
    if (prev.settings.mqtt !== next.settings.mqtt && JSON.stringify(prev.settings.mqtt) !== JSON.stringify(next.settings.mqtt)) {
      this.reconnect();
      return;
    }
    const before = new Set(this.spaces(prev).map((sp) => `${sp.id}:${sp.connected!.id}`));
    const after = new Set(this.spaces(next).map((sp) => `${sp.id}:${sp.connected!.id}`));
    let membership = before.size !== after.size;
    for (const k of after) if (!before.has(k)) membership = true;
    if (membership) {
      // spaces that left: say goodbye and forget their document
      for (const sp of this.spaces(prev)) {
        if (after.has(`${sp.id}:${sp.connected!.id}`)) continue;
        void this.publishPresence(sp.connected!.broker, sp.connected!.id, sp.connected!.key, false);
        delete this.docs[sp.id];
        this.signatures.delete(sp.id);
        this.peers.delete(sp.connected!.id);
      }
      this.persist();
      this.sync();
    }
    for (const sp of this.spaces(next)) {
      const sig = spaceSignature(next, sp);
      if (this.signatures.get(sp.id) === sig) continue;
      this.signatures.set(sp.id, sig);
      this.schedulePublish(sp.id);
    }
  }

  reconnect(): void {
    for (const link of this.links.values()) link.client.end(true);
    this.links.clear();
    this.sync();
  }

  /** Open the clients the connected spaces need, subscribe to their topics, drop what is no longer needed. */
  sync(): void {
    const wanted = new Map<string, { broker: string; topics: Set<string> }>();
    for (const sp of this.spaces()) {
      const k = this.linkKey(sp.connected!.broker);
      const w = wanted.get(k) ?? { broker: sp.connected!.broker, topics: new Set<string>() };
      w.topics.add(topicFor(sp.connected!.id));
      wanted.set(k, w);
    }
    for (const [k, link] of this.links) {
      const w = wanted.get(k);
      if (!w) {
        link.client.end(true);
        this.links.delete(k);
        continue;
      }
      for (const t of link.topics) if (!w.topics.has(t)) {
        link.client.unsubscribe(`${t}/#`);
        link.topics.delete(t);
      }
      for (const t of w.topics) if (!link.topics.has(t)) {
        link.topics.add(t);
        if (link.state === 'online') link.client.subscribe(`${t}/#`, { qos: 1 });
      }
    }
    for (const [k, w] of wanted) if (!this.links.has(k)) this.open(k, w.broker, w.topics);
    this.broadcast();
  }

  private open(key: string, broker: string, topics: Set<string>): void {
    const problem = brokerProblem(broker);
    if (problem) {
      this.links.set(key, { client: connectNever(), key, state: 'error', error: problem, topics });
      return;
    }
    const m = this.c.state.settings.mqtt;
    const opts: IClientOptions = {
      clientId: `chord-${this.clientId}`,
      clean: true,
      keepalive: 60,
      reconnectPeriod: 5000,
      connectTimeout: 15_000,
      protocolVersion: 4,
      rejectUnauthorized: true,
      resubscribe: true,
    };
    if (m.username) opts.username = m.username;
    if (m.password) opts.password = m.password;
    const client = connect(broker, opts);
    const link: Link = { client, key, state: 'connecting', topics: new Set(topics) };
    this.links.set(key, link);
    client.on('connect', () => {
      link.state = 'online';
      link.error = undefined;
      for (const t of link.topics) client.subscribe(`${t}/#`, { qos: 1 });
      // say hello, and put our copy of each space on the broker in case nothing is there yet
      for (const sp of this.spaces()) {
        if (this.linkKey(sp.connected!.broker) !== key) continue;
        void this.publishPresence(sp.connected!.broker, sp.connected!.id, sp.connected!.key, true);
        setTimeout(() => void this.publish(sp.id, true), 1500).unref();
      }
      this.broadcast();
    });
    client.on('reconnect', () => {
      link.state = 'connecting';
      this.broadcast();
    });
    client.on('close', () => {
      if (link.state !== 'error') link.state = 'offline';
      this.broadcast();
    });
    client.on('error', (err) => {
      link.state = 'error';
      link.error = err.message;
      this.broadcast();
    });
    client.on('message', (topic, payload) => void this.onMessage(topic, payload));
  }

  private schedulePublish(spaceId: SpaceId): void {
    const t = this.publishTimers.get(spaceId);
    if (t) clearTimeout(t);
    this.publishTimers.set(spaceId, setTimeout(() => {
      this.publishTimers.delete(spaceId);
      void this.publish(spaceId, false);
    }, PUBLISH_DELAY));
  }

  /** Put the space's current document on the broker; `force` sends it even when nothing changed. */
  private async publish(spaceId: SpaceId, force: boolean): Promise<void> {
    const sp = this.spaces().find((x) => x.id === spaceId);
    if (!sp?.connected) return;
    const doc = docFromSpace(this.c.state, sp, this.docs[spaceId], Date.now(), this.clientId);
    const prev = this.docs[spaceId];
    if (!force && prev && sameDoc(prev, doc)) return;
    this.docs[spaceId] = doc;
    this.persist();
    await this.send(sp.connected.broker, `${topicFor(sp.connected.id)}/state`, sp.connected.key, doc, true);
  }

  private async send(broker: string, topic: string, key: string, value: unknown, retain: boolean): Promise<void> {
    const link = this.links.get(this.linkKey(broker));
    if (!link || link.state !== 'online') return;
    const bytes = await seal(key, value);
    if (!bytes) return;
    link.client.publish(topic, Buffer.from(bytes), { qos: 1, retain }, () => {});
  }

  private async publishPresence(broker: string, id: string, key: string, present: boolean): Promise<void> {
    const link = this.links.get(this.linkKey(broker));
    if (!link || link.state !== 'online') return;
    const topic = `${topicFor(id)}/p/${this.clientId}`;
    if (!present) {
      link.client.publish(topic, Buffer.alloc(0), { qos: 1, retain: true }, () => {});
      return;
    }
    await this.send(broker, topic, key, { at: Date.now() }, true);
  }

  private async onMessage(topic: string, payload: Buffer): Promise<void> {
    const m = /^chord\/v1\/([0-9a-f]{24})\/(state|p\/([\w-]{1,40}))$/.exec(topic);
    if (!m) return;
    const sp = this.spaces().find((x) => x.connected!.id === m[1]);
    if (!sp?.connected) return;
    if (m[2] !== 'state') {
      const cid = m[3];
      const seen = this.peers.get(m[1]) ?? new Map<string, number>();
      this.peers.set(m[1], seen);
      if (payload.length === 0) seen.delete(cid);
      else {
        const v = (await unseal(sp.connected.key, new Uint8Array(payload))) as { at?: number } | null;
        if (v && typeof v.at === 'number') seen.set(cid, Math.min(v.at, Date.now()));
      }
      this.broadcast();
      return;
    }
    if (payload.length === 0) return;
    const raw = await unseal(sp.connected.key, new Uint8Array(payload));
    if (!isSharedDoc(raw)) return;
    const remote = sanitizeDoc(raw);
    const now = Date.now();
    const local = this.docs[sp.id] ?? docFromSpace(this.c.state, sp, undefined, now, this.clientId);
    const merged = mergeDocs(local, remote, now);
    this.lastSync.set(sp.id, now);
    if (!sameDoc(merged, local)) {
      this.docs[sp.id] = merged;
      this.c.apply({ type: 'space.connectedSync', id: sp.id, doc: merged });
      // the space now matches the merged document: remember its fingerprint so the apply above does not republish
      const after = this.c.state.spaces.find((x) => x.id === sp.id);
      if (after) this.signatures.set(sp.id, spaceSignature(this.c.state, after));
      this.docs[sp.id] = docFromSpace(this.c.state, after ?? sp, merged, now, this.clientId);
    } else this.docs[sp.id] = merged;
    this.persist();
    // when the merge added something the sender did not have, put the result on the broker so everyone converges
    if (!sameDoc(merged, remote)) await this.send(sp.connected.broker, `${topicFor(sp.connected.id)}/state`, sp.connected.key, this.docs[sp.id], true);
    this.broadcast();
  }

  private tick(): void {
    const now = Date.now();
    for (const sp of this.spaces()) void this.publishPresence(sp.connected!.broker, sp.connected!.id, sp.connected!.key, true);
    for (const seen of this.peers.values()) for (const [cid, at] of seen) if (now - at > PEER_TTL * 2) seen.delete(cid);
    this.broadcast();
  }

  private shutdown(): void {
    for (const sp of this.spaces()) void this.publishPresence(sp.connected!.broker, sp.connected!.id, sp.connected!.key, false);
    if (this.heartbeat) clearInterval(this.heartbeat);
    setTimeout(() => {
      for (const link of this.links.values()) link.client.end(true);
    }, 300).unref();
  }
}

/** A placeholder client for a broker URL we refuse to talk to. */
function connectNever(): MqttClient {
  return { end() {}, subscribe() {}, unsubscribe() {}, publish() {}, on() {} } as unknown as MqttClient;
}
