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

### RESTE
- [ ] **Merge `dev` → `main`** pour propager les changements applicatifs (direct-CDN Sendvid, preconnect, referrerPolicy) en prod. Le Worker + cache edge servent DÉJÀ la prod (Worker commun aux 2 envs).
- [ ] (Suivi) Vérifier le seek MP4 (Sendvid) et non-régression Sibnet/Vidmoly/VOE en usage réel.
- [ ] (Suivi) Surveiller dashboard Workers (req/jour) ; > ~70k/jour récurrent → Workers Paid 5$/mois.

## Notes en cours de route

- Typecheck : les erreurs `tsc` restantes sont pré-existantes (deps non installées dans ce checkout : `@upstash/redis`, `ably`) — aucune ne touche mes fichiers.
- Le header debug est capitalisé `X-Aniscroll-Cache` (HTTP header-insensible ; le plan écrivait `x-aniscroll-cache`).
