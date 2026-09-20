/**
 * Le manifeste, demande AVANT que hls.js n'existe — et servi depuis la memoire.
 *
 * Chronologie mesuree le 20/09/2026 (ansembed, profil neuf) : l'extraction rend
 * l'adresse du master, puis le lecteur monte, puis hls.js se reveille et
 * demande ce master — 1 a 3 s rien que pour lui sur le CDN vidmoly, suivis de
 * la variante. Or l'adresse est connue des la fin de l'extraction : ces deux
 * allers-retours peuvent courir PENDANT le montage du lecteur, voire pendant
 * que la personne lit encore la page info.
 *
 * D'ou ce petit magasin, et un `loader` hls.js qui le consulte. On ne pouvait
 * pas se contenter du cache HTTP du navigateur : ces reponses sont servies sans
 * en-tete de cache utilisable, et une seconde requete repartirait sur le
 * reseau.
 *
 * Ce qu'on NE fait pas : garder longtemps. Le jeton du master est lie a l'IP et
 * a l'instant ; au-dela de PEREMPTION_MS l'entree est jetee et hls.js refait sa
 * requete normalement. Mieux vaut un aller-retour qu'un manifeste perime.
 */

import { bandwidthKey, pickStartVariant } from "./hlsBandwidth";

const PEREMPTION_MS = 30_000;

type Entree = { texte: string; at: number };

const magasin = new Map<string, Entree>();
const enVol = new Map<string, Promise<string | null>>();

function frais(e: Entree | undefined): e is Entree {
  return !!e && Date.now() - e.at < PEREMPTION_MS;
}

/** Va chercher un manifeste et le garde. Sans effet s'il est deja en memoire. */
export function prechargeManifeste(url: string): void {
  if (typeof window === "undefined" || !url) return;
  if (frais(magasin.get(url)) || enVol.has(url)) return;
  const p = fetch(url, { referrerPolicy: "no-referrer", priority: "high" } as any)
    .then(async (r) => {
      if (!r.ok) return null;
      const texte = await r.text();
      if (!/^\s*#EXTM3U/.test(texte)) return null;
      magasin.set(url, { texte, at: Date.now() });
      /* Et la variante dans la foulee : un master ne se joue pas, il annonce.
         hls.js demanderait ensuite la playlist du niveau choisi — un
         aller-retour de plus sur le meme CDN lent. On prend celle qu'il
         choisira (meme calcul que son ABR au demarrage, cf. pickStartVariant)
         pendant qu'il n'existe pas encore. */
      const variante = pickStartVariant(texte, bandwidthKey(url, true));
      if (variante) {
        try {
          prechargeManifeste(new URL(variante, url).toString());
        } catch {
          /* URI relative illisible : hls.js s'en chargera */
        }
      }
      return texte;
    })
    .catch(() => null)
    .finally(() => {
      enVol.delete(url);
    });
  enVol.set(url, p);
}

/** Le texte deja en memoire pour cette adresse, ou `null`. */
export function manifesteEnMemoire(url: string): string | null {
  const e = magasin.get(url);
  return frais(e) ? e.texte : null;
}

/**
 * Le `loader` a donner a hls.js : il sert depuis la memoire quand il peut, et
 * delegue tout le reste (segments compris) au chargeur d'origine. Ecrit comme
 * une sous-classe pour ne rien avoir a reimplementer — hls.js appelle `load`
 * avec ses propres rappels, et on se contente de repondre a sa place.
 */
export function fabriqueLoader(Hls: any) {
  const Base = Hls.DefaultConfig.loader;
  return class LoaderAvecMemoire extends Base {
    load(contexte: any, config: any, rappels: any) {
      const texte = contexte?.url ? manifesteEnMemoire(contexte.url) : null;
      // Les playlists seulement : un segment est binaire et ne passe pas par
      // ce magasin.
      if (texte && contexte.responseType !== "arraybuffer") {
        const debut = performance.now();
        const stats = {
          ...(this.stats || {}),
          loading: { start: debut, first: debut, end: debut },
          parsing: { start: debut, end: debut },
          total: texte.length,
          loaded: texte.length,
          retry: 0,
          chunkCount: 0,
          bwEstimate: 0,
          aborted: false,
        };
        // Asynchrone : hls.js n'attend pas d'etre rappele depuis son propre
        // appel a `load` (il pose ses gestionnaires juste apres).
        Promise.resolve().then(() => {
          rappels.onSuccess(
            { url: contexte.url, data: texte },
            stats,
            contexte,
            null,
          );
        });
        return;
      }
      super.load(contexte, config, rappels);
    }
  };
}
