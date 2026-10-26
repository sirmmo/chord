import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Debounced, atomic JSON persistence. */
export class Store<T> {
  private pending: T | null = null;
  private timer: NodeJS.Timeout | null = null;

  private readonly file: string;
  private readonly delay: number;

  constructor(file: string, delay = 400) {
    this.file = file;
    this.delay = delay;
  }

  load(): unknown {
    try {
      return JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      return null;
    }
  }

  save(value: T): void {
    this.pending = value;
    if (!this.timer) this.timer = setTimeout(() => this.flush(), this.delay);
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending === null) return;
    const value = this.pending;
    this.pending = null;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      writeFileSync(tmp, JSON.stringify(value));
      renameSync(tmp, this.file);
    } catch (err) {
      console.error('Could not save state:', err);
    }
  }
}
