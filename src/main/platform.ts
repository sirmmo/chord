import { PAD } from '../shared/layout.ts';

export const isMac = process.platform === 'darwin';

/** Height of the native window-controls overlay drawn by Windows and Linux. */
export const TITLEBAR_HEIGHT = 36;

/** Where the content area starts: below the window controls on Windows and Linux. */
export const TOP_INSET = isMac ? PAD : TITLEBAR_HEIGHT;

/** Height of the optional address bar row, including its bottom gap. */
export const ADDRESS_BAR_HEIGHT = 44;
