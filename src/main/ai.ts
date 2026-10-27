import { app, ipcMain, net, safeStorage } from 'electron';
import Anthropic from '@anthropic-ai/sdk';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AiMessage, AiStatus, SpaceId, TabId, WebMcpTool } from '../shared/types.ts';
import { activeSpace, focusedTab, spaceById } from '../shared/model.ts';
import { hostOf } from '../shared/url.ts';
import { Store } from './store.ts';
import type { Controller } from './controller.ts';

const MAX_ITERATIONS = 8;
const MAX_TOOL_OUTPUT = 20_000;
const MAX_HISTORY = 60;
const SYSTEM = `You are the assistant built into Chord, a web browser. You help the user with the tabs of the current space.
You have tools to list the space's tabs, read a page's text, open and navigate tabs, and fetch URLs. Pages may also expose their own tools (names starting with "page_"); use them when they fit the request.
Be concise. Quote the page when you rely on it. Never invent page content: read it first.`;

interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const EXTRACT_JS = `(() => {
  const main = document.querySelector('main, article, [role="main"]') || document.body;
  const text = (main && main.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim();
  return { title: document.title, url: location.href, text: text.slice(0, 60000), truncated: text.length > 60000 };
})()`;

/**
 * AI mode: a chat per space with a model of the user's choice — Anthropic
 * through the official SDK, or any OpenAI-compatible endpoint (Ollama, LM
 * Studio, OpenRouter, …) — that can read and act on the space's tabs and call
 * the tools pages expose through WebMCP.
 */
export class AiManager {
  private readonly c: Controller;
  private readonly keyStore: Store<{ key: string }>;
  private readonly chatStore: Store<Record<SpaceId, AiMessage[]>>;
  private chats: Record<SpaceId, AiMessage[]> = {};
  private busy = new Map<SpaceId, AbortController>();
  private errors = new Map<SpaceId, string>();
  private encryptedKey = '';
  private pendingCalls = new Map<string, { resolve: (v: unknown) => void; timer: NodeJS.Timeout }>();

  constructor(c: Controller) {
    this.c = c;
    this.keyStore = new Store(join(app.getPath('userData'), 'ai-key.json'));
    this.chatStore = new Store(join(app.getPath('userData'), 'ai-chats.json'));
  }

  init(): void {
    const k = this.keyStore.load() as { key?: string } | null;
    if (k && typeof k.key === 'string') this.encryptedKey = k.key;
    const chats = this.chatStore.load();
    if (chats && typeof chats === 'object') this.chats = chats as Record<SpaceId, AiMessage[]>;
    ipcMain.handle('ai', (event, spaceId: unknown) => (this.c.trustedEvent(event) && typeof spaceId === 'string' ? this.status(spaceId) : null));
  }

  status(spaceId: SpaceId): AiStatus {
    const { ai } = this.c.state.settings;
    return { spaceId, messages: this.chats[spaceId] ?? [], busy: this.busy.has(spaceId), error: this.errors.get(spaceId), hasKey: this.hasKey(), provider: ai.provider, model: ai.model };
  }

  hasKey(): boolean {
    return Boolean(this.encryptedKey);
  }

  setKey(key: string): void {
    this.encryptedKey = key && safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(key).toString('base64') : '';
    this.keyStore.save({ key: this.encryptedKey });
    this.push(this.c.state.activeSpaceId);
  }

  private key(): string {
    if (!this.encryptedKey) return '';
    try {
      return safeStorage.decryptString(Buffer.from(this.encryptedKey, 'base64'));
    } catch {
      return '';
    }
  }

  clear(spaceId: SpaceId): void {
    this.stop(spaceId);
    this.chats[spaceId] = [];
    this.errors.delete(spaceId);
    this.chatStore.save(this.chats);
    this.push(spaceId);
  }

  stop(spaceId: SpaceId): void {
    this.busy.get(spaceId)?.abort();
  }

