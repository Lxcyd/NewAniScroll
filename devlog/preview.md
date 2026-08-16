# DEVLOG — Apercu au survol & bandes-annonces

La carte de survol, son lecteur de bande-annonce, la lumiere d'ambiance,
et la longue bataille contre le blocage de YouTube (PO token, cobalt,
embed nu, geo-blocage).

Le plus recent en premier. L'index general est dans `../DEVLOG.md`.

## 2026-08-16 — Le trailer de la carte, parfois noir, et qui marchait « au bout de plusieurs essais »

**Le symptôme** : sur certaines cartes le haut restait un rectangle noir — pas
l'artwork, du noir — et re-survoler la même carte deux ou trois fois finissait
par faire apparaître la bande-annonce.

**Ce que ce noir est** : le fond de course de `TrailerStage`. `REVEAL_ANYWAY_MS`
était un `setTimeout(reveal, 4000)` sec, écrit pour un seul scénario — le
message qui n'arrive pas alors que l'image, elle, est bien là. Il ne demandait
jamais s'il y avait quelque chose à révéler. Quand le chargement de la vidéo se
perd, il lève quand même la bannière au bout de 4 s, et découvre un lecteur qui
n'affiche rien. D'où le noir, et d'où le fait que seul un nouveau survol (un
nouveau `loadVideoById`) le corrige.

**Pourquoi le chargement se perd** : le lecteur ignore ce qu'on lui envoie tant
qu'il n'a pas fini de charger la vidéo précédente — la même règle qui faisait
courir la lueur avec une demi-seconde d'avance. Un pointeur qui balaie un
carrousel lui donne un id toutes les quelques centaines de ms : celui qui tombe
au mauvais moment est jeté, et `loadedIdRef` croit pourtant l'avoir chargé.

**Le second chemin, plus vicieux** : la poignée de main `listening` s'arrête 4 s
après le boot. Si l'iframe n'a pas fini de charger d'ici là (cache froid, boot
au ralenti), le lecteur n'est jamais abonné et **ne parle plus de la session** —
les commandes passent, la vidéo joue, mais aucun `currentTime` n'arrive, donc la
révélation n'a plus sa preuve et *toutes* les cartes tombent dans le fond de
course.

**La correction**, deux endroits :

- le fond de course demande d'abord si une position a été rapportée pour cette
  carte. Oui → il révèle, comme avant. Non → il ne révèle rien, redemande la
  vidéo une fois, et s'il est toujours muet 4 s plus tard rend la main à
  l'artwork (`onHide`) au lieu du noir ;
- `listening` est réémis 2 s à chaque ouverture de carte, en plus du boot. Un
  lecteur déjà abonné répond en renvoyant ce qu'il aurait envoyé de toute façon.

**Non vérifié en conditions réelles** : le défaut est intermittent et se mesure
sur dev, pas en local (voir [[no-local-player-testing]]). Ce qui est établi ici
c'est le mécanisme du noir — un `reveal` inconditionnel — pas la fréquence de
chacune des deux causes.


## 2026-08-15 — Nettoyage de l'aperçu au survol

Rien de fonctionnel : uniquement du code et des fichiers sans appelant.

**Code mort retiré** (`TrailerAmbient` / `PreviewCard` / provider / `trailerBars`)
- La boucle `requestAnimationFrame` qui échantillonnait un `<video>` : plus personne
  ne passe `sourceRef` depuis le retour à l'embed YouTube. ~90 lignes, avec son
  canvas `prev` et `SAMPLE_INTERVAL_MS`.
- `zoom` : paramètre dont l'unique appelant passait toujours `1`.
- `poster` : traversait le provider et la carte sans jamais être peint (la carte
  documente même pourquoi elle ne l'utilise pas) — supprimé avec la requête DOM
  faite à chaque survol pour le lire.
- `ambientFrames` : renvoyait `storyboardFrames(id)` inchangé.

**Bancs d'essai supprimés de `public/`** — `embed-mask-lab.html` et
`embed-scale-lab.html`. Raison concrète, pas cosmétique : **next-pwa précache tout
ce qui est sous `public/`** (sauf `emojis/`, déjà exclu), donc ces 24 Ko étaient
téléchargés par chaque visiteur. Leurs conclusions sont dans les commentaires du
code et ici ; les fichiers restent dans l'historique git.

**Vérifié après coup sur dev, les deux chemins** :
`défaut` → 2 iframes, calque glow présent, ambient canvas à opacity 0 ;
`Data Saver` → 1 iframe, pas de calque glow, ambient canvas à opacity 1 et peint.
Aucune erreur console dans les deux cas.

**Non supprimé, à décider** : `public/trailer-lab.html` (31 Ko) n'est **pas suivi
par git**, donc il n'est ni déployé ni précaché — il n'existe que dans la copie de
travail locale. Aucun effet en production ; le supprimer serait en revanche
irréversible (aucune trace dans l'historique). À trancher par Luc.

**Composants orphelins supprimés** — vérifiés deux fois (aucun import par chemin,
aucune référence à leur symbole exporté dans le code suivi ; seul le DEVLOG les
citait en prose) :
`components/anime/viewMode/{listMode,thumbnailDetail,thumbnailOnly}.js`,
`components/anime/viewSelector.js`, `components/shared/{AnimeCard,GenrePills,
RankingBadge,StatusPill}.tsx`. `AnimeCard.tsx` datait du 08/08, remplacé pendant
le travail sur l'aperçu au survol sans être retiré.

Gardés malgré une première alerte du scan : `lib/hlsMerge.js` (importé par symbole,
`mergeHlsPlaylists`, depuis `lib/clientVidmoly.js`) et `lib/nsfw/*.mjs` (utilisés par
`scripts/fanarts/classify-fanarts.mjs` et le workflow `refresh-fanarts.yml`). Un scan
par nom de fichier seul les aurait supprimés à tort — d'où la double vérification.

Rappel au passage : `public/sw.js`, `public/workbox-*.js` et `public/fallback-*.js`
sont **générés par next-pwa** à chaque build et déjà ignorés par git — ce ne sont
pas des résidus du dépôt, les effacer les fait juste revenir au build suivant.

### Suite — SNK ne démarrait pas : une tabulation dans l'id AniList

Symptôme : sur *Attack on Titan*, la carte dévoile un rectangle **noir** et le trailer
ne part jamais, alors que la même vidéo (`LHtdKWJdif4`) se lit sur youtube.com.

Sonde sur la carte : le lecteur reçoit l'id **`"LHtdKWJdif4\t"`** — AniList stocke une
tabulation à la fin. `loadVideoById` charge donc un id inexistant, le lecteur reste en
état **−1** (jamais démarré), et c'est le garde-fou `REVEAL_ANYWAY_MS` (4 s) qui
dévoile le cadre : d'où le noir. La même tabulation empoisonnait aussi
`i.ytimg.com/vi/<id>/mq1.jpg`, donc le glow de repli **et** la sonde de bandes noires.
Un caractère dans la base de quelqu'un d'autre, quatre choses cassées.

Correctif : `lib/preview/trailerId.ts` — `youtubeTrailerId()` **nettoie puis valide**
(11 caractères `[A-Za-z0-9_-]`). Trimmer seul aurait suffi pour ce cas ; valider la
forme attrape le suivant sans avoir à le connaître, et répond « pas de trailer » plutôt
que de garer un lecteur sur une vidéo qui ne chargera jamais.

Appliqué aux trois entrées : `pages/api/v2/preview/[id].ts` (toute la chaîne de la
carte), `Overview.tsx` (lien sortant + sonde `useTrailerBlocked`) et
`InfoPageMobile.tsx` (embed + vignette `hqdefault`).

### Suite — la teinte du halo (vrai défaut) et la synchro (sous le plancher)

**Teinte — corrigé.** Signalé sur la vraie carte : un carton BLEACH orange éclairait
en **jaune**, un plan bleu ressortait bien trop clair. Cause : le `brightness(1.7)`
que j'avais ajouté pour densifier. Mon argument (« un empilement de cinq couches
≈ 2,15 d'opacité, donc une multiplication est l'équivalent fidèle ») est faux deux
fois :
- empiler des copies **translucides** d'une image *converge* vers cette image
  (composer une image sur elle-même la rend inchangée) — la pile n'a jamais
  dépassé les couleurs de la vidéo ;
- une multiplication **écrête** : orange (255,140,0) ×1,7 = (255,238,0) = jaune.

Le filtre est désormais celui du lecteur à l'identique — `blur() saturate(1.8)`,
rien qui puisse déplacer une teinte. Mesuré après coup sur SNK : écart de teinte
médian image↔halo **14,6°** (le p90 reste élevé, artefact des plans sombres où la
teinte n'a pas de sens et où le fond de page domine la bande mesurée).

**Synchro — sous la résolution de la mesure.** Testé sur SNK comme suggéré (fondu
couleur→noir, signal franc). Le pic de corrélation reste à **un échantillon** de
zéro, mais **le signe change d'une passe à l'autre** : +51 ms (avant l'avance de
25 ms), −40 ms (après), −40 ms encore avec la géométrie d'échantillonnage corrigée.
Un écart de 25 ms ne peut pas produire un basculement de 90 ms : ces pics sont du
bruit à cette échelle. Conclusion honnête : **|décalage| ≤ ~40 ms**, non réglable
par cette méthode. `GLOW_LEAD_S` reste à 25 ms (une lumière très légèrement en
avance se lit comme la coupe ; en retard, comme un défaut).

**Biais de sonde corrigé au passage** : je comparais un recadrage **central** de
l'image à un halo qui, lui, montre le cadre **entier** flouté — toute coupe
commençant par les bords donnait au halo une avance apparente. Les deux séries
intègrent désormais la même surface.

---

## 2026-08-15 — Le fondu bas de la carte, et le rail du hero rendu survolable

### Le dégradé arrivait en deux marches

Constat de Luc : le fondu entre le trailer et le corps de la carte se fait « en
deux étapes ». Mesuré sur dev avant correction, sur les stops réellement servis :

| segment | pente d'alpha | cassure vs. segment précédent |
|---|---|---|
| 80 % → 95 % | 0,0593 /% | (départ depuis 0) |
| 95 % → 100 % | 0,0220 /% | **−0,0373** |

Deux ruptures, donc deux marches : l'entrée brutale à 80 % et le changement de
pente d'un facteur 2,7 à 95 %.

**Ce que j'ai compris en le mesurant** : un `linear-gradient` interpole en
DROITE entre deux stops consécutifs. Chaque stop est donc un angle dans la
courbe d'alpha, et l'œil lit un angle comme un bord. Moins de stops ne veut pas
dire plus doux — c'est même l'inverse : trois stops, c'est deux segments, donc
au mieux une cassure bien visible.

Remplacés par neuf stops qui échantillonnent un smoothstep (3t²−2t³) de 58 % à
100 % : pente nulle aux deux extrémités (ni bord de départ ni bord d'arrivée) et
plus aucun couple de segments assez dissemblable pour se voir. Cassure maximale
mesurée après déploiement : **0,0120 /%**, contre 0,0373 avant.

À ne pas « simplifier » plus tard : la liste est longue parce qu'elle
échantillonne une courbe. La raccourcir remet les marches. Et *doux* n'est pas
*plat* — le fondu tenté en 2025 qui n'arrivait jamais au plein avait été jugé
pire que le problème ; celui-ci atteint le plein, juste sans angle.

### Les affiches du rail du hero sont survolables

Ce qui l'empêchait n'était pas le markup mais la **rotation** : un auto-next
pendant un preview réordonne le rail SOUS le pointeur, donc l'affiche inspectée
est remplacée par un autre titre en pleine ouverture, et l'ancre du preview
disparaît du DOM. `previewAnchor(e.id)` sur chaque couverture + un maintien de
la rotation tant que le pointeur travaille le rail.

**Le piège, et il aurait suffi à rendre le correctif inopérant** : `onPointerLeave`
sur le rail ne marche pas. La carte de preview est portalisée dans `<body>` et
s'ouvre **centrée sur l'affiche**, donc elle recouvre l'élément même que le
pointeur survole : le rail voit un `leave` à l'instant précis où le preview
qu'il a causé apparaît, et la rotation repartirait exactement quand il ne faut
pas. Le maintien s'arrête donc sur un pointeur qui n'est **ni** sur le rail
(`[data-hero-rail]`) **ni** sur un popup (`[data-preview-popup]`) — les deux
forment une seule région, quoi qu'en dise le DOM.

La pilule de progression est l'autre moitié visible du compte à rebours : mise
en pause avec lui (`animationPlayState`), et **remontée à la relance** — son
remplissage est une animation CSS qui reprend là où elle s'était arrêtée, alors
que le timer, lui, est un `setTimeout` neuf ; sans le remount elle afficherait
un remplissage aux trois quarts avec huit secondes encore à courir.

Ce n'est **pas** une pause au survol du hero, toujours refusée pour la même
raison : le hero fait la taille du viewport, le curseur s'y pose par défaut, et
la rotation serait gelée en permanence. Le rail est une cible de 126 px qu'il
faut viser.

Vérifié sur dev : preview ouvert sur une couverture du rail, ordre du rail
**inchangé sur 16 s** (soit deux avances manquées, intervalle = 8 s), puis
rotation reprise après le départ du pointeur.

**Correctif du lendemain** : ce maintien remettait le compte à rebours à zéro.
Un `setTimeout` ne se met pas en pause, et relancer l'effet avec l'intervalle
complet à la sortie du survol revient à redémarrer la diapo — six secondes
d'attente jetées parce que le pointeur est passé sur une affiche. L'échéance est
désormais suivie en temps réel (`remainingRef`/`deadlineRef`) : entrer dans le
maintien fige ce qu'il en reste, en sortir arme un timer d'exactement cette
durée ; `timedIdxRef` distingue « nouvelle diapo » (intervalle entier) de
« maintien relâché » (le reliquat). La pilule n'est plus remontée :
`animation-play-state: paused` fige son remplissage sans jamais le rembobiner,
ce que le timer imite maintenant.

Mesuré sur dev : survol à t+5,2 s (pilule figée à scaleX 0,639, `paused`), 6 s
de maintien sans avance, puis avance **2,8 s après le relâchement** — soit
8 − 5,2. Une remise à zéro aurait donné 8 s.

**Piège de sonde, encore un** : mon premier point zéro était un clic sur la
pastille ACTIVE, censé relancer l'intervalle. Il ne relance rien — `go(i)`
appelle `setIdx` avec la même valeur, `idx` ne change pas, l'effet ne re-tourne
pas. La mesure partait donc d'un instant quelconque de la diapo en cours et
accusait le code à tort. Le point zéro est maintenant une avance réelle,
attendue en scrutant l'ordre du rail.

## 2026-08-14 — La page info sait enfin qu'un trailer est géo-bloqué

La carte apprenait le blocage gratuitement (elle monte un lecteur, il proteste).
La page info, elle, affiche une **vignette + lien** : aucun lecteur, donc aucun
moyen de savoir — et Bleach y gardait sa bande-annonce, qui menait à une page
d'erreur.

**Ce qui rend la sonde acceptable, et qui décide de sa forme** : le lecteur
signale le refus **sans qu'on lui demande de jouer**. Mesuré depuis la France,
sans aucun `playVideo` :

| vidéo | messages |
|---|---|
| Bleach `0c4IoCA5fY0` | `etat -1` puis **`onError 150`** |
| témoin jouable | `etat 5`, et plus rien |

Donc `lib/preview/useTrailerBlocked.ts` charge un embed caché et écoute. Pas de
lecture, donc **aucun octet de vidéo** : le coût est le boot du lecteur et une
requête de config, et le script de boot est partagé avec tous les autres embeds
que le navigateur a déjà vus. Au repos (`requestIdleCallback`), et **seulement si
la réponse est inconnue** — la mémoire de session est partagée avec la carte,
donc une vidéo déjà jugée d'un côté n'est jamais redemandée de l'autre.

**Le silence vaut réponse** : une vidéo jouable n'émet jamais d'erreur, donc au
bout de 9 s l'absence de refus est enregistrée comme « ça marche ». Sans ça le
bloc resterait caché pour tous les trailers qui vont bien.

**Ce que ce n'est délibérément pas** : un contrôle côté serveur. L'ancien
demandait à notre Worker, qui répondait sur la région d'un datacentre — la
mauvaise question, au prix d'un aller-retour bloquant. L'API YouTube Data
répondrait juste mais demande une clé, un quota et le pays du visiteur. Le
lecteur sait déjà, et le lecteur est gratuit.

**Coût assumé** : un boot d'embed caché par page anime ayant un trailer YouTube,
une fois par vidéo et par session, entièrement chez le visiteur. Rien chez nous.

## 2026-08-14 — Le géo-blocage revient, par le lecteur cette fois

**Régression réparée, mieux qu'avant.** En supprimant l'appel Worker de
`/api/v2/preview`, j'ai supprimé avec lui la capacité de cacher un trailer
injouable — Bleach jouait donc dans le vide. Mais l'ancien verdict répondait à la
mauvaise question : il parlait de la région d'un **datacentre**, pas de celle du
visiteur.

**La bonne réponse arrivait déjà et on la jetait.** Mesuré depuis la France :

| vidéo | messages du lecteur |
|---|---|
| Bleach `0c4IoCA5fY0` | `etat -1` puis **`onError 150`** |
| témoin jouable | `etat 5, -1, 3, 1` — aucune erreur |
| vidéo supprimée | `onError 150` |

Ce qui manquait n'était pas le signal, c'était la **mémoire** : sans elle la
carte monte le lecteur, apprend que c'est bloqué, se cache — et recommence à
chaque survol. `lib/preview/trailerBlocked.ts` retient les codes 100/101/150 pour
la session. Les codes 2 (mauvais paramètre) et 5 (erreur HTML5) sont exclus : le
premier est notre bug, le second est passager, et cacher un trailer là-dessus
supprimerait des aperçus qui marchent.

**Pas persisté volontairement** : la disponibilité dépend d'où l'on est, et
quelqu'un qui voyage — ou qui coupe un VPN — ne doit pas se voir refuser pendant
des semaines un trailer qu'il peut désormais regarder.

**oembed ne sert à rien pour ça** : `youtube.com/oembed` est bien lisible en CORS
(il renvoie l'`Origin` demandé), mais répond **200** pour Bleach. Il détecte le
supprimé et le privé, pas le blocage régional. Vérifié avant de bâtir dessus.

**Naruto : un faux négatif que l'instrument ne peut pas voir.** Le trailer
`-G9BqkgZXRA` porte des bandes latérales constantes — mesurées sur 19 captures
de la carte réelle, présentes sur les 19, ~5,8 % de la boîte après notre débord,
soit ~10 % dans la vidéo. Et **aucune** des images publiées par YouTube (mq1,
mq2, mq3, mqdefault, maxresdefault, hqdefault, sddefault) ne montre une seule
colonne noire, à aucun seuil jusqu'à 64. Les vignettes ne sont pas la même image
que le flux. Comme le flux est cross-origin, il n'y a rien d'autre à regarder :
ces trailers gardent leurs bandes. Consigné dans l'en-tête de `trailerBars.ts`
pour que personne ne passe un après-midi à desserrer des seuils contre une image
qui n'a jamais porté la preuve.

## 2026-08-14 — Bandes noires, curseur, et un coût Vercel qui ne servait plus

**Un appel Worker inutile sur chaque payload d'aperçu.** `/api/v2/preview/[id]`
demandait encore à notre Worker Cloudflare `/w/trailer/<id>.json` si la vidéo
était supprimée ou bloquée — un aller-retour **bloquant, jusqu'à 1,2 s de temps
de fonction Vercel**, sur chaque payload qui rate le cache edge, pour un verdict
que plus personne ne lit depuis que la carte joue l'embed (qui rapporte ses
propres erreurs par `onError`). Pire : l'endpoint appelé a été supprimé de la
source du Worker, donc au prochain déploiement c'était un aller-retour vers un
404. Supprimé.

**Le chemin trailer ne touche plus rien à nous** : `youtube-nocookie` pour le
lecteur, `i.ytimg` pour les images, `google.com` en préconnexion. Aucun Worker,
aucun proxy, aucun Upstash. (`/api/v2/preview` sert toute la carte et
préexistait au trailer.)

**Bandes noires — ce qui est mesurable quand on ne peut pas lire la vidéo.**
L'iframe est cross-origin, donc ses pixels sont hors d'atteinte : c'est pour ça
que l'ancienne sonde de recadrage était morte avec le proxy. Mais YouTube publie
`mq1/mq2/mq3.jpg`, trois images prises à ~25/50/75 % de la vidéo, en **vrai
16:9** (320×180) et servies en `Access-Control-Allow-Origin: *` — donc lisibles
dans un canvas. (Les `1/2/3.jpg` sont en 4:3 : ils portent le letterbox de
YouTube lui-même et déclareraient 12,5 % de bande sur toute vidéo 16:9. Vérifié.)

**La médiane, pas le minimum.** Premier essai : minimum par côté sur les trois
images — trop sévère, une seule image discordante (un logo de fin qui remplit le
cadre) annulait une bande présente partout ailleurs. Blue Exorcist, réellement
encadré de noir sur quatre côtés, passait à travers. La médiane demande que
**deux images sur trois** soient d'accord, ce qui est la définition utile de « la
bande est là pendant la vidéo ». Puis symétrie forcée entre côtés opposés : une
asymétrie veut dire qu'on regarde une scène sombre, pas une bande — et ça garde
le recadrage centré, donc rien à réaligner.

**Mesuré sur 140 trailers populaires : 1 recadrage, 0 faux positif.** C'est rare,
et c'est la forme honnête du problème. Death Note — le cas signalé — n'est **pas**
recadré, à raison : ses trois images montrent des cadrages différents et un écran
de fin plein cadre. Ses bandes sont par plan, et aucun recadrage statique ne peut
les enlever sans massacrer les plans qui vont bien.

Garde-fous : bord net exigé (la ligne juste après la bande doit être nettement
plus claire, sinon un ciel nocturne se fait recadrer), plafond à 30 % par côté,
zoom plafonné à 1,6, et une détection qui arrive après la révélation est
**ignorée** — redimensionner une iframe ×200 sous une vidéo en cours échange une
bordure noire contre une secousse. Le résultat est mis en cache, donc le survol
suivant est correct d'emblée.

**Le curseur** disparaît quand le trailer apparaît et revient au premier
mouvement — même règle que les boutons, parce que c'est la même question : le
visiteur regarde-t-il, ou cherche-t-il un contrôle ?

## 2026-08-14 — Le lecteur est préchauffé au repos ; deux fautes du commit d'avant

**La première carte restait noire.** Faute à moi, et précise : l'effet qui
dimensionne la couche mesurait `boxRef` alors que le composant renvoyait encore
`null` — l'iframe n'existait pas. L'effet ne se rejouait jamais (seul
`attachment` était en dépendance, et il ne changeait plus), donc le lecteur
gardait une taille nulle. `bootId` est maintenant en dépendance. À retenir : un
effet de mesure qui ne dépend pas de l'existence de ce qu'il mesure est un bug
qui attend son tour.

**Le son partait avant l'image**, et c'est ce design qui l'a introduit : un
lecteur qui meurt avec sa carte ne peut rien laisser fuiter dans la suivante, un
lecteur qui SURVIT transporte le volume de la carte d'avant. `loadVideoById`
démarrant aussitôt, le nouveau trailer était audible dès sa première frame
pendant que l'image attendait encore que l'horloge bouge. Silence imposé avant
chaque chargement, levé dans `reveal`, au même instant que l'image. Le fondu
passe aussi de 300 à 140 ms — l'oreille recevait un trailer fini pendant que
l'œil en recevait encore un.

**« On ne peut pas warm les trailers ? »** Ce qui se préchauffe, c'est le BOOT
(~450 ms), pas la vidéo — `cueVideoById` ne précharge rien, c'est mesuré (voir
plus bas). Le lecteur est donc booté à `requestIdleCallback`, sur le premier id
de trailer que les payloads déjà préchargés annoncent (`onFirstTrailer` dans
`previewStore`). Rien n'est fetché pour ça, aucune vidéo ne joue avant qu'une
carte le demande, et la première carte de la session ne paie plus le boot.

Le seul vrai warm de la vidéo elle-même serait de la JOUER d'avance, cachée et
muette, dans un second lecteur — ce qui consomme de la bande passante pour des
cartes que le visiteur n'ouvrira peut-être jamais. Non fait : c'est un arbitrage
qui appartient à Luc, pas une évidence technique.

## 2026-08-14 — Un seul lecteur pour toute la session

Deux symptômes signalés — « beaucoup trop long à charger » et « on voit toujours
le zoom avec le carré en haut à gauche » — une seule cause : **chaque survol
faisait naître un lecteur YouTube complet, de zéro**.

**Le budget, mesuré** (banc `bench23.js`, boîte de la taille de la carte, ×200) :

| poste | coût | à qui |
|---|---|---|
| naissance de l'iframe + boot du lecteur | ~450 ms | nous |
| le repos de 350 ms qui cachait la frame de démarrage | 350 ms | nous |
| `playVideo` → image qui avance | **~800 ms** | YouTube |

Les deux premières lignes étaient repayées à chaque poster. La troisième est
incompressible.

**Deux mesures qui ont changé le plan en cours de route :**

1. **`cueVideoById` ne précharge pas** (`bench24.js`). Cuer 200, 400, 800 ou
   1500 ms à l'avance donne la même médiane de démarrage (~600–1000 ms, aucune
   tendance). Le levier « précharger pendant les 200 ms d'immobilité du
   pointeur » — que j'allais construire — **n'existe pas**. Consigné dans
   l'en-tête de `TrailerStage` pour qu'il ne soit pas rebâti.
