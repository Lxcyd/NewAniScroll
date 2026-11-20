import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useTranslation } from "react-i18next";
import { prettyFormat } from "@/components/anime/v2/helpers";
import { animeHref } from "@/lib/prefs/clickTarget";
import type { ProfileEntry } from "@/lib/profile/types";
import { useSheetPresence } from "./useSheetPresence";

/**
 * LA FICHE DU TITRE TIRÉ AU HASARD (20/11/2026, Luc, proposition 01 de
 * l'artefact des tirages). Au centre de l'écran, par-dessus la liste qui ne
 * bouge pas : affiche, titre, statut, progression ; « Regarder » ouvre
 * l'anime, « Relancer » tire un autre titre dans les mêmes résultats.
 */
export default function RandomReveal({
  entry,
  title,
  statusName,
  color,
  progress,
  onReroll,
  onClose,
}: {
  entry: ProfileEntry | null;
  title: string;
  statusName: string;
  color: string;
  progress: string;
  onReroll: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const open = !!entry;
  const { shown, closing } = useSheetPresence(open);
  /* Pendant la sortie, `entry` est déjà null : on garde le dernier affiché. */
  const last = useRef<{ entry: ProfileEntry; title: string; statusName: string; color: string; progress: string } | null>(null);
  if (entry) last.current = { entry, title, statusName, color, progress };
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCloseRef.current();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Même blocage du défilement que les autres feuilles (c'est <html> qui défile).
  useEffect(() => {
    if (!shown) return;
    const html = document.documentElement;
    const bar = window.innerWidth - html.clientWidth;
    const prev = [html.style.overflow, html.style.paddingRight];
    html.style.overflow = "hidden";
    if (bar > 0) html.style.paddingRight = `${bar}px`;
    return () => {
      [html.style.overflow, html.style.paddingRight] = prev;
    };
  }, [shown]);

  const v = last.current;
  if (!shown || !mounted || !v) return null;
  const e = v.entry;
  const sub = [e.format && prettyFormat(e.format), e.year, e.studio].filter(Boolean).join(" · ");
  /* L'adresse d'AniList TELLE QUELLE (20/11, Luc : « parfois l'image ne
     charge pas ») : pour les vieux titres, leur « large » EST le fichier du
     dossier /medium/, et le réécrire en /large/ donnait un 404 (Tokyo Ghoul). */
  const cover = e.cover || null;

  return createPortal(
    <div className={`as-sfp-overlay as-rr-overlay${closing ? " is-closing" : ""}`} onMouseDown={(ev) => ev.target === ev.currentTarget && onClose()}>
      <div className="as-rr" role="dialog" aria-modal="true" aria-label={t("listMenu.randomPick", { title: v.title })}>
        {cover ? <div className="as-rr-bg" style={{ backgroundImage: `url("${cover}")` }} aria-hidden /> : null}
        <button type="button" className="as-sfp-x as-rr-x" onClick={onClose} aria-label={t("listMenu.close")}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
        {/* La clé rejoue l'entrée à chaque relance. */}
        <div key={e.mediaId} className="as-rr-body">
          {cover ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={cover}
              alt=""
              width={210}
              height={298}
              className="as-rr-poster"
              // Une affiche introuvable laisse le cadre gris, pas l'icône d'image cassée.
              onError={(ev) => {
                ev.currentTarget.style.visibility = "hidden";
              }}
            />
          ) : (
            <div className="as-rr-poster" />
          )}
          <div className="as-rr-info">
            <span className="as-rr-eyebrow">{t("listMenu.random")}</span>
            <h3 title={v.title}>{v.title}</h3>
            <div className="as-rr-meta">
              <span className="as-rr-status" style={{ color: v.color, background: `${v.color}24`, boxShadow: `inset 0 0 0 1px ${v.color}66` }}>
                {v.statusName}
              </span>
              {sub ? <span className="as-rr-sub">{sub}</span> : null}
            </div>
            <div className="as-rr-meta">
              <span className="as-rr-chip">{v.progress}</span>
              {e.score ? <span className="as-rr-score">{e.score}</span> : null}
            </div>
            {/* Regarder et Plus d'infos sur une ligne, Relancer dessous
                (20/11, Luc). « Regarder » va TOUJOURS au lecteur, « Plus
                d'infos » à la fiche, quel que soit le réglage du clic. */}
            <div className="as-rr-actions">
              <Link href={animeHref(e.mediaId, "watch")} className="as-rr-go" onClick={onClose}>
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86A1 1 0 0 0 8 5.14z" /></svg>
                {t("listMenu.reveal.watch")}
              </Link>
              <Link href={animeHref(e.mediaId, "info")} className="as-rr-ghost" onClick={onClose}>
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 15a1 1 0 0 1-1-1v-4a1 1 0 0 1 2 0v4a1 1 0 0 1-1 1zm0-8a1.25 1.25 0 1 1 0-2.5A1.25 1.25 0 0 1 12 9z" /></svg>
                {t("preview.moreInfo")}
              </Link>
              <button type="button" className="as-rr-ghost as-rr-again" onClick={onReroll}>
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M15,20q-0.42,0-0.71-0.29Q14,19.43 14,19t0.29-0.71T15,18h1.6l-2.48-2.47q-0.3-0.3-0.29-0.71t0.31-0.71t0.71-0.3t0.71,0.3L18,16.55V15q0-0.43 0.29-0.71T19,14t0.71,0.29T20,15v4q0,0.43-0.29,0.71T19,20H15ZM4.3,19.7Q4.03,19.43 4.03,19T4.3,18.3L16.6,6H15q-0.42,0-0.71-0.29Q14,5.43 14,5t0.29-0.71T15,4h4q0.43,0 0.71,0.29T20,5V9q0,0.42-0.29,0.71T19,10T18.29,9.71T18,9V7.4L5.7,19.7Q5.43,19.98 5,19.98q-0.42,0-0.7-0.28ZM4.28,5.7Q4,5.43 4,5T4.28,4.3T4.96,4.02T5.68,4.3l4.2,4.18q0.28,0.28 0.29,0.69T9.88,9.88q-0.27,0.27-0.7,0.27T8.48,9.88L4.28,5.7Z" /></svg>
                {t("listMenu.reveal.reroll")}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
