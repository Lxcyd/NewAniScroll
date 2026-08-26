import type { NextApiRequest, NextApiResponse } from "next";
import {
  getSeasonRuntimes,
  putRuntime,
  isPlausibleRuntime,
} from "@/lib/db/episodeRuntimes";
import { serverToHost, isDisplayedHost } from "@/lib/hostRegistry";

/**
 * Durees d'episode PAR LECTEUR.
 *
 *   GET  /api/v2/runtimes/{malId}?server={serverId}          -> { host, lang, runtimes }
 *   GET  /api/v2/runtimes/{malId}?host={host}&lang={lang}    (idem, sans passer par servers.js)
 *   POST /api/v2/runtimes/{malId}  { episode, seconds, server | host+lang }
 *
 * Le GET rend la SAISON ENTIERE en un appel : `{ "1": 1420, "2": 1418, … }`.
 * C'est le point de la route. Avant, chaque ligne d'episode visible allait
 * chercher sa duree chez AniSkip depuis le navigateur — N requetes par visiteur,
 * jamais partagees, et contre un encodage qui n'etait pas celui du lecteur
 * actif. Ici c'est une lecture Turso indexee, cachee au CDN : la quasi-totalite
 * des visiteurs ne reveille meme pas la fonction.
 *
 * Le POST est le mecanisme d'auto-correction. Le lecteur connait la duree du
 * fichier qu'il vient d'ouvrir, sur l'hote exact : c'est la mesure de reference,
 * gratuite. Le client ne l'envoie que si elle DIVERGE de ce qu'on avait (ou
 * qu'on n'avait rien), donc un episode stable ne genere aucune ecriture. C'est
 * ce qui repond a « si la video a change / si le timing n'est plus bon » sans
 * re-sonder quoi que ce soit a l'aveugle.
 *
 * Zero Upstash des deux cotes.
 */

/** 6 h au CDN : une correction par un lecteur doit pouvoir atteindre les autres
 *  visiteurs dans la journee. Le client qui corrige, lui, a deja la bonne valeur
 *  sous les yeux — elle vient de son propre lecteur. */
const CACHE = "public, max-age=0, s-maxage=21600, stale-while-revalidate=86400";

/** (host, lang) demande, depuis `server=` (servers.js) ou explicitement. */
function targetOf(q: NextApiRequest["query"]): { host: string; lang: string } | null {
  const server = typeof q.server === "string" ? q.server : null;
  if (server) return serverToHost(server);
  const host = typeof q.host === "string" ? q.host : null;
  const lang = typeof q.lang === "string" ? q.lang : null;
  if (!host || !lang) return null;
  // On n'accepte que les hotes reellement affiches — meme garantie que
  // oped_host_skips : la table ne doit contenir que des lecteurs choisissables.
  return isDisplayedHost(host) ? { host, lang } : null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const malId = Number(req.query.malId);
  if (!Number.isFinite(malId) || malId <= 0) {
    return res.status(400).json({ error: "bad malId" });
  }

  if (req.method === "POST") {
    // Le corps peut arriver deja parse (JSON) ou en texte selon l'appelant
    // (`navigator.sendBeacon` envoie un Blob).
    let body: any = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        return res.status(400).json({ error: "bad body" });
      }
    }
    const target = targetOf({ ...req.query, ...(body || {}) });
    const episode = Number(body?.episode);
    const seconds = Number(body?.seconds);
    if (!target) return res.status(400).json({ error: "unknown server/host" });
    if (!Number.isInteger(episode) || episode < 1 || episode > 5000) {
      return res.status(400).json({ error: "bad episode" });
    }
    if (!isPlausibleRuntime(seconds)) {
      return res.status(400).json({ error: "implausible runtime" });
    }
    await putRuntime({
      malId,
      episode,
      lang: target.lang,
      host: target.host,
      // Arrondi a la seconde : `video.duration` est un flottant et on n'affiche
      // jamais mieux que la seconde. Stocker 1419.9832 ferait diverger deux
      // lecteurs du meme fichier a chaque comparaison.
      seconds: Math.round(seconds),
      source: "player",
    });
    // Rien a renvoyer, et surtout rien a cacher.
    res.setHeader("Cache-Control", "no-store");
    return res.status(204).end();
  }

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).end();
  }

  const target = targetOf(req.query);
  if (!target) {
    // Un serveur sans hote detecteur n'est pas une erreur : la liste d'episodes
    // retombe simplement sur ses autres sources.
    res.setHeader("Cache-Control", CACHE);
    return res.status(200).json({ host: null, lang: null, runtimes: {} });
  }

  const runtimes = await getSeasonRuntimes(malId, target.lang, target.host);
  res.setHeader("Cache-Control", CACHE);
  return res.status(200).json({ host: target.host, lang: target.lang, runtimes });
}
