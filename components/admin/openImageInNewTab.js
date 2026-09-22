/**
 * Open a base64 data URL in a new browser tab. Going through `<a href>` is
 * unreliable on large data URLs (Chrome / Opera land you on about:blank).
 * Converting to a Blob URL first makes the new-tab open reliably.
 */
export default function openImageInNewTab(dataUrl) {
  try {
    const [meta, b64] = dataUrl.split(",");
    if (!b64) return;
    const mime = (meta.match(/data:([^;]+);base64/) || [])[1] || "image/png";
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const blob = new Blob([buf], { type: mime });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener,noreferrer");
    // Don't revoke immediately — give the new tab time to load.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch {}
}
