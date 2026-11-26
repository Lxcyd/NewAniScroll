/**
 * LES CHAMPS DU FILTRE DE LA LISTE, CHARGÉS PAR L'ONGLET (26/11/2026, passe
 * vitesse du profil).
 *
 * La page n'envoie plus, avec chaque entrée, tous ses tags, son état de
 * diffusion, sa source et son pays : 22 Ko compressés sur 105 pour un profil de
 * 693 animes, que seul le filtre de l'onglet Liste lit (cf. CHAMPS_FILTRE dans
 * pages/en/profile/[user].tsx). L'onglet les demande ici à son ouverture, à
 * la MÊME fonction serveur que la page (`?champs=1`) — mêmes contrôles de
 * compte et de profil privé —, et les recolle titre par titre.
 *
 * Tant qu'ils ne sont pas arrivés, le filtre fait comme avant avec ce qu'il a :
 * les tags principaux (`tags`) servent pour les tags, les sections diffusion,
 * source et pays n'apparaissent qu'avec leurs données. Une entrée qui porte
 * déjà ces champs (la liste vivante du propriétaire) n'est pas touchée.
 */
import { useEffect, useMemo, useState } from "react";
import type { ProfileEntry } from "./types";

type Champs = { d: string[]; c: Record<string, [number[] | null, string | null, string | null, string | null]> };

/** Une demande par profil et par chargement de page : l'onglet remonté la reprend. */
const enCours = new Map<string, Promise<Champs | null>>();

function charger(segment: string): Promise<Champs | null> {
  let p = enCours.get(segment);
  if (!p) {
    const build = (window as any).__NEXT_DATA__?.buildId;
    const q = new URLSearchParams({ user: segment, champs: "1" });
    p = build
      ? fetch(`/_next/data/${build}/en/profile/${encodeURIComponent(segment)}.json?${q}`, {
          credentials: "same-origin",
          headers: { "x-nextjs-data": "1" },
        })
          .then((r) => (r.ok ? r.json() : null))
          .then((j) => (j?.pageProps?.champs as Champs | undefined) ?? null)
          .catch(() => null)
      : Promise.resolve(null);
    /* Un échec (réseau, déploiement entre-temps) n'est pas retenu : le
       prochain montage de l'onglet réessaie. */
    p.then((v) => {
      if (!v) enCours.delete(segment);
    });
    enCours.set(segment, p);
  }
  return p;
}

export function useListFields(entries: ProfileEntry[], segment: string | null | undefined): ProfileEntry[] {
  const [champs, setChamps] = useState<Champs | null>(null);
  useEffect(() => {
    if (!segment) return;
    let live = true;
    charger(segment).then((v) => {
      if (live && v) setChamps(v);
    });
    return () => {
      live = false;
    };
  }, [segment]);
  return useMemo(() => {
    if (!champs) return entries;
    const { d, c } = champs;
    return entries.map((e) => {
      const x = c[e.mediaId];
      if (!x || "airStatus" in e || "allTags" in e) return e;
      const [tags, airStatus, source, country] = x;
      return {
        ...e,
        ...(tags ? { allTags: tags.map((i) => d[i]) } : {}),
        airStatus,
        source,
        country,
      } as ProfileEntry;
    });
  }, [entries, champs]);
}
