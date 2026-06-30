# Déploiement — réduction du Fluid Active CPU Vercel

Checklist des étapes **manuelles** (infra/secrets) à faire après merge. Le code
est prêt ; ces étapes branchent les services externes. Tant qu'elles ne sont pas
faites, tout **dégrade proprement** vers les routes Vercel existantes (aucune
casse), mais le gain CPU n'est pas encore actif.

## 1. Ably (temps-réel Watch 2gether)

1. Créer un compte Ably (free tier) → créer une app → copier la **Root API key**.
2. Vercel → Project → Settings → Environment Variables :
   - `ABLY_API_KEY` = la clé root Ably (**secret serveur**, ne pas préfixer `NEXT_PUBLIC_`).
3. Sans cette clé : `/api/v2/watch2gether/ably-token` renvoie 503 et le client ne
   se connecte pas en temps réel. Le SSE legacy (`stream.ts`) est **toujours en
   place** comme filet, mais le client ne l'appelle plus — donc tant qu'`ABLY_API_KEY`
   n'est pas posée, la sync ne fonctionne pas. **À poser avant de compter sur la
   migration.**

> Le `package.json` déclare déjà `ably` ; Vercel l'installe au build.

## 2. Cloudflare Worker — KV + secrets (health / broadcast / track)

Dans `worker/` :

1. Créer le namespace KV (une fois) :
   ```
   wrangler kv namespace create W2G_CACHE
   ```
   Copier l'`id` renvoyé dans `worker/wrangler.toml` (remplacer
   `REPLACE_WITH_KV_NAMESPACE_ID`).
2. Secrets pour `/w/track` (analytics → Turso) :
   ```
   wrangler secret put TURSO_ADMIN_URL     # libsql://<admin-db>.turso.io
   wrangler secret put TURSO_ADMIN_TOKEN   # token admin Turso
   ```
3. Déployer le Worker :
   ```
   wrangler deploy
   ```

## 3. Vercel — écriture vers Cloudflare KV (mirror health/broadcast)

Pour que les routes Vercel `anilist-health` et `broadcast` poussent la valeur
dans KV (lu par le Worker), poser sur Vercel :

- `CF_ACCOUNT_ID`       = account id Cloudflare
- `CF_KV_NAMESPACE_ID`  = le **même** id que `W2G_CACHE` ci-dessus
- `CF_KV_API_TOKEN`     = token API Cloudflare avec permission *Workers KV Storage: Edit*

> Le Worker `/w/health` est **auto-suffisant** : si KV est vide/périmé il sonde
> AniList lui-même et réécrit KV. Le mirror Vercel n'est qu'un seed/fallback —
> donc même sans ces 3 vars, la bannière santé fonctionne via le Worker. Le
> mirror reste utile pour le **broadcast** (le Worker ne recalcule pas le
> broadcast ; il lit KV). **Pour que les broadcasts admin s'affichent en prod,
> ces 3 vars sont nécessaires.**

## 4. Vérifs post-déploiement

Voir la section « Plan de test de régression » dans le plan
(`~/.claude/plans/comment-r-duire-0-rippling-tarjan.md`). En bref :

- Watch 2gether : 2 onglets se synchronisent (Ably), guests inclus.
- DevTools Network : `/w/health`, `/w/broadcast`, `/w/track` partent vers
  `*.workers.dev` (plus vers Vercel). `ABLY_API_KEY` jamais exposé client.
- `curl -I` sur `/en/anime/...` → `CDN-Cache-Control: s-maxage=21600`.
- Onglet en arrière-plan → aucun poll health/broadcast/presence ne part.
- 72 h plus tard : Fluid Active CPU Vercel **< 4h**, fonction `stream` absente du top.

## 5. Nettoyage (après validation prod, optionnel)

Une fois la sync Ably confirmée en prod sur quelques jours, on peut supprimer le
SSE legacy et son code :

- `pages/api/v2/watch2gether/stream.ts`
- `lib/watch2gether/subscriber.ts`
- le `redis.publish(...)` dans `publishEvent` (`lib/watch2gether/redisRoom.ts`)
  ne sert plus qu'au SSE — à retirer en même temps.

Les routes Vercel `/api/v2/track`, `/api/v2/anilist-health`,
`/api/v2/admin/broadcast` (GET) restent comme fallback local-dev et seed ; pas
besoin de les supprimer.
