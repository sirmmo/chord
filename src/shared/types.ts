// Shared types between the main process, the preload bridge and the UI pages.

import type { ChordConfig, ImportMode } from './config.ts';

export type TabId = string;
export type SpaceId = string;
export type TabKind = 'favorite' | 'pinned' | 'today';
export type SearchEngine = 'duckduckgo' | 'google' | 'brave' | 'kagi' | 'startpage';

export interface Tab {
  id: TabId;
  /** null for favorites, which are shared by all spaces */
  spaceId: SpaceId | null;
  kind: TabKind;
  url: string;
  /** For pinned and favorite tabs: the page they were pinned at and reset to */
  homeUrl?: string;
  title: string;
  favicon?: string;
  createdAt: number;
  lastActiveAt: number;
  /** true when a live web view exists for this tab */
  awake: boolean;
  loading?: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
  audible?: boolean;
  muted?: boolean;
  crashed?: boolean;
}

export interface Boost {
  id: string;
  name: string;
  /** comma or space separated site patterns, see shared/boosts.ts */
  sites: string;
  css: string;
  js: string;
  enabled: boolean;
}

export interface PasswordEntry {
  id: string;
  host: string;
  username: string;
  updatedAt: number;
}
export interface PasswordsStatus {
  available: boolean;
  entries: PasswordEntry[];
  never: string[];
}

export type ModeId = 'research' | 'ai';

export interface ResearchClip {
  id: string;
  text: string;
  url: string;
  title: string;
  at: number;
}
export interface ResearchSource {
  id: string;
  url: string;
  title: string;
  at: number;
  /** saved to Zotero */
  zotero?: boolean;
}
export interface ResearchData {
  notes: string;
  clips: ResearchClip[];
  sources: ResearchSource[];
}
export interface ResearchStatus {
  spaceId: SpaceId;
  data: ResearchData;
  zotero: { available: boolean; checkedAt: number };
}

export interface AiSettings {
  provider: 'anthropic' | 'openai';
  /** OpenAI-compatible base URL, e.g. http://localhost:11434/v1 for Ollama */
  baseUrl: string;
  model: string;
}
export interface AiMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  /** for role 'tool': the call that produced it */
  tool?: { name: string; input: unknown; error?: boolean };
  at: number;
}
export interface AiStatus {
  spaceId: SpaceId;
  messages: AiMessage[];
  busy: boolean;
  error?: string;
  hasKey: boolean;
  provider: AiSettings['provider'];
  model: string;
}

