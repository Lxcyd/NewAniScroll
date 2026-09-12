# AniScroll — regles de travail

## ⛔ LE QUOTA VERCEL EST LA CONTRAINTE DURE DE CE PROJET

Le 11/09/2026 le compte Vercel est passe **en pause** et `aniscroll.com` a
repondu **402 Payment Required** a tous ses visiteurs. Ce n'etait pas un bug de
code : c'etait l'accumulation de deploiements.

| Compteur | Etat ce jour-la | Plafond Hobby |
| --- | --: | --: |
| Functions Storage | 35,85 Go | 10 Go |
| Deployment Storage | 15,23 Go | 10 Go |
| Fluid Active CPU | 12 h 05 | 4 h / mois |

Il a fallu supprimer **plus de 380 deploiements** a la main. Deux causes :
aucune politique de retention n'avait jamais ete reglee (correctif dans le
dashboard), et **12 commits pousses en deux jours dont 10 dans la meme
journee**, sur une serie d'allers-retours d'affinage.

### Les trois regles qui en decoulent

**1. UN PUSH = UN DEPLOIEMENT. Grouper.**
Commiter autant que necessaire ; ne pousser qu'une fois la serie terminee, ou
quand l'utilisateur a besoin de voir le resultat sur dev. Un aller-retour sur
une constante (« plus », « moins », « encore plus ») ne merite pas trois
deploiements : il merite trois commits et un push.

Un budget de **3 pushs/jour sur `dev`** est applique mecaniquement par
[tools/quota-guard/guard.mjs](tools/quota-guard/guard.mjs), a deux niveaux :
un hook `pre-push` (versionne dans `.githooks/`) et un hook `PreToolUse` de
Claude Code. `node tools/quota-guard/guard.mjs status` dit ou on en est.

Au-dela du budget, **demander a l'utilisateur** — c'est lui qui accorde
`ANISCROLL_PUSH_OVERRIDE=1`. Ne jamais contourner la garde de sa propre
initiative.

**2. JAMAIS de boucle de sondage contre le site.**
Chaque iteration d'un `for`/`while` qui curl `aniscroll.com` ou
`dev.aniscroll.com` est une invocation de fonction facturee, et le compteur
Fluid Active CPU est **partage entre la prod et dev** ([[fluid-quota-tous-environnements]]).
Un curl unique pour lire un en-tete reste parfaitement legitime ; quarante ne
le sont pas. Pour attendre un deploiement : demander, ou revenir plus tard dans
la conversation.

**3. Le dev et la prod puisent dans le MEME pot.**
`dev.aniscroll.com` n'est pas gratuit. Chaque preview a sa propre cle de cache
d'edge, donc chaque vue y est un MISS par construction — c'est l'environnement
le plus cher du projet, pas le moins cher.

### Ce qui reste a la main de l'utilisateur

- **Deployment Retention** (dashboard, *Project → Settings*) : sans elle, tout
  ce qui a ete supprime se reconstitue. Valeurs retenues : Canceled 1 j,
  Errored 7 j, Pre-Production 7 j, Production 30 j.
- L'upgrade Pro, seule action qui relance un compte deja en pause : le Fluid
  CPU deja consomme ne redescend qu'au 1er du mois.

## Le reste

- **Prod = `main`**, dev = `dev`. Mesurer l'ecart sur le REMOTE
  (`origin/main..origin/dev`) : le `main` local ment.
- **Tout test navigateur se fait sur dev.aniscroll.com**, jamais sur localhost
  (pas de Redis, pas de CDN, compilations froides) — mais voir la regle 1 : ca
  coute un deploiement, donc on groupe.
- Le devlog est decoupe par sous-systeme sous `devlog/`. Lire seulement
  l'index `DEVLOG.md` en debut de session.
