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
import { EARLY_SOURCE_KEY } from "./earlySource";

export type SourceOutcome =
  | { kind: "ok"; data: any }
  | { kind: "absent"; hard?: boolean }
  /* `hostDown` : l'hote nous refuse GLOBALEMENT (memo d'egress, throttle), par
     opposition a un episode qui echoue. L'appelant s'en sert pour eteindre le
     chip plutot que de proposer un choix qui ne peut pas aboutir. */
  | { kind: "retry"; status?: number; hostDown?: boolean };

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
  /**
   * « Cette requete sert a peindre un chip, pas a ouvrir un lecteur. »
   *
   * Elle autorise la route a payer une verification de liveness de plus (un
   * HEAD, jusqu'a 3 s) pour qu'un chip mort ne s'allume pas. L'ouverture du
   * lecteur, elle, ne la paie plus : c'est le chemin que l'utilisateur regarde,
   * et le meme 404 s'y decouvre tout seul.
   *
   * Reservee au fan-out de sondage. Un prechauffage (episode suivant, chaine de
   * la page info) n'est PAS une sonde : il prepare une vraie lecture et doit
   * donc partager l'entree de cache du lecteur.
   */
  probe?: boolean;
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
  /* Cinquieme parametre, et il SEPARE bien deux entrees de cache d'edge — ce
     que le paragraphe ci-dessus met en garde de faire a la legere. C'est
     assume ici, parce que la separation n'est pas aleatoire : elle suit
     l'USAGE, pas l'appelant. Les sondes ont leur entree, les ouvertures de
     lecteur la leur, et chacune est alimentee par sa propre population. Le cas
     pathologique d'alors etait tout autre : `title` present ou absent coupait
     en deux LA MEME population, si bien qu'une moitie ratait le cache rempli
     par l'autre. Cote Redis la cle reste commune, volontairement (cf.
     `sourceCacheKey`). */
  if (params.probe) q.set("probe", "1");
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
  const url = sourceRequestUrl(params);
  /* La requete est peut-etre deja partie, avant meme ce bundle : le script pose
     dans le document en lance une des l'analyse du HTML (cf.
     lib/watch/earlySource.ts). Si c'est la meme adresse, on adopte sa reponse
     au lieu d'en demander une seconde — sinon on aurait paye deux fois le
     chemin qu'on cherchait justement a raccourcir.
     Consommee une seule fois : le repere est efface avant meme d'etre attendu,
     une `Response` ne se lit pas deux fois. Le `signal` d'annulation ne
     s'applique pas a celle-la — elle etait partie avant qu'il existe. */
  const early = (globalThis as any)[EARLY_SOURCE_KEY] as
    | { url: string; promise: Promise<Response> }
    | undefined;
  let res: Response;
  if (early && early.url === url) {
    delete (globalThis as any)[EARLY_SOURCE_KEY];
    try {
      res = await early.promise;
    } catch {
      return { kind: "retry" };
    }
  } else {
    res = await fetch(url, {
      signal: opts.signal,
      // @ts-ignore — `priority` is a valid fetch init in Chromium/Safari.
      priority: opts.priority || "auto",
    });
  }

  // Legacy spellings of "absent" (POST contract / an edge copy from before the
  // switch). Terminal either way.
  if (res.status === 204 || res.status === 404) return { kind: "absent" };
  if (!res.ok) {
    /* Un 503 porte un corps : la route y met `hostDown` quand elle sait que
       l'hote refuse tout. On le lit AVANT de conclure — sans ca l'information
       etait produite cote serveur et jetee ici. */
    let corps: any = null;
    try {
      corps = await res.json();
    } catch {
      /* corps vide ou illisible : on reste sur un simple retry */
    }
    return { kind: "retry", status: res.status, hostDown: corps?.hostDown === true };
  }

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