2. **Réemployer un lecteur chaud supprime la frame moche.** Photographié : un
   `loadVideoById` sur un lecteur déjà posé passe du noir à l'image, sans bouton
   géant ni carré blanc. Le carré n'était donc pas un défaut du ×200 mais du
   BOOT, que le ×200 se contentait d'agrandir.

**Piège de mesure, noté parce qu'il a menti pendant deux passes** : la vidéo
précédente continue d'annoncer son `currentTime` pendant que la suivante charge,
donc un simple « `currentTime` > 0,2 s » est satisfait instantanément — d'où une
colonne à 2 ms qui ne mesurait rien. Il faut avoir vu le compteur **redescendre**
avant d'accepter qu'il remonte. La même précaution est dans le code de prod
(`REWOUND`), pour la même raison.

**Ce qui a été fait** : le lecteur sort de la carte. `TrailerStage` est un
lecteur unique, monté au premier survol de la session et gardé vivant, dessiné
par-dessus l'emplacement vidéo de la carte ouverte. Il ne peut pas être
*déplacé* dans la carte — reparenter une iframe la recharge, ce qui détruirait
justement le boot qu'on garde — donc il reste en place et **mesure** la carte
(`stageStore.ts` : la carte prête un élément, pas un rectangle, sinon la position
dériverait du défilement).

**Le repos de 350 ms disparaît**, remplacé par une règle qui n'est pas une
horloge : on révèle quand le `currentTime` a bougé. Une constante ne peut pas
gagner une course dont la longueur appartient à la machine du visiteur ; c'est
pour ça que le carré revenait chez Luc et pas chez moi.

**Récupéré au passage** : le trailer se remet en pause derrière l'éditeur de
liste — la carte rend la scène quand le dialogue s'ouvre. C'était une régression
consignée le jour même, plus bas.

**Reste, honnêtement** : la première carte de la session paie toujours le boot.
Et les ~800 ms de YouTube ne bougent pas.

## 2026-08-14 — Le proxy trailer est supprimé, retour à l'embed nu

Décision prise après la journée de mesures : le proxy achetait une première
image propre au prix d'être **rationné par YouTube** — un tiers des trailers
refusés à froid depuis l'edge, quelle que soit la forme donnée à la requête.
Trois culs-de-sac indépendants mesurés le même jour (table des clients yt-dlp
épuisée, PO token obtenu mais catalogue WEB vide, aucun dépôt du domaine n'y
échappe) : le prix n'en valait pas la peine.

**Supprimé** : `worker/src/youtube-trailer.js` et son câblage, `NativeTrailer`,
`lib/preview/trailerCrop.ts`, `lib/preview/trailerVerdict.ts`, et la logique de
verdict dans `Overview` et `InfoPageMobile`.

**Pas touché** : `worker/src/index.js`, le proxy vidéo des **épisodes**. C'est un
autre chemin et il est en production — « enlève le worker » ne pouvait pas
vouloir dire celui-là.

**À la place**, l'embed délibérément nu : autoplay, muet, nos boutons par-dessus
et **mis de côté** pour ne pas s'empiler sur celui de YouTube — qui revient donc
les ~4 premières secondes. État connu et assumé : on veut une base simple et
juste avant de l'optimiser.

**La piste pour l'enlever est consignée dans l'en-tête d'`EmbedTrailer`** plutôt
que perdue : la chrome est fixe en pixels, donc elle ne survit pas à une
réduction (360 px de glyphe à ×1, 0 à ×8, cadre impeccable à ×200), avec ses deux
réserves — un voile de ~7 % qui survit à tout facteur, et une surface composée
quadratique qui dépend du navigateur qui la clampe. Banc :
`public/embed-scale-lab.html`.

**Régressions assumées, écrites plutôt que découvertes plus tard** :
- `TrailerAmbient` retombe sur la bannière floutée — une iframe cross-origin ne
  se lit pas, donc plus de lueur tirée des vraies images ;
- la sonde de recadrage disparaît : les vieux trailers avec bandes incrustées les
  montreront ;
- le trailer ne se met plus en pause derrière l'éditeur de liste.

**Le Worker n'est PAS redéployé, et c'est important** : la production sert
`main`, qui contient encore `NativeTrailer` appelant `/w/trailer/`. Déployer le
Worker amputé maintenant casserait les aperçus en production. Il ne pourra
l'être qu'une fois ce travail passé sur `main`.

## 2026-08-14 — Ne pas déplacer le cadre : AGRANDIR le player

Idée venue d'une intuition géométrique — « et si on décalait l'iframe ? ». Le
décalage lui-même avait déjà été essayé et échoue par construction : le bouton
est **au centre du player**, donc tout recadrage qui l'exclut exclut le centre de
l'image. Mais la question rouvre un indice mesuré le 09/08 et jamais exploité :
**à 120 px « la chrome MANGE l'image »**. Si elle mange l'image à 120 px, c'est
qu'elle ne rétrécit pas avec le player — donc elle est de **taille fixe en
pixels**.

Conséquence directe : il ne faut pas déplacer le cadre autour d'un bouton
constant, il faut **agrandir le player puis le réduire**. Une iframe montée à
2912 px et ramenée à 364 px par `transform: scale(0.125)` garde la vidéo
plein cadre et divise le bouton par huit.

**Mesuré** (pixels quasi-blancs dans le disque central, chrome encore présente à
t≈2,1 s, deux vidéos) :

| facteur | player | pixels de glyphe |
|---|---|---|
| ×1 | 364 px | **360** |
| ×2 | 728 px | 77 |
| ×4 | 1456 px | 10 — *encore visible à l'œil* |
| ×8 | 2912 px | **0** — le compte du témoin sans chrome |

Vérifié à l'image et pas seulement au compteur : à ×8 le bouton a disparu, le
titre en haut à gauche est une trace illisible de quelques pixels, le logo en bas
à droite idem. Sur la seconde vidéo les 118 pixels clairs restants à ×8 sont la
scène (le témoin en compte 80), pas le glyphe.

**Le coût en octets ne s'envole pas**, contre toute attente : sur les 6 premières
secondes — la durée d'un survol — 1,05 Mo à ×8 contre 1,15 Mo à ×1 sur une vidéo,
1,19 contre 0,48 sur l'autre. Même ordre de grandeur. L'ABR de YouTube n'a pas le
temps de monter. *Deux vidéos, variance forte : c'est un ordre de grandeur, pas
un chiffre.*

**Ce que ça remettrait en cause si ça tient.** Le proxy existe UNIQUEMENT pour se
débarrasser de ce bouton (première ligne de `youtube-trailer.js`). S'il tombe par
la géométrie, alors tombent avec lui : la bande passante du Worker, les appels
InnerTube, le blocage bot, le disjoncteur, l'échelle de réchauffage, et le projet
d'ingestion R2. Et les octets viendraient de la connexion du visiteur en direct —
c'est-à-dire la réponse à « comment paraître légitime aux yeux de YouTube ».

**Ce qui n'est PAS encore vérifié, et qui décide** :
- le coût de composition d'une iframe 2912×1640 **par carte**, sur une grille de
  survol qui en affiche plusieurs, et sur mobile ;
- la tenue sur beaucoup plus que deux vidéos ;
- ce que deviennent les traces résiduelles (titre, logo) à l'œil sur du contenu
  clair plutôt que sur ces deux-là.

