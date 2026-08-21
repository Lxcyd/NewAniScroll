/**
 * The browser's way of asking /api/v2/source for an episode.
 *
 * It is a **GET**, and that is the whole reason this module exists: the route
 * has always set `s-maxage` on its answers, but a POST is never cached by any
 * CDN, so every visitor re-invoked the function for a resolution the edge
 * already had — and the watch page fires one of these per server it probes, per
 * page load. As a GET the exact same answers are served from Vercel's edge (and
 * from the browser's own cache on an episode revisit) for the 5 minutes they
 * stay valid.
 *
 * It also normalises the three outcomes in one place. They used to be spelled
 * out at four call sites against status codes (204 here, 404 there), which is
 * precisely the kind of contract that drifts:
 *
 *   ok      — a payload to play or to cache
 *   absent  — this server genuinely has no source for this episode
 *   retry   — transient (upstream hiccup, 5xx, network); ask again later
 *
 * "absent" arrives as `200 { absent: true }` rather than a 204/404 so that it is
 * unambiguously cacheable at the edge and prints nothing in the console. The old
 * 204/404 spellings are still accepted here: warmers and scripts use the POST
 * contract, and a stale client can be served by an edge copy for a few minutes
 * after a deploy.
 */

/**
 * `absent.hard` = the route PROVED the absence (the host answered 404 for this
 * upload) rather than merely failing to find a source. Callers use it to skip
 * the anti-bot decoy retries — a proven 404 does not become a 200 in 5.6 s —
 * and to publish the absence, which an ambiguous one must never do.
 */
export type SourceOutcome =
  | { kind: "ok"; data: any }
  | { kind: "absent"; hard?: boolean }
  | { kind: "retry"; status?: number };

export type SourceParams = {
  server: string;
  aniId: number | string;
  episode: number | string;
  sub: "sub" | "dub";
  /* `title` et `malId` restent acceptes pour ne pas casser les appelants, mais
     ne partent plus dans l'URL — cf. `sourceRequestUrl`. */
  title?: string | null;
  /** The only field the route ever read out of the old `mediaMeta` blob. */
  malId?: number | string | null;
};

export function sourceRequestUrl(params: SourceParams): string {
  /* Quatre parametres, et rien d'autre. `title` et `malId` etaient joints quand
     le client les connaissait, pour epargner une lecture au serveur — or la
     route les retrouve seule (`resolveTitle()` retombe sur `getMediaMeta`, et
     la branche megaplay va chercher le `malId` quand il manque), depuis un
     cache qu'elle a deja.
     Ils coutaient deux fois. La clé de cache CDN dependait de leur PRESENCE :
     la meme video avait une adresse avec titre en navigation interne et une
     sans a l'arrivee froide, donc chaque moitie des visiteurs ratait le cache
     de l'autre. Et les attendre retardait la demande, qui n'a besoin que de ce
     que l'URL de la page porte deja. */
  const q = new URLSearchParams({
    server: String(params.server),
    aniId: String(params.aniId),
    episode: String(params.episode),
    sub: params.sub,
  });
  return `/api/v2/source?${q.toString()}`;
}

/**
 * Resolve one (server, episode) pair. Never throws except on abort, which the
 * callers already distinguish (they abort on episode change / unmount).
 */
export async function requestSource(
  params: SourceParams,
  opts: { signal?: AbortSignal; priority?: "high" | "low" | "auto" } = {},
): Promise<SourceOutcome> {
  const res = await fetch(sourceRequestUrl(params), {
    signal: opts.signal,
    // @ts-ignore — `priority` is a valid fetch init in Chromium/Safari.
    priority: opts.priority || "auto",
  });

  // Legacy spellings of "absent" (POST contract / an edge copy from before the
  // switch). Terminal either way.
  if (res.status === 204 || res.status === 404) return { kind: "absent" };
  if (!res.ok) return { kind: "retry", status: res.status };

  let body: any;
  try {
    body = await res.json();
  } catch {
    return { kind: "retry", status: res.status };
  }

  if (body?.absent) return { kind: "absent", hard: body.hard === true };
  // The route wraps an extractor failure as `{ error }` — transient, not a
  // verdict on the server (publishing it as "absent" would hide a working host
  // from every visitor for the 6 h of the availability snapshot).
  if (body?.error) return { kind: "retry", status: res.status };
  return { kind: "ok", data: body };
}
