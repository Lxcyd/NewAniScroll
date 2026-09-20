/**
 * Streaming server definitions.
 *
 * Each server has:
 *   - name          : display label
 *   - id            : unique key (used in localStorage + URL)
 *   - type          : "iframe" | "hls" | "api"
 *   - lang          : "multi" | "vo" | "vf"  (for display icon)
 *   - buildSrc(opts): returns the iframe URL (iframe type only)
 *   - source        : backend source key (api/hls types)
 *   - speed         : typical delivery-speed rank (1 = fastest). Drives the
 *                     order servers appear in the selector — fastest first.
 *                     Based on the delivery architecture: direct-CDN /
 *                     browser-extracted hosts are quick; hosts routed through
 *                     the Fly proxy (sibnet) are the slowest.
 *
 * `speed` n'est PAS le mot final. C'est le premier des trois etages de
 * lib/watch/serverPerf.ts — rang ecrit a la main, puis agregat mesure des
 * visiteurs (plafond 0,6), puis mesures de l'appareil (plafond 0,75). Deux
 * consequences pratiques, apprises le 20/09/2026 :
 *
 *   - echanger deux entrees de PLACE dans ce fichier ne change rien des lors
 *     qu'elles ont le meme `speed` : l'agregat tranche avant l'ordre de
 *     declaration. Pour deplacer un lecteur, il faut changer son rang.
 *   - un rang qui contredit la mesure sera corrige par elle. C'est voulu : ce
 *     fichier porte l'intention, la mesure porte le reel.
 *
 * Les rangs sont donc tenus SANS ex aequo, pour que l'ordre ne depende jamais
 * de l'ordre de declaration : 1 frembed, 2 ansembed, 3 voiranime, 4 sibnet,
 * 5 uqload.
 */

