import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { SpaceLock } from '../shared/types.ts';

// Passwords for private spaces: scrypt with a random salt, never stored in clear.

export function makeLock(password: string): SpaceLock {
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: scryptSync(password, salt, 32).toString('hex') };
}

export function verifyLock(lock: SpaceLock, password: string): boolean {
  try {
    const expected = Buffer.from(lock.hash, 'hex');
    const actual = scryptSync(password, lock.salt, expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
