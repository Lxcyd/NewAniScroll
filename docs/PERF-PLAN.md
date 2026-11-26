# Plan vitesse — 25/11/2026

Ce document dit **où part le temps**, ce qui a été fait, et dans quel ordre traiter
le reste. Chaque chantier est mesuré avant et après ; rien ne part sans chiffre.

Outils (tous dans le dépôt ou le devlog) :
- `tools/browser-check/perf-measure.mjs` — LCP/CLS/TBT/octets, bureau + mobile 4G lente
  CPU ×4, à froid, médiane de 3. Sous Git Bash : `MSYS_NO_PATHCONV=1` et un chemin de
  sortie en `C:/…` (sinon `c:\c\…`).
- En-tête `Server-Timing` de la fiche anime (depuis cette passe) : les étapes du rendu
  serveur, lisibles dans DevTools > Réseau > Timing, sur n'importe quel rendu.
- `/_next/data/<build>/en/anime/<id>.json?id=<id>&_t=<x>` : un paramètre inutile force un
  vrai rendu chez Vercel (autre clé de cache Cloudflare).

## 1. Le constat (dev, 25/11)

### Premier chargement à froid (médiane de 3)

| Page | LCP mobile | TBT mobile | Octets mobile | Octets bureau |
|---|--:|--:|--:|--:|
| Accueil | 5,1 s | 0,35 s | 2,4 Mo | 8,5 Mo |
| Fiche Frieren | 10,0 s | 0,39 s | 2,6 Mo | 5,9 Mo |
| Fiche One Piece | 17,8 s | 0,82 s | 6,0 Mo | 9,5 Mo |
| Lecture | 8,5 s | 0,58 s | 2,2 Mo | 6,1 Mo |
| Recherche | 5,7 s | 0,20 s | 2,3 Mo | 9,0 Mo |
| Planning | 5,8 s | 0,23 s | 4,8 Mo | 7,5 Mo |
| Populaires | 4,9 s | 0,17 s | 1,8 Mo | 9,2 Mo |
| Découvrir | 21,1 s | 0,19 s | 3,9 Mo | 6,6 Mo |
| Profil | 12,0 s | 2,1 s | 2,6 Mo | 9,0 Mo |

Bureau, HTML en cache : LCP 0,3-0,5 s partout. **Le problème n'est pas le calcul, c'est
le poids et l'ordre** : sur une 4G lente tout se dispute 1,6 Mb/s et l'image principale
arrive en dernier.

### Navigation interne (ce que l'on ressent en cliquant)

Un clic attend les données de la page (`/_next/data`) **sans rien changer à l'écran**.

| Données | 1er clic (rendu Vercel) | 2e clic (cache Cloudflare) |
|---|--:|--:|
| Fiche Frieren | 0,9 s | 0,06 s |
| Fiche One Piece | 4,4 s | 0,07 s |
| Lecture | 1,5 s | 0,06 s |
| Planning | 1,4 s | 0,05 s |
| Profil | 2,7 s | 1,5 s (jamais en cache, 756 Ko) |

À chaud, la fonction rend One Piece en **0,58 s** : les 4,4 s sont un démarrage à froid
(fonction endormie, caches vides). Le cache Cloudflare est **vidé à chaque déploiement**
(purge-cf-cache.yml) et les URL `/_next/data` changent avec le build : après un
déploiement, tout le monde repart à froid. Le préchauffage au survol
(lib/navigation/warmAnimeData.ts) couvre le bureau ; sur tactile il ne part qu'au
toucher (~100 ms d'avance).

### Ce qui pèse, ressource par ressource (mobile)

| Ressource | Poids | Où |
|---|--:|---|
| `changelog/v0.0.9/apercu.mp4` | 2,7 Mo | Toute page, 1re visite (popup « Nouveautés ») |
| Couvertures de l'arbre de franchise | ~160 Ko pièce, des dizaines | Fiche (One Piece : 4 Mo d'images) |
| Préparation de la page de lecture depuis la fiche | ~280 Ko de JS + 256 Ko de vidéo | Fiche, 200 ms après l'affichage |
| Préchargement des pages liées (`next/link`) | ~400 Ko | Toutes les pages |
| Bannières du carrousel | 250-350 Ko chacune | Découvrir, accueil |
| Polices | 150-190 Ko | Toutes |
| Profil : `entries` dans le HTML | 694 Ko brut / 128 Ko gz | Profil, chaque visite |

