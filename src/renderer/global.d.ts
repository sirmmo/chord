import type { ChordApi } from '../shared/types.ts';

declare global {
  interface Window {
    chord: ChordApi;
  }
}

export {};
