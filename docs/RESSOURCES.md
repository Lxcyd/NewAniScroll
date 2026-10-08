# Ressources externes d'AniScroll

Le carnet d'adresses du projet : tout ce qu'on utilise, et tout ce qu'on POURRAIT
utiliser un jour — bases de donnees, API, lecteurs, outils, jusqu'aux plus niches.
But : quand un besoin arrive (« d'ou viennent les horaires VF ? », « qui a les
chapitres des releases ? »), chercher ici avant de chercher sur le web.

Lancee le 09/10/2026 a partir de [wotaku.wiki/misc](https://wotaku.wiki/misc),
de l'analyse de reanime.to et ani.pm, et du code du site.

**Legende** — ✅ utilise (fichier entre crochets) · 🧪 essaye / partiel ·
⏳ pas encore utilise · ☠️ mort ou retire · ⚖️ risque juridique (contenu sous
droits, DMCA deja vu) · 🔑 cle / compte requis · 🐢 limite de debit severe.

> L'etat des LECTEURS (frembed, megaplay…) ne se lit PAS ici : la seule source
> est [lib/lecteurs.json](../lib/lecteurs.json). Ce fichier ne fait que les citer.

> Les URLs marquees « a verifier » sont citees de memoire et n'ont pas ete
> ouvertes au moment de l'ecriture. Corriger la ligne quand on s'en sert.

---

## 1. Bases de donnees anime / manga

| Site | Ce qu'il apporte | Acces | Chez nous |
| --- | --- | --- | --- |
| [AniList](https://anilist.co) | Base principale : titres, genres, tags, relations, saisons, listes utilisateurs, trailers | API GraphQL `graphql.anilist.co`, ~90 req/min 🐢 | ✅ partout [lib/anilist/] |
| [MyAnimeList](https://myanimelist.net) | Notes, classement, notes PAR EPISODE | Via Jikan (non officiel) ; API officielle v2 🔑 | ✅ via Jikan [onglet Scores] |
| [Jikan](https://jikan.moe) | API REST non officielle de MAL, sans cle | `api.jikan.moe/v4`, 3 req/s, 60/min 🐢 | ✅ [lib/…, score-grid] |
| [AniDB](https://anidb.net) | La base la plus fine sur les EPISODES : specials, recaps, ep 0, types « credits » (OP/ED), fichiers par release (hash ed2k) | API HTTP/UDP 🔑, bannit vite 🐢 | ⏳ — cf. anime-lists ci-dessous |
| [Kitsu](https://kitsu.app) | Base alternative, episodes avec vignettes | API JSON:API publique | ⏳ |
| [Anime-Planet](https://www.anime-planet.com) | Recos, tags, base doubleurs | Pas d'API (scrape) | ⏳ |
| [aniSearch](https://www.anisearch.com) | Base allemande tres complete, titres DE/FR | Scrape | ⏳ |
| [Anime News Network Encyclopedia](https://www.animenewsnetwork.com/encyclopedia/) | Staff, casting, sorties, licences | API XML publique (`cdn.animenewsnetwork.com/encyclopedia/api.xml`) | ⏳ |
| [Shikimori](https://shikimori.one) | Base russe, API complete, ids MAL | API REST publique | ⏳ (a verifier) |
| [Bangumi](https://bgm.tv) | Base chinoise, ids utilises par anitabi | API publique `api.bgm.tv` | ⏳ |
| [Annict](https://annict.com) | Base japonaise, episodes, horaires TV JP | API GraphQL 🔑 | ⏳ |
| [Kurozora](https://kurozora.app), [NeoApo](https://neoapo.com) | Bases alternatives (iOS / communautaire) | — | ⏳ |
| [MangaBaka](https://mangabaka.org), [MangaUpdates](https://www.mangaupdates.com) | Manga : groupes de scan, sorties, series liees | API MangaUpdates publique | ⏳ |
| [MangaDex](https://mangadex.org) | Manga : chapitres, covers | API publique | ⏳ ⚖️ (contenu) |
| [VNDB](https://vndb.org) | Visual novels (sources d'animes) | API publique | ⏳ |
| [Nautiljon](https://www.nautiljon.com) | Base FRANCAISE : licences FR, editeurs, VF, dates de sortie FR | Scrape | ⏳ — la meilleure source pour « licencie en France par… » |
| [Wikipedia](https://www.wikipedia.org) / [NamuWiki](https://namu.wiki) | Listes d'episodes avec dates, titres JP, diffusions | API MediaWiki | ⏳ |
| [Bookmeter](https://bookmeter.com), [Goodreads](https://www.goodreads.com), [Hardcover](https://hardcover.app), [Hanmoto](https://www.hanmoto.com) | Light novels / romans sources | Hardcover : API GraphQL | ⏳ |

### Correspondances d'identifiants (le nerf de la guerre)

| Projet | Ce qu'il fait | Chez nous |
| --- | --- | --- |
| [ani.zip](https://api.ani.zip) | AniList -> MAL/AniDB/TVDB/TMDB/Kitsu + episodes avec titres, vignettes, dates | ✅ [lib/anizip/] |
| [Anime-Lists/anime-lists](https://github.com/Anime-Lists/anime-lists) | Mapping AniDB -> TVDB/TMDB **avec decalages d'episodes par saison** (XML) | ⏳ — fiabiliserait la numerotation (Mushoku Tensei ep 0, SAO II 14.5, Fairy Tail) |
| [Fribb/anime-lists](https://github.com/Fribb/anime-lists) | JSON qui fusionne ids AniList/MAL/AniDB/Kitsu/TVDB/TMDB/IMDb | ⏳ |
| [manami-project/anime-offline-database](https://github.com/manami-project/anime-offline-database) | Toute la base anime en un JSON (sources croisees de 10 sites), mis a jour chaque semaine | ⏳ — ideal pour un import hors ligne |
| [arm-server](https://github.com/BeeeQueue/arm-server) | API qui convertit un id d'un site vers un autre | ⏳ (a verifier) |
| [Simkl](https://simkl.com) | Mapping + episodes + images (stills) | ✅ [lib/anizip/episodes.ts, schema.sql] 🔑 |

---

## 2. Images et artwork

| Site | Ce qu'il apporte | Chez nous |
| --- | --- | --- |
| AniList (`s4.anilist.co`) | Covers (JPEG, `extraLarge` ~460x652), bannieres | ✅ |
| [TMDB](https://www.themoviedb.org) | Backdrops 4K, LOGOS de titre (PNG transparents), stills d'episodes | ✅ backdrops/logos ; ☠️ stills bannis (03/08) 🔑 |
| [fanart.tv](https://fanart.tv) | Logos HD, clearart, backgrounds | ✅ [lib/db/fanarts.ts] 🔑 |
| [wallhaven](https://wallhaven.cc) | Fonds d'ecran HD par recherche | ✅ [lib/db/wallhavenImages.ts] |
| [TheTVDB](https://thetvdb.com) | Artwork + ordres d'episodes alternatifs (aired/DVD/absolute) | ⏳ 🔑 (payant pour l'API v4) |
| [Zerochan](https://www.zerochan.net), [Safebooru](https://safebooru.org), [Danbooru](https://danbooru.donmai.us), [Konachan](https://konachan.net), [yande.re](https://yande.re), [Anime-Pictures](https://anime-pictures.net) | Fanarts tagues par personnage / serie, API booru | ⏳ ⚖️ (droits des artistes) |
| [Pixiv](https://www.pixiv.net) | Fanarts originaux | ⏳ ⚖️ |
| [Anime Characters Database](https://www.animecharactersdatabase.com) | Personnages, images, traits | ⏳ |
| [wsrv.nl](https://wsrv.nl) | Proxy de redimensionnement / conversion WebP gratuit | ✅ [lib/images/imgProxy.ts] — BLOQUE le domaine AniList |
| [imgproxy](https://imgproxy.net), Cloudflare Images | Alternatives auto-hebergees / payantes | ⏳ |

**Comment font les autres** (analyse du 08-09/10/2026) :
- **ani.pm** : banniere = backdrop TMDB reencode en WebP 3 tailles (`/banners/t/<id>.webp`, `-1600`, `-p` recadrage portrait mobile), cache Cloudflare 1 mois ; cover = fichier AniList identique a l'octet, resservi via `/api/anime/cover?key=<sha256>` (`x-artwork-store: owned-origin`).
- **reanime.to** : cadres d'avatar Discord (372, 42 categories) servis par `static.anicdn.cc/avatar-decorations/<slug>.avif|webp` ; catalogue `/api/v1/frames`.

### Cadres d'avatar (decorations)
| Source | Contenu | Note |
| --- | --- | --- |
| [itemshop.gg/discord](https://itemshop.gg/discord) | Toute la boutique Discord republiee chaque jour (688 decorations, 90 collections au 08/10/2026), donnees dans le flux Next.js de la page | ✅ source du catalogue `avatar_frames` (scripts/discord-frames/sync-frames.mjs, GH Action nocturne) ; images hotlinkees sur le CDN Discord |
| [Kadantte/discord-fake-avatar-decorations](https://github.com/Kadantte/discord-fake-avatar-decorations) | 640 PNG animes `public/decorations/<slug>.png`, miniatures WebP, catalogue `src/data/decorations.js` | ⚖️ fork d'un depot retire par DMCA (ItsPi3141) |
| CDN Discord `cdn.discordapp.com/avatar-decoration-presets/<asset>.png?passthrough=true` | Les originaux | ⚖️ il faut l'`asset` (API boutique 🔑) |
| [Vencord « Decor »](https://github.com/Vendicated/Vencord) | Decorations creees par les utilisateurs | ⚖️ variable |

---

## 3. Calendriers et horaires de diffusion

| Site | Ce qu'il apporte | Chez nous |
| --- | --- | --- |
| AniList `airingSchedule` | Heure de diffusion JP par episode | ✅ [/schedule] |
| [AnimeSchedule.net](https://animeschedule.net) | Heures de sortie REELLES : raw, sous-titre, DUB ; reports | ⏳ — API publique 🔑 ; la meilleure source pour « quand sort la VOSTFR / VF » |
| [LiveChart](https://www.livechart.me) | Horaires, reports, pauses, streams | ⏳ (scrape) |
| [AniChart](https://anichart.net) | Saison en grille (meme donnees qu'AniList) | — doublon |
| [Anime Countdown](https://animecountdown.com), [Anisaki](https://anisaki.vercel.app) | Comptes a rebours | ⏳ |
| [Anica](https://anica.jp), [aniSearch Calendar](https://www.anisearch.com/anime/calendar) | Calendriers mensuels | ⏳ |
| [Syoboi Calendar](https://cal.syoboi.jp) | Horaires TV JAPONAIS chaine par chaine, titres d'episodes JP | ⏳ — API publique (`cal.syoboi.jp/db.php`) |
| [Bangumi List](https://bgmlist.com), [Kansou](https://www.kansou.me), [Moon Phase](https://m-p.sakura.ne.jp), [Anime Hack](https://anime.eiga.com), [CoolJapan](https://cooljapanportal.com) | Calendriers japonais | ⏳ |
| [Anime Dubs Release Calendar](https://teamup.com/ksdhpfjcouprnauwda), [English Dubbed Anime Lovers](https://english-dubbed.com) | Sorties des DUB anglais | ⏳ |
| [Blu-ray.com](https://www.blu-ray.com), [Yatta-Tachi](https://yattatachi.com) | Sorties BD / films en salle | ⏳ |
| [TVmaze](https://www.tvmaze.com) | Episodes et horaires, API gratuite sans cle | ⏳ |

---

## 4. Doublage (VF / VA)

| Site | Ce qu'il apporte | Chez nous |
| --- | --- | --- |
| [MyDubList](https://mydublist.com) | Quels animes ont un dub, dans quelles langues | ✅ [lib/db/dubCatalog.ts] |
| [RS Doublage](https://www.rsdoublage.com) | Base des castings VF (comediens par role) | ⏳ (scrape) |
| [Doublage Quebec](https://doublage.qc.ca) | VF quebecoise | ⏳ |
| [La Tour des Heros](https://www.latourdesheros.com) | Fiches doublage VF animes (a verifier) | ⏳ |
| Kenny Stryker's English dublist (forum MAL) | Liste des dubs EN | ⏳ |

---

## 5. Musique, OP/ED

| Site | Ce qu'il apporte | Chez nous |
| --- | --- | --- |
| [AnimeThemes](https://animethemes.moe) | OP/ED en video/audio (WebM/OGG), sequences, versions ; references du detecteur | ✅ [lib/animethemes/, tools/opening-detector-v2/refs/] |
| [AniSkip](https://aniskip.com) | Bornes OP/ED communautaires par MAL id + episode | ✅ [lib/context/watchPageProvider.js] |
| [anime-skip](https://anime-skip.com) | Bornes communautaires (GraphQL, 🔑 client id) | ✅ [lib/skip/providers.ts] |
| [AnisongDB](https://anisongdb.com) | Base AMQ : chaque OP/ED/insert, artistes, liens audio | ⏳ — API JSON publique (a verifier) |
| [AnimeSongs.org](https://www.animesongs.org) | Paroles, credits | ⏳ |
| [Aniplaylist](https://aniplaylist.com) | Liens Spotify / Apple Music / YouTube des OP/ED | ⏳ — « ecouter l'OP sur Spotify » |
| [anison.info](http://anison.info) | Base japonaise exhaustive des anisongs | ⏳ |
| [VGMdb](https://vgmdb.net) | OST, albums, catalogues | ⏳ (API non officielle vgmdb.info) |
| [Spotify Web API](https://developer.spotify.com) | Lecture d'extraits, pochettes | ⏳ 🔑 |

### Detection audio (si on revoit le detecteur)
| Outil | Usage |
| --- | --- |
| [Chromaprint / fpcalc](https://acoustid.org/chromaprint) | Empreintes audio — ce qu'utilise le plugin Jellyfin Intro Skipper |
| [Intro Skipper (Jellyfin)](https://github.com/intro-skipper/intro-skipper) | Detection d'intros par comparaison d'episodes, sans reference |
| [audfprint](https://github.com/dpwe/audfprint), [Panako](https://github.com/JorenSix/Panako), [Olaf](https://github.com/JorenSix/Olaf) | Empreintes robustes au changement de vitesse / hauteur (doublages a 1001/1000) |
| [librosa](https://librosa.org), [Essentia](https://essentia.upf.edu) | Analyse audio Python (onsets, chroma) |

### Chapitres des releases (bornes gratuites)
| Source | Ce qu'il apporte |
| --- | --- |
| Chapitres MKV des fansubs (« Opening », « Ending », « Part A »…) | Bornes OP/ED posees par l'encodeur — c'est ce que reanime.to/flixcloud affichent |
| [Animetosho](https://animetosho.org) | Indexe les releases, EXTRAIT chapitres, sous-titres et pistes des MKV | ⏳ — source de chapitres sans telecharger la video |
| [SeaDex](https://releases.moe) | « Meilleure release » par anime | ⏳ |
| [Nyaa](https://nyaa.si) | Index des releases | ⏳ ⚖️ |

---

## 6. Episodes : fillers, recaps, ordre de visionnage

| Site | Ce qu'il apporte | Chez nous |
| --- | --- | --- |
| [Anime Filler List](https://www.animefillerlist.com) | Canon / filler / mixte par episode | ⏳ — badge « filler » + « passer les fillers » ; scrape, donnees stables |
| [Related Anime](https://relatedanime.com), [WikiTimeline](https://wiki-timeline.com) | Ordre de visionnage d'une franchise | ⏳ (AniList `relations` suffit) |
| [Manga Adaptations](https://anilist-adaptations.timschneeberger.me) | Jusqu'a quel chapitre va l'anime | ⏳ — « continuer en manga : chapitre X » |
| [Chiaki.site](https://chiaki.site) | Ordre de visionnage genere depuis MAL (a verifier) | ⏳ |

---

## 7. Lieux reels, culture

| Site | Ce qu'il apporte | Chez nous |
| --- | --- | --- |
| [anitabi](https://www.anitabi.cn) | Carte des lieux reels des decors, photos comparees | ⏳ — API par id Bangumi (a verifier) |
| Flubber's Fluttering Anime Pilgrimage, Anime Tourism | Blogs de pelerinage | ⏳ |
| [Animechan](https://animechan.io) | Citations d'anime (API) | ⏳ |

---

## 8. Recherche, reconnaissance, recommandations

| Outil | Ce qu'il fait | Chez nous |
| --- | --- | --- |
| [trace.moe](https://trace.moe) | Retrouve anime + episode + minute depuis une capture | ✅ [components/search/searchByImage.tsx] |
| [SauceNAO](https://saucenao.com) | Source d'une image (fanart, manga) | ⏳ 🔑 |
| [due.moe](https://due.moe) | Ce qui sort dans ta liste AniList | ⏳ (idee) |
| [Randime](https://randime.moe), [Spin.moe](https://spin.moe) | Anime au hasard | ⏳ (trivial chez nous) |
| [Konsumr](https://www.konsumr.com), [Anime Bingo](https://anime-bingo.aikats.us) | Gadgets communautaires | ⏳ |
| Jeux de donnees Kaggle (MAL ratings, AniList) | Entrainer / evaluer le moteur de recos | ⏳ |

---

## 9. Actualites (si un jour on fait un fil d'actus)

[Anime News Network](https://www.animenewsnetwork.com) (RSS) ·
[Crunchyroll News](https://www.crunchyroll.com/news) ·
[MAL News](https://myanimelist.net/news) ·
[animate Times](https://www.animatetimes.com) ·
[ORICON NEWS](https://www.oricon.co.jp) / [Japan Anime News](https://us.oricon-group.com) ·
[Anime UK News](https://animeuknews.net) · [Otaku News](https://www.otakunews.com) ·
[Anime Blog Tracker](https://aniblogtracker.app) · [Anime Nano](https://www.animenano.com) ·
FR : [Animeland](https://www.animeland.fr), [Manga-News](https://www.manga-news.com), [Adala News](https://adala-news.fr).
Sites de franchise : [GUNDAM.INFO](https://en.gundam-official.com), [Kanzenshuu](https://www.kanzenshuu.com) (Dragon Ball), [Rumic World](https://www.furinkan.com) (Takahashi).

⚠ Un fil d'actus sur Vercel = invocations de fonction ; le faire tourner cote Cloudflare (cron Worker -> KV).

---

## 10. Lecture video : sources et outils

Etat des lecteurs : **[lib/lecteurs.json](../lib/lecteurs.json)** (seule source).
Pour memoire, les hotes croises dans le code :
frembed (`frembed.*`, domaine tournant), megaplay (`megaplay.buzz`), ansembed,
vidmoly (`vidmoly.to/.net`), anime-sama (`anime-sama.to`), voir-anime
(`voir-anime.to`), sibnet ☠️, uqload ☠️, sendvid ☠️, animepahe/kwik ☠️,
aniwatchtv, megaup, embed4me, mewstream.

Vu ailleurs : **flixcloud.cc** (reanime.to : Artplayer + hls.js, MKV « dual audio »
VO+VA dans un meme fichier, chapitres MKV, sous-titres sur `vault-*.fallencdn.top`).

| Outil | Usage |
| --- | --- |
| [hls.js](https://github.com/video-dev/hls.js) | Lecture HLS navigateur (horloge = 1er segment charge, cf. memoire « horloge lecteur ») |
| [Vidstack](https://vidstack.io) | Notre lecteur |
| [Artplayer](https://artplayer.org) | Lecteur de flixcloud, plugins chapitres |
| [Shaka Player](https://github.com/shaka-project/shaka-player) | DASH + HLS, DRM |
| [JASSUB](https://github.com/ThaUnknown/jassub) / [SubtitlesOctopus](https://github.com/libass/JavascriptSubtitlesOctopus) | Rendu ASS (libass en WASM) — sous-titres de fansub avec styles |
| [Anime4K](https://github.com/bloc97/Anime4K) | Upscale temps reel (shaders, existe en WebGPU) |
| [ffmpeg](https://ffmpeg.org), [MKVToolNix](https://mkvtoolnix.download) | Extraction pistes/chapitres |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp), [streamlink](https://streamlink.github.io) | Recuperation de flux |
| [Jimaku](https://jimaku.cc), [Kitsunekko](https://kitsunekko.net), [OpenSubtitles](https://www.opensubtitles.com) | Sous-titres (JP / multi) | 

---

## 11. Infrastructure et services

| Service | Role | Chez nous |
| --- | --- | --- |
| Vercel (Hobby, 2 comptes) | Site prod + dev | ✅ — quotas : voir CLAUDE.md |
| Cloudflare Workers / KV / DNS | Proxy video `proxy.aniscroll.com`, cache edge | ✅ |
| Cloudflare R2 | Stockage objets sans frais de sortie (images, cadres, archives) | ⏳ |
| [Upstash Redis](https://upstash.com) | Cache + etat W2G ; Free 500 K cmd/mois | ✅ — dev et prod PARTAGENT une base (a separer) |
| [Turso](https://turso.tech) | SQLite distribue : player_map, skips, fanarts, runtimes | ✅ |
| Postgres (Prisma) | Comptes, donnees utilisateur | ✅ |
| [Resend](https://resend.com) | E-mails (verification, mots de passe) | ✅ [lib/auth/mail.ts] |
| Google Translate (endpoint public) | Traduction synopsis | ✅ [pages/api/v2/translate.ts] |
| [Spaceship](https://www.spaceship.com) | Registrar du domaine | ✅ |
| YouTube / Dailymotion | Trailers (seul YouTube est joue en fond de profil) | ✅ |

---

## 12. Annuaires a fouiller quand on cherche plus

- [wotaku.wiki](https://wotaku.wiki) — l'annuaire de reference (sites, outils, guides) ; pages `/misc`, `/websites`, `/tools`, `/guides`.
- [everythingmoe](https://everythingmoe.com) — annuaire concurrent (a verifier).
- [awesome-anime-sources / awesome lists GitHub](https://github.com/search?q=awesome+anime&type=repositories) — listes d'API et projets.
- [r/animepiracy wiki](https://www.reddit.com/r/animepiracy/wiki/) — sources video et index (⚖️).
- Archives 4chan /a/ ([Desuarchive](https://desuarchive.org), [Warosu](https://warosu.org), [arch.b4k](https://arch.b4k.dev), [4plebs](https://archive.4plebs.org)) — pour retrouver une discussion technique perdue ; rien d'utile au site lui-meme.

---

## Comment tenir ce fichier

- Un service adopte : passer sa ligne a ✅ avec le fichier qui l'appelle.
- Un service qui meurt : ☠️ + la date. Pour un LECTEUR, l'ecrire d'abord dans `lib/lecteurs.json`.
- Une analyse d'un site concurrent : resumer ce qu'on a appris dans la section concernee (comme ani.pm / reanime ci-dessus).