const SERVERS = [
  // ── Iframe embeds ──────────────────────────────────────────
  // VidNest was here — removed as a near-duplicate of Megaplay: both resolve
  // the same MegaCloud source (cdn.mewstream.buzz), so for ~9/12 titles tested
  // they returned the IDENTICAL m3u8. The marginal cases where VidNest differed
  // (more subtitle tracks on a few titles) didn't justify a second chip serving
  // the same stream. Megaplay is the canonical MegaCloud entry.
  // Megaplay RETIRE le 08/09/2026 : /stream/getSources ne rend plus de source.
  //
  // Mesure, a travers le Worker (donc sur une page de fichier VALIDE, titre
  // « File 36396 - MegaPlay ») :
  //   { "tracks":[…], "intro":{…}, "outro":{…}, "server":4,
  //     "enc":"wdeBruh3qqn_i5wUNnyaPQQl1wp7r0Sr…" }
  // Le `sources.file` a disparu au profit d'un blob CHIFFRE. L'extracteur ne
  // peut plus rien en tirer — 6 titres testes, 6 fois « no source.file in API
  // response » — et le moindre parametre ajoute a l'url (`&raw=1`, `&_k=1`)
  // fait repondre 403, donc il n'y a pas d'echappatoire cote requete. Le
  // dechiffrement demanderait leur cle, qui tourne et qu'il faudrait aller
  // chercher chez un tiers : ce serait un lecteur en sursis, pas un lecteur.
  //
  // Il etait le DEFAUT du site : chaque visiteur ouvrait donc une page de
  // lecture sur un lecteur mort, voyait un lecteur vide, puis la bascule
  // automatique. D'ou le retrait plutot qu'un chip rouge — et le deplacement
  // du defaut vers DEFAULT_SERVER_ID plus bas.
  //
  // RALLUME le 20/09/2026, mais EN IFRAME — pas en extraction.
  //
  // Re-mesure ce jour-la : la page embed repond toujours 200 et joue, mais
  // `getSources` ne rend plus que `{ tracks, intro, outro, server, enc }`.
  // L'adresse du flux ne vit que dans le blob chiffre. Cinq variantes
  // essayees, dont les deux valeurs de `s` que leur propre page utilise
  // (`s=tcdn`, `s=bcdn`) et le `bypass=yes` qu'elle force : meme forme partout.
  //
  // Puisque leur page sait jouer, on l'encadre au lieu de l'extraire. Valide a
  // la mesure : aucun `X-Frame-Options`, aucun CSP, et la page accepte notre
  // referer (sans referer elle rend « Error 410 » — donc jamais `no-referrer`
  // sur cette iframe, cf. la branche megaplay de pages/api/v2/source).
  //
  // `speed: 7`, en FIN d'echelle et derriere uqload, parce qu'une iframe coute
  // ce que les autres ne coutent pas : pas d'habillage maison, pas de saut
  // d'OP/ED, pas de raccourcis clavier, pas de synchro watch2gether, et leurs
  // publicites. C'est un filet pour les series que personne d'autre ne sert,
  // pas un premier choix — et surtout plus JAMAIS le defaut du site, ce qu'il
  // etait quand il est mort le 08/09 (chaque visiteur ouvrait alors sur un
  // lecteur vide).
  //
  // `lang: "multi"` : un seul chip qui porte sub ET dub, la forme de megaplay —
  // le parametre `sub|dub` de l'URL suit la demande, il n'y a pas deux entrees
  // a separer comme pour frembed.
  // `type: "api"` et NON `"iframe"`, bien que le resultat soit une iframe —
  // c'est contre-intuitif et ca merite d'etre dit. Le type `"iframe"` veut dire
  // « le client fabrique l'URL lui-meme avec `buildSrc`, sans passer par le
  // backend » : instantane, mais aveugle. Or une page megaplay d'episode
  // inexistant repond 200 comme les autres, et c'est le `data-id` du lecteur
  // qui les distingue — invisible depuis le navigateur, qui ne peut pas lire
  // une page cross-origin. Le detour par /api/v2/source est donc ce qui permet
  // de VERIFIER avant d'allumer le chip, et accessoirement de passer par le
  // Worker, seul chemin que Cloudflare laisse aboutir.
  // Le declarer `"iframe"` sans fournir `buildSrc` jette un
  // `TypeError: e.buildSrc is not a function` qui emporte toute la page de
  // lecture — constate le 20/09/2026, attrape par un test navigateur.
  // `lecteurExterne: true` — le seul serveur qui PEUT rendre le lecteur d'un
  // tiers. Depuis la re-extraction (cf. la branche megaplay de
  // pages/api/v2/source), le chemin normal rend notre propre lecteur ; il ne
  // retombe sur leur page encadree que si le fichier n'a aucune piste de
  // sous-titres, faute de quoi deriver le repertoire du flux. Le drapeau reste
  // donc justifie : on ne veut pas qu'un clic epingle a vie un serveur qui, sur
  // certains titres, servira l'habillage et les publicites d'un tiers.
  //
  // La consequence a corriger : un clic sur ce chip appelait
  // `setAnimeServer`, donc l'epinglait comme choix EXPLICITE de la fiche, et un
  // choix explicite prime sur tout le classement. Un seul essai — y compris
  // pour verifier que l'hote marche — condamnait la serie a s'ouvrir sur une
  // interface etrangere a chaque visite, alors que nos propres lecteurs la
  // servaient. Constate le 20/09/2026 sur Mushoku Tensei S3, qui a pourtant
  // Ansembed, Vidmoly et Sibnet.
  //
  // Il reste donc choisissable, mais pour la SESSION seulement : on ne retient
  // pas un repli comme s'il etait une preference. Voir `handleServerChange`
  // dans pages/en/anime/watch/[...info].js.
  {
    id: "megaplay",
    name: "Megaplay",
    type: "api",
    lang: "multi",
    source: "megaplay",
    speed: 7,
    lecteurExterne: true,
  },
  // 4Animo removed — only ships hardcoded English subs and confused users
  // since Megaplay covers the same MegaCloud source with multi-language
  // separate tracks.

  // Miruro (`miruro-jet`) was here — relied on a third-party `miruro-api`
  // service that's been returning 500s. Their direct API uses ECDH-encrypted
  // JWE envelopes (very intrusive to reverse). Megaplay already covers the
  // same multi-sub use case, so this is removed for now.

  // CoorenLabs providers were here (AnimePahe, Animekai). They require a
  // COOREN_API_URL env var which isn't set in this deployment — and Megaplay
  // already covers MegaCloud/AnimeKai with multi-language separate subtitle
  // tracks, so removing them avoids permanently-empty entries in the UI.

  // AnimeSaturn (Italian, via consumet) removed at user request.

  // ── Frembed (VF + VOSTFR, one stream) ──
  // The only source we play with NO proxy: its CDN answers
  // `Access-Control-Allow-Origin: *`, so the browser pulls segments straight
  // from the edge — no Worker hop, no Fast Origin Transfer, no Fluid budget.
  // That, plus a uniform 1080p, is why both chips outrank everything else.
  //
  // ONE master.m3u8 carries BOTH audio renditions (`fr` and `ja`) and the
  // French subtitle tracks. The two chips below therefore resolve the SAME
  // url and differ only by the audio track the player pins (see `audioLang`
  // in pages/api/v2/source). They are split in two rather than offered as a
  // single `multi` chip (megaplay's shape) so they land in the VF/VO groups
  // the language preference already drives.
  {
    id: "frembed",
    name: "Frembed",
    type: "api",
    lang: "vf",
    source: "frembed",
    speed: 1,
  },

  // ── Anime-Sama (VF — French dubs) ──
  {
    id: "animesama-sibnet",
    name: "Anime-Sama Sibnet",
    type: "api",
    lang: "vf",
    source: "animesama",
    /* Rapide au SEEK (rapporte par l'utilisateur), malgre le saut par le proxy
       Fly — mais lent a DEMARRER, et c'est le demarrage qui decide du lecteur
       qu'on ouvre : l'agregat lui donne 8 222 ms (n3) au 20/09/2026, de loin le
       pire du parc. Descendu a 4 le meme jour pour laisser passer voiranime, qui
       recule lui aussi mais mesure 937 ms. */
    speed: 4,
  },
  // Sendvid (VF et VO) RETIRE le 31/08/2026 : sendvid.com repond 502 sur
  // TOUTES ses urls, page d'accueil comprise — une page « We are experiencing
  // technical difficulties » servie a la place du site entier, vue depuis deux
  // reseaux (ligne d'ici et Worker Cloudflare). Ce n'est pas une extraction qui
  // casse, c'est l'hebergeur qui n'est plus la ; les panneaux d'anime-sama, eux,
  // listent toujours ses embeds (25 sur SnK S1 VF), donc rien en amont ne
  // signalera son retour. Anime-sama sert les memes episodes via sibnet et
  // ansembed, deja mieux classes.
  // Pour le rallumer : ces deux entrees, les deux lignes de lib/hostRegistry.js,
  // la cle de tools/opening-detector/host_versions.json, MULTI_HOSTS dans
  // oped/adapter_aniscroll.py, et les deux lignes de ANIMESAMA_SERVERS dans
  // pages/api/v2/source. L'extracteur, lui, est intact.
  /* Voir-Anime passe DERRIERE ansembed le 20/09/2026, a la demande de
     l'utilisateur (« vidmoly a mis bcp de temps a charger »), et la mesure lui
     donne raison. Agregat partage (table `server_perf`) ce jour-la :

       voiranime-vidmoly-vo   demarrage 3 103 ms (n10)
       animesama-ansembed-vo  demarrage 1 312 ms (n4)

     Cote VF l'agregat ne dit encore rien d'ansembed (aucun echantillon de
     demarrage) : le rang y est donc pose sur la foi du report, ce qui est
     exactement l'usage de `speed` — un PRIOR, que les mesures corrigeront
     d'elles-memes si elles le contredisent.

     Pourquoi un cran et pas une permutation : `speed` n'est que le premier des
     trois etages du classement (cf. lib/watch/serverPerf.ts), et l'agregat
     plaçait deja voiranime devant (19,3 contre 19,6) a `speed` EGAL. Les
     echanger de place dans ce fichier n'aurait rien change ; les separer d'un
     rang, si — voiranime tombe a 30,2.

     CE QU'ON PERD, et qu'il ne faut pas « reparer » par megarde : les uploads
     de voir-anime restent frais bien plus longtemps que ceux d'anime-sama
     (reservoir d'uploadeurs different, rotation plus lente). Le mettre en
     premier mettait donc le chip QUI MARCHE en premier. On echange ici un peu
     de disponibilite contre de la vitesse, et cet echange n'est tenable que
     parce que trois filets le rattrapent, tous poses le 20/09/2026 : le verdict
     de la page info (elle teste avant le clic), le souvenir par anime
     (`aniscroll:animeHost`, le lecteur qui a vraiment rendu une image) et la
     bascule `pickNextServer`. Si ces trois-la disparaissent un jour, ce rang
     doit redescendre avec eux. */
  {
    id: "voiranime-vidmoly",
    name: "Voir-Anime Vidmoly",
    type: "api",
    lang: "vf",
    source: "voiranime",
    speed: 3,
  },
  // Ansembed REPLACES the old "Anime-Sama Vidmoly" chip. anime-sama migrated
  // its vidmoly uploads to this white-label domain: it serves the same vidmoly
  // backend (same embed page, same …/hls2/…/master.m3u8 — see VIDMOLY_DOMAINS
  // in lib/extractors.js) and vidmoly.* no longer appears on ANY panel
  // (measured over 17 panels: 0 hits, while ansembed is on 11 of 12 — more
  // often than sibnet). The old chip could never resolve, so it was removed
  // rather than left to fail its probe on every episode. Voir-Anime's Vidmoly
  // is a different SITE with its own uploads and is unaffected.
  // Same browser-side extraction, no proxy, so it keeps Vidmoly's speed rank.
  {
    id: "animesama-ansembed",
    name: "Anime-Sama Ansembed",
    type: "api",
    lang: "vf",
    source: "animesama",
    speed: 2,
  },
  // Uqload — last-resort fallback. Its stream token is IP/single-use-bound
  // (a concurrent pull 403s), so it's the least reliable host; ranked last
  // (speed 5). Unlike the removed Embed4Me it never degrades to a dead iframe:
  // the route hides the chip on extraction failure (uqload's embed is
  // Referer-gated and would only render "embed restricted" in a raw iframe).
  {
    id: "animesama-uqload",
    name: "Anime-Sama Uqload",
    type: "api",
    lang: "vf",
    source: "animesama",
    speed: 5,
  },
  // Embed4Me removed — it frequently failed extraction and fell back to a
  // degraded iframe embed, which is a poor experience. The other anime-sama
  // hosts (Sibnet, Sendvid, Vidmoly) cover the same VF/VOSTFR content.
  // Smoothpre / Movearnpre removed: their playback CDN (acek-cdn) blocks
  // Cloudflare Worker IPs AND we don't want the traffic on Vercel Fast
  // Origin Transfer. We'd need to route via the Fly.io proxy for it, which
  // works but eats the proxy's bandwidth budget for content that's already
  // available on the other working hosts (Vidmoly, Sendvid, Sibnet).

  // ── Anime-Sama (VOSTFR — Japanese with French subs) ──
  // Frembed (VO) — same single stream as the VF chip above, pinned to the `ja`
  // audio rendition; see the VF block.
  {
    id: "frembed-vo",
    name: "Frembed",
    type: "api",
    lang: "vo",
    source: "frembed",
    speed: 1,
  },
  {
    id: "animesama-sibnet-vo",
    name: "Anime-Sama Sibnet",
    type: "api",
    lang: "vo",
    source: "animesama",
    // Descendu a 4 avec son jumeau VF — voir le bloc VF.
    speed: 4,
  },
  // Sendvid (VO) retire le 31/08/2026 avec son jumeau VF — voir le bloc VF.
  // Voir-Anime derriere ansembed — voir le bloc VF. C'est cote VO que la mesure
  // est la plus nette : 3 103 ms de demarrage contre 1 312 ms.
  {
    id: "voiranime-vidmoly-vo",
    name: "Voir-Anime Vidmoly",
    type: "api",
    lang: "vo",
    source: "voiranime",
    speed: 3,
  },
  // Ansembed (VO) — replaces the old Anime-Sama Vidmoly chip; see the VF block.
  {
    id: "animesama-ansembed-vo",
    name: "Anime-Sama Ansembed",
    type: "api",
    lang: "vo",
    source: "animesama",
    speed: 2,
  },
  // Uqload (VO) — last-resort fallback; see the VF block above.
  {
    id: "animesama-uqload-vo",
    name: "Anime-Sama Uqload",
    type: "api",
    lang: "vo",
    source: "animesama",
    speed: 5,
  },
  // Embed4Me removed — see the VF block above.
  // Smoothpre / Movearnpre removed — see comment above the VF block.

  // ── voir-anime.to (VF + VOSTFR) ──
  // Backend supports both languages; the slug resolver picks the -vf variant
  // for VF requests and the un-suffixed slug for VOSTFR.
  // Voir-anime's vidmoly entries are listed up in the anime-sama VF/VO blocks
  // so the two providers' vidmoly chips sit next to each other (voiranime
  // first since its uploads are fresher).
  //
  // Voir-Anime VOE (voiranime-voe / -vo) REMOVED 2026-07-04: voir-anime no
  // longer carries any VOE links in its catalogue (verified — VOE resolved 204
  // on all 10 popular titles tested, sub AND dub, while voir-anime's vidmoly
  // resolved 200). The chip never lit up; it only cost a wasted /api/v2/source
  // probe on every visit. voe.sx itself is alive, so if voir-anime re-adds VOE
  // links later, restore these two entries.
];

