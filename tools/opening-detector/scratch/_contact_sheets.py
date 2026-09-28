"""Planches-contact des timings OP/ED, pour les verifier a l'oeil sans lecteur.

Pour chaque (episode, langue, hote, OP|ED) d'une sortie de `batch_detect.py`,
une image de 3 rangees, horodatees en temps ABSOLU de l'encode de cet hote
(celui qu'affiche le lecteur) :

  1. DEBUT  : 9 images, de debut-4 s a debut+4 s, pas de 1 s ;
  2. MILIEU : 9 images reparties dans le segment ;
  3. FIN    : 9 images, de fin-4 s a fin+4 s.

L'image la plus proche du bord detecte est encadree (vert = debut, rouge =
fin). Ce qu'on doit y lire : une coupe nette « scene -> generique » entre la 4e
et la 5e image de la rangee 1, une sequence de generique (credits, logo) dans
la rangee 2, et la coupe inverse en rangee 3.

Les flux viennent du meme pont que le detecteur (`resolve_episodes`, cache
d'URL de 6 h) et se decodent avec ses propres options ffmpeg (Referer, drapeaux
HLS, deballage megaplay) : on regarde exactement ce que le detecteur a vu.

Usage :
  python scratch/_contact_sheets.py out/v3/gt10.jsonl datasets/anime.gt10.json \
      out/v3/sheets [--only MAL:EP] [--workers 3]
Sortie : un PNG par cellule + `index.json` (cellule -> fichier, timings).
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from oped.adapter_aniscroll import resolve_episodes  # noqa: E402
from oped.audio import _container_start, _hls_flags, _input_headers  # noqa: E402
from oped.hls_cache import local_mp4, local_window  # noqa: E402
from oped.megaplay import is_megaplay, materialize_window  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _build_gt_cells import encode_groups  # noqa: E402

W, H = 240, 135          # une vignette
LABEL = 18               # bandeau d'horodatage sous chaque vignette
COLS = 9
FONT = ImageFont.truetype("C:/Windows/Fonts/consola.ttf", 14)
FONT_BIG = ImageFont.truetype("C:/Windows/Fonts/segoeui.ttf", 20)
_PTS = re.compile(r"\[Parsed_showinfo[^\]]*\].*?pts_time:\s*([-\d.]+)")


def mmss(t: float) -> str:
    sign = "-" if t < 0 else ""
    t = round(abs(t), 1)
    return f"{sign}{int(t // 60)}:{t % 60:04.1f}"


def decode(src: str, referer: str | None, t0: float, t1: float,
           fps: float | None = None) -> list[tuple[float, Image.Image]]:
    """Toutes les images de [t0, t1] (ou `fps` par seconde), avec leur pts absolu."""
    t0 = max(0.0, t0)
    seek = t0
    # Meme fenetre locale que le detecteur (segments deja en cache apres le lot).
    # 12 s de marge AVANT : sur vmpx/megaplay un segment ne commence pas
    # toujours sur une image-cle, et sans elle les images d'avant le bord —
    # celles qui disent si la coupe est juste — sortaient toutes manquantes.
    lead = min(12.0, t0)
    local = (local_window(src, t0 - lead, t1 - t0 + lead, referer=referer, want="video")
             or local_mp4(src, referer=referer))
    if local is None and is_megaplay(src, referer):
        local = materialize_window(src, t0 - lead, t1 - t0 + lead, referer=referer)
    select = ""
    if local is not None and not local.endswith("full.mp4"):
        # Fenetre HLS concatenee (MPEG-TS sans index) : `-ss` en entree y
        # atterrit jusqu'a ~4,5 s APRES la cible (mesure 28/09, Frieren ep28
        # vmpx) et les images d'avant le bord disparaissent. La fenetre est
        # courte : on la decode entiere et on filtre sur l'horodatage absolu.
        src, referer = local, None
        cmd = ["ffmpeg", "-hide_banner", "-loglevel", "info", "-copyts", "-i", src]
        select = f"select='between(t\\,{t0:.3f}\\,{t1:.3f})',"
    else:
        if local is not None:
            src, referer = local, None
            seek = max(0.0, t0 - _container_start(src))
        cmd = ["ffmpeg", "-hide_banner", "-loglevel", "info"]
        cmd += _input_headers(src, referer) + _hls_flags(src)
        cmd += ["-copyts", "-ss", f"{seek:.3f}", "-to", f"{seek + (t1 - t0):.3f}", "-i", src]
    cmd += ["-fps_mode", "passthrough"]
    chain = f"{select}scale={W}:{H},showinfo"
    cmd += ["-vf", chain if fps is None else f"fps={fps},{chain}",
            "-an", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    p = subprocess.run(cmd, capture_output=True, timeout=600)
    if p.returncode != 0:
        raise RuntimeError(p.stderr.decode("utf-8", "replace")[-600:])
    size = W * H * 3
    times = [float(x) for x in _PTS.findall(p.stderr.decode("utf-8", "replace"))]
    n = min(len(times), len(p.stdout) // size)
    return [(times[i], Image.frombytes("RGB", (W, H), p.stdout[i * size:(i + 1) * size]))
            for i in range(n)]


def nearest(frames, targets):
    out = []
    for t in targets:
        if not frames:
            out.append(None)
            continue
        out.append(min(frames, key=lambda f: abs(f[0] - t)))
    return out


def sheet(title: str, rows: list[tuple[str, list, float | None, str | None]]) -> Image.Image:
    head = 34
    rh = H + LABEL + 26
    img = Image.new("RGB", (COLS * W, head + rh * len(rows)), (18, 18, 18))
    d = ImageDraw.Draw(img)
    d.text((8, 4), title, font=FONT_BIG, fill=(240, 240, 240))
    for r, (name, frames, mark_t, colour) in enumerate(rows):
        y = head + r * rh
        d.text((6, y + 3), name, font=FONT, fill=(200, 200, 120))
        y += 22
        marked = None
        if mark_t is not None:
            real = [f for f in frames if f]
            if real:
                marked = min(real, key=lambda f: abs(f[0] - mark_t))
        for c, f in enumerate(frames[:COLS]):
            x = c * W
            if f is None:
                d.rectangle([x, y, x + W - 1, y + H - 1], outline=(70, 70, 70))
                continue
            t, im = f
            img.paste(im, (x, y))
            d.text((x + 4, y + H + 1), mmss(t), font=FONT, fill=(230, 230, 230))
            if f is marked:
                col = (40, 220, 60) if colour == "start" else (230, 50, 50)
                for k in range(3):
                    d.rectangle([x + k, y + k, x + W - 1 - k, y + H - 1 - k], outline=col)
    return img


def cell_sheet(title, url, referer, start, end, dst: Path) -> None:
    s_fr = decode(url, referer, start - 4.5, start + 4.6)
    e_fr = decode(url, referer, end - 4.5, end + 4.6)
    mid_t = [start + (end - start) * (i + 1) / (COLS + 1) for i in range(COLS)]
    span = max(1.0, end - start - 6)
    m_fr = decode(url, referer, start + 3, end - 3, fps=COLS / span)
    rows = [
        (f"DEBUT detecte {mmss(start)}  (de -4 s a +4 s)",
         nearest(s_fr, [start + k for k in range(-4, 5)]), start, "start"),
        (f"DANS LE SEGMENT ({end - start:.0f} s)", nearest(m_fr, mid_t), None, None),
        (f"FIN detectee {mmss(end)}  (de -4 s a +4 s)",
         nearest(e_fr, [end + k for k in range(-4, 5)]), end, "end"),
    ]
    sheet(title, rows).save(dst, optimize=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("jsonl")
    ap.add_argument("anime_list")
    ap.add_argument("out_dir")
    ap.add_argument("--only", help="MAL:EP, pour une seule cellule")
    ap.add_argument("--workers", type=int, default=3)
    a = ap.parse_args()
    out = Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    animes = {x["mal_id"]: x for x in json.loads(Path(a.anime_list).read_text("utf-8"))}

    jobs = []
    for line in open(a.jsonl, encoding="utf-8"):
        if not line.strip():
            continue
        row = json.loads(line)
        mal, ep, lang = row["mal_id"], row["episode"], row["lang"]
        if a.only and a.only != f"{mal}:{ep}":
            continue
        anime = animes.get(mal)
        if not anime:
            continue
        season = next((s for s in anime["seasons"] if s["lang"] == lang), None)
        if not season:
            continue
        # Une planche par GROUPE d'encodage (son premier lecteur) : c'est
        # l'unite de verdict de la page.
        for kind in ("op", "ed"):
            for g in encode_groups(row, kind)[0]:
                host = g["hosts"][0]
                jobs.append((anime, season, ep, lang, host, kind, row["per_host"][host][kind]))

    index = {}
    idx_file = out / "index.json"
    if idx_file.exists():
        index = json.loads(idx_file.read_text("utf-8"))

    def run(job):
        anime, season, ep, lang, host, kind, hit = job
        key = f"{anime['mal_id']}_{ep}_{lang}_{host}_{kind}"
        dst = out / f"{key}.png"
        start, end = float(hit["start"]), float(hit["end"])
        if not dst.exists():
            eps = resolve_episodes(
                anime["slug"], season["season_dir"], lang, ep, ep, host_pref=host,
                mal_id=anime["mal_id"],
                va_slug=season.get("va_slug") or anime.get("va_slug") or anime["slug"],
                frembed=season.get("frembed"),
            )
            e = eps[0]
            title = (f"{anime.get('title', anime['slug'])} — ep {ep} {lang.upper()} — "
                     f"{host} — {kind.upper()} {mmss(start)} → {mmss(end)} "
                     f"[{hit.get('source')}]")
            cell_sheet(title, e["url"], e.get("referer"), start, end, dst)
        return key, {"file": dst.name, "mal_id": anime["mal_id"], "episode": ep,
                     "lang": lang, "host": host, "kind": kind,
                     "start": start, "end": end, "source": hit.get("source")}

    with ThreadPoolExecutor(max_workers=a.workers) as pool:
        for job, fut in [(j, pool.submit(run, j)) for j in jobs]:
            try:
                key, meta = fut.result()
                index[key] = meta
                print(f"  ok  {key}")
            except Exception as exc:  # une cellule ratee ne bloque pas les autres
                print(f"  ECHEC {job[0]['mal_id']} ep{job[2]} {job[3]} {job[4]} {job[5]}: "
                      f"{type(exc).__name__}: {str(exc)[:200]}")
    idx_file.write_text(json.dumps(index, ensure_ascii=False, indent=1), "utf-8")


if __name__ == "__main__":
    main()
