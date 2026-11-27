/**
 * Un segment, plusieurs connexions : le chargeur de SEGMENTS (`fLoader`) qui
 * contourne les CDN bridés par connexion.
 *
 * Pourquoi (27/11/2026) : en 1080p (la qualite d'abord, decision de Luc), un
 * segment pese 5 a 10 Mo, et c'est lui qu'on attend au demarrage et apres
 * chaque saut. Un CDN qui plafonne CHAQUE connexion (frembed : ~2 Mo/s sur le
 * premier segment au banc du 27/11) ne plafonne pas le total : la meme
 * requete coupee en N plages `Range` paralleles arrive jusqu'a N fois plus
 * vite. La table `CONNEXIONS` dit, serveur par serveur, combien de plages ouvrir —
 * chiffres releves par tools/browser-check/debit-connexions.mjs, jamais
 * devines. Un serveur absent de la table garde le chargeur d'hls.js, inchange.
 *
 * Deroulement d'un segment :
 *   1. `Range: bytes=0-(1 Mo)` — la tete, qui donne aussi la taille totale
 *      (`Content-Range`). Elle est lue AU FIL DE L'EAU : en mode progressif,
 *      hls.js decode deja la premiere image pendant que le reste arrive ;
 *   2. des que la taille est connue, le reste en N-1 plages lancees ensemble ;
 *   3. les plages sont rendues a hls.js DANS L'ORDRE (le TS se lit d'un bout a
 *      l'autre), chacune des qu'elle et toutes celles d'avant sont arrivees.
 * Les statistiques (`loading.first/end`, `loaded`, `total`) sont celles du
 * segment entier : l'ABR voit le vrai debit cumule et n'a aucune raison de
 * descendre.
 *
 * DISJONCTEUR : un CDN qui rend 200 a une `Range` (il l'ignore), un 403/429,
 * une coupure — et ce CDN repasse au chargeur d'hls.js pour toute la session.
 * Si rien n'a encore ete rendu a hls.js, le segment est refait aussitot par le
 * chargeur ordinaire : l'echec ne se voit pas. Vidmoly coupe les connexions
 * quand on le martele (ERR_EMPTY_RESPONSE, cf. HLS_CONFIG_DIRECT) et ansembed
 * compte les requetes par IP : d'ou des N petits, et ce disjoncteur.
 *
 * Interrupteur : localStorage `aniscroll:parallel` = "0" coupe tout, "N"
 * force N connexions sur tous les CDN (banc).
 */

/* Connexions par SERVEUR, d'apres la carte des bridages du 27/11/2026
   (devlog/player.md). Par serveur et non par domaine : le CDN de frembed
   change de nom regulierement (« domaine du jour »), une table de domaines se
   perimerait seule. Le domaine ne sert qu'au disjoncteur. */
const CONNEXIONS: Record<string, number> = {};

/** La tete demandee seule : assez pour la premiere image en progressif. */
const TETE = 1024 * 1024;
/** En dessous, un segment ne vaut pas plusieurs connexions. */
const SEUIL = 2 * 1024 * 1024;

const disjonctes = new Set<string>();
/* Le reglage du flux en cours (un seul lecteur a la fois ; l'apercu de la
   barre a son propre hls.js, sans ce chargeur). */
let reglage = 0;

function domaine(url: string): string {
  try {
    return new URL(url).hostname.split(".").slice(-2).join(".");
  } catch {
    return "";
  }
}

function force(): string | null {
  try {
    return localStorage.getItem("aniscroll:parallel");
  } catch {
    return null;
  }
}

/** Connexions pour un serveur (0 = chargeur d'hls.js). Pose le reglage du flux
 *  qui demarre : a appeler quand le lecteur monte une source. */
export function reglerParallele(serverId: string | null | undefined): number {
  const f = force();
  if (f === "0") reglage = 0;
  else if (f && /^\d+$/.test(f)) reglage = Math.min(8, Number(f));
  else {
    const cle = Object.keys(CONNEXIONS).find((k) => (serverId || "").startsWith(k));
    reglage = cle ? CONNEXIONS[cle] : 0;
  }
  return reglage;
}

/** Combien de connexions pour CE segment : le reglage du flux, sauf CDN disjoncte. */
function connexionsPour(url: string): number {
  const d = domaine(url);
  if (!d || disjonctes.has(d)) return 0;
  return reglage;
}

