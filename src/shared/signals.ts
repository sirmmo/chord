// Signals a page gives away in its title: unread counts and running timers.
// Pure, so the sidebar and the main process agree and it can be unit-tested.

import type { TimerInfo } from './types.ts';

const UNREAD_LEADING = /^\s*[([]\s*(\d{1,3})\+?\s*[)\]]/;
const UNREAD_ANYWHERE = /[([]\s*(\d{1,3})\+?\s*[)\]]/;
const UNREAD_DOT = /^\s*(\d{1,3})\s*[•·]/;
const CLOCK = /(?:^|[\s(])(\d{1,2}:\d{2}(?::\d{2})?)(?=$|[\s)|•·–-])/;
const PERCENT = /(?:^|[\s(])(\d{1,3})\s?%/;

export function parseTitleSignals(title: string): { unread?: number; timer?: TimerInfo } {
  const out: { unread?: number; timer?: TimerInfo } = {};
  const unread = UNREAD_LEADING.exec(title) ?? UNREAD_DOT.exec(title) ?? UNREAD_ANYWHERE.exec(title);
  if (unread) out.unread = Number(unread[1]);
  const clock = CLOCK.exec(title);
  const pct = PERCENT.exec(title);
  if (clock || pct) {
    const progress = pct ? Math.min(100, Number(pct[1])) / 100 : null;
    out.timer = { text: clock ? clock[1] : `${pct![1]}%`, progress };
  }
  return out;
}
