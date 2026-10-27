/** Picture-in-picture for the largest (preferably playing) video of a page; runs with a user gesture. */
export function PIP_JS(mode: 'toggle' | 'enter' | 'exit'): string {
  return `(async () => {
    const mode = ${JSON.stringify(mode)};
    if (document.pictureInPictureElement) {
      if (mode !== 'enter') await document.exitPictureInPicture().catch(() => {});
      return 'exit';
    }
    if (mode === 'exit') return 'none';
    const vids = Array.from(document.querySelectorAll('video')).filter((v) => v.readyState >= 2 && v.videoWidth > 0 && !v.disablePictureInPicture);
    vids.sort((a, b) => b.videoWidth * b.videoHeight - a.videoWidth * a.videoHeight);
    const v = vids.find((x) => !x.paused) ?? vids[0];
    if (!v) return 'none';
    try { await v.requestPictureInPicture(); return 'enter'; } catch (e) { return 'error: ' + e; }
  })()`;
}
