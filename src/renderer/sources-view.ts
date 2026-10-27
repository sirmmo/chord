// The Sources view of the side panel: the Sourceror report for the space's focused tab.
// Ported from the Sourceror extension's side panel. Everything shown comes from the
// page or third-party APIs and is escaped before it reaches innerHTML.

import type { Message, SourcesStatus, State } from '../shared/types.ts';

type Str = string | ((...a: never[]) => string);
const T: Record<'en' | 'it', Record<string, Str>> = {
  en: {
    server_url: 'Sourceror server', opt_links: 'Check that links are alive', opt_llm: 'Use the LLM (if configured)', opt_discover: 'Search for sources for unsourced claims',
    server_hint: 'Start it with “docker compose up -d” in the sourceror folder. It listens only on this computer.',
    analyze: 'Check this page’s sources', analyzing: 'Checking…', reanalyze: 'Check again', clear_marks: 'Clear marks',
    g_solid: 'solid', g_ok: 'acceptable', g_weak: 'weak', g_unreliable: 'unreliable',
    limits: 'Sourceror judges who published a source and whether the link works. It does not read the source, so it cannot tell whether it really says what the article claims.',
    not_web: 'Open an article (a web page or a Wikipedia entry) to check its sources.',
    no_server: (s: string) => `The Sourceror server is not reachable at ${s}. Start it with “docker compose up -d”, or fix the address in the settings below.`,
    inject_failed: 'Chord cannot read this page.', no_text: 'No article text was found on this page.', not_found: 'Wikipedia has no article with this title.',
    failed: 'The analysis failed: ', timeout: 'The analysis is taking too long. The server may be overloaded; try again with link checks off.',
    starting: 'Starting', fetching: 'Fetching the article', 'checking citations': 'Checking citations', 'checking sources': 'Checking linked sources', 'reading claims': 'Reading the claims', 'searching for sources': 'Searching for sources', complete: 'Done',
    outlet: 'Publisher', unlisted: 'Not in WP:RSP or CITEWATCH. That means no verdict, not “reliable”.',
    t_unsourced: 'claims with no source', t_weak: 'claims on weak sources', t_attributed: 'attributed, not linked', t_linked: 'linked to a source',
    sources_line: (n: number, s: number) => `${n} external source${n === 1 ? '' : 's'}` + (s ? ` · ${s} link${s === 1 ? '' : 's'} to the same site` : ''),
    dead: (n: number) => ` · ${n} dead`, by_llm: 'Claims read by the LLM.', by_heur: 'Claims found by a simple heuristic (no LLM configured): expect misses.',
    tab_claims: 'Claims', tab_sources: 'Sources', tab_citations: 'Citations', tab_gaps: 'Gaps', tab_sugg: 'Suggested',
    f_problems: 'Problems', f_all: 'All', f_unsourced: 'No source', f_weak: 'Weak source', f_attributed: 'Attributed', f_linked: 'Linked',
    s_unsourced: 'no source', s_weakly_linked: 'weak source', s_attributed: 'attributed', s_linked: 'linked',
    backed_by: 'Backed by', attributed_to: 'Attributed to', possible: 'Possible sources', no_items: 'Nothing here.', copy: 'copy', copied: 'copied',
    marks: (a: number, b: number) => `${a} sources and ${b} claims marked on the page.`,
    w_cited: 'citations', w_avg: 'average score', w_flagged: 'weak or unreliable', w_dead: 'dead links', w_cn: '“citation needed” tags', w_unsourced: 'paragraphs without notes',
    g_tagged: 'citation needed', g_para: 'paragraph without notes', same_site: 'same site', up: 'Sourceror server running', down: 'Sourceror server not reachable',
  },
  it: {
    server_url: 'Server Sourceror', opt_links: 'Controlla che i link funzionino', opt_llm: 'Usa l’LLM (se configurato)', opt_discover: 'Cerca fonti per le affermazioni senza fonte',
    server_hint: 'Avvialo con “docker compose up -d” nella cartella sourceror. Ascolta solo su questo computer.',
    analyze: 'Controlla le fonti di questa pagina', analyzing: 'Controllo in corso…', reanalyze: 'Ricontrolla', clear_marks: 'Togli i segni',
    g_solid: 'solida', g_ok: 'accettabile', g_weak: 'debole', g_unreliable: 'inaffidabile',
    limits: 'Sourceror valuta chi ha pubblicato una fonte e se il link funziona. Non legge la fonte: non può sapere se dice davvero ciò che l’articolo le attribuisce.',
    not_web: 'Apri un articolo (una pagina web o una voce di Wikipedia) per controllarne le fonti.',
    no_server: (s: string) => `Il server Sourceror non risponde su ${s}. Avvialo con “docker compose up -d”, o correggi l’indirizzo nelle impostazioni qui sotto.`,
    inject_failed: 'Chord non riesce a leggere questa pagina.', no_text: 'In questa pagina non c’è testo di un articolo.', not_found: 'Wikipedia non ha una voce con questo titolo.',
    failed: 'L’analisi non è riuscita: ', timeout: 'L’analisi sta durando troppo. Il server potrebbe essere sovraccarico: riprova senza il controllo dei link.',
    starting: 'Avvio', fetching: 'Scarico la voce', 'checking citations': 'Controllo le note', 'checking sources': 'Controllo le fonti collegate', 'reading claims': 'Leggo le affermazioni', 'searching for sources': 'Cerco fonti', complete: 'Fatto',
    outlet: 'Testata', unlisted: 'Non è in WP:RSP né in CITEWATCH: nessun giudizio, che non vuol dire “affidabile”.',
    t_unsourced: 'affermazioni senza fonte', t_weak: 'affermazioni su fonti deboli', t_attributed: 'attribuite, senza link', t_linked: 'collegate a una fonte',
    sources_line: (n: number, s: number) => `${n} font${n === 1 ? 'e esterna' : 'i esterne'}` + (s ? ` · ${s} link allo stesso sito` : ''),
    dead: (n: number) => ` · ${n} morti`, by_llm: 'Affermazioni lette dall’LLM.', by_heur: 'Affermazioni trovate con un’euristica semplice (LLM non configurato): ne sfuggiranno alcune.',
    tab_claims: 'Affermazioni', tab_sources: 'Fonti', tab_citations: 'Note', tab_gaps: 'Lacune', tab_sugg: 'Suggerite',
    f_problems: 'Problemi', f_all: 'Tutte', f_unsourced: 'Senza fonte', f_weak: 'Fonte debole', f_attributed: 'Attribuite', f_linked: 'Collegate',
    s_unsourced: 'senza fonte', s_weakly_linked: 'fonte debole', s_attributed: 'attribuita', s_linked: 'collegata',
    backed_by: 'Fonte', attributed_to: 'Attribuita a', possible: 'Fonti possibili', no_items: 'Niente da mostrare.', copy: 'copia', copied: 'copiato',
    marks: (a: number, b: number) => `Segnate nella pagina ${a} fonti e ${b} affermazioni.`,
    w_cited: 'note', w_avg: 'punteggio medio', w_flagged: 'deboli o inaffidabili', w_dead: 'link morti', w_cn: 'template “senza fonte”', w_unsourced: 'paragrafi senza note',
    g_tagged: 'senza fonte', g_para: 'paragrafo senza note', same_site: 'stesso sito', up: 'Server Sourceror attivo', down: 'Server Sourceror non raggiungibile',
  },
};
const L = T[(navigator.language || 'en').toLowerCase().startsWith('it') ? 'it' : 'en'];
const t = (k: string, ...a: unknown[]): string => {
  const v = L[k] ?? T.en[k] ?? k;
  return typeof v === 'function' ? (v as (...x: unknown[]) => string)(...a) : v;
};

