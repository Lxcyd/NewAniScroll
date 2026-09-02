import { useEffect } from "react";
import { useTranslation } from "react-i18next";

/**
 * Les réglages d'un widget, au centre de l'écran.
 *
 * MÊME FENÊTRE QUE L'ÉDITEUR DE LISTE (components/listEditor.tsx) : un fond
 * noir flouté, une carte centrée, et surtout un EN-TÊTE ILLUSTRÉ — là-bas la
 * bannière de l'anime sous un dégradé qui la fond dans la carte, ici la couleur
 * du bloc, qui est déjà son repère dans la grille et dans la bibliothèque. On
 * sait ce qu'on règle avant d'avoir lu le titre.
 *
 * ELLE A REMPLACÉ UN PANNEAU POSÉ DANS LA CARTE. Une carte de widget fait
 * parfois une colonne de large, coupe ce qui dépasse et se déplace sous le
 * curseur : le panneau y était à l'étroit, tronqué, et il suivait le bloc.
 *
 * Le composant ne connaît aucun bloc : il reçoit des interrupteurs déjà
 * traduits et déjà résolus à leur état, il rend des bascules. Un bloc qui n'a
 * rien à régler le DIT — c'est ce qui autorise la roue dentée à être offerte
 * sur toutes les cartes plutôt que sur quelques-unes.
 */

export type WidgetOption = { key: string; label: string; on: boolean };

type Props = {
  /** `null` : rien d'ouvert. */
  block: {
    id: string;
    title: string;
    color: string;
    icon: string;
    options: WidgetOption[];
  } | null;
  onOption: (key: string, on: boolean) => void;
  onClose: () => void;
};

export default function WidgetSettings({ block, onOption, onClose }: Props) {
  const { t } = useTranslation();

  // Échap ferme, comme toutes les autres surfaces modales du site.
  useEffect(() => {
    if (!block) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [block, onClose]);

  if (!block) return null;

  return (
    <div
      /* Au-dessus de la bibliothèque de blocs (z-60) : les deux ne s'ouvrent
         jamais ensemble, mais celle-ci se lance depuis la grille, donc c'est
         elle qui doit être devant si l'ordre venait à changer. */
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm sm:p-7"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-3xl bg-[#12131a] ring-1 ring-white/10 shadow-[0_40px_90px_rgba(0,0,0,0.7)]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t("profile.widgets.settings")}
      >
        {/* L'en-tête coloré. Le dégradé descend jusqu'au fond exact de la carte
            (#12131a) plutôt que vers du transparent : sans quoi la couleur
            s'arrête sur une ligne au lieu de s'y fondre. */}
        <div
          className="relative px-5 pb-4 pt-5"
          style={{
            background: `linear-gradient(to bottom, ${block.color}2e 0%, ${block.color}12 45%, #12131a 100%)`,
          }}
        >
          <div className="flex items-start gap-3.5">
            <span
              className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-xl text-base ring-1"
              style={{
                color: block.color,
                background: `${block.color}22`,
                borderColor: `${block.color}55`,
              }}
            >
              {block.icon}
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-karla text-[11px] font-bold uppercase tracking-[0.14em] text-white/40">
                {t("profile.widgets.settings")}
              </p>
              <h2 className="mt-0.5 truncate font-outfit text-xl font-bold tracking-tight text-white">
                {block.title}
              </h2>
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
        </div>

        <div className="px-5 pb-5">
          {block.options.length ? (
            <div className="flex flex-col gap-1.5">
              {block.options.map((o) => (
                <button
                  key={o.key}
                  type="button"
                  role="switch"
                  aria-checked={o.on}
                  onClick={() => onOption(o.key, !o.on)}
                  className="flex w-full items-center justify-between gap-4 rounded-2xl bg-white/[0.03] px-4 py-3 text-left ring-1 ring-white/[0.07] transition-colors hover:bg-white/[0.06]"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block font-outfit text-sm font-bold text-white">
                      {o.label}
                    </span>
                    <span className="mt-0.5 block font-karla text-[11px] leading-relaxed text-white/45">
                      {t(`profile.widgets.options.${o.key}Desc`)}
                    </span>
                  </span>
                  {/* L'interrupteur des réglages du site. */}
                  <span
                    className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                      o.on ? "bg-action" : "bg-white/15"
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
                        o.on ? "translate-x-[18px]" : "translate-x-0.5"
                      }`}
                    />
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="rounded-2xl bg-white/[0.03] px-4 py-5 text-center font-karla text-xs leading-relaxed text-white/40 ring-1 ring-white/[0.07]">
              {t("profile.widgets.noOptions")}
            </p>
          )}

          <div className="mt-5 flex justify-end">
            <button
              type="button"
              onClick={onClose}
              className="rounded-full bg-action px-5 py-2 font-karla text-xs font-bold text-white shadow-glow transition-transform hover:scale-105"
            >
              {t("profile.widgets.done")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
