# Remonter la production sur un nouveau compte Vercel

Procédure écrite le 12/09/2026, pendant la migration elle-même.

> **Le domaine n'est pas en jeu.** `aniscroll.com` et `anisdcroll.com` sont
> enregistrés chez un tiers (`Registrar: Third Party`), pas chez Vercel.
> Supprimer l'ancien compte ne peut pas les faire perdre.

---

## 0. Ce qui n'est récupérable QUE tant que l'ancien compte existe — fait

```bash
npx vercel env pull <fichier> --environment=production   # + preview, development
```

Sauvegardes dans `C:\Users\Luc\aniscroll-vercel-backup\`.

**Sur 32 variables, 7 seulement sont ressorties en clair.** Les 25 autres sont
de type *Secret* : Vercel les refuse en lecture, y compris au propriétaire —
`! 25 Secret values cannot be pulled`. C'est la contrainte structurante de toute
cette migration, et elle n'est pas contournable.

| Provenance | Nombre |
| --- | --: |
| Relues depuis Vercel | 7 |
| Reprises de `.env.local` | 12 |
| Retrouvées dans le code (constantes, pas des secrets) | 3 |
| **À récupérer à leur source** | **10** |

Les trois constantes retrouvées dans le code — `NEXT_PUBLIC_PROXY_BASE`,
`MAIL_FROM`, `FANART_PROXY_HOST` — figuraient comme valeur par défaut dans
`lib/extractors.js`, `lib/auth/mail.ts` et `scripts/cache/warm-images.mjs`.

---

## 1. Créer le projet sur le nouveau compte

1. `vercel.com/new` → **GitHub** → autoriser → importer `NewAniScroll`.
2. **Ne remplir aucune variable dans le formulaire.** 32 saisies à la main,
   c'est 32 occasions de coller une valeur dans le mauvais champ ; l'étape 3 le
   fait en une commande.
3. Framework : Next.js (détecté). La région `cdg1` est déjà dans `vercel.json`,
   ne pas la ressaisir.
4. Lancer le déploiement. **Il va échouer ou produire un site cassé, c'est
   normal** — il n'a aucune variable.

---

## 2. Lier le dossier local au NOUVEAU projet

L'étape la plus facile à rater, et celle qui écrit dans le mauvais compte.

```bash
npx vercel logout          # sinon la CLI reste sur l'ancien compte
npx vercel login           # avec le compte du nouveau projet
rm -rf .vercel             # le lien vers l'ancien projet
npx vercel link            # choisir le nouveau projet
cat .vercel/project.json   # VÉRIFIER le projectId avant d'écrire quoi que ce soit
```

---

## 3. Pousser les variables

Le fichier de référence est **`.env` à la racine** — les 32 variables du projet,
par ordre alphabétique, les manquantes écrites `NOM=` vide avec, juste au-dessus,
où aller la chercher. Une ligne vide se **voit** ; une absence, non.

```bash
# simulation : n'écrit rien, liste ce qui partirait
node tools/vercel-migration/import-env.mjs .env --env=production

# pour de vrai
node tools/vercel-migration/import-env.mjs .env --env=production --apply
```

Les lignes vides sont **sautées**, jamais poussées comme chaîne vide — ce n'est
pas la même chose qu'une variable absente, et le code teste partout
`if (!process.env.X)`.

Pour régénérer `.env` depuis les sauvegardes :

```bash
node tools/vercel-migration/build-env.mjs
```

> `.env` est couvert par `.gitignore` (ligne 18). **Ne jamais le renommer en
> `.env.production`** : ce nom-là n'est pas ignoré, et le fichier contient de
> vrais jetons.

L'outil n'affiche jamais une valeur — seulement le nom, la longueur, le verdict.
Il est rejouable (`--force`), donc un échec partiel se rattrape en relançant.

### ⚠️ `REDIS_URL` a été neutralisé volontairement

La valeur de `.env.local` pointait sur `stable-tahr-110008.upstash.io`, une base
**supprimée**. Un cache mort ne dégrade pas le service : il l'**amplifie** —
chaque miss repart à l'origine, et c'est exactement la boucle qui a fait
exploser le Fluid CPU. Le fichier la marque `# MANQUANT` pour que l'outil refuse
de la pousser. À remplacer par la base vivante, ou à laisser absente au profit de
`UPSTASH_REDIS_REST_URL` / `_TOKEN`.

