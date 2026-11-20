import type { NextApiHandler, NextApiRequest, NextApiResponse } from "next";

/**
 * La trace minimale d'une route chaude (20/11/2026).
 *
 * OpenTelemetry complet demande un collecteur (l'export OTel de Vercel est
 * reserve au plan Pro). L'equivalent utile, gratuit :
 *   - un en-tete `Server-Timing: app;dur=<ms>`, lisible dans l'onglet Network
 *     de DevTools (et par perf-measure.mjs) — le temps passe DANS la fonction,
 *     distinct du reseau et du cache ;
 *   - une ligne `[slow] <route> <ms> ms` au-dela de SLOW_MS, que
 *     `vercel logs --json` permet de retrouver.
 * Rien n'est envoye ailleurs : aucun cout de quota.
 */
const SLOW_MS = 1500;

export function withTiming(route: string, handler: NextApiHandler): NextApiHandler {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    const t0 = performance.now();
    const end = res.end.bind(res);
    (res as any).end = (...args: any[]) => {
      const ms = Math.round(performance.now() - t0);
      try {
        if (!res.headersSent) res.setHeader("Server-Timing", `app;dur=${ms}`);
      } catch {
        /* en-tetes deja partis : on garde seulement le journal */
      }
      if (ms > SLOW_MS) console.warn(`[slow] ${route} ${ms} ms ${res.statusCode}`);
      return (end as any)(...args);
    };
    return handler(req, res);
  };
}
