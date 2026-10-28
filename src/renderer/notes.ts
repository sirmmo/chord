// chord://notes — a space's notes in Markdown, or every space's notes at once.

import type { Message, State } from '../shared/types.ts';
import { activeSpace } from '../shared/model.ts';
import { renderMarkdown } from '../shared/markdown.ts';
import { h } from './dom.ts';
import { applyTheme } from './theme.ts';

const api = window.chord;
const dispatch = (m: Message) => void api.dispatch(m);
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

const params = new URLSearchParams(location.search);
let spaceId: string | null = params.get('space') && params.get('space') !== 'all' ? params.get('space') : null;
let state: State | null = null;
let mode: 'split' | 'edit' | 'view' = 'split';
const text = $<HTMLTextAreaElement>('#text');
const preview = $('#preview');
let saveTimer = 0;
let dirty = false;

try {
  const m = localStorage.getItem('notes-mode');
  if (m === 'edit' || m === 'view' || m === 'split') mode = m;
} catch {
  /* no storage */
}

api.onState((s) => {
  state = s;
  applyTheme(s.settings.theme, activeSpace(s));
  render();
});
void api.getState().then((s) => {
  if (!s) return;
  state = s;
  if (!spaceId && !params.has('space')) spaceId = s.activeSpaceId; // opened without a space: this one
  applyTheme(s.settings.theme, activeSpace(s));
  render();
});

$('#mode').querySelectorAll('button').forEach((b) => (b.onclick = () => {
  mode = (b.dataset.v as typeof mode) ?? 'split';
  try {
    localStorage.setItem('notes-mode', mode);
  } catch {
    /* no storage */
  }
  render();
}));
$('#insert-link').onclick = () => {
  if (!state || !spaceId) return;
  const sp = state.spaces.find((x) => x.id === spaceId) ?? activeSpace(state);
  const tab = sp.focused ? state.tabs[sp.focused] : null;
  const current = tab && !tab.url.startsWith('chord://') ? tab : Object.values(state.tabs).find((t) => t.spaceId === spaceId && !t.url.startsWith('chord://') && t.awake);
  if (!current) return;
  const link = `[${current.title || current.url}](${current.url})`;
  const start = text.selectionStart;
  text.setRangeText(link, start, text.selectionEnd, 'end');
  text.focus();
  onInput();
};
const pick = $<HTMLSelectElement>('#space-pick');
pick.onchange = () => {
  spaceId = pick.value || null;
  history.replaceState(null, '', spaceId ? `?space=${encodeURIComponent(spaceId)}` : '?space=all');
  render();
};

function onInput(): void {
  dirty = true;
  preview.innerHTML = renderMarkdown(text.value);
  $('#saved').textContent = 'Editing…';
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(save, 500);
}
function save(): void {
  if (!dirty || !spaceId) return;
  dirty = false;
  dispatch({ type: 'space.notes', id: spaceId, text: text.value });
  $('#saved').textContent = `Saved ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}
text.addEventListener('input', onInput);
text.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    text.setRangeText('  ', text.selectionStart, text.selectionEnd, 'end');
    onInput();
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    save();
  }
});
window.addEventListener('blur', save);
window.addEventListener('beforeunload', save);
preview.addEventListener('click', (e) => {
  const a = (e.target as Element).closest('a[href]') as HTMLAnchorElement | null;
  if (!a || !/^https?:/i.test(a.href)) return;
  e.preventDefault();
  dispatch({ type: 'tab.new', url: a.href, activate: !(e.metaKey || e.ctrlKey) });
});

function render(): void {
  if (!state) return;
  const spaces = state.spaces.filter((sp) => !sp.lock || !sp.locked);
  pick.hidden = false;
  const cur = pick.value;
  pick.replaceChildren(h('option', { value: '' }, 'All spaces'), ...spaces.map((sp) => h('option', { value: sp.id }, `${sp.icon ? `${sp.icon} ` : ''}${sp.name}`)));
  pick.value = spaceId ?? '';
  if (pick.value !== (spaceId ?? '')) pick.value = cur;
  const work = $('#work');
  const all = $('#all');
  if (!spaceId) {
    document.title = 'Notes · all spaces';
    $('#title').textContent = 'Notes of every space';
    work.hidden = true;
    all.hidden = false;
    $('#insert-link').hidden = true;
    $('#mode').hidden = true;
    const withNotes = spaces.filter((sp) => sp.notes?.trim());
    all.replaceChildren(
      ...withNotes.map((sp) => {
        const body = h('div', { class: 'body' });
        body.innerHTML = renderMarkdown(sp.notes ?? '');
        body.addEventListener('click', (e) => {
          const a = (e.target as Element).closest('a[href]') as HTMLAnchorElement | null;
          if (!a || !/^https?:/i.test(a.href)) return;
          e.preventDefault();
          dispatch({ type: 'tab.new', url: a.href, activate: true });
        });
        return h('section', {}, h('h2', { class: 'space' }, h('span', { class: 'dot', style: `background:${sp.color}` }), `${sp.icon ? `${sp.icon} ` : ''}${sp.name}`, h('a', { href: '#', onclick: (e: MouseEvent) => { e.preventDefault(); spaceId = sp.id; history.replaceState(null, '', `?space=${encodeURIComponent(sp.id)}`); render(); } }, 'edit')), body);
      }),
      withNotes.length ? '' : h('p', { class: 'empty' }, 'No space has notes yet. Pick a space above to write some.'),
    );
    $('#count').textContent = `${withNotes.length} of ${spaces.length} spaces have notes`;
    return;
  }
  const sp = state.spaces.find((x) => x.id === spaceId);
  if (!sp) {
    spaceId = null;
    render();
    return;
  }
  work.hidden = false;
  all.hidden = true;
  $('#insert-link').hidden = false;
  $('#mode').hidden = false;
  document.title = `Notes · ${sp.name}`;
  $('#title').textContent = `Notes · ${sp.icon ? `${sp.icon} ` : ''}${sp.name}`;
  work.className = `work${mode === 'edit' ? ' edit-only' : mode === 'view' ? ' view-only' : ''}`;
  $('#mode').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === mode));
  const notes = sp.notes ?? '';
  if (!dirty && text.value !== notes && document.activeElement !== text) text.value = notes;
  if (!dirty) preview.innerHTML = renderMarkdown(text.value);
  const words = text.value.trim() ? text.value.trim().split(/\s+/).length : 0;
  $('#count').textContent = `${words} word${words === 1 ? '' : 's'}`;
  if (!dirty && !$('#saved').textContent) $('#saved').textContent = notes ? 'Saved' : '';
}
