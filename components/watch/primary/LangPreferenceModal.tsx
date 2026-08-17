/**
 * Popup de classement des langues de lecture.
 *
 * Affichee UNE fois, au premier episode ouvert (la page de lecture la declenche
 * quand `getLangOrder()` vaut `null`), et re-ouvrable depuis Reglages > Lecteur.
 *
 * Trois cartes — doublage VF, VOSTFR, lecteur multi-langue — posees sous des
 * numeros FIXES 1-2-3. On deplace une carte sous le numero voulu (drag, ou les
 * fleches pour le tactile / le clavier) : l'ordre obtenu devient l'ordre d'essai
 * des lecteurs (cf. lib/prefs/langPref.ts).
 *
 * Fermeture: pas de sortie « sans reponse ». Le bouton valide l'ordre affiche,
 * donc meme un utilisateur pressé repart avec un classement explicite plutot
 * qu'avec une popup qui reviendrait a chaque episode.
 */

import { useEffect, useState } from "react";
import { Reorder } from "framer-motion";
import { useTranslation } from "react-i18next";
import { MdRecordVoiceOver, MdSubtitles, MdTranslate } from "react-icons/md";
import {
  DEFAULT_LANG_ORDER,
  getLangOrder,
  setLangOrder,
  type Lang,
} from "@/lib/prefs/langPref";

const CARDS: Record<
  Lang,
  { icon: React.ComponentType<{ className?: string }>; flag: string; titleKey: string; descKey: string }
> = {
  vf: {
    icon: MdRecordVoiceOver,
    flag: "🇫🇷",
    titleKey: "player.langPref.vfTitle",
    descKey: "player.langPref.vfDesc",
  },
  vo: {
    icon: MdSubtitles,
    flag: "🇫🇷",
    titleKey: "player.langPref.voTitle",
    descKey: "player.langPref.voDesc",
  },
  multi: {
    icon: MdTranslate,
    flag: "🌐",
    titleKey: "player.langPref.multiTitle",
    descKey: "player.langPref.multiDesc",
  },
};

function Card({
  lang,
  onMove,
  canLeft,
  canRight,
}: {
  lang: Lang;
  onMove: (dir: -1 | 1) => void;
  canLeft: boolean;
  canRight: boolean;
}) {
  const { t } = useTranslation();
  const card = CARDS[lang];
  const Icon = card.icon;

  return (
    <Reorder.Item
      as="div"
      value={lang}
      whileDrag={{ scale: 1.04, zIndex: 10 }}
      className="flex-1 basis-0 min-w-0 cursor-grab active:cursor-grabbing select-none rounded-xl bg-white/5 ring-1 ring-white/10 p-4 flex flex-col items-center text-center gap-2 hover:bg-white/10 hover:ring-action/40 transition"
    >
      <span className="relative grid place-items-center w-12 h-12 rounded-xl bg-white/5 ring-1 ring-white/10 text-action">
        <Icon className="w-7 h-7" />
        <span className="absolute -bottom-1 -right-1 text-sm leading-none">
          {card.flag}
        </span>
      </span>
      <span className="text-sm font-medium font-outfit">{t(card.titleKey)}</span>
      <span className="text-[11px] leading-snug text-white/55 font-karla">
        {t(card.descKey)}
      </span>

      {/* Repli tactile/clavier du glisser-deposer. */}
      <span className="flex items-center gap-1 pt-1">
        <button
          type="button"
          disabled={!canLeft}
          aria-label={t("player.langPref.moveLeft") as string}
          onClick={() => onMove(-1)}
          className="w-7 h-7 grid place-items-center rounded-md bg-white/5 ring-1 ring-white/10 text-white/70 hover:bg-white/15 disabled:opacity-25 disabled:hover:bg-white/5"
        >
          ‹
        </button>
        <button
          type="button"
          disabled={!canRight}
          aria-label={t("player.langPref.moveRight") as string}
          onClick={() => onMove(1)}
          className="w-7 h-7 grid place-items-center rounded-md bg-white/5 ring-1 ring-white/10 text-white/70 hover:bg-white/15 disabled:opacity-25 disabled:hover:bg-white/5"
        >
          ›
        </button>
      </span>
    </Reorder.Item>
  );
}

export default function LangPreferenceModal({
  open,
  onSave,
}: {
  open: boolean;
  /** Recoit l'ordre valide — deja persiste quand le callback est appele. */
  onSave?: (order: Lang[]) => void;
}) {
  const { t } = useTranslation();
  const [order, setOrder] = useState<Lang[]>(DEFAULT_LANG_ORDER);

  // Re-ouverture (Reglages) : repartir du classement enregistre, pas du defaut.
  useEffect(() => {
    if (open) setOrder(getLangOrder() || DEFAULT_LANG_ORDER);
  }, [open]);

  if (!open) return null;

  const move = (lang: Lang, dir: -1 | 1) => {
    setOrder((prev) => {
      const i = prev.indexOf(lang);
      const j = i + dir;
      if (i === -1 || j < 0 || j >= prev.length) return prev;
      const next = prev.slice();
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };

  const save = () => {
    setLangOrder(order);
    onSave?.(order);
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 px-4">
      <div className="w-full max-w-2xl rounded-xl bg-secondary ring-1 ring-white/10 p-6">
        <h3 className="text-lg font-semibold font-outfit mb-1">
          {t("player.langPref.title")}
        </h3>
        <p className="text-white/60 text-sm mb-5 font-karla">
          {t("player.langPref.body")}
        </p>

        {/* Numeros FIXES : ils ne bougent pas, ce sont les cartes qui glissent
            dessous. Meme grille 3 colonnes que la liste pour rester alignes. */}
        <div className="flex gap-3 mb-2">
          {[1, 2, 3].map((n) => (
            <div key={n} className="flex-1 basis-0 flex justify-center">
              <span className="grid place-items-center w-7 h-7 rounded-full bg-action/20 text-action text-sm font-semibold ring-1 ring-action/40">
                {n}
              </span>
            </div>
          ))}
        </div>

        <Reorder.Group
          as="div"
          axis="x"
          values={order}
          onReorder={setOrder}
          className="flex gap-3 items-stretch"
        >
          {order.map((lang, i) => (
            <Card
              key={lang}
              lang={lang}
              canLeft={i > 0}
              canRight={i < order.length - 1}
              onMove={(dir) => move(lang, dir)}
            />
          ))}
        </Reorder.Group>

        <p className="text-white/40 text-xs mt-4 font-karla">
          {t("player.langPref.hint")}
        </p>

        <div className="flex justify-end mt-5">
          <button
            type="button"
            onClick={save}
            className="rounded-lg bg-action px-4 py-2 text-sm font-medium text-white transition hover:brightness-110"
          >
            {t("player.langPref.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
