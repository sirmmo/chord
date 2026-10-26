import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { ChordApi, Message, OverlayMessage, SidebarMessage, State } from '../shared/types.ts';

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
};

contextBridge.exposeInMainWorld('chord', api);
