import { CSSProperties, ReactNode } from "react";
import Skeleton from "react-loading-skeleton";
import { AniListInfoTypes } from "types/info/AnilistInfoTypes";
import Link from "next/link";
import Image from "next/image";
import { useTranslation } from "react-i18next";
import {
  statusLabel,
  parseDescription,
  listLabel,
  LIST_COLORS,
  STATUS_TO_LIST,
} from "@/components/anime/v2/helpers";
import { genreLabel } from "@/lib/i18n/genreLabel";
import { useTranslatedText } from "@/lib/i18n/useTranslatedText";

/* Chips, copied VALUE FOR VALUE from the info page's hero (Hero.tsx
 * hStyles.genreChip / studioChip).
 *
 * They have to be inline styles, not Tailwind classes: `action` is declared in
 * tailwind.config.js as `var(--brand-primary, …)` — a complete colour, not the
 * channel triplet Tailwind needs to inject an alpha. So `bg-action/[0.12]` and
 * `border-action/[0.35]` compile to NOTHING at all, which is why these chips
 * came out as hard red outlines on no background instead of the soft tinted
 * pills the info page shows. color-mix() does the tinting instead, exactly as
 * the info page does it. */
const GENRE_CHIP: CSSProperties = {
  padding: "5px 11px",
  background: "color-mix(in srgb, var(--brand-primary, #ff3b5c) 12%, transparent)",
  border: "1px solid color-mix(in srgb, var(--brand-primary, #ff3b5c) 35%, transparent)",
  borderRadius: 999,
  color: "color-mix(in srgb, var(--brand-primary, #ff7a91) 75%, #fff)",
  fontSize: 12,
  fontWeight: 600,
};

const STUDIO_CHIP: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "5px 11px",
  background: "rgba(74,143,255,0.1)",
  border: "1px solid rgba(74,143,255,0.3)",
  borderRadius: 999,
  color: "#7ec8ff",
  fontSize: 12,
  fontWeight: 600,
};

type DetailsProps = {
  info: AniListInfoTypes;
  epiNumber: number;
  description: string;
  /** Statut de liste AniList ("CURRENT", "PLANNING", …) ou null hors liste. */
  listStatus: string | null;
  /** false tant que le statut n'est pas connu — le bouton affiche « … »
   *  plutot que d'annoncer « Ajouter a la liste » a tort. */
  listResolved: boolean;
  /** Ouvre l'editeur de liste, exactement comme le bouton de la page d'info. */
  onOpenListEditor: () => void;
  /** Title shown at the top of the card — the page owns it because it also
   *  knows the episode being played. */
  title?: ReactNode;
  /** Secondary action buttons (party / share / report) rendered under the
   *  add-to-list CTA. The page keeps their handlers; we only place them. */
  actions?: ReactNode;
};

