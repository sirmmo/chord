/** Compare two dotted versions ("0.16.0", "v1.2.3-beta"): negative when a < b, 0 when equal, positive when a > b. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?/.exec(v.trim());
    return { nums: m ? m[1].split('.').map(Number) : [0], pre: m?.[2] ?? '' };
  };
  const x = parse(a);
  const y = parse(b);
  const n = Math.max(x.nums.length, y.nums.length);
  for (let i = 0; i < n; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  // a release beats its own pre-release; two pre-releases compare as strings
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** Pick the release asset that matches this build, from a list of asset names. */
export function assetFor(names: string[], channel: string): string | undefined {
  const want: Record<string, RegExp> = {
    mac: /-mac-(universal|arm64)\.dmg$/,
    nsis: /-win-x64-setup\.exe$/,
    portable: /-win-x64-portable\.zip$/,
    appimage: /\.AppImage$/,
    deb: /\.deb$/,
  };
  const re = want[channel];
  if (!re) return undefined;
  return names.find((n) => re.test(n)) ?? (channel === 'mac' ? names.find((n) => /-mac-x64\.dmg$/.test(n)) : undefined);
}