Banc pour juger à l'œil : `public/embed-scale-lab.html`, curseur de facteur, ×1
contre ×N côte à côte à la vraie largeur de carte. **Le facteur 4 ne suffit pas.**

## 2026-08-14 — Existe-t-il un dépôt qui n'est PAS bloqué ? Non — et cobalt le prouve

Recherche de l'état de l'art plutôt que de nouvelles mesures.

**cobalt (imputnet)**, le téléchargeur le mieux tenu du domaine : son **instance
publique ne télécharge plus rien depuis YouTube** en 2026, et les contournements
réseau d'avant ne fonctionnent plus. Leur réponse officielle est **« auto-
hébergez »**, c'est-à-dire : utilisez votre propre adresse. Un projet actif et
bien doté n'arrive pas à servir YouTube depuis une infrastructure partagée. C'est
exactement notre situation, et c'est le meilleur argument qu'on ait que le
problème n'est pas notre code.

**Invidious** a déprécié `youtube-trusted-session-generator` au profit de
`invidious-companion`. Leur doc d'erreurs dit que YouTube bloque les adresses de
datacentre **et de VPN**, et leur conseil de dépannage n'est pas un meilleur
token : c'est de **faire tourner l'adresse**, en IPv6 quand la machine en a.

**Ce qui marche réellement, dans tout l'écosystème**, se réduit à quatre choses,
et aucune n'est une requête mieux formée :
1. proxies **résidentiels** (payants) ;
2. egress via **Cloudflare WARP** — YouTube ne traite apparemment pas les IP WARP
   comme du datacentre. Gratuit. Demande wireguard/wgcf sur une machine, donc
   **impossible depuis un Worker**, dont on ne choisit pas l'egress ;
3. tourner **sur la machine de l'utilisateur** (yt-dlp, cobalt auto-hébergé) ;
4. **cookies / OAuth** d'un vrai compte.

**La piste WARP est la seule nouveauté actionnable.** Elle ne change pas le plan
du 13/08 — sortir le résolveur du datacentre — mais elle en change le **prix** :
une source d'adresses gratuite au lieu de proxies résidentiels payants. Son
auteur prévient lui-même qu'il ne sait pas si ça tient dans le temps, et il
surveille la liaison toutes les 30 s.

**Correction que je dois à l'entrée précédente.** J'y ai écrit qu'un minteur de
POT pouvait vivre n'importe où, le lien étant `visitor_data` et jamais l'IP. Une
recherche affirme au contraire que le générateur doit tourner **sur la même IP
publique** que le serveur. Vérification faite dans la doc Invidious elle-même :
**elle ne dit ni l'un ni l'autre**. Donc mon affirmation reposait sur la lecture
du code de yt-dlp seule, la contradiction sur un résumé de moteur de recherche,
et **aucune des deux n'est mesurée**. Point laissé ouvert — sans conséquence, la
piste POT étant morte sur le catalogue.

*À noter aussi, contre l'enthousiasme d'aujourd'hui pour l'IPv6 : plusieurs
signalements décrivent YouTube prenant justement des adresses IPv6 pour des bots.*

## 2026-08-14 — « Et si c'était le navigateur du visiteur qui demandait ? »

Bonne idée, et elle oblige à séparer deux choses que ce dépôt confondait : la
RÉSOLUTION (l'appel InnerTube) et l'ENCAISSEMENT (tirer les octets googlevideo).

**La résolution depuis le navigateur est fermée, et proprement mesurée.**
Préflight `OPTIONS` sur `youtubei/v1/player` avec `Origin: https://aniscroll.com`
→ **403, et aucun en-tête CORS** (`access-control-allow-origin` absent). POST
direct → 403 également. Un navigateur ne peut donc pas appeler InnerTube depuis
notre origine. Ce n'est pas contournable côté client : c'est le serveur qui
refuse d'accorder l'origine.

**Et c'est ce qui tue l'idée**, parce que **le blocage est AU niveau de la
résolution** : le refus qu'on mesure est `LOGIN_REQUIRED: Sign in to confirm
you're not a bot`, rendu par l'appel player. Déplacer l'encaissement chez le
visiteur ne déplace donc pas l'étape refusée. On resterait bloqué au même taux.

**En revanche la signature par IP est moins ferme qu'écrit ici.** Le fichier
worker affirme qu'une URL mintée par nous « n'est pas utilisable depuis la
connexion du visiteur ». C'était une DÉDUCTION tirée d'une mesure voisine (on
avait vu que `sparams` liste `ip`). Testé pour de bon, en double pile : lien
résolu **en IPv6**, `ip=` portant bien l'adresse v6 — et **encaissé en 206 depuis
l'IPv4**, une autre adresse. Reproduit deux fois.

**Mais je n'en tire pas de conclusion**, et c'est délibéré :
- deux familles d'une même ligne restent **un même abonné** ; ça ne dit rien de
  deux réseaux vraiment étrangers ;
- une passe intermédiaire a rendu **403 depuis la maison même**, sur un lien
  qu'une autre passe encaissait en 206 — donc une autre variable traîne ;
- l'essai via Cloudflare est **non concluant** : le 410 venait de notre propre
  proxy, pas de googlevideo.

Donc : « signé sur l'IP » est mesuré, « **refusé** ailleurs » ne l'est toujours
pas, dans un sens comme dans l'autre. À ne pas re-déduire.

*Et si un jour ça se confirmait, le gain ne serait pas le déblocage — ce serait
la bande passante : le Worker résoudrait (du JSON), le navigateur lirait l'URL
directement en `<video src>`, qui n'exige aucun CORS contrairement à `fetch` et
MSE. Le bouton resterait absent, puisqu'il n'y aurait toujours pas de lecteur
YouTube. C'est une piste de COÛT, pas de blocage.*

**À traiter séparément** : le proxy principal accepte un `?url=` arbitraire, sans
liste blanche d'hôtes. C'est ce qui m'a permis de m'en servir comme encaisseur
tiers — et c'est exactement ce que n'importe qui d'autre peut en faire.

## 2026-08-14 — Le Worker déployé et mesuré : rien n'a changé, et c'était prévisible

Le Worker ne se déploie par aucun CI (pas de `wrangler` dans les workflows) : il
part d'un `wrangler deploy` à la main, donc **git ne dit pas quelle génération
tourne**. `youtube-trailer.js` apparaît en 1080 lignes ajoutées face à `main`
alors qu'il sert en production — la comparaison avec `main` ne renseigne sur rien.
Il fallait donc mesurer avant, déployer, remesurer.

**Avant** (AniList page 8, 14 trailers froids) : **8/14 servis**, 0 en cache,
disjoncteur fermé de bout en bout, refus uniformément
`LOGIN_REQUIRED: Sign in to confirm you're not a bot`.

**Après** (`wrangler deploy`, version `5719cb65`, puis page 12) : **10/14 dont 3
déjà en cache**, soit **7/11 à froid**. Sondage de contrôle page 20 : 7/8, et
l'unique échec est un `410 UNPLAYABLE / not available in your country` — un
verdict géographique correct, pas un refus.

**Verdict : aucun écart mesurable.** 57 % contre 64 % sur des échantillons de
onze à quatorze, ce sont des vidéos différentes et une vidéo d'écart ; seul un
grand écart aurait voulu dire quelque chose, et il n'y en a pas. Le déploiement
n'a d'ailleurs probablement rien apporté parce que la version en ligne était déjà
récente : elle estampillait déjà `X-Aniscroll-Cache` / `Breaker` / `It-Calls`.

**Ce que ça confirme** : le blocage ne vient pas d'un correctif qui manquait au
déploiement. Il est là où les trois culs-de-sac de la journée l'ont déjà situé —
l'egress.

*Sous-question laissée ouverte, honnêtement* : mon banc tronquait le diag à 90
caractères, et `android` n'y apparaissait jamais derrière `android_vr`. Relancé
sans troncature, aucun cas en échec ne s'est représenté (7/8, l'échec étant
géographique), donc **je n'ai ni confirmé ni infirmé** que le repli sur le second
client s'exécute. À revérifier quand une vague de refus se présentera.

## 2026-08-14 — PO token : la porte s'ouvre, la pièce est vide

Exécution du plan en cinq étapes. **Arrêté à la porte 1, comme prévu** — c'était
tout l'intérêt de mettre la question la moins chère en premier.

**Étape 0 (~5 min, prévu 20).** Ni Deno ni Docker sur la machine ; voie Node.
`bgutil-ytdlp-pot-provider` cloné **épinglé sur `1.3.1`**, `npm ci` en 21 s sans
compilation native (`canvas` 3.x fournit des binaires — la friction anticipée
n'existait pas), `npx tsc` propre. Et une bonne surprise : le mode `generate_once`
mint un token en un coup, donc **aucun serveur à tenir** pour l'essai.

**Étape 1 — deux temps.** Le POT seul ne change rien : WEB reste sur
`UNPLAYABLE / The page needs to be reloaded`. La pièce manquante n'était pas le
token mais le **`playbackContext.contentPlaybackContext`** que yt-dlp joint pour
les clients à JS player : `html5Preference: HTML5_PREF_WANTS` et le
`signatureTimestamp` (sts) lu dans le `base.js` du player — dont le chemin change
à chaque déploiement, donc il se lit dans la page, jamais en dur. Avec ça, **WEB
répond `OK`**. La machinerie marche, la porte s'ouvre.

**Et il n'y a rien derrière.** Sur 7 vidéos :

| | |
|---|---|
| **6 sur 7** | **zéro format progressif** (26 à 122 adaptatifs) |
| 1 sur 7 (`dQw4w9WgXcQ`) | un itag 18 unique, en **`signatureCipher`** |

Or les clients android rendent un itag 18 **en clair** pour ces mêmes vidéos.
YouTube a retiré le progressif du catalogue de WEB. Et la seule survivante n'est
pas une bande-annonce : c'est le Rickroll, une vieille vidéo — nos titres réels
sont dans les six.

**Le POT achète l'entrée d'une pièce qui ne contient plus de fichier muxé**, et
`<video src>` en exige un. Les étapes 2 à 5 tombent avec.

**La forme de l'argument compte**, parce qu'elle décide de sa durée de vie. Ce
n'est **pas** « le PO token est hors de portée » — il est parfaitement à portée,
le lien est `visitor_data` / `video_id` et **jamais l'IP**, donc un minteur posé
n'importe où aurait pu alimenter le Worker sans toucher à la topologie. C'était
même élégant. L'objection porte sur le **catalogue**, et c'est ce qui la rend
solide : aucune ingéniosité d'architecture ne fait réapparaître un format que
YouTube ne sert plus.

**Ce qui reste debout.** Les deux clients android, `REQUIRE_JS_PLAYER: False`,
seuls à rendre un itag 18 en clair — c'est-à-dire exactement ce que le worker
fait déjà. Et le seul levier non épuisé reste celui du 13/08 : l'egress.

*Corollaire, si un jour on acceptait MSE : WEB+POT rend 26 à 122 formats
adaptatifs. Mais MSE bute sur l'absence de CORS chez googlevideo, qui est la
raison d'être du proxy. La boucle est bouclée.*

## 2026-08-14 — Le POT est lié à la SESSION, pas à l'adresse (et pourquoi ça ne suffit pas)

Suite : si le remède de yt-dlp est hors de l'outil, comment font-ils, et peut-on
faire pareil ? Trois remèdes documentés — cookies, fournisseur de PO token, autre
egress. Le deuxième méritait d'être rouvert : je l'avais écarté en partie parce
que `workerd` interdit `eval` et ne peut donc pas faire tourner BotGuard. « Hors
du worker » dissout exactement cette objection.

**Comment ils font.** `bgutil-ytdlp-pot-provider` fait tourner la bibliothèque
BotGuard de LuanRT dans un **serveur HTTP séparé** (Node ≥ 20 ou Deno, port 4416,
image Docker fournie). yt-dlp lui demande un token par un plugin. Le VM BotGuard
n'est donc jamais dans l'outil : il est dans un service à côté.

**La bonne nouvelle, et elle est structurelle.** Dans
`yt_dlp/extractor/youtube/pot/utils.py`, le token est lié à `visitor_data`,
`visitor_id` ou `video_id` — **jamais à l'adresse IP**. Un minteur posé n'importe
où peut donc servir un appelant posé ailleurs. La topologie actuelle serait
préservée : le Worker mint son `visitorData`, demande au minteur un POT lié à ce
`visitorData`, résout lui-même, et comme l'URL googlevideo reste signée contre
**l'IP du Worker**, c'est bien le Worker qui tire les octets et remplit son cache.
Cloudflare resterait le serveur ; seul le minteur serait dehors.

**Les deux murs, mesurés aujourd'hui.**

1. **`WEBPO_CLIENTS` est une liste fermée** : WEB, MWEB, TVHTML5,
   WEB_EMBEDDED_PLAYER, WEB_CREATOR, WEB_REMIX, TVHTML5_SIMPLY et sa variante
   embedded. **ANDROID et ANDROID_VR n'y sont pas** — ils relèvent de DroidGuard
   (attestation Android), que bgutil n'implémente pas. Le POT externe ne peut
   donc **jamais** aider les deux seuls clients qui nous rendent un fichier muxé.
   Pour en profiter il faudrait passer à WEB.
2. **WEB ne rend rien à voir.** Interrogé proprement avec identité (5 vidéos) :
   `UNPLAYABLE` / « Video unavailable », sous-raison **« The page needs to be
   reloaded »** avec `signalAction: RELOAD_PAGE` — la signature canonique du POT
   manquant, donc un POT le débloquerait probablement. Mais la réponse contient
   **0 format progressif et 0 adaptatif** : on ne peut pas savoir d'ici s'il
   rendrait un itag 18. Et yt-dlp classe `web` en `REQUIRE_JS_PLAYER: True` — ses
   formats arrivent en `signatureCipher`, à déchiffrer avec le JS du player, que
   `workerd` ne peut pas exécuter. Les deux clients android sont justement
   `REQUIRE_JS_PLAYER: False`, et c'est pour ça qu'ils avaient été choisis.

**Où ça laisse les choses.** Le chemin existe sur le papier et ses deux points de
rupture sont nommés. Il ne se tranche que par l'expérience : monter bgutil, minter
un POT, interroger WEB, et regarder si un itag 18 revient **avec une `url` en
clair** plutôt qu'un `signatureCipher`. Si oui, l'architecture tient sans quitter
Cloudflare. Si non, le POT ne sert à rien ici et il ne reste que l'egress.

**Et un piège à ne pas répéter** : `_extract_visitor_id` lit le `visitorData` sans
parser le protobuf (découpe d'octets fixe). C'est de la reconnaissance de forme,
pas du décodage — ne pas s'en inspirer pour du code qui doit durer.

## 2026-08-14 — Reproduire yt-dlp : la table des clients est épuisée

Demande : reproduire ce que fait yt-dlp pour régler le blocage. Le worker s'en
inspirait déjà pour les EN-TÊTES (`generate_api_headers`), jamais pour la TABLE
DES CLIENTS. Lecture de `yt_dlp/extractor/youtube/_base.py` sur master, recopiée
champ par champ plutôt que de mémoire — quatre écarts, dont **trois jamais
testés** et deux qui invalidaient une conclusion antérieure :

1. `ANDROID` : on envoyait `20.10.38` / sdk 35 / Android 15, la référence envoie
   `21.26.364` / sdk 30 / Android 11.
2. `VISIONOS` (client 101, récent) : le **seul** du tableau sans aucune
   `GVS_PO_TOKEN_POLICY` ni `PLAYER_PO_TOKEN_POLICY`, avec
   `REQUIRE_JS_PLAYER=False`. Sur le papier, le client le moins exigeant qui
   existe. Jamais essayé.
3. `TV` / `TV_DOWNGRADED` / `TV_SIMPLY` : le balayage du 14/08 interrogeait
   `TVHTML5_SIMPLY_EMBEDDED_PLAYER`, **un nom que la référence n'utilise plus**.
   On avait donc conclu « ERROR » sur un client mort.
4. `WEB_EMBEDDED` : la référence lui pose `thirdParty.embedUrl` avec une URL
   **non-YouTube** (issue 14826). On l'avait interrogé sans — d'où son ERROR.

**Mesure** (8 vidéos froides, version/UA/champs device/`thirdParty` exacts de la
référence, avec `visitorData`, et le lien ensuite **redeemé** — un resolve qui ne
se redeeme pas ne vaut rien, leçon du 13/08) :

| client | résultat |
|---|---|
| `android`, `android_vr` | **7/8 SERVI** ← les deux déjà en place |
| `visionos` | OK, **0 format progressif** |
| `ios` | OK, 0 format progressif |
| `tv`, `tv_downgraded`, `tv_simply` | UNPLAYABLE |
| `web_embedded` (avec `thirdParty`) | ERROR |
| `mweb` | UNPLAYABLE |

Les deux retests corrigés échouent donc **quand même**, proprement interrogés
cette fois. Et `android_stale` (nos valeurs actuelles) fait exactement le même
score que la version de référence : 7/8, la même vidéo manquante.

**Ce verdict-là se transporte à l'edge, contrairement à tout le reste de ce
fichier.** Il porte sur la présence d'un flux MUXÉ, qui est une propriété du
client et non de l'adresse appelante : seuls les deux clients android rendent un
itag 18, et `<video src>` exige un fichier muxé. **Il n'y a pas de troisième
client à ajouter.** La table est close.

**Et il n'y a pas non plus de forme de requête à copier.** `_download_ytcfg` de
la référence ne va chercher un vrai ytcfg que pour les familles web et tv — pour
android elle **synthétise le contexte exactement comme ce fichier le fait**. Le
remède de yt-dlp face à un appelant datacentre refusé n'est pas une forme de
requête : ce sont des cookies, un fournisseur de PO token, ou un autre egress.
Ce qui rejoint la conclusion d'hier par un chemin indépendant.

**Changé** : les constantes ANDROID alignées sur la référence. Écrit dans le
fichier tel quel — c'est de la parité, **pas un gain mesuré** (7/8 contre 7/8) ;
c'est là parce qu'une version d'appli périmée est un écart qui ne peut que jouer
contre nous, jamais pour. Invérifiable depuis la maison, comme le reste.

## 2026-08-14 — Le bouton de l'embed, enfin PHOTOGRAPHIÉ

Question rouverte : le proxy existe parce que l'embed peint son bouton pendant
les premières secondes ; peut-on retirer ce bouton et se passer du proxy ? Jusqu'ici
on répondait par déduction. Cette fois on a REGARDÉ : Playwright + Chrome, capture
de la zone toutes les 250 ms — un screenshot composite inclut le contenu
cross-origin, donc ce que le raisonnement ne peut pas atteindre, l'appareil photo
le peut. (Banc jetable, hors dépôt.)

**Ce qui est peint, mesuré sur deux vidéos différentes** (`6vMuWuWlW4I` et
`dQw4w9WgXcQ`, `controls=0&autoplay=1&mute=1&disablekb=1&fs=0&iv_load_policy=3`) :
un même décor apparaît au même instant et au même pixel sur les deux, donc il
n'appartient pas au film — barre de titre + avatar de chaîne en haut, icône de
partage en bas à gauche, pastille « Plus de vidéos » en bas au centre, logo
YouTube en bas à droite, et **le glyphe pause ‖ exactement au centre**.

**Le point neuf, et il est décisif : cette chrome est peinte PENDANT `PLAYING`,
horloge qui avance.** Ce n'est pas un écran d'avant-lecture qu'un seuil sur
`currentTime` laisserait passer : elle s'efface **~4 s après le début réel de la
lecture** (rick : présente à t=3,14 s, partie à t=3,94 s ; DS : présente à
t=3,89 s, partie avant t=5,2 s). Le seuil réglable du banc `trailer-lab.html`
devrait donc valoir ~4 s — quatre secondes de jaquette sur une carte de survol,
c'est-à-dire pas d'aperçu du tout.

**Trois échappatoires, testées, toutes mortes.**
- *Paramètres* : `youtube-nocookie`, `modestbranding`, `showinfo`, `autohide`,
  `color`, `loop`+`playlist`, sans `enablejsapi` — captures **identiques au pixel**
  à la base. Aucun n'a d'effet, ce qui reconfirme l'entrée du 09/08 par la mesure.
- *Taille* : espoir que YouTube renonce à sa chrome sur un player étroit (on
  aurait rendu petit puis agrandi en `scale`). Mesuré à 120/160/200/240/320/480 px :
  **c'est l'inverse**, à 120 px la chrome MANGE l'image, le bouton reste.
- *Géométrie* : le `width:300%; margin-left:-100%` du codepen coupe bien le titre
  et le logo — mais le bouton est au centre du player, donc au centre du recadrage.
  Il existe bien deux zones propres (deux bandes verticales à mi-hauteur, ~25 %
  de large sur ~48 % de haut) : les viser demande un zoom ~4×. On échange un
  bouton contre une bouillie.

**Piège de diagnostic à noter.** Sur la capture d'origine (Demon Slayer, recadrage
central) on croyait voir « un A dans un carré + un bouton pause ». Le « A » est le
**logo Aniplex du trailer lui-même**, qui s'anime à cet instant précis ; seul le ‖
central appartient à YouTube. Deux vidéos valent mieux qu'une pour trancher ce
genre de chose : ce qui bouge d'une vidéo à l'autre est du contenu.

**Deux canaux de plus, testés après coup** (« avoir essayé N choses n'est pas une
preuve » — Luc, et il avait raison de pousser) :
- *Le pont `postMessage`*. Il relaie `{event:'command', func}` ; le player HTML5
  expose historiquement `hideControls()`. Envoyés en boucle : `hideControls`,
  `showControls`, `hideVideoInfo`, `setControlsVisibility`, `hideTitle`,
  `hideOverlay`, `setOption`. **Captures identiques au pixel** — le pont n'a
  qu'une liste blanche, le reste tombe en silence.
- *`embed_config`*, le JSON de configuration des intégrations maison de YouTube.
  Trois jeux de clés (`hideControls`, `showTitle`, `hideInfoBar`, `unbranded`,
  `disableRelatedVideos`…) : **aucun effet**, captures identiques.

### Ce qui MARCHE, et qui n'avait jamais été tenté : masquer par position

La chrome n'est pas la vidéo, et surtout elle est peinte à des positions FIXES du
player. Cette régularité est exploitable — on n'a pas besoin de l'atteindre, il
suffit de savoir où elle tombe :
- bandeaux haut et bas → **sortis du cadre** en faisant déborder l'iframe.
  Mesuré au palier : garder 0,80 de la hauteur ne suffit pas (titre + barre du
  bas visibles), 0,72 laisse dépasser la pastille « Plus de vidéos », **0,64 est
  propre** — soit un zoom de 1,56 ;
- le glyphe central → il reste **un seul endroit**, le centre exact, ~10 % de la
  largeur du player (≈ 57 px sur notre carte de 364 px). Une pastille à nous le
  couvre.
- au-delà d'un zoom de ~2,1 le centre du player sort lui-même du cadre : plus
  aucun calque, mais on ne voit plus que la moitié de l'image, décentrée.

Le prix passe donc de **4 s d'image entièrement cachée** à **un zoom de ~1,6 plus
une pastille de 57 px pendant ~4 s**. Banc de démonstration :
[public/embed-mask-lab.html](public/embed-mask-lab.html), embed nu et embed
masqué côte à côte, réglages en direct.

### Deux mesures de plus, qui ont chacune démenti ce que je venais d'écrire

**Le seuil ne se transpose pas d'une taille à l'autre.** Les 0,64 ci-dessus ont
été mesurés sur un cadre de 480 px ; la carte fait 364. Re-mesuré à 364 : il faut
**0,60** (à 0,64 la pastille « Plus de vidéos » dépasse encore). La chrome se
dimensionne avec le player, donc elle occupe une fraction plus grande quand le
player rétrécit. Tout réglage trouvé ici vaut pour une largeur donnée.

**L'état du player n'annonce PAS la chrome.** J'avais câblé « la pastille suit
l'état », en tenant pour acquis qu'elle ne revient qu'en quittant `PLAYING`.
Mesuré : réseau coupé + saut en avant → **la chrome revient en entier avec
`playerState === 1`**. C'était déjà visible au démarrage (peinte pendant PLAYING
pendant ~4 s) et je ne l'avais pas généralisé. Donc **la pastille doit être
permanente** : tout masquage piloté par l'état est un pari.