const PROBLEMS = new Set(['weak', 'unreliable']);
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const safeUrl = (u: unknown) => {
  try {
    const x = new URL(String(u));
    return /^https?:$/.test(x.protocol) ? x.href : '';
  } catch {
    return '';
  }
};
const link = (u: unknown, label: unknown) => {
  const s = safeUrl(u);
  return s ? `<a href="${esc(s)}" data-open="${esc(s)}">${esc(label)}</a>` : esc(label);
};
const stripTags = (s: unknown) => new DOMParser().parseFromString(String(s ?? ''), 'text/html').body.textContent || '';

type R = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- the server's report shape is open

interface View {
  view: string;
  filter: string;
}

export function initSourcesView(root: HTMLElement, getState: () => State | null, dispatch: (m: Message) => void): { update(s: SourcesStatus): void } {
  const $ = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector(sel) as T;
  let status: SourcesStatus | null = null;
  let lastSeq = 0;
  const views = new Map<string, View>(); // per tab+url

  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) el.textContent = t(el.dataset.i18n!);

  const patchSettings = () => {
    const state = getState();
    if (!state) return;
    dispatch({
      type: 'settings.update',
      patch: {
        sourceror: {
          server: ($<HTMLInputElement>('#srcr-server').value.trim() || 'http://127.0.0.1:5010').replace(/\/+$/, ''),
          checkLinks: $<HTMLInputElement>('#srcr-links').checked,
          useLlm: $<HTMLInputElement>('#srcr-llm').checked,
          discover: $<HTMLInputElement>('#srcr-discover').checked,
        },
      },
    });
  };
  for (const sel of ['#srcr-server', '#srcr-links', '#srcr-llm', '#srcr-discover']) $(sel).addEventListener('change', patchSettings);
  $('#srcr-toggle-settings').onclick = () => {
    const s = $('#srcr-settings');
    s.hidden = !s.hidden;
  };
  $('#srcr-analyze').onclick = () => status && dispatch({ type: 'sources.analyze', spaceId: status.spaceId });
  $('#srcr-clear').onclick = () => status && dispatch({ type: 'sources.clear', spaceId: status.spaceId });

  $('#srcr-report').addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;
    const copy = target.closest<HTMLElement>('.copy');
    if (copy) {
      e.stopPropagation();
      await navigator.clipboard.writeText(copy.dataset.copy ?? '').catch(() => {});
      copy.textContent = t('copied');
      setTimeout(() => (copy.textContent = t('copy')), 1200);
      return;
    }
    const a = target.closest<HTMLElement>('a[data-open]');
    if (a) {
      e.preventDefault();
      dispatch({ type: 'tab.new', url: a.dataset.open! });
      return;
    }
    if (target.closest('summary')) return;
    const item = target.closest<HTMLElement>('.item[data-kind]');
    if (item && status) dispatch({ type: 'sources.focus', spaceId: status.spaceId, kind: item.dataset.kind!, id: item.dataset.id! });
  });

  function key(s: SourcesStatus): string {
    return `${s.tabId ?? ''}|${s.url}`;
  }
  function viewOf(s: SourcesStatus): View {
    let v = views.get(key(s));
    if (!v) {
      v = { view: s.kind === 'wikipedia' ? 'citations' : 'claims', filter: 'problems' };
      views.set(key(s), v);
    }
    return v;
  }

  function update(s: SourcesStatus): void {
    const state = getState();
    status = s;
    const settings = state?.settings.sourceror;
    if (settings) {
      const serverEl = $<HTMLInputElement>('#srcr-server');
      if (document.activeElement !== serverEl) serverEl.value = settings.server;
      $<HTMLInputElement>('#srcr-links').checked = settings.checkLinks;
      $<HTMLInputElement>('#srcr-llm').checked = settings.useLlm;
      $<HTMLInputElement>('#srcr-discover').checked = settings.discover;
    }
    const dotEl = $('#srcr-server-dot');
    dotEl.className = `srcr-server ${s.serverUp === true ? 'up' : s.serverUp === false ? 'down' : ''}`;
    dotEl.title = s.serverUp === true ? `${t('up')} · ${s.serverInfo}` : s.serverUp === false ? t('down') : s.server;

    $('#srcr-title').textContent = s.title;
    $('#srcr-url').textContent = s.url ? s.url.replace(/^https?:\/\//, '').slice(0, 120) : '';
    const btn = $<HTMLButtonElement>('#srcr-analyze');
    btn.disabled = !s.web || s.busy;
    btn.textContent = s.busy ? t('analyzing') : s.result ? t('reanalyze') : t('analyze');

    const prog = $('#srcr-progress');
    prog.hidden = !s.progress;
    if (s.progress) {
      $('#srcr-phase').textContent = t(s.progress.phase || 'starting');
      const bar = $('#srcr-bar');
      if (s.progress.total > 1) {
        bar.classList.remove('indeterminate');
        bar.style.width = `${Math.max(5, Math.round((100 * s.progress.done) / s.progress.total))}%`;
        $('#srcr-count').textContent = `${s.progress.done}/${s.progress.total}`;
      } else {
        bar.classList.add('indeterminate');
        bar.style.width = '';
        $('#srcr-count').textContent = '';
      }
    }

    const msg = $('#srcr-message');
    const text = s.message ? messageText(s.message.text, s.server) : !s.web ? t('not_web') : '';
    msg.hidden = !text;
    msg.textContent = text;
    msg.className = `srcr-message${s.message?.error ? ' error' : ''}`;

    const report = $('#srcr-report');
    const legend = $('#srcr-legend');
    const clear = $('#srcr-clear');
    if (!s.result) {
      report.hidden = true;
      legend.hidden = true;
      clear.hidden = true;
      report.innerHTML = '';
      return;
    }
    report.hidden = false;
    legend.hidden = false;
    clear.hidden = false;
    render(s);
    if (s.selected && s.selected.seq !== lastSeq) {
      lastSeq = s.selected.seq;
      flashItem(s, s.selected.kind, s.selected.id);
    }
  }

  function messageText(code: string, server: string): string {
    if (code.startsWith('failed:')) return t('failed') + code.slice(7);
    if (code === 'no_server') return t('no_server', server);
    return t(code);
  }

  // ---- render ----

  function render(s: SourcesStatus): void {
    const v = viewOf(s);
    if (s.kind === 'wikipedia') renderWikipedia(s, v);
    else renderArticle(s, v);
    const marks = $('#srcr-marks');
    if (marks && s.marks) marks.textContent = t('marks', s.marks.sources, s.marks.claims);
  }

  function tabsHtml(v: View, defs: [string, string, number][]): string {
    return `<nav class="srcr-tabs" role="tablist">${defs.map(([k, label, n]) => `<button class="srcr-tab" role="tab" data-view="${k}" aria-selected="${v.view === k}">${esc(label)}<span class="n">${n}</span></button>`).join('')}</nav>`;
  }

  function gradeBar(byGrade: Record<string, number>): string {
    const total = Object.values(byGrade).reduce((a, b) => a + b, 0) || 1;
    return `<div class="srcr-gradebar">${['solid', 'ok', 'weak', 'unreliable'].map((g) => (byGrade[g] ? `<i class="${g}" style="width:${((100 * byGrade[g]) / total).toFixed(1)}%" title="${byGrade[g]} ${esc(t('g_' + g))}"></i>` : '')).join('')}</div>`;
  }

  function renderArticle(s: SourcesStatus, v: View): void {
    const r = s.result as R;
    const st = r.stats ?? {};
    const cs = st.claims_by_status ?? {};
    const o = r.outlet ?? { verdicts: [] };
    const ov = (o.verdicts ?? [])[0];
    $('#srcr-report').innerHTML = `
      <div class="srcr-outlet">
        <div class="k">${esc(t('outlet'))}</div>
        <div class="v"><i class="d ${esc(o.verdict)}"></i>${esc(r.page?.site_name || o.domain || '')}</div>
        <p>${ov ? `${link(ov.url, ov.label)}${ov.name ? ' · ' + esc(ov.name) : ''}` : esc(t('unlisted'))}</p>
      </div>
      <div class="srcr-tiles">
        <div class="tile unsourced"><b>${cs.unsourced ?? 0}</b><span>${esc(t('t_unsourced'))}</span></div>
        <div class="tile weak"><b>${cs.weakly_linked ?? 0}</b><span>${esc(t('t_weak'))}</span></div>
        <div class="tile attributed"><b>${cs.attributed ?? 0}</b><span>${esc(t('t_attributed'))}</span></div>
        <div class="tile linked"><b>${cs.linked ?? 0}</b><span>${esc(t('t_linked'))}</span></div>
      </div>
      ${gradeBar(st.by_grade ?? {})}
      <div class="srcr-meta">${esc(t('sources_line', st.external_sources ?? 0, st.same_site_links ?? 0))}${st.dead_links ? esc(t('dead', st.dead_links)) : ''}
        · ${esc(r.claims_by === 'llm' ? t('by_llm') : t('by_heur'))} <span id="srcr-marks"></span></div>
      ${tabsHtml(v, [['claims', t('tab_claims'), (r.claims ?? []).length], ['sources', t('tab_sources'), (r.sources ?? []).length]])}
      <div id="srcr-filters" class="srcr-filters"></div>
      <div id="srcr-list" class="srcr-list"></div>`;
    wireTabs(s, v, renderArticleList);
    renderArticleList(s, v);
  }

  function renderArticleList(s: SourcesStatus, v: View): void {
    const r = s.result as R;
    if (v.view === 'claims') {
      filters(s, v, [['problems', 'f_problems'], ['all', 'f_all'], ['unsourced', 'f_unsourced'], ['weakly_linked', 'f_weak'], ['attributed', 'f_attributed'], ['linked', 'f_linked']], renderArticleList);
      const pick = (c: R) => (v.filter === 'all' ? true : v.filter === 'problems' ? c.status === 'unsourced' || c.status === 'weakly_linked' : c.status === v.filter);
      list((r.claims ?? []).filter(pick).map((c: R) => claimHtml(c, r)));
    } else {
      filters(s, v, [['problems', 'f_problems'], ['all', 'f_all']], renderArticleList);
      const items = (r.sources ?? []).filter((x: R) => v.filter === 'all' || PROBLEMS.has(x.grade) || (x.flags ?? []).some((f: R) => f.severity === 'serious' || f.severity === 'critical'));
      items.sort((a: R, b: R) => a.score - b.score);
      list(items.map(sourceHtml));
    }
  }

  function claimHtml(c: R, r: R): string {
    const backed = (c.sources ?? [])
      .map((i: number) => (r.sources ?? [])[i])
      .filter(Boolean)
      .map((src: R) => `<div class="sub"><i class="d ${esc(src.grade)}"></i> ${esc(t('backed_by'))}: ${link(src.href, src.anchor || src.domain)} <span class="score">${esc(src.domain)} · ${esc(src.score)}</span></div>`)
      .join('');
    return `<div class="item ${esc(c.status)}" data-kind="claim" data-id="${esc(c.id)}">
      <div class="head"><span class="chip ${esc(c.status)}">${esc(t('s_' + c.status))}</span></div>
      <blockquote>${esc(c.text)}</blockquote>
      ${c.why ? `<div class="why">${esc(c.why)}</div>` : ''}
      ${c.attribution ? `<div class="sub">${esc(t('attributed_to'))}: ${esc(c.attribution)}</div>` : ''}
      ${backed}
      ${candidatesHtml(c.candidates)}
    </div>`;
  }

  function candidatesHtml(cands: R[] | undefined): string {
    if (!cands || !cands.length) return '';
    return `<div class="srcr-cands"><div class="k">${esc(t('possible'))}</div>${cands
      .map((x) => {
        const href = x.landing || (x.doi ? `https://doi.org/${x.doi}` : '');
        const rel = x.relevance ? `<span class="rel ${esc(x.relevance)}">${esc(x.relevance)}${x.relevance_why ? ' — ' + esc(x.relevance_why) : ''}</span>` : '';
        return `<div class="cand">${link(href, stripTags(x.title))} <span class="score">${esc([x.venue, x.year].filter(Boolean).join(', '))}</span>
          ${x.citation ? `<button class="copy" data-copy="${esc(x.citation)}">${esc(t('copy'))}</button>` : ''}<br>${rel}</div>`;
      })
      .join('')}</div>`;
  }

  function flagsHtml(flags: R[] | undefined): string {
    const all = flags ?? [];
    const shown = all.filter((f) => f.severity !== 'good' && f.code !== 'SAME_SITE').slice(0, 4);
    const good = all.filter((f) => f.severity === 'good').slice(0, 2);
    return `<ul class="srcr-flags">${[...shown, ...good]
      .map((f) => `<li><i class="d ${esc(f.severity)}"></i><details><summary>${esc(f.title)}</summary>${f.detail ? `<p>${esc(String(f.detail).slice(0, 500))}</p>` : ''}${f.fix ? `<p>→ ${esc(f.fix)}</p>` : ''}${f.url ? `<p>${link(f.url, String(f.url).replace(/^https?:\/\//, '').slice(0, 60))}</p>` : ''}</details></li>`)
      .join('')}</ul>`;
  }

  function sourceHtml(src: R): string {
    return `<div class="item" data-kind="source" data-id="${esc(src.n)}">
      <div class="head"><i class="d ${esc(src.grade)}"></i><span class="title">${esc(src.anchor || src.display || src.domain)}</span><span class="score">${esc(src.score)}/100</span></div>
      <div class="sub">${link(src.href || (src.doi ? 'https://doi.org/' + src.doi : ''), src.domain || 'doi:' + src.doi)}${src.same_site ? ' · ' + esc(t('same_site')) : ''}</div>
      ${flagsHtml(src.flags)}
    </div>`;
  }

  function renderWikipedia(s: SourcesStatus, v: View): void {
    const r = s.result as R;
    const st = r.stats ?? {};
    $('#srcr-report').innerHTML = `
      <div class="srcr-outlet">
        <div class="k">Wikipedia · ${esc(r.page?.lang)}</div>
        <div class="v">${link(r.page?.url, r.page?.title)}</div>
        ${r.redirected_from ? `<p>← ${esc(r.redirected_from)}</p>` : ''}
      </div>
      <div class="srcr-tiles">
        <div class="tile"><b>${esc(st.scored ?? 0)}</b><span>${esc(t('w_cited'))}</span></div>
        <div class="tile"><b>${esc(st.avg_score ?? 0)}</b><span>${esc(t('w_avg'))}</span></div>
        <div class="tile weak"><b>${esc(st.flagged ?? 0)}</b><span>${esc(t('w_flagged'))}</span></div>
        <div class="tile unsourced"><b>${(st.cn_tags ?? 0) + (st.unsourced_paragraphs ?? 0)}</b><span>${esc(t('w_cn'))} + ${esc(t('w_unsourced'))}</span></div>
      </div>
      ${gradeBar(st.by_grade ?? {})}
      <div class="srcr-meta">${st.dead_links ? `${st.dead_links} ${esc(t('w_dead'))} · ` : ''}<span id="srcr-marks"></span></div>
      ${tabsHtml(v, [['citations', t('tab_citations'), (r.citations ?? []).length], ['gaps', t('tab_gaps'), (r.gaps ?? []).length], ['suggestions', t('tab_sugg'), (r.suggestions ?? []).length]])}
      <div id="srcr-filters" class="srcr-filters"></div>
      <div id="srcr-list" class="srcr-list"></div>`;
    wireTabs(s, v, renderWikipediaList);
    renderWikipediaList(s, v);
  }

  function renderWikipediaList(s: SourcesStatus, v: View): void {
    const r = s.result as R;
    $('#srcr-filters').innerHTML = '';
    if (v.view === 'citations') {
      filters(s, v, [['problems', 'f_problems'], ['all', 'f_all']], renderWikipediaList);
      const items = (r.citations ?? []).filter((c: R) => v.filter === 'all' || PROBLEMS.has(c.grade) || (c.flags ?? []).some((f: R) => f.severity === 'serious' || f.severity === 'critical'));
      list(
        items.map(
          (c: R) => `<div class="item" data-kind="citation" data-id="${esc(c.n)}">
        <div class="head"><i class="d ${esc(c.grade)}"></i><span class="title">${esc(c.display)}</span><span class="score">${esc(c.score)}/100</span></div>
        <div class="sub">${c.urls && c.urls[0] ? link(c.urls[0], c.domain || c.urls[0]) : esc(c.kind)}${c.section ? ' · § ' + esc(c.section) : ''}</div>
        ${flagsHtml(c.flags)}
        ${c.archive_snippet ? `<div class="srcr-cands"><div class="cand"><code>${esc(c.archive_snippet)}</code><button class="copy" data-copy="${esc(c.archive_snippet)}">${esc(t('copy'))}</button></div></div>` : ''}
      </div>`,
        ),
      );
    } else if (v.view === 'gaps') {
      list(
        (r.gaps ?? []).map(
          (g: R) => `<div class="item unsourced" data-kind="claim" data-id="${esc(g.id)}">
        <div class="head"><span class="chip unsourced">${esc(g.type === 'tagged' ? t('g_tagged') : t('g_para'))}</span><span class="score">§ ${esc(g.section)}</span></div>
        <blockquote>${esc(String(g.claim ?? '').length > 400 ? String(g.claim).slice(0, 400) + '…' : g.claim)}</blockquote>
        ${candidatesHtml(g.candidates)}
      </div>`,
        ),
      );
    } else {
      list([`<div class="item">${candidatesHtml(r.suggestions).replace('class="srcr-cands"', 'class="srcr-cands" style="border:0;margin:0;padding:0"')}</div>`]);
    }
  }

  function wireTabs(s: SourcesStatus, v: View, renderList: (s: SourcesStatus, v: View) => void): void {
    for (const b of root.querySelectorAll<HTMLElement>('.srcr-tab')) {
      b.addEventListener('click', () => {
        v.view = b.dataset.view!;
        v.filter = 'problems';
        for (const x of root.querySelectorAll<HTMLElement>('.srcr-tab')) x.setAttribute('aria-selected', String(x === b));
        renderList(s, v);
      });
    }
  }

  function filters(s: SourcesStatus, v: View, keys: [string, string][], renderList: (s: SourcesStatus, v: View) => void): void {
    const el = $('#srcr-filters');
    el.innerHTML = keys.map(([k, label]) => `<button class="srcr-filter" data-f="${k}" aria-pressed="${v.filter === k}">${esc(t(label))}</button>`).join('');
    for (const b of el.querySelectorAll<HTMLElement>('.srcr-filter')) {
      b.addEventListener('click', () => {
        v.filter = b.dataset.f!;
        renderList(s, v);
      });
    }
  }

  function list(items: string[]): void {
    $('#srcr-list').innerHTML = items.length ? items.join('') : `<div class="srcr-empty">${esc(t('no_items'))}</div>`;
  }

  function flashItem(s: SourcesStatus, kind: string, id: string): void {
    const v = viewOf(s);
    const wantView = kind === 'claim' ? (s.kind === 'wikipedia' ? 'gaps' : 'claims') : s.kind === 'wikipedia' ? 'citations' : 'sources';
    const sel = `.item[data-kind="${kind}"][data-id="${CSS.escape(String(id))}"]`;
    if (v.view !== wantView || !root.querySelector(sel)) {
      v.view = wantView;
      v.filter = 'all';
      for (const x of root.querySelectorAll<HTMLElement>('.srcr-tab')) x.setAttribute('aria-selected', String(x.dataset.view === wantView));
      (s.kind === 'wikipedia' ? renderWikipediaList : renderArticleList)(s, v);
    }
    const el = root.querySelector<HTMLElement>(sel);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1600);
  }

  return { update };
}
