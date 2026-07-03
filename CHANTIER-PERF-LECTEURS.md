# Chantier : lecteurs rapides (seek instantané)

> Fichier de suivi vivant — mis à jour par Claude à chaque étape pour savoir où on en est.
> Plan complet : `C:\Users\luc.deldem\.claude\plans\ok-mes-lecteurs-anime-clever-treasure.md`
> Démarré le 2026-07-03.

## Diagnostic (résumé)

1. **Cache edge du Worker = no-op** : le Worker tourne sur `aniscroll-proxy.luc-deldem.workers.dev`, or l'API Cache de Cloudflare (`caches.default`) ne fonctionne **que sur un domaine custom** rattaché à une zone. Tout le cache segments 24h + pre-warm codé dans `worker/src/index.js` ne stocke rien en prod → chaque seek = aller-retour complet vers l'origine (200-800ms TTFB).
2. **MP4 jamais cachables** : Chrome envoie `Range:` → upstream 206 → `cache.put` rejette les 206, et la clé de cache n'inclut pas le Range.
3. **Concurrents = lecture directe CDN** : AniScroll ne le fait que pour Sibnet (`directUrl`) et Vidmoly (extraction client). Le reste paie le double-hop proxy.
4. Secondaire : plafond Workers Free 100k req/jour ; `workers.dev` sur des blocklists adblock ; preconnect proxy conditionné à l'env var alors que l'URL est hardcodée en fallback.

**Vercel n'est pas le goulot** (les octets vidéo ne passent jamais par Vercel en prod). On reste sur Vercel.

## Décisions

- Domaine : Luc a un domaine **hébergé ailleurs** → migration nameservers vers Cloudflare (zone Free). *(Nom du domaine : à renseigner)*
- Workers Paid 5$/mois : OK si les stats approchent du plafond free.
- Périmètre : infra + worker + direct-CDN + client.

## Avancement

### Code — TERMINÉ (branche dev, à déployer)
- [x] **B1. Worker : header `X-Aniscroll-Cache: HIT|MISS`** (+ expose CORS `worker/src/index.js:110-111`, HIT `:247`, MISS `:317`)
- [x] **B2. Worker : clé de cache avec Range + stratégie MP4** (`worker/src/index.js:199-250, 310-324`) : `bytes=0-` upgradé en fetch full → 200 caché ; seek `bytes=N-` → `cache.match` avec Range → 206 tranché au edge ; 206 upstream jamais mis en cache (`cache.put` les rejette).
- [x] **C1. Sendvid direct** : sonde Referer-agnostique (`Referer: example.com`, `Range: bytes=0-0`) dans `extractSendvid` (`lib/extractors.js:348-377`) → `directUrl+noCors` seulement si le CDN répond 200/206 sans notre Referer.
- [x] **C2. Player** : `directPlaybackRef` (`UniversalPlayer.tsx:1201`) écrit au render (`:3364`), lu dans `onProviderSetup` (`:1242-1248`) → `videoEl.referrerPolicy = "no-referrer"` pour les streams directs. `crossorigin` retiré pour `noCors` (`:3514`).
- [x] **C3. Hôtes HLS** : probe ACAO (`lib/extractors.js:586-612`) → `directUrl` (SANS noCors — hls.js exige CORS via `crossorigin="anonymous"`) si `Access-Control-Allow-Origin` = `*` ou notre origine (`:665`).
- [x] **D1. Preconnect inconditionnel** : constante `PROXY_BASE` résolue en tête de fichier + `<link preconnect/dns-prefetch>` non gardés (`pages/en/anime/watch/[...info].js`).

> ⚠️ Ces changements sont **inertes tant que le Worker tourne sur `workers.dev`** (cache = no-op). Le gain réel arrive avec la Phase A (domaine custom). C1/C2/C3/D1 apportent déjà un gain partiel (lecture directe CDN pour Sendvid/HLS-CORS, moins de hops proxy).

### Infra
- [x] **A1. Domaine sur Cloudflare** : ✅ DÉJÀ FAIT — `aniscroll.com` tourne déjà sur les nameservers Cloudflare (`bethany`/`kenneth.ns.cloudflare.com`). Aucune migration nameserver nécessaire. Enregistrements Vercel intacts (`www` + `dev` → vercel-dns).
- [x] **A2. `wrangler.toml`** : `routes = [{ pattern = "proxy.aniscroll.com", custom_domain = true }]` ajouté. `wrangler deploy` provisionnera le DNS `proxy.aniscroll.com` automatiquement.
- [x] **A3. Bascule app (code)** : les 4 fallbacks hardcodés + le watch page + `.env.example` pointent désormais sur `https://proxy.aniscroll.com` (`UniversalPlayer.tsx:138`, `source/index.js:61`, `extractors.js:21`, `_app.tsx:41`, `watch/[...info].js`).

### DÉPLOIEMENT — FAIT
- [x] **DEPLOY-1. `wrangler deploy`** → `proxy.aniscroll.com` provisionné (custom domain confirmé, Version `d26e9974`).
- [x] **DEPLOY-2. Vercel** : env var `NEXT_PUBLIC_PROXY_BASE=https://proxy.aniscroll.com` posée (Prod + Preview/dev).
- [x] **Code pushé sur `dev`** : commit `bfd233f`.

