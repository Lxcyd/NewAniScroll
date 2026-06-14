import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

/**
 * "Share card" — renders a polished image of the current anime on a <canvas>
 * (cover + title + meta), then offers it via the native share sheet (with the
 * file on supporting browsers) or a PNG download. Pure client-side, no deps.
 */

type ShareInfo = {
  id: number;
  title: string;
  coverImage?: string | null;
  bannerImage?: string | null;
  score?: number | null; // AniList averageScore 0-100
  year?: number | null;
  genres?: string[];
  format?: string | null;
  episodes?: number | null;
};

const W = 1200;
const H = 630; // OG-card ratio

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/** Cover-fit draw of `img` into the rect (like CSS object-fit: cover). */
function drawCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const ir = img.width / img.height;
  const rr = w / h;
  let sw = img.width;
  let sh = img.height;
  let sx = 0;
  let sy = 0;
  if (ir > rr) {
    sw = img.height * rr;
    sx = (img.width - sw) / 2;
  } else {
    sh = img.width / rr;
    sy = (img.height - sh) / 2;
  }
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = w;
      if (lines.length === maxLines - 1) break;
    } else {
      line = test;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  // Ellipsize if we ran out of room.
  if (lines.length === maxLines) {
    let last = lines[maxLines - 1];
    while (ctx.measureText(`${last}…`).width > maxWidth && last.length > 1) {
      last = last.slice(0, -1);
    }
    lines[maxLines - 1] = last !== text ? `${last}…` : last;
  }
  return lines;
}

async function buildCard(info: ShareInfo, accent: string): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  // Background: dark base + blurred banner/cover if available.
  ctx.fillStyle = "#0b0d14";
  ctx.fillRect(0, 0, W, H);
  const bgSrc = info.bannerImage || info.coverImage;
  if (bgSrc) {
    try {
      const bg = await loadImage(bgSrc);
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.filter = "blur(8px)";
      drawCover(ctx, bg, -20, -20, W + 40, H + 40);
      ctx.restore();
    } catch {
      /* CORS / load failure — plain background is fine */
    }
  }
  // Darkening gradient for text legibility.
  const grad = ctx.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, "rgba(6,8,14,0.95)");
  grad.addColorStop(0.6, "rgba(6,8,14,0.6)");
  grad.addColorStop(1, "rgba(6,8,14,0.2)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Poster (left).
  const pad = 56;
  const posterW = 300;
  const posterH = 430;
  if (info.coverImage) {
    try {
      const cover = await loadImage(info.coverImage);
      const px = pad;
      const py = (H - posterH) / 2;
      ctx.save();
      // rounded rect clip
      const r = 16;
      ctx.beginPath();
      ctx.moveTo(px + r, py);
      ctx.arcTo(px + posterW, py, px + posterW, py + posterH, r);
      ctx.arcTo(px + posterW, py + posterH, px, py + posterH, r);
      ctx.arcTo(px, py + posterH, px, py, r);
      ctx.arcTo(px, py, px + posterW, py, r);
      ctx.closePath();
      ctx.shadowColor = "rgba(0,0,0,0.5)";
      ctx.shadowBlur = 30;
      ctx.shadowOffsetY = 10;
      ctx.fill();
      ctx.shadowColor = "transparent";
      ctx.clip();
      drawCover(ctx, cover, px, py, posterW, posterH);
      ctx.restore();
    } catch {
      /* skip poster on failure */
    }
  }

  // Text column (right of poster).
  const tx = pad + posterW + 48;
  const tw = W - tx - pad;

  // Brand tag.
  ctx.fillStyle = accent;
  ctx.font = "700 26px Outfit, Arial, sans-serif";
  ctx.fillText("ANISCROLL", tx, 130);

  // Title (wrapped, up to 3 lines).
  ctx.fillStyle = "#ffffff";
  ctx.font = "800 58px Outfit, Arial, sans-serif";
  const titleLines = wrapText(ctx, info.title, tw, 3);
  let cy = 200;
  for (const line of titleLines) {
    ctx.fillText(line, tx, cy);
    cy += 70;
  }

  // Meta line: year · format · episodes.
  const meta: string[] = [];
  if (info.year) meta.push(String(info.year));
  if (info.format) meta.push(info.format);
  if (info.episodes) meta.push(`${info.episodes} ep`);
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.font = "500 30px Karla, Arial, sans-serif";
  if (meta.length) {
    ctx.fillText(meta.join("   ·   "), tx, cy + 16);
    cy += 56;
  }

  // Genres chips.
  if (info.genres?.length) {
    let gx = tx;
    const gy = cy + 18;
    ctx.font = "600 24px Karla, Arial, sans-serif";
    for (const g of info.genres.slice(0, 3)) {
      const pwid = ctx.measureText(g).width + 36;
      ctx.fillStyle = "rgba(255,255,255,0.1)";
      ctx.beginPath();
      const rr = 20;
      ctx.moveTo(gx + rr, gy);
      ctx.arcTo(gx + pwid, gy, gx + pwid, gy + 40, rr);
      ctx.arcTo(gx + pwid, gy + 40, gx, gy + 40, rr);
      ctx.arcTo(gx, gy + 40, gx, gy, rr);
      ctx.arcTo(gx, gy, gx + pwid, gy, rr);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fillText(g, gx + 18, gy + 28);
      gx += pwid + 14;
    }
    cy = gy + 40;
  }

  // Score badge (bottom-right).
  if (typeof info.score === "number" && info.score > 0) {
    ctx.fillStyle = accent;
    ctx.font = "800 64px Outfit, Arial, sans-serif";
    const sTxt = `${(info.score / 10).toFixed(1)}`;
    const sw = ctx.measureText(sTxt).width;
    ctx.fillText(sTxt, W - pad - sw, H - 64);
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.font = "600 24px Karla, Arial, sans-serif";
    ctx.fillText("/ 10", W - pad - sw + sw + 8, H - 64);
  }

  return await new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/png", 0.92),
  );
}

export default function ShareCardButton({
  info,
  accent = "#E94560",
  style,
}: {
  info: ShareInfo;
  accent?: string;
  style?: React.CSSProperties;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);

  const onClick = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const blob = await buildCard(info, accent);
      if (!blob) throw new Error("render failed");
      const filename = `${info.title.replace(/[^\w]+/g, "_").slice(0, 50)}_aniscroll.png`;
      const file = new File([blob], filename, { type: "image/png" });

      // Prefer the native share sheet WITH the file (mobile); fall back to a
      // plain download.
      const nav = navigator as any;
      if (nav.canShare && nav.canShare({ files: [file] })) {
        await nav.share({ files: [file], title: info.title }).catch(() => {});
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
        toast.success(t("shareCard.downloaded"));
      }
    } catch {
      toast.error(t("shareCard.failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <button onClick={onClick} disabled={busy} title={t("shareCard.button")} style={style}>
      {/* Material "image" icon */}
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <polyline points="21 15 16 10 5 21" />
      </svg>
      {t("shareCard.button")}
    </button>
  );
}