function statsNeuves() {
  return {
    aborted: false,
    loaded: 0,
    retry: 0,
    total: 0,
    chunkCount: 0,
    bwEstimate: 0,
    loading: { start: 0, first: 0, end: 0 },
    parsing: { start: 0, end: 0 },
    buffering: { start: 0, first: 0, end: 0 },
  };
}

class Refus extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}

export function fabriqueFragLoaderParallele(_Hls: any) {
  return class ChargeurParallele {
    hlsConfig: any;
    stats: any;
    context: any = null;
    private delegue: any = null;
    private controleurs: AbortController[] = [];
    private minuteur: number | undefined;
    private clos = false;
    private rappels: any = null;

    constructor(config: any) {
      this.hlsConfig = config;
      this.stats = statsNeuves();
    }

    getCacheAge() {
      return this.delegue?.getCacheAge?.() ?? null;
    }

    getResponseHeader(nom: string) {
      return this.delegue?.getResponseHeader?.(nom) ?? null;
    }

    destroy() {
      this.couper();
      this.delegue?.destroy?.();
      this.delegue = null;
      this.rappels = null;
    }

    abort() {
      if (this.delegue) return this.delegue.abort();
      if (this.clos) return;
      this.couper();
      this.stats.aborted = true;
      this.rappels?.onAbort?.(this.stats, this.context, null);
    }

    private couper() {
      this.clos = true;
      if (this.minuteur != null) clearTimeout(this.minuteur);
      for (const c of this.controleurs) c.abort();
      this.controleurs = [];
    }

    /** Le chargeur d'hls.js (FetchLoader en mode progressif), sur NOS stats :
     *  hls.js les a deja rattachees au fragment. */
    private deleguer(context: any, config: any, rappels: any) {
      const Base = this.hlsConfig.loader;
      this.delegue = new Base(this.hlsConfig);
      this.delegue.stats = this.stats;
      this.delegue.load(context, config, rappels);
    }

    load(context: any, config: any, rappels: any) {
      this.context = context;
      this.rappels = rappels;
      const n = connexionsPour(context.url);
      // Fragments a plage d'octets (EXT-X-BYTERANGE) : deja decoupes par le
      // manifeste, on n'y touche pas.
      if (n < 2 || context.rangeStart || context.rangeEnd) return this.deleguer(context, config, rappels);
      this.stats.loading.start = performance.now();
      if (config.timeout) {
        this.minuteur = window.setTimeout(() => {
          if (this.clos) return;
          this.couper();
          rappels.onTimeout?.(this.stats, context, null);
        }, config.timeout);
      }
      const progressif = !!rappels.onProgress && Number.isFinite(config.highWaterMark);
      void this.charger(context, config, rappels, n, progressif).catch((e: unknown) => {
        if (this.clos) return;
        const d = domaine(context.url);
        if (d) disjonctes.add(d);
        if (!this.rendu) {
          // Rien n'est encore parti vers hls.js : on refait le segment par le
          // chemin ordinaire, sans que la lecture le voie.
          this.couper();
          this.clos = false;
          this.stats = Object.assign(this.stats, statsNeuves());
          this.stats.loading.start = performance.now();
          return this.deleguer(context, config, rappels);
        }
        this.couper();
        const code = e instanceof Refus ? e.code : 0;
        rappels.onError({ code, text: e instanceof Error ? e.message : String(e) }, context, null, this.stats);
      });
    }

    private rendu = false;

    private lire(url: string, debut: number, fin: number | null, entetes: Record<string, string>) {
      const c = new AbortController();
      this.controleurs.push(c);
      const h = new Headers(entetes || {});
      h.set("Range", `bytes=${debut}-${fin == null ? "" : fin}`);
      return fetch(url, { method: "GET", mode: "cors", credentials: "same-origin", headers: h, signal: c.signal });
    }

    private async charger(context: any, config: any, rappels: any, n: number, progressif: boolean) {
      const url = context.url;
      const stats = this.stats;
      const r0 = await this.lire(url, 0, TETE - 1, context.headers);
      if (this.clos) return;
      if (r0.status !== 206) {
        // 200 : la Range est ignoree ; 403/429/… : refus. Le disjoncteur dans
        // les deux cas — et le corps de r0 n'est pas lu.
        r0.body?.cancel().catch(() => {});
        throw new Refus(r0.status, `Range ${r0.status}`);
      }
      stats.loading.first = performance.now();
      /* LA TAILLE. `Content-Range` la donne, mais ces CDN ne l'exposent pas au
         navigateur (CORS, carte du 27/11/2026 : vmpx, vmbox et frembed rendent
         bien 206, en-tete illisible). `Content-Length`, lui, est toujours
         lisible : un HEAD le donne, pendant que la tete arrive. A defaut, le
         reste part en UNE plage ouverte — deux connexions au lieu de N, jamais
         une erreur. */
      let total = Number((r0.headers.get("content-range") || "").split("/")[1]) || 0;
      if (!total) {
        const c = new AbortController();
        this.controleurs.push(c);
        total = await fetch(url, {
          method: "HEAD",
          mode: "cors",
          credentials: "same-origin",
          headers: new Headers(context.headers || {}),
          signal: c.signal,
        })
          .then((r) => (r.ok ? Number(r.headers.get("content-length")) || 0 : 0))
          .catch(() => 0);
        if (this.clos) return;
      }
      stats.total = total;

      /* Le reste, decoupe et lance TOUT DE SUITE, pendant qu'on lit la tete. */
      const plage = (debut: number, fin: number | null) =>
        this.lire(url, debut, fin, context.headers).then(async (r) => {
          // 416 : on a demande au-dela de la fin (taille inconnue, segment
          // plus court que la tete) — il n'y a simplement rien de plus.
          if (r.status === 416 && fin == null) return new ArrayBuffer(0);
          if (r.status !== 206) {
            r.body?.cancel().catch(() => {});
            throw new Refus(r.status, `Range ${r.status}`);
          }
          const b = await r.arrayBuffer();
          if (fin != null && b.byteLength !== fin - debut + 1) throw new Refus(0, "plage incomplete");
          stats.loaded += b.byteLength;
          return b;
        });
      const reste: Promise<ArrayBuffer>[] = [];
      if (!total) reste.push(plage(TETE, null));
      else if (total > TETE) {
        const parts = total > SEUIL ? n - 1 : 1;
        const taille = Math.ceil((total - TETE) / parts);
        for (let i = 0; i < parts; i++) {
          const debut = TETE + i * taille;
          if (debut >= total) break;
          reste.push(plage(debut, Math.min(total - 1, debut + taille - 1)));
        }
      }
      // Une plage qui echoue pendant qu'on lit la tete ne doit pas rester en
      // « rejet non gere » : l'erreur ressort plus bas, a son tour.
      reste.forEach((p) => p.catch(() => {}));

      const morceaux: ArrayBuffer[] = [];
      const rendre = (b: ArrayBuffer) => {
        if (this.clos || !b.byteLength) return;
        if (progressif) {
          this.rendu = true;
          stats.chunkCount++;
          rappels.onProgress(stats, context, b, null);
        } else morceaux.push(b);
      };

      /* La tete, au fil de l'eau, par paquets d'au moins `highWaterMark`. */
      const lecteur = r0.body!.getReader();
      const seuil = progressif ? config.highWaterMark || 0 : Infinity;
      let attente: Uint8Array[] = [];
      let enAttente = 0;
      const vider = () => {
        if (!enAttente) return;
        const out = new Uint8Array(enAttente);
        let o = 0;
        for (const a of attente) {
          out.set(a, o);
          o += a.length;
        }
        attente = [];
        enAttente = 0;
        rendre(out.buffer);
      };
      for (;;) {
        const { done, value } = await lecteur.read();
        if (this.clos) return;
        if (done) break;
        stats.loaded += value.length;
        attente.push(value);
        enAttente += value.length;
        if (enAttente >= seuil) vider();
      }
      vider();

      for (const p of reste) {
        const b = await p;
        if (this.clos) return;
        rendre(b);
      }

      if (this.clos) return;
      if (this.minuteur != null) clearTimeout(this.minuteur);
      stats.loading.end = performance.now();
      if (!total) total = stats.loaded;
      stats.loaded = stats.total = total;
      let data: ArrayBuffer;
      if (progressif) data = new ArrayBuffer(0);
      else {
        const somme = morceaux.reduce((x, m) => x + m.byteLength, 0);
        if (somme !== total) throw new Refus(0, `taille ${somme} au lieu de ${total}`);
        const tout = new Uint8Array(total);
        let o = 0;
        for (const m of morceaux) {
          tout.set(new Uint8Array(m), o);
          o += m.byteLength;
        }
        data = tout.buffer;
      }
      this.clos = true;
      rappels.onSuccess({ url, data }, stats, context, null);
    }
  };
}