**D'où une troisième option, « décentré ».** Plutôt que couvrir le centre, on le
sort du cadre : fenêtre calée après le centre du player, ce qui impose un zoom
> 2 (`x0 > 50·Z` et `x0 + 100 ≤ 100·Z` en % du cadre ; on prend 2,6, le player
borde son image et la marge n'est pas du luxe). Vérifié sur deux vidéos, au
démarrage **et** sous le stress qui rappelait la chrome : **rien, jamais, sans
dépendre d'aucun état**. Le prix est brutal — il reste ~17 % de la surface de
l'image, décentrée.

### Leçon

Le bouton n'est ni supprimable ni atteignable — mais « on ne peut pas l'enlever »
n'impliquait pas « on ne peut pas s'en débarrasser », et j'ai tenu les deux pour
équivalents pendant une semaine. Ce qui a débloqué, c'est d'arrêter de chercher
un canal vers le DOM de YouTube pour regarder la seule propriété qu'on possède
déjà : **il peint toujours au même endroit.**

Deuxième leçon, contre moi-même : j'ai écrit « les transitions sont annoncées par
l'API » à l'instant même où je venais de photographier une chrome peinte pendant
PLAYING. **Un raffinement qu'on trouve élégant se relit moins bien qu'on ne le
mesure** — celui-là a survécu deux heures avant que le banc ne le tue.

Ce que le masquage ne rend toujours pas : la pause (état 2 = gros ▶ permanent) et
le cadrage. Le choix se résume à trois lignes, pour une carte de 364 px :

| | zoom | calque | image visible | dépend d'un état ? |
| --- | --- | --- | --- | --- |
| proxy (actuel) | 1,00 | aucun | 100 % | non |
| masqué, pastille | 1,67 | pastille ~57 px | ~36 %, centrée | non |
| masqué, décentré | 2,60 | aucun | ~15 %, décentrée | non |

Le proxy garde l'avantage. Mais « on ne peut pas » était faux, et c'est ça qu'il
fallait corriger.

### Les pistes SANS compromis, et la racine qu'elles ont fini par exposer

Cahier des charges de Luc, et il est le bon : **image entière, aucun bouton,
qualité native**. Tout ce qui zoome ou couvre est donc hors sujet. Trois pistes
restantes, testées :

- **Démarrage programmé** (charger sans `autoplay`, appeler `playVideo()` à
  `ready`) : chrome identique.
- **Son actif** (l'overlay long est-il l'affordance « activer le son » de
  l'autoplay muet ? clic préalable pour l'activation collante, puis `mute=0`) :
  chrome identique. Ce n'est pas ça.
- **Rendre le player SAME-ORIGIN** — la seule piste qui cochait les trois cases :
  on récupère la page `/embed/`, on y injecte `<base>` + une feuille qui tue
  `.ytp-*`, et on la sert depuis notre domaine ; le player se construit alors
  dans NOTRE document. **Et il s'y construit vraiment** : `#movie_player`
  présent, `<video>` présent, 16 nœuds `ytp-` joignables par notre CSS. Mais
  YouTube refuse de jouer — **erreur 153**, contrôle du domaine d'embed — et les
  appels `youtubei/v1/*` sont bloqués par CORS depuis notre origine.

**Et en remontant ce dernier échec on tombe sur la vraie racine.** Pour réparer
les CORS il faudrait relayer les appels InnerTube par le worker — donc l'URL
média serait frappée par le worker. Or, mesuré aujourd'hui pour la première fois
au lieu d'être affirmé : `sparams` contient bien **`ip`**, et le champ `ip=` vaut
l'adresse de la machine appelante (vérifié : mon IPv6). Balayage de six clients
InnerTube — ANDROID, ANDROID_VR (itag 18, `ip` signée), IOS (aucun muxé, 27
adaptatifs), MWEB `UNPLAYABLE`, TVHTML5_SIMPLY_EMBEDDED et WEB_EMBEDDED `ERROR` :
**aucun ne rend d'URL muxée non liée à l'adresse.**

Donc la même contrainte tue les deux architectures alternatives : le player
same-origin comme le « worker qui répondrait juste une URL » butent sur le fait
qu'une URL frappée chez nous ne vaut rien chez le visiteur. **Le transit des
octets n'est pas un choix, c'est la conséquence de la signature par IP** — et
c'est ça, pas le bouton, qui explique l'architecture actuelle.

### Conclusion, cette fois avec le périmètre mesuré

L'embed ne peut pas rendre les trois à la fois. Le canal DOM est clos (paramètres,
liste blanche du pont, `embed_config`), le canal same-origin est clos (153 +
CORS), et le canal « URL directe » est clos (signature par IP, tous clients).
Ce qui reste — masquer par position — coûte du zoom ou un calque, c'est-à-dire
exactement ce que le cahier des charges refuse.

**Le proxy n'est donc pas la solution la moins mauvaise : c'est la seule qui
satisfait les trois contraintes, et elle est déjà en production.**

### Post-scriptum : le calque qui ne retire rien à l'image

Idée de Luc, annoncée comme « vraiment stupide » : au lieu de masquer le bouton,
**redessiner par-dessus les pixels de la vidéo**. LIRE ces pixels est interdit —
et ce n'est pas un oubli, c'est la règle qui empêche une page de photographier
l'iframe de votre banque.

Mais `backdrop-filter` ne passe pas par JS : il demande au COMPOSITEUR de filtrer
ce qui est derrière l'élément, et le navigateur l'autorise sur du cross-origin
précisément parce que le script n'en apprend rien. **Le bouton est donc remplacé
par la vidéo elle-même**, floutée, vivante, aux bonnes couleurs.

Deux réglages viennent de la mesure, et ils font toute la différence :
- le flou doit s'appliquer **2,4× plus large que le glyphe**. À sa taille, le
  blanc n'est pas dilué, il est ÉTALÉ : on remplace un bouton net par une tache
  claire. C'est l'étalement large qui le noie.
- **masque radial à bord doux**, sinon le disque flouté a un contour net, aussi
  visible que ce qu'il cache.

Résultat mesuré : sur fond sombre (le cas le plus dur, glyphe blanc très
contrasté) **il disparaît entièrement** ; sur fond clair il reste un voile à
peine perceptible. Et contrairement au `filter` du 09/08 qui avait figé le rendu
d'une iframe cross-origin, celui-ci ne gèle rien — deux clichés espacés diffèrent.

Ça ne change pas la conclusion (il reste le zoom de 1,67, que le cahier des
charges refuse), mais ça règle le seul reproche qu'on pouvait faire au calque :
il ne coûte plus un morceau d'image. Réglage `remplissage: flou` dans le banc.

