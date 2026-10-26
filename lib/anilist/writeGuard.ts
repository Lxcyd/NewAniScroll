/**
 * AUCUNE ÉCRITURE VERS ANILIST HORS DE LA PROD (25/10/2026, Luc : « il m'arrive
 * beaucoup de modifier mes anime par erreur » en testant).
 *
 * Sur localhost, dev.aniscroll.com ou une preview, la liste LOCALE se met à jour
 * normalement, mais rien ne part vers AniList : ni la synchro d'un épisode fini,
 * ni la mise en pause automatique, ni l'éditeur de liste, ni les favoris, ni la
 * file d'envoi. Le nom d'hôte et pas NODE_ENV : la dev est un build de
 * production (cf. lib/watch/serverPerf.ts).
 *
 * Deux étages :
 *  - `anilistWritesAllowed()`, vérifié là où l'interface doit se taire plutôt
 *    qu'afficher une erreur (éditeur, synchro) ;
 *  - `installAnilistWriteGuard()`, posé une fois au démarrage : tout `fetch`
 *    d'une mutation vers graphql.anilist.co hors prod est arrêté avant de
 *    partir. Le filet pour les chemins qu'on oublierait.
 */

const ENDPOINT = "graphql.anilist.co";

export function anilistWritesAllowed(): boolean {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname;
  return host === "aniscroll.com" || host === "www.aniscroll.com";
}

/** La réponse rendue à une mutation arrêtée : un refus définitif (400), pour
 *  que la file d'envoi ne la range pas et ne la rejoue jamais. */
const BLOCKED_MESSAGE = "AniList writes are off outside aniscroll.com";

export function installAnilistWriteGuard(): void {
  if (typeof window === "undefined" || anilistWritesAllowed()) return;
  const w = window as Window & { __anilistGuard?: boolean };
  if (w.__anilistGuard) return;
  w.__anilistGuard = true;
  const original = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = typeof init?.body === "string" ? init.body : "";
      /* `"query":"\n      mutation …"` : dans le JSON, les retours à la ligne de
         tête sont des `\n` littéraux, d'où `(?:\\[nrt]|\s)*`. */
      if (url.includes(ENDPOINT) && /"query"\s*:\s*"(?:\\[nrt]|\s)*mutation\b/.test(body)) {
        console.info(`[aniscroll] ${BLOCKED_MESSAGE} — mutation non envoyée.`);
        return Promise.resolve(
          new Response(JSON.stringify({ data: null, errors: [{ message: BLOCKED_MESSAGE, status: 400 }] }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
    } catch {
      /* requête illisible : on la laisse passer, comme avant */
    }
    return original(input as RequestInfo, init);
  }) as typeof window.fetch;
}
