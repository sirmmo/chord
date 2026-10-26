// Shared types between the main process, the preload bridge and the UI pages.

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

export interface Settings {
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
  | { type: 'settings.update'; patch: Partial<Settings> }
  | { type: 'archived.restore'; id: TabId }
  | { type: 'archived.clear' }
  | { type: 'closed.reopen' }
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
  | { type: 'find.open' }
  | { type: 'find.query'; text: string; forward: boolean; findNext: boolean }
  | { type: 'find.close' }
  | { type: 'url.copy' }
  | { type: 'devtools.toggle' }
  | { type: 'zoom.in' }
  | { type: 'zoom.out' }
  | { type: 'zoom.reset' }
  | { type: 'open.external'; url: string }
  | { type: 'app.setDefaultBrowser' };

export const COMMAND_TYPES: ReadonlySet<string> = new Set<Command['type']>([
  'tab.navigate', 'tab.home', 'tab.duplicate', 'tab.mute', 'tab.contextmenu', 'space.contextmenu', 'space.rename',
  'nav.back', 'nav.forward', 'nav.reload', 'nav.stop',
  'palette.open', 'palette.close', 'find.open', 'find.query', 'find.close',
  'url.copy', 'devtools.toggle', 'zoom.in', 'zoom.out', 'zoom.reset', 'open.external', 'app.setDefaultBrowser',
]);

export type Message = Action | Command;

export function isCommand(m: Message): m is Command {
  return COMMAND_TYPES.has(m.type);
}

/** Messages from main to the overlay page */
export type OverlayMessage =
  | { kind: 'show'; mode: 'palette'; intent: 'new' | 'current'; query: string }
  | { kind: 'show'; mode: 'find' }
  | { kind: 'hide' }
  | { kind: 'find:result'; active: number; matches: number };

/** Messages from main to the sidebar page */
export type SidebarMessage =
  | { kind: 'space.renameStart'; id: SpaceId };

export interface ChordApi {
  platform: string;
  dispatch(message: Message): Promise<void>;
  getState(): Promise<State>;
  onState(cb: (state: State) => void): () => void;
  onOverlay(cb: (message: OverlayMessage) => void): () => void;
  onSidebar(cb: (message: SidebarMessage) => void): () => void;
}