### Les 10 (11 avec Redis) à aller chercher

| Variable | Où | Conséquence si absente |
| --- | --- | --- |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | console Upstash → base → *REST API* | **Aucun cache.** À ne pas laisser vide. |
| `REDIS_URL` | idem | idem |
| `TURSO_USERS_URL` / `_TOKEN` | console Turso | Les comptes AniScroll sont inactifs ; le site marche en local seul |
| `CF_ACCOUNT_ID`, `CF_KV_NAMESPACE_ID`, `CF_KV_API_TOKEN` | Cloudflare → Workers KV (jeton : *Workers KV Storage: Edit*) | Le cache KV du watch-party est muet |
| `ABLY_API_KEY` | console Ably | Le watch-party perd son transport temps réel |
| `RESEND_API_KEY` | console Resend (régénérable) | Les liens d'inscription partent dans les logs au lieu des mails |
| `SIMKL_CLIENT_ID` | console Simkl | Source d'épisodes dégradée |

Aucune n'est perdue : toutes sont relisibles ou régénérables à leur source.

---

## 4. Le domaine

**Un domaine ne peut être attaché qu'à un seul compte Vercel à la fois.** Il faut
donc le retirer de l'ancien avant de l'ajouter au nouveau.

```bash
# sur l'ANCIEN compte
npx vercel domains rm aniscroll.com

# sur le NOUVEAU
npx vercel domains add aniscroll.com
npx vercel domains add www.aniscroll.com
npx vercel alias set <deployment-url> aniscroll.com
```

Puis mettre à jour les DNS chez le registrar selon ce que Vercel affiche
(généralement `A 76.76.21.21` pour l'apex et un `CNAME` pour `www`).

> **La coupure de service est sans objet ici** : le site répond déjà 402 à tous
> ses visiteurs depuis la mise en pause. C'est le seul avantage de la situation.

Ne pas oublier `anisdcroll.com` (le domaine de faute de frappe) si tu veux
garder la redirection.

---

## 5. Ce qui n'a PAS besoin de bouger

Vérifié, pour éviter de chercher des problèmes qui n'existent pas :

- **AniList OAuth** — `CLIENT_ID` / `CLIENT_SECRET` et l'URL de redirection sont
  liés au **domaine**, pas au compte Vercel. Le domaine ne change pas → rien à
  faire. Idem `NEXTAUTH_URL` (`https://aniscroll.com`).
- **Turso, Upstash, Cloudflare Worker, Ably, Resend** — comptes indépendants.
- **GitHub Actions** — ses secrets vivent chez GitHub. Les crons continuent.
- **Le proxy `proxy.aniscroll.com`** — Worker Cloudflare, hors sujet.

---

## 6. Après la bascule, dans cet ordre

1. **Régler la politique de rétention TOUT DE SUITE** — *Settings → Deployment
   Retention* : Canceled 1 j, Errored 7 j, Pre-Production 7 j, Production 30 j.
   C'est l'absence de cette politique qui a rempli les 10 Go. La régler sur un
   compte neuf coûte deux minutes ; la régler trop tard coûte une journée.
2. **Fusionner la PR #16** avant d'envoyer du trafic. Elle contient les caches
   négatifs qui rendent la panne AniList bon marché. Sans elle, le compte neuf
   rebrûlera ses 4 h de CPU de la même façon.
3. Vérifier `/admin/quotas` — la page existe pour ça.
4. Ne supprimer l'ancien compte qu'**après** avoir constaté que tout fonctionne.
   Une fois supprimé, les 7 variables en clair disparaissent avec lui.
