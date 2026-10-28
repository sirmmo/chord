// Pure helpers for the built-in passkey provider.

/** WebAuthn's rule: the relying party ID must equal the page's host or be a registrable suffix of it. */
export function rpIdMatches(host: string, rpId: string): boolean {
  const h = host.toLowerCase();
  const r = rpId.toLowerCase();
  if (!r || !h) return false;
  if (h === r) return true;
  if (!h.endsWith(`.${r}`)) return false;
  // not a bare public suffix: "co.uk" or "com" cannot be relying party ids
  const labels = r.split('.');
  if (labels.length < 2) return false;
  if (labels.length === 2 && labels[0].length <= 3 && labels[1].length === 2) return false;
  return true;
}

export const b64url = (b64: string): string => b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const fromB64url = (s: string): string => {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  return t + '='.repeat((4 - (t.length % 4)) % 4);
};
