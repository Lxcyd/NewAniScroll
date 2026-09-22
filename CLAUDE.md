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

**1. UN PUSH = UN DEPLOIEMENT. Grouper quand c'est naturel.**
Il n'y a plus de budget de pushs (retire le 13/09/2026 a la demande de
l'utilisateur) : pousser sur dev des que l'utilisateur a besoin de voir le
resultat. Un aller-retour sur une constante reste mieux servi par plusieurs
commits et un push.

Ce qui borne le stockage a la place d'un compteur :
- dev vit sur **son propre compte Vercel** (`aniscroll-dev`, cf.
  [tools/vercel/](tools/vercel/)) : ses deploiements ne touchent pas le quota
  de la prod ;
- retention du projet dev a **1 jour** pour tous les types (reglee le 13/09 via
  `vc.mjs dev api /v9/projects/<id>/deployment-expiration`), plus les 10
  derniers gardes d'office — soit ~1 Go + les pushs du jour ;
- [should-build.sh](tools/quota-guard/should-build.sh) annule les previews et
  les commits sans effet sur le site.

Verifier `node tools/vercel/vc.mjs dev ls` si les pushs s'enchainent.

**2. JAMAIS de boucle de sondage contre le site.**
Chaque iteration d'un `for`/`while` qui curl `aniscroll.com` ou
`dev.aniscroll.com` est une invocation de fonction facturee, et le compteur
Fluid Active CPU ne se reinitialise que le 1er du mois (le hook `PreToolUse`
de [guard.mjs](tools/quota-guard/guard.mjs) refuse ces boucles). Un curl unique pour lire un en-tete reste parfaitement legitime ; quarante ne
le sont pas. Pour attendre un deploiement : demander, ou revenir plus tard dans
la conversation.

**3. Les allocations Hobby sont par COMPTE, pas par projet.**
4 h de CPU, 1 M d'invocations, 1 M d'edge requests : tous projets d'un compte
confondus. Depuis le 12/09/2026 la prod (`aniscroll`) et la dev
(`aniscroll-dev`) sont sur **deux comptes distincts**, donc deux pots ; mais
`dev.aniscroll.com` a toujours 4 h de CPU a lui seul, et un nouveau
deploiement repart avec un cache d'edge vide.

### Ce qui reste a la main de l'utilisateur

- **Deployment Retention** : prod = Canceled 1 j, Errored 7 j, Pre-Production
  7 j, Production 30 j ; dev = 1 j partout. Sans elle, tout ce qui a ete
  supprime se reconstitue.
- L'upgrade Pro, seule action qui relance un compte deja en pause : le Fluid
  CPU deja consomme ne redescend qu'au 1er du mois.

## Le reste

- **Prod = `main`**, dev = `dev`. Mesurer l'ecart sur le REMOTE
  (`origin/main..origin/dev`) : le `main` local ment.
- **Tout test navigateur se fait sur dev.aniscroll.com**, jamais sur localhost
  (pas de Redis, pas de CDN, compilations froides) — ca coute un deploiement,
  voir la regle 1.
- Le devlog est decoupe par sous-systeme sous `devlog/`. Lire seulement
  l'index `DEVLOG.md` en debut de session.