/** A tool a page exposes through WebMCP (navigator.modelContext). */
export interface WebMcpTool {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface SpaceLock {
  salt: string;
  hash: string;
}

export interface Space {
  id: SpaceId;
  name: string;
  /** hex colour used to tint the sidebar */
  color: string;
  /** optional emoji shown in the space switcher */
  icon?: string;
  pinned: TabId[];
  today: TabId[];
  /** tabs currently shown side by side (split view); usually one */
  panes: TabId[];
  /** split-view tiling spec (see shared/tiling.ts); equal columns when unset */
  tiling?: string;
  /** named browsing profile (cookies, logins, storage); unset means the shared session */
  profile?: string;
  /** composable modes; each has a view in the side panel */
  modes?: ModeId[];
  /** which mode's view the side panel shows */
  panelMode?: ModeId;
  /** private space: password protected, never exported, never archived */
  lock?: SpaceLock;
  /** runtime: a private space starts locked and locks again when left alone */
  locked?: boolean;
  /** when the user last switched away from this space */
  leftAt?: number;
  focused: TabId | null;
}

export interface ArchivedTab {
  id: TabId;
  url: string;
  title: string;
  favicon?: string;
  spaceId: SpaceId | null;
  archivedAt: number;
}

export type ThemeMode = 'system' | 'light' | 'dark';
export type IconStyle = 'color' | 'mono';
export type FontStyle = 'system' | 'rounded' | 'mono' | 'serif';

/** Appearance: colours, icons and type. Space colour comes from the space itself. */
export interface Theme {
  mode: ThemeMode;
  /** 0..100: how strongly the space colour tints the sidebar */
  tint: number;
  /** UI accent (selected tab, buttons); null follows the space colour */
  accent: string | null;
  iconStyle: IconStyle;
  /** colour of monochrome icons and letter glyphs; null follows the text colour */
  iconColor: string | null;
  font: FontStyle;
}

/** An unpacked Chrome extension the user added from a folder. */
export interface ExtensionEntry {
  path: string;
  enabled: boolean;
  /** cached from the manifest the last time it loaded */
  name?: string;
  version?: string;
}

/** Runtime status of extensions, sent by main (not persisted). */
export type ExtensionsStatus = Record<string, { loaded: boolean; error?: string }>;

export interface Settings {
  theme: Theme;
  /** show media controls for pages that expose a Media Session (YouTube Music, Spotify…) */
  smartPages: boolean;
  /** show a save dialog for every download instead of saving to the download folder */
  askDownloadPath: boolean;
  /** where downloads go; null means the system Downloads folder */
  downloadDir: string | null;
  /** closing the window hides it; Chord keeps running in the menu bar / tray */
  closeToTray: boolean;
  /** user-defined split-view layouts */
  tilings: { name: string; spec: string }[];
  /** per-site CSS and JavaScript */
  boosts: Boost[];
  /** pop a playing video out when switching away from its tab */
  autoPip: boolean;
  /** the side panel (modes) is shown for spaces that have modes */
  panelOpen: boolean;
  panelWidth: number;
  ai: AiSettings;
  /** editable address bar across the top of the page */
  addressBar: boolean;
  extensions: ExtensionEntry[];
  sidebarOpen: boolean;
  sidebarWidth: number;
  /** "Today" tabs that were not used for this long are archived */
  archiveAfterHours: number;
  /** ad and tracker blocking */
  shields: boolean;
  searchEngine: SearchEngine;
}

export interface State {
  version: 1;
  spaces: Space[];
  activeSpaceId: SpaceId;
  tabs: Record<TabId, Tab>;
  favorites: TabId[];
  archived: ArchivedTab[];
  recentlyClosed: ArchivedTab[];
  settings: Settings;
}

export type ListName = 'favorites' | 'pinned' | 'today';

/** Pure state transitions, handled by the reducer in model.ts */
export type Action =
  | { type: 'tab.new'; url: string; spaceId?: SpaceId; activate?: boolean; id?: TabId; adopt?: boolean }
  | { type: 'tab.activate'; id: TabId }
  | { type: 'tab.close'; id: TabId }
  | { type: 'tab.closeActive' }
  | { type: 'tab.patch'; id: TabId; patch: Partial<Tab> }
  | { type: 'tab.sleep'; id: TabId }
  | { type: 'tab.pin'; id: TabId }
  | { type: 'tab.unpin'; id: TabId }
  | { type: 'tab.togglePin'; id?: TabId }
  | { type: 'tab.favorite'; id: TabId }
  | { type: 'tab.unfavorite'; id: TabId }
  | { type: 'tab.move'; id: TabId; list: ListName; spaceId?: SpaceId; index: number }
  | { type: 'tab.split'; id: TabId }
  | { type: 'space.tiling'; spec: string | null; spaceId?: SpaceId }
  | { type: 'space.modes'; id: SpaceId; modes: ModeId[] }
  | { type: 'space.profile'; id: SpaceId; profile: string | null }
  | { type: 'panel.toggle'; open?: boolean }
  | { type: 'panel.mode'; mode: ModeId }
  | { type: 'panel.resize'; width: number }
  | { type: 'space.setLock'; id: SpaceId; lock: SpaceLock | null }
  | { type: 'space.lock'; id: SpaceId }
  | { type: 'space.lockAll' }
  | { type: 'space.unlocked'; id: SpaceId }
  | { type: 'space.tilingNext' }
  | { type: 'tab.unsplit'; id: TabId }
  | { type: 'pane.focus'; id: TabId }
  | { type: 'tab.next' }
  | { type: 'tab.prev' }
  | { type: 'tab.jump'; index: number }
  | { type: 'today.clear' }
  | { type: 'space.create'; name?: string; color?: string; icon?: string }
  | { type: 'space.activate'; id: SpaceId }
  | { type: 'space.next' }
  | { type: 'space.prev' }
  | { type: 'space.update'; id: SpaceId; patch: Partial<Pick<Space, 'name' | 'color' | 'icon'>> }
  | { type: 'space.delete'; id: SpaceId }
  | { type: 'sidebar.toggle' }
  | { type: 'sidebar.resize'; width: number }
  | { type: 'settings.update'; patch: Partial<Omit<Settings, 'theme' | 'extensions'>> }
  | { type: 'extension.add'; path: string; name?: string; version?: string }
  | { type: 'extension.remove'; path: string }
  | { type: 'extension.toggle'; path: string; enabled: boolean }
  | { type: 'extension.info'; path: string; name: string; version: string }
  | { type: 'theme.update'; patch: Partial<Theme> }
  | { type: 'archived.restore'; id: TabId }
  | { type: 'archived.clear' }
  | { type: 'closed.reopen' }
  | { type: 'config.import'; config: ChordConfig; mode: ImportMode }
  | { type: 'tick' };

/** Side-effecting commands handled by the main-process controller */
export type Command =
  | { type: 'tab.navigate'; id?: TabId | null; url: string }
  | { type: 'tab.home'; id: TabId }
  | { type: 'tab.duplicate'; id: TabId }
  | { type: 'tab.mute'; id: TabId }
  | { type: 'tab.contextmenu'; id: TabId }
  | { type: 'space.contextmenu'; id: SpaceId }
  | { type: 'space.rename'; id: SpaceId; name: string }
  | { type: 'nav.back' }
  | { type: 'nav.forward' }
  | { type: 'nav.reload' }
  | { type: 'nav.stop' }
  | { type: 'palette.open'; intent: 'new' | 'current' }
  | { type: 'palette.close' }
  | { type: 'settings.open'; page?: string }
  | { type: 'sidebar.peek'; on: boolean }
  | { type: 'find.open' }
  | { type: 'find.query'; text: string; forward: boolean; findNext: boolean }
  | { type: 'find.close' }
  | { type: 'url.copy' }
  | { type: 'devtools.toggle' }
  | { type: 'zoom.in' }
  | { type: 'zoom.out' }
  | { type: 'zoom.reset' }
  | { type: 'open.external'; url: string }
  | { type: 'app.setDefaultBrowser' }
  | { type: 'extension.pickFolder' }
  | { type: 'config.export'; spaceId?: SpaceId }
  | { type: 'config.importFile' }
  | { type: 'diagnostics.copy' }
  | { type: 'media.action'; id: TabId; action: MediaAction }
  | { type: 'call.action'; id: TabId; action: CallAction }
  | { type: 'media.pip'; id?: TabId }
  | { type: 'space.install'; url: string }
  | { type: 'space.modesMenu'; id: SpaceId }
  | { type: 'space.newProfile'; id: SpaceId }
  | { type: 'space.forgetProfile'; id: SpaceId }
  | { type: 'prompt.answer'; token: string; text: string }
  | { type: 'research.note'; spaceId: SpaceId; text: string }
  | { type: 'research.clip'; spaceId?: SpaceId; text?: string; url?: string; title?: string }
  | { type: 'research.remove'; spaceId: SpaceId; kind: 'clip' | 'source'; id: string }
  | { type: 'research.source'; spaceId?: SpaceId; url?: string; title?: string }
  | { type: 'research.zotero'; spaceId?: SpaceId; tabId?: TabId }
  | { type: 'ai.send'; spaceId: SpaceId; text: string }
  | { type: 'ai.stop'; spaceId: SpaceId }
  | { type: 'ai.clear'; spaceId: SpaceId }
  | { type: 'ai.setKey'; key: string }
  | { type: 'ai.test' }
  | { type: 'downloads.panel' }
  | { type: 'password.delete'; id: string }
  | { type: 'password.allowAgain'; host: string }
  | { type: 'import.browser' }
  | { type: 'download.pause'; id: string }
  | { type: 'download.resume'; id: string }
  | { type: 'download.cancel'; id: string }
  | { type: 'download.open'; id: string }
  | { type: 'download.show'; id: string }
  | { type: 'download.retry'; id: string }
  | { type: 'download.remove'; id: string }
  | { type: 'downloads.clear' }
  | { type: 'downloads.openFolder' }
  | { type: 'downloads.chooseFolder' }
  | { type: 'downloads.open' }
  | { type: 'space.passwordPrompt'; id: SpaceId; purpose: LockPurpose }
  | { type: 'space.password'; id: SpaceId; purpose: LockPurpose; password: string }
  | { type: 'history.open' }
  | { type: 'history.remove'; id: string }
  | { type: 'history.clear' };

export const COMMAND_TYPES: ReadonlySet<string> = new Set<Command['type']>([
  'tab.navigate', 'tab.home', 'tab.duplicate', 'tab.mute', 'tab.contextmenu', 'space.contextmenu', 'space.rename',
  'nav.back', 'nav.forward', 'nav.reload', 'nav.stop',
  'palette.open', 'palette.close', 'settings.open', 'sidebar.peek', 'find.open', 'find.query', 'find.close',
  'url.copy', 'devtools.toggle', 'zoom.in', 'zoom.out', 'zoom.reset', 'open.external', 'app.setDefaultBrowser',
  'extension.pickFolder', 'config.export', 'config.importFile', 'diagnostics.copy', 'media.action', 'call.action', 'media.pip', 'space.install', 'space.modesMenu', 'space.newProfile', 'space.forgetProfile', 'prompt.answer', 'research.note', 'research.clip', 'research.remove', 'research.source', 'research.zotero', 'ai.send', 'ai.stop', 'ai.clear', 'ai.setKey', 'ai.test', 'downloads.panel', 'password.delete', 'password.allowAgain', 'import.browser',
  'download.pause', 'download.resume', 'download.cancel', 'download.open', 'download.show', 'download.retry', 'download.remove',
  'downloads.clear', 'downloads.openFolder', 'downloads.chooseFolder', 'downloads.open', 'space.passwordPrompt', 'space.password', 'history.open', 'history.remove', 'history.clear',
]);

export type Message = Action | Command;

export function isCommand(m: Message): m is Command {
  return COMMAND_TYPES.has(m.type);
}

/** Messages from main to the overlay page */
export type LockPurpose = 'unlock' | 'set' | 'remove';

export type OverlayMessage =
  | { kind: 'show'; mode: 'palette'; intent: 'new' | 'current'; query: string }
  | { kind: 'show'; mode: 'find' }
  | { kind: 'show'; mode: 'downloads' }
  | { kind: 'show'; mode: 'password'; spaceId: SpaceId; purpose: LockPurpose; name: string }
  | { kind: 'show'; mode: 'prompt'; token: string; title: string; placeholder: string; value: string }
  | { kind: 'password:error' }
  | { kind: 'hide' }
  | { kind: 'find:result'; active: number; matches: number };

/** Messages from main to the sidebar page */
export type SidebarMessage =
  | { kind: 'space.renameStart'; id: SpaceId };

/** Media Session actions Chord can send back to a page. */
export type MediaAction = 'play' | 'pause' | 'previoustrack' | 'nexttrack' | 'seekbackward' | 'seekforward' | 'stop';

/** What a "smart page" reports about its player. */
export interface MediaInfo {
  title: string;
  artist: string;
  album: string;
  artwork: string;
  playing: boolean;
  /** actions the page registered handlers for */
  actions: MediaAction[];
  /** the page has a playable video element */
  video: boolean;
  host: string;
  updatedAt: number;
}
export type CallAction = 'mute' | 'camera' | 'leave';
export interface CallInfo {
  since: number;
  muted: boolean | null;
  cameraOff: boolean | null;
  sharing: boolean;
  canLeave: boolean;
  site: string;
}
export interface TimerInfo {
  /** "12:34" or "45%" as it appears in the title */
  text: string;
  /** 0–1 when the title carries a percentage */
  progress: number | null;
}
/** Everything a tab gives away that is worth showing across spaces. */
export interface SmartInfo {
  media?: MediaInfo;
  call?: CallInfo;
  timer?: TimerInfo;
  unread?: number;
  /** notifications the page created since it was last looked at */
  notifications: number;
  /** the page offers an installable space (its manifest URL) */
  manifest?: string;
  /** tools the page exposes through WebMCP */
  tools?: WebMcpTool[];
  lastNotification?: { title: string; body: string; at: number };
  updatedAt: number;
}
export type SmartStatus = Record<TabId, SmartInfo>;

export interface AppInfo {
  version: string;
  electron: string;
  chrome: string;
  node: string;
  v8: string;
  platform: string;
  arch: string;
  userData: string;
}

export interface HistoryEntry {
  id: string;
  url: string;
  title: string;
  at: number;
}
export interface HistoryQuery {
  query?: string;
  limit?: number;
}
export interface HistoryResult {
  entries: HistoryEntry[];
  total: number;
}

export type DownloadState = 'progressing' | 'completed' | 'cancelled' | 'interrupted';
export interface DownloadEntry {
  id: string;
  url: string;
  filename: string;
  path: string;
  total: number;
  received: number;
  state: DownloadState;
  paused: boolean;
  canResume: boolean;
  startedAt: number;
  finishedAt?: number;
  bytesPerSecond: number;
  /** for completed downloads: whether the file is still on disk */
  exists?: boolean;
}
export interface DownloadsStatus {
  /** newest first */
  items: DownloadEntry[];
  active: number;
}

export interface ChordApi {
  platform: string;
  dispatch(message: Message): Promise<void>;
  getState(): Promise<State>;
  onState(cb: (state: State) => void): () => void;
  onOverlay(cb: (message: OverlayMessage) => void): () => void;
  onSidebar(cb: (message: SidebarMessage) => void): () => void;
  onExtensions(cb: (status: ExtensionsStatus) => void): () => void;
  getExtensions(): Promise<ExtensionsStatus>;
  onSmart(cb: (status: SmartStatus) => void): () => void;
  getSmart(): Promise<SmartStatus>;
  onDownloads(cb: (status: DownloadsStatus) => void): () => void;
  getDownloads(): Promise<DownloadsStatus>;
  onHistory(cb: (info: { total: number }) => void): () => void;
  getHistory(query: HistoryQuery): Promise<HistoryResult>;
  getInfo(): Promise<AppInfo>;
  onPasswords(cb: (status: PasswordsStatus) => void): () => void;
  getPasswords(): Promise<PasswordsStatus>;
  revealPassword(id: string): Promise<string | null>;
  onResearch(cb: (status: ResearchStatus) => void): () => void;
  getResearch(spaceId: SpaceId): Promise<ResearchStatus>;
  onAi(cb: (status: AiStatus) => void): () => void;
  getAi(spaceId: SpaceId): Promise<AiStatus>;
}
