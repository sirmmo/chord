// chord://panel — the side panel: the active space's mode views.

import type { AiStatus, Message, ModeId, ResearchStatus, Space, State } from '../shared/types.ts';
import { activeSpace } from '../shared/model.ts';
import { MODES } from '../shared/modes.ts';
import { hostOf } from '../shared/url.ts';
import { h } from './dom.ts';
import { applyTheme } from './theme.ts';

const api = window.chord;
const dispatch = (m: Message) => void api.dispatch(m);
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

let state: State | null = null;
let research: ResearchStatus | null = null;
let ai: AiStatus | null = null;
let shownSpace = '';
let shownMode: ModeId | 'none' = 'none';

api.onState((s) => {
  const prevSpace = state?.activeSpaceId;
  state = s;
  applyTheme(s.settings.theme, activeSpace(s));
  render();
  if (prevSpace !== s.activeSpaceId) void loadSpace();
});
api.getState().then((s) => {
  if (s) {
    state = s;
    applyTheme(s.settings.theme, activeSpace(s));
    render();
    void loadSpace();
  }
});
api.onResearch((r) => {
  if (state && r.spaceId === state.activeSpaceId) {
    research = r;
    renderResearch();
  }
});
api.onAi((a) => {
  if (state && a.spaceId === state.activeSpaceId) {
    ai = a;
    renderAi();
  }
});

async function loadSpace(): Promise<void> {
  if (!state) return;
  const id = state.activeSpaceId;
  const [r, a] = await Promise.all([api.getResearch(id), api.getAi(id)]);
  if (state.activeSpaceId !== id) return;
  research = r;
  ai = a;
  renderResearch();
  renderAi();
}

$('#close').onclick = () => dispatch({ type: 'panel.toggle', open: false });

function currentSpace(): Space | null {
  return state ? activeSpace(state) : null;
}

function render(): void {
  const sp = currentSpace();
  if (!sp) return;
  const modes = sp.modes ?? [];
  const mode: ModeId | 'none' = modes.length ? (sp.panelMode && modes.includes(sp.panelMode) ? sp.panelMode : modes[0]) : 'none';
  $('#modes').replaceChildren(
    ...MODES.filter((m) => modes.includes(m.id)).map((m) => h('button', { class: m.id === mode ? 'on' : '', onclick: () => dispatch({ type: 'panel.mode', mode: m.id }) }, m.name)),
  );
  for (const v of document.querySelectorAll<HTMLElement>('.view')) v.classList.toggle('on', v.id === `view-${mode}`);
  if (sp.id !== shownSpace || mode !== shownMode) {
    shownSpace = sp.id;
    shownMode = mode;
    if (mode === 'ai') $<HTMLTextAreaElement>('#ai-text').focus();
  }
}

// ---- research ----

const notes = $<HTMLTextAreaElement>('#r-notes');
let notesTimer = 0;
notes.addEventListener('input', () => {
  window.clearTimeout(notesTimer);
  notesTimer = window.setTimeout(() => {
    if (state) dispatch({ type: 'research.note', spaceId: state.activeSpaceId, text: notes.value });
  }, 400);
});
$('#r-zotero').onclick = () => dispatch({ type: 'research.zotero' });
$('#r-source').onclick = () => dispatch({ type: 'research.source' });
$('#r-clip').onclick = () => dispatch({ type: 'research.clip' });