Leçon : la meilleure idée de ces deux jours est arrivée précédée de « c'est
vraiment stupide ». La question à se poser n'était pas « peut-on lire les pixels »
(non, et c'est définitif) mais « qui d'autre y a accès » — le compositeur, lui,
les manipule en permanence sans jamais les montrer à personne.

### Dernière fouille, web compris

**La « couche sombre » est réelle, et c'est la bonne objection.** Le bezel n'est
pas qu'un glyphe : c'est un disque sombre translucide AVEC les barres blanches
dessus, plus deux dégradés aux bords (`ytp-gradient-top`/`bottom`). Donc flouter
le centre, c'est aussi flouter ce disque sombre. Vérifié à l'image sur un plan
clair, pendant la chrome : le noir franc fait un trou, le flou à 2,4× dilue le
disque sombre en même temps que les barres et laisse un voile clair. Il tient,
mais c'était à vérifier plutôt qu'à supposer. (Tentative de chiffrer un voile
plein cadre par deux lecteurs décalés : abandonnée, l'alignement des contenus
n'était pas assez précis pour que les moyennes veuillent dire quelque chose.)

**Deux hypothèses de plus, mortes.** La chrome est-elle un rite d'accueil payé
UNE FOIS par page (monter un lecteur leurre, puis le vrai) ? Non : le second
lecteur affiche exactement la même chrome, leurre visible ou hors écran.
`start=` grand y change-t-il quelque chose (0, 8, 30, 60, 120) ? Non plus.

**Ce que dit le web** (recherche demandée par Luc) : rien de plus que ce qu'on a
dérivé. Les deux seules techniques qui circulent sont « couvrir jusqu'à la
lecture » et « agrandir l'iframe pour rogner l'UI » ; la doc officielle des
paramètres ne propose rien, `autohide` est déprécié, `modestbranding` ne touche
que le logo, et `embed_config` n'apparaît nulle part comme levier public.

**Une seule vraie trouvaille, et elle vient de là** : `movingThumbnailDetails`,
la vignette ANIMÉE de YouTube (celle du survol sur youtube.com). Elle existe pour
nos trailers — vérifié sur les deux ids de test via `youtubei/v1/search` :
`an_webp/<id>/mqdefault_6s.webp`, **320×180, ~135 Ko, HTTP 200**, servie par
i.ytimg.com. Sans signature elle répond 404, mais l'URL signée est stable ~6 h
par vidéo, donc elle n'est pas liée à l'IP comme googlevideo. C'est donc la seule
image de trailer que YouTube nous laisse afficher **sans chrome, sans zoom et
sans faire transiter nos octets** — 135 Ko contre 3 Mo.

**Mais son contenu, décodé chunk par chunk plutôt que déduit du nom de fichier
(`mqdefault_6s`, qui ment) : `du=3000`, 24 images ANMF, 3,00 s, 8 i/s, 320×180,
muet.** Ce n'est pas une lecture de trailer, c'est une vignette qui bouge. À
garder en tête si le proxy devient un problème de coût ; jamais comme un
remplaçant.

### Les autres hôtes d'embed : onze testés, deux qui jouent

Piste de Luc : YouTube a d'autres domaines, l'un d'eux sert peut-être un player
différent. Onze hôtes frappés, puis photographiés :

| hôte | résultat |
| --- | --- |
| `www.youtube.com` | joue — chrome de référence |
| `www.youtube-nocookie.com` | joue — **captures identiques au pixel** |
| `www.youtubeeducation.com` | page servie (136 Ko) mais **erreur 152-2**, vidéo indisponible |
| `youtube.googleapis.com` | page servie, **erreur de lecture** |
| `www.youtubekids.com` | page servie (128 Ko), **frame plantée** |
| `m.youtube.com` | 302 → `www.youtube.com?app=desktop` |
| `music.youtube.com`, `/shorts/` | 302 → mur de consentement |
| `youtu.be/embed/` | 303 → `/watch` |
| `youtubeembeddedplayer.googleapis.com` | 404 |

Les trois refus ont été rejoués **sous une vraie origine** (page servie comme si
elle venait de `dev.aniscroll.com`, par interception) — `localhost` est un cas
particulier pour un embed et j'aurais conclu de travers. Refus identiques. Il n'y
a donc que deux hôtes qui jouent, et ils dessinent la même chrome.

### Les proxys d'inconnus : un sur douze répond encore

Douze front-ends tiers frappés (Invidious et Piped), parce qu'ils servent le
média sans chrome — exactement notre cahier des charges, chez quelqu'un d'autre.

**L'écosystème s'est effondré.** La liste officielle `api.invidious.io` ne
compte plus que 11 entrées, dont 2 en https et **sur un réseau overlay `.ygg`**,
injoignable depuis l'internet normal. Sur 9 hôtes historiques : 4 morts en DNS,
1 en 418, 1 en 404, et les 3 qui répondent 200 sur `/embed` renvoient du
**`text/html` sur la route média** — une page d'erreur, pas un fichier. Côté
Piped, 2 des 3 API testées répondent 403/404.

**Un seul marche**, `api.piped.private.coffee` : flux muxé MP4 360p (le même
itag 18), servi par `proxy.piped.private.coffee` en 206, avec
`Access-Control-Allow-Origin: *` — donc mieux que googlevideo, qui n'en met
aucun. Course sur le même fichier de 11,28 Mo, deux passes :

| | passe 1 | passe 2 |
| --- | --- | --- |
| notre worker | 0,77 s (14,7 Mo/s) | 0,67 s (16,9 Mo/s) |
| piped (inconnu) | 1,31 s (8,6 Mo/s) | 1,06 s (10,6 Mo/s) |

**Sauf que cette course était truquée** : elle portait sur une vidéo déjà
résolue. Sur des ids FROIDS, l'instance ne résout **rien du tout** — 10/10 en
HTTP 500, et le corps de l'erreur est mot pour mot notre mur :

```
SignInConfirmNotBotException: YouTube probably temporarily blocked anonymous
watch access with this IP, got LOGIN_REQUIRED: "Sign in to confirm that you're not a bot"
```

Le proxy média, lui, ne filtre rien (Referer/Origin quelconques : 206 ; 12
requêtes rapprochées : 12 × 206). Ce n'est donc pas l'instance qui nous refuse,
c'est YouTube qui la refuse ELLE — et sans résolution, un proxy média ne sert à
rien.

**Tête-à-tête à froid, 6 trailers que personne n'avait vus :**

| | 1 tentative | +15 s | +30 s |
| --- | --- | --- | --- |
| notre worker | 1/6 | 3/6 | **4/6** (les réussis reviennent en 20-42 ms) |
| piped | 0/6 | 0/6 | 0/6 |

**Et c'est le vrai enseignement.** Nous sommes rationnés exactement comme elle —
même refus, même phrase. La différence n'est pas l'adresse IP, c'est
l'ARCHITECTURE : `warmLater` retente hors bande, les reprises client ont un
rendez-vous à 7 s, et le cache d'edge rend définitif chaque succès. L'instance
tierce n'a rien de tout ça : un refus chez elle est un refus final.

**Verdict.** Ça ne marche pas, sauf sur ce qu'elle a déjà en cache. Même si ça
marchait, ce serait un serveur bénévole sans engagement, dans un écosystème dont
les trois quarts sont morts pendant qu'on regardait, et notre coût déplacé sur la
bande passante de quelqu'un qui ne l'a pas demandé. Ni architecture, ni repli.

### Le PO token : fausse piste, et c'était la mienne

J'avais suggéré le PO token comme prochaine marche. Vérification faite, c'est
une impasse, pour trois raisons indépendantes.

**1. Le format 18 est précisément l'exempté.** yt-dlp #17348 : « `android_vr` now
requires GVS PO token for anything but format 18 » — le seul format qui reste
servi sans jeton est « format 18 (H.264 360p pre-merged with AAC over https) ».
C'est exactement, et uniquement, celui sur lequel repose tout ce worker. Notre
architecture est déjà dans le couloir exempté ; un jeton GVS n'achèterait rien.

**2. Notre refus n'est pas une absence de jeton, c'est un rationnement.** La
preuve est dans notre propre diagnostic du 13/08 : même vidéo, même client, aucun
jeton, six passes — passe 1 **200 partout**, puis dégradation jusqu'à 403 partout.
Une absence de jeton est une CONSTANTE ; elle ne peut pas produire « ça marche,
puis ça ne marche plus ». Et l'instance Piped, qui n'utilise pas non plus de PO
token, reçoit le refus au mot près.

**3. On ne peut pas en fabriquer dans un Worker.** BotGuard exige d'évaluer du JS
à l'exécution ; `workerd` interdit `eval`/`new Function` (le drapeau
`allow_eval_during_startup` ne couvre que le démarrage, pas un défi par vidéo).
Il faudrait un service Node séparé (bgutil + jsdom) — et comme les jetons sont
désormais liés à l'ID DE LA VIDÉO, ce serait une attestation par trailer, pas une
par session. L'économie « un jeton toutes les 6 h » n'existe pas.

**Et les clients sans jeton ne rendent rien d'utilisable** (avec le
`thirdParty.embedUrl` qui manquait à mon premier essai) : `TVHTML5` →
`UNPLAYABLE` « The page needs to be reloaded », `TVHTML5_SIMPLY_EMBEDDED_PLAYER`
→ « YouTube is no longer supported in this application », `WEB_EMBEDDED_PLAYER`
→ « This video is unavailable ». Les deux clients android restent les seuls.

### Les autres sources : il n'y en a pas dans notre catalogue

**Mesuré sur nos propres données** (AniList, 400 animes les plus populaires) :
378 ont un trailer, et **378 sur 378 ont `trailer.site === "youtube"`**. Pas un
seul dailymotion, pas un seul vimeo. La question « et si on prenait ailleurs »
n'a donc pas de réponse gratuite : il faudrait CHERCHER le trailer ailleurs, pas
le lire ailleurs.

**Dailymotion**, la seule vraie alternative testée : API publique sans clé,
10/10 de nos titres rendent au moins un candidat embarquable. Sauf que ce sont
des uploads amateurs — « Tráiler VO », « Trailer [Vostfr] », un « Soundtrack »
classé en trailer, un promo Netflix live-action pour One Piece. On échangerait un
id CURÉ par AniList contre une recherche floue, avec le risque d'afficher la
mauvaise vidéo sur une fiche. Et son player, photographié comme les autres :
**pas de bouton central** — mais une bannière de consentement aux traceurs qui
occupe le tiers haut de l'image, toujours là à 5 s, infermable depuis l'extérieur
puisque cross-origin. On troquerait 4 s de bouton contre un bandeau définitif.

### Comment les outils de téléchargement évitent le drapeau

Lu chez ceux qui vivent le même problème en production.

**Le facteur dominant n'est pas le protocole, c'est l'ADRESSE.** Les IP de
datacentre (AWS, GCP, Azure, VPS) sont scrutées beaucoup plus durement : le même
script marche sur un portable et échoue sur un serveur. **Notre worker tourne sur
Cloudflare, donc en datacentre.** C'est l'explication la plus simple de « ça
marche chez moi, ça se fait flaguer en prod », et elle ne se corrige par aucun
en-tête.

**Ce que fait cobalt**, service public confronté au même mur, d'après ses
variables d'environnement — trois leviers, pas un de plus :
- `YOUTUBE_SESSION_SERVER` : *« URL to an instance of yt-session-generator. used
  for automatically pulling `poToken` & `visitor_data` »* — donc un SERVICE
  SÉPARÉ, pas du code dans l'app (avec `YOUTUBE_SESSION_INNERTUBE_CLIENT`, qui
  doit être un client compatible botguard, c'est-à-dire `web`) ;
- `COOKIE_PATH` : des cookies de compte connecté ;
- `HTTP_PROXY`/`HTTPS_PROXY` : une sortie réseau ailleurs qu'en datacentre.

**Et yt-dlp** recommande la même famille : coller au client de référence (fait le
13/08), ralentir (`--sleep-interval`), choisir un client moins challengé
(android — le nôtre), cookies d'un navigateur connecté, et un fournisseur de POT
pour les IP déjà flaguées.

**Aucun des trois leviers n'est disponible pour nous.** Le service de jetons
demande un runtime avec `eval` (voir plus haut) ; les cookies veulent un compte
YouTube réel dont on ferait porter tout le trafic de l'app, avec le risque de
bannissement qui va avec ; et une sortie résidentielle est un service payant dont
le seul objet est de faire passer du trafic de datacentre pour autre chose.

**Ce qu'on a et qu'aucun de ces outils n'a : un cache.** yt-dlp et cobalt
résolvent à la demande, pour un utilisateur, une fois. Nous servons N visiteurs
la même vidéo. C'est notre seul avantage structurel, et il pointe exactement là
où la mesure pointait déjà.

### Dailymotion : les deux exigences échouent

Luc demande TOUS les titres, et sans recherche par nom. Les deux tombent.

- **Pas de catalogue officiel.** Chaînes éditeurs frappées une à une :
  `crunchyroll_fr`, `crunchyroll`, `animedigitalnetwork`, `kazevideo`,
  `allthatanime` **n'existent pas** ; `adn`, `animeland`, `netflixfr` ont **0
  vidéo** ; `wakanim` en a **3** ; `kana-home-video` **20**. Il n'y a pas de
  source officielle à indexer.
- **Rien sur quoi joindre.** Tous les champs qu'une vidéo expose : `id`, `title`,
  `description`, `tags` (texte libre), `channel`, `owner`, `duration`, `language`.
  Aucun identifiant d'œuvre. « Autrement que par recherche de nom » est donc
  impossible en principe, pas seulement difficile. Le 10/10 mesuré hier était de
  l'upload amateur trouvé au nom — l'exemple type appartient à une chaîne
  « Movie Trailer » (`shortfilms`), pas à un éditeur.
- **La bannière** est un consentement TCF. Elle disparaît quand la page PARENTE
  porte un vrai CMP et que le visiteur a consenti ; elle ne se supprime pas
  depuis l'extérieur, et la simuler serait un problème de conformité, pas une
  astuce.

### Sortir de Cloudflare : la mesure dit oui, mais pas n'importe comment

**L'adresse compte, et beaucoup.** 30 résolutions InnerTube en rafale, sans
pause, depuis une ligne résidentielle : **30/30 en 2 s**, aucune dégradation —
là où le worker oscille entre 1/6 et 6/8 sur des ids froids. Le rationnement ne
vient donc ni de la cadence, ni des en-têtes, ni d'un jeton manquant : il vient
de l'egress datacentre.

**Mais on ne peut pas résoudre ici et servir là-bas.** L'URL googlevideo est
signée contre l'IP qui l'a frappée (mesuré le 14/08, `ip` dans `sparams`). La
machine qui résout doit donc aussi tirer les octets. La forme viable est :
egress non-datacentre qui résout ET récupère, avec le Worker devant en cache
d'edge — le miss froid coûte quelques Mo sur cette liaison, tout le reste est
servi par l'edge. Reste à vérifier ce que devient cette IP au volume réel de la
prod : 30 requêtes en 2 s ne prouvent pas qu'une ligne domestique tient une
journée de trafic.

### Deux fausses pistes que j'ai suivies, et ce qui les a arrêtées

**« android_vr est mort, on le met en second. »** Mesuré 0/14 contre 14/14 pour
android, depuis cette ligne. C'était faux : ma requête **omettait le
`visitorData`** que le worker mint et envoie. Rejouée avec identité :
**10/10 pour les deux clients**, redemption du lien comprise. Un client refusé
sans identité ne dit rien du client tel qu'on l'utilise.

**Et surtout, le commentaire de `CLIENTS` décrivait déjà l'erreur** : depuis une
ligne résidentielle android paraît le meilleur meneur, mais depuis l'edge ses
liens tombent en 403 — c'est l'exigence de jeton GVS que le PO Token Guide
attribue à ANDROID et pas à ANDROID_VR. « Cette correction a coûté un deploy »,
dit le fichier. Elle a failli en coûter un second.

**La leçon, et elle vaut pour la section précédente :** une mesure prise à la
maison ne se transporte pas à l'edge. Avant de déménager le résolveur, il faudra
mesurer sur l'egress réellement visé, pas sur celui qu'on a sous la main.

### Ce que la mesure désigne à la place

Le rationnement est fonction du TEMPS, pas de notre identité. La bonne réponse
n'est donc pas de mieux s'authentifier, c'est de **sortir la résolution du chemin
critique du visiteur** : une fois chaud, un trailer revient en 20-42 ms, et on a
mesuré 4/6 à +30 s contre 1/6 à la première tentative. Pré-chauffer les trailers
des fiches populaires hors ligne (cron) déplacerait l'échec là où il ne coûte
rien — personne n'attend. C'est la suite naturelle, et elle ne demande aucune
nouvelle dépendance.

## 2026-08-14 — Lumière d'ambiance du survol : elle ne pouvait pas bouger

Plainte : « la couleur est bonne au début puis se fige (rouge) pour tout le reste ».
Trois commits de plomberie à l'aveugle avant de mesurer. **Mesurer d'abord.**

### La vraie cause (mesurée, pas déduite)
Le glow était piloté par `currentTime / duration`, et les trois images de YouTube
(`mq1/2/3`) étaient placées à 1/6, 3/6, 5/6 — leur vraie position dans la vidéo.
Sonde Puppeteer sur dev, trailer de 129 s : **25 s de survol = `p` 0.002 → 0.19**.
Tout le survol se passe sous 1/6, la zone où le fondu vaut 100 % de `mq1`.
La lumière n'était pas bloquée par un bug : elle était **immobile par construction**
(2 min de vidéo étalées sur un survol de 15 s).

### Ce qui a été vérifié et qu'il ne faut pas re-tester
- `currentTime` **et** `duration` arrivent en continu et correctement (~3 msg/s).
  Ils n'ont jamais été en cause. La duration n'est plus lue du tout.
- Il n'existe que **trois** images : `mq4` → 404, `i.ytimg.com/sb/…` → 403 sans le
  jeton du lecteur. On ne peut pas densifier l'échantillonnage.
- `listening` renvoyé à un lecteur déjà initialisé répond `alreadyInitialized`,
  **pas** un nouvel `initialDelivery` — inutile pour re-demander une info.

