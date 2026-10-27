import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { ChordApi, DownloadsStatus, ExtensionsStatus, HistoryQuery, SmartStatus, Message, OverlayMessage, SidebarMessage, State } from '../shared/types.ts';

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
};

contextBridge.exposeInMainWorld('chord', api);
