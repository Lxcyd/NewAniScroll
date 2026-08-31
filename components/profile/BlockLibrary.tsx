import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import type { BlockDef } from "@/lib/profile/blocks";

/**
 * La bibliothèque de blocs : ce qu'on peut poser sur son profil.
 *
 * Un clic pose ou retire — pas de panier, pas de confirmation : la grille se
 * réorganise sous la fenêtre et le bloc réapparaît d'un second clic.
 *
 * Les blocs sans source (cf. lib/profile/blocks.ts) sont proposés comme les
 * autres, avec leur avertissement : c'est ce qui permet de voir la mise en page
 * finale d'un profil sans qu'aucun chiffre ne mente.
 */

type Props = {
  open: boolean;
  onClose: () => void;
  blocks: BlockDef[];
  posed: Set<string>;
  onToggle: (id: string) => void;
  onRearrange: () => void;
  onReset: () => void;
};

export default function BlockLibrary({
  open,
  onClose,
  blocks,
  posed,
  onToggle,
  onRearrange,
  onReset,
}: Props) {
  const { t } = useTranslation();

  // Échap ferme, comme toutes les autres surfaces modales du site.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm sm:p-7"
      onClick={onClose}
    >
      <div
        className="max-h-[82vh] w-full max-w-3xl overflow-auto rounded-3xl bg-[#12131a] p-6 ring-1 ring-white/10 shadow-[0_40px_90px_rgba(0,0,0,0.7)]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h2 className="font-outfit text-xl font-bold tracking-tight text-white">
              {t("profile.library.title")}
            </h2>
            <p className="mt-1.5 font-karla text-xs text-white/45">
              {t("profile.library.desc")}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("profile.library.close")}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/5 text-white/60 ring-1 ring-white/10 transition-colors hover:text-white hover:ring-white/30"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="h-3.5 w-3.5">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {blocks.map((b) => {
            const added = posed.has(b.id);
            return (
              <button
                key={b.id}
                type="button"
                onClick={() => onToggle(b.id)}
                className={`flex items-start gap-3.5 rounded-2xl px-4 py-3.5 text-left ring-1 transition-colors ${
                  added
                    ? "bg-white/[0.02] ring-white/[0.07] hover:ring-white/20"
                    : "bg-white/[0.04] ring-action/30 hover:ring-action"
                }`}
              >
                <span
                  className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[11px] text-[15px] ring-1"
                  style={{
                    color: b.color,
                    background: `${b.color}22`,
                    borderColor: `${b.color}44`,
                  }}
                >
                  {b.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-outfit text-sm font-bold text-white">
                    {t(`profile.blocks.${b.id}.title`)}
                  </span>
                  <span className="mt-1 block font-karla text-[11px] leading-relaxed text-white/45">
                    {t(`profile.blocks.${b.id}.desc`)}
                  </span>
                  {b.source === "soon" ? (
                    <span className="mt-1.5 inline-block rounded-full bg-white/5 px-2 py-0.5 font-karla text-[10px] font-bold text-white/40">
                      {t("profile.library.noData")}
                    </span>
                  ) : null}
                </span>
                <span
                  className={`shrink-0 rounded-full px-2.5 py-1 font-karla text-[11px] font-bold ${
                    added ? "bg-white/[0.06] text-white/40" : "bg-action text-white"
                  }`}
                >
                  {added ? t("profile.library.added") : t("profile.library.add")}
                </span>
              </button>
            );
          })}
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.08] pt-4">
          <span className="font-karla text-xs text-white/40">
            {t("profile.library.count", { count: posed.size })}
          </span>
          <div className="flex gap-2.5">
            <button
              type="button"
              onClick={onReset}
              className="rounded-full bg-white/5 px-4 py-2 font-karla text-xs font-bold text-white/65 ring-1 ring-white/10 transition-colors hover:text-white"
            >
              {t("profile.widgets.reset")}
            </button>
            <button
              type="button"
              onClick={onRearrange}
              className="rounded-full bg-action px-4 py-2 font-karla text-xs font-bold text-white shadow-glow"
            >
              {t("profile.widgets.rearrange")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