### Le correctif
Le balayage prend sa propre horloge : triangle de 9 s aller / 9 s retour sur les
trois images (`GLOW_SWEEP_S`), tant que la vidéo avance. On perd la prétention que
la lumière se tient là où se tient la tête de lecture (intenable à cette échelle) ;
on garde que chaque couleur vient vraiment du trailer et que la lumière ne s'arrête
jamais. Côté `TrailerAmbient`, l'espacement 1/6-3/6-5/6 devient uniforme : ce n'est
plus une position vidéo qui arrive mais une position dans la séquence.

Corrigé au passage : `onPlaying(true)` n'était dit qu'une fois (depuis `reveal`)
alors que `false` partait à chaque PAUSED rapporté — un hoquet de buffer démontait
la boucle de fondu **définitivement**.

### Outillage / pièges de mesure
- `puppeteer-core` + Chrome installé (hors repo, dans le scratchpad) : le local
  n'a pas toutes les env → **sonder dev.aniscroll.com**, pas localhost.
- Les canvases du glow sont **taintés** (la bannière AniList est dessinée sans
  `crossOrigin`) → `getImageData` refusé. Contournement de sonde : patcher
  `window.Image` pour forcer `crossOrigin="anonymous"` (le CDN AniList envoie les
  en-têtes CORS). Sans ça on mesure le fond de page, pas la lumière.
- Mesurer une bande **à côté** de la carte ne mesure pas le glow : le carrousel
  d'accueil défile derrière et fabrique de fausses variations toutes les ~6 s.

### Suite (même jour) — la lumière n'avait pas à être calculée

Piste donnée par Luc : Hayase utilise les embeds YouTube ET a des ambient lights.
Vérifié dans `hayase-app/interface`, `src/lib/components/ui/cards/YoutubeIframe.svelte` :
ils montent **une seconde iframe** derrière la carte avec `blur-2xl saturate-200 -z-10`.

**Le renversement** : on ne peut pas *lire* les pixels d'un embed cross-origin —
vrai, et sans issue. Mais une copie floutée de la vidéo **EST** la lumière. Aucun
pixel n'est lu, donc la règle cross-origin n'a rien à dire. Tout le travail
précédent (3 images, balayage, courbe de couleurs envisagée) partait du postulat
implicite que la lumière devait être CALCULÉE à partir de la vidéo.

Implémenté dans `TrailerStage` : second iframe, commandes de transport mirroitées
(`MIRRORED`), jamais le son (elle naît muette), dessinée 22 % plus grande et
découpée comme l'ancienne couche canvas. Coupée sous **Data Saver** (second
décodeur + second flux) — la carte y garde le glow storyboard.

Restant assumé : deux lecteurs = deux horloges, dérive d'une fraction de seconde,
invisible à 34 px de flou. Le balayage storyboard reste comme repli, pas comme
chemin principal.

### Suite — la copie prenait de l'avance au changement de carte

Symptôme : sur une même image, le halo ne correspond pas ; « il y a un retard ».

Mesuré en abonnant **séparément** les deux lecteurs (`listening` envoyé aussi à la
copie, messages triés par `e.source`) :

| | dérive |
|---|---|
| 1ʳᵉ carte, lecture continue | ±0,08 s, indéfiniment |
| après un changement de carte | **−0,35 à −0,67 s**, définitif (copie en avance) |

Cause : `reveal()` rembobine le lecteur visible à zéro ; la copie est encore en
train de charger la nouvelle vidéo à cet instant et **laisse tomber le seek** (le
lecteur ignore ce qu'on adresse à une vidéo non finie de charger). Elle reste en
avance d'exactement ce que l'autre a rembobiné.

Correctif : on ne fait plus confiance à une commande unique. Le ticker compare
deux positions **extrapolées de la même façon** (comparer des instants d'arrivée
de messages ferait passer la gigue pour une dérive) ; au-delà de 0,3 s, un seek
remet la copie en place, au plus une fois toutes les 2,5 s — chaque correction
assombrit brièvement le halo le temps du rebuffer. Après : −0,31 → 0,00 en 1 s,
puis ±0,05.

**Sous-titres** : `unloadModule` n'était envoyé qu'au `onLoad` de l'iframe. Chaque
`loadVideoById` reconstruit un module de sous-titres → ils revenaient sur tous les
trailers sauf celui du boot. Redonné à chaque dévoilement, deux graphies, deux
formes (`unloadModule` + `setOption(track,{})`), mirroité vers la copie.

**Piège de mesure (2ᵉ fois)** : échantillonner une bande *à côté* de la carte ne
mesure pas le halo — le carrousel d'accueil défile derrière à peu près au rythme
des cartons de crédits d'un trailer. Lire les deux régions dans **une seule et
même capture**, et corréler, est la seule méthode qui tienne. Sondes : `--mute-audio`.

### Suite — le chrome de YouTube s'allumait DANS la lumière

Le décalage persistait après la resynchro des horloges. Il n'était pas temporel :
mesuré à ~130 ms de résolution, l'image et le halo changent **au même échantillon**
(dV 20,9 / dH 20,0 sur la même frame). C'est le *contenu* de la copie qui était faux.

Photographié à la sonde : la copie floutée peignait **la barre de progression et
le titre** (« Saga of… », lisibles). Elle était montée à ×1, sans la réduction ×200
du lecteur visible — au motif, écrit dans le code, que « le flou cache le chrome
mieux que n'importe quelle réduction ». Faux : un flou de 34 px cache la FORME du
chrome, pas sa **lumière**. La barre de progression est un trait blanc de 530 px ;
floutée, c'est une bande claire en travers du halo. Et ce chrome apparaît/disparaît
sur l'horloge du lecteur → **le halo changeait d'un coup alors que l'image ne
bougeait pas**, ce qui était le tout premier symptôme rapporté (« deux images
identiques, deux ambient lights différentes »).

Correctif : la copie est montée ×200 et rapetissée comme l'autre. Le chrome est
dimensionné en pixels, il ne survit pas à la réduction ; la vidéo remplit toujours
le cadre.

**Leçon de méthode** : trois symptômes différents (« figée », « en retard », « change
d'un coup ») avaient la même cause matérielle visible sur UNE capture de la couche
elle-même. J'ai mesuré des séries statistiques avant d'avoir simplement REGARDÉ ce
que peignait le calque incriminé.

### Suite — les 50 ms restantes, et le piège de capture qui les cachait

**Piège de méthode, majeur** : `page.screenshot({clip})` ne compose PAS le filtre CSS
sur une iframe cross-origin — il rend le lecteur **brut, non flouté**. Toutes les
mesures de halo prises avec un `clip` portaient donc sur la vidéo elle-même et
concluaient docilement « aucun décalage ». Ça explique aussi pourquoi `brightness(1.7)`
ne changeait aucun chiffre. **Seule la capture pleine page rend le filtre.**

Mesure refaite en pleine page (170 captures, ~20 fps, corrélation croisée) :

| avance donnée | pic de corrélation |
|---|---|
| aucune | **+1 échantillon** (halo en retard ~50 ms) |
| 50 ms | −1 échantillon (halo en avance) |
| 25 ms | −1 échantillon (inchangé) |

Le pic est net (0,0068 contre 0,0009 autour). L'origine n'est pas les horloges
(±0,05 s) mais le pipeline de la copie : ses images passent par un flou avant
l'écran, ce que la copie visible ne paie pas.

Retenu : `GLOW_LEAD_S = 25 ms`, posé au dévoilement (pendant le fondu, où le
rebuffer ne se voit pas) et tenu par le correcteur, qui vise cet écart au lieu de
zéro. **On ne peut pas affirmer mieux que |décalage| ≤ 50 ms** : le pas de mesure
vaut 50 ms et une image de la vidéo dure 33 à 42 ms. Descendre plus bas serait
ajuster du bruit.

## 2026-08-13 (fin) — Copier la requête de référence valait tous les réglages

Après une soirée à régler le disjoncteur au gramme près (43 %, 72 %, 79 %), le
gain décisif est venu d'ailleurs : **aligner la requête sur celle de yt-dlp**
(`generate_api_headers` dans `yt_dlp/extractor/youtube/_base.py`).

Nous envoyions quatre en-têtes. La référence en envoie plus :

- `Origin` et `X-Origin` — nous n'en envoyions aucun ;
- `X-Goog-Visitor-Id` : l'identité voyage AUSSI en en-tête, pas seulement dans
  le corps ;
- `context.client` : `userAgent`, `timeZone`, `utcOffsetMinutes`, que nous
  laissions vides.

**Mesure sur 25 titres froids : 1re passe 12/25 → 17/25, total 19 → 24/25.**

### Leçon

Une requête incomplète est une requête atypique, et l'atypique est ce qui se
fait rationner. J'ai passé la soirée à optimiser *quand* réessayer au lieu de
regarder *à quoi ressemble* ce qu'on envoie. Avant de régler une politique de
reprise, comparer sa requête à celle d'une implémentation de référence.

## 2026-08-13 (nuit) — Le 403 n'était pas un token, c'était du rationnement

Sonde temporaire posée DANS le worker (`/w/trailer-diag`, retirée depuis) pour
trancher une question que je traitais par déduction : quand googlevideo répond
403, est-ce le PO token ou l'adresse ?

Réponse : **ni l'un ni l'autre**. La même vidéo, demandée six fois de suite :

| Passe | Résultat |
| --- | --- |
| 1 (isolate frais) | **200 partout**, tous clients, avec et sans identité |
| 2 | timeouts |
| 3 | premiers 403 sur le média |
| 4 | `http 403` **sur l'appel InnerTube lui-même** |
| 6 | 403 partout |

Même vidéo, même client, même identité — **seul le volume change**. Le 403 média
n'est donc pas une exigence de token, c'est le rationnement qui frappe à une
autre porte. La sonde a aussi montré que le `ip=` du lien change d'une
sous-requête à l'autre (`162.159.122.192` puis `.193`) **sans empêcher le
téléchargement** : l'instabilité d'egress de Cloudflare n'est pas le problème
non plus.

### Décision

- **Le disjoncteur compte désormais TOUT le rationnement** (`noteRationed`) :
  refus bot, 403/429 sur InnerTube, 403 sur le lien média, et les timeouts. Il ne
  regardait qu'une seule porte et restait fermé pendant qu'on continuait à
  frapper.

### Leçons / pièges

- **J'ai attribué ces 403 au PO token GVS sur la foi du PO Token Guide, sans
  mesurer.** C'était faux, et deux entrées de ce DEVLOG le disent encore. Un
  token n'aurait rien changé : le même appel réussit sur un isolate frais.
- **La bonne sonde est celle qui tourne à l'endroit où le problème se produit.**
  Toutes mes mesures depuis la connexion résidentielle étaient justes et
  inutiles : elles ne pouvaient pas voir un effet de volume propre à l'edge.
- **Corollaire pour la suite : le seul levier réel est de moins demander.** Ni
  client, ni token, ni identité ne relèvent une limite de débit. C'est ce qui
  justifie le stockage persistant — rendre chaque succès définitif.

## 2026-08-13 (soir) — Trailers : l'identité de session, et pourquoi elle ne doit servir qu'en secours

`visitorData` était le §8 jamais livré du plan. C'est le correctif le plus
rentable du fichier — et il a fallu trois essais pour le poser au bon endroit.

### Ce que ça change

Mesuré sur les trois ids qui avaient résisté à tout (`1hYWc5MCIPk`,
`5JpTU6wj_-g`, `KYGgyQtSAdI`) : `ANDROID_VR` répond `LOGIN_REQUIRED` aux trois
depuis une connexion **résidentielle**, et `OK` + itag 18 aux trois dès que la
même requête porte un `visitorData`. **3 sur 3.** Le blocage bot n'était donc
pas d'abord une affaire d'adresse : un appel sans session est un appel anonyme,
et c'est l'anonyme que YouTube refuse.

Ce n'est **pas** un PO token : c'est une chaîne opaque prise sur youtube.com,
sans BotGuard ni DroidGuard, rien à forger.

### Les deux pièges, dans l'ordre où je suis tombé dedans

1. **Ne PAS partager l'identité entre colos.** Première version : cachée en KV
   pour qu'un isolate froid en hérite. Résultat mesuré : `LOGIN_REQUIRED`
   disparaît de tous les diags — exactement l'effet voulu — et est remplacé par
   `upstream 403 on the link`, `ANDROID_VR` se faisant refuser des liens qu'il
   encaissait avant. Une identité n'est crédible que là où elle vit : via KV,
   une seule session émettait depuis des centaines d'adresses, ce qui est le
   profil d'une session volée. La doc Invidious dit la même chose — le token
   doit être généré depuis l'IP qui l'utilise. **Portée module, jamais partagée.**
2. **Anonyme d'abord, identité en ESCALADE.** Les deux modes échouent de façon
   **disjointe**, mesuré sur 25 ids froids chacun : l'anonyme se fait bloquer à
   la résolution mais ses liens s'encaissent ; avec identité, `LOGIN_REQUIRED`
   tombe à **0/25** mais googlevideo refuse les liens (un Worker ne tient pas une
   même adresse sur deux sous-requêtes). Toujours envoyer l'identité échangeait
   donc un problème contre un autre. On demande anonymement, et on n'escalade
   que sur un refus bot — là où il n'y avait de toute façon aucune réponse.

### Résultat

**19/23 servis (83 %)** hors géoblocages légitimes, contre **7/14 (50 %)** avant
le chantier du jour.

### Leçons / pièges

- **Le seuil du disjoncteur est couplé au nombre de tentatives par vidéo.**
  L'escalade porte une vidéo froide à 4 refus possibles (2 clients × anonyme puis
  identité) ; avec un seuil à 3, le disjoncteur se déclenchait sur **un seul**
  échec et muselait le réchauffage pendant une minute — il tirait précisément sur
  ce qui devait rattraper l'échec. Passé à 6. Attrapé par le banc, pas en prod.
- **Ce qui reste** est exclusivement le refus de LIEN (`upstream 403`, le token
  GVS) et des timeouts. C'est le seul endroit où un PO token servirait, et il
  reste hors d'atteinte (DroidGuard, plus une IP stable qu'un Worker n'a pas).

## 2026-08-13 — Trailers : c'est notre propre machinerie de reprise qui nourrissait le blocage

Symptôme rapporté : **le taux de refus est faible en début de session et monte à
mesure qu'on survole des animes**. Ce n'est donc ni une vague aléatoire ni une
question d'adresse seule — c'est un compteur, et c'est nous qui le remplissions.

Coût d'UN trailer froid et refusé, avant ce chantier : 2 manches × 2 clients (4
appels InnerTube) + réchauffage 3 paliers × 2 clients (6) + les 3 reprises du
front retombant chacune sur une clé froide (12) + le verdict demandé à la 2ᵉ
erreur (2) = **~24 appels**. Chaque étage multipliait le précédent, au moment
précis où YouTube nous rationnait. La reprise creusait le refus qu'elle
essayait d'attendre.

### Mesures (connexion résidentielle, InnerTube en direct)

```
dQw4w9WgXcQ   ANDROID -> OK itag18   ANDROID_VR -> OK itag18
6vMuWuWlW4I   ANDROID -> OK itag18   ANDROID_VR -> LOGIN_REQUIRED
                                     "Sign in to confirm you're not a bot"
téléchargement itag18, sans aucun PO token : 206 pour les deux clients
WEB -> UNPLAYABLE   WEB_EMBEDDED_PLAYER -> ERROR   TVHTML5 -> LOGIN_REQUIRED
```

- **La conclusion du 11/08 (« le blocage vise l'adresse et la MINUTE, pas le
  client ») est FALSIFIÉE.** `ANDROID_VR` refusé et `ANDROID` servi sur la même
  vidéo, la même IP résidentielle, la même seconde. Le refus est aussi par
  client et par vidéo. La mesure du 11/08 passait par un cache froid, où les
  deux effets sont indiscernables. **Conséquence : les deux clients doivent
  rester** — n'en garder qu'un aurait purement supprimé les trailers que son
  jumeau se fait refuser.

### La question PO token, close (ne pas la rouvrir)

- Le PO token **GVS** (celui du téléchargement) : **inutile ici**, rien ne 403,
  les deux clients servent leurs octets sans token.
- Le PO token **Player** (le seul qui pourrait lever le `LOGIN_REQUIRED`) :
  **hors d'atteinte**. Il est spécifique à la plateforme — BotGuard pour `web`,
  **DroidGuard** pour `android`/`android_vr`, ce qui suppose l'attestation
  Android réelle (émulateur), impossible depuis un Worker. Et la famille `web`,
  seule à portée de BotGuard, répond `UNPLAYABLE`/`ERROR` **même depuis une
  connexion résidentielle**.
