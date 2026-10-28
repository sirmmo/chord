import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { AiStatus, ChordApi, McpStatus, SourcesStatus, UpdateStatus, DownloadsStatus, ExtensionsStatus, HistoryQuery, PasskeysStatus, PasswordsStatus, ResearchStatus, SmartStatus, Message, OverlayMessage, SidebarMessage, State } from '../shared/types.ts';

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
};

contextBridge.exposeInMainWorld('chord', api);
