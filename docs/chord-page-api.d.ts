// Type declarations for the Chord page API (navigator.chord), available to pages
// open in the Chord browser. Copy this file into your project or reference it
// with /// <reference path="chord-page-api.d.ts" />.

interface ChordTabInfo {
  /** opaque id, valid while the tab exists */
  id: string;
  url: string;
  title: string;
}

interface ChordTabEventMap {
  /** one of the page's tabs was closed (by the user or by the page) */
  tabclosed: CustomEvent<{ type: 'tabclosed'; id: string }>;
  /** one of the page's tabs navigated or changed its title */
  tabchanged: CustomEvent<{ type: 'tabchanged'; id: string; url: string; title: string }>;
}

interface ChordPageApi {
  readonly version: 1;
  /** Ask once per origin; resolves true when the page may manage tabs in its space. */
  requestTabs(): Promise<boolean>;
  /** Whether the permission is already granted, without prompting. */
  tabsGranted(): Promise<boolean>;
  /** Open an http(s) page in a new tab of the page's subspace; at most 24 per page. */
  openTab(opts: { url: string; activate?: boolean }): Promise<ChordTabInfo>;
  closeTab(id: string): Promise<void>;
  focusTab(id: string): Promise<void>;
  navigateTab(id: string, url: string): Promise<void>;
  /** The tabs this page opened that are still open. */
  listTabs(): Promise<ChordTabInfo[]>;
  /** Rename the subspace that holds the page's tabs (defaults to the page title). */
  setSubspaceName(name: string): Promise<void>;
  // ---- deeper integration: sites the user wrote a boost for, or granted origins ----
  /** A card in Chord's sidebar, shown from every space, with up to four buttons. */
  readonly card: {
    set(card: { title: string; subtitle?: string; state?: '' | 'ok' | 'warn' | 'err' | 'busy'; badge?: number; actions?: { id: string; label: string }[] }): Promise<void>;
    clear(): Promise<void>;
    onAction(fn: (actionId: string) => void): void;
  };
  /** Badge on the tab and the space dot; null goes back to reading the title. */
  setUnread(count: number | null): Promise<void>;
  /** Counted like a web notification: bell in the title bar, badge on the tab. */
  notify(title: string, body?: string): Promise<void>;
  /** Bookmark a page (this one by default) into the tab's space. */
  bookmark(opts?: { url?: string; title?: string; note?: string; tags?: string[]; public?: boolean }): Promise<void>;
  /** Append Markdown to the space's notes. */
  addNote(markdown: string): Promise<void>;
  /** Subscribe the reader to a feed (this page's, discovered, by default), tagged with the space. */
  subscribe(feedUrl?: string): Promise<{ title: string; url: string }>;
  /** Open a page in the space (a plain tab, not part of the page's subspace). */
  open(url: string, opts?: { background?: boolean }): Promise<void>;
  /** Open a page in a Little window. */
  openLittle(url: string): Promise<void>;
  /** The space this tab is in and Chord's look. Also CSS variables --chord-space and --chord-accent and data-chord-theme on <html>, and a "theme" event. */
  theme(): Promise<ChordTheme>;
  addEventListener<K extends keyof ChordTabEventMap>(type: K, listener: (ev: ChordTabEventMap[K]) => void): void;
  addEventListener(type: 'theme', listener: (ev: CustomEvent<ChordTheme>) => void): void;
  removeEventListener<K extends keyof ChordTabEventMap>(type: K, listener: (ev: ChordTabEventMap[K]) => void): void;
}

interface ChordTheme {
  space: { id: string; name: string; color: string; icon: string };
  accent: string;
  dark: boolean;
  font: string;
}

interface Navigator {
  /** Present only inside Chord. Feature-detect: `if ('chord' in navigator)`. */
  readonly chord?: ChordPageApi;
}
