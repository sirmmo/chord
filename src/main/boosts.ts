import type { WebContents } from 'electron';
import type { Boost, TabId } from '../shared/types.ts';
import { boostsFor } from '../shared/boosts.ts';
import { hostOf } from '../shared/url.ts';
import type { Controller } from './controller.ts';

interface Applied {
  boostId: string;
  cssKey?: string;
  css: string;
  ranJs: boolean;
}

/** Applies the user's boosts to page views and keeps CSS in sync while boosts are edited. */
export class BoostManager {
  private readonly c: Controller;
  private readonly applied = new Map<TabId, Applied[]>();

  constructor(c: Controller) {
    this.c = c;
  }

  /** New document in this tab: nothing is applied any more. */
  reset(id: TabId): void {
    this.applied.delete(id);
  }

  /** Called at dom-ready: inject every matching boost. */
  async apply(id: TabId, wc: WebContents): Promise<void> {
    if (wc.isDestroyed()) return;
    const host = hostOf(wc.getURL());
    if (!host) return;
    const list: Applied[] = [];
    this.applied.set(id, list);
    for (const b of boostsFor(this.c.state.settings.boosts, host)) {
      const entry: Applied = { boostId: b.id, css: b.css, ranJs: false };
      list.push(entry);
      if (b.css.trim()) entry.cssKey = await wc.insertCSS(b.css).catch(() => undefined);
      if (b.js.trim()) {
        entry.ranJs = true;
        await wc.executeJavaScript(`(() => { try { ${b.js}\n } catch (e) { console.error('Chord boost "${b.name.replace(/["\\\\]/g, '')}" failed:', e); } })()`, true).catch(() => {});
      }
    }
  }

  /** Boosts changed in settings: swap the CSS on every live page; JS needs a reload. */
  async refresh(): Promise<void> {
    for (const [id, list] of this.applied) {
      const wc = this.c.tabs.get(id)?.webContents;
      if (!wc || wc.isDestroyed()) continue;
      const host = hostOf(wc.getURL());
      const wanted = boostsFor(this.c.state.settings.boosts, host);
      for (const a of list) {
        const now = wanted.find((b) => b.id === a.boostId);
        if (a.cssKey && (!now || now.css !== a.css)) {
          await wc.removeInsertedCSS(a.cssKey).catch(() => {});
          a.cssKey = undefined;
        }
      }
      const next: Applied[] = [];
      for (const b of wanted) {
        const prev = list.find((a) => a.boostId === b.id);
        const entry: Applied = { boostId: b.id, css: b.css, ranJs: prev?.ranJs ?? false, cssKey: prev?.css === b.css ? prev.cssKey : undefined };
        if (b.css.trim() && !entry.cssKey) entry.cssKey = await wc.insertCSS(b.css).catch(() => undefined);
        next.push(entry);
      }
      this.applied.set(id, next);
    }
  }
}

export function newBoost(partial: Partial<Boost> = {}): Boost {
  return { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, name: '', sites: '', css: '', js: '', enabled: true, ...partial };
}