  async test(): Promise<void> {
    const sid = this.c.state.activeSpaceId;
    this.errors.delete(sid);
    try {
      const reply = await this.complete([{ role: 'user', content: 'Reply with the single word OK.' }], [], new AbortController().signal);
      this.errors.set(sid, `Connection works: “${reply.text.trim().slice(0, 40)}”`);
    } catch (err) {
      this.errors.set(sid, `Connection failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.push(sid);
  }

  /** The user sent a message: run the model with tools until it answers. */
  async send(spaceId: SpaceId, text: string): Promise<void> {
    if (!text.trim() || this.busy.has(spaceId)) return;
    const history = (this.chats[spaceId] ??= []);
    history.push({ id: randomUUID(), role: 'user', text: text.trim(), at: Date.now() });
    const abort = new AbortController();
    this.busy.set(spaceId, abort);
    this.errors.delete(spaceId);
    this.push(spaceId);
    try {
      const transcript: ChatTurn[] = [];
      for (const m of history.slice(-MAX_HISTORY)) {
        if (m.role === 'user') transcript.push({ role: 'user', content: m.text });
        else if (m.role === 'assistant') transcript.push({ role: 'assistant', content: m.text });
      }
      let tools = this.tools(spaceId);
      for (let i = 0; i < MAX_ITERATIONS; i++) {
        const reply = await this.complete(transcript, tools, abort.signal);
        if (reply.text.trim()) history.push({ id: randomUUID(), role: 'assistant', text: reply.text.trim(), at: Date.now() });
        if (reply.calls.length === 0) break;
        transcript.push({ role: 'assistant', content: reply.text, calls: reply.calls });
        const results: ToolResult[] = [];
        for (const call of reply.calls) {
          const r = await this.runTool(spaceId, call.name, call.input).catch((e: Error) => ({ error: e.message }));
          const output = 'error' in r ? `Error: ${r.error}` : typeof r.result === 'string' ? r.result : JSON.stringify(r.result);
          history.push({ id: randomUUID(), role: 'tool', text: output.slice(0, 2000), tool: { name: call.name, input: call.input, error: 'error' in r }, at: Date.now() });
          results.push({ id: call.id, name: call.name, output: output.slice(0, MAX_TOOL_OUTPUT), error: 'error' in r });
          this.push(spaceId);
        }
        transcript.push({ role: 'tool', results });
        tools = this.tools(spaceId); // page tools may have changed after navigation
      }
    } catch (err) {
      if (!abort.signal.aborted) this.errors.set(spaceId, err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.delete(spaceId);
      if (history.length > MAX_HISTORY * 2) history.splice(0, history.length - MAX_HISTORY * 2);
      this.chatStore.save(this.chats);
      this.push(spaceId);
    }
  }

  private push(spaceId: SpaceId): void {
    this.c.sendAll('ai', this.status(spaceId));
  }

  // ---- tools ----

  private tools(spaceId: SpaceId): ToolDef[] {
    const base: ToolDef[] = [
      { name: 'list_tabs', description: 'List the tabs of the current space with their ids, titles and URLs. The focused tab is marked.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
      { name: 'read_page', description: 'Read the visible text of a tab (the focused one by default). Returns title, URL and text.', parameters: { type: 'object', properties: { tabId: { type: 'string', description: 'id from list_tabs; omit for the focused tab' } }, additionalProperties: false } },
      { name: 'open_tab', description: 'Open a URL in a new tab of the space and focus it.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false } },
      { name: 'navigate', description: 'Navigate an existing tab to a URL.', parameters: { type: 'object', properties: { tabId: { type: 'string' }, url: { type: 'string' } }, required: ['tabId', 'url'], additionalProperties: false } },
      { name: 'fetch_url', description: 'Fetch a URL without opening it and return its text content (HTML stripped).', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false } },
    ];
    const tab = focusedTab(this.c.state);
    const pageTools = tab ? (this.c.smart.getStatus()[tab.id]?.tools ?? []) : [];
    for (const t of pageTools.slice(0, 30)) {
      const schema = t.inputSchema && typeof t.inputSchema === 'object' ? (t.inputSchema as Record<string, unknown>) : { type: 'object', properties: {} };
      base.push({ name: `page_${t.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50)}`, description: `[Tool of the page ${hostOf(tab!.url)}] ${t.description}`.slice(0, 1000), parameters: schema });
    }
    return base;
  }

  private async runTool(spaceId: SpaceId, name: string, input: unknown): Promise<{ result: unknown }> {
    const args = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
    const space = spaceById(this.c.state, spaceId) ?? activeSpace(this.c.state);
    const tabsOf = () => [...space.pinned, ...space.today].map((id) => this.c.state.tabs[id]).filter(Boolean);
    switch (name) {
      case 'list_tabs':
        return { result: tabsOf().map((t) => ({ id: t.id, title: t.title, url: t.url, focused: space.focused === t.id, awake: t.awake })) };
      case 'read_page': {
        const id = typeof args.tabId === 'string' ? args.tabId : (space.focused ?? '');
        return { result: await this.readTab(id) };
      }
      case 'open_tab': {
        const url = String(args.url ?? '');
        if (!/^https?:\/\//i.test(url)) throw new Error('url must be http(s)');
        const id = randomUUID();
        this.c.apply({ type: 'tab.new', url, spaceId: space.id, id, activate: true });
        await this.settle(id);
        return { result: { tabId: id, ...(await this.readTab(id, 4000)) } };
      }
      case 'navigate': {
        const url = String(args.url ?? '');
        const id = String(args.tabId ?? '');
        if (!/^https?:\/\//i.test(url)) throw new Error('url must be http(s)');
        if (!this.c.state.tabs[id]) throw new Error('unknown tab');
        this.c.dispatch({ type: 'tab.navigate', url, id });
        await this.settle(id);
        return { result: await this.readTab(id, 4000) };
      }
      case 'fetch_url': {
        const url = String(args.url ?? '');
        if (!/^https?:\/\//i.test(url)) throw new Error('url must be http(s)');
        const res = await net.fetch(url, { signal: AbortSignal.timeout(15_000), headers: { Accept: 'text/html, text/plain;q=0.9, */*;q=0.1' } });
        const body = (await res.text()).slice(0, 2_000_000);
        const text = body
          .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/\s{2,}/g, ' ')
          .trim();
        return { result: { status: res.status, text: text.slice(0, MAX_TOOL_OUTPUT) } };
      }
      default: {
        if (!name.startsWith('page_')) throw new Error(`unknown tool ${name}`);
        const tab = focusedTab(this.c.state);
        if (!tab) throw new Error('no focused page');
        const real = (this.c.smart.getStatus()[tab.id]?.tools ?? []).find((t) => `page_${t.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50)}` === name);
        if (!real) throw new Error('the page no longer offers this tool');
        return { result: await this.callPageTool(tab.id, real.name, args) };
      }
    }
  }

  private async readTab(id: TabId, limit = 15_000): Promise<{ title: string; url: string; text: string; truncated?: boolean }> {
    const tab = this.c.state.tabs[id];
    if (!tab) throw new Error('unknown tab');
    let wc = this.c.tabs.get(id)?.webContents;
    if (!wc || wc.isDestroyed()) {
      this.c.apply({ type: 'tab.activate', id });
      await this.settle(id);
      wc = this.c.tabs.get(id)?.webContents;
    }
    if (!wc || wc.isDestroyed()) throw new Error('page is not available');
    const r = (await wc.executeJavaScript(EXTRACT_JS)) as { title: string; url: string; text: string; truncated: boolean };
    return { title: r.title, url: r.url, text: r.text.slice(0, limit), truncated: r.truncated || r.text.length > limit };
  }

  /** Wait until a tab's page finished loading (or 12 s). */
  private settle(id: TabId): Promise<void> {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        const wc = this.c.tabs.get(id)?.webContents;
        if (wc && !wc.isDestroyed() && !wc.isLoading() && Date.now() - start > 300) return resolve();
        if (Date.now() - start > 12_000) return resolve();
        setTimeout(tick, 150);
      };
      setTimeout(tick, 300);
    });
  }

  /** Execute a WebMCP tool in the page's main world through the bridge. */
  private callPageTool(tabId: TabId, name: string, args: Record<string, unknown>): Promise<unknown> {
    const wc = this.c.tabs.get(tabId)?.webContents;
    if (!wc || wc.isDestroyed()) return Promise.reject(new Error('page is not available'));
    const callId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCalls.delete(callId);
        reject(new Error('the page tool did not answer in time'));
      }, 30_000);
      this.pendingCalls.set(callId, { resolve, timer });
      wc.send('smart:action', `webmcp:${JSON.stringify({ callId, name, args })}`);
    });
  }

  /** Result of a page tool call, forwarded by SmartManager. */
  resolvePageTool(callId: string, result: unknown, error?: string): void {
    const p = this.pendingCalls.get(callId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pendingCalls.delete(callId);
    p.resolve(error ? { error } : result);
  }

  // ---- providers ----

  private async complete(transcript: ChatTurn[], tools: ToolDef[], signal: AbortSignal): Promise<{ text: string; calls: ToolCall[] }> {
    const { ai } = this.c.state.settings;
    return ai.provider === 'anthropic' ? this.completeAnthropic(transcript, tools, signal) : this.completeOpenAi(transcript, tools, signal);
  }

  private async completeAnthropic(transcript: ChatTurn[], tools: ToolDef[], signal: AbortSignal): Promise<{ text: string; calls: ToolCall[] }> {
    const apiKey = this.key();
    if (!apiKey) throw new Error('No API key: add one in Settings → AI.');
    const client = new Anthropic({ apiKey, maxRetries: 1 });
    const model = this.c.state.settings.ai.model || 'claude-opus-5-5';
    const messages: Anthropic.Beta.BetaMessageParam[] = [];
    for (const t of transcript) {
      if (t.role === 'user') messages.push({ role: 'user', content: t.content });
      else if (t.role === 'assistant') {
        const content: Anthropic.Beta.BetaContentBlockParam[] = [];
        if (t.content.trim()) content.push({ type: 'text', text: t.content });
        for (const call of t.calls ?? []) content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
        if (content.length) messages.push({ role: 'assistant', content });
      } else {
        messages.push({ role: 'user', content: t.results.map((r): Anthropic.Beta.BetaToolResultBlockParam => ({ type: 'tool_result', tool_use_id: r.id, content: r.output, is_error: r.error || undefined })) });
      }
    }
    const response = await client.beta.messages.create(
      {
        model,
        max_tokens: 16000,
        system: SYSTEM,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        tools: tools.map((t): Anthropic.Beta.BetaTool => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Beta.BetaTool['input_schema'] })),
        messages,
      },
      { signal },
    );
    if (response.stop_reason === 'refusal') throw new Error(`The model declined (${response.stop_details?.category ?? 'safety'}).`);
    let text = '';
    const calls: ToolCall[] = [];
    for (const block of response.content) {
      if (block.type === 'text') text += block.text;
      else if (block.type === 'tool_use') calls.push({ id: block.id, name: block.name, input: block.input });
    }
    return { text, calls };
  }

  private async completeOpenAi(transcript: ChatTurn[], tools: ToolDef[], signal: AbortSignal): Promise<{ text: string; calls: ToolCall[] }> {
    const { ai } = this.c.state.settings;
    const base = (ai.baseUrl || 'http://localhost:11434/v1').replace(/\/+$/, '');
    const messages: Record<string, unknown>[] = [{ role: 'system', content: SYSTEM }];
    for (const t of transcript) {
      if (t.role === 'user') messages.push({ role: 'user', content: t.content });
      else if (t.role === 'assistant') {
        messages.push({
          role: 'assistant',
          content: t.content || null,
          ...(t.calls && t.calls.length ? { tool_calls: t.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } })) } : {}),
        });
      } else for (const r of t.results) messages.push({ role: 'tool', tool_call_id: r.id, content: r.output });
    }
    const key = this.key();
    const res = await net.fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({
        model: ai.model,
        messages,
        ...(tools.length ? { tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })), tool_choice: 'auto' } : {}),
      }),
      signal,
    });
    if (!res.ok) throw new Error(`${hostOf(base) || base} answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string | null; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] } }[] };
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error('empty answer from the model');
    const calls: ToolCall[] = [];
    for (const tc of msg.tool_calls ?? []) {
      let input: unknown = {};
      try {
        input = JSON.parse(tc.function?.arguments || '{}');
      } catch {
        input = {};
      }
      calls.push({ id: tc.id ?? randomUUID(), name: tc.function?.name ?? '', input });
    }
    return { text: msg.content ?? '', calls };
  }

  flush(): void {
    this.chatStore.flush();
  }
}

interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}
interface ToolResult {
  id: string;
  name: string;
  output: string;
  error: boolean;
}
type ChatTurn = { role: 'user'; content: string } | { role: 'assistant'; content: string; calls?: ToolCall[] } | { role: 'tool'; results: ToolResult[] };

export type { WebMcpTool };
