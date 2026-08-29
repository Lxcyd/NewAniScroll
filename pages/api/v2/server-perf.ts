import type { NextApiRequest, NextApiResponse } from "next";
import SERVERS from "@/lib/servers";
import {
  ajouterMesures,
  estCritValide,
  estValeurPlausible,
  lirePerfPartagee,
  type CritPartage,
} from "@/lib/db/serverPerfShared";

/**
 * /api/v2/server-perf — le classement des lecteurs, mis en commun.
 *
 *   GET  → l'agregat de tous les visiteurs, pour servir de PRIOR a celui qui
 *          n'a encore rien mesure. Voir lib/db/serverPerfShared.ts.
 *   POST → depose les mesures d'une session. Echantillonne cote client, envoye
 *          par `sendBeacon` : ni attente, ni chemin critique.
 *
 * CACHE. Le GET est mis en cache d'edge une heure, avec une journee de
 * `stale-while-revalidate`. La charge de la base est donc constante quel que
 * soit le trafic — et c'est indispensable ici : la page de lecture est deja le
 * premier consommateur de quota du site.
 *
 * Le corps du GET est minuscule (~55 entrees, quelques centaines d'octets) et
 * ne depend d'AUCUN parametre : une seule cle de cache pour tout le monde.
 *
 * Asymetrie voulue : tout le monde LIT, seule la production ECRIT. Voir le
 * garde dans le POST.
 */

const MAX_CORPS = 2000; // octets — un depot fait quelques dizaines d'octets

type Depot = { server?: unknown; m?: unknown };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method === "GET") {
    const perf = await lirePerfPartagee();
    res.setHeader(
      "Cache-Control",
      "public, s-maxage=3600, stale-while-revalidate=86400",
    );
    return res.status(200).json({ s: perf });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).end();
  }

  /* SEULE la production alimente l'agregat, alors que TOUT LE MONDE le lit :
     dev.aniscroll.com et la production partagent la meme base Turso, et les
     deploiements de preview servent precisement a etre malmenes — compilations
     froides, Chrome headless de test, lecteurs volontairement casses. Ces
     mesures-la ne decrivent pas ce que vit un visiteur, et rien ne les
     distinguerait une fois fondues dans la moyenne.
     Refus SILENCIEUX (204) et non 403 : le client n'attend pas de reponse, et
     la preview doit se comporter exactement comme la production a ses yeux. */
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== "production") {
    return res.status(204).end();
  }

  /* Un depot rate n'a aucune consequence : la page n'attend pas la reponse, et
     l'agregat n'a pas besoin de CE visiteur-la. On refuse donc large et en
     silence plutot que d'expliquer — rien ici ne merite un aller-retour. */
  const brut: Depot =
    typeof req.body === "string"
      ? (() => {
          if (req.body.length > MAX_CORPS) return {};
          try {
            return JSON.parse(req.body);
          } catch {
            return {};
          }
        })()
      : req.body || {};

  const serverId = typeof brut.server === "string" ? brut.server : "";
  // Un id inconnu ne cree jamais de ligne : sans ce filtre, la table
  // accueillerait n'importe quelle chaine postee.
  if (!(SERVERS as { id: string }[]).some((s) => s.id === serverId)) {
    return res.status(204).end();
  }

  const source = brut.m;
  if (!source || typeof source !== "object") return res.status(204).end();

  const mesures: Partial<Record<CritPartage, number>> = {};
  for (const [c, v] of Object.entries(source as Record<string, unknown>)) {
    if (!estCritValide(c)) continue;
    if (!estValeurPlausible(c, v)) continue;
    mesures[c] = Number(v);
  }
  if (!Object.keys(mesures).length) return res.status(204).end();

  await ajouterMesures(serverId, mesures);
  // 204 et non 200 : le client n'a rien a lire, et `sendBeacon` ignore de toute
  // facon le corps de la reponse.
  return res.status(204).end();
}
