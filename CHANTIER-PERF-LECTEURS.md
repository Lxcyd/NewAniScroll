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

- [ ] **B1. Worker : header `x-aniscroll-cache: HIT|MISS`** (+ expose CORS) — EN COURS
- [ ] **B2. Worker : clé de cache avec Range + stratégie MP4** (bytes=0- → fetch sans Range → 200 caché ; seek → cache.match(Range) → 206 edge ; miss → forward Range non caché)
- [ ] **C1. Sendvid direct** : sonde no-referer côté serveur dans `extractSendvid` (`lib/extractors.js:300`) → `directUrl+noCors`
- [ ] **C2. Player** : `referrerPolicy="no-referrer"` pour les streams `noCors` (`UniversalPlayer.tsx`)
- [ ] **C3. Hôtes HLS** (movearnpre/smoothpre/dingtezuni) : check ACAO → `directUrl` si CORS OK
- [ ] **D1. Preconnect inconditionnel** au PROXY_BASE résolu (`pages/en/anime/watch/[...info].js:1792`)
- [ ] **A1. Migration domaine** vers Cloudflare (action manuelle Luc, guidée)
- [ ] **A2. `wrangler.toml`** : `routes = [{ pattern = "proxy.<domaine>", custom_domain = true }]` + deploy
- [ ] **A3. Bascule app** : env Vercel `NEXT_PUBLIC_PROXY_BASE` + fallbacks hardcodés (UniversalPlayer.tsx:135, source/index.js:59, extractors.js:20, _app.tsx:40)
- [ ] **V. Vérification** : curl MISS→HIT, seek HLS/MP4, non-régression Sibnet/Vidmoly/VOE/downloads

## Notes en cours de route

- (vide)