- **yt-dlp** ne change rien : c'est du Python, ça ne tourne pas dans un Worker,
  et il émet exactement les mêmes appels InnerTube. Utile comme oracle, pas
  comme runtime.
- **`web_safari` + HLS** : le refus tombe dans `playabilityStatus`, donc *avant*
  les formats — l'exemption HLS ne s'y applique pas. Et HLS = N segments
  IP-bound sans CORS à faire transiter, alors que **la requête est la seule
  unité facturée** : on échangerait un fichier de 3 Mo caché une fois contre des
  centaines de requêtes par lecture.

### Décisions

- **La course à deux clients devient une SÉQUENCE**, ANDROID d'abord. 1 appel
  dans le cas courant au lieu de 2, 2 seulement en cas de refus : même
  couverture, moitié moins de carburant. Le repli séquentiel *est* la
  confirmation par le second client, donc l'invariant du 11/08 (« un refus
  durable n'est cru que s'il est unanime ») tient gratuitement.
- **Une seule manche en avant-plan.** Deux tentatives dans la même seconde
  échantillonnent le même instant — ce fichier le disait déjà de `warmLater`.
  Seul le `403` upstream garde sa reprise (lien expiré ou minté depuis une autre
  adresse : seul un lien frais corrige ça).
- **Cache négatif de 6 s sur le 404** (`unresolved()`), déposé explicitement dans
  `caches.default` — la réponse d'un Worker n'y va pas toute seule. Le 6 est
  calé entre `RETRY_DELAYS_MS = [500, 2500, 7000]` et `WARM_SCHEDULE_MS[0] =
  4000` : les deux premières reprises du front deviennent des hits gratuits, la
  troisième tombe après le premier palier de réchauffage et voit les octets.
- **Disjoncteur par isolate** : au-delà de 3 refus bot, plus AUCUN appel pendant
  60 s. Sous rationnement, le worker arrête de cogner au lieu de cogner plus
  fort.
- **Déduplication en vol** (`inFlight`) : reprises du front, survols concurrents,
  verdict et réchauffage partagent une seule résolution par id.
- **Le verdict `.json` ne résout plus jamais.** `Overview.tsx` et
  `InfoPageMobile.tsx` l'appellent à chaque visite de page info ; une page vue ne
  doit pas pouvoir dépenser un appel InnerTube. Il lit le cache, sinon répond
  `unknown` + réchauffage. Le front ne mémorise jamais `unknown`, donc rien de
  valide n'est caché.
- **`EDGE_TTL` : 1 jour → 30 jours.** Le contenu d'un trailer ne change pas ; le
  jour était un alignement sur le proxy principal, pas une contrainte. Reste du
  cache (éviction LRU), pas du stockage — R2 a été écarté explicitement.

### Correctif du même jour : l'ordre des clients, et le 403 GVS

Le premier déploiement a fait apparaître un refus **différent**, invisible depuis
la maison : `Unresolvable: upstream 403 | upstream 403`. La résolution
réussissait, c'est le **lien** qui était refusé — le PO token **GVS**, que la
guide attribue à `ANDROID` et pas à `ANDROID_VR`. L'application suit
manifestement la réputation de l'appelant : elle mord un egress datacentre et
pas une connexion résidentielle. **Mesurer depuis chez soi a donc donné le
mauvais ordre de clients.**

Deux corrections :

- **`ANDROID_VR` passe en tête** — le client dont les liens sont redeemables
  depuis l'edge. `ANDROID` devient le repli pour les vidéos que VR refuse.
- **Un 403 bascule sur le client SUIVANT** au lieu de re-résoudre le même
  (`fetchTrailer` résout et redeem dans la même boucle). L'ancienne boucle
  rejouait exactement le même échec : c'est ce que disait le `403 | 403`.

### Troisième temps : « aucun lien encaissable » n'est pas une vague

Restaient deux ids qui échouaient à chaque survol (`KYGgyQtSAdI`,
`5JpTU6wj_-g`). Matrice complète des clients, mesurée depuis la connexion
résidentielle :

| Client | Réponse |
| --- | --- |
| `ANDROID_VR`, `TVHTML5`, `ANDROID_UNPLUGGED` | `LOGIN_REQUIRED` **même depuis chez soi** |
| `TVHTML5_SIMPLY_EMBEDDED`, `WEB_EMBEDDED_PLAYER` | `ERROR` |
| `IOS` | `OK` mais **aucun format progressif** |
| `ANDROID` | `OK` + itag 18, dont le lien est refusé depuis l'edge |

Donc pour ces vidéos, **aucun client ne donne un itag 18 encaissable depuis un
datacentre**. C'est un état **stable**, pas une vague : le réchauffage n'y peut
rien, et le traiter comme un échec passager coûtait 3 reprises + une échelle de
réchauffage à chaque survol, indéfiniment.

- Nouveau cas `unredeemable` : un client a bien donné un lien et le lien a été
  refusé → 404 mémorisé **10 min** (`UNREDEEMABLE_TTL`), réchauffage **conservé**.
  Distinct du 404 de 6 s, qui reste pour les vraies vagues.
- **Correction dans la foulée, et c'est la leçon du jour.** La première version
  lisait ce tableau comme une preuve de permanence : 6 h de mémorisation et
  réchauffage coupé. Puis **les deux ids se sont mis à marcher tout seuls** —
  donc la même signature est AUSSI transitoire. On ne peut pas distinguer les
  deux sur une tentative : la lecture honnête est « peu susceptible de se
  résoudre dans la minute », pas « jamais ». D'où 10 min, et le réchauffage
  gardé — c'est précisément lui qui les a rattrapés.
- C'est **le seul cas où un PO token GVS serait la réponse**, et il reste hors
  d'atteinte (DroidGuard). Le noter plutôt que le combattre.

Attention au piège rencontré en l'écrivant : `UNREDEEMABLE_TTL = GONE_TTL`
plantait au chargement du module (TDZ, `GONE_TTL` est déclaré plus bas). La
valeur est écrite en clair.

### Leçons / pièges

- **Un refus de RÉSOLUTION et un refus de LIEN ne se soignent pas pareil**, et
  le diag doit les distinguer : `LOGIN_REQUIRED` = le client n'a rien obtenu ;
  `upstream 403` = il a obtenu un lien qu'on ne peut pas encaisser. Tant que le
  diag disait `upstream 403 | upstream 403` sans nommer le client, le bug était
  invisible.
- **Ce qui se mesure depuis une connexion résidentielle ne vaut pas pour
  l'edge.** Les deux clients servaient leurs octets en 206 depuis la maison ;
  depuis Cloudflare, seul VR y arrive. Toute mesure de réputation doit être
  refaite depuis l'egress réel.
- **Sous rate-limit, insister est la seule chose à ne pas faire.** Tout le
  chantier consiste à retirer des tentatives, pas à en ajouter. Le plan initial
  proposait l'inverse et il a fallu la mesure pour le corriger.
