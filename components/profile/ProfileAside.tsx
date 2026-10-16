import { useTranslation } from "react-i18next";
import FramedAvatar from "./FramedAvatar";
import FeaturedBadges from "./FeaturedBadges";

import type { HeroStat } from "./ProfileHero";

/**
 * L'identité en COLONNE — l'agencement « column » du studio.
 *
 * Le haut de profil se réduit alors à une plaque, et tout ce qui identifie
 * quelqu'un descend ici : portrait, nom, badges, chiffres. La colonne est
 * collante (`sticky`), donc elle reste lisible pendant qu'on parcourt les
 * widgets à sa droite — c'est ce qui justifie de la sortir du bandeau : une
 * identité qui disparaît au premier défilement n'avait pas besoin d'une
 * colonne à elle.
 *
 * Les chiffres forment une grille 2 × 2 séparée par des filets, sans cadre à
 * eux : quatre cartes dans une colonne de 18 rem redeviendraient une pile de
 * boîtes, et la carte du dessous porte déjà le cadre. Ils étaient d'abord
 * empilés en lignes « libellé / valeur » ; à 18 rem, la valeur en `text-lg`
 * et l'intitulé à 10 px faisaient une liste tassée qu'on ne lisait pas
 * (15/10/2026). En grille, chaque chiffre a la largeur d'une demi-colonne et
 * se lit en grand.
 */
export default function ProfileAside({
  name,
  tag,
  avatar,
  anilistName,
  createdAt,
  stats,
  subtitle,
  frame,
  avatarScale = 100,
  nameScale = 100,
  badges,
  earned,
  badgeScale = 100,
}: {
  /** La taille des badges mis en avant, en % — le réglage du studio. */
  badgeScale?: number;
  /** Les badges mis en avant, et ceux obtenus qui les filtrent. */
  badges?: string[];
  earned?: Record<string, number> | null;
  /** Tailles de l'avatar et du pseudo, en % — le réglage du studio. */
  avatarScale?: number;
  nameScale?: number;
  name: string;
  tag?: string | null;
  avatar?: string | null;
  /** Cadre d'avatar (décoration Discord), ou rien. */
  frame?: string | null;
  anilistName?: string | null;
  createdAt?: number | null;
  stats: HeroStat[];
  subtitle?: string | null;
}) {
  const { t, i18n } = useTranslation();

  return (
    <aside
      className="as-stat-card sticky top-24 flex w-full flex-col overflow-hidden rounded-2xl ring-1 ring-white/10"
      style={{ "--as-av": avatarScale / 100, "--as-nm": nameScale / 100 } as React.CSSProperties}
    >
      <div className="flex flex-col items-center gap-4 px-5 pb-5 pt-7 text-center">
        <FramedAvatar
          src={avatar}
          name={name}
          frame={frame}
          priority
          px={256}
          sizeClass="h-[calc(7rem*var(--as-av,1))] w-[calc(7rem*var(--as-av,1))]"
          textClass="text-4xl"
        />
        <div className="min-w-0 w-full">
          {/* À la ligne plutôt que tronqué : un pseudo se lit en entier. */}
          <h1 className="break-words font-outfit text-[length:calc(1.65rem*var(--as-nm,1))] font-bold leading-tight">
            {name}
          </h1>
          <FeaturedBadges ids={badges} earned={earned} size={Math.round(44 * (badgeScale / 100))} className="mt-3 justify-center gap-2" />
          <div className="mt-2.5 flex flex-wrap items-center justify-center gap-1.5 text-[11px]">
            {tag ? (
              <span className="rounded-md bg-black/40 px-2 py-1 font-mono text-white/60 ring-1 ring-white/10">
                #{tag}
              </span>
            ) : null}
            {anilistName ? (
              <a
                href={`https://anilist.co/user/${anilistName}`}
                target="_blank"
                rel="noreferrer"
                className="rounded-md bg-[#02a9ff]/20 px-2 py-1 font-bold text-[#5ac8ff] ring-1 ring-[#02a9ff]/30 transition-colors hover:bg-[#02a9ff]/30"
              >
                AniList · {anilistName}
              </a>
            ) : null}
          </div>
          {createdAt ? (
            <p className="mt-2.5 text-[11px] text-white/45">
              {/* Formatée contre la langue ACTIVE, en UTC — mêmes raisons, et le
                  même prix quand on l'oublie, que dans ProfileHero. */}
              {t("profile.memberSince", {
                date: new Date(createdAt).toLocaleDateString(i18n.language, {
                  month: "long",
                  year: "numeric",
                  timeZone: "UTC",
                }),
              })}
            </p>
          ) : null}
          {subtitle ? <p className="mt-1 text-xs text-white/50">{subtitle}</p> : null}
        </div>
      </div>

      {stats.length > 0 ? (
        <dl className="grid grid-cols-2 border-t border-white/10">
          {stats.map((s, i) => (
            <div
              key={s.key}
              className={`flex flex-col-reverse items-center gap-1.5 px-4 py-4 text-center ${i % 2 ? "border-l border-white/10" : ""} ${
                i >= 2 ? "border-t border-white/10" : ""
              }`}
            >
              <dt className="text-[10px] font-bold uppercase tracking-wider text-white/45">
                {s.label}
              </dt>
              <dd
                className={`font-outfit text-2xl font-bold leading-none tabular-nums ${
                  s.accent ? "text-action" : "text-white"
                }`}
              >
                {s.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </aside>
  );
}
