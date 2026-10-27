import type { BrowserWindow } from 'electron';
import type { Space, SpaceId, TabId } from '../shared/types.ts';
import { activeSpace, spaceById } from '../shared/model.ts';
import type { Controller } from './controller.ts';
import { Overlay } from './overlay.ts';
import { PanelManager } from './panel.ts';

/**
 * One Chord window: a BrowserWindow showing the sidebar page, the space it
 * currently displays, and the overlay and side panel layered over it. A space
 * is shown in at most one window at a time; the focused window's space is the
 * state's active space.
 */
export class ChordWindow {
  readonly id: number;
  readonly win: BrowserWindow;
  readonly overlay: Overlay;
  readonly panel: PanelManager;
  spaceId: SpaceId;
  /** the pane that last received keyboard focus in this window */
  lastFocused: TabId | null = null;

  private readonly c: Controller;

  constructor(c: Controller, win: BrowserWindow, spaceId: SpaceId) {
    this.c = c;
    this.id = win.id;
    this.win = win;
    this.spaceId = spaceId;
    this.overlay = new Overlay(c, this);
    this.panel = new PanelManager(c, this);
  }

  get space(): Space {
    return spaceById(this.c.state, this.spaceId) ?? activeSpace(this.c.state);
  }

  alive(): boolean {
    return !this.win.isDestroyed();
  }
}
