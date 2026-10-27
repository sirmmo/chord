import { app, clipboard, shell } from 'electron';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { McpStatus } from '../shared/types.ts';
import { activeSpace, spaceById } from '../shared/model.ts';
import { hostOf } from '../shared/url.ts';
import type { Controller } from './controller.ts';

/**
 * A local MCP server (Streamable HTTP, JSON responses) so Claude Desktop and
 * other MCP clients can read and drive the browser: spaces, tabs, page text,
 * navigation, history, downloads and the tools pages expose through WebMCP.
 * Bound to 127.0.0.1, protected by a bearer token that lives in the profile
 * folder. Off by default.
 */

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BODY = 1_000_000;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export class McpManager {
  private readonly c: Controller;
  private server: Server | null = null;
  private token = '';
  status: McpStatus = { running: false, port: 0, token: '', clients: 0 };
  private readonly seen = new Set<string>();

  constructor(c: Controller) {
    this.c = c;
  }

  init(): void {
    this.token = this.loadToken();
    this.sync();
  }

  /** Start or stop according to the settings. */
  sync(): void {
    const { enabled, port } = this.c.state.settings.mcp;
    if (enabled && (!this.server || this.status.port !== port)) {
      this.stop();
      this.start(port);
    } else if (!enabled && this.server) {
      this.stop();
    } else {
      this.publish();
    }
  }

  private start(port: number): void {
    const server = createServer((req, res) => void this.handle(req, res));
    server.on('error', (err: NodeJS.ErrnoException) => {
      this.status = { ...this.status, running: false, error: err.code === 'EADDRINUSE' ? `port ${port} is in use` : err.message };
      this.server = null;
      this.publish();
    });
    server.listen(port, '127.0.0.1', () => {
      this.status = { running: true, port, token: this.token, clients: this.seen.size, error: undefined };
      this.publish();
    });
    this.server = server;
  }

  private stop(): void {
    this.server?.close();
    this.server = null;
    this.status = { ...this.status, running: false };
    this.publish();
  }

  private publish(): void {
    this.status = { ...this.status, token: this.token, clients: this.seen.size };
    this.c.sendAll('mcp', this.status);
  }

  regenerateToken(): void {
    this.token = randomBytes(24).toString('base64url');
    try {
      writeFileSync(this.tokenFile(), this.token, { mode: 0o600 });
    } catch {
      /* read-only profile */
    }
    this.seen.clear();
    this.publish();
  }

  private tokenFile(): string {
    return join(app.getPath('userData'), 'mcp-token');
  }

  private loadToken(): string {
    try {
      const t = readFileSync(this.tokenFile(), 'utf8').trim();
      if (/^[A-Za-z0-9_-]{20,}$/.test(t)) return t;
    } catch {
      /* first run */
    }
    const fresh = randomBytes(24).toString('base64url');
    try {
      writeFileSync(this.tokenFile(), fresh, { mode: 0o600 });
    } catch {
      /* read-only profile */
    }
    return fresh;
  }

  /** The Claude Desktop / mcp-remote configuration for this server. */
  configSnippet(): string {
    const url = `http://127.0.0.1:${this.c.state.settings.mcp.port}/mcp`;
    return JSON.stringify({ mcpServers: { chord: { command: 'npx', args: ['-y', 'mcp-remote', url, '--header', `Authorization: Bearer ${this.token}`] } } }, null, 2);
  }

  copyConfig(): void {
    clipboard.writeText(this.configSnippet());
  }

  openDocs(): void {
    void shell.openExternal('https://ingmmo.com/chord/#mcp');
  }

  // ---- HTTP ----

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    res.setHeader('Access-Control-Allow-Origin', 'null');
    if (url.pathname !== '/mcp') return end(res, 404, { error: 'not found' });
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) return end(res, 403, { error: 'origin not allowed' });
    const auth = req.headers.authorization ?? '';
    if (auth !== `Bearer ${this.token}`) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return end(res, 401, { error: 'bad token' });
    }
    if (req.method === 'GET') return end(res, 405, { error: 'no server-initiated stream; use POST' });
    if (req.method === 'DELETE') return end(res, 204);
    if (req.method !== 'POST') return end(res, 405, { error: 'method not allowed' });

    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return end(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    }
    const client = `${req.socket.remoteAddress ?? ''}:${req.headers['user-agent'] ?? ''}`;
    if (!this.seen.has(client)) {
      this.seen.add(client);
      this.publish();
    }
    const batch = Array.isArray(body) ? body : [body];
    const replies: unknown[] = [];
    for (const item of batch) {
      if (!isRequest(item)) {
        replies.push({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } });
        continue;
      }
      const reply = await this.rpc(item);
      if (reply !== undefined) replies.push(reply);
    }
    if (replies.length === 0) return end(res, 202);
    return end(res, 200, Array.isArray(body) ? replies : replies[0]);
  }

  private async rpc(req: JsonRpcRequest): Promise<unknown> {
    const { id, method, params = {} } = req;
    const ok = (result: unknown) => (id === undefined ? undefined : { jsonrpc: '2.0', id, result });
    const fail = (code: number, message: string) => (id === undefined ? undefined : { jsonrpc: '2.0', id, error: { code, message } });
    switch (method) {
      case 'initialize': {
        const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        return ok({
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'chord', version: app.getVersion() },
          instructions: 'Tools act on the Chord browser running on this computer. Tab and space ids come from list_spaces and list_tabs. Pages that expose WebMCP tools appear as page_<name> tools for the focused tab.',
        });
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return undefined;
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: this.tools() });
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : '';
        const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
        try {
          const result = await this.call(name, args);
          const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
          return ok({ content: [{ type: 'text', text }], isError: false });
        } catch (err) {
          return ok({ content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true });
        }
      }
      case 'resources/list':
      case 'prompts/list':
        return ok({ [method === 'resources/list' ? 'resources' : 'prompts']: [] });
      default:
        return fail(-32601, `method not found: ${method}`);
    }
  }

  // ---- tools ----

  private tools(): ToolSpec[] {
    const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, additionalProperties: false, ...(required.length ? { required } : {}) });
    const spaceArg = { spaceId: { type: 'string', description: 'id from list_spaces; omit for the active space' } };
    const out: ToolSpec[] = [
      { name: 'list_spaces', description: 'List the spaces (named sets of tabs) with their ids; the active one is marked. Private spaces that are locked are listed without tabs.', inputSchema: obj({}) },
      { name: 'list_tabs', description: 'List the tabs of a space with ids, titles, URLs and whether each is focused or awake.', inputSchema: obj(spaceArg) },
      { name: 'read_page', description: 'Read the visible text of a tab (the focused tab of the active space by default).', inputSchema: obj({ tabId: { type: 'string' } }) },
      { name: 'open_tab', description: 'Open a URL in a new tab and return its text.', inputSchema: obj({ url: { type: 'string' }, ...spaceArg, activate: { type: 'boolean', description: 'focus it (default true)' } }, ['url']) },
      { name: 'navigate', description: 'Navigate an existing tab to a URL and return its text.', inputSchema: obj({ tabId: { type: 'string' }, url: { type: 'string' } }, ['tabId', 'url']) },
      { name: 'activate_tab', description: 'Focus a tab (and its space).', inputSchema: obj({ tabId: { type: 'string' } }, ['tabId']) },
      { name: 'close_tab', description: 'Close a tab.', inputSchema: obj({ tabId: { type: 'string' } }, ['tabId']) },
      { name: 'fetch_url', description: 'Fetch a URL without opening it and return its text (HTML stripped).', inputSchema: obj({ url: { type: 'string' } }, ['url']) },
      { name: 'search_history', description: 'Search the browsing history.', inputSchema: obj({ query: { type: 'string' }, limit: { type: 'number' } }) },
      { name: 'list_downloads', description: 'List recent downloads with their state and file paths.', inputSchema: obj({}) },
    ];
    for (const t of this.c.ai.toolDefs(this.c.state.activeSpaceId)) {
      if (t.name.startsWith('page_')) out.push({ name: t.name, description: t.description, inputSchema: t.parameters });
    }
    return out;
  }

  private async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const s = this.c.state;
    const space = typeof args.spaceId === 'string' ? spaceById(s, args.spaceId) : activeSpace(s);
    if (!space) throw new Error('unknown space');
    switch (name) {
      case 'list_spaces':
        return s.spaces.map((sp) => ({ id: sp.id, name: sp.name, icon: sp.icon, active: sp.id === s.activeSpaceId, locked: Boolean(sp.locked), tabs: sp.locked ? undefined : sp.pinned.length + sp.today.length }));
      case 'list_tabs':
        if (space.locked) throw new Error('that space is locked');
        return [...space.pinned, ...space.today].map((id) => s.tabs[id]).filter(Boolean).map((t) => ({ id: t.id, title: t.title, url: t.url, host: hostOf(t.url), focused: space.focused === t.id, awake: t.awake, group: space.groups?.find((g) => g.id === t.groupId)?.name }));
      case 'activate_tab': {
        const id = String(args.tabId ?? '');
        if (!s.tabs[id]) throw new Error('unknown tab');
        this.c.apply({ type: 'tab.activate', id });
        return { ok: true };
      }
      case 'close_tab': {
        const id = String(args.tabId ?? '');
        if (!s.tabs[id]) throw new Error('unknown tab');
        this.c.apply({ type: 'tab.close', id });
        return { ok: true };
      }
      case 'search_history':
        return this.c.history.query({ query: typeof args.query === 'string' ? args.query : '', limit: typeof args.limit === 'number' ? args.limit : 50 });
      case 'list_downloads':
        return this.c.downloads.status().items.slice(0, 50).map((d) => ({ id: d.id, name: d.filename, url: d.url, state: d.state, path: d.path, received: d.received, total: d.total }));
      case 'open_tab':
        return (await this.c.ai.runToolFor(space.id, 'open_tab', { url: args.url, activate: args.activate !== false })).result;
      default:
        return (await this.c.ai.runToolFor(space.id, name, args)).result;
    }
  }
}

function isRequest(v: unknown): v is JsonRpcRequest {
  return typeof v === 'object' && v !== null && (v as JsonRpcRequest).jsonrpc === '2.0' && typeof (v as JsonRpcRequest).method === 'string';
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function end(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}