- **Le 404 court est posé sous la clé des OCTETS**, donc le garde-fou de
  `warmLater` (« quelqu'un a déjà gagné ») devait passer de `if (cached)` à
  `if (cached?.ok)` — sans quoi le réchauffage s'annulait exactement dans le cas
  où il servait à quelque chose. Attrapé au banc, pas en prod.
- **Un commentaire est un journal de mesures : il périme.** Le bloc `CLIENTS`
  justifiait `android_vr` par une exemption de PO token que la mesure ne montre
  plus, et concluait sur une course que les chiffres condamnaient déjà. Les deux
  ont été réécrits plutôt que contournés.
- **Banc local possible pour la LOGIQUE** (`fetch` et `caches.default`
  bouchonnés, réimport du module par scénario pour repartir d'un isolate neuf) :
  9 scénarios couvrent séquence, unanimité, disjoncteur, dédup, cache négatif et
  rendez-vous du réchauffage. Le chemin de cache réel, lui, ne se valide toujours
  qu'en prod (`caches.default` est inerte hors domaine personnalisé).

## 2026-08-11 — Trailers : le refus de YouTube ne se combat pas dans la requête

Les cartes de survol pleuvaient en `404` sur `/w/trailer/<id>.mp4`. Le corps de
la réponse disait déjà tout : `Unresolvable: LOGIN_REQUIRED: Sign in to confirm
you're not a bot`, quatre fois — YouTube refusant l'egress datacentre de
Cloudflare, pas la vidéo. Le même payload ANDROID depuis une connexion
résidentielle résolvait les mêmes ids instantanément.

### Décisions
- **Deuxième client InnerTube (ANDROID_VR), gardé comme assurance et pas comme
  correctif.** Le PO Token Guide de yt-dlp classe désormais `android` parmi les
  clients exigeant un GVS PO token et `android_vr` parmi ceux qui n'en
  demandent aucun ; le seul format que VR sert encore sans token est l'itag 18,
  c'est-à-dire exactement et uniquement celui dont ce worker a besoin. Coût
  nul : la course tirait déjà deux appels.
- **Réchauffage hors bande (`warmLater`)**, la vraie correction : après avoir
  répondu 404, le worker attend 4 s dans un `ctx.waitUntil`, retente la
  résolution et **pose les octets dans le cache**. La carte qui a échoué est
  prête au survol suivant, pour tout le colo, pendant 24 h.
- **Un refus « durable » n'est plus cru que s'il est UNANIME.** Avec deux
  clients différents dans la course, un `UNPLAYABLE` isolé à côté d'un blocage
  bot ne prouve rien sur la vidéo, et le croire cacherait un bon trailer six
  heures. Un 410 mérité (supprimé, géobloqué) est dit par tous les clients.

### Leçons / pièges
- ~~**Le blocage vise l'adresse et la MINUTE, pas le client.**~~ **FALSIFIÉ le
  13/08** — voir l'entrée de cette date : `ANDROID_VR` refusé et `ANDROID` servi
  sur la même vidéo, même IP, même seconde. Le refus est AUSSI par client et par
  vidéo ; cette mesure-ci passait par un cache froid, où les deux effets sont
  indiscernables. Le paragraphe est conservé pour l'historique. Mesuré depuis
  l'edge sur 16 ids froids : deux clients + trois manches = 9 échecs, un client
  + deux manches = 8 — et **les mêmes ids** échouaient dans les deux passes. La
  troisième manche a donc été retirée : ajouter des tentatives dans la même
  seconde, c'est échantillonner deux fois le même instant.
- **Ce qui marche, c'est d'attendre — mais hors de la requête.** Trois passes
  successives en prod : `404 404 404 404`, puis `404 206 206 206`, puis tout en
  cache. La vague dure des secondes. Mesuré après déploiement : sur 7 échecs à
  froid, 4 revenaient **`X-Aniscroll-Cache: HIT` en ~55 ms** quinze secondes
  plus tard, un 5ᵉ se résolvait de lui-même.
- **`wrangler dev --remote` a refusé la session** (KV sans `preview_id`, puis
  « Could not create remote preview session ») ; le banc utile a été un worker
  jetable sur `workers.dev` — en sachant que `caches.default` y est inerte,
  donc que seul le prod peut valider le chemin de cache.
- **Le front n'a pas été touché** : ses reprises sont à 500 ms et 2500 ms, donc
  elles passent AVANT que le réchauffage n'ait posé les octets. Le gain se
  matérialise au survol suivant. Un essai supplémentaire vers 7 s le capterait
  dans le même survol — à décider.

## 2026-08-09 (soir 2) — Le halo « tout autour » n'était pas le halo

Luc signalait encore une lumière sur les quatre côtés de la carte alors que le
calque d'ambiance est découpé sur la zone vidéo depuis deux commits. Ce n'était
pas lui : c'était une **seconde ombre portée**, dans la couleur dominante de
l'anime, que j'avais ajoutée au `box-shadow` de la carte. Un `box-shadow`
enveloppe les quatre côtés par construction — il éclairait donc le synopsis par
en dessous autant que la vidéo par derrière, c'est-à-dire précisément l'effet que
le `clip-path` du vrai halo sert à empêcher. Supprimée. **Une seule source de
lumière par carte**, sinon on débogue la mauvaise.

**Les deux boutons superposés : une garantie plutôt qu'un diagnostic.** Aucun
paramètre d'embed ne retire le gros bouton central de YouTube, et notre parade
(iframe invisible dès que la vidéo n'est pas en lecture) ne vaut que si notre
état de lecture est juste. Il pouvait rester périmé indéfiniment : on coupait le
ping `listening` au premier message reçu, donc une transition manquée ne se
rattrapait jamais. Le ping devient un **battement lent (1,5 s)** qui ne s'arrête
plus, et `initialDelivery` — la réponse complète à ce ping — est désormais lu
comme le flux courant. Notre état ne peut plus être faux plus de 1,5 s.

Icônes sans fond, en `--text-body`, `--brand-primary` à l'état actif, et une
`drop-shadow` à la place de la plaque sur la vidéo : une plaque sombre derrière
un glyphe ressemble à un bouton, et c'est cette ressemblance qui faisait lire
« deux boutons » quand celui de YouTube apparaissait dessous.

---


## 2026-08-09 (soir) — Deux frames YouTube, un seul état : le bug du bouton fantôme

**Le vrai suspect du « bouton qui n'est pas le nôtre ».** Depuis qu'il y a une
seconde iframe (le halo animé), **deux lecteurs postent depuis
`www.youtube-nocookie.com`** et notre `window.addEventListener("message")` ne
filtrait que sur l'origine. Un `infoDelivery` venu de la copie décorative
pilotait donc la machine à états du vrai lecteur — de quoi laisser `playing` à
`true` alors que YouTube a mis sa vidéo en pause et dessine son gros bouton
central. Filtre ajouté sur `e.source`.

**À retenir : `e.origin` n'identifie pas un émetteur dès qu'il y a deux frames
du même site.** Le bug n'existait pas hier ; il est né de l'ajout du halo, sans
que rien dans le code du halo ne le laisse deviner.

Aucun paramètre d'embed ne supprime ce bouton (`controls=0` ne couvre pas
l'overlay de pause), donc la parade structurelle reste : iframe invisible dès
que la vidéo n'est pas en lecture, artwork dessous.

**Deux demandes qui reviennent en arrière**, notées pour éviter le ping-pong :
- la carte **suit à nouveau le scroll** (elle doit se déplacer comme le reste de
  la page ; hier on l'avait fixée au viewport) ;
- **plus de recadrage viewport** : une vignette à moitié hors écran donne un
  aperçu à moitié hors écran, comme chez Hayase. La carte est ancrée à sa
  vignette, la ramener dans l'écran la ferait désigner une voisine.

**Halo sur trois bords.** `clip-path: inset(-400px -400px 0 -400px)` sur une
boîte calée sur la vidéo : le flou court librement à gauche, à droite et en haut,
et se coupe net au bas de l'image.

**Style.** Boutons repris de `hStyles` dans Hero : dégradé de marque + lueur pour
le CTA, `rgba(255,255,255,.04)` sur un liseré `#2f3447` en rayon 11 pour les
secondaires, cœur au tracé identique à celui de la fiche, icône de file d'attente
identique à `QueueButton`. Piège au passage : un `background` **inline** bat
toujours une règle `:hover` de feuille de style — la forme est donc dans
`globals.css`, seule la couleur d'état reste inline. `--line-2` n'est pas
utilisable ici, il est déclaré dans le module CSS de la fiche et l'aperçu est
portalé dans `<body>`.

---


## 2026-08-09 — Le bouton de YouTube qu'on ne peut pas enlever, et le halo en retard

**`controls=0` ne supprime pas le gros bouton central de YouTube.** Il reste un
bouton qui n'est pas le nôtre sur une vidéo en pause, et le nôtre se dessine
par-dessus : deux boutons pause superposés. Aucun paramètre d'embed ne l'enlève
et le contenu est cross-origin, donc on ne peut ni le masquer ni le styler.
Solution : **une bande-annonce en pause n'est plus affichée du tout** — l'iframe
passe à `opacity: 0` et PreviewCard refait apparaître son artwork dessous, avec
notre seul bouton par-dessus. On perd l'image figée, on gagne une surface dont
on contrôle chaque pixel.

**Le halo était en retard parce que je l'avais optimisé.** La copie décorative ne
se montait qu'une fois le vrai lecteur en lecture, pour ne pas disputer la bande
passante au démarrage. Mais **démarrer une seconde copie deux secondes plus tard,
c'est un décalage de deux secondes pour toujours** : les deux instances n'ont
aucun canal de synchronisation. Elles démarrent maintenant ensemble, et la boucle
se fait par remontage sur un compteur partagé (`key={cycle}`) plutôt qu'avec
`loop=1&playlist=`, qui faisait dessiner à YouTube la chrome supplémentaire dont
Hayase se plaint déjà en commentaire.

Le halo est aussi recadré sur les 45 % du haut : étendu à toute la carte il
éclairait le synopsis par derrière, ce qui se lit comme un panneau rétroéclairé
et non comme de la lumière qui sort de l'image.

**La carte ne suit plus le scroll.** Elle suivait son ancre, au motif qu'une
bulle qui désigne une vignette devrait continuer à la désigner. En pratique le
pointeur ne bouge pas pendant qu'on tourne la molette : la carte glissait de
sous le curseur et le texte qu'on lisait partait tout seul. Fixée au viewport,
elle reste là où on regarde.

Aussi : synopsis traduit via `useTranslatedText` (même chemin que la page info) ;
troncature explicite en `-webkit-line-clamp` + `max-height` — sans hauteur
imposée le texte était coupé au ciseau par l'`overflow: hidden` de la carte et
**aucun « … » n'était jamais dessiné**, l'ellipse n'apparaît que si c'est le clamp
qui tronque ; icônes passées à `react-icons/md` comme le reste de l'app ; et le
recadrage viewport tient compte du débord du halo, sinon la lumière se fait
trancher par le bord de l'écran.

---


## 2026-08-09 — Le halo qui ne changeait pas de couleur, et le volume partagé

**Un `filter` + `translateZ(0)` au-dessus d'une iframe cross-origin fige le
rendu.** Le halo animé était bien une seconde iframe qui jouait la vidéo, mais sa
couleur ne bougeait pas. `.as-preview-ambient` portait `transform: translateZ(0)`
(posé pour forcer une couche et rendre le flou moins coûteux) : le compositeur
garde alors un raster du sous-arbre flouté, et **le contenu d'une iframe
cross-origin qui change derrière ce filtre n'invalide pas ce cache de façon
fiable**. Retiré.

Le flou est passé sur l'élément lui-même, comme chez Hayase, et l'ordre compte :
`overflow-hidden` clippe d'abord la vidéo à la boîte, puis `filter` floute le
résultat — c'est **le flou qui fait déborder la lumière hors de la boîte**. C'est
aussi pour ça qu'il était « à peine visible » : le débord était de 9 % (33 px)
pour un flou de 38 px, donc l'essentiel du halo tombait derrière la carte opaque.
Passé à 60 px fixes, opacité 0.85, et l'ombre portée noire de la carte réduite —
elle atterrissait exactement là où la lumière essayait de se poser et l'annulait.

**Le volume est celui de l'app.** `lib/prefs/playerVolume.ts` sort les clés que
`UniversalPlayer` persistait déjà (`aniscroll:volume`, `aniscroll:muted`) ; la
bande-annonce lit et écrit les mêmes. Un niveau réglé sur un aperçu est celui du
prochain épisode. Seule réserve, notée dans le module : quand rien n'a jamais été
enregistré, l'aperçu démarre à 40 % (le défaut du lecteur est 1, inacceptable pour
un son déclenché par un survol) **sans écrire cette valeur** — le partage commence
au premier réglage délibéré.

> **Annulé le 09/08/2026.** Le module est devenu `lib/prefs/previewVolume.ts` et
> l'aperçu a ses propres clés (`aniscroll:preview:volume` / `:muted`). Le
> raisonnement « le volume est une propriété de la personne, pas de la surface »
> ne tient pas à l'usage : on coupe le son du survol *parce qu'*on n'a rien
> demandé, et couper ce bruit-là coupait aussi l'épisode suivant. Le lecteur n'a
> pas bougé, il lit toujours ses clés en direct.

Aussi : commandes sans `backdrop-blur` (demande de Luc), synopsis cliquable vers
la fiche, et une garde de 350 ms après ouverture en plus du seuil de 8 px avant
que les commandes ne puissent apparaître.

---


## 2026-08-09 — Le bouton pause qui s'affichait tout seul, et la lumière qui suit la vidéo

**Le pointeur n'avait pas bougé — c'est la carte qui est venue à lui.** Les
commandes devaient n'apparaître qu'au mouvement du curseur sur la vidéo ; le
bouton pause se montrait dès le démarrage. Cause : la carte s'ouvre **sous** le
pointeur, donc le navigateur émet aussitôt un `pointermove` contre elle alors que
la main n'a pas bougé d'un pixel. Le premier mouvement ne fait plus qu'enregistrer
une origine, et rien ne s'affiche tant que le pointeur n'a pas parcouru 6 px.
**Un `pointermove` ne prouve pas que le pointeur a bougé** dès qu'un élément peut
apparaître sous lui.

Au passage, la règle `|| !playing` qui gardait la pause visible sur vidéo en pause
est supprimée : deux commandes du même bandeau qui apparaissent à des conditions
différentes se lisent comme un bug. Bouger le curseur les ramène — c'est le geste
qui a mis la vidéo en pause au départ.

**La lumière d'ambiance ne pouvait pas suivre la vidéo sans une seconde iframe.**
Un embed YouTube est cross-origin : aucun accès aux pixels, ni canvas ni rien. Un
halo qui suit le trailer ne se *calcule* donc pas, il se *rejoue* — c'est le
truc de Hayase et il n'y en a pas de moins cher. Décision de Luc après que
j'ai exposé le compromis. Réduit au minimum : la copie ne se monte **qu'une fois
le vrai lecteur en lecture** (elle ne dispute donc jamais la bande passante au
démarrage, seul moment où l'utilisateur attend), muette à vie, sans handshake API,
et bouclée en `loop=1&playlist=` — la chrome supplémentaire que YouTube dessine
alors ne survit pas à un flou de 38 px. L'artwork tient le halo avant, fondu de
700 ms entre les deux étapes.

Piège CSS rencontré : `.as-preview-ambient` fixait `opacity` en CSS simple, donc
**après** `@tailwind utilities` — les classes `opacity-*` de Tailwind ne pouvaient
pas gagner. L'opacité est passée inline.

**Préchargement des cartes visibles** (`lib/preview/viewportPrefetch.ts`). Le noir
au premier instant d'une carte est un téléchargement qui n'a commencé qu'à
l'arrivée du pointeur : rien fait *au survol* ne peut le supprimer, il faut que le
travail ait eu lieu avant. IntersectionObserver + MutationObserver (les carrousels
et les grilles infinies ajoutent des ancres après coup), drain sur
`requestIdleCallback` 3 par 3, sortie immédiate sur Save-Data / 2g. Reste
soutenable parce que l'endpoint est anonyme et caché 24 h au CDN : un id chaud est
un hit CDN, ni invocation ni commande Upstash.

---


## 2026-08-09 — L'aperçu et la page info doivent montrer la MÊME bannière

Luc : « la première bannière affichée est changée en une fraction de seconde ».
Deux causes distinctes derrière un seul symptôme.

**1. Une image provisoire volontairement fausse.** La carte peignait d'abord la
vignette survolée (`poster`) en attendant la réponse de `/api/v2/preview`. C'est
une jaquette **portrait** posée dans un emplacement 16:9 : elle ne pouvait que
sauter au remplacement. Elle est supprimée — un squelette tient l'emplacement, et
la vraie bannière apparaît en fondu **au `onLoad`**, pas au montage (une image à
moitié décodée est un clignotement de plus). L'endpoint étant préchargé 30 ms
avant l'ouverture et mis en cache 24 h au CDN, ce squelette est invisible sur un
id chaud.

**2. Les deux surfaces ne suivaient pas la même règle.** La page info applique
`bannerImage` AniList, remplacée par le backdrop TMDB quand elle est absente ou
mesurée basse résolution. L'aperçu, lui, avait hérité la chaîne de Hayase
(bannière → miniature YouTube du trailer → jaquette). Un titre dont la page info
avait basculé sur TMDB montrait donc **deux images différentes selon l'endroit
où on le regardait**.

La règle est sortie dans `lib/images/heroBanner.ts` (`resolveHeroBanner`) et
appelée par la page info **et** par `/api/v2/preview`. Ce n'est pas de la
factorisation cosmétique : tant que deux surfaces recopient une même règle, elles
divergent au premier changement — c'est exactement le même piège que la chaîne
du titre au `??` sur les deux chemins SSR, corrigée la veille. La miniature
YouTube a disparu de la chaîne : jolie, mais ce n'est pas l'image de la page
dont la carte est l'aperçu.

Coût : un `getTmdbAnimeImages` de plus sur un aperçu froid — une ligne Turso,
sous une réponse déjà cachée 24 h au CDN.

---


## 2026-08-09 — Aperçu au survol : commandes, son, lumière d'ambiance

Sept demandes de Luc sur la carte de survol. Trois points valent d'être notés.

**1. Les boutons n'étaient pas cliquables, et ce n'était pas un problème de
CSS.** Le `pointerdown` en phase de **capture** posé sur `document` par le
provider (pour fermer la carte quand on clique ailleurs) démolissait la carte
*avant* que pause / son / favori ne voient leur propre clic. Le bouton était
parfaitement cliquable ; sa cible disparaissait entre le `pointerdown` et le
`click`. Exemption ajoutée pour tout ce qui est dans `[data-preview-popup]`.
À retenir : **un `close()` global en capture est un piège dès qu'on ajoute un
contrôle interactif dans le contenu qu'il ferme.**

**2. Le son par défaut ne peut pas se demander dans l'URL.** `mute=0` +
`autoplay=1` est refusé par la politique d'autoplay de Chrome : la vidéo ne
démarre tout simplement pas. La seule voie fiable est de **charger toujours
`mute=1`, puis d'appeler `unMute()` une fois l'état `playerState === 1` reçu** —
démarrer un média audible est interdit, dé-muter un média déjà en lecture ne
l'est pas. L'icône se resynchronise ensuite sur `infoDelivery.info.muted`, donc
si un navigateur refuse quand même, l'affichage ne ment pas. Le choix de
l'utilisateur est mémorisé (`aniscroll.preview.muted`).

**3. La lumière d'ambiance ne peut pas être un enfant de la carte.** La carte
`overflow-hidden` (pour ses coins arrondis) et son fond est opaque : n'importe
quel halo posé à l'intérieur est soit rogné, soit masqué. Il est donc sorti dans
un conteneur racine, en `-z-10`, avec un inset négatif. C'est aussi ce qui a
permis de **supprimer la seconde iframe YouTube décorative** de Hayase (elle
servait ce rôle et, chez nous comme chez eux, ne pouvait rien peindre) : deux
fois moins de travail réseau pour le lecteur. Avec en plus un `preconnect` vers
`youtube-nocookie.com` posé au chargement de la page, la poignée de main TLS
sort du chemin critique. Contrepartie assumée : le halo vient de la bannière
fixe, il ne suit pas les couleurs de la vidéo.

Divers : carte agrandie à 364×424 pour couvrir la vignette (une fiche qui
dépasse derrière l'aperçu se lit comme un bug d'affichage) ; commandes masquées
tant que le curseur ne bouge pas sur la vidéo, et maintenues si la vidéo est en
pause — sinon le seul bouton qui permet de repartir devient invisible ; style
repris sur les jetons de l'app (`as-card`, `as-accent`, `rounded-card`,
`font-outfit`).

---


## 2026-08-08 (nuit) — `size-full` n'existe pas en Tailwind 3.3 : la bannière de l'aperçu était vide

Symptôme : la carte de survol s'affichait bien (titre, boutons, méta, résumé)
mais sa moitié haute restait noire — ni bannière, ni bande-annonce.

Cause : en portant Hayase **à l'identique** j'ai recopié ses classes, or Hayase
est en Tailwind 4 et ce projet en **3.3.3**. Le raccourci `size-*` (`size-full`
= `h-full w-full`) n'arrive qu'en **3.4**. Les cinq `size-full` du portage ne
généraient donc *aucun* CSS : les deux `<img>` de bannière perdaient leur
contrainte de taille, et surtout le conteneur `absolute` des deux iframes
YouTube tombait à 0×0 — l'iframe existait, chargeait, mais n'avait pas un pixel
où se peindre.

**Leçon de portage : les classes utilitaires ne se recopient pas telles quelles
d'un projet à l'autre — elles dépendent de la version du générateur.** Une
classe inconnue de Tailwind ne produit ni erreur ni avertissement, elle
disparaît silencieusement ; c'est le mode d'échec le plus discret qui soit, et
il ne se voit ni au `tsc` ni au build. Le contrôle qui tranche en une seconde :
`grep size-full .next/static/css/*.css` → 0 occurrence.

Corrigé partout en `h-full w-full`. Au passage, même défaut préexistant sur
`/en/removed` (`size-24 lg:size-32`). Reste à vérifier un jour : `h-dvh` sur
cette même page est aussi une classe 3.4+.

---


## 2026-08-08 (nuit) — Carte de survol avec bande-annonce, portée de Hayase

Carte flottante au survol d'une fiche anime : bande-annonce YouTube, méta,
Regarder / favori / à-regarder. Portage de `hayase-app/interface`
(`src/lib/components/ui/cards/preview.svelte`, `YoutubeIframe.svelte` et
l'action `hover` de `src/lib/modules/navigate.ts`).

**⚠️ Le dépôt de référence n'est pas celui qu'on croit.** `hayase-app/ui` est en
**takedown DMCA depuis le 22/10/2025** (Crunchyroll) : l'API GitHub le liste
encore, mais tout `git clone` renvoie 403. Le code vit dans
`hayase-app/interface`, qui se clone normalement.

**La poignée de main YouTube est la partie non documentée.** Pour recevoir les
événements du lecteur sans charger le SDK, il faut poster
`{"event":"listening","id":1,"channel":"widget"}` **dans** la frame — et elle
n'écoute pas encore quand `load` se déclenche, d'où l'intervalle de 100 ms qui
réessaie jusqu'au premier message. Ce qu'on en tire : `onReady` → volume à 30,
`initialDelivery` avec `isPlayable: false` → vidéo bloquée, on retire la frame et
on garde la bannière, `infoDelivery` playerState 1 → on révèle enfin l'iframe
(jamais de carré noir pendant le chargement), playerState 0 → boucle **manuelle**
(remontage de l'iframe), parce que `loop=1` exige `playlist=<id>` et que YouTube
affiche alors des boutons en plus.

**L'iframe doit être `pointer-events: none`.** Une frame cross-origin avale les
événements pointeur : sans ça la carte se ferme dès que le curseur entre dans la
vidéo. Le bouton son est donc le nôtre, au-dessus de la frame.

**HOVER_TIME = 30 ms, pas 550.** J'avais d'abord mis un délai long « pour ne pas
déclencher au passage ». Hayase fait l'inverse et c'est meilleur : 30 ms, mais le
minuteur est **réarmé à chaque `pointermove`**. La carte apparaît donc à l'instant
où le curseur *s'arrête*, et jamais pendant qu'il traverse. Le délai ne sert pas
à filtrer le temps, il sert à filtrer le mouvement.

**Deux écarts assumés avec l'original**, imposés par ce dépôt : Hayase rend la
carte comme enfant absolu de la vignette — nos carrousels sont
`overflow-x-scroll` et la découperaient, donc portail vers `<body>` et
positionnement sur le rect de l'ancre (recalé en rAF au scroll, pas fermé) ; et
Hayase attache l'action par carte alors que nous n'avons **aucun composant carte
partagé** (`components/shared/AnimeCard.tsx` existe mais n'est importé nulle
part). D'où un **listener `pointerover` délégué unique** qui cherche l'ancêtre
portant `data-anime-preview` : rendre une vignette survolable = un spread
`{...previewAnchor(id)}`, sans nœud enveloppant ni listener par carte.

**Le cœur a fini par coûter un cache.** `isFavourite` est par-utilisateur, donc
impossible à mettre dans `/api/v2/preview/[id]` (cache edge 24 h, ~1 Ko contre
~40 Ko pour la Media complète) sans le tuer, et impossible à interroger par
survol sans brûler le quota AniList. Solution, la même que `userListCache` :
`lib/anilist/favouritesCache.ts` tire **toute** la liste de favoris une fois par
session (ids seuls) et répond depuis un Set. Le signet, lui, écrit PLANNING dans
la liste locale — c'est exactement ce que fait `authAggregator.entry` chez eux.

**Non couvert volontairement** : les listes denses (my-list, profil, file
d'attente) où le popup recouvrirait les lignes voisines, et la recherche par
image (elle a déjà son propre aperçu vidéo).

---