export default SERVERS;

/**
 * Le lecteur sur lequel une page de lecture DEMARRE, avant de savoir quoi que
 * ce soit du visiteur.
 *
 * Il existe pour une raison de rendu : la valeur initiale doit etre la meme au
 * serveur et au navigateur, et les preferences (langue, lecteur epingle,
 * memoire par anime) ne se lisent qu'apres le montage. C'etait « megaplay »
 * ecrit en dur a quatre endroits ; depuis son retrait, la constante vit ici,
 * avec la liste qu'elle designe.
 *
 * Ansembed plutot qu'un autre : c'est le panneau d'anime-sama, present sur 11
 * titres sur 12 (mesure en meme temps que le remplacement de l'ancien chip
 * vidmoly), il sert la VF comme la VOSTFR, et il se joue sans proxy — donc
 * sans toucher au budget Fluid pour un lecteur qu'on ouvre a chaque visite.
 */
export const DEFAULT_SERVER_ID = "animesama-ansembed";

/** Return a server definition by id, fallback to first */
export function getServer(id) {
  return SERVERS.find((s) => s.id === id) || SERVERS[0];
}

/**
 * Group servers by language, each group ordered fastest-first.
 *
 * `rank` decides the order INSIDE a language; lower wins. It defaults to the
 * static `speed` above, and callers on the client pass the measured rank from
 * lib/watch/serverPerf instead — which itself falls back to `speed` until it
 * has learned anything, so the default order is unchanged either way.
 *
 * The function is INJECTED rather than imported: this module is pulled in by
 * server-side consumers (and by tools/), and it must not drag a browser-only
 * store behind it.
 */
export function getServersByLang(rank = (s) => s.speed ?? 99) {
  const byLang = (lang) =>
    SERVERS.filter((s) => s.lang === lang).sort((a, b) => rank(a) - rank(b));
  return {
    multi: byLang("multi"),
    vo: byLang("vo"),
    vf: byLang("vf"),
  };
}
