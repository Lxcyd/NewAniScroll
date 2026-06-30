# HANDOFF — Réduction Fluid Active CPU Vercel (à reprendre sur l'autre PC)

> **À Claude :** ce fichier est le contexte pour reprendre le travail. Le code est
> écrit (non commité au moment de l'écriture). Il reste les étapes infra/secrets.
> L'utilisateur va sur un PC qui a Node + wrangler pour faire la partie 2, puis la
> partie 3 (Vercel). Aide-le à finir le branchement et la vérif.

## Pourquoi on fait ça

Vercel dépasse son quota gratuit : **4h50 / 4h de Fluid Active CPU**. Objectif :
repasser sous 4h en déportant le travail hors du serverless Vercel (vers Ably +
le Worker Cloudflare existant) ou en l'éliminant (edge cache). On ne vise PAS 0
absolu (impossible avec trafic + SSR).

Cause n°1 = le SSE Watch 2gether (`stream.ts`) qui gardait une fonction Vercel
vivante ~58s par connexion (~1h de quota par personne-heure dans une room).

## Ce qui est DÉJÀ fait dans le code (non commité)

1. **Temps-réel w2g : SSE → Ably**
   - `lib/watch2gether/ably.ts` (client REST serveur), `pages/api/v2/watch2gether/ably-token.ts`
     (token subscribe-only scoppé à la room), `publishEvent` publie Ably + Redis,
     `useWatchParty.ts` utilise Ably au lieu d'EventSource.
   - `stream.ts` / `subscriber.ts` GARDÉS en fallback (suppression après validation prod).
2. **SSR `/en/anime/[...id]`** : edge cache élargi 1h → 6h (`s-maxage=21600`).
3. **Déports vers le Worker Cloudflare** (`worker/src/edge-endpoints.js`) :
   - `/w/health` (auto-suffisant : sonde AniList + écrit KV), `/w/broadcast` (lit KV),
     `/w/track` (analytics → Turso via HTTP).
   - Côté Next : `lib/cloudflareKv.ts` mirrore health/broadcast dans KV ; les
     clients (`_app.tsx`, `AnilistHealthBanner.tsx`) pollent le Worker.
4. **Polling on-focus** : health, broadcast, presence w2g s'arrêtent quand l'onglet
   est caché.

> Tout DÉGRADE proprement vers les routes Vercel tant que l'infra n'est pas
> branchée — aucune casse, mais pas de gain CPU avant que les étapes ci-dessous
> soient faites.

## ÉTAPES RESTANTES

### Partie 1 — Ably (sur Vercel)
- Compte Ably (free) → app → API Keys → copier la **Root key**.
- Vercel → Env Vars : `ABLY_API_KEY` = root key (secret serveur, PAS `NEXT_PUBLIC_`).

### Partie 2 — Cloudflare KV + Worker (machine avec Node/wrangler)
Dans `worker/` :
```
npm i -g wrangler        # une fois
wrangler login           # une fois
./setup-kv.ps1           # ou: powershell -ExecutionPolicy Bypass -File .\setup-kv.ps1
```
Le script `setup-kv.ps1` :
1. crée le namespace KV `W2G_CACHE`,
2. injecte son `id` dans `wrangler.toml`,
3. demande + pose `TURSO_ADMIN_URL` et `TURSO_ADMIN_TOKEN` (mêmes valeurs que le .env Vercel),
4. déploie le Worker.
→ **Noter l'ID KV affiché à la fin** (sert en partie 3).

### Partie 3 — Variables `CF_*` sur Vercel (pour que Vercel écrive dans KV)
But : les routes Vercel `anilist-health` / `broadcast` poussent la valeur dans KV,
lue par le Worker. Nécessaire surtout pour les **broadcasts** (le Worker ne les
recalcule pas ; `/w/health` est auto-suffisant).

1. **Générer le token API Cloudflare** :
   - https://dash.cloudflare.com/profile/api-tokens → **Create Token** → **Create Custom Token**
   - **Nom du token : `aniscroll-vercel-kv-write`**
   - Permission : **Account → Workers KV Storage → Edit**
   - Account Resources : ton compte
   - Create → copier le token (affiché une seule fois) = `CF_KV_API_TOKEN`
2. **Poser sur Vercel → Env Vars** :
   - `CF_ACCOUNT_ID`       = account id Cloudflare (dashboard, ou URL)
   - `CF_KV_NAMESPACE_ID`  = l'ID KV de la partie 2
   - `CF_KV_API_TOKEN`     = le token généré ci-dessus

### Partie 4 — Redéployer Vercel
Redeploy après avoir posé `ABLY_API_KEY` + les 3 `CF_*` (les env vars ne
s'appliquent qu'au prochain build).

## Vérification post-déploiement (résumé)
- Watch 2gether : 2 onglets se synchronisent (Ably), guests inclus, reconnexion après veille.
- `ABLY_API_KEY` jamais exposé client (DevTools : seulement un TokenRequest).
- DevTools Network : `/w/health`, `/w/broadcast`, `/w/track` partent vers `*.workers.dev`.
- `curl -I` sur `/en/anime/...` → `CDN-Cache-Control: ... s-maxage=21600`.
- Onglet en arrière-plan → aucun poll health/broadcast/presence.
- Broadcast admin posté → s'affiche pour tous ; clear → disparaît.
- 72h après : Fluid Active CPU Vercel < 4h, fonction `stream` absente du top.

## Fichiers clés (déjà modifiés/créés)
- `pages/api/v2/watch2gether/ably-token.ts`, `lib/watch2gether/ably.ts`,
  `lib/watch2gether/useWatchParty.ts`, `lib/watch2gether/redisRoom.ts`
- `worker/src/edge-endpoints.js`, `worker/src/index.js`, `worker/wrangler.toml`,
  `worker/setup-kv.ps1`
- `lib/cloudflareKv.ts`, `pages/api/v2/anilist-health.ts`,
  `pages/api/v2/admin/broadcast/index.js`
- `pages/_app.tsx`, `components/shared/AnilistHealthBanner.tsx`
- `pages/en/anime/[...id].tsx`
- `package.json` (ajout `ably`)
- `DEPLOY_CPU_OFFLOAD.md` (détail des secrets), ce fichier.

## Note environnement
La machine d'origine n'a PAS Node/npm/wrangler (poste d'édition seul). Build,
typecheck et wrangler tournent ailleurs (CI Vercel / l'autre PC). Le code n'a donc
pas été buildé localement — vérif statique faite, build réel = Vercel.
