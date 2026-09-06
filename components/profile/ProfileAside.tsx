import Image from "next/image";
import { useTranslation } from "react-i18next";

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
 * Les chiffres y sont empilés en lignes « libellé / valeur » plutôt qu'en
 * cartes : quatre cadres dans une colonne de 18 rem redeviendraient une pile de
 * boîtes, et la carte du dessous porte déjà le cadre.
 */
export default function ProfileAside({
  name,
  tag,
  avatar,
  anilistName,
  createdAt,
  stats,
  subtitle,
}: {
  name: string;
  tag?: string | null;
  avatar?: string | null;
  anilistName?: string | null;
  createdAt?: number | null;
  stats: HeroStat[];
  subtitle?: string | null;
}) {
  const { t, i18n } = useTranslation();

  return (
    <aside className="as-stat-card sticky top-24 flex w-full flex-col gap-4 rounded-2xl p-4 ring-1 ring-white/10">
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="rounded-[1.35rem] bg-gradient-to-br from-as-accent to-as-accent2 p-[3px] shadow-glow">
          {avatar ? (
            <Image
              src={avatar}
              alt={name}
              width={128}
              height={128}
              priority
              className="h-24 w-24 rounded-[1.2rem] object-cover"
            />
          ) : (
            <div className="flex h-24 w-24 items-center justify-center rounded-[1.2rem] bg-primary text-3xl font-bold text-white/80">
              {name.charAt(0).toUpperCase()}
            </div>
          )}
        </div>
        <div className="min-w-0 w-full">
          <h1 className="truncate font-outfit text-2xl font-bold leading-tight">{name}</h1>
          <div className="mt-2 flex flex-wrap items-center justify-center gap-1.5 text-[11px]">
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
            <p className="mt-1.5 text-[11px] text-white/45">
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
        <dl className="flex flex-col gap-1.5 border-t border-white/10 pt-3">
          {stats.map((s) => (
            <div key={s.key} className="flex items-baseline justify-between gap-3">
              <dt className="text-[10px] font-bold uppercase tracking-wider text-white/40">
                {s.label}
              </dt>
              <dd
                className={`font-outfit text-lg font-bold leading-none ${
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