export default function Details({
  info,
  epiNumber,
  description,
  listStatus,
  listResolved,
  onOpenListEditor,
  title,
  actions,
}: DetailsProps) {
  const { t, i18n } = useTranslation();

  // Same treatment as the info page's Overview: strip the "(Source: …)" tail
  // out of the body and show it as an attribution line, rather than leaving
  // it mid-paragraph.
  const parsed = parseDescription(description);
  // Auto-translate the synopsis into the active UI language (server-cached).
  const localizedDesc = useTranslatedText(parsed.text);

  // (The effect that used to reset the "Read more" fold on episode change is
  // gone with the fold itself — there is no expansion state left to reset.)

  // "#278" — AniList's all-time RATED position. Only shown when AniList
  // actually ranks the entry; a computed rank would be a fabrication.
  const rank = info?.rankings?.find(
    (r: any) => r.type === "RATED" && r.allTime,
  )?.rank;
  const score = info?.averageScore ? (info.averageScore / 10).toFixed(2) : null;
  const studio = info?.studios?.edges?.[0]?.node?.name;

  // Bouton de liste : la MEME lecture que la page d'info (Hero.tsx) — pastille
  // coloree, libelle du statut, chevron — pour que le meme anime ne se presente
  // pas d'une facon ici et d'une autre la-bas.
  const list = (listStatus && STATUS_TO_LIST[listStatus]) || "Add to List";
  const listColor = LIST_COLORS[list] || "#8a8fa3";
  const listDisplay = listResolved ? listLabel(t, list) : "…";

  // Episode count, read exactly as the info page reads it: while a show is
  // AIRING the total alone would overstate what you can actually watch, so it
  // becomes "aired/total". `nextAiringEpisode.episode` is the NEXT one to air.
  const airedSoFar = info?.nextAiringEpisode?.episode
    ? Math.max(0, info.nextAiringEpisode.episode - 1)
    : null;
  const epLabel =
    info?.status === "RELEASING"
      ? airedSoFar != null && info?.episodes
        ? `${airedSoFar}/${info.episodes}`
        : airedSoFar != null
          ? `${airedSoFar}+`
          : info?.episodes
            ? `${info.episodes}`
            : "N/A"
      : info?.episodes
        ? `${info.episodes}`
        : "N/A";
  const durLabel = info?.duration ? `EP · ${info.duration}min` : "EP";

  return (
    // `relative z-10`: the player's ambient glow is a positioned layer that
    // overflows well past the player box. A non-positioned sibling paints
    // UNDER it, which is what veiled the add-to-list button — the glow was
    // literally on top of it. Giving the card its own positioned layer puts
    // the light back where it belongs, behind the controls.
    // `font-karla` : rien ici ne declarait de famille, donc tout ce que j'ai
    // repris de la page d'info (stats, pastilles, synopsis, boutons) tombait
    // sur la sans-serif systeme — visiblement etrangere au reste du site, qui
    // est en Karla. La page d'info a son propre Inter parce qu'elle porte ses
    // tokens ; ici c'est la police du site qui fait foi.
    //
    // A partir de `lg` la fiche reprend les DEUX COLONNES DE LA PAGE
    // (`grid-cols-[subgrid]`) plutot que d'inventer les siennes : jaquette et
    // texte tiennent dans la colonne du lecteur — le synopsis s'arrete donc
    // pile au bord droit de la barre de serveurs — et les boutons se placent
    // dans celle de la liste d'episodes. Ces deux largeurs dependent de la
    // hauteur de l'ecran (voir la grille de la page), aucune valeur en dur ne
    // pourrait suivre.
    //
    // Le synopsis etait par ailleurs un bloc pleine largeur SOUS la rangee :
    // la jaquette s'arretait a mi-hauteur de la fiche. Il est desormais dans
    // la colonne de texte, sous les genres, et la jaquette descend jusqu'en bas.
    <div className="relative z-10 flex flex-col gap-5 font-karla lg:col-span-2 lg:grid lg:grid-cols-[subgrid] lg:items-stretch lg:gap-0">
      <div className="flex flex-wrap gap-5 lg:col-start-1 lg:grid lg:grid-cols-[190px_minmax(0,1fr)] lg:items-stretch lg:gap-7">
        {/* The box carries the size, not the <Image>. next/image renders an
            <img> with width=1000, so without a sized parent it stretches to
            the row's full width — object-cover then shows a wide band of the
            portrait cover (it reads as a banner) and the blown-up flex item
            pushes the rest of the card over the episode column. */}
        <div className="h-[190px] w-[132px] shrink-0 overflow-hidden rounded-poster shadow-poster lg:h-full lg:w-full">
          {info ? (
            <Link href={`/en/anime/${info.id}`} className="block h-full w-full">
              <Image
                src={info.coverImage.extraLarge}
                alt="Anime Cover"
                width={1000}
                height={1000}
                className="h-full w-full object-cover duration-300 ease-out hover:scale-[1.03]"
              />
            </Link>
          ) : (
            <Skeleton height={190} width={132} />
          )}
        </div>

        <div className="flex min-w-0 grow basis-[300px] flex-col gap-3 lg:basis-auto">
          {title}

          {/* Stat blocks, identical to the info page's hero (Hero.tsx): same
              icons, same metric, same caption underneath. The previous version
              invented its own row — a chevron for POPULARITY where the info
              page shows a heart for FAVOURITES — so the same anime reported two
              different numbers depending on the page you were on. */}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
            {score && (
              <>
                <div className="flex flex-col items-center text-center">
                  <div className="flex items-center gap-2">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="#f6c544">
                      <polygon points="12 2 15 9 22 9 17 14 19 21 12 17 5 21 7 14 2 9 9 9" />
                    </svg>
                    <span className="text-[22px] font-bold leading-none text-[#f6c544]">
                      {score}
                    </span>
                    <span className="text-[11.5px] font-medium text-[#8a8fa3]">/10</span>
                  </div>
                  <div className="mt-1.5 text-[10px] font-semibold tracking-[0.1em] text-[#5e6478]">
                    {rank ? t("anime.rated", { rank }) : t("anime.average")}
                  </div>
                </div>
                <div className="h-10 w-px bg-[#252938]" />
              </>
            )}

            {info?.favourites != null && (
              <>
                <div className="flex flex-col items-center text-center">
                  <div className="flex items-center gap-2">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="#ff3b5c">
                      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
                    </svg>
                    {/* Formatted against the ACTIVE UI language, never the
                        ambient one — see the long note in Hero.tsx: a bare
                        toLocaleString() makes Node and a French browser
                        disagree and costs a full hydration re-render. */}
                    <span className="text-[22px] font-bold leading-none text-[#f4f5f8]">
                      {info.favourites.toLocaleString(i18n.language)}
                    </span>
                  </div>
                  <div className="mt-1.5 text-[10px] font-semibold tracking-[0.1em] text-[#5e6478]">
                    FAVORITES
                  </div>
                </div>
                <div className="h-10 w-px bg-[#252938]" />
              </>
            )}

            <div className="flex flex-col items-center text-center">
              <div className="flex items-center gap-2 text-[#c4c8d4]">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <rect x="3" y="5" width="18" height="14" rx="2" />
                  <path d="m10 9 5 3-5 3z" fill="currentColor" />
                </svg>
                <span className="text-[22px] font-bold leading-none text-[#f4f5f8]">
                  {epLabel}
                </span>
                <span className="text-[11.5px] font-medium text-[#8a8fa3]">{durLabel}</span>
              </div>
              {info?.status && (
                <div className="mt-1.5 text-[10px] font-semibold tracking-[0.1em] text-[#5e6478]">
                  {statusLabel(t, info.status).toUpperCase()}
                </div>
              )}
            </div>
          </div>

          {/* Same chip vocabulary as the info page's hero: brand-tinted pills
              for genres, then a hairline, then the studio in blue. The order
              matters — the studio is the aside, not the headline. */}
          <div className="flex flex-wrap items-center gap-2">
            {info?.genres?.slice(0, 4).map((item, index) => (
              <span key={index} style={GENRE_CHIP}>
                {genreLabel(t, item)}
              </span>
            ))}
            {studio && (
              <>
                <span className="h-4 w-px bg-[#2f3447]" />
                <span style={STUDIO_CHIP}>{studio}</span>
              </>
            )}
          </div>

          {/* Synopsis — info-page typography (14px / 1.65, --txt-1) on the same
              panel treatment as the rest of the card. Shown WHOLE: there is no
              "read more" fold. The page is already scrolled past the player by
              anyone reading this far, and a fold on a paragraph of four lines
              bought nothing but a click. */}
          <div className="mt-1 rounded-xl bg-as-card/60 ring-1 ring-white/[0.06]">
            {info && (
              <div className="p-5">
                <p
                  className="m-0 text-sm leading-[1.65] text-[#c4c8d4]"
                  style={{ textWrap: "pretty" } as any}
                  dangerouslySetInnerHTML={{ __html: localizedDesc }}
                />
                {parsed.source && (
                  <div className="mt-2.5 text-[11px] text-[#5e6478]">
                    <em>
                      {t("anime.source")} · {parsed.source}
                    </em>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Colonne d'action. Le bouton de liste est celui de la page d'info,
          repris tel quel : pastille du statut, libelle du statut, chevron, et
          l'editeur complet derriere — et non plus un « + Ajouter a la liste »
          a sens unique, qui ne savait que passer en « Planning » et ne disait
          rien de ce que l'anime etait deja pour vous. */}
      {/* `lg:pl-4` : la grille de la page n'a pas de gouttiere — la liste
          d'episodes cree la sienne avec son `left-4`. Sans ce meme retrait les
          boutons se colleraient au synopsis au lieu de s'aligner sur la liste.
          Le `max-w` les empeche de s'etaler sur toute une colonne large. */}
      <aside className="flex w-full flex-col gap-2.5 lg:col-start-2 lg:max-w-[21rem] lg:self-start lg:pl-4">
        <button
          type="button"
          onClick={onOpenListEditor}
          style={{
            background: `${listColor}1a`,
            border: `1px solid ${listColor}66`,
            color: listColor,
          }}
          className="flex w-full items-center gap-3 rounded-[13px] px-5 py-[17px] text-base font-semibold transition-[filter] hover:brightness-125"
        >
          <span
            className="h-[9px] w-[9px] shrink-0 rounded-full"
            style={{
              background: listColor,
              boxShadow: `0 0 6px ${listColor}b3, 0 0 2px ${listColor}`,
            }}
          />
          <span className="flex-1 text-left">{listDisplay}</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
        {actions}
      </aside>
    </div>
  );
}