## 2. Fait dans cette passe (risque faible)

1. **Arbre de franchise monté à l'approche** (RelationsGraph, `approche`) : rien n'est
   demandé — ni l'arbre, ni une couverture — tant que la section est à plus de 600 px de
   l'écran. La boîte garde sa place (380 px), un squelette s'affiche, pas de saut.
2. **Préparation de la page de lecture après `load`** (fiche, au plus 5 s) au lieu de
   200 ms : l'image principale passe d'abord. Navigation interne et bouton « Regarder »
   (au doigt, au survol) inchangés.
3. **Vidéo de la popup « Nouveautés » après `load` + repos** : la popup s'ouvre comme
   avant, sa vidéo démarre un instant après au lieu de voler la bande passante.
4. **Entrées du profil compactées** (lib/profile/packEntries.ts) : dictionnaire des
   tags/genres/studios, préfixe des couvertures. 694 → 419 Ko brut, 128 → 103 Ko gz.
   Aller-retour vérifié identique sur 693 entrées réelles.
5. **`Server-Timing` sur la fiche** : chaque rendu dit où il a passé son temps.
6. **Écran tactile : plus de préchargement « parce que visible »** (`_app`) : next/link
   préchargeait PUIS EXÉCUTAIT au repos le code de toute page dont un lien entrait dans
   l'écran (~260 Ko). Il précharge maintenant au toucher ; nos appels explicites passent
   `priority: true`. Bureau inchangé.
7. **Page de lecture : le lecteur (~300 Ko, hls.js compris) ne se précharge que si elle est
   affichée** — son module était exécuté en avance depuis la fiche, et le tirait.
8. **Fiche mobile : la couverture n'est plus préchargée au rang de la bannière** (image
   principale).
