/**
 * UN ÉPISODE EN FOND DE PROFIL (20/10/2026, demande de Luc).
 *
 * Un épisode ne s'enregistre pas comme une bande-annonce : son flux est un HLS
 * signé qui expire en 1 à 4 h, et celui de Vidmoly / Ansembed ne vaut que pour
 * l'IP qui l'a obtenu. Le profil ne garde donc que { anime, épisode, lecteur }
 * (`Dressing.episode`), et chaque visiteur retrouve le flux au chargement par
 * le même chemin que la page de lecture : `/api/v2/source` (une invocation,
 * ~27 ms de Fluid CPU mesurés le 22/09), puis l'extraction dans le navigateur
 * pour les lecteurs qui l'exigent.
 */

import SERVERS from "@/lib/servers";
import { requestSource } from "@/lib/watch/sourceRequest";
import { playbackUrl } from "@/lib/watch/streamUrl";

export type StudioEpisode = { n: number; title: string | null; img: string | null };

type Server = { id: string; name: string; lang: "multi" | "vo" | "vf" };
const LISTED = SERVERS as Server[];

/** La langue d'un lecteur, entre crochets dans le menu. */
const LANG_TAG: Record<Server["lang"], string> = { multi: "MULTI", vo: "VOSTFR", vf: "VF" };

export function serverLabel(id: string): string {
  const s = LISTED.find((x) => x.id === id);
  if (!s) return id;
  /* Le dernier mot du nom, comme les chips de la page de lecture
     (« Anime-Sama Ansembed » → « Ansembed »). */
  return `${s.name.split(" ").pop()} [${LANG_TAG[s.lang]}]`;
}

/** VF = la piste doublée ; VOSTFR et MULTI = la version originale. */
const subOf = (id: string): "sub" | "dub" =>
  LISTED.find((x) => x.id === id)?.lang === "vf" ? "dub" : "sub";

/* UNE SEULE REQUÊTE PAR QUESTION (20/10/2026, « optimise »). Le studio sonde
   un lecteur pour son menu au moment même où le fond le résout pour jouer :
   deux appels identiques à /api/v2/source, que le cache du navigateur ne
   fusionne pas tant que le premier n'a pas répondu. Les promesses en vol sont
   partagées, et gardées deux minutes (le flux, lui, vit 1 à 4 h). */
const MEMO_MS = 2 * 60 * 1000;
const memo = new Map<string, { at: number; p: Promise<any> }>();
function once<T>(key: string, run: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < MEMO_MS) return hit.p;
  const p = run().catch((e) => {
    memo.delete(key);
    throw e;
  });
  memo.set(key, { at: Date.now(), p });
  return p;
}

const ask = (aniId: number, n: number, server: string) =>
  once(`src:${aniId}:${n}:${server}`, () =>
    requestSource({ server, aniId, episode: n, sub: subOf(server) }),
  );

/** Les épisodes d'un anime, par la route de la fiche (cachée 30 j). Partagé :
    le survol d'une ligne le lance d'avance, le clic le reprend. */
export function fetchEpisodes(aniId: number): Promise<StudioEpisode[]> {
  return once(`eps:${aniId}`, async () => {
    const r = await fetch(`/api/v2/episode/${aniId}?releasing=false`);
    if (!r.ok) throw new Error(`episode ${r.status}`);
    const payload = await r.json();
    if (!Array.isArray(payload)) return [];
    const provider = payload.find((p: any) => p?.providerId === "megaplay") || payload[0];
    return (provider?.episodes || [])
      .filter((e: any) => Number.isFinite(Number(e?.number)))
      .map((e: any) => ({ n: Number(e.number), title: e.title || null, img: e.img || null }));
  });
}

/**
 * Les lecteurs qui ont CET épisode, AU FIL DE L'EAU : `onUpdate` reçoit la
 * liste à chaque lecteur confirmé, puis `done` à la fin. On n'attend plus le
 * plus lent — Frembed met parfois 16 s à échouer — pour proposer les autres.
 *
 * L'instantané de la page de lecture (/api/v2/availability) d'abord, une
 * lecture Redis ; à défaut, une sonde par lecteur, que le studio seul paie.
 * `failed` dit les lecteurs écartés, pour remplacer sans attendre la fin un
 * lecteur supposé qui n'a pas l'épisode.
 */
/* LES LECTEURS D'UN ANIME, appris au premier épisode sondé (21/10/2026,
   quota Fluid). Un hôte qui a un épisode d'une série a presque toujours les
   autres, et un hôte qui ne l'a pas n'a presque jamais le suivant : passer
   d'un épisode à l'autre ne sonde plus que les lecteurs déjà vus vivants —
   deux ou trois appels à /api/v2/source au lieu de sept, et plus de lecture de
   l'instantané. Tant de cette session seulement. */
