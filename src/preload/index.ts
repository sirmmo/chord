import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { AiStatus, ChordApi, ConnectedStatus, CuratedStatus, McpStatus, SourcesStatus, UpdateStatus, DownloadsStatus, EaselStatus, ExtensionsStatus, HistoryQuery, PasskeysStatus, PasswordsStatus, ResearchStatus, SmartStatus, Message, OverlayMessage, SidebarMessage, LittleStatus, ReaderQuery, ReaderStatus, State, SyncStatus } from '../shared/types.ts';

const listen =
  <T>(channel: string) =>
  (cb: (payload: T) => void) => {
    const handler = (_event: IpcRendererEvent, payload: T) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => {
      ipcRenderer.off(channel, handler);
    };
  };

const api: ChordApi = {
  platform: process.platform,
  dispatch: (message: Message) => ipcRenderer.invoke('dispatch', message),
  getState: () => ipcRenderer.invoke('state'),
  onState: listen<State>('state'),
  onOverlay: listen<OverlayMessage>('overlay'),
  onSidebar: listen<SidebarMessage>('sidebar'),
  onExtensions: listen<ExtensionsStatus>('extensions'),
  getExtensions: () => ipcRenderer.invoke('extensions'),
  onSmart: listen<SmartStatus>('smart'),
  getSmart: () => ipcRenderer.invoke('smart'),
  onDownloads: listen<DownloadsStatus>('downloads'),
  getDownloads: () => ipcRenderer.invoke('downloads'),
  onHistory: listen<{ total: number }>('history'),
  getHistory: (query: HistoryQuery) => ipcRenderer.invoke('history', query),
  getInfo: () => ipcRenderer.invoke('info'),
  onUpdates: listen<UpdateStatus>('updates'),
  getUpdates: () => ipcRenderer.invoke('updates'),
  onMcp: listen<McpStatus>('mcp'),
  getMcp: () => ipcRenderer.invoke('mcp'),
  onPasswords: listen<PasswordsStatus>('passwords'),
  getPasswords: () => ipcRenderer.invoke('passwords'),
  revealPassword: (id: string) => ipcRenderer.invoke('passwords:reveal', id),
  onPasskeys: listen<PasskeysStatus>('passkeys'),
  getPasskeys: () => ipcRenderer.invoke('passkeys'),
  onResearch: listen<ResearchStatus>('research'),
  getResearch: (spaceId: string) => ipcRenderer.invoke('research', spaceId),
  onAi: listen<AiStatus>('ai'),
  getAi: (spaceId: string) => ipcRenderer.invoke('ai', spaceId),
  onSources: listen<SourcesStatus>('sources'),
  getSources: (spaceId: string) => ipcRenderer.invoke('sources', spaceId),
  onCurated: listen<CuratedStatus>('curated'),
  getCurated: (spaceId: string) => ipcRenderer.invoke('curated', spaceId),
  onSync: listen<SyncStatus>('sync'),
  getSync: () => ipcRenderer.invoke('sync'),
  onConnected: listen<ConnectedStatus>('connected'),
  getConnected: () => ipcRenderer.invoke('connected'),
  onLittle: listen<LittleStatus>('little'),
  onPeek: listen<LittleStatus>('peek'),
  onEasels: listen<EaselStatus>('easels'),
  getEasels: () => ipcRenderer.invoke('easels'),
  onReader: listen<ReaderStatus>('reader'),
  getReader: () => ipcRenderer.invoke('reader'),
  getReaderItems: (query: ReaderQuery) => ipcRenderer.invoke('reader:items', query),
};

contextBridge.exposeInMainWorld('chord', api);