9. **Découvrir : la carte visible charge ses images avant ses voisines** (12 images,
   2,6 Mo au même rang ; l'image principale arrivait la dernière).

10. **Squelettes de navigation sur toutes les pages** (RouteSkeleton, 25/11) : après 120 ms
    sans réponse, la forme de la page d'arrivée s'affiche ; la fiche en aperçu rempli
    (bannière, couverture, titre, genres déjà connus). Ne change aucun octet ni aucun temps
    serveur : change ce qu'on VOIT pendant l'attente. Clic préchauffé : rien ne s'affiche.

### Résultat (dev, médiane de 3, à froid)

| Mobile 4G lente | LCP avant | LCP après |
|---|--:|--:|
| Découvrir | 21,1 s | **9,3 s** |
| Fiche Frieren | 10,0 s | **8,2 s** (relevé détaillé : 9,0 → 5,9 s ; octets avant l'image principale 2,2 → 1,0 Mo) |
| Fiche One Piece | 17,8 s | **15,4 s** |
| Profil | 12,0 s | 11,6 s |
| Accueil, Recherche, Planning, Populaires, Lecture | — | inchangés |

Bureau : inchangé, au bruit près (0,4-0,5 s ; profil 1,3 s).

Outil ajouté pour la suite : un relevé « tout ce qui part avant l'image principale »
(ordre, poids, priorité, initiateur) — c'est lui qui a trouvé les vrais goulots, là où
les moyennes ne disaient rien. Versé : `tools/browser-check/avant-lcp.mjs`.

## 3. La suite, par gain attendu

### P1 — Rendu serveur à froid (navigation : 1 à 4,4 s)
- Lire `Server-Timing` sur une série de rendus forcés (fiches populaires et rares) pour
  savoir QUELLE étape coûte : marcheurs de saisons (`resolveSeasonChain/List`, plusieurs
  appels AniList), films bonus, MAL, fanarts, TMDB.
- Hypothèse à vérifier : les marcheurs de saisons dominent un MISS. Si oui, leur résultat
  par franchise mérite sa propre clé (Turso, pas Redis : cap Upstash) ou un budget de temps
  avec repli côté client.
- **Réchauffer après déploiement** les `/_next/data` des ~50 fiches les plus vues
  (purge-cf-cache.yml réchauffe déjà le HTML). Coût : ~50 invocations par déploiement.
  À peser contre le quota Fluid (CLAUDE.md, règle 1).

### P2 — Mobile : moins d'octets avant l'image principale
- ~~Préchargement `next/link` sur tactile~~ (fait, point 6) ; ~~Découvrir~~ (fait, point 9).
- **One Piece (15 s)** : relevé « avant l'image principale » à faire, même méthode — la
  bande de couvertures `medium` (saisons, PNG jusqu'à 160 Ko) est le suspect.
- **Polices (~280 Ko, 16 fichiers, priorité très haute)** : Karla ×5, Outfit ×2, Roboto ×3,
  Inter ×4… C'est le plus gros poste restant avant l'image principale, mais c'est du DESIGN :
  réduire les familles/graisses demande l'accord de Luc.
- **Accueil (5,7 s)** : relevé à faire.
- **Couvertures** : vérifier les tailles demandées à AniList (`large` vs `medium`) carte par
  carte ; `decoding="async"` partout.
- Polices : n'embarquer que les graisses réellement utilisées au premier écran.

### P3 — Profil (TBT mobile 2 s, données jamais en cache)
- **Serveur, fait le 26/11** (devlog/infra.md) : ligne « profil prêt » (`profile_digest`), fil AniList en
  parallèle, `Server-Timing`. Reste : Prisma `getUser` (2 s à froid en local) si dev le confirme.
- **À suivre, dans l'ordre** : (a) `allTags`/`studios`/`airStatus`/`source`/`country` hors de la page, chargés
  par l'onglet Liste (seul le filtre les lit) ; (b) profil jamais vu : coquille tout de suite + squelette ;
  (c) une frontière `<Suspense>` par widget (hydratation découpée, HTML identique) ; (d) code des widgets par
  type de bloc, éditeur/musique seulement chez qui s'en sert ; (e) `studioAnimes` et l'évaluation des badges
  au repos ; (f) relevé avant-lcp.mjs du profil mobile.
- La lecture des données ne coûte que ~2 ms : **c'est le rendu** qui bloque. Profiler
  l'hydratation (React Profiler / trace Performance) : sections hors écran à monter à
  l'approche, comme l'arbre ; onglets non ouverts en `dynamic`.
- Le chunk propre au profil fait 402 Ko brut (123 Ko gz) : analyse du build (source maps
  dans un worktree jetable, jamais dans le dépôt pendant que :3123 tourne).

### P4 — Page de lecture (LCP mobile 8,5 s)
- Même méthode : ce qui part avant la première image du lecteur.

## 4. Règles de la passe
- **Rien sans mesure avant/après** sur dev (perf-measure.mjs, mêmes pages).
- **Rien qui change ce qu'on voit** sans accord : on change l'ORDRE et le MOMENT des
  chargements, pas le contenu.
- Quotas : pas de boucle contre le site (règle 2), pas de nouvelle clé Redis, Turso mesuré
  avec `queryCost` avant toute requête nouvelle.
- Ce qui a été écarté le 20/11 l'est toujours (WebP/AVIF : optimiseur Vercel coupé, wsrv
  bloque AniList ; nouvelles clés Redis ; OTel complet).