function when(ts: number): string {
  return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function renderResearch(): void {
  const r = research;
  const sp = currentSpace();
  if (!r || !sp) return;
  if (document.activeElement !== notes && notes.value !== r.data.notes) notes.value = r.data.notes;
  $('#r-zotero-state').textContent = r.zotero.available ? 'Zotero is running: pages save to its current collection.' : 'Zotero not detected. Start Zotero (desktop) to save pages to it.';
  ($('#r-zotero') as HTMLButtonElement).disabled = !r.zotero.available;
  $('#r-clips').replaceChildren(
    ...r.data.clips.map((c) =>
      h(
        'div',
        { class: 'item' },
        h('div', { class: 'text' }, c.text),
        c.url ? h('a', { class: 'src', href: c.url, title: c.url, onclick: (e: MouseEvent) => { e.preventDefault(); dispatch({ type: 'tab.new', url: c.url }); } }, `${c.title || hostOf(c.url)} · ${when(c.at)}`) : h('span', { class: 'src' }, when(c.at)),
        h('button', { class: 'rm', title: 'Remove', onclick: () => dispatch({ type: 'research.remove', spaceId: sp.id, kind: 'clip', id: c.id }) }, '×'),
      ),
    ),
  );
  $('#r-sources').replaceChildren(
    ...r.data.sources.map((s) =>
      h(
        'div',
        { class: 'item' },
        h('a', { class: 'src', href: s.url, title: s.url, style: 'margin:0;font-size:13px;color:var(--fg)', onclick: (e: MouseEvent) => { e.preventDefault(); dispatch({ type: 'tab.new', url: s.url }); } }, s.title || s.url),
        h('span', { class: 'src' }, `${hostOf(s.url)} · ${when(s.at)}`, s.zotero ? h('span', { class: 'z' }, 'in Zotero') : ''),
        h('button', { class: 'rm', title: 'Remove', onclick: () => dispatch({ type: 'research.remove', spaceId: sp.id, kind: 'source', id: s.id }) }, '×'),
      ),
    ),
  );
}

// ---- ai ----

const aiText = $<HTMLTextAreaElement>('#ai-text');
const aiSend = $<HTMLButtonElement>('#ai-send');
const aiStop = $<HTMLButtonElement>('#ai-stop');
const aiMessages = $('#ai-messages');

function send(): void {
  const text = aiText.value.trim();
  if (!text || !state) return;
  dispatch({ type: 'ai.send', spaceId: state.activeSpaceId, text });
  aiText.value = '';
}
aiSend.onclick = send;
aiText.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
aiStop.onclick = () => state && dispatch({ type: 'ai.stop', spaceId: state.activeSpaceId });
$('#ai-clear').onclick = () => state && dispatch({ type: 'ai.clear', spaceId: state.activeSpaceId });
$('#ai-settings').onclick = () => dispatch({ type: 'settings.open', page: 'ai' });

/** Minimal markdown: fenced code, inline code, paragraphs. */
function richText(text: string): Node[] {
  const out: Node[] = [];
  const parts = text.split(/```(?:\w+)?\n?([\s\S]*?)```/g);
  parts.forEach((part, i) => {
    if (i % 2 === 1) out.push(h('pre', { class: 'code' }, part.replace(/\n$/, '')));
    else {
      const inline = part.split(/`([^`\n]+)`/g);
      inline.forEach((seg, k) => out.push(k % 2 === 1 ? h('code', {}, seg) : document.createTextNode(seg)));
    }
  });
  return out;
}

function renderAi(): void {
  const a = ai;
  if (!a) return;
  const keyNote = a.provider === 'anthropic' && !a.hasKey ? ' · no API key' : '';
  $('#ai-model').textContent = `${a.provider === 'anthropic' ? 'Anthropic' : 'OpenAI-compatible'} · ${a.model || 'no model'}${keyNote}`;
  $('#ai-error').textContent = a.error ?? '';
  aiStop.hidden = !a.busy;
  aiSend.hidden = a.busy;
  aiMessages.classList.toggle('busy', a.busy);
  const atBottom = aiMessages.scrollTop + aiMessages.clientHeight >= aiMessages.scrollHeight - 40;
  aiMessages.replaceChildren(
    ...a.messages.map((m) => {
      if (m.role === 'tool') {
        return h(
          'details',
          { class: `msg tool${m.tool?.error ? ' error' : ''}` },
          h('summary', {}, `${m.tool?.name ?? 'tool'}(${JSON.stringify(m.tool?.input ?? {}).slice(0, 80)})`),
          h('pre', {}, m.text),
        );
      }
      return h('div', { class: `msg ${m.role}` }, ...richText(m.text));
    }),
    a.busy ? h('div', { class: 'msg assistant' }, '…') : '',
  );
  if (atBottom) aiMessages.scrollTop = aiMessages.scrollHeight;
}