### ✅ VÉRIFICATION — CACHE EDGE PROUVÉ (2026-07-03)
Test `curl` ×3 sur un vrai segment MegaCloud (`seg-247`, 999 Ko) via `proxy.aniscroll.com` :
- Passe 1 : `X-Aniscroll-Cache: HIT` — TTFB 194 ms, total 263 ms
- Passe 2 : HIT — TTFB 76 ms
- Passe 3 : HIT — TTFB **52 ms**, total 106 ms
→ Avant : mêmes segments à **3.00 s** (jusqu'à 8.44 s) en Network. **~30-80× plus rapide** sur cache chaud. Cache partagé entre tous les visiteurs (HIT dès le 1er curl, rempli par la lecture navigateur).

### Session 2 (2026-07-04) — bugs découverts en test réel + optimisation seek

**Bug chip Megaplay/VOE qui disparaît — 3 causes empilées, TOUTES corrigées :**
- [x] `d58603f` — extractMegaplay : échec transitoire (timeout/anti-bot/5xx) était traité comme absence définitive → negative-cache + 204 → publié `absent` 6h. Fix : `absent:true` seulement sur le vrai "file not found" ; les autres → `sendRetryable` (503, pas de negative-cache).
- [x] `6823f3a` — l'activeServer (megaplay par défaut / serveur préféré) est résolu HORS du pool de probe → son verdict n'entrait jamais dans `cachedConfirmed` (le Set qui construit le snapshot) → jamais publié. Fix : `activeVerdictRef` + union à la publication.
- [x] `93f3def` — **le vrai déblocage** : le write-guard de 10 min faisait que le 1er publisher claimait le slot ; un serveur lent (megaplay arrive après les vidmoly dans le pool) restait EXCLU 6h. Fix : un POST qui apporte un id NOUVEAU bypasse le guard.
- [x] **Réparation manuelle** des snapshots pollués JJK (113415) + AoT (16498) ep 1-12 sub (megaplay vérifié 200 puis POST). Les autres animes s'auto-réparent au 1er visionnage grâce à `93f3def`.

**Bug freeze infini au seek-spam :**
- [x] `e0f1a1b` — sur CDN direct fragile (Vidmoly `vmwesa.online`), le spam fait couper le CDN (`net::ERR_EMPTY_RESPONSE`) → erreur fatale SANS status HTTP → le handler l'ignorait (ne gérait que 401/403/404/410) → gel éternel. Fix : récupération hls.js active (startLoad/recoverMediaError, max 4/12s puis fallback) + hard-resume 1.2s dans le coalescing seek-spam.

**Cosmétique :**
- [x] `f9ae1db` — barre de progression plus épaisse aux jonctions de chapitres AniSkip → `overflow:hidden` sur les pilules.

**Optimisation seek froid (le vrai sujet perf) :**
- [x] `227bc0a` — worker : le warm ratait ~2/3 des segments (MegaCloud déguise en .html/.js, pas seulement .ts/.jpg). Fix : "tout ce qui n'est pas .m3u8 enfant" = segment. Samples 10→20.
- [x] `cd620a7` — **hover pre-warm client** : survoler la barre → fetch fire-and-forget du fragment HLS sous le curseur → warme le edge AVANT le clic → seek quasi-instant au 1er visionnage. Non-interférent, throttlé, dédup, skip si bufferisé. ⚠️ À TESTER.

**Sendvid preview manquante** : NON un bug — `HoverPreview` est volontairement désactivé pour les streams `noCors` (canvas tainté sans CORS, impossible de capturer les frames). Comme Sibnet. Options si on veut la preview : repasser Sendvid par le proxy (perd le direct-CDN).

**RÉPONSE à "pourquoi les autres sites sont instantanés et pas nous"** : eux jouent le CDN en DIRECT (1 saut). Nous DEVONS proxifier MegaCloud (le CDN 403 sans Referer megaplay.buzz, que seul un proxy serveur peut injecter) → 2 sauts sur un MISS. Le cache edge annule le 2e saut sur HIT (52ms, aussi rapide/plus rapide qu'eux). Le seul point lent = cache FROID (1er visionnage, seek vers un trou) → attaqué par warm serveur + hover-prefetch. Piste non explorée : jouer MegaCloud en direct SI son CDN accepte le CORS (comme Vidmoly) — à tester si le hover-prefetch ne suffit pas.

### RESTE
- [ ] **TESTER hover-prefetch** (`cd620a7`) : survoler la barre loin puis cliquer → doit être quasi-instant au 1er visionnage.
- [ ] **Merge `dev` → `main`** une fois tout validé sur dev.
- [ ] (Optionnel) Explorer le direct MegaCloud (CORS) si le hover-prefetch ne suffit pas.
- [ ] (Optionnel) Améliorer Vidmoly (config hls.js dédiée, moins agressif) — demandé mais mis en pause pour prioriser le seek.
- [ ] (Suivi) Surveiller dashboard Workers (req/jour) ; > ~70k/jour → Workers Paid 5$/mois.

## Notes en cours de route

- Typecheck : les erreurs `tsc` restantes sont pré-existantes (deps non installées dans ce checkout : `@upstash/redis`, `ably`) — aucune ne touche mes fichiers.
- Le header debug est capitalisé `X-Aniscroll-Cache` (HTTP header-insensible ; le plan écrivait `x-aniscroll-cache`).