const hostsOf = new Map<number, Set<string>>();

export async function availableServers(
  aniId: number,
  n: number,
  onUpdate: (ids: string[], failed: Set<string>, done: boolean) => void,
  signal?: AbortSignal,
): Promise<void> {
  const ok = new Set<string>();
  const failed = new Set<string>();
  const emit = (done: boolean) => {
    if (!signal?.aborted)
      onUpdate(LISTED.filter((s) => ok.has(s.id)).map((s) => s.id), new Set(failed), done);
  };
  const known = hostsOf.get(aniId);
  if (known?.size) {
    for (const s of LISTED) if (!known.has(s.id)) failed.add(s.id);
    await Promise.all(
      [...known].map(async (id) => {
        try {
          const out = await ask(aniId, n, id);
          if (out.kind === "ok" && playable(out.data)) ok.add(id);
          else failed.add(id);
        } catch {
          failed.add(id);
        }
        emit(false);
      }),
    );
    /* Aucun des lecteurs connus n'a CET épisode : on sonde tout, une fois. */
    if (ok.size || signal?.aborted) return emit(true);
    failed.clear();
  }
  await Promise.all(
    (["sub", "dub"] as const).map(async (sub) => {
      try {
        const r = await fetch(`/api/v2/availability?aniId=${aniId}&episode=${n}&sub=${sub}`, { signal });
        if (!r.ok) return;
        const d = await r.json();
        for (const s of d?.servers ?? []) if (subOf(s) === sub) ok.add(s);
        for (const s of d?.absent ?? []) if (subOf(s) === sub) failed.add(s);
      } catch {
        /* sans instantané : on sonde */
      }
    }),
  );
  if (ok.size) emit(false);
  const unknown = LISTED.filter((s) => !ok.has(s.id) && !failed.has(s.id));
  await Promise.all(
    unknown.map(async (s) => {
      try {
        const out = await ask(aniId, n, s.id);
        if (out.kind === "ok" && playable(out.data)) ok.add(s.id);
        else failed.add(s.id);
      } catch {
        failed.add(s.id);
      }
      emit(false);
    }),
  );
  if (ok.size && !signal?.aborted) hostsOf.set(aniId, new Set(ok));
  emit(true);
}

/** Une réponse jouable dans un `<video>` : un flux, ou une extraction à faire. */
function playable(data: any): boolean {
  const ce = data?.clientExtract;
  if (ce?.type === "vidmoly" || ce?.type === "vidmoly-multipart") return true;
  return !!data?.streams?.some((s: any) => s?.url && !s.localFile);
}

export type EpisodeStream = { url: string; hls: boolean; revoke?: () => void };

/**
 * Le flux du lecteur choisi ; s'il est mort pour cet épisode, `fallback` essaie
 * les autres lecteurs de la MÊME langue, un par un. Le profil d'un visiteur ne
 * doit pas rester noir parce qu'un hôte est tombé depuis l'enregistrement ; le
 * studio, lui, montre le lecteur qu'on a choisi et rien d'autre.
 */
export async function resolveEpisodeStream(
  aniId: number,
  ep: { n: number; server: string },
  signal?: AbortSignal,
  fallback = false,
): Promise<EpisodeStream | null> {
  const first = await resolveOne(aniId, ep, signal);
  if (first || !fallback || signal?.aborted) return first;
  const lang = LISTED.find((x) => x.id === ep.server)?.lang;
  for (const s of LISTED.filter((x) => x.id !== ep.server && x.lang === lang)) {
    const got = await resolveOne(aniId, { n: ep.n, server: s.id }, signal);
    if (got || signal?.aborted) return got;
  }
  return null;
}

/** Le flux à jouer, ou null (épisode absent, lecteur mort, iframe seule). */
async function resolveOne(
  aniId: number,
  ep: { n: number; server: string },
  signal?: AbortSignal,
): Promise<EpisodeStream | null> {
  const out = await ask(aniId, ep.n, ep.server);
  if (signal?.aborted || out.kind !== "ok") return null;
  const data = out.data;
  const ce = data?.clientExtract;
  if (ce?.type === "vidmoly" || ce?.type === "vidmoly-multipart") {
    const mod = await import("@/lib/clientVidmoly");
    const res: any =
      ce.type === "vidmoly"
        ? await mod.extractVidmolyClient(ce.embedUrl, { signal })
        : await mod.extractVidmolyMultipartClient(ce.embedUrls, { signal });
    if (!res?.masterUrl) return null;
    return { url: res.masterUrl, hls: true, revoke: res.revoke };
  }
  const stream = data?.streams?.find((s: any) => s?.url && !s.localFile);
  const url = stream ? playbackUrl(stream, data.referer) : null;
  if (!url) return null;
  return { url, hls: !!stream.isM3U8 || /\.m3u8/.test(stream.url) };
}
