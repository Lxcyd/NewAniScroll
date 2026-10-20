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

/** Les épisodes d'un anime, par la route de la fiche (cachée 30 j). */
export async function fetchEpisodes(aniId: number, signal?: AbortSignal): Promise<StudioEpisode[]> {
  const r = await fetch(`/api/v2/episode/${aniId}?releasing=false`, { signal });
  if (!r.ok) throw new Error(`episode ${r.status}`);
  const payload = await r.json();
  if (!Array.isArray(payload)) return [];
  const provider = payload.find((p: any) => p?.providerId === "megaplay") || payload[0];
  return (provider?.episodes || [])
    .filter((e: any) => Number.isFinite(Number(e?.number)))
    .map((e: any) => ({ n: Number(e.number), title: e.title || null, img: e.img || null }));
}

/**
 * Les lecteurs qui ont CET épisode. L'instantané de la page de lecture
 * (/api/v2/availability) d'abord, qui ne coûte qu'une lecture Redis ; à
 * défaut, une sonde par lecteur — le studio seul la paie, une fois par
 * épisode ouvert.
 */
export async function availableServers(aniId: number, n: number, signal?: AbortSignal): Promise<string[]> {
  const ok = new Set<string>();
  const absent = new Set<string>();
  await Promise.all(
    (["sub", "dub"] as const).map(async (sub) => {
      try {
        const r = await fetch(`/api/v2/availability?aniId=${aniId}&episode=${n}&sub=${sub}`, { signal });
        if (!r.ok) return;
        const d = await r.json();
        for (const s of d?.servers ?? []) if (subOf(s) === sub) ok.add(s);
        for (const s of d?.absent ?? []) if (subOf(s) === sub) absent.add(s);
      } catch {
        /* sans instantané : on sonde */
      }
    }),
  );
  const unknown = LISTED.filter((s) => !ok.has(s.id) && !absent.has(s.id));
  await Promise.all(
    unknown.map(async (s) => {
      try {
        const out = await requestSource({ server: s.id, aniId, episode: n, sub: subOf(s.id), probe: true }, { signal });
        if (out.kind === "ok" && playable(out.data)) ok.add(s.id);
      } catch {
        /* abandon ou réseau : le lecteur n'est pas proposé */
      }
    }),
  );
  /* Dans l'ordre de la liste des lecteurs (lib/servers.js). */
  return LISTED.filter((s) => ok.has(s.id)).map((s) => s.id);
}

/** Une réponse jouable dans un `<video>` : un flux, ou une extraction à faire. */
function playable(data: any): boolean {
  const ce = data?.clientExtract;
  if (ce?.type === "vidmoly" || ce?.type === "vidmoly-multipart") return true;
  return !!data?.streams?.some((s: any) => s?.url && !s.localFile);
}

export type EpisodeStream = { url: string; hls: boolean; revoke?: () => void };

/** Le flux à jouer, ou null (épisode absent, lecteur mort, iframe seule). */
export async function resolveEpisodeStream(
  aniId: number,
  ep: { n: number; server: string },
  signal?: AbortSignal,
): Promise<EpisodeStream | null> {
  const out = await requestSource(
    { server: ep.server, aniId, episode: ep.n, sub: subOf(ep.server) },
    { signal },
  );
  if (out.kind !== "ok") return null;
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
