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
  addEventListener<K extends keyof ChordTabEventMap>(type: K, listener: (ev: ChordTabEventMap[K]) => void): void;
  removeEventListener<K extends keyof ChordTabEventMap>(type: K, listener: (ev: ChordTabEventMap[K]) => void): void;
}

interface Navigator {
  /** Present only inside Chord. Feature-detect: `if ('chord' in navigator)`. */
  readonly chord?: ChordPageApi;
}
