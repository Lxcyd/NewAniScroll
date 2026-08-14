# DEVLOG

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

## 2026-08-10 — Graphe de franchise : le reste du chantier

Fin des cinq points laissés ouverts sur `RelationsGraph`, plus un bug de calque.

### Décisions
- **Le graphe passe en portail vers `<body>`.** Rendu en place il s'empilait
  dans la page d'info, donc **sous** la barre de navigation (`fixed`, `z-[9999]`) :
  son propre titre et ses filtres sortaient dessinés à travers le menu. Portail
  + `zIndex: 10000`, comme `OpEdPanel`. Un `position: fixed` ne garantit rien
  tant qu'un ancêtre peut créer un contexte d'empilement.
- **Une requête par VAGUE, pas par nœud** (`/api/v2/relations/batch?ids=`). Le
  parcours demande les relations d'un niveau entier en une rafale synchrone ;
  les demandes sont enregistrées puis vidées sur la microtâche suivante. Sword
  Art Online : 19 allers-retours → 3. L'ordre de visite est inchangé, chaque
  appelant garde sa propre promesse. Les ids sont triés dans l'URL pour que le
  même niveau demandé deux fois soit une seule clé de cache.
- **La mise en forme est partagée** (`lib/anilist/relationsPayload.ts`) entre la
  route unitaire et la route groupée : elles avaient déjà divergé sur
  `coverImage`, et une fiche tirée d'un fetch isolé sortait sans jaquette.
- **« Trame canon » est une accessibilité, pas un test par fiche.** Gun Gale
  Online II est une suite directe : jugée seule elle restait, alors que sa
  propre saison 1 (spin-off) partait. On coupe le fil au spin-off et tout ce qui
  pend derrière s'en va avec.
- **Le survol ne touche pas à la sélection.** Lire le plateau, c'est demander
  « celle-ci tient à quoi ? » d'une dizaine de fiches d'affilée ; le faire au
  clic renumérote l'ordre de visionnage à chaque fois — on perd le fil qu'on
  suit. Le survol éclaire le voisinage, la fenêtre en bas à droite nomme la
  précédente et la suivante.
- **Verticale sous 820 px** : la direction de rang suit le côté long de la
  fenêtre. Les extrémités d'arête doivent suivre la même bascule (bas → haut),
  sinon chaque trait traverse une carte au lieu de la contourner.

### Leçons / pièges
- **Ne pas mettre `query` dans les dépendances de l'effet Échap** : il possède
  aussi le verrou de défilement, et le relancer à chaque frappe lui ferait
  capturer `hidden` comme valeur à restaurer — la page resterait bloquée après
  fermeture. Lecture par `ref`.
- **La barre de recherche vue sur la capture n'était pas celle du graphe** :
  c'était celle du site, visible à travers le bug de superposition. Une
  fonctionnalité « déjà là » peut n'être qu'un calque mal empilé.
- Vignette absente ≠ pas de vignette : la hauteur de carte est réservée par la
  mise en page, donc on dessine un bandeau vide plutôt qu'un trou sous le titre.
- `next build` propre ; aucune version de cache saisons touchée (logique
  inchangée).

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


## 2026-08-08 (nuit) — Titre de la fiche : TMDB passe devant le logo fanart.tv

Ordre demandé par Luc pour le titre du héros de la page info : clearart → TMDB →
logo fanart.tv → texte. TMDB s'insère donc **entre les deux types fanart.tv**, et
non après les deux comme avant.

Le point à retenir : **le départage se fait sur le type d'image, pas sur le
fournisseur**. Le clearart (art de personnage détouré) est ce autour de quoi ce
héros a été dessiné, et c'est le seul type qui alimente le cycle au clic — il
garde donc la première place quoi qu'il arrive. Mais entre deux *logos*, la
bibliothèque TMDB est nettement plus complète : le logo fanart.tv devient ce qui
comble les trous de TMDB, et non l'inverse.

`pickTitleImage(fanarts, tmdbLogo)` porte désormais toute la chaîne au lieu de
la laisser se composer au `??` sur les deux appels SSR, qui pouvaient diverger.

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


## 2026-08-08 (soir) — Sibnet remarche : deux blocages, et une conclusion fausse en route

Suite du diagnostic du lot `top50` ci-dessous. Sibnet ne rendait que 5 cellules
sur 439 alors qu'anime-sama le propose sur 89 % des saisons. Corrige (commit
2c5e027, `lib/extractors.js`) — et **la production n'a jamais ete concernee**.

**⚠️ Ma conclusion intermediaire etait fausse, et Luc l'a corrigee.** J'avais
ecrit que Vercel et Cloudflare etaient bloques comme la ligne de Luc, sur la foi
d'un `{"absent":true}` renvoye par dev pour SnK ep5. C'etait un episode sans
upload sibnet, pas un blocage : l'ep11 rend un flux normal depuis Vercel. La
lecon est petite et couteuse — **ne jamais declarer un hote mort sur un
environnement a partir d'un seul episode**, la ou l'absence est un resultat
attendu la moitie du temps. Seules la ligne residentielle de Luc et Cloudflare
sont filtrees ; un VPN ouest-europeen passe, donc c'est un filtre d'IP/plage
FAI, pas un geo-blocage.

**Blocage 1 — l'endpoint d'embed.** `shell.php?videoid=` repond 403, sur *tous*
les videoid, y compris un identifiant inexistant : c'est l'endpoint qui est
ferme, pas les videos. La page de visionnage `/video<ID>`, elle, repond 200 et
porte le meme `player.src`. On la lit en dernier recours. `looksGood` valide
toujours le videoid, donc la porte de secours ne laisse pas passer de leurre.

**Blocage 2 — le shard CDN, et c'est le vrai enseignement.** Le 302 route chaque
client vers un shard, et certains shards refusent certains reseaux : depuis la
ligne de Luc toute redirection tombe sur `dv97`, qui refuse ; Vercel est route
vers `cvs111-2`, qui sert. **La signature n'est pas liee au hostname** — mesure
sur deux fichiers et deux machines, une requete `st`/`e`/`stor` identique a
servi un 206 depuis `cvs111-2` et un 400 depuis `dv97`. Un shard qui dit non
vaut donc la peine d'etre rejoue ailleurs, tel quel.

**Le piege qui a fait echouer le premier correctif.** Le repli ne se declenchait
jamais. Raison : **un shard qui refuse ne refuse pas vite, il PEND**. Avec
`redirect: "follow"`, la requete mourait sur le timeout d'abort *sans objet
reponse*, donc on n'apprenait jamais quel shard reessayer. D'ou la resolution du
302 en deux temps (`redirect: "manual"`), qui lit le `Location` avant de
s'engager. Deuxieme piege du meme correctif : le Referer du hop doit etre la
page **reellement lue** — envoyer un Referer `shell.php` pour une page qu'on n'a
jamais obtenue fait repondre 403 au lieu de rediriger.

Verifie depuis la machine bloquee : 3/3 episodes resolus ET lus (206, 64 Ko), et
`bridge/resolve_sibnet.mjs` rend `ok:true` sur SnK 1-3.

**Effet attendu sur le detecteur** : sibnet redevient un second temoin sur ~89 %
des saisons, et **53 % des cellules retenues (76/144) le sont faute d'un
deuxieme hote**. C'est le levier principal, pas un gain marginal.

**Corollaire livre au passage** (commit 5dd0306) : un extracteur qui n'a jamais
atteint la page ne sait rien de l'episode, et ne doit donc pas publier une
absence que le client met en cache 6 h. `extractSibnet` marque desormais
`transient: true` dans ce cas, et le resolveur leve une `TransientSourceError`
-> 503 -> la puce lit `retry`. Une absence de preuve n'est pas une preuve
d'absence.

---


## 2026-08-08 — Lot `top50` : le resultat, et pourquoi deux lecteurs sur six n'ont rien rendu

**Le lot est termine** : 50/50 titres, **439 cellules** (441 estimees ; plusieurs
titres ont moins de 10 episodes). Sortie : `out/top50.jsonl`.

| | servi | retenu | absent |
|---|---|---|---|
| OP | 288 | 67 | 84 |
| ED | 275 | 77 | 87 |

Motifs de retenue (144 au total) : *single host, no image confirmation* 70,
*inferred theme* 27, *hosts split* 23, *av_divergence* 8, *implausible_length* 8.
La famille « trouve mais sans second temoin » pese **97/144 (67 %)**.

**Rappel du §top50 precedent : ce chiffre n'est PAS un progres.** Ces 50 titres
sont les plus populaires, donc les mieux servis et les mieux couverts par
AnimeThemes. C'est une premiere mesure honnete, un point de depart.

### Le vrai frein est le transport, et il se mesure

Question posee : « est-ce que sendvid et sibnet sont juste des lecteurs rares ? »
La reponse demandait de separer deux choses que le log confondait — un hote
**non propose** par le catalogue et un hote **propose et en panne**. Mesure faite
en relisant `episodes.js` des 92 saisons du lot, directement sur anime-sama :

| hote | propose | apparait dans le lot | verdict |
|---|---|---|---|
| ansembed | 92/92 (100 %) | 399/439 | sain |
| sibnet | **82/92 (89 %)** | **5/439** | **en panne, pas rare** |
| sendvid | **76/92 (83 %)** | **1/439** | **en panne, pas rare** |
| uqload | **6/92 (7 %)** | 32/439 | **rare, pas casse** |
| embed4me / lpayer | 12/92 (13 %) | — | non implemente |
| minochinos | 6/92 (7 %) | — | non implemente |
| vidmoly-va | (source voir-anime) | 310/439 | sain |
| megaplay | (URL construite depuis MAL) | 232/439 | sain |

Donc : **l'intuition « ce sont des lecteurs rares » est juste pour uqload et
fausse pour sibnet/sendvid.** uqload n'est propose que sur 7 % des saisons — ses
255 `not offered by anime-sama` sont une absence de donnee, pas un echec, et
c'etait une erreur de le compter parmi les hotes « utilisables ». sibnet et
sendvid, eux, etaient proposes sur ~85 % des saisons et n'ont rien rendu.

Le lot a donc tourne sur **trois** hotes reels, pas quatre ni six. Et
**76 des 144 cellules retenues (53 %) n'avaient qu'un seul hote** : ce sont
exactement celles qu'un second temoin debloquerait.

### Les trois causes, verifiees une par une (aucune n'est le detecteur)

**1. sendvid est mort a la source.** `https://sendvid.com/` repond **502** sur sa
propre page d'accueil. Rien a corriger chez nous ; le disjoncteur s'est ouvert
219 fois, ce qui est le comportement voulu.

**2. sibnet nous refuse, mais seulement sur `shell.php`.** Le site est debout —
`video.sibnet.ru/` **200**, la page de visionnage `video.sibnet.ru/video<ID>`
**200** — mais l'endpoint d'embed `shell.php?videoid=<ID>` renvoie **403**, un
403 nginx nu (pas de page anti-bot, pas de Cloudflare), quel que soit le Referer,
l'UA ou l'absence d'en-tetes. C'est un refus au niveau IP/endpoint, pas un bug de
parsing.

⚠️ **Le contournement evident ne marche pas, et il fallait le tester avant de
l'ecrire.** La page `/video<ID>` contient le meme `player.src` avec le meme
videoid — un correctif d'une ligne, tentant. Teste bout en bout : la chaine de
redirection aboutit bien a une URL `noip=1`, mais le CDN (`dv97.sibnet.ru`)
renvoie **400** sur le media. Recuperer l'embed ne recupere pas le flux, donc
**rien n'a ete livre pour sibnet.** A retester depuis une autre IP avant de
conclure que sibnet est perdu : la panne peut etre propre a ce reseau.

**3. Le proxy de secours du bridge n'existait plus — corrige.** Les deux bridges
pointaient sur `aniscroll-proxy.luc-deldem.workers.dev`. Cette route workers.dev
a ete retiree quand le proxy est passe sur le domaine personnalise
(`proxy.aniscroll.com`, requis pour le cache edge). Cloudflare repond a un
sous-domaine sans worker par **sa propre page 404 « There is nothing here yet »**,
19 984 octets, HTTP 404, **pour n'importe quelle URL** — verifie sur example.com.
Donc `viaWorker` ne se degradait pas : il echouait durement a chaque appel, en
silence, pendant tout le lot. Corrige dans `resolve.mjs` et `resolve_sibnet.mjs`.
Effet immediat verifie : `episodes.js` se recupere a nouveau via le worker (le
bridge sibnet atteint desormais l'extraction, la ou il mourait sur `worker fetch
404`).

**La lecon, et c'est la meme qu'au §cache-refusal.** Une URL d'infrastructure
codee en dur survit au demenagement de l'infrastructure, et un 404 Cloudflare
ressemble a une panne d'hote. Le log disait « le repli a echoue » ; personne ne
pouvait deviner que le repli n'existait plus. **Un repli qui echoue toujours doit
etre bruyant** — c'est le vrai defaut ici, pas l'URL perimee.

### A savoir pour la suite

- **anime-sama bloque les IP Cloudflare** (erreur 1042, data-center vers
  data-center). Le worker remis en service n'est donc PAS un repli utile pour
  anime-sama lui-meme — le chemin direct depuis la machine reste le seul. Le
  worker sert pour les autres hotes.
- Les deux hotes non implementes (`embed4me`/`lpayer`, `minochinos`) ne couvrent
  que 13 % et 7 % des saisons : les implementer ne remplacerait pas sibnet.

---


## 🔄 EN COURS au 08/08 15:50 — lot `top50`, à relire ce soir

Reprise après un `/clear` : tout est ici, rien à redécouvrir.

**Le lot.** `anime.top50.json`, 50 titres, **441 cellules** attendues. Lancé à
15:24, ~43 cellules à 15:50, fin estimée **vers 20 h**. Processus détaché
(superviseur orphelin), il survit à la fermeture du terminal. Sortie :
`tools/opening-detector/out/top50.jsonl`.

**Pour lire le résultat** — et *seulement* sur ce lot, jamais sur les lots
d'audit (§11) :
```
node tools/opening-detector/_compare_sources.mjs --list=anime.top50.weights.json
```
Le fichier de poids est distinct d'`anime.top50.json` à dessein : ce dernier
est lu par le lot en cours, on n'y touche pas. Un titre diffère entre les deux
(la 50ᵉ place a bougé), l'outil le signale.

**⚠️ Ne PAS conclure que le détecteur s'est amélioré.** Ces 50 titres sont les
plus populaires, donc mieux servis par les hôtes, mieux couverts par
AnimeThemes. Les chiffres seront meilleurs **par construction**. Les comparer
aux lots durs, c'est refaire l'erreur du §11 dans l'autre sens. Ce lot est la
**première mesure honnête**, un point de départ — pas un progrès.

**Le levier, lui, est déjà mesuré.** Sur les cellules trouvées puis retenues,
**84 % le sont pour « un seul hôte, pas de confirmation image »** (le reste :
hôtes en désaccord franc, 20-40 s). Ce n'est ni l'empreinte, ni le matcher :
on trouve le générique et on le jette faute d'un second témoin. Les deux voies
sont un hôte de plus (transport), ou accepter l'hôte unique quand la vidéo
confirme.

**Ensuite** : revue manuelle par Luc → import avec `batch_id` → vérification
sur dev. Aucun import sans validation manuelle.

---

## 2026-08-08 — Une machine qui s'éteint fabriquait des absences de générique

Le lot `top50` lancé à 01:50 était mort à 02:18 sans que rien ne le signale.
Le diagnostic évident — « les hôtes sont tombés » — était faux, et la façon dont
il était faux désigne un défaut de sûreté plus grave que la panne elle-même.

**Ce que disaient les logs.** Les 35 dernières lignes montrent les **six** hôtes
en `bridge failed (rc=3221226091)`, avec un **stderr vide**, au même instant.
Six hôtes indépendants ne tombent pas à la même seconde en silence.

**Ce que le code d'erreur disait vraiment.** `3221226091` = `0xC000026B` =
`STATUS_DLL_INIT_FAILED_LOGOFF` : Node n'a pas pu initialiser ses DLL *parce que
la session Windows se fermait*. Le shell qui portait le lot avait été fermé et
Windows a démoli tout le groupe de processus. La cause n'est donc pas déduite de
la simultanéité, elle est écrite dans le code de retour.
⚠️ J'avais d'abord lu ce code `0xC000041D` de mémoire, ce qui aurait envoyé
chercher une exception applicative. **Convertir le code AVANT de conclure** —
c'est un test unitaire qui l'a corrigé, pas une relecture.

**Le vrai défaut, et il n'est pas dans le transport.** Cette mort traversait
toutes nos résiliences en se faisant passer pour un échec d'hôte :

1. aucun `_PERMANENT_MARKERS` ne correspond → `_is_transient` la dit réessayable ;
2. le coupe-circuit compte 3 échecs et **ferme l'hôte pour tout le lot** ;
3. les `except Exception` de `multi_host` la ravalent en `hits = []` ;
4. le worker de `batch_detect` la marque `failed` et **passe à l'anime suivant**.

Conséquence : le lot **continue d'écrire des lignes**, où des hôtes morts avec la
machine figurent comme des hôtes n'ayant pas trouvé de générique. Une fois en
base, cette ligne est **indiscernable d'une vraie absence**. C'est exactement le
type d'erreur que le plan s'interdit : pas un faux servi, mais une donnée fausse
et crédible qu'aucun contrôle ultérieur ne peut rattraper.

**Le correctif.** `oped/errors.py` : `ProcessKilled` + `killed_by_os(rc)`, sur
deux signatures inatteignables par une sortie volontaire (POSIX `rc < 0` ;
Windows `rc >= 0xC0000000`, quand Node et ffmpeg sortent dans 0-255). Levée au
point de passage unique de chaque sous-processus — `adapter_aniscroll` pour le
pont, **`audio._run` pour ffmpeg** (le même défaut y existait : un ffmpeg tué
rend aussi une fenêtre manquante). Puis re-levée explicitement aux 4 `except`
de `multi_host` et aux 2 `except … continue` de `batch_detect`. Le worker
n'écrit **rien** au manifeste — le titre n'a pas échoué, il a été interrompu, il
est simplement à refaire — et `run` sort **2**, que `_supervise.py` traite en
arrêt définitif plutôt qu'en relance (relancer sur une machine qui s'éteint
consommerait le budget de relances réservé aux vraies pannes).

**Vérifié**, pas seulement compilé : le prédicat sur les deux signatures et sur
les sorties normales (0, 1, 255) ; `audio._run` qui lève sur un ffmpeg tué mais
laisse passer une sortie 1 ; et le trajet complet `resolve_episodes_multi` →
**un seul appel de pont, zéro réessai, coupe-circuit intact**.

**La leçon transposable.** Nos résiliences sont écrites pour des pannes *locales*
(un hôte, un épisode) et transforment toute erreur en « rien trouvé ici ». Une
panne *globale* les traverse toutes et ressort en donnée. Toute couche qui
convertit une exception en absence doit d'abord se demander si ce qui a échoué
est le sujet de la mesure ou son support.

---

## 2026-08-07 — Audit OP/ED : ce que la nuit de tests a révélé

Journée d'audit, sans changement de production hormis un revert. Tout ce qui suit
est mesuré ; les cas témoins sont nommés pour servir de tests d'acceptation.

> ⚠️ **À LIRE AVANT TOUT CHIFFRE DE COUVERTURE DE CETTE ENTRÉE.** Découvert en
> fin de journée (§11) : nos 690 cellules couvrent ~131 titres, choisis pour
> être **difficiles** (`anime.hard.json`), et **2 097 des 2 228 titres jouables
> n'ont jamais été mesurés** — dont les 20 plus populaires, qui ont zéro
> cellule. Tous les taux de couverture ci-dessous (48 % servable, 32 % de
> cellules vides…) décrivent donc un échantillon délibérément défavorable, PAS
> le catalogue. Les taux d'ERREUR et les mécanismes restent valides ; les taux
> de COUVERTURE sont à refaire sur un échantillon représentatif.

### 0. Une régression poussée puis revertée — la leçon d'abord

Commit `4e5567b` (filtrage AniSkip par montage) poussé sur dev après vérification
sur **trois titres choisis parce qu'ils illustraient le bug visé**. Luc, en jouant :
« c'est tout décalé, largement pire qu'avant ». Reverté en `88170c1`.

Trois défauts réels dans ce que j'avais poussé :
- une règle de cohérence qui validait un montage étranger dès qu'il était **seul**
  (Dragon Ball ep1 : unique soumission timée sur 1452 s, servie sur notre flux de
  1244 s) ;
- « ne jamais remplacer une réponse peuplée par une vide », qui rendait ce mauvais
  affichage **permanent** en jetant l'information corrective ;
- un garde `askedWithLength` jamais réinitialisé entre épisodes, donc l'appel
  correcteur ne partait quasiment jamais.

**Leçon** : vérifier sur les cas qui illustrent le bug ne prouve rien. Aucun
changement ne part sans **rejeu comparatif sur un lot large**.

### 1. Le détecteur n'a jamais servi personne

`oped_skips` et `oped_host_skips` sont **vides**. Prod et dev interrogés
directement ne répondent jamais `source: oped`, toujours `aniskip`/`anime_skip`.
Les ~975 cellules servables (489 OP, 486 ED sur 690 paires) n'existent que dans
`tools/opening-detector/out/*.jsonl`. Tout le travail de détection est à ce jour
sans effet sur un seul visiteur.

### 2. Ce qu'on sert aujourd'hui est mesurablement faux

Sur 305 épisodes où le site répond et où nous avons nos propres durées, en ne
testant qu'une arithmétique (un générique ne peut pas commencer après la fin) :

| | |
|---|---|
| faux pour **tous** nos lecteurs | 10 / 305 — **3,3 %** |
| faux pour **certains** lecteurs | 37 / 305 — 12,1 % |
| plausible partout | 258 / 305 — 84,6 % |

Sailor Moon ep1 : ED annoncé 1326-1416 sur un fichier de 1263 s. Re:Zero ep3 : ED
à 2686-2771 sur ~1500 s. Le 12,1 % est en partie gonflé par nos propres sondes
tronquées (durées à 700 s sur des épisodes de 24 min) — ne pas le citer sans cette
réserve.

### 3. Erased ep1 : un générique de fin sur la chanson d'*opening*

Cas qui a falsifié deux versions du plan. Mesure sur cache, queue de l'épisode
(fenêtre 1132 → 1372 s) :

```
ED1 (Sore wa Chiisana Hikari no You na) : score 0      -> absente
OP1 (Re:Re:)                            : score 26-41  -> presente

ansembed    fichier 1372.1   OP1 a 1281.50   depuis la fin 90.60
megaplay    fichier 1372.0   OP1 a 1281.54   depuis la fin 90.46
vidmoly-va  fichier 1381.2   OP1 a 1288.66   depuis la fin 92.54
```

Confirmé à l'écran par Luc : crédits défilants de 21:26 à 22:52. **AnimeThemes a
raison** (ED1 ne couvre pas l'ep1, OP1 est mappé 1-10) ; c'est notre fenêtre de
recherche qui est aveugle — `OP_SEARCH = (0.0, 300.0)`, repli 720 s
(`theme_bank.py:1362-1366`), et la chanson est à 21 minutes.

**Conséquences** : le livrable n'est pas « OP » ou « ED » mais **une séquence de
générique sautable et sa position** ; l'étiquette doit découler du thème apparié,
jamais de la position. Et « thème mappé mais introuvable dans sa fenêtre » est un
signal fort qu'on jette au lieu d'élargir la recherche.

**Erreur à ne pas répéter** : j'avais donné cette cellule comme la preuve
qu'AnimeThemes ment. En mettant au compte du catalogue ce qui venait de nous,
j'avais fabriqué un « 31 % de contamination » qui ne vaut rien.

**Test d'acceptation du point 3, passé le 07/08 SUR LE CACHE SEUL** — aucune
modification du détecteur, donc aucun risque pris pour l'établir. Les fenêtres de
queue déjà en cache (`abs952.1_420.0`) appariées contre les références OP1 :

| hôte | référence | votes | intervalle absolu | fill |
|---|---|---|---|---|
| ansembed | OP1 v1/v2/v3 | 2631–2871 | **1281,0 → 1371,0** | 0,977–0,980 |
| megaplay | OP1 v1/v2/v3 | 2077–3016 | 1281,1 → 1371,1 | 0,976–0,980 |
| vidmoly-va | OP1 v1/v2/v3 | 1669–2288 | 1286,8 → 1376,9 | 0,976–0,980 |

ED1 dans la même fenêtre : **aucun match**. OP1 dure 90,007 s, d'où la borne de
fin. Le décalage de vidmoly-va (+5,8 s) est son écart d'encodage connu. Trois
hôtes, trois versions, `fill ≈ 0,98` : il ne reste aucun doute à lever, seulement
le code à écrire.

**Conception — et une contradiction que j'ai failli introduire.** Le segment est à
21:21 d'un épisode de 22:52 ; j'ai d'abord voulu le livrer comme un **ED**, au
motif que c'est ce que le spectateur vit (« Passer l'outro » sur la capture de
Luc). C'est précisément le raisonnement par position que cette même section
interdit deux paragraphes plus haut. Conciliation retenue : **`kind` reste `op`**
— l'identité du thème vient de l'appariement, jamais de la position — et un champ
séparé note que le segment tombe en fin d'épisode, ce qui pilote le *libellé
affiché*. L'identité vient de l'appariement, la présentation de la position. Les
deux règles tiennent ensemble sans que l'une mente.

### 4. vidmoly-va échoue seul dans 36 % des cas — cause NON identifiée

⚠️ **Deux diagnostics écrits puis falsifiés le même jour. Lire la section
entière avant de s'appuyer dessus.**

Le fait de départ, solide. Charlotte ep2 : vidmoly-va sert le **même fichier** que
sibnet (1442,04 contre 1442,03) et apparie l'OP **mieux que tous** (4011 votes
contre 2936 et 2912). Le pipeline a pourtant écrit `op: None`.

| lecteur | % de replis 720 s | % d'échecs en solo |
|---|---|---|
| sibnet | 13,2 % | 1,7 % |
| megaplay | 15,3 % | 1,9 % |
| sendvid | 20,0 % | 0,0 % |
| ansembed | 27,2 % | 16,6 % |
| **vidmoly-va** | **39,6 %** | **36,2 %** |
| uqload | 44,4 % | 17,4 % |

**Hypothèse 1 — « l'empreinte n'est pas invariante à la taille de la fenêtre ».
FAUSSE.** Elle venait d'une comparaison entre deux fichiers de cache de
Charlotte ep2 : 300 s → 4011 votes / fill 0,959 ; 720 s tranché à 300 s → 1227 /
0,333. J'en ai conclu que la normalisation globale des pics changeait les hachages
du même audio. Test contrôlé (`_test_block_fingerprint.py`, 475 références en PCM
brut, cible noyée dans du vrai contenu à six offsets dont un à cheval sur une
frontière de bloc) : **fill = 0,959 partout, fenêtre courte comme fenêtre large.**
Aucune dégradation. Le mécanisme n'existe pas.

**Hypothèse 2 — « le décodage long ramène un audio différent ». VRAIE mais RARE,
et n'explique pas vidmoly.** Les deux décodages de Charlotte ep2 ne concordent
effectivement que sur les 63 premières secondes, et le décodage de 720 s est
décalé de ~85 s par rapport à sibnet. Mais généralisé aux 242 paires
(fenêtre 720 + fenêtre 300 du même hôte/épisode) : **90 % sont identiques**, et
les ~10 % de désalignement sont répartis sur tous les hôtes (ansembed 6/67,
megaplay 7/54, vidmoly-va 8/93). Charlotte ep2 faisait partie des 10 %.
**J'ai généralisé depuis un seul cas** — la même faute que le matin même.

**Hypothèse 3 — « le pipeline jette des appariements corrects ». FAUSSE AUSSI,
et c'était une erreur de mesure de ma part.** J'avais annoncé « 45 des 50
cellules ont un appariement valide ignoré ». Le script globait
`absa__*__{lang}__ep{N}__vidmoly-va…`, donc il attrapait **n'importe quel anime**
ayant cet épisode et retenait le premier par ordre alphabétique : j'appariais la
fenêtre de Charlotte contre les références de Charlotte pour des cellules qui
n'étaient pas Charlotte. Avec la table `mal_id → slug` correcte, il ne reste que
**2** appariements valides ignorés sur 58.

**Deuxième erreur de méthode, corrigée dans la foulée** : mon agrégation gardait
le **premier** lot rencontré par ordre alphabétique (`audit.jsonl` avant
`audit6.jsonl`), c'est-à-dire le **plus ancien**. Charlotte ep2, mon cas témoin,
avait été résolu : `op: None` dans `audit`…`audit5` (05/08), puis
`op = 32.1-123.8` dans `audit6` et `audit7` (06/08). Je diagnostiquais une
cellule déjà réparée. Recalcul en gardant le lot le plus récent : vidmoly-va
passe de 36,2 % à **32,9 %** d'échecs en solo — le phénomène tient, mais aucun
chiffre de la première version n'était fiable.

**CE QUI EST ÉTABLI.** Sur les 58 cellules à jour où vidmoly-va rate l'OP seul,
contrôle de l'existence même d'une fenêtre audio en cache :

```
vidmoly-va SANS fenetre audio, les autres hotes AVEC :  33   (57 %)
vidmoly-va AVEC fenetre                              :  25
```

**Dans la majorité des cas, l'audio de vidmoly-va n'a jamais été récupéré**,
alors que celui des autres hôtes l'a été pour le même épisode. Ce n'est ni un
problème d'empreinte, ni de matcher, ni de logique de cascade : c'est en amont,
à la résolution du flux ou au décodage. C'est cohérent avec ce que le projet sait
déjà de la famille vidmoly (uploads instables, qui meurent) et avec le tout
premier signalement de Luc — « vidmoly a souvent du mal ». Les timeouts ffmpeg et
bridge ajoutés le 06/08 transforment un hôte qui cale en fenêtre absente, donc en
`op: None`.

Le reste (25 cellules) n'est pas expliqué : 2 appariements valides ignorés, 1 sans
appariement, 22 dont la référence OP n'est plus en cache — donc non testables.

**Conséquence pour le plan** : le correctif « empreinte par blocs recouvrants »
est retiré (maladie inexistante), et « trouver la ligne qui jette un hit » aussi
(le phénomène n'existe qu'à la marge). Ce qu'il reste à faire est plus banal et
plus utile : **mesurer le taux d'échec de récupération du flux par hôte, et
réessayer**. Un hôte qui ne répond pas est un problème de transport, pas de
détection.

**Leçon de méthode, la plus chère de la journée** : trois hypothèses successives,
trois falsifications, dont deux dues à mes propres scripts de mesure (un glob trop
large, un tri qui gardait le plus ancien). Avant d'écrire un constat, vérifier le
script qui l'a produit sur un cas dont on connaît la réponse.

| lecteur | % de replis 720 s | % d'échecs en solo |
|---|---|---|
| sibnet | 13,2 % | 1,7 % |
| megaplay | 15,3 % | 1,9 % |
| sendvid | 20,0 % | 0,0 % |
| ansembed | 27,2 % | 16,6 % |
| **vidmoly-va** | **39,6 %** | **36,2 %** |
| uqload | 44,4 % | 17,4 % |

Même ordre dans les deux colonnes — mais l'explication « fenêtre cassée » qui
accompagnait cette table a été falsifiée par l'hypothèse 1 ci-dessus, et le
remède « blocs recouvrants » retiré avec elle. La table ne dit plus que ceci :
vidmoly-va et ansembed sont les deux hôtes qui échouent le plus. La section 4 bis
donne la vraie raison.

### 4 bis. Le taux d'échec de récupération, mesuré par hôte — et vidmoly n'est pas un cas à part

Suite du point 2b. Deux choses à retenir : **l'instrument n'existait pas**, et
une fois posé, **le problème s'est révélé général**.

**L'instrument.** `oped/multi_host.py` contenait deux `except Exception: hits =
[]` — un par branche (cascade et v2). Résilience volontaire et justifiée (« un
hôte capricieux ne doit pas couler l'épisode »), mais l'exception était **jetée
sans être ni journalisée ni typée**. Un timeout ffmpeg, un 404, une coupure
réseau et un épisode réellement sans générique produisaient donc le *même objet* :
une liste vide. Aucun run passé ne porte l'information — c'est pour ça que les
57 % du matin avaient dû être obtenus par un détour (l'absence de fenêtre en
cache). Corrigé : `HostStream.detect_error` + une ligne `[detect-fail]`.

**La mesure** (`_measure_fetch_failures.py`, 690 cellules, 1488 couples
hôte-cellule). ⚠️ **Première version fausse, corrigée le jour même** — voir
« quatrième falsification » plus bas. Le tableau juste sépare deux choses que
j'avais additionnées :

| hôte | tenté | sans réf. | échec récup. | taux |
|---|---|---|---|---|
| **vidmoly-va** | 441 | 33 | 59 | **13,4 %** |
| **ansembed** | 497 | 41 | 58 | **11,7 %** |
| uqload | 16 | 0 | 1 | 6,2 % |
| sibnet | 108 | 4 | 1 | 0,9 % |
| megaplay | 414 | 26 | 0 | **0,0 %** |
| sendvid | 12 | 1 | 0 | 0,0 % |
| **TOTAL** | **1488** | **105** | **119** | **8,0 %** |

*sans réf.* = aucune référence AnimeThemes pour l'anime, donc **aucun audio
récupéré parce qu'il n'y avait rien à chercher**. Ce n'est pas un échec de
transport et un réessai n'y changera rien. *échec récup.* reste une borne haute
(un cache purgé y compte).

**Ce que dit le tableau juste.** megaplay et sibnet sont **irréprochables**
(0,0 % et 0,9 %) : leurs 6,3 % et 8,0 % de la première version étaient
*entièrement* l'artefact « pas de référence ». L'échec de récupération est bien
concentré sur **vidmoly-va (13,4 %) et ansembed (11,7 %)** — à la moitié du taux
que j'avais annoncé, et à deux hôtes, pas un. Les 57 % du matin restaient un
chiffre **conditionnel** (mesuré sur les seules cellules où vidmoly échouait
seul, donc sur un sous-ensemble sélectionné pour ça).

**Le lien causal, vérifié plutôt que supposé** : sans fenêtre → cellule vide dans
**94 %** des cas (219/233), contre 26,8 % quand la fenêtre existe. Les 14
exceptions sont cohérentes avec la borne haute (cache purgé après un succès).

**Portée du réessai.** 225 cellules vides sur 690 (32,6 %) ; **97** ont au moins
un hôte sans fenêtre, soit 142 fetches à rejouer (ansembed 61, vidmoly-va 46,
megaplay 26, sibnet 8, sendvid 1). ⚠️ **Ne pas annoncer 97 cellules récupérées** :
91 de ces 97 lignes sont antérieures au champ `expected_absent`, donc on ne peut
pas savoir combien sont des absences légitimes. Base mesurée le 07/08 : 35 % des
« absences » étaient déclarées par AnimeThemes. En attendre nettement moins.
J'avais d'abord écrit « 97 gains réels, 0 absence déclarée » — un comptage vide
de sens, le champ étant absent de 91 des lignes.

**Le vrai livrable du réessai** n'est pas les cellules récupérées mais le
diagnostic : c'est le premier run à porter `detect_error`, donc le premier où un
échec persistant sera nommé au lieu d'être confondu avec une absence.

Note relevée dès les premières minutes du run : une partie des hôtes « sans
fenêtre » échouent en réalité à la **résolution** (`not in voir-anime page`, 404
sur voir-anime), pas au transport. Ce sont deux défauts distincts et le second
n'est pas réparable par un réessai.

**QUATRIÈME FALSIFICATION — la mienne, encore, mais attrapée avant publication
d'une décision.** Le run de réessai a rendu 0 récupération sur ses 19 premières
lignes *et zéro `detect_error`*. Si l'échec avait été le transport, l'instrument
tout juste posé aurait crié. Il s'est tu — et ce silence était la réponse :
**sans référence de thème, `detect_op_ed` sort AVANT de récupérer le moindre
audio.** Pas de fenêtre en cache, pas d'exception, cellule vide. Mon propre test
d'instrumentation l'avait exhibé une heure plus tôt (il ne levait rien tant que je
ne lui donnais pas une vraie référence) et je n'en avais pas tiré la conséquence.

Sur les 227 couples sans fenêtre, **47 % appartiennent à des anime sans aucune
référence** : il n'y avait rien à chercher. C'est le même phénomène que les
14,2 % de titres hors AnimeThemes mesurés au point 0, vu sous un autre angle.

Au passage, un piège de nommage qui a failli me faire publier « 41 anime sur 41
sans référence » : **le slug AnimeThemes n'est pas le nôtre**
(`les-brigades-immunitaires` → `hataraku_saibou`, `aho-girl` → `aho_girl`). Un
glob sur notre slug ne trouve presque rien. Passer par `resolve_slug(mal_id=…)`,
jamais par une substitution de tirets. Ce qui m'a arrêté est le contrôle que je
m'étais imposé : le même glob prétendait que **84 des 94 anime ayant produit un
résultat** n'avaient pas de référence — Erased compris. Un instrument qui accuse
les cas connus pour bons s'accuse lui-même.

**RÉSULTAT DU RUN DE RÉESSAI (41 anime, 95 cellules, terminé 16:36).** La
prédiction tient exactement :

```
cellules AVEC reference : 11 recuperees / 30   (37 %)
cellules SANS reference :  0 recuperees / 65
```

**11 cellules récupérées**, toutes du côté « avec référence » ; zéro du côté
« sans », sur 65 essais. Et **zéro `detect_error` sur tout le run** : l'échec
n'est jamais une exception pendant la détection.

**Deux défauts distincts, et ma table du 2b n'en voyait qu'un.** Quand la
résolution échoue, l'hôte **n'entre jamais dans `per_host`** — il est donc
invisible dans une table qui ne compte que les hôtes déjà résolus. D'où
l'apparente perfection de sibnet et megaplay : ils échouent *avant* d'être
comptés. Ventilation des `[no-host]` du run :

| hôte | non proposé | vraie panne |
|---|---|---|
| sibnet | 5 | **62** |
| sendvid | 19 | **46** |
| vidmoly-va | 0 | 27 |
| ansembed | 10 | 7 |
| uqload | **61** | 5 |
| megaplay | 0 | 2 |
| **TOTAL** | **95** | **149** |

*non proposé* = « not offered by anime-sama for this season » : l'hôte ne sert
pas cette saison, ce n'est pas une panne et aucun réessai n'y peut rien. Les 149
vraies pannes se répartissent en `embed unreachable or decoy` (57),
`sendvid HTTP 502` (41), `direct failed` / 404 voir-anime (23), divers.
⚠️ Lot volontairement difficile (les cellules qui avaient déjà échoué) : ces
proportions ne valent **pas** pour la base entière.

**La décomposition à retenir**, et elle rend le sujet enfin lisible :
1. **Non proposé** — l'hôte ne sert pas cette saison. Ni panne ni réessai.
2. **Panne de résolution** — l'hôte est absent de `per_host`, invisible au 2b.
3. **Panne de récupération** — l'hôte est dans `per_host` sans fenêtre (table 2b).
4. **Pas de référence** — rien à chercher ; le détecteur sort avant tout réseau.

Trois des quatre ne sont pas des défauts du détecteur, et aucun ne se répare en
réessayant. Ce qui reste à traiter est la catégorie 3, sur deux hôtes.

**Le contrôle du script de mesure a servi le jour même.** Il refuse de publier si
le cas témoin (Charlotte ep2 vostfr) ne se comporte pas comme établi — et il a
bloqué au premier lancement, parce que j'y avais encodé la croyance *périmée*
(« vidmoly-va n'a pas de fenêtre ») au lieu du fait corrigé la veille (elle en a
une, et son OP est à 32,21). Exactement le travail attendu de lui.

### 5. L'ancre `from_end` n'est pas duration-indépendante — 5 % des ED servis

Le mécanisme même du service. Sur **241 cellules ED servies, 12 (5 %)** ont des
ancres `from_end` dispersées de plus de 10 s entre hôtes :

```
Erased  ep3   megaplay  90.9  ansembed  90.9  vidmoly-va  75.3    ecart 15.7 s
Re:Zero ep1   sibnet   147.1  megaplay  96.3  vidmoly-va  95.4    ecart 51.7 s
Naruto  ep2   megaplay 121.3  ansembed  96.1  vidmoly-va 119.8    ecart 25.2 s
```

Et le champ `spread` annonce **0,02 s** sur Erased. Il n'est pas faux : il mesure
la dispersion des positions **absolues**, identiques ici. Mais
`from_end = durée − début` — deux hôtes qui placent l'ED au même endroit dans des
fichiers dont les **fins** diffèrent ont des ancres différentes.

La route re-projette exactement cette ancre (`start = episodeLength −
fromEndStart`), donc le visiteur sur l'hôte minoritaire reçoit un ED décalé de
tout l'écart — jusqu'à 51 s.

**Ni l'absolu ni le `from_end` n'est un invariant.** L'absolu vaut si le début du
fichier est identique, le `from_end` si la fin l'est. `SERVE_MAX_SPREAD_S` ne
contrôle que le premier.

### 6. On allait reconstruire le bug AniSkip sur nous-mêmes

`oped_host_skips.duration` et `oped_skips.canonical_duration` stockent la durée
contre laquelle la mesure a été faite. `hostRowToSkips` et `opedRowToSkip`
(`pages/api/v2/skip/[malId]/[episode].ts`) ne les lisent **jamais**. Quand un hôte
réuploade un **montage différent** — le cache megaplay tourne, des uploads meurent
— la ligne devient un timing étranger servi avec pleine confiance, **avant** le
crowdsourcing. La re-projection `from_end` aggrave l'illusion : elle corrige un
rognage, jamais un remontage.

### 7. Autres incohérences relevées dans les résultats de la nuit

- **Un même segment sous deux étiquettes** :
  `i-cant-understand-what-my-husband-is-saying` (format court, épisode de 210 s),
  OP à 180,42→208,60 et ED à 180,46→210,13. Retenus par la porte, mais rien ne
  l'interdisait.
- **Étiquette de thème fausse, timing juste** : `100 girlfriends` ep12 — ED2 pour
  sendvid/megaplay/ansembed, **ED1** pour vidmoly-va, tous à 1324,5→1414,4 dans
  des fichiers de même durée. ED1 et ED2 se ressemblent trop pour être distingués.
  Donc « une référence connue s'apparie dans la fenêtre » est une confirmation plus
  faible qu'elle n'en a l'air.
- **Reproductibilité** : 54 cellules produites par plusieurs runs, **4 divergent de
  plus de 5 s** (Hyouka ep3 : 1527,2 vs 1535,2 ; Dandadan ep4 : 386,0 vs 393,1).
  Selon le run importé, on servait juste ou faux.
- **Plausibilité arithmétique : zéro violation** sur nos 690 cellules (contre 3,3 %
  côté AniSkip). Cette porte protège les entrées externes et manuelles, pas notre
  propre sortie.

### 8. AnimeThemes : trois défaillances distinctes, mesurées sans AniSkip

1. **Trou dans le mapping par épisode** — aucun thème mappé alors que le thème est
   là. Nos hits `inferred` le mesurent : **85 OP (21 %) et 57 ED (14 %)** des
   cellules produites, dont 48 OP et 19 ED servies. **Une cellule sur cinq pour
   l'OP.** C'est ce qui condamne `expected_absent`.
2. **Aucune référence utilisable** (pas d'entrée, ou thème absent de notre
   encodage) — 24 cellules sur 6 anime, récupérées en `SELF-OP`/`SELF-ED`, aucune
   servie (`DERIVED_REQUIRES_SEASON`).
3. **Ce qui n'en est pas une** — Erased ep1 (§3).

Règle : le catalogue est un **indice de départ**, jamais une borne. Il dit quels
thèmes existent, jamais où ils sont ni s'ils sont absents d'un épisode.

### 9. Échelle — le chiffre qui contraint tout le reste

```
anime en base       : 22 547
entrees player_map  :  3 505  (2 364 verified + 1 131 heuristic)
debit mesure        : 116 anime x 4 episodes en 7 h -> ~66 episodes/h
```

| ambition | volume | temps machine continu |
|---|---|---|
| 4 épisodes échantillonnés sur tout `player_map` | ~14 000 ép. | **~9 jours** |
| couverture complète (~12 ép./titre) | ~42 000 ép. | **~26 jours** |

Par langue. **Une passe uniforme n'est pas réaliste** → prioriser par trafic réel.
Le risque principal n'est pas l'échec technique, c'est de ne jamais aboutir.

### 9 bis. Le plafond adressable — mesuré, et c'est une bonne nouvelle

Point 0 du plan, exécuté le 07/08 (`tools/opening-detector/_measure_ceiling.mjs`,
lecture seule). L'index AnimeThemes est aspiré une fois (50 pages, 4 910 titres
avec identifiant AniList) et croisé avec `player_map`.

**Correction au passage** : les 3 505 lignes `player_map` ne font que **2 235
titres distincts** — une ligne par (titre, source, langue). C'est le bon
dénominateur ; le chiffre de 3 505 cité plus haut surestime le volume d'environ
50 %, et donc aussi les 9 à 26 jours du §9.

```
entree AnimeThemes exploitable :  1915   85.7 %
entree sans aucune video       :     2    0.1 %
aucune entree AnimeThemes      :   318   14.2 %

verified    1621 / 1706 exploitables  (95.0 %)
heuristic    294 /  529 exploitables  (55.6 %)
```

Profil des classes :

| classe | n | année méd. | popularité méd. |
|---|---|---|---|
| exploitables | 1 915 | 2020 | **51 111** |
| sans entrée | 318 | 2011 | **4 255** |

**Plafond pondéré par la popularité : 97,5 %.** Les titres hors de portée sont
douze fois moins populaires que les autres — ce sont des obscurités. Le plafond
vu par un visiteur n'a donc rien à voir avec le plafond compté par titre.

**Ce que ça tranche** : le risque que le plan soit bâti sur du sable est levé. Le
chemin par référence peut couvrir l'essentiel de ce qui est réellement regardé,
et les 14 % restants (dont 39 titres d'avant 2000) sont exactement la classe
destinée au repli auto-dérivé et aux surcharges manuelles. Ça conforte aussi le
point 4 : prioriser par le trafic est ce qui rend l'objectif atteignable.

Vérifications faites avant de croire le chiffre : la page 51 est vide et `next`
est nul (aspiration complète, pas tronquée) ; cinq titres témoins sont présents
avec le bon nombre de thèmes ; et un échantillon des « absents » interrogé par la
seconde voie (`/resource`) confirme soit l'absence totale, soit une ressource
orpheline sans anime lié.

### 9 ter. Point 1 exécuté — plausibilité, `batch_id`, garde de péremption

**Ce qui n'était pas à écrire.** Le plan prévoyait un `oped/plausibility.py`.
`oped/validate.py` fait déjà ce travail côté détecteur, et plus finement : bande
de longueur 25-150 s, bord rogné, couverture des votes, divergence audio/image,
chevauchement OP/ED. C'est ce qui explique les zéro violations du §7. En écrire un
second aurait dupliqué la règle — exactement ce que la docstring de
`lib/skip/providers.ts` reproche aux contrats réimplémentés.

**Ce qui manquait vraiment : la frontière de la base.** Les deux scripts d'import
ne vérifiaient que `end <= start`, sans aucune conscience de la durée. Nouveau
`scripts/lib/opedPlausibility.mjs`, une seule implémentation partagée, règle
minimale et sans hypothèse sur le contenu (un OP en plein milieu passe, un
générique de fin sur la chanson d'ouverture passe) :

```
[import-oped] 5 lines -> 3 intervals
[import-oped] 4 interval(s) REJECTED as impossible :
    mal2 ep1 vostfr ed — commence apres la fin (1326.0s >= 1263.0s)   <- le cas Sailor Moon reel
    mal3 ep1 vostfr op — intervalle degenere (3.0s < 5s)
    mal4 ep1 vostfr op — debut negatif (-5.0s)
    mal4 ep1 vostfr ed — finit apres la fin (1500.0s > 1420.0s)
```

Un intervalle sans durée connue **passe** : rejeter faute d'information
transformerait une donnée incomplète en donnée perdue. Et les rejets sont
comptés et affichés — une ligne qui disparaît sans un mot, c'est un mauvais lot
repéré six semaines trop tard.

**`batch_id` + retour arrière**, sur les deux tables (migration `ALTER TABLE`
défensive, même motif que `player_map.algo_version`). `--revert=<id>` montre ce
qui partirait, `--revert=<id> --yes` efface. Le retour arrière ne dépend pas du
JSONL d'origine : c'est justement quand tout va mal qu'il a disparu.

**Garde de péremption (0.c)** dans `pages/api/v2/skip/[malId]/[episode].ts`. Deux
seuils, parce que les deux champs ne disent pas la même chose : **10 s** par hôte
(la durée stockée est celle de cet encodage précis, l'écart attendu se limite au
bruit ffprobe/lecteur) et **60 s** sur `canonical_duration` (une médiane sur des
encodages qui diffèrent légitimement — Erased ep1 : 1372 s contre 1381 s). En cas
de refus on retombe sur le participatif, jamais sur du vide.

Vérifié en local contre une ligne fabriquée sur un `mal_id` inexistant :

```
reconcilie (canonical 1400, tolerance 60) : 1400/1440/1455 servis, 1465/1500 refuses
par hote   (duration  1400, tolerance 10) : 1400/1408 -> oped-host,
                                            1412/1450 -> refuses, repli sur le reconcilie
```

Puis les lignes de test effacées par `--revert=test-0c --yes`, les deux tables
revenues à zéro, et la route à `source: none`. Le retour arrière est donc éprouvé
**avant** d'en avoir besoin, pas pendant un incident.

**Découverte au passage, et elle compte** : *aucun appelant n'envoie
`episodeLength`*. `lib/skip/prefetchSkips.ts` sait le transmettre, mais aucun de
ses sites d'appel ne remplit le champ. La route reçoit donc toujours 0, ce qui
rend **inertes** la re-projection `from_end` de l'ED **et** cette garde. Les faire
mordre suppose que le client transmette la durée réelle — précisément le
changement qui a causé la régression revertée en `88170c1`. À refaire au point 5,
avec la porte de non-régression en place.

### 10. État de l'art (vérifié ce jour)

- **[intro-skipper](https://github.com/intro-skipper/intro-skipper)** (Jellyfin,
  2 627 étoiles, actif) — Chromaprint sur la répétition inter-épisodes, plus
  silence et image noire. Valide notre architecture. Mais il ne cherche l'OP que
  dans les premiers 25 % et l'ED que s'il dure moins de 4 min : les hypothèses de
  position que ce projet a démontrées fausses en anime.
- **[open-anime-timestamps](https://github.com/jonbarrow/open-anime-timestamps)** —
  exactement notre approche (Dejavu), 41 étoiles, mort depuis août 2022.
- **[arXiv 2504.09738](https://arxiv.org/html/2504.09738v1)** (CLIP + attention,
  972 épisodes, visuel seul) : exactitude 94,3 %, **précision 89,0 %**, rappel
  97,0 %. Un segment servi sur neuf est faux → **pas un décideur**, mais un bon
  générateur de candidats. Ses modes d'échec listés tombent sur l'anime : coupes
  rapides des intros animées, crédits en surimpression, intros très courtes.
- **AWS Rekognition** revendique les crédits stylisés d'anime mais est payant
  (0,05 $/min, S3 obligatoire) → **écarté**. Le besoin réel est une borne exacte :
  [PySceneDetect](https://www.scenedetect.com/), TransNetV2, AutoShot le font
  gratuitement.
- **Netflix** combine algorithme **et curation humaine** — argument en faveur de la
  file de revue.
- **Bugs mesurés chez Anime-Skip** : notre table de types contient `Ending`,
  `New Ending`, `Mixed Ending` **qui n'existent pas** dans leur énumération, et il
  manque `Credits`, le nom d'ending le plus courant (leurs 15 types réels : Canon,
  Must Watch, Branding, Intro, Mixed Intro, New Intro, Recap, Filler, Transition,
  Credits, Mixed Credits, New Credits, Preview, Title Card, Unknown). De plus la
  conversion points → intervalles ferme chaque marqueur avec le suivant, or un
  ending est presque toujours le **dernier** — donc supprimé. Témoin : Attack on
  Titan ep1, marqueur `Credits` à 1309,3 aujourd'hui jeté.

### 12. Le lot `seed` — ce que réessai et amorçage rapportent réellement

Lot construit pour ce qu'il peut prouver : les cellules qui n'avaient **qu'UN
SEUL hôte qui répond** alors qu'un autre était présent et muet, donc à un hôte
du seuil de service. 29 anime, 60 cellules, état figé avant le run
(`out/seed_before.json`) pour qu'il y ait un point de comparaison.

```
hotes EN PLUS (franchissent le seuil) : 42/60   (70 %)
inchangees                            : 18
hotes EN MOINS (regression)           :  0
```

**Et surtout, la précision tient** — c'est la moitié du résultat :

```
consensus servis : 75 | retenus : 25
spread MAX des hits servis : 3,67 s   (seuil SERVE_MAX_SPREAD_S = 10,0)
servis violant le seuil ou marques hosts_split : 0
```

Sur les 111 paires (hôte déjà présent × hôte nouvellement apparu), 96 s'accordent
à moins de 10 s. Les 15 désaccords se lisent : la plupart valent ~11,5 s et sont
**cohérents entre eux** — sur l'anime 60285, ansembed (134,7) et sibnet (134,5)
s'accordent *contre* megaplay (123,1), donc c'est le décalage d'encodage de
megaplay, pas une erreur. Un seul vrai désaccord (`50204|2|vf`, ED à 1335,3
contre 963,8, 371 s d'écart) : il n'a produit **aucun** hit de consensus. Rejeté,
pas arbitré.

**Le gagnant est sibnet**, présent dans ~35 des 42 gains — l'hôte qui affichait
62 échecs de résolution (`embed unreachable or decoy`). Le réessai *dans le run*
le récupère, là où la mesure inter-lots donnait 0/3 : ce motif est réellement
transitoire à l'échelle de la seconde, pas à celle du jour. C'est la nuance que
la mesure historique ne pouvait pas voir.

**Coût, après le coupe-circuit** : 87 minutes, contre ~7 heures projetées sans
lui. Réessais tombés de 64 à 12, circuit déclenché 25 fois, 5 amorçages, aucun
balayage plein-épisode.

⚠️ **Ne pas généraliser ce 70 %** : le lot a été choisi parce qu'il lui manquait
un hôte. C'est le rendement du mécanisme *là où il s'applique*, pas un gain de
couverture sur le catalogue.

### 11. Nos mesures portent sur un échantillon défavorable — et personne ne l'avait dit

Découvert en construisant la priorisation du point 4
(`_prioritise_titles.mjs`) :

```
2 228 titres jouables (player_map verified/heuristic)
2 097 jamais mesures                                   (94 %)
couverture servable des 20 plus populaires : 0/11 cellules
```

Les vingt titres les plus populaires — Shingeki no Kyojin, Demon Slayer,
Jujutsu Kaisen, Death Note, One Piece, Hunter x Hunter — **n'ont jamais été
passés au détecteur**. Nos 690 cellules couvrent ~131 titres, et ces lots ont
été constitués pour être *difficiles* (`anime.hard.json`), pas représentatifs.

**Conséquence, et elle est large.** Chaque taux de couverture de cette entrée
décrit les cas durs, pas le catalogue : les 32,6 % de cellules vides, les 48,4 %
de cellules servables, les 33 % de cellules à un seul hôte. Ces nombres ne sont
pas faux, ils ne répondent simplement pas à la question qu'on croit leur poser.
Les taux d'ERREUR et les mécanismes établis (transport, fenêtre aveugle,
amorçage) ne sont pas touchés — ils portent sur des cas nommés et reproduits.

**Effet direct sur le critère d'arrêt (point 6)** : comparer détecteur et
participatif sur cet échantillon ferait perdre le détecteur d'avance, puisqu'on
l'a jugé sur ce qu'on lui a donné de plus dur. Le lot du point 5 doit être
constitué **par popularité**, pas par difficulté.

**Limite du classement lui-même, assumée** : c'est la popularité AniList, PAS le
trafic réel demandé par le plan. Le CLI Vercel n'est pas installé et son
authentification est interactive ; la base Turso ne contient aucune table de
trafic (`user_analytics` n'existe pas côté prod, et le Worker ne l'alimente plus
depuis le 11/07). Un titre ancien et célèbre peut n'être presque pas regardé
chez nous. À refaire sur `vercel logs --json` avant toute décision irréversible.

### Décisions (Luc, 07/08)

- **Détecteur d'abord**, assainissement du crowdsourcing ensuite — confirmé **en
  connaissance des délais** (§9) et des 3,3 % servis faux aujourd'hui.
- **Aucun import sans validation manuelle.** Flux cible : run local → vérification
  → dev avec les pastilles → prod → automatisé.
- **Rien de payant.**
- **Graduation N = 3** : après 3 lots consécutifs sans erreur, une catégorie passe
  en import automatique ; une seule erreur la fait retomber.
- **Cible reformulée** : « zéro erreur **détectable** + résiduel mesuré et
  publié », le zéro absolu n'étant pas démontrable.
- **La détection de texte est écartée** (objection de Luc) : nos flux sont en
  VOSTFR hardsub, il y a du texte à l'écran la moitié de l'épisode.
- **Le bouton de signalement existe déjà** (`components/shared/ReportModal.tsx`,
  motif `wrong_skip`) — il faut l'**enrichir** (serveur actif, durée réelle,
  intervalle servi), pas en construire un.

### Leçons / pièges

- **Un commentaire peut mentir.** `episodeLength=0` ne « désactive pas juste leur
  départage » chez AniSkip : ça laisse revenir des résultats de montages sans
  rapport. Et la docstring de SkipOverlay affirmait envoyer un indice que le client
  n'envoyait jamais.
- **Ne jamais jeter une information corrective** pour préserver un affichage.
- **Un garde d'idempotence sur `useRef` doit être réinitialisé** quand ses
  dépendances changent, sinon il bloque le cas normal.
- **Mesurer avant de croire** : j'ai déclassé la détection de crédits à l'image sur
  une intuition, puis dû la remonter. Toute nouvelle nature de preuve doit être
  mesurée sur les ~975 cellules connues **avant** d'obtenir un droit de vote.
- **Un appariement guidé n'est pas un témoin indépendant** : si on dit à un hôte où
  chercher, le trouver ne confirme rien. À marquer `verified_from_peers` — donne la
  couverture pour cet hôte, jamais une voix.
- **`_self_reference_pass` (F1) est aveugle à l'échec d'un seul hôte** : il exige
  que >66 % de la saison soit vide (`SELF_REF_MIN_HIT_RATE = 0.34`) et teste la
  ligne **réconciliée**, pas les lignes par hôte.

## 2026-08-06 — Le cache de sondes n'etait pas indexe par EPISODE

Suite du precedent. Le repli marche (ep2 VF bascule bien sur Anime-Sama Sibnet,
en VF), mais Luc : « il y est toujours, quand je passe de l'ep 1 [ou il existe] a
l'ep 2 ». Le chip Voir-Anime restait VERT sur un episode dont l'upload est mort.

### La cle oubliait l'episode
```js
// avant
const probeCacheKey = `aniscroll.probes.${info.id}.${dub ? "dub" : "sub"}`;
```
Cache sessionStorage, TTL 90 s, sur la premisse ecrite en commentaire : « d'un
episode a l'autre la disponibilite change a peine ». Vrai de la presence au
catalogue, **faux des uploads**, qui meurent un episode a la fois. Les
confirmations de l'ep 1 etaient donc rehydratees sur l'ep 2 — chip vert pour une
source inexistante, et surtout entree dans `cachedConfirmed`, ce qui fait SAUTER
la sonde qui l'aurait detectee. Tous les autres stocks de disponibilite de la
page sont indexes par episode (snapshot Redis `avail:v1:<id>:<ep>:<sub>`, cache
negatif, cache de source) : celui-la etait le seul a ne pas l'etre.

Le pre-affichage inter-episodes n'est pas perdu : le snapshot inter-visiteurs,
lui aussi par episode, allume deja les chips au premier rendu.

### Asymetrie restante (non corrigee, assumee)
Un `ok` du snapshot est TRUSTED et jamais re-sonde pendant 6 h (c'est le gain CPU
assume de juillet), alors qu'un `absent` est re-sonde sur ~20 % des visites. Un
hote mort entre-temps reste donc vert jusqu'a ce que quelqu'un le SELECTIONNE —
la, le chemin clic le rabat (et, depuis `hard`, publie l'absence pour tous).
Symetriser couterait exactement le trafic Upstash que ce gain protege : a
arbitrer avec Luc, pas a decider seul.

## 2026-08-06 — Un upload mort ne doit pas revenir a chaque rechargement

Luc, ep 2 VF de Clevatess S2 (aniId 198946) : « le lecteur vf est mort et a
chaque fois que je reload il reapparait ». Mesure sur voir-anime :

```
clevatess-2-vf  ep1  voembed.net/embed-giegiymmyrta   HEAD 200  m3u8=true
clevatess-2-vf  ep2  voembed.net/embed-3mx1x85hof1b   HEAD 404  <-- upload supprime
clevatess-2-vf  ep3  voembed.net/embed-d92n983p22by   HEAD 200  m3u8=true
```

L'API repond donc `absent` a juste titre. **Le bug est ce que le lecteur en
fait.** Deux comportements, tous deux volontaires, tous deux faux ici :

1. Le chemin « clic » retente 3 fois (800/1600/3200 ms) avant de conclure, parce
   qu'un hote peut servir un leurre anti-bot a froid. Sur un 404 prouve c'est
   5,6 s de roue qui tourne pour rien — la « mort » du lecteur.
2. Il refuse ensuite de PUBLIER l'absence (un leurre et un vrai vide se
   ressemblent, et se tromper masque un hote sain 6 h). Donc le chip n'est jamais
   masque : il revient a chaque rechargement, mort a chaque fois.

### Le manque : une absence prouvee n'avait pas de nom
`isVidmolyEmbedAlive` ne renvoie `false` que sur un 404 explicite (une erreur
reseau renvoie `true`, on ne punit jamais un chip pour notre propre hoquet). On
SAIT donc que l'upload est supprime — mais l'info se perdait dans un `null`
indistinguable d'un « pas trouve ». Ajout de `HardAbsenceError`, symetrique de
`TransientSourceError` : le contrat a maintenant trois etats au lieu de deux.

| Verdict | Sens | Effet |
|---|---|---|
| `TransientSourceError` | l'amont a hoquete | 503, on retente, rien n'est enterre |
| `null` | pas trouve (ambigu) | 404, cache 10 min, publie par la sonde de fond seulement |
| `HardAbsenceError` | **prouve** (404 de l'hote) | 404 + `{absent, hard}` : pas de retry, chip masque |

Le drapeau traverse tout le chemin, cache compris (`HARD_NOT_FOUND_SENTINEL`) —
sinon il n'aurait survecu qu'a une requete sur 10 minutes.

### Au passage : le repli changeait de langue
`PREFERRED_FALLBACK_ORDER` listait 9 serveurs dont **6 n'existent plus** dans
lib/servers.js (hianime-*, animesama-oneupload, voiranime-streamtape*).
`isCandidate` les filtrait en silence, la liste valait donc
`[megaplay, animesama-sibnet, animesama-sibnet-vo]`. Et comme le test acceptait
`lang === "multi"` au meme rang, perdre un chip VF basculait l'episode sur
Megaplay — donc en VOSTFR. Repli en deux temps : meme langue STRICTE d'abord
(liste indicative puis lib/servers.js, deja triee par vitesse), le reste apres.

### Leçons / pièges
- **« Le lecteur est mort » et « le chip revient » etaient le meme bug**, vu par
  ses deux bouts : le retry qui fait attendre, le non-publie qui fait revenir.
- **Un garde-fou anti-leurre applique sans nuance devient une panne** : les 3
  retries et le refus de publier sont justes pour une absence ambigue, absurdes
  pour un 404 prouve. Il manquait la distinction, pas la prudence.
- **Risque assume** : si vidmoly se mettait a 404 des slugs valides depuis les IP
  Vercel, on publierait desormais une absence de 6 h depuis le chemin clic. La
  sonde de fond publiait deja sur ce meme signal — le profil de risque ne change
  pas, seul le chemin s'aligne.
- **Verifier l'amont avant d'accuser le code** : ici les trois episodes voisins
  prouvaient en une commande que le probleme etait l'upload, pas la resolution.

## 2026-08-06 — Le chip Voir-Anime disparait au rechargement (absence fabriquee)

Luc : deux captures de Clevatess S2 (aniId 198946) sur dev, meme page. Avant
rechargement le chip « Voir-Anime Vidmoly » est la, en vert ; apres, la ligne VF
n'a plus que les trois anime-sama. Ma premiere hypothese (le snapshot 6h masque
au premier rendu) etait dans le mauvais sens : ici le chip est present PUIS perdu.

### La cause : `getVoiranimeIframe` renvoyait `null` pour TOUT
Le contrat du routeur ([pages/api/v2/source/index.js](pages/api/v2/source/index.js)) :
`null` = « cet hote n'a genuinement pas cet episode » → 404 + cache negatif 10 min
+ publication dans le snapshot de disponibilite **6 h** ; `TransientSourceError` =
« l'amont a hoquete » → 503, le client retente, rien n'est enterre.

anime-sama respecte ce contrat (son `catch` rethrow en transitoire, sa page detail
non-200 leve). **voir-anime ne l'a jamais respecte** : `catch (e) { return null }`,
page episode non-200 → `null`, `thisChapterSources` absent → `null`, recherche de
slug non concluante → `null`. Donc un seul 429 du Worker, un challenge Cloudflare
ou un timeout se diffusait comme une absence definitive — pour TOUS les visiteurs,
pendant 6 h. C'est mot pour mot le bug « megaplay disparait apres un rechargement »
deja documente dans ce fichier, sur un autre fournisseur.

Mesure : a froid l'appel met **2065 ms** (worker + page detail + page episode +
sonde HEAD), contre ~100 ms en cache. La marge avant timeout est mince — d'ou le
caractere intermittent, et d'ou le fait que ca s'est vu maintenant : la migration
voembed a rallonge le chemin (une famille de domaines de plus a essayer).

### Correctif : classer les echecs au lieu de tous les aplatir
- page episode 5xx/429/403 → transitoire ; un vrai 404/410 reste une absence.
- `thisChapterSources` absent ou illisible sur un 200 → transitoire (c'est une
  interstitielle anti-bot, pas une page sans lecteur).
- page detail 5xx/429/timeout + fallback AJAX vide → transitoire (`detailInconclusive`).
- recherche de slug non concluante → transitoire. Le flag `sawInconclusive`
  existait deja et protegeait le cache memoire, mais le VERDICT sortait quand
  meme en `null` — la moitie du garde-fou manquait.
- `catch` final → rethrow en `TransientSourceError`, comme anime-sama.

Seul reste `null` : la page a bien ete lue et l'hote n'y est pas (le cas
vidmoly/voembed d'hier), ou l'upload est mort (HEAD 404).

### Leçons / pièges
- **Une capture « avant/apres » donne le SENS de la panne** : chip present puis
  absent = une absence ecrite pendant la session ; absent puis present = un cache
  d'affichage perime. J'avais decrit le second, Luc observait le premier.
- **Un contrat null/throw ne vaut que si chaque fournisseur l'honore.** Le meme
  bug a ete corrige sur megaplay, puis re-introduit ailleurs par simple omission —
  rien dans le code ne l'imposait a voir-anime. Le commentaire de `sendRetryable`
  decrit pourtant exactement le piege.
- **Ne pas conclure depuis une seule sonde qui passe** : au moment du diagnostic
  l'API repondait 200 sur les 3 tours. C'est le CHEMIN de code, pas la mesure
  instantanee, qui prouve le bug.

## 2026-08-06 — voir-anime migre « LECTEUR myTV » : vidmoly.biz -> voembed.net

Luc signale que certains lecteurs vidmoly de voir-anime ont change. Mesure sur
les pages live : le panneau **LECTEUR myTV** sert desormais `voembed.net` sur les
titres recents, `vidmoly.biz` sur le back-catalogue.

- 25 episodes lies depuis la home : **25/25 sur voembed.net**, 0 vidmoly.
- 25 slugs `player_map` verifies tires au hasard (VF) : **24/25 encore sur
  vidmoly.biz**, 1 deja migre (`sousou-no-frieren-2-vf`).

Notre filtre d'hote ne connaissait que `vidmoly.(to|biz|net)` : sur un titre
migre aucun panneau ne matchait, donc **le chip Voir-Anime disparaissait
entierement** (pas « casse » : absent, comme le split Re:Zero de la veille).

### C'est un white-label vidmoly, pas un nouvel hote
La page embed voembed est une page vidmoly : `<meta description>` « VidMoly »,
favicon `vidmoly.me`, assets `cdn.staticmoly.me`, meme `…/hls2/…/master.m3u8`.
Le slug resout AUSSI sur `vidmoly.biz/.net` et `ansembed.net` (verifie) — donc
espace de noms partage, contrairement a ansembed. Ajoute a la famille
(`VIDMOLY_DOMAINS` / `VIDMOLY_HOST_RE`) plutot que traite comme un hote a part :
meme backend, meme encode, donc **meme hote de fingerprint OP/ED `vidmoly-va`**,
aucun ajout dans `lib/hostRegistry.js` ni dans `lib/servers.js` (le chip
« Voir-Anime Vidmoly » est inchange, il resout juste a nouveau).

Touche : [lib/extractors.js](lib/extractors.js), [lib/clientVidmoly.js](lib/clientVidmoly.js),
[pages/api/v2/source/index.js](pages/api/v2/source/index.js) (hotes du panneau,
sonde d'aliveness, `EXTRACTABLE_HOSTS`),
[components/watch/primary/UniversalPlayer.tsx](components/watch/primary/UniversalPlayer.tsx)
(`referrerPolicy` no-referrer, qui ne couvrait ni ansembed ni voembed),
[tools/opening-detector/bridge/resolve.mjs](tools/opening-detector/bridge/resolve.mjs).

### Leçons / pièges
- **La sonde d'aliveness ne doit pas reecrire le domaine** d'un white-label :
  `embedUrl.replace(/vidmoly\.(to|biz|net)/, "vidmoly.biz")` sur une URL voembed
  ne matche rien, mais le reflexe inverse (forcer .biz) 404erait sur un slug qui
  n'y est pas. On sonde l'hote d'origine, comme pour ansembed.
- **Verifie de bout en bout** (page episode -> panneau -> HEAD -> m3u8 -> GET du
  master) sur 3 titres migres : master 200 `#EXTM3U`. Un slug vidmoly.biz mort
  (Naruto ep1) reste correctement masque : HEAD 404 == GET 404.
- **Ne pas generaliser depuis la home** : elle ne montre que les sorties recentes.
  C'est le croisement home (100 % voembed) x `player_map` (96 % vidmoly) qui
  donne la vraie image — une migration en cours, les deux hotes doivent matcher.
- Les autres panneaux voir-anime (MOON = miroirs VOE, Stape, FHD1 = mail.ru, YU,
  SB = streamhide) restent non branches : signales a Luc, pas demandes.

## 2026-08-06 — Episode SPLIT par le lecteur : Re:Zero ep1 VF (01a + 01b -> 49 min)

L'inverse du multi-parties de la veille. Hier : un fichier = plusieurs episodes
(`oped/multipart.py`). Aujourd'hui : plusieurs fichiers = UN episode. voir-anime
decoupe la premiere VF de Re:Zero en `…-01a-vf/` (25:07) et `…-01b-vf/` (24:07),
la VOSTFR non. Luc : « c'est une exception, ce sera le seul ».

### Le chip n'etait pas casse, il etait ABSENT
`buildVoiranimeEpRegex` ancre sur `-<chiffres>` juste avant le slash final, donc
`01a` ne matche jamais. Mesure sur la page live : episodes trouves = **2..25**.
L'episode 1 VF n'a jamais resolu, sur aucun lecteur. Cette invisibilite est aussi
la garantie qu'on garde : aucun autre titre ne peut ramasser une page `-a`/`-b`
par accident, seuls les appelants qui ont consulte la table opt-in les cherchent.

### Table d'exceptions, pas de regle generique (`lib/multipartEpisodes.js`)
Accepter `01a`/`01b` partout recollerait des episodes legitimement separes
ailleurs (specials, recaps, cours splittes). Recoller deux episodes sans rapport
est bien pire que d'en rater un : ca corrompt la timeline, la reprise et chaque
timing OP/ED qui en derive. Une entree = un opt-in a la main.

### Fusion au niveau PLAYLIST, pas dans le lecteur (`lib/hlsMerge.js`)
Le choix structurant. On concatene les playlists HLS (`#EXT-X-DISCONTINUITY`
entre les deux) et on sert un blob: unique. En dessous de `<MediaPlayer>` il n'y
a **rien a savoir** : scrubber, seek, progression, overlay skip voient un fichier
VOD ordinaire de 49 min. L'alternative (enchainement + timeline virtuelle)
obligeait a patcher barre, seek, HoverPreview, VideoStats, progress.ts, download.
L'ABR survit : les variantes sont appariees rang par rang (1080p avec 1080p) et
un master synthetique les liste toutes.

### Le piege : ffmpeg et hls.js ne lisent PAS la meme discontinuite
La playlist fusionnee marche pour le navigateur mais **pas** pour le detecteur.
Le demuxer HLS de ffmpeg ne rebase pas les timestamps de la partie B — mesure sur
les vrais flux :

    playlist fusionnee + EXT-X-DISCONTINUITY   -ss 1600 / 2000 / 2900 -> 0 octet
    .ffconcat + `duration` par entree          -ss 1600 / 2000 / 2900 -> fenetre pleine

Donc deux representations du meme episode : m3u8 fusionne pour le navigateur,
`.ffconcat` pour le bridge. Les directives `duration` sont porteuses deux fois :
sans elles la duree totale est `N/A` et `-sseof` (l'ancrage de la fenetre ED)
ne rend **rien du tout**, silencieusement.

### Deux options ffmpeg qui tuent selon la forme de l'entree
- `-headers` appartient au protocole http. Sur une entree LOCALE ffmpeg la
  resout contre le protocole file, ne trouve rien et abandonne avant d'ouvrir
  le fichier (« Option headers not found »). megaplay contournait deja ca en
  mettant `referer = None` a la main ; c'est generalise (`_input_headers`).
  Verifie au passage : les segments Vidmoly n'ont pas besoin du Referer, le
  token est lie a l'IP.
- Les flags HLS (`-allowed_extensions` …) sont fatals pour le demuxer concat
  (« Option allowed_extensions not found »). D'ou `_hls_flags` en soit/soit,
  partage par audio.py, video_fingerprint.py et detect_anime.py — les trois
  dupliquaient le meme bloc.

### Mesures de bout en bout
- parties trouvees et ordonnees sur la page live : 01a puis 01b
- bridge : `2 parts -> 2954s (1507 + 1447)` = 49:14, la duree de la VOSTFR
- ffprobe a travers le .ffconcat : 2954.106 s ; `multipart.py` en deduit **2 parties**
- fenetres decodees : OP 240 s, partie B 30 s, ED `-sseof -180` 180 s (pleines)
- variantes preservees : 1080p + 480p

Non verifie ici : la lecture navigateur (memoire `no-local-player-testing` — il
faut un vrai flux, donc dev.aniscroll.com). C'est hls.js qui doit avaler la
discontinuite, ce pour quoi la balise existe, mais ca reste a constater.

## 2026-08-05 (4) — Audit complet : 4 bugs corriges, dont 2 qui SERVAIENT du faux

Suite directe de la passe (3). Luc : « on devrait avoir au minimum plus de resultat que
ca et meme si animetheme n'a rien, on peut comparer les episodes donc aucune excuse ».
Feu vert explicite pour toucher au garde-fou F1. En le corrigeant, 3 autres bugs sont
tombes, dont deux qui ne cachaient pas des resultats mais en **fabriquaient**.

### Outil : `_replay_selfref.py` (rejeu hors-ligne de F1)
Le lot ne dit que le verdict (`no repeated segment`), qui confond « rien trouve » et
« trouve puis jete par un garde-fou ». Ce script rejoue `find_segment` sur les
`cache/audio/*.fp.npz` (dont le nom porte deja l'offset absolu de la fenetre) : un anime
deja traite se re-evalue en millisecondes, sans reseau. C'est ce qui a permis d'arbitrer
sur mesure au lieu d'a l'intuition.

### Bug 1 — F1 : accord de POSITION -> accord de LONGUEUR pour l'OP
Confirme sur les 15 anime, pas seulement toradora. Les rejets disaient tous la meme
chose :

    akame-ga-kill  position 2/3 (spread 31s)  MAIS longueur 3/3 [88, 88, 88]
    oregairu       position 1/3 (spread 96s)  MAIS longueur 3/3 [87, 87, 87]
    toradora       position 1/3 (spread 88s)  MAIS longueur 3/3 [87, 91, 91]
    mirai-nikki    position 1/3 (spread 55s)  MAIS longueur 3/3 [87, 87, 87]
    dororo         position 2/3 (spread 48s)  MAIS longueur 3/3 [88, 88, 88]

Des longueurs de generique canoniques, rejetees sur la position. `POSITION_TOLERANCE_S`
devient **ED-only** (ancre depuis la fin, ou elle est pertinente) ; l'OP passe sur
`LENGTH_TOLERANCE_S`. Un OP est un bout de film de longueur fixe : il dure 88 s ou que
le cold-open le pose. Le BGM partage, le faux positif que la garde visait, n'a PAS cet
invariant — il matche aussi longtemps que les deux passages se recouvrent, donc il ne
cluste toujours pas. MIN_SUPPORT, bande 25-150 s, SELF_MIN_VOTES et le stride anti-recap
sont inchanges.

Seuil **calibre**, pas devine (`--tolerance`) : 3 s -> 28 OP, 5 s -> 31, **8 s -> 32**,
12 s -> 32. 8 est le coude : il rattrape noragami (93/88/93 s, un seul generique de 90 s
dont le bord de fondu coute quelques secondes de votes) et au-dela on ne gagne rien.

Rejeu OP : **21 -> 32 recuperes**. ED inchange (42), donc pas de regression.

### Bug 2 — `_consensus` : un « accord » fabrique pouvait etre SERVI
hyouka ep3 annoncait `4/4 d'accord` ET `22.0s spread` sur la meme ligne. Les deux
sortent du meme appel : quand rien ne survit au filtre median, la fonction reintegrait
TOUTES les valeurs et l'appelant stockait `n_hosts_agree = len(values)`. Le commentaire
d'origine le savait (« ne pas lire n_hosts_agree sans le spread »), mais le champ
mentait quand meme.

Et surtout le trou : ce centre fabrique n'etait retenu que par `SERVE_MAX_SPREAD_S=10`.
Deux paires de lecteurs a ~10 s d'ecart (chacune hors de la tolerance de 4 s) passent
sous le plafond et etaient **SERVIES** — sur un timecode qu'aucun lecteur ne produit.
Desormais `_consensus` renvoie un flag `split`, `n_hosts_agree` compte le plus grand
groupe reel, et `hosts_split` interdit le service explicitement. Un 2-contre-2 est une
vraie ambiguite : on ne choisit pas un camp.

### Bug 3 — cohorte de duree : on reconciliait deux oeuvres differentes
bungou-stray-dogs `saison1hs`, durees par lecteur : sibnet 700 s, ansembed 700 s,
megaplay 1451 s, vidmoly-va 1420 s. Anime-sama sert les hors-series de ~12 min ;
megaplay (embed construit sur malId + NUMERO d'episode, aucun signal de saison) et
voir-anime servent les episodes de la serie principale. Mediane = **1060 s, une duree
qu'aucun lecteur n'a**, et toutes les projections ED `from_end` etaient calculees dessus.

`_duration_cohort` ecarte les lecteurs hors cohorte (>15 % d'ecart = autre contenu, pas
autre montage) AVANT toute moyenne, et refuse de reconcilier sur un partage a egalite.
Les durees ESTIMEES (repli F4, 24 min nominales) ne votent pas : sinon elles
fabriqueraient une cohorte rivale contre un vrai court-metrage.

### Bug 4 — `_measure_actual_window_start` etait mort depuis toujours
Il renvoyait `None` sur tous les hosts (« measured win = n/a »), donc la garde ecrite
pour attraper l'erreur d'ancrage de 18 s de la passe (2) n'a jamais pu se declencher.
Cause : `-copyts` n'est pas une option **ffprobe** (c'est ffmpeg), donc ffprobe avalait
`-sseof` comme sa valeur et mourait sur `Option not found` — que le `except` nu
convertissait en None silencieux. En prime ffprobe 8 a supprime `-ss`/`-sseof`. Le seek
passe maintenant par `-read_intervals "<t>%+#1"`, et la conversion d'un depart negatif
demande `ep_dur` (nouveau parametre). Verifie sur fichier local : ED (-180) sur 300 s ->
119.98. Lecon : un diagnostic qui ne peut pas echouer bruyamment est pire que pas de
diagnostic.

### Correctif d'outil
`_report_audit.py` ne compte plus « self-derived, awaiting season confirmation » comme
un signalement : c'est l'etat NORMAL en sortie de detection, seul `season_pass.py`
promeut. 26 des 34 « held » de la passe (3) n'etaient que ca — un run sain paraissait
casse. Nouvelles categories `split` et `content`.

Tests : 65 -> **81 assertions**, dont le faux positif qui doit RESTER rejete (segment
flottant a longueur variable) et le trou de service du bug 2.

### Verification : re-run complet des 15 anime (`out/audit2.jsonl`)
| | avant | apres |
|---|---|---|
| OP servi / retenu / absent | 10 / 8 / **27** | **25** / 14 / **6** |
| ED servi / retenu / absent | 10 / 26 / 9 | **22** / 20 / **3** |

**Attribution honnete — le gros du bond N'EST PAS mon correctif.** F1 ne produit que du
`derived`, or les 47 cellules servies sont TOUTES `credite` (0 derived servi : le gate
DERIVED_REQUIRES_SEASON tient, rien de non valide n'est parti en service). Le passage
de 10 a 25 OP servis vient du chemin AnimeThemes normal. Preuve : F1 a ete invoque
**24 fois au run 1 contre 11 au run 2**, et la phase `themes` est passee de 1183 s a
**2242 s** — le run 1 n'avait tout simplement pas recupere ses references (echecs reseau
silencieux), le run 2 les a telechargees. Le cache AnimeThemes tiede explique la
majorite de l'ecart.

Mesure PROPRE de mon correctif F1, isolee de la variance reseau (rejeu sur cache fige) :
**21 -> 32 OP recuperes**. Effet visible dans ce run : F1 OP recupere 1 fois -> 3 fois
(anohana et dororo passent d'absent a derived-retenu).

Les bugs 2 et 3 ne se lisent pas en gain de couverture, c'est le but : hyouka ep3 ED et
dandadan ep4 OP sont desormais retenus `hosts split into disagreeing groups` au lieu de
risquer d'etre servis sur un centre fabrique ; BSD rend toujours zero, mais pour la
bonne raison (cohortes 700 s vs 1420 s a egalite -> refus de reconcilier) au lieu d'une
moyenne a 1060 s.

ETA backfill : 6.9 -> 6.4 j (16.4 s/episode-lang).

### Reste ouvert
- **vinland-saga (37521)** : OP absent, longueurs [66, 66, 45] — F1 ne cluste pas. Le
  seul vrai trou de couverture restant hors BSD.
- **bungou-stray-dogs (31478)** : probleme de DONNEES, pas de detecteur. `saison1hs`
  n'est pas la meme oeuvre selon la source ; il faut soit ne pas melanger les hosts
  MAL-id sur les hors-series, soit corriger le mapping de saison.
- **18 outliers par lecteur** (jusqu'a +/-45 s sur dandadan) : absorbes par le stockage
  par lecteur, mais dandadan est franchement instable — a regarder si on l'expose.
- La passe `season_pass.py` n'a PAS ete lancee sur ce lot : les 24 `derived` retenus
  restent a promouvoir, c'est la que se joue le reste de la couverture.

## 2026-08-05 (3) — Passe large 15 anime : F1 ne recupere jamais l'OP

Lot demande par Luc pour attraper des erreurs : 15 anime varies x eps 2-4, multi-host,
45 episodes / 90 cellules, 20 min de wall (17.6 s/episode-langue ; ETA backfill complet
~6.9 j). Outil d'analyse : `_report_audit.py` (ne remonte QUE ce qui cloche).

### Resultat brut
| | servi | retenu | absent |
|---|---|---|---|
| OP | 10 | 8 | **27** |
| ED | 10 | 26 | 9 |

9 anime sur 15 n'ont AUCUN OP. Deux (anohana, bungou-stray-dogs saison1hs) ne rendent
rien du tout.

### Cause : le garde-fou de position de F1 rejette le vrai OP
Sur les 7 anime ou l'ED est recupere en auto-reference mais pas l'OP, le log dit
`[self-ref] op: no repeated segment across [2, 3, 4]`. C'est FAUX au sens litteral : le
segment est parfaitement trouve. Mesure sur toradora (fenetre OP, sibnet, cache) :

    ep2 x ep3: 2531 votes, span 86.6s
    ep2 x ep4: 2533 votes, span 86.6s
    ep3 x ep4: 2855 votes, span 95.1s
    positions retenues -> ep2 52.4s | ep3 140.4s | ep4 109.4s (chaque episode
    parfaitement coherent avec lui-meme : ses 2 observations sont identiques)
    cluster a +/-25s -> support 1/3, il en faut 3 -> REJET

`self_ref.POSITION_TOLERANCE_S = 25.0` exige que le segment tombe au MEME endroit dans
>= MIN_SUPPORT episodes. Or la position absolue d'un OP n'est pas stable : elle depend
du cold-open, qui varie de 88 s entre ep2 et ep3 sur toradora. Le garde-fou est ecrit
pour rejeter un segment qui « flotte » (BGM recurrent) — il rejette exactement de la
meme facon un OP legitime. L'ED echappe au probleme parce qu'il est ancre depuis la FIN,
qui est stable : d'ou l'asymetrie parfaite ED-recupere / OP-jamais.

C'est aussi la meme lecon que le faux positif de mon propre outil d'audit, corrige au
passage : j'avais mis un controle « drift » sur le debut absolu de l'OP, il signalait
erased (0:43 / 1:07 / 1:05) alors que ces trois valeurs sont justes. La position absolue
d'un OP ne peut servir NI de controle de coherence, NI de garde-fou.

Piste (NON implementee, a arbitrer) : pour l'OP, remplacer l'accord de position par un
accord de LONGUEUR (le meme generique dure la meme chose : 86.6 / 86.6 / 95.1 ici),
en gardant MIN_SUPPORT, la bande 25-150 s et SELF_MIN_VOTES=150. Toucher a un garde-fou
anti-faux-positif se decide, ca ne se bricole pas.

### Autre chose a regarder
- **hyouka ep3 ED** : retenu pour `hosts disagree (22.0s spread)` alors que la meme
  ligne annonce `4/4 d'accord`. Les deux ne peuvent pas etre vrais — le compteur
  d'accord et le spread ne mesurent pas la meme population.
- **anohana / bungou-stray-dogs** : zero absolu, F1 compris. BSD est en `saison1hs`
  (hors-serie), mapping saison->themes a verifier.
- Ecarts inter-lecteurs stables et fortement votes (toradora sibnet +14 s sur 3 eps,
  noragami megaplay -6 s) = vraies differences d'encode, c'est le stockage par lecteur
  qui les absorbe. En revanche hyouka ep3 fait diverger les 4 hosts dans DEUX sens
  (-8/-8/+14/+14), ce qui ressemble a une vraie erreur.


## 2026-08-05 (2) — OP/ED : passe sur les 6 lecteurs + megaplay corrige (fenetre ED)

Test demande par Luc : `diag_multi_host.py` sur tous les lecteurs affiches.
Resultat : **6/6 resolvent et detectent**, mais la passe a revele un bug megaplay
que la passe precedente ne pouvait pas voir.

### Etat par lecteur (SnK ep3 vostfr + erased ep3 vostfr)
| host | SnK OP | SnK ED | erased ED |
|---|---|---|---|
| sibnet | 0:01-1:30 | 22:25-23:53 | non propose |
| megaplay | 0:17-1:47 | 22:42-24:10 | 21:21-22:46 |
| ansembed | 0:00-1:30 | 22:24-23:51 | 21:19-22:43 |
| vidmoly-va | 0:01-1:31 | 22:42-24:10 | — |
| uqload | 0:00-1:30 | 22:25-23:53 | non propose |
| sendvid | non propose | non propose | 21:21-22:46 |

« non propose » = anime-sama ne liste pas ce host pour cette saison (pas une panne).
Les ecarts d'absolu suivent les durees d'encode (megaplay 24:27 vs 24:11) : c'est
exactement ce que `from_end_*` neutralise cote client.

### Bug corrige : megaplay perdu sur la fenetre ED
Deux defauts en serie, tous deux invisibles jusqu'ici :
1. **`_ffmpeg_decode` (chemin fenetre) ne de-PNG-ait pas megaplay** — seul
   `decode_audio_abs` le faisait. Or c'est le chemin fenetre que `detect_anime`
   appelle. Quand le CDN rotatif sert des segments PNG-wrappes (mesure sur
   `megap.norami.top`), ffmpeg lit un `Video: png` sans audio et le host tombe en
   « fetch failed ». SnK passait parce que SON CDN servait du non-wrappe : le host
   avait l'air sain.
2. **`-ss` de ffmpeg est RELATIF au `start_time` du conteneur** (il ajoute
   `ic->start_time` ; `-seek_timestamp 1` ne l'annule pas en mpegts — mesure). Le
   .ts materialise commence a `start_abs - _LEAD_S`, pas a 0 : passer l'absolu
   seekait au double, au-dela de l'EOF, 0 frame. Ne mordait que les fenetres
   tardives — l'ED. Une fenetre OP (fichier partant de ~0) marchait.

Ajouts : `megaplay.playlist_duration()` (somme des EXTINF) pour ancrer le `-sseof`
negatif sans demuxer, et `audio._container_start()` pour convertir l'absolu en
relatif. `-copyts` garde les pts de SORTIE absolus, donc l'horloge partagee tient.

**Effet mesure** : erased ED megaplay passe de « fetch failed » a 21:21-22:46,
identique a sendvid. Et SnK ED megaplay passe de 22:37 (3162 votes) a **22:42
(4478 votes)** — soit exactement ce que rapporte vidmoly-va, donc l'ancien chemin
donnait deja un resultat legerement FAUX sans le signaler.

### 2e bug, trouve parce que Luc a dit « il y a clairement une erreur »
Le tableau ci-dessus annoncait ED 21:42 pour vidmoly-va sur erased. Verification a
l'image (frames extraites du stream) : derniere scene a 21:19, fondu au noir
21:21-21:24, premier credit « CAST » a 21:28. Donc 21:42 etait FAUX — et l'app,
elle, affichait « Outro » a 21:23, c-a-d juste.

Cause : les DEUX outils de diag (`diag_multi_host.py`, `diag_match.py`) ancraient la
fenetre ED sur le nominal `ep_dur + start_s`. Or `-sseof -180` seeke a la frontiere de
segment AU PLUS TARD egale a EOF-180, puis decode jusqu'a EOF : mesure 197.8s decodes
pour 180s demandes sur le HLS vidmoly de voir-anime. L'ancre nominale etait donc 18s
trop tard, et poussait chaque timestamp ED de +18s. `theme_bank._abs_offset` faisait
DEJA la correction (ancre = EOF - duree reellement decodee) — c'est le chemin de prod ;
seuls les outils de diag mentaient. Le matcher n'a jamais ete en cause.

Corrige : `_window_offset()` dans diag_match.py, partage par diag_multi_host.py.
Apres correction, les 4 hosts d'erased s'accordent (21:21 x3, 21:24 pour vidmoly-va
dont l'encode a +7s) et SnK ne bouge quasiment pas (ses hosts decodent bien 180s).

A noter : `_measure_actual_window_start`, ecrit exactement pour attraper ce genre
d'ecart, renvoie None sur tous les hosts (colonne « measured win » = n/a) — le
garde-fou etait mort, personne ne l'a vu. Reste a reparer.

### Piege releve
Le slug voir-anime a change : `shingeki-no-kyojin-vostfr` 404, c'est
`shingeki-no-kyojin` (sans suffixe de langue). Un `--va-slug` perime ressemble a
un host en panne.

`test_guards.py` : 65 assertions vertes.


## 2026-08-05 — OP/ED : 4 lecteurs au lieu d'1 (megaplay, ansembed, DNS box)

Parti d'une question de Luc (« quel lecteur as-tu mesure ? »), fini sur trois bugs
distincts qui se masquaient l'un l'autre. Verification de depart : sur sibnet notre
ED SnK ep1 (23:55 -> 25:24.9) est JUSTE, verifie en extrayant les frames (23:50
derniere scene, 23:55 fondu au noir, 24:00 visuels de l'ED, 25:20 generique, 25:28
preview). Le 24:05 observe par Luc venait d'un AUTRE encode (voir-anime/vidmoly).

### 1. Le pont n'expliquait jamais un echec (commit 1e75bf0)
`out.errors` n'etait affecte que dans `episodes.length > out.episodes.length`. Un
host resolvant ZERO episode (0 > 0 = faux) voyait ses raisons JETEES : l'echec
total, le cas qui demande le plus d'etre explique, etait le seul a n'expliquer
rien. D'ou le `resolution failed: []` uniforme, deja note comme non diagnosticable
le 29/07. Les erreurs s'accumulent maintenant, prefixees par host, et `pickArray`
vide dit « not offered by anime-sama for this season » (absence de donnee != panne).

### 2. megaplay muet depuis une rotation de CDN (commit cf6e76c)
`is_megaplay()` reconnaissait le stream sur une liste FIGEE de domaines CDN ; le CDN
est passe a `megap.shiora.top`. La branche de-PNG etait donc court-circuitee, ffmpeg
lisait la playlist brute — dont les premiers segments sont des PUBS au format PNG —
concluait `Video: png` sans audio, et ne sortait rien. Zero erreur, zero hit. Le
commentaire du code disait deja « its CDN hosts rotate ». **Le REFERER
(`https://megaplay.buzz/`) est le signal stable**, pas le hostname du CDN.

### 3. Le DNS de la box bloque en IPv6 seulement
`uqload.is` et `vidmoly.net` -> `::1` via le resolveur IPv6 de la box Bouygues,
alors que l'IPv4 (8.8.8.8) rend les vraies IP Cloudflare. Le fichier hosts est vide,
ce n'est pas un blocage local. L'app n'est pas affectee (Worker + proxy.aniscroll),
seul l'outil local tape ces domaines en direct. **Non corrige** : changer le DNS
IPv6 de l'interface demande l'elevation. Commande a passer en admin :
`Set-DnsClientServerAddress -InterfaceAlias "Ethernet 2" -ServerAddresses ("2606:4700:4700::1111","2606:4700:4700::1001")`.

### 4. Ansembed implemente (commit 3e4db04) — app + detecteur
anime-sama liste 5 lecteurs pour SnK S1 (sibnet, ansembed, uqload, embed4me,
minochinos) et on n'en exploitait que 2. **ansembed.net EST vidmoly** sous domaine
white-label (meme page, meme master.m3u8) mais c'est une entree anime-sama distincte
avec ses propres uploads -> un encode de plus. Host `ansembed` PROPRE, pas un alias
de `vidmoly` : partager les lignes servirait le timing d'un encode sur l'autre.
**Bonus** : ansembed.net n'est pas dans la liste de blocage de la box, donc
l'extraction vidmoly-va remarche en local via ce miroir.

Resultat SnK ep1 VOSTFR, de 1 lecteur exploitable a 4 :
```
sibnet     OP 2:03.0  ED 23:55.0  image
ansembed   OP 2:03.2  ED 23:55.2  image
vidmoly-va OP 2:03.8  ED 24:05.7  image   <- l'encode que Luc regardait
megaplay   OP 2:19.6            audio   <- encode +16.6s en tete
```
Consensus OP 3/4 spread 0.77s, ED 2/3 spread 0.17s : les deux servis.

### Calibration corrigee par ces donnees reelles
- `peak_margin` mesure **0.001-0.005** sur des matches corrects (seuil 0.6) et
  `av_delta` **4 a 66 ms** quand les deux signaux s'accordent (seuil 4s) : enormement
  de marge, les gardes ne peuvent pas mordre sur un vrai positif.
- **`av_divergence` ne bloque plus un hit dont le timing vient de l'IMAGE.** Sur
  ansembed l'audio etait a 12.6s d'un ancrage image que 3 autres hosts confirment a
  0.2s pres : bloquer aurait jete un intervalle correct au nom du signal qu'il venait
  de corriger. Reste rapporte en consultatif (`audio_diverged`).
- `SERVE_MAX_SPREAD_S` valide sur du reel : megaplay a 16.6s d'ecart en tete est
  exclu du consensus (3/4) au lieu de le polluer.
- `align_status` distinguait mal « l'image n'a rien dit » de « l'image n'a pas
  confirme » (commit b3e7b39) — les deux retombaient sur `absent`.

### 5. DNS corrige (05/08, machine de Luc) — 5 lecteurs
`Set-DnsClientServerAddress -InterfaceIndex 19 -ServerAddresses ("2606:4700:4700::1111","2606:4700:4700::1001")`
en PowerShell ADMIN (l'IPv4 etait deja sur 8.8.8.8 ; c'est le resolveur IPv6 de la box
qui sinkholait vers `::1`/`127.0.0.1`). Verifie au prealable que la box n'intercepte
PAS le port 53 : une requete explicite vers 8.8.8.8/1.1.1.1 rendait deja les vraies IP.

uqload devient extractible et concorde parfaitement. Etat final SnK ep1 VOSTFR :
```
sibnet     OP 2:03.0  ED 23:55.0  image
ansembed   OP 2:03.2  ED 23:55.2  image
uqload     OP 2:03.2  ED 23:55.2  image
vidmoly-va OP 2:03.8  ED 24:05.7  image   <- encode different (ED plus tard)
megaplay   OP 2:19.6            audio   <- encode +16.6s en tete, pas d'ED
```
Consensus OP 4/5 (spread 0.77s) et ED 3/4 (spread 0.17s), les deux SERVIS.

### A retenir
Le risque de cette couche n'est pas dans la logique de decision (65 tests hors-ligne
verte des le depart) mais dans le **cablage** et dans les **listes figees** (domaines
CDN, listes de hosts) : c'est ce que seul un run reel expose. Trois des quatre bugs
de cette session sont de cette famille.

## 2026-08-04 (suite 4) — OP/ED : couche de replis (F) + garde-fous faux positifs (P)

Demande : « il nous faut énormément de fallback, par ex si l'OP/ED fourni n'est pas
du tout le même que ce qu'on a ; et des vérifications pour ne pas avoir de faux
positifs ». Fait : tous les F sauf F6 (AniSkip, écarté), tous les P.

### Les deux principes qui structurent la couche
- **Rien n'est jamais déplacé.** Un hit douteux est retenu ou signalé, jamais
  « corrigé » en un timing inventé. Les raisons vivent dans `oped/validate.py` ;
  celles de `validate.BLOCKING` empêchent de servir, les autres sont consultatives.
- **L'accord entre lecteurs n'est PAS une preuve d'exactitude.** Tous les hosts
  passent la MÊME référence dans le MÊME matcher : ils reproduisent la même erreur.
  C'était le trou central. Les deux preuves réellement indépendantes sont l'IMAGE
  (par épisode) et la SAISON (par titre).

### Replis
- **F1 auto-référence ep↔ep** (`oped/self_ref.py`) — le cas « le thème fourni n'est
  pas le nôtre » : l'OP/ED est récupéré comme le segment qui SE RÉPÈTE entre
  épisodes, puis découpé du fingerprint déjà calculé (`slice_fingerprint`) → **zéro
  décodage supplémentaire**, et ça redevient une `ThemeReference` ordinaire que tout
  le pipeline existant consomme. Anti-recap : échantillonnage **stridé** (ep 1,4,7…)
  — un recap ne se répète qu'entre épisodes ADJACENTS, il ne peut donc pas voter.
  Tout hit dérivé est retenu jusqu'à confirmation par la passe saison.
- **F2** fenêtre ED élargie (240→420 s de fin), **F3** repli sur le pool de thèmes
  quand le mapping direct échoue (le champ `episodes` d'AnimeThemes est souvent
  décalé d'un épisode autour d'un OP1→OP2), **F4** durée estimée depuis les pairs
  quand ffprobe échoue (l'OP est servi, l'ED retenu — son ancre dépend de la durée),
  **F5** `min_fill` relâché mais seulement si l'image confirme, **F7** prédiction
  intra-saison des trous.
- **F6 (AniSkip) volontairement non fait** : écarté comme source, et comme
  validateur il aurait ajouté une dépendance réseau pour une couverture faible.

### Vérifications
- **P2 pic rival** : `best_match_ranked` sort le rapport de votes du meilleur offset
  concurrent dans la MÊME passe (coût nul). Une chanson qui se rejoue produit deux
  pics — c'est la cause RACINE du faux positif cyberpunk, qui n'était jusqu'ici que
  mitigé par `inferred`.
- **P4** : `av_delta` mesuré dès que audio et image ancrent tous les deux
  (`video_disagreement` était déclaré depuis le début mais **jamais posé en v2**) ;
  `align_status` distingue enfin « l'image a rejeté » (preuve CONTRE) de « l'image
  n'a rien dit » (aucune info) — les deux finissaient en `source="audio"`.
- **P5 cohérence intra-saison** (`season_pass.py`), le plus fort et le plus délicat.
  **Par clusters, pas par médiane** : la position de l'OP est légitimement bimodale
  (cold-open ou non selon l'épisode), une médiane tomberait entre les deux modes et
  signalerait la moitié de la saison. **ep1 et dernier épisode exemptés** (piège
  signalé par Luc : beaucoup d'animes placent le premier OP très loin dans l'ep1 —
  c'est normal, jamais une anomalie). Une saison trop dispersée ne rend AUCUN verdict
  plutôt qu'un faux.
- **P3, décision assumée** : `low_confidence` est remonté partout mais n'est PAS
  bloquant. SnK ep1 OP (2:02, correct) est un hit audio-seul : le bloquer coûterait
  de la couverture réelle. C'est la passe saison qui arbitre les audio-seuls.

### Ordre d'exploitation (la passe saison est OBLIGATOIRE avant import)
```
python batch_detect.py … --multi-host --out results.jsonl
python season_pass.py --in results.jsonl --out results.checked.jsonl --report
node scripts/import-oped-host-skips.mjs --in=results.checked.jsonl
```
Elle promeut les hits `derived` et retire les outliers. L'importeur jetait déjà tout
`serve:false` : les nouveaux blocages arrivent donc en DB sans le toucher.

### Vérifié / non vérifié
- `python test_guards.py` : **65 assertions vertes, hors-ligne** (ni réseau ni
  ffmpeg) — plausibilité, pic rival, slicing, découverte de segment + anti-recap,
  gate `serve`, passe saison (dont les deux pièges ep1/bimodal), et la cascade v2 de
  bout en bout sur audio synthétique.
- **NON vérifié** : aucun run réseau réel depuis ces changements. Les seuils
  (bandes de longueur, 0.6 de pic rival, 12 s de tolérance de cluster) sont raisonnés,
  pas calibrés sur des mesures — à confronter à un vrai batch avant backfill.

## 2026-08-04 (suite 3) — CORRECTION de l'entrée précédente : Vercel va bien, seul le Worker est muet

**L'entrée « suite 2 » ci-dessous est FAUSSE sur son point principal.** Je l'ai
laissée telle quelle plutôt que de la réécrire, parce que l'erreur de méthode est
plus instructive que le diagnostic.

### Ce que j'avais conclu (à tort)
Que `bug_reports` (écrit par Vercel) et `user_analytics` (écrit par le Worker)
s'étant arrêtés à 26 h d'intervalle, le facteur commun était forcément le couple
`TURSO_ADMIN_*`, périmé des deux côtés. J'ai écrit « c'est étanche ».

### Ce que dit le test
Un POST réel sur `/api/v2/admin/bug-report` en prod : **`{"message":"Report
received","id":39}` — HTTP 200.** La ligne est apparue dans la base lue en local
(donc même base), puis supprimée. Vercel écrit parfaitement dans la base ADMIN.

`bug_reports` s'arrêtait au 10/07 pour la raison la plus bête : **personne n'a
envoyé de rapport depuis**. 38 rapports en six semaines, très irréguliers
(28/06, 29/06, 07/07, 09/07, 10/07) — un trou de 25 jours n'a rien d'anormal à ce
rythme. J'ai pris une coïncidence pour une corrélation, sur un échantillon de deux.

### Ce qui reste vrai
`user_analytics` est bien morte depuis le **11/07 21:14**, et le Worker en est le
**seul** écrivain depuis le 4-5/07. Le problème est donc entièrement côté
Cloudflare — secrets propres, configurés par `wrangler secret put`, indépendants
de ceux de Vercel. Non vérifiable d'ici : wrangler exige un `CLOUDFLARE_API_TOKEN`
en session non interactive. À faire à la main :
`wrangler secret list`, puis `wrangler secret put TURSO_ADMIN_TOKEN` /
`TURSO_ADMIN_URL`, redéployer, et vérifier `GET /w/status`.

Les correctifs d'observabilité du Worker (commit 1dcfb0c) restent entièrement
valables : c'est justement parce que tout y était muet que j'ai dû deviner.

### La leçon
Deux séries temporelles qui s'arrêtent en même temps ne partagent pas forcément
une cause — surtout quand l'une est un flux continu (50-110 lignes/jour) et
l'autre un événement rare (moins d'un par jour). **Il fallait tester le chemin
d'écriture avant de conclure**, ce qui coûtait une requête curl. Le DEVLOG du
01/07 disait déjà « ne pas surinterpréter une capture » ; ici c'était deux dates.

---


## 2026-08-04 (suite 2) — ⚠️ ENTRÉE ERRONÉE (voir la correction en suite 3) — la base ADMIN n'est plus écrite depuis la prod (11/07)

Trouvé en cherchant « ce qui reste à faire » : ce n'est pas de la perf, c'est une
panne de production silencieuse depuis presque quatre semaines.

### Le constat
Deux chemins d'écriture **indépendants** vers la base Turso ADMIN se sont
arrêtés à 26 h d'intervalle :

| table | écrite par | dernière écriture |
|---|---|---|
| `bug_reports` | route Vercel `/api/v2/admin/bug-report` | **2026-07-10 19:03** |
| `user_analytics` | Worker Cloudflare `/w/track` | **2026-07-11 21:14** |

`user_analytics` tournait à 50-110 pages vues/jour (12 443 lignes) puis plus rien.

### Le diagnostic
Le facteur commun n'est ni Vercel ni Cloudflare : c'est le **couple
TURSO_ADMIN_URL / TURSO_ADMIN_TOKEN**, configuré séparément des deux côtés.
Éléments qui verrouillent la conclusion :

- La base **MAIN** (`TURSO_DATABASE_URL`, creds différents) est écrite depuis la
  prod **aujourd'hui** (`player_map.checked_at` = 04/08 06:41). Donc Turso n'est
  pas en panne et la prod tourne.
- Le token ADMIN de `.env.local` **lit la base sans problème** → le token a été
  renouvelé en local lors d'une rotation, mais **ni Vercel ni Cloudflare** n'ont
  reçu le nouveau.
- Aucun changement de code sur le chemin de report à cette date. Le seul commit
  proche (0fc9f23, 07/07, refonte des notices) est écarté : des rapports sont
  arrivés les 9 et 10 juillet APRÈS lui.

### Ce que ça casse, en silence
1. **Les rapports de bug ne sont plus enregistrés.** La route renvoie un 500 à
   l'utilisateur — bruyant pour lui, muet pour nous. Le bouton report est notre
   seul canal de remontée : on est aveugles depuis un mois.
2. **Analytics visiteurs mortes.** C'est aussi la seule qui voit l'IP → la
   modération / le bannissement d'IP travaille à l'aveugle.
3. `banned_ips` est vide et ne peut pas être écrite.

### À faire (côté dashboards, pas côté code)
Repousser le token ADMIN courant dans les deux environnements :
`vercel env` pour `TURSO_ADMIN_URL`/`TURSO_ADMIN_TOKEN`, et
`wrangler secret put TURSO_ADMIN_TOKEN` pour le Worker. Puis vérifier
`GET /w/status` (nouveau) et guetter une ligne fraîche dans `user_analytics`.

### Corrigé côté code : la cécité
Le token, je ne peux pas le voir. Mais la panne était **inobservable**, et c'est
ça le vrai défaut. Dans le Worker (`worker/src/edge-endpoints.js`) :
- config absente renvoyait un `{ok:true}` nu, identique à une écriture réussie
  → `{ok:true, stored:false, reason:"unconfigured"}` + `console.error` ;
- le `.catch(() => {})` avalait TOUT, y compris le 401 d'un token expiré — le
  mode de panne exact qu'on vient de vivre. On n'échoue toujours jamais, mais on
  logge : visible dans `wrangler tail` ;
- nouveau `GET /w/status`, lecture seule, booléens uniquement (jamais les
  secrets), constatable d'un `curl`.

**Leçon** : un chemin fail-open sans log est un chemin qui meurt sans témoin.
Tout `.catch(() => {})` sur une écriture doit au minimum logger.

### Autres tables — état des lieux
Passe de fraîcheur sur les deux bases :
- Saines : `anime` (22 533, 0 j), `season_cache` (31 380, 0 j), `player_map`
  (3 484, 0,3 j), `fribb_map` (20 693, 1,3 j), `anime_fanarts` (123 339, 4,3 j).
- **`oped_skips` = 0 et `oped_host_skips` = 0**, `skip_episodes` = 1 ligne. Tout
  le travail du détecteur d'OP/ED n'a **jamais été importé en base** — l'endpoint
  `/api/v2/skip` (718 invocations/12 h) retombe donc systématiquement sur
  AniSkip. Le TODO de l'importeur JSONL→DB (noté au 01/07) est toujours ouvert.
- `tmdb_stills_cache` : 10 lignes, 18 j. Vestige — TMDB est banni comme provider
  depuis le 03/08, Simkl est la seule source de vignettes. Table à supprimer.

---

## 2026-08-04 (suite) — Passe de propreté : deps mortes, duplication, pages statiques

Suite de la passe de perf. Cette fois la question était « que reste-t-il de sale,
en double ou mal pensé ». Plusieurs trouvailles dépassent la cosmétique.

### ⚠️ cheerio n'était pas déclaré
`pages/api/v2/source/index.js` — le cœur de la résolution vidéo — importe
`cheerio` directement, mais il **n'était pas dans package.json**. Il n'arrivait
que comme dépendance transitive de `@consumet/extensions`, un paquet git que
l'application n'importe nulle part. Supprimer cette dépendance morte (ce qui
paraissait totalement anodin) aurait cassé la fonctionnalité principale du site
sans le moindre avertissement au build. Déclaré explicitement avant toute
suppression. **Leçon : avant de retirer une dépendance inutilisée, vérifier ce
qu'elle traîne derrière elle.**

### 10 dépendances mortes retirées
Aucun import dans tout le dépôt, et aucun paquet installé ne les déclare en peer
(vérifié par script sur node_modules) : `@consumet/extensions` (dépendance git,
clonée à chaque install), `@tensorflow/tfjs-node` (module natif — c'est LUI qui
fait échouer `npm install` en local sans toolchain C++), `nsfwjs`, `media-icons`,
`workbox-webpack-plugin` (déjà une vraie dep de next-pwa), `cron`, `graphql`,
`i18next-browser-languagedetector` et `react-use-draggable-scroll` (ces deux-là
n'apparaissaient que dans des commentaires expliquant qu'on ne les utilise
volontairement PAS), `disqus-react`. `onnxruntime-node` déplacé en devDeps (seul
scripts/classify-fanarts.mjs s'en sert).

`tailwindcss-animate` a bien failli y passer aussi : absent des 60 premières
lignes de tailwind.config.js, il est en fait bien dans `plugins`. **C'est le
build qui l'a rattrapé** — d'où l'intérêt de rebuilder après chaque lot.

### 4 pages passées de serverless à statique
En typant un composant partagé, TypeScript a sorti ce que les fichiers `.js`
cachaient : **`<MobileNav>` n'accepte pas de prop `sessions`** — il lit la
session lui-même via `useSession()`. Or popular, trending et recent appelaient
`getServerSession` dans getServerSideProps *uniquement* pour alimenter cette
prop morte. recently-watched, elle, lisait la session… mais seulement dans des
effets client. Les quatre pages sont maintenant ○ (statiques, CDN) au lieu de ƒ :
plus aucune invocation Vercel par vue.

### Duplication
- **popular.js et trending.js étaient le même fichier** (147 et 145 lignes) à la
  clé de tri, deux clés i18n et une meta près → components/anime/CatalogGrid.
  Un `mt-5` parasite sur le bouton de trending était de la dérive, pas une
  intention.
- **getClientIp existait en 3 exemplaires divergents**, et l'écart comptait :
  deux copies ne gardaient pas contre un `x-forwarded-for` vide et renvoyaient
  `""`. Comme bug-report conditionne son anti-spam par IP à `if (ip)`, une
  chaîne vide **désactivait le contrôle**. → lib/net/clientIp.
- **setEdgeCache** redéfini dans 3 handlers → lib/http/edgeCache. Ces en-têtes
  décident si une requête est facturée en Edge Request : un seul endroit.
- **`convertSecondsToTime` existait en double avec DES SORTIES DIFFÉRENTES**
  (2 unités vs 4 avec les secondes). Substituer l'une par l'autre aurait changé
  le compte à rebours de la home. Les deux vivent maintenant dans getTimes, la
  compacte renommée `formatCountdownCompact`. **Un nom identique pour deux
  comportements, c'est comme ça qu'on « corrige » l'un en cassant l'autre.**
- listEditor importait `inputToFuzzy as toFuzzy` ET redéfinissait sa propre copie
  identique sous le vrai nom — deux appels utilisaient l'une, deux l'autre.
- `getCurrentSeason` de footer.tsx : copie mot pour mot de utils/getTimes.

### Fichiers morts supprimés
components/anime/{charactersCard.js (2023), episode.js}, components/anime/mobile/
(topSection + reused/, tout le dossier), utils/getRedisWithPrefix.ts (2024),
components/disqus.tsx — ce dernier accompagné d'une prop `disqus` que la page
watch calculait, sérialisait dans les props SSR de CHAQUE épisode et
déstructurait sans jamais l'utiliser.

`components/home/content.tsx` coexistait avec un dossier `components/home/content/`,
et content.tsx importait `./content/historyOptions` — un fichier important depuis
un dossier portant son propre nom. Aplati.

### Volontairement PAS touché
- **`components/shared/{AnimeCard,RankingBadge,StatusPill}.tsx`** : importés
  nulle part, mais créés ensemble le 2026-04-28 et jamais câblés depuis. Ça
  ressemble à un design system amorcé — c'est un choix produit, pas du code mort
  évident. (Note : AnimeCard a reçu l'optimisation d'images de la passe
  précédente avant que je réalise qu'il était orphelin.)
- **`pages/api/v2/source/index.js`** (3129 lignes) duplique `fetchWithTimeout` et
  `fetchViaWorker` avec lib/extractors.js. C'est le fichier le plus critique du
  site et le player ne se teste pas en local (cf. no-local-player-testing) :
  refactor à faire avec une vraie session de test sur dev, pas à l'aveugle.
- **components/admin/{dashboard,reports}** partagent 4 fonctions identiques
  (fetchReports, handleResolved, handleTogglePending, openImageInNewTab). Page
  admin, trafic nul, aucun impact perf → pas prioritaire.
- **Page watch (91,9 kB)** : ReportModal / RateModal / WatchPartyPanel montés en
  permanence. ReportModal se splitte proprement (`<Transition appear>` de
  headlessui), mais **RateModal anime son ouverture en CSS depuis l'état monté**
  — le gater sur le montage lui ferait perdre son fondu.

---

## 2026-08-04 — Passe de perf : bundle, images, code splitting, scroll

Point de départ : « le site est très laggy ». Tout a été mesuré au build, pas
supposé — et le build lui-même était cassé, ce qui a été la première trouvaille.

### Le build ne passait plus (et personne ne le voyait)
`tsconfig.json` avait `exclude: ["node_modules"]`, qui n'exclut QUE le
node_modules racine. Avec `include: ["**/*.ts"]`, tsc avalait donc
`worker/node_modules` (125 Mo, typings wrangler + workerd) et les caches de
scraping sauvegardés en `.ts` sous `tools/`. Le build mourait en OOM au-delà de
**12 Go** de heap, en phase « checking validity of types ». Excludes explicites
→ build complet en **71 s**. À retenir : `"node_modules"` seul est un piège dès
qu'un sous-projet a ses propres deps.

### Bundle : shared 247 → 201 kB, _app 138 → 91,6 kB
- **framer-motion vivait dans `_app`** pour un unique fade d'opacité 0→1 — donc
  dans le chunk partagé de TOUTES les pages. Remplacé par un keyframe CSS
  (`.as-fade-in` dans globals.css). Même chose pour les wrappers purement
  décoratifs de about / my-list / profile / settings, et pour search où
  l'animation tournait **par carte de résultat**. framer-motion ne reste que
  sur home et schedule, où il anime réellement quelque chose (carrousel héros).
- **Les deux locales étaient bundlées** dans `_app` : chaque visiteur
  téléchargeait ~48 kB de traductions qu'il ne lirait jamais. Seule la locale
  par défaut (celle du SSR) reste bundlée ; l'autre arrive via `ensureLanguage()`
  dans son propre chunk, dont le fetch part à l'évaluation du module pour
  recouvrir l'hydratation. `I18nProvider` l'attend avant `changeLanguage`, donc
  on ne bascule jamais sur une langue dont les chaînes ne sont pas là.
  `partialBundledLanguages: true` est requis côté i18next.

### Images : la vraie cause du scroll qui saccade
`images.unoptimized: true` (volontaire, pour ne pas payer les transformations
Vercel) veut dire que l'URL passée à `<Image>` est **littéralement** ce que le
navigateur télécharge et décode. Or presque tous les appelants prenaient
`coverImage.extraLarge`, y compris les cartes de 135-180 px. Mesuré :

| variante | segment d'URL AniList | taille | poids |
|---|---|---|---|
| extraLarge | `/cover/large/` | 460×636 | 83,8 kB |
| large | `/cover/medium/` | 230×318 | 28,8 kB |
| medium | `/cover/small/` | 100×138 | 9,7 kB |

Sur une home d'une soixantaine de posters : ~5 Mo et ~18 Mpx à décoder contre
~1,7 Mo et ~4 Mpx. Les trois variantes ne diffèrent que par ce segment, donc
`lib/images/cover.ts` **dérive** la bonne taille de celle qu'on a reçue —
aucune query GraphQL à changer (le batch de la home ne demande QUE extraLarge),
aucun payload en plus, et les URL non-AniList passent intactes. Le helper
remplace au passage l'échelle `extraLarge || large || medium` recopiée dans une
dizaine de composants. Laissé en `full` là où l'image est réellement grande :
héros, poster de fiche, grille de recherche, deck discover.

### Code splitting de la fiche anime : 53,2 → 9,1 kB de JS de page
Les onglets étaient déjà montés à la demande mais **importés statiquement** :
tout le monde téléchargeait Episodes (le plus gros composant de l'app),
ScoresTab, CharactersTab et Artworks pour n'afficher qu'Overview. Pire, la page
embarquait InfoPage (desktop) ET InfoPageMobile alors que la branche est connue
dès le SSR via l'useragent. Chacun est passé en `next/dynamic` (ssr:true — rien
n'est browser-only, un onglet restauré depuis le hash d'un lien partagé doit
rendre côté serveur). L'overlay RelationsGraph n'est monté qu'à la première
ouverture, avec un montage **collant** (pas lié à `open`) pour qu'un graphe
rouvert garde son pan/zoom, exactement comme quand il restait monté.
299 → 212 kB de first load.

### Scroll
- **Navbar** (sur quasi toutes les pages) : elle stockait l'offset brut, donc un
  setState et un re-render de tout le composant à chaque événement de scroll,
  alors que seuls **deux booléens** en sont dérivés. Calculés dans le handler,
  coalescés en rAF, setState uniquement quand un booléen bascule.
- Bug trouvé au passage : `scrollPosition?.y ?? 0 >= 180` se parse en
  `scrollPosition?.y ?? (0 >= 180)`, soit « y est-il non nul » → le bouton
  « haut de page » apparaissait après 1 px de scroll, pas 180.
- **Scroll infini** : le même useEffect copié-collé dans 4 pages, lisant
  `document.body.offsetHeight` dans le handler (reflow synchrone forcé à chaque
  scroll, sur les pages au DOM le plus long). Chaque copie appelait aussi
  `removeEventListener` depuis l'intérieur du handler, en doublon du cleanup —
  et ce mécanisme cessait silencieusement de marcher dès que l'effet se
  ré-exécutait. Factorisé dans `lib/hooks/useInfiniteScroll`.

### Résultat (first load JS)
| route | avant | après |
|---|---|---|
| shared / `_app` | 247 / 138 kB | **201 / 91,6 kB** |
| `/en/anime/[...id]` | 299 kB | **212 kB** |
| `/en/anime/watch/[...info]` | 341 kB | **296 kB** |
| `/en/settings` | 256 kB | **209 kB** |
| `/en/anime/popular` | 230 kB | **184 kB** |

### Pistes restantes
- Page watch encore à 91,9 kB de JS de page : ReportModal / RateModal /
  WatchPartyPanel sont montés en permanence et se contentent de se cacher —
  mêmes candidats que RelationsGraph. Attention : RateModal anime son ouverture
  en CSS depuis l'état monté, donc le gater sur le montage lui ferait perdre son
  fondu (contrairement à ReportModal qui utilise `<Transition appear>` de
  headlessui et supporte le montage tardif).
- `tailwindcss-animate` est en devDependency mais **absent des plugins** de
  tailwind.config.js → dépendance morte.
- `components/home/content.tsx` coexiste avec un dossier `components/home/content/`
  (un seul fichier dedans, historyOptions.js). Résolution ambiguë à l'œil nu,
  piège pour la prochaine personne.
- Vérifier en vrai sur dev.aniscroll.com : bascule FR (le chunk de locale arrive
  maintenant en différé) et onglets de la fiche anime.

---

Journal des modifs de dev, pour garder le contexte entre les sessions (survit aux `/clear`).
Ordre anti-chronologique (le plus récent en haut). Une entrée = une session/sujet, avec **décisions** et **leçons/pièges**, pas juste les commits (git les a déjà).

> Convention : dates absolues. Branche de travail = `dev` (push auto, voir mémoire). Le Worker Cloudflare se déploie **à la main** (`cd worker && npx wrangler deploy`) — un `git push` ne le déploie pas.

---

## 2026-08-03 (suite 3) — Audit usage Vercel : le plus gros poste de coût était notre propre cron

Parti de la doc « manage and optimize usage ». La doc elle-même n'apporte presque rien (c'est un
guide de dashboard), mais **mesurer** a renversé trois conclusions successives.

### Méthode (à réutiliser)
- `npx vercel logs https://aniscroll.com --json` sur ~40 min → tableau path × source × cache.
  C'est le seul instrument qui donne la répartition réelle ; l'Observability donne l'Active CPU
  par route, la page **Usage** donne les barres d'allotment. Les trois sont nécessaires.
- ⚠️ **Ne jamais extrapoler une fenêtre de 12 h Production vers le mois** : j'ai projeté 66 K
  invocations, la vraie barre en disait **256 K** (×4). La page Usage compte *tous* les
  environnements, previews `dev` comprises, et une fenêtre courte tombe dans un creux.

### Le vrai coupable : `warm-cache.yml`
Le step « Run page warmer » (`scripts/warm-cache.mjs`) parcourait **chaque `/en/anime/{id}`** tous
les jours depuis un runner GitHub (datacenter US). Conséquences mesurées :
- **56,4 % des Edge Requests sur le PoP Cleveland** contre 15,6 % Paris → il réchauffait un edge
  que personne ne consulte. Un cache CDN est **par PoP** : warmer depuis les US ne sert pas les FR.
- `/en/anime/[...id]` = 1ʳᵉ route en Active CPU (54 s/12 h) **et 1,2 % de hit CDN** — chaque id
  marché est une clé de cache distincte, rendue à froid, jetée.
- ~170 KB de HTML SSR par page droit dans le **Fast Origin Transfer** (quota Hobby = 10 GB, on
  était à 40 %).
- **Et il n'atteignait pas son but** : un `fetch()` Node ne parse pas le HTML et ne charge aucune
  sous-ressource — il ne pouvait donc pas faire ingérer un seul fanart au Worker. Le vrai
  réchauffage d'images, c'est `warm-images.mjs`, qui tape `fanart-proxy` en direct.
→ Step passé en `if: github.event_name == 'workflow_dispatch'`. Le schedule ne fait plus que les images.

### Leçons
- **Un Edge Request est facturé sur un HIT comme sur un MISS.** Donc `s-maxage` réduit les
  invocations mais **pas** la barre Edge Requests (la plus haute : 420 K/1 M). Le seul levier sur
  celle-ci, c'est de **ne pas émettre la requête** : `max-age` navigateur, et SW en `CacheFirst`.
- **Le `s-maxage` ne sert à rien sur une route à longue traîne à faible trafic.** `/en/anime/{id}`
  a `s-maxage=21600` et 1,2 % de hit : 15 requêtes = 15 ids distincts, zéro répétition. À
  l'inverse `/en/manga/[...id]`, qui n'a **aucun `getServerSideProps`**, est à 94,4 %. C'est le
  mode de rendu qui décide, pas le TTL.
- **Fluid ne facture pas l'attente I/O** : `/api/v2/source` est la route la plus invoquée (341)
  mais seulement 29 s d'Active CPU — scraper des hosts morts ne coûte quasi rien. J'avais dit le
  contraire avant de mesurer.
- Le SW interceptait **tout** `/api/` en `NetworkFirst` avec `maxEntries: 16` → chaque GET repartait
  au réseau et le peu de cache était évincé avant réutilisation.

### Fait
- `warm-cache.yml` : page-walk en dispatch-only.
- `pages/api/og.tsx` : **4,5 s d'Active CPU par appel** (23 % du budget mensuel pour 8 appels) —
  rendu 1800×945 ramené à 1200×630 via une constante `SCALE` (revert = une ligne). Le blur du
  bandeau est l'opération dominante de resvg. Meta `og:image:width/height` synchronisées.
- SW : nouvelle règle `CacheFirst` (`apis-static`, 256 entrées) pour skip/themes/episode-scores/
  changelog-popup/changelog/banner-tone/fanarts ; `apis` passe de 16 → 64 entrées.
- `max-age` navigateur 60 s → 300 s sur catalog / discover / etc-recent / episode (les 2 sorties).
- `changelog-popup` : 300 s → 3600 s (il était à 7,5 % de hit — 5 min est plus court que
  l'intervalle entre deux visiteurs).
- `Tabs.tsx` : **suppression du prefetch idle de `/api/v2/episode-scores`** — il partait à chaque
  chargement de page pour un onglet que peu ouvrent. Les onglets ne montent que sur clic.
- `lib/db/fanarts.ts` : `slimFanartsForSsr()` retire `label`/`nsfwScore` (décidés par le WHERE SQL,
  lus par aucun composant) du payload SSR — ~9 KB sur les 34 KB de la prop `fanarts`.

### Restant / piège
- **`/en/anime/[...id]` en ISR : BLOQUÉ**, pas par la donnée mais par `initialUA`. La page choisit
  `InfoPageMobile` vs `InfoPage` à partir du User-Agent lu au SSR ; un rendu statique ne le connaît
  pas → tout visiteur mobile recevrait le HTML desktop puis un swap complet de composant au mount.
  Il faut d'abord passer ce choix en CSS (rendre les deux, masquer par media-query) — ce qui gonfle
  le HTML et va contre l'allègement. Décision produit, pas technique.
- `__NEXT_DATA__` = **40 % du HTML** (120 KB sur 300 KB pour One Piece) : `info.relations` 37,7 KB,
  `tags` 15,6 KB, `characters` 11,8 KB, `fanarts` 34 KB. La suite = sortir `characters` et
  `fanarts` du payload SSR et les charger au clic sur l'onglet.
- **`npx tsc --noEmit` OOM même à 8 GB** sur ce repo (préexistant) → validation par parsing
  TypeScript fichier par fichier. Le vrai gate, c'est `build-test.yml`, qui tourne **sur PR vers
  main** — donc une release passe par une PR, pas par un merge direct.

---

## 2026-08-03 (suite 2) — « Pourquoi on a pas les bonnes vignettes ? » — Fribb ne connaît qu'un tiers des ids Simkl

Signalement user : `/fr/anime/208044`, les 6 épisodes affichent **la même image**. `GET /api/v2/episode/208044` → `img: null` partout, donc le client retombe sur le pool fanart.

**Ce n'est pas notre code, c'est la couverture de Fribb.** Mesuré sur le fichier live :
```
anime-list-mini.json : 14 480 / 42 868 entrées ont un simkl_id  (34 %)
fribb_map (Turso)    : 13 018 / 20 693
AniList 208044       : simkl_id = null   (mais mal_id 63508 présent)
```
Simkl a pourtant l'entrée complète (id 3025908, 6 stills). **On ne lui demandait jamais**, parce que Fribb était le seul chemin qu'on connaissait vers son id. Et le trou frappe exactement les titres qui en ont le plus besoin : une série en cours de diffusion est la moins susceptible d'avoir été indexée par le mapping.

**Fix :** Fribb reste le chemin rapide (une ligne locale, zéro réseau), `resolveSimklId` est le repli — `/search/id` de Simkl, par id AniList puis par id MAL. Une ligne Fribb absente n'est plus bloquante (`no-fribb` n'est plus un cul-de-sac). Vérifié en prod, cache purgé, **dès le premier appel à froid : 6/6 vraies URLs `simkl.in`**.

**Note sur TMDB :** Fribb avait `themoviedb_id.tv: 314554` + `season.tmdb: 1` pour ce titre — mais TMDB ne l'aurait pas sauvé non plus, son ancien chemin exigeait une **égalité exacte** du nombre d'épisodes, ce qu'une série en diffusion ne peut pas satisfaire. La suppression de TMDB ne coûte rien ici.

### Deux pièges de diagnostic à retenir

1. **`?refresh=1` ne purge que Redis, pas le cache de stills Turso.** Le premier test après le fix renvoyait toujours `null` : c'était la ligne `{"reason":"no-simkl-id"}` de `tmdb_stills_cache` (TTL 24 h) qui répondait, avant même que le code ne tourne. Il faut supprimer la ligne pour tester un changement de résolution. 6 lignes bloquées ont été purgées après le déploiement.
2. **Vercel ne remonte pas les `console.info`** dans `vercel logs --json` — seulement warn/error. Un titre en vignettes génériques ne laissait donc **aucune trace**, ce qui est précisément le symptôme dont on nous parle. Le log de refus est passé en `warn`, et la résolution directe logge son issue.

**Leçon générale : « aucune ligne écrite en cache » ne prouve pas quelle branche a tourné** — si le client Turso n'est pas configuré dans cet environnement, rien ne s'écrit quoi qu'il arrive. J'ai perdu plusieurs allers-retours à déduire d'une absence. Instrumenter au bon niveau de log, puis lire, aurait été plus court.

### Changelog v0.0.6

`changelog/full.{en,fr}.md` + `popup.{en,fr}.md`. Format respecté (popup = première ligne `## vX.Y.Z`, puis 4 lignes `emoji + **titre** — phrase` ; seul `**gras**` est rendu, la signature est un hash du fichier entier donc toute édition re-déclenche le popup). Contenu : éditeur de raccourcis, stats vidéo, bouton épisode suivant, plein écran conservé, vraies vignettes, page Sources, uqload, et le travail de perf.

---

## 2026-08-03 (suite) — Release `dev` → `main`, monitor vivant, et TMDB dégagé

### La release

`dev` → `main` mergé (PR #1, 136 commits). Merge testé avant : **zéro conflit**, `next build` propre sur l'arbre mergé. Le conflit sur `episode/[id].tsx` que le DEVLOG du 29/07 annonçait n'a pas eu lieu — git a auto-mergé et les deux fixes perf ont survécu (vérifié : `edgeSmaxage`, `filterData` sans clone).

**`perf-prod-aug` supprimée.** Elle réécrivait à la main sur `main` ce que `dev` avait nativement → la merger d'abord créait 2 conflits (`next.config.js`, page watch) que `dev` seul n'avait pas. Les deux seules choses qui n'étaient que sur elle (redirect `/`, durcissement du monitor) ont été portées sur `dev` d'abord. **Leçon : quand une branche de backport et la branche principale se recouvrent, porter le delta sur la principale et jeter le backport — ne jamais merger les deux.**

**Vérifié en prod après déploiement** (curl, pas déduit) :
```
page watch          MISS → HIT      (avant : MISS, MISS)   + Set-Cookie disparu
GET /api/v2/source  MISS → HIT → HIT
absent (~½ sondes)  MISS → HIT
/                   307 sans en-tête x-vercel-cache → servi par le routage, pas de fonction
```
Et sur 133 s de trafic réel : `/api/v2/source` en **GET, 5 HIT / 2 MISS**. Le matin même : 54 POST, 54 MISS, zéro HIT.

### `build-test.yml` n'avait jamais réussi une seule fois

Sa toute première exécution était cette PR #1 — et elle a échoué **avant de compiler quoi que ce soit** : `npm run build` commence par `prisma migrate deploy`, qui veut `DATABASE_URL`/`DIRECT_URL` et un Postgres joignable. La CI n'a ni l'un ni l'autre. Le gate ne disait rien sur le code depuis sa création. Corrigé : `prisma generate && next build` avec des URLs bidons (parsées pour valider le schéma, jamais connectées), Node 18 → 22, actions v2 → v4, `npm install --ignore-scripts`. **Leçon : un check qui n'a jamais été vert n'est pas un check.** Il passe maintenant en 1 min 52.

### Le monitor tourne

Secrets Upstash posés par le user → run vert en 22 s, premier recensement commité. Ce qu'il montre tout de suite : **`anime:v5` = 3 756 clés, 67 % du keyspace**. Le gros du cache Redis, c'est la page info, pas `src:` (1 clé — TTL 5 min). `episode:v3` (1 654) est le résidu de l'ancienne prod, il expirera seul ; `episode:v5` démarrait à 15.

Restent optionnels : `UPSTASH_EMAIL`+`UPSTASH_API_KEY` (c'est **eux** qui projettent le plafond de 500 K, donc qui voient venir le mur) et `VERCEL_TOKEN`.

### TMDB supprimé (décision user)

« On arrête avec TMDB, plus jamais, on utilise Simkl. » Retiré : client, résolveur de saison, adaptateur de stills, crédit sur /en/sources, disclaimer contractuel, `TMDB_API_KEY`.

Le point qui justifie la décision : **Simkl n'a aucune saison à inférer** (son id, via `simkl_id` de Fribb, indexe la MÊME entrée qu'AniList). Tout le poids du chemin TMDB venait de là — mapper une franchise sur une saison TMDB, valider contre un compte d'épisodes exact, et refuser dès qu'il ne pouvait pas prouver le match. **Mesuré après suppression, avec `?refresh=1` pour forcer le recalcul** : couverture inchangée. Chainsaw Man 12/12 par Simkl (AniList ne liste rien), One Piece 1102 Simkl + 69 Crunchyroll sur 1172.

**Gardés exprès :**
- `tmdb_stills_cache` **garde son nom** : la table contient des lignes Simkl vivantes en prod ; la renommer les orphelinerait et re-téléchargerait le catalogue pour rien. `StillsSource` garde sa variante `"tmdb"` pour que les vieilles lignes restent lisibles.
- **`tmdb_id` / `season.tmdb` de Fribb ne sont PAS TMDB le fournisseur** — ce sont des identifiants dans un fichier de mapping statique dont `resolveSeason.ts` se sert pour arbitrer l'ordre des franchises. Rien à voir avec l'API.

**Piège corrigé au passage :** une note mémoire affirmait « l'onglet Scores utilise TMDB, nécessite `TMDB_API_KEY` ». **Faux** — il est sur Jikan depuis toujours. J'avais recommandé au user de poser `TMDB_API_KEY` en me basant dessus. **Leçon : une note périmée qui contredit le code produit une recommandation fausse ; vérifier avant de conseiller une variable d'env.**

### Piège d'outillage (auto-infligé)

J'avais créé une jonction Windows `node_modules` **à l'intérieur** d'un worktree de test. `git worktree remove --force` a suivi la jonction et vidé le `node_modules` du dépôt principal. Réinstallé (`npm install --ignore-scripts`). **Leçon : ne jamais mettre de jonction/symlink vers un dossier partagé dans un worktree qu'on va supprimer en `--force`.**

Effet de bord non résolu : depuis, `next build` **local** meurt en OOM dans la phase de type-check (le worker de Next plafonne à 4 Go et n'hérite pas de `NODE_OPTIONS`). **Vérifié que ce n'est PAS lié à la suppression de TMDB** — il OOM aussi avec les changements remisés. La validation est passée par le build Vercel (préview Ready en 1 min), qui est de toute façon l'environnement de référence. À creuser si ça gêne.

---

## 2026-08-03 — Le fix du 30/07 n'était jamais parti en prod (et le monitor ne pouvait pas le dire)

Parti de deux captures Vercel (Functions 12 h + Fluid Active CPU **6h41 / 4h**) avec la consigne « regarde le usage monitor ». Le monitor n'a rien à dire : `snapshots/` est vide depuis le 30/07. **Ma première lecture des captures était fausse** et c'est la leçon centrale de la session.

### Ce que j'ai cru, puis mesuré

Lecture naïve du tableau : `/api/v2/source` 1,5 K → 155 invocations, page watch 1,3 K → 31. « Le fix du 30/07 a marché, spectaculairement. » Faux. `npx vercel logs aniscroll.com --json` (le CLI est authentifié, ça marche, **c'est l'outil qui manquait**) :

```
requestMethod:"POST"  requestPath:"/api/v2/source"  cache:"MISS"  branch:"main"
```

**La prod tourne `main`, qui n'a jamais reçu le commit `8fc3d62`.** `dev` est 135 commits devant ; le seul truc mergé le 29/07 était la branche `perf-cpu-fix`. Toutes les mesures triomphales du 30/07 (« 18 HIT, 0 invocation ») avaient été faites **sur le preview**. La baisse observée sur les captures, c'est le **reset mensuel Upstash du 1er août** (cache de nouveau vivant → moins de recompute), pas un fix. Le mur de mi-août revenait à l'identique.

**Leçon : un fix validé sur preview n'est pas un fix. Vérifier `git branch --contains <sha>` avant de conclure quoi que ce soit d'un dashboard de prod.** Le DEVLOG du 29/07 se faisait déjà exactement ce reproche (« toujours vérifier `git log origin/main..origin/dev` **avant** de bâtir une timeline ») — et j'ai remis le pied dedans quatre jours plus tard.

### Une 2ᵉ mise en cache décorative, du même acabit que le POST

Mesuré au curl sur la prod, deux fois de suite :

```
GET /en/anime/watch/16498/1
  Set-Cookie: __Host-next-auth.csrf-token=…
  Cdn-Cache-Control: public, s-maxage=1800…
  X-Vercel-Cache: MISS        ← les deux fois
```

`getServerSession()` **pose des cookies** en sortant. Une réponse avec `Set-Cookie` n'est stockée par aucun cache partagé → le `s-maxage=1800` de la branche *anonyme* ne servait à rien non plus. Le DEVLOG du 30/07 attribuait la non-cachabilité aux seuls connectés (`private, no-store`) ; en réalité **personne** n'était caché. **Leçon : lire la session côté serveur rend la réponse non-cachable même quand on ne met rien de personnel dedans.**

### Ce qui est parti sur `perf-prod-aug` (branche partie de `main`, 3 commits)

Même méthode que `perf-cpu-fix` : cherry-pick de ce qui s'applique proprement (4/5 fichiers de `8fc3d62`, dont la route `/source`), **réapplication à la main de la page watch** pour ne pas embarquer le code de feature de `dev` (`setPlayerFullscreen`, `DECOY_RETRIES`).

- **`/api/v2/source` en GET** + branche « absente » edge-cachée. POST intact pour les warmers.
- **SSR watch sans session** → plus de `Set-Cookie`. Au passage : `createUser`+`createList`+`getEpisode` supprimés (3 allers-retours Prisma pour une prop `userData` jamais lue).
- **`/` : redirect dans `next.config.js`** au lieu d'un `getServerSideProps` qui ne retournait que `{ redirect }` — **133 invocations/12 h** pour un en-tête `Location` que la couche de routage sert gratuitement.
- **Popup changelog** (`0413ed5`, aussi coincé sur dev) : `?t=${Date.now()}` + `no-store` deux fois par page pour un markdown qui change au déploiement.
- **`mediaMeta` supprimé du contrat client** : la route n'en lisait que `idMal` → `?malId=`. Bonus, ça ferme le piège que la route documentait déjà (données client atteignant les caches serveur, cf. « SnK S1 joue la S2 »).

**Vérifié sur le preview** (curl, pas déduit) : watch MISS→**HIT**, `Set-Cookie` disparu ; GET `/source` MISS→HIT→HIT ; **branche « absente » HIT** (c'est ~la moitié des sondes) ; POST toujours 200 ; `/` → 307 sans passer par une fonction. Type-check + `next build` propres.

### Le monitor : pourquoi il n'a jamais tourné

Pas (que) les secrets, comme dit le 30/07. **`tools/usage-monitor/` et son workflow n'existaient que sur `dev`, et GitHub n'enregistre les `schedule:` que depuis la branche par défaut.** Le cron de 06:20 n'a jamais existé côté GitHub ; le workflow n'était même pas dispatchable à la main. Déplacé sur `main`, avec la raison écrite en tête de fichier.

Second défaut : le collecteur dégradait gracieusement *chaque* source, donc une exécution **sans aucune** credential sortait en **exit 0** après avoir commité un snapshot vide. Il `exit 1` désormais si aucun collecteur Upstash n'a produit de données. **Leçon : un monitor qui ne rapporte rien en restant vert est pire que pas de monitor.**

### Restant / décidé

- **Secrets à poser** (`UPSTASH_REDIS_REST_URL`/`_TOKEN` depuis `aniscroll-cache`) : `vercel env pull` ne les donne pas, ils sortent en `[SENSITIVE]`. Console Upstash obligatoire.
- **Page info en ISR : volontairement PAS fait.** Elle pèse 51 % du CPU sur la capture (255 inv × 224 ms), mais sur 15 min de logs réels elle fait 6 lignes contre **54 pour `/api/v2/source`**, toutes MISS. Refactorer 973 lignes à l'aveugle avant que le fix ci-dessus n'ait changé le profil, c'est exactement l'erreur nommée le 30/07 (« le fix du 29 a optimisé le petit »). À rouvrir avec les chiffres d'après-merge.
- **`/api/og` compte-t-il dans Fluid ?** Le 29/07 concluait « runtime edge, pas Fluid, ne pas optimiser ». La capture le montre dans le tableau Fluid : **23 s de CPU pour 4 invocations** (5,75 s/appel), 21 % du total. À revérifier — si c'est confirmé, c'est le 2ᵉ levier. Accessoirement son `Cache-Control` sort dupliqué (`@vercel/og` pose le sien, le nôtre est concaténé derrière, `s-maxage` perdu) — sans effet mesurable, il HIT quand même.
- **Les 1,3 % d'erreurs sur `/source` sont normales** : c'est `sendRetryable` → 503 sur un upstream capricieux, compté 5XX par Vercel. Rien à corriger.
- **Le 6h41/4h est un cumul de cycle** (axe 6 juil → 3 août, reset vers le 5-6 août), dominé par le pic du 18/07 (1h23 à lui seul) et le palier pré-reset. La barre du jour : 4 min 6 s.

---

## 2026-07-30 (suite 4) — Chasse aux invocations : le POST qui rendait tout le cache décoratif

Parti du tableau Observability de Vercel (top Active CPU : `/api/v2/source` 1,5 K invocations / 1 min CPU, page watch 1,3 K / 51 s, page info 107 / 28 s). Le monitor maison (`tools/usage-monitor`) **n'a jamais tourné** : `snapshots/` est vide, pas de `LATEST.md` — il manque les secrets Upstash/Vercel dans les Actions. À réactiver, c'est lui qui doit voir venir le mur, pas une capture d'écran.

**La trouvaille : `/api/v2/source` est en POST — donc aucun CDN ne cache ses réponses.** La route posait pourtant scrupuleusement `s-maxage=300, stale-while-revalidate=600` depuis des mois : des en-têtes qui n'ont jamais rien fait. Chaque visiteur ré-invoquait la fonction pour une résolution que l'edge avait déjà, et la page watch en tire **une par serveur sondé** à chaque chargement (~18). **Leçon : un en-tête de cache sur un POST est du commentaire.** Le passage en GET n'a rien coûté côté contrat : le body ne portait qu'un seul champ utile, `mediaMeta` (objet média complet avec `synonyms` + `relations`) dont la route ne lit que `idMal` → `?malId=`. POST conservé tel quel pour les warmers/scripts d'audit.

Deuxième moitié du même bug : **la branche "source absente" n'avait que `max-age` (navigateur)**, alors que ~la moitié des sondes ratent par design → chacune ré-invoquait. Maintenant `CDN-Cache-Control` aussi, 5 min, sous le sentinel négatif Redis de 10 min (l'edge ne prétend jamais "absent" plus longtemps que le serveur). Sur GET l'absence est un **`200 {absent:true}`** et non un 204/404 : garanti cachable (le comportement de Vercel sur le cache d'un 204 n'est pas une chose sur laquelle parier pour l'endpoint le plus chaud du site) et muet en console. Côté client, les trois dialectes de statut éparpillés sur 4 appelants sont pliés dans un helper unique (`lib/watch/sourceRequest.ts`) à trois issues : `ok` / `absent` / `retry`.

**Page watch : le SSR ne dépend plus de qui demande.** Il lisait la session pour injecter `sessions` + le `mediaListEntry` de l'utilisateur dans les props → `private, no-store` → les connectés (ceux qui enchaînent le plus d'épisodes) ré-invoquaient la fonction à **chaque vue et chaque changement d'épisode** (la navigation SPA refetch les props). Les deux passent côté client (`useSession()`, et l'effet de backfill `/api/v2/media/[id]` qui existait déjà) — même arbitrage que la page info. Coût assumé : un `/api/auth/session` par chargement à froid, partagé ensuite sur toute la navigation SPA (mesuré : 1, exactement comme la page info le faisait déjà).

Au passage, trois allers-retours Prisma par vue connectée (`createUser` + `createList` + `getEpisode`) **construisaient une prop `userData` que le composant déstructurait sans jamais la lire**. Et les lignes écrites étaient des coquilles vides : `updateUserEpisode` n'a plus aucun appelant, et `recently-watched` filtre les lignes sans image/titre et retombe sur localStorage — qui est ce qui contient réellement l'historique. Supprimés. **Leçon : vérifier ce que la prop devient avant d'optimiser ce qui la produit.** Idem `getRemovedMedia()` : un `findMany` non caché à chaque SSR watch pour une table DMCA éditée à la main → cache mémoire 10 min (un échec de lecture n'est PAS caché, sinon un hoquet Prisma dé-masquerait un retrait).

**Mesuré sur le preview** (Chrome réel) : deux visiteurs neufs successifs sur la même page watch → **18 appels `/api/v2/source`, 18 `x-vercel-cache: HIT`, 0 invocation** (avant : 18 POST = 18 invocations, par visiteur). HTML de la page watch : HIT. Absence : MISS puis HIT. POST : MISS (jamais caché — la preuve du diagnostic). Lecture inchangée : `readyState 4`, durée 1435 s, zéro erreur console.

Petit à côté du même acabit : le popup changelog s'appelait avec `?t=${Date.now()}` + `cache:"no-store"`, **deux fois par chargement de page**, pour un fichier markdown qui ne change qu'au déploiement (246 invocations/jour qu'aucun cache ne pouvait servir).

---

## 2026-07-30 (suite 3) — Navbar illisible sur une bannière claire → on mesure les pixels

La navbar flotte en transparent sur la bannière de la page info, donc **tout** son chrome est blanc (liens, icônes, pilule de recherche). Sur une bannière blanche/pastel (Nippon Sangoku) elle disparaît complètement. Aucune métadonnée AniList ne dit "cette image est claire" → la seule source de vérité, ce sont les pixels.

**Design.** `lib/color/navContrast.ts` : store hors React (les deux côtés sont des composants sans lien — la navbar est rendue par la page, la bannière par le hero ; un contexte aurait voulu dire brancher un provider sur deux layouts pour un booléen). Le hero déclare l'artwork (`useNavBackdrop(src)`), la navbar lit le verdict (`useNavOnLight()`) et bascule en chrome quasi-noir. Seuil : **luminance relative WCAG moyenne > 0,42**. Le croisement blanc/noir est à L≈0,28, mais basculer pile au croisement repeindrait la navbar sur toutes les bannières gris moyen pour un gain marginal ; mesuré sur 20 bannières réelles, les claires sont à 0,51-0,99 et les "ciel bleu" (AoT, Kimi no Na wa) restent à 0,28-0,37 et gardent le look du site.

**Le piège (2 h perdues) : lire les pixels dans le navigateur est IMPOSSIBLE sur le CDN AniList.** Première version : `crossOrigin="anonymous"` sur le `<img>` + canvas + `getImageData`, en vérifiant d'abord au curl que `s4.anilist.co` renvoie bien `Access-Control-Allow-Origin` (oui, sur MISS **et** sur HIT). En vrai Chrome sur le preview : **toutes** les bannières en `ERR_FAILED` / "blocked by CORS policy". Raison : **Cloudflare ignore `Vary: origin` pour la mise en cache**. Le fait de recevoir l'en-tête dépend donc de la copie que ce PoP détient — curl (avec Origin, sa propre entrée de cache) le voit, le navigateur non, parce que les chargements *sans* CORS de la même image ailleurs sur le site ont rempli le cache en premier. **Leçon : "curl voit l'en-tête CORS" ne prouve rien ; derrière un CDN, la validité d'un ACAO dépend du cache, pas du serveur.** (Le fallback `onError` → retrait de l'attribut → rechargement en clair a bien joué son rôle : la bannière s'affichait, seule la mesure était perdue.)

**Refonte : mesure côté serveur.** `GET /api/v2/banner-tone?u=…` (sharp) renvoie `{ l }`, la luminance moyenne du haut de l'image. Réponse **immuable** (une nouvelle illustration = un nouveau nom de fichier) → `s-maxage` d'un an : **une invocation par bannière existante**, pas une par page vue, et le client télécharge ~20 octets au lieu d'une 2ᵉ copie de la bannière. Le seuil reste **côté client** exprès : la réponse est cachée un an, le régler ne doit pas demander de purge. Allowlist d'hôte (`s4.anilist.co`) parce que la route fetch l'URL qu'on lui donne (SSRF).
Alternatives écartées : `/_next/image` (l'optimiseur est désactivé, `unoptimized: true` → 404), le proxy fanart CF (quota 5k transformations/mois, réservé à fanart.tv).

**Le serveur ne connaît pas le viewport** → il échantillonne le **haut 25 %** du fichier. `object-fit: cover` place la bande de la navbar dans cette zone à toutes nos largeurs (lignes 0-80 à 1280 px, 14-86 à 1900, 47-100 à 2560). Vérifié contre le crop exact par viewport sur 21 bannières : même verdict sur 19, les 2 autres étant des crops mobiles limites.

**CSS (`.nav-on-light`) : surtout PAS de `nav.nav-on-light { color }` global.** La navbar *contient* le menu avatar, la liste de notifications et la modale changelog — des panneaux sombres dont le texte hérite sa couleur : une règle en cascade les aurait passés en noir sur noir. Seuls les éléments marqués `nav-chrome` (Discord/cloche/report/changelog) et `nav-chrome-dim` (le tag "Beta") sont repeints, marqueur posé **sur le bouton**, jamais sur un wrapper ; les liens de nav et la pilule de recherche prennent des classes conditionnelles dans NavBar. La bascule ne s'applique que tant que la navbar est transparente : passé le seuil de scroll elle peint son propre fond sombre et le blanc redevient correct.

**Validé en vrai Chrome sur le preview** (Playwright + Chrome système) : desktop 1900 px → classe posée, liens `rgba(0,0,0,.8)`, pilule `rgba(0,0,0,.06)`, icônes `rgba(11,13,18,.72)` ; scroll → retour au chrome blanc ; page à bannière sombre (Jujutsu Kaisen) inchangée ; mobile (Pixel 7) idem ; menu avatar toujours blanc sur `#212127` ; **1 seule requête** pour la bannière.

---

## 2026-07-30 (suite 2) — Bouton "épisode suivant" dans la barre + on RESTE en plein écran au changement d'épisode

Deux demandes liées. Le bouton est trivial ; garder le plein écran l'était moins.

**Bouton next (icône `skip_next` classique) dans la barre de contrôle.** Même technique que Download/Subs/Cast : un **host DOM stable** (`data-slot="moopa-nav-controls-host"`, `display:contents`) dans lequel React portale le bouton, que le MutationObserver **repositionne** juste après le bouton play. Piège évité : le host des boutons custom se place dans le **dernier** `.vds-controls-group` — ce qui marche en layout large mais PAS en `data-size="sm"`, où le dernier groupe est la **barre de progression** (l'ordre mobile est : [cc/menus/mute] · [play centré] · [temps+fullscreen] · [slider]). Le nouveau host cible donc le groupe **par contenu** (celui qui contient `.vds-play-button`), valable sur les deux layouts. En mobile ce groupe est `pointer-events:none` (seul le play réactive) et le play y est rond/40px/`translateY(25%)` → CSS dédiée pour que le bouton next soit cliquable et assorti.

**Rester en plein écran (le vrai sujet).** Le player est **keyé** par `{server}-{aniId}-{episode}-{sub|dub}` → changer d'épisode **démonte** `.vds-player`, et l'API Fullscreen lâche le plein écran dès que son élément quitte le DOM. L'ancien code assumait la sortie (SkipOverlay faisait un `exitFullscreen()` explicite avant `router.push`, sinon la page suivante chargeait *sous* une frame figée et le bouton semblait mort).

Fix = **handoff en 2 temps** autour de la navigation (`lib/player/episodeTransition.ts`) :
1. `beginEpisodeTransition()` (dans le geste, **avant** `router.push`, et **await** pour ne pas courir contre le démontage) donne le plein écran à un **host de niveau `_app`** (`components/shared/episodeTransitionOverlay.tsx`) qui survit à toute navigation. Il peint du noir + **la barre rose du site** (le `<NextNProgress>` de la page est invisible quand un autre élément possède l'écran) → l'utilisateur voit que ça charge.
2. `claimEpisodeTransition(el)` : le **nouveau** player récupère le plein écran dès que son élément existe (le plus tôt possible = geste encore récent → activation transitoire probablement encore valide).

**Pourquoi rendre le plein écran à `.vds-player` et pas garder un ancêtre plein écran** (ce qui aurait évité le 2ᵉ `requestFullscreen`) : Vidstack dérive son état de `isFullscreen(player.el)` = `fullscreenElement === el || el.matches(':fullscreen')`, et `:fullscreen` ne matche **QUE** l'élément demandé (pas ses descendants — la remontée du spec est inter-**documents**/iframes, pas inter-éléments). Un ancêtre plein écran laisserait donc Vidstack en état "fenêtré" → mauvaise icône, `[data-fullscreen]` absent (ratio 16:9 gardé → bandes noires) et surtout **menus portalisés vers `<body>`** donc invisibles en plein écran mobile. Vérifié aussi dans le dist Vidstack : son `FullscreenController.exit()` (appelé au dispose du player) **court-circuite** si son élément n'est pas l'élément plein écran → le démontage de l'ancien player ne casse pas notre handoff. 

### Le vrai verdict (2ᵉ test user) : **le handoff par re-demande est IMPOSSIBLE** → refonte, le plein écran passe sur `<html>`

Trace `?fsdebug` du user, sans ambiguïté :
```
begin: host owns the screen          ← étape 1 OK
claim → Failed to execute 'requestFullscreen' on 'Element':
        API can only be initiated by a user gesture.
```
Donc **Chrome exige une activation utilisateur pour re-demander le plein écran**, même document déjà en plein écran (mon hypothèse "déjà fullscreen ⇒ autorisé" était fausse). Et de toute façon l'activation transitoire (~5 s) est expirée quand la source du nouvel épisode finit de se résoudre.

**Nuance découverte en testant le mécanisme dans un vrai Chrome** (script Playwright + Chrome système, `scratchpad/fs-mechanism.html`) : une re-demande **sans geste est accordée si la cible est un DESCENDANT** de l'élément plein écran courant (plein écran imbriqué), et refusée sinon. Mon host vivait dans `_app`, donc **frère** du player, pas ancêtre → refus. C'est exactement ce que la console montrait.

**Refonte (design final).** L'élément plein écran doit être **stable depuis le début** : c'est `document.documentElement`, qu'aucune navigation ne démonte → **plus jamais de re-demande**. Le "player en plein écran" devient du **CSS** (`aniscroll-player-fs` : `position:fixed; inset:0; z-index:9999`) — c'est-à-dire le pseudo-fullscreen déjà éprouvé pour iOS, **généralisé à toutes les plateformes**, avec le vrai plein écran racine par-dessus pour faire disparaître la chrome du navigateur. Mesuré en vrai Chrome : démonter/remonter l'enfant **ne perd pas** `document.fullscreenElement` (= HTML). Nouveau module `lib/player/playerFullscreen.ts` (état hors React pour survivre au remount + `usePlayerFullscreen`), `episodeTransition.ts` réduit à l'overlay de chargement (plus aucun appel Fullscreen).

**Pourquoi la racine et pas un wrapper ancêtre du player** (les deux résolvent la persistance) : quand Vidstack ne se croit pas en plein écran, il **portalise ses menus vers `<body>`** sur layout mobile (`<Portal disabled="fullscreen">` — le portal n'est désactivé QUE s'il se croit fullscreen). Avec un wrapper ancêtre, `<body>` est **hors** du sous-arbre plein écran → menus invisibles en plein écran mobile. Avec `<html>` comme élément plein écran, tout le document est dedans → les menus s'affichent (leur `z-index:9999999` passe au-dessus de notre wrapper à 9999). C'est ce détail qui a tranché entre les deux.

**Le prix à payer, assumé et compensé** : l'état `fullscreen` de Vidstack reste faux. Donc (1) on **cache son bouton plein écran** (son icône/label viennent de son état → il afficherait "Entrer en plein écran" *en* plein écran) et on portale **le nôtre** juste après, ancré sur le bouton natif resté dans le DOM ; (2) on **pose `data-fullscreen` à la main** sur la racine du player → toutes les règles `[data-fullscreen]` existantes (thème Vidstack **et** nos globals : rayon, ratio, taille des boutons, échelle des sous-titres) continuent de marcher (Vidstack n'écrit cet attribut que sur changement de son état, qui n'arrive plus → il ne nous le reprend pas) ; (3) le geste **double-clic** `toggle:fullscreen` de Vidstack est **intercepté** en capture (il entrerait dans SON plein écran, que le changement d'épisode retuerait). `keyDisabled` fait que son raccourci `f` n'existe pas, donc pas d'autre porte d'entrée. Bonus : le pseudo-fullscreen iOS n'est plus un cas spécial, et le verrou d'orientation/scroll est étendu à tout appareil tactile.

**Dernier bug (3ᵉ test user) : "le 1er next marche, le 2ᵉ sort du plein écran".** Le relâchement du mode était branché sur le **démontage de UniversalPlayer** (gardé par "sauf si une transition est en cours"). Or le player est remonté **bien plus souvent** que "l'utilisateur est parti" : sa clé est `{serveur}-{aniId}-{épisode}-{dub}`, donc il remonte aussi sur un **repli de serveur** (l'épisode testé avait un flux en 403) et pendant un battement quand le **numéro d'épisode du router arrive avant les données du stream**. Ces remounts arrivent *après* le claim (donc `pending=false`) → le garde-fou les laissait relâcher l'écran. **Fix : c'est la PAGE watch qui relâche** (`useEffect(() => () => setPlayerFullscreen(false), [])`) — elle reste montée sur toute la route (tous les changements d'épisode) et ne se démonte qu'en partant vraiment. Plus aucun remount, dans aucun ordre, ne peut tuer le plein écran. **Leçon : ne pas confondre "le composant se démonte" et "l'utilisateur s'en va"** — sur une page dont un enfant est keyé, le démontage de l'enfant est un signal de *reconstruction*, pas de sortie.

**Validation (vrai Chrome, sur le preview déployé, pas en local)** : Playwright + Chrome système, clic réel sur notre bouton plein écran puis 3 `next` d'affilée → `document.fullscreenElement === HTML`, classe CSS et `data-fullscreen` présents, label "Quitter le plein écran", épisodes 1→2→3→4, zéro erreur console. Script : `scratchpad/live-test2.mjs` (le local ne résout pas les sources : inutile d'y tester le player).

**Leçon (la vraie) : ne jamais bâtir une feature sur un `requestFullscreen` qu'on ne peut pas garantir.** L'API n'est utilisable qu'au moment du geste ; tout ce qui doit survivre à une navigation doit être plein écran **avant** de naviguer, sur un élément que rien ne démonte.

**Bug intermédiaire — "sorti du plein écran de force" (1ère correction, gardée pour la leçon).** Cause : **changer d'élément plein écran n'est pas atomique**. Quand on demande le plein écran pour le host alors que `.vds-player` l'a, le navigateur **sort d'abord** (`fullscreenchange` avec `fullscreenElement === null`) **puis entre** sur le host (2ᵉ `fullscreenchange`). Ma détection d'Échap prenait le null intermédiaire pour un abandon utilisateur → `cancel()` → host repassé en `display:none` **alors qu'il devenait l'élément plein écran** → puis le garde-fou "host obsolète" voyait `fullscreenElement === host` avec `pending=false` → `exitFs()` → **sortie forcée**. Trois correctifs : (1) flag `swapping` posé autour de NOS `requestFullscreen` — on ignore tout `fullscreenchange` pendant un swap qu'on a initié, le verdict vient de la promesse ; (2) toute décision sur un `fullscreenchange` est **re-vérifiée après 300 ms** (`SETTLE_MS`) au lieu d'être prise sur le premier signal ; (3) le host n'est plus `display:none` mais `opacity:0 + pointer-events:none` — un élément non rendu peut recevoir le plein écran et s'afficher en noir sans la barre. Ajouté `?fsdebug` dans l'URL → trace chaque étape en console (begin/claim/refus/cancel) : un bug de plein écran est irreproductible sans savoir **quelle** étape le navigateur a refusée. **Leçon : ne jamais traiter un `fullscreenchange` isolé comme un fait — c'est un flux d'états transitoires.**

**Taille du bouton (retour user : "un poil trop petit").** Nos boutons custom codaient en dur `h-10 w-10` + icône `h-7 w-7` (28 px), alors que Vidstack dimensionne les siens via `.vds-button` = `--media-button-size` (40 px, **42 px en plein écran**) et l'icône via `.vds-icon` = **80 %** (32 px). D'où des glyphes visiblement plus petits que play/mute/fullscreen à côté. Fix : retirer les tailles fixes et ajouter la classe `vds-icon` aux `<svg>` → les 4 boutons custom (Download/Subs/Cast/Next) suivent exactement la métrique native, y compris le passage 40→42 px en plein écran. **Leçon : dans la chrome Vidstack, s'appuyer sur ses variables/classes plutôt que sur des tailles Tailwind figées** (ses règles sont en `:where()`, donc n'importe quel utilitaire Tailwind les écrase silencieusement).

**Garde-fous** : Échap pendant la transition (fullscreenchange → `fullscreenElement` null) → on annule et la page charge en fenêtré ; **watchdog 25 s** si personne ne réclame l'écran (source morte) → on sort du plein écran au lieu de bloquer sur un host noir ; si le 2ᵉ `requestFullscreen` est refusé (navigateur exigeant un nouveau geste) → on sort proprement = comportement d'avant, jamais de piège. iOS n'a pas de vrai plein écran (pseudo-FS CSS dans un state React que le remount perdait) → le flag est **mirroré hors de l'arbre** (`setPseudoFullscreenActive`) et restauré par le player suivant, nettoyé quand on quitte vraiment la page.

Tous les chemins de changement d'épisode du player passent maintenant par `navigateToEpisode()` : bouton de la barre, CTA "Next Episode" de SkipOverlay, **auto next episode**, raccourcis clavier next/prev. **Non couvert** (choix) : le changement d'épisode piloté par un pair en Watch-2gether (`router.push` dans la page watch) et le changement de **serveur**, qui démonte aussi le player.

**Bug trouvé en passant (bloquait tout `next build`)** : `lib/db/opedHostSkips.ts` avait `op_*/ed_*` dans un commentaire `/** */` — le `*/` **ferme le commentaire** → `Parsing error: ';' expected` à l'ESLint de build. Corrigé. Leçon : jamais de `*/` littéral dans un bloc de commentaire (et `next build` local échouait donc AVANT cette session — le lint de build est un gate réel).

**Note outillage** : `npx tsc --noEmit` sur tout le projet **OOM** (>8 Go, `allowJs` + `tools/` + `worker/` + toutes les pages dans un seul programme). Pour valider une modif : tsconfig scopé aux fichiers touchés (+ leurs imports) dans le scratchpad → 0 erreur ici ; `next lint --file …` marche normalement.

## 2026-07-30 (suite) — `tools/usage-monitor` : collecteur de diagnostic usage quotidien

Nouveau tool pour comprendre **d'où vient le volume** sans deviner. `node tools/usage-monitor/collect.mjs` écrit un snapshot daté + `LATEST.md`/`HISTORY.md` avec deltas jour/jour :
- **Census keyspace Redis** (REST, SCAN complet borné) → clés bucketées par préfixe (`src:`/`avail:`/`episode:`/`lock:`/W2G `room:`…). C'est l'attribution que le chiffre agrégé Upstash ne donne pas — si `src:` domine, le levier est le fan-out `/source`, pas les GET edge-cachés.
- **Daily requests Upstash** (management API, optionnel) → la courbe "Daily Commands" + **projection mensuelle vs cap 500K** + flag saturation. `databaseCount>1` = dev/prod déjà séparés.
- **Déploiements Vercel** (API, best-effort) → corréler un pic avec une release (Vercel n'expose pas d'API publique invocations/CPU par route sur Hobby).
- Section **Flags** en tête (projection cap, DB partagée, spike J/J, explosion de préfixe). Action GitHub `.github/workflows/usage-monitor.yml` (cron 06:20 UTC) commit le snapshot ; creds en secrets repo.

**Effet de bord trouvé en testant :** le `REDIS_URL` de `.env.local` pointe sur une **vieille DB Upstash supprimée** (`stable-tahr-110008`, NXDOMAIN) → le dev **local tourne sans Redis** (cache désactivé). La DB live est `aniscroll-cache` (creds seulement dans Vercel). Pour lancer le census sur la vraie DB : mettre `UPSTASH_REDIS_REST_URL`/`_TOKEN` de `aniscroll-cache`. Le tool a été validé de bout en bout (rendu rapport + flags + deltas + projection) sur snapshot synthétique.

## 2026-07-30 — Upstash toujours ~31k cmd/j après le fix edge-cache : le vrai volume = re-probe des `absent` sur `/source`

Constat user (captures Upstash + Vercel) : **le volume Upstash n'a PAS baissé** après le fix du 29/07 (Mer 31 673 cmd, à peine sous les ~35k d'avant). Le fix est pourtant bien en prod (`main` `97b732d` : availability edge-cachée + `/source` CDN + `LOCK_POLL=350`).

**Pourquoi le fix du 29 ne pouvait pas faire baisser la courbe :**
- Il a edge-caché **catalog / discover / episode / availability** = endpoints à **faible trafic** (bas du tableau Vercel : episode 406, availability 759 inv).
- L'edge-cache n'aide que si plusieurs visiteurs tapent la **même URL** dans la fenêtre TTL. Or le trafic est **long-tail par épisode** (`aniId:episode:sub` quasi unique en 10 min) → **taux de hit edge faible**. C'est structurel, pas un bug de config.

**Le vrai consommateur = `/api/v2/source`** (5,7K inv / ~12h, loin devant). C'est un **POST → jamais edge-cachable** : chaque probe traverse la fonction et fait ≥1 commande Upstash. La page watch tire un **fan-out ~17 probes/chargement**.

**L'amplificateur non traité :** les serveurs marqués `absent` dans le snapshot cross-visiteur étaient **re-probés à CHAQUE visite** ([watch/[...info].js] `hydrateFromServer` → `snapshotAbsent`), et `probe()` fait **2 tentatives** (gestion decoy anti-bot). Comme ~la moitié des ~17 serveurs sont absents → **~8 × 2 = ~16 GET Redis par visite d'un épisode déjà connu**, uniquement pour redécouvrir des absences déjà confirmées. Les serveurs `ok`, eux, étaient bien skippés.

**Fix appliqué (dev, choix user "1 tentative + proba 20%") :**
- **Re-probe probabiliste** des `snapshotAbsent` : `SNAPSHOT_ABSENT_REPROBE_P=0.2` — on ne re-probe un absent que ~1 visite/5 (drop dans le calcul de `remaining`). Un host récupéré est redécouvert en ~5 visiteurs, bien dans la fenêtre 6h.
- **1 seule tentative** pour un absent connu (pas le double-retry decoy, qui ne sert qu'aux inconnus froids).
- Effet attendu : coût `/source` d'un épisode connu ~16 GET → ~2 GET (÷~5-8). Seul levier qui fait réellement plonger Upstash (edge-cache impuissant sur un POST long-tail).

**Question tranchée (30/07) : dev (Preview) et Prod PARTAGENT la même DB Upstash** — et c'est la vraie explication du 31k qui ne bouge pas. Preuves : (1) une seule DB `aniscroll-cache` en console ; (2) une env var Vercel non scopée s'applique à TOUS les environnements. **Découverte clé en inspectant `main` :** la PROD n'a PAS le bug de volume — sur `main`, les serveurs `absent` du snapshot vont dans `cachedFailed` (jamais re-probés, 0 commande). C'est **`dev` qui a régressé** ça (absents → `snapshotAbsent` → re-probe ×2 à CHAQUE visite ≈ ×16 GET/visite watch). Donc le 31k de la DB partagée = prod (lean) **+ dev (glouton ×16)**. → **NE PAS porter le fix re-probe sur main** : main est déjà lean, ça ferait 0→20% de re-probe = régression usage. Décision user : **séparer les DB** (2ᵉ DB Upstash gratuite + `UPSTASH_REDIS_REST_URL`/`_TOKEN` — ou `REDIS_URL` — scopés *Preview*, + `.env.local` vers la DB dev). Aucun code à changer : `lib/redisRest.ts` `resolveConfig()` lit purement les env vars, zéro URL hardcodée. Le fix re-probe dev (`SNAPSHOT_ABSENT_REPROBE_P=0.2`) reste utile pour rendre dev lean en bonus.

**Leçon :** l'edge-cache HTTP ne réduit le volume Upstash que sur des **GET à URL partagée et chaude**. Sur du **POST** (ou du GET long-tail par-épisode), le seul levier est de **réduire le nombre de requêtes / commandes-par-requête** (ici : ne pas re-prober ce qu'un visiteur a déjà tranché). Toujours identifier l'endpoint qui DOMINE le volume (Vercel invocations × cmd-par-req) **avant** d'optimiser — le fix du 29 a optimisé le petit.

## 2026-07-29 — Explosion du Fluid Active CPU (Vercel) depuis le 18/07 : plafond Upstash gratuit

Le Fluid Active CPU a explosé (**6h24 / 4h**, pic isolé **1h20 le 18/07**, puis palier **×2‑3** vs. début juillet). Diagnostic + fix (commits `fcbd942`, `79d4632`, sur `dev`).

**Cause racine — plafond de commandes Upstash gratuit.** Upstash Free ≈ **500K commandes/mois** (~16k/j soutenable), mais volume réel **~35k/j** (~1M/mois, **~2× le cap**, lu dans la console : Sam 40k / Dim 28k / Lun 44k / Mar 34k). L'allocation mensuelle s'épuise **à mi‑mois** → Upstash throttle → le cache Redis ne sert plus de hits → **chaque requête recompute** (AniList/scrapes au lieu d'un GET) → le CPU déborde le plafond Hobby 4h.

⚠️ **Correction (piège d'analyse) :** j'avais d'abord attribué le pic du 18 au bump de clé `episode:v4→v5` du 17/07. **Faux pour prod** : `main` (prod) date du **5 juillet** et n'a jamais reçu ce commit (il est resté sur `dev`/preview). Le pic prod s'explique donc uniquement par le **volume vs cap**, pas par le bump. **Question ouverte clé : `dev` (preview, testé en continu) et prod partagent-ils la même DB Upstash gratuite ?** Si oui, le trafic de dev brûle le budget commun et tue aussi le cache de prod → à vérifier dans la console (une DB ou deux ?). Leçon : toujours vérifier `git log origin/main..origin/dev` **avant** de bâtir une timeline — prod ≠ dev.

**Ce que Redis fait vraiment (2 rôles) :** (1) **cache** (episode/catalog/discover/availability/recent/health…) = l'essentiel du volume, proportionnel au trafic ; (2) **état partagé** W2G rooms/présence/chat + merge availability + lock single-flight `/source` = besoin d'un KV, volume faible. → **Supprimer Upstash = mauvaise idée** (CPU haut en permanence + W2G cassé). Le bon move = **vider Redis de son rôle de cache** vers l'edge HTTP **gratuit** de Vercel (hors quota), Upstash ne garde que l'état.

**Fix appliqué (option B) :**
- `catalog/[sort]`, `discover/[page]` : fenêtre edge **60s → TTL Redis (1h / 30min)** via `CDN-Cache-Control`. Avant, `s-maxage=60` faisait re-traverser la fonction (et payer un GET) toutes les 60s.
- `episode/[id]` : edge **30min → 24h** pour séries **terminées** (liste immuable) ; **30min gardé** pour les en‑cours (nouvel épisode visible vite). + suppression de la **copie inutile par épisode** dans `filterData` (coût CPU réel sur One Piece/Conan, chemin cache‑hit).
- `availability` GET : edge **300 → 600s** (`CDN-Cache-Control`).
- `/source` : `LOCK_POLL_MS` **150 → 350ms** — le polling follower du single-flight = **amplificateur de GET** pendant les vagues (jusqu'à 40 GET/follower sur les 6s → ~17).
- `og` : header cache long — **mais runtime `edge`, PAS Fluid** → correctness, ne compte pas dans la métrique qui a explosé.

**Leçons/pièges :**
- **Ne jamais bumper une clé de cache « à sec ».** Invalidation totale = pic CPU + rafale de commandes garantis. Migrer/backfiller.
- Sur Upstash gratuit, un `redis.get` par requête sur un endpoint **identique pour tous** est du gaspillage → **edge cache HTTP** (gratuit, hors quota). `CDN-Cache-Control` (edge) ≠ `Cache-Control` (navigateur) : split pour un TTL edge long sans forcer le cache navigateur.
- `og` = runtime **edge** = pool compute distinct de **Fluid** ; optimiser og ne bouge PAS la métrique Fluid.

**Release prod (fait) :** `dev` était **117 commits devant `main`** (features non sorties : episode thumbs, éditeur raccourcis, notices, W2G, opening-detector). Donc **pas** de merge `dev→main` complet — **release perf uniquement** via une branche `perf-cpu-fix` partie de `main` : 2 cherry-picks du 29 (SSR résilient Redis + cut volume recent/translate) + réapplication à la main des 6 fixes edge-cache sur les versions `main` (l'edit `episode/[id]` s'appliquait proprement car main est en clé `v3` sans Simkl). Mergé dans `main` (`97b732d`), 10 fichiers, 0 code de feature. ⚠️ **Piège futur :** le prochain merge `dev→main` complet **conflictera sur `episode/[id].tsx`** (main = v3+perf, dev = v5+Simkl+perf) — résoudre en gardant la version dev + les 2 perf (no-clone `filterData`, `edgeSmaxage`).

**Reste à faire :**
- Soulagement CPU **immédiat** = dépend du cycle Upstash : reset le 1er du mois, ou **pay‑as‑you‑go ~2 $/mois** en attendant. Le fix code empêche surtout la **récidive** les mois suivants.
- **Vérifier si dev et prod partagent la même DB Upstash** (cf. cause racine) — si oui, séparer, sinon le budget prod restera pollué par les tests dev.
- Vérifier **Upstash → Usage mensuel** (saturation ~le 18 ?) et les headers `X-Cache` / `age` sur catalog/discover/episode en prod.

## 2026-07-14 — OP/ED : fin d'OP tronquée à 4:00 (fenêtre) + megaplay ED décalé (credited faible override audio)

Validation sur **JJK S1** (AniList 113415, mal 40748). Deux bugs distincts trouvés en vérifiant l'ép3 au pixel.

**Bug 1 — OP end tronqué à 4:00 pour tous les lecteurs anime-sama.** `OP_WINDOW=(0,240)` ne décode que les 4 premières min. L'OP de JJK (90s) démarre à 3:12 → finit à **4:42**, donc **à cheval** sur le bord 240s. Le match fenêtré en capturait ~48s (fill 0.53, juste au-dessus de `min_fill=0.5`) et renvoyait un hit **tronqué à 4:00**, ce qui **supprimait** le fallback épisode-complet (déclenché seulement si `hit is None`). ep2 (OP entièrement hors fenêtre à 5:45) marchait, lui, via ce fallback. Tous les hosts d'accord sur 4:00 = signal partagé (fenêtre), pas du bruit par lecteur.
- **Fix** : `_window_clipped(hit, win)` — détecte que `theme_t0 + ref_duration` déborde la plage décodée (marge 1s, un bord = fin d'épisode ne compte pas). Le fallback se déclenche alors **aussi sur troncature**, pas que sur `hit is None`, et garde le match qui couvre le plus de la réf (`r_end - r_start`).
- **Perf** : au lieu de re-décoder l'épisode entier (~24 min audio **et** keyframes vidéo → très lent), le fallback décode une **fenêtre élargie** `(theme_lo-12, theme_hi+12)` (~2 min) puisque l'audio a déjà localisé le thème. `video_win` dérivé de même pour ne jamais scanner les keyframes de tout l'épisode. Résultat ép3 : OP **3:12→4:40** (span 88s, 278 votes vs 197 avant).

**Bug 2 — megaplay ED à 21:20 au lieu de 21:15 (même contenu/durée que les autres).** Prouvé au pixel : megaplay@1362 == sibnet@1362 (frame « 制作 MAPPA » identique) → **même timeline**. megaplay = source `mewstream.buzz` (HLS, construite depuis le MAL id), keyframes clairsemées → match **credited faible (137 votes)** qui **overridait l'audio très fort (2616 votes)** et décalait le start de ~10s. L'ED ouvrant sur un **aplat cyan sans détail**, l'image ne peut pas y planter un bord.
- **Fix** : `CREDITED_OVERRIDE_AGREE_BAND_S=4.0` — un credited n'override un hit audio **fort** que si son `theme_t0` est à ≤4s de l'ancre audio. Désaccord large → on **garde l'alignement audio** (flag `video_disagreement`). Ne gate que l'audio fort ; audio faible/absent cède au credited comme avant. megaplay ép3 : ED **21:20→21:10** (audio, vrai ≈21:12). Fin encore ~6s tôt (22:38 vs ~22:44) : son credited HLS reste trop pauvre pour caler le fondu — plafond de la source.

Aussi : `diag_match.ms()` floor → **round-to-nearest** (le floor biaisait chaque timecode ~1s tôt).

**Constat clé** : les 3 lecteurs anime-sama (sendvid/sibnet/vidmoly) donnent un résultat **identique au dixième** (même source). Seuls **megaplay** (mewstream) et **vidmoly-va** (voir-anime) divergent = providers réellement différents (encodage/keyframes/intro). Les bords OP/ED étant des fondus/aplats, le calage image y est intrinsèquement ambigu.

**Prochaine piste (idée user)** : **ancrage sur image-repère** — repérer 1–2 frames *distinctives* (haute entropie) de la réf credited, les localiser (match unique) dans l'épisode, et **projeter** les bords via la géométrie connue du clip, au lieu de planter le bord sur un aplat/fondu. Devrait fixer megaplay (une seule keyframe repère suffit) et les fins en fondu. Plan à établir.

## 2026-07-10 — OP/ED : précision ~0.25s sur les 4 bords (refine image *credited* dense)

Problème : le détecteur OP/ED se trompait de plusieurs secondes, surtout sur la **dernière frame de l'ED**. Objectif user : que la « dernière frame » de notre timing soit à ~0.25s près de la vraie dernière frame dans le player, sur **les 4 bords**.

**Cause racine (3 cumuls)** :
1. Précision vidéo plafonnée à ~0.5–1s : `SAMPLE_FPS=2.0` + bins de vote arrondis à 1s entière (`best_match_video`).
2. Fin credited déléguée à l'audio (`_refine_hit(end_only=True)`) — or la dernière frame IMAGE d'un fondu au noir ne correspond à aucun cut audio.
3. API `opedRowToSkip` arrondissait à la **seconde entière**.

**Fix — refine dense ancré sur l'image credited** (décision user : précision d'abord, décodage dense OK) :
- `video_fingerprint.py` : nouveau `refine_edge_credited_video()` **pur** — re-décode ep + réf credited à `DENSE_FPS=12` sur une fenêtre ±3s autour du bord grossier, apparie chaque frame ep à sa frame réf alignée (`t_ref = t_ep - theme_t0`), et trouve la transition sub-seconde (start = 1er run soutenu matché ; end = dernière frame matchée — **robuste au fondu au noir** car ep+réf fondent ensemble et matchent jusqu'à la dernière frame credited). + `decode_dense_window()`.
- **Bug latent corrigé** : `extract_keyframe_hashes` ne mettait PAS `fps` dans la clé de cache → un décodage 12fps aurait renvoyé le `.vfp.npz` 2fps. Tag `.fps12` ajouté ; tag vide à 2fps → caches existants préservés.
- `theme_bank.py` : champ `ThemeHit.video_theme_t0` (ancre stable) ; `_refine_credited_dense()` OWN les 2 bords d'un hit credited (remplace le snap audio `end_only`) ; **sharpe aussi les hits audio** quand une réf credited existe, **gardé** par plancher de votes + bande de sanité ±2s (`DENSE_AUDIO_SHARPEN_BAND_S`) + flag `sharpen_audio_with_credited`. Sans réf credited → refine audio inchangé (fallback).
- Threading `resolve_video_dense` : `detect_op_ed` → `multi_host` (`detect_per_host`/`detect_op_ed_multi`, **sans** resserrer les tolérances d'outlier) → `batch_detect.py` + `detect_anime.py` (single + multi-host).
- API `pages/api/v2/skip` : arrondi 2 décimales au lieu d'entier (DB stocke déjà des floats). Fallbacks AniSkip/Anime-Skip laissés à la seconde.

**Vérif** : unit test pur (bords exacts, None si pas de match) ✓ ; test d'intégration `detect_op_ed` avec resolvers mock (fondu au noir) → erreur de fin **0.067s** ✓ ; tout compile, rétro-compatible (params optionnels).

**Leçon/piège** : le refine dense attend des `times` **window-relatifs** (comme `decode_dense_window` les produit) + `*_win_off` ; en full_fallback (audio None) `used_win=None` → `_abs_offset=0`, donc `resolve_video(None)` doit renvoyer des times **absolus**. **Reste à faire** : check visuel décisif sur vrai anime (JJK ED1 fondu au noir) via `detect_anime.py` + extraire la frame à `end` avec ffmpeg pour confirmer que c'est bien la dernière frame de l'ED.

## 2026-07-06 (suite 21) — toasts player : pile collapse sonner (max 3) + barre fine teintée + croix

Retours user : la barre était trop épaisse / mal placée / trop blanche « flashy », et en fullscreen les toasts s'empilaient à l'infini au lieu de se collapser comme sonner (max ~3 visibles derrière, + une croix).

- **Pile collapse (fullscreen)** : on ne rend que les **3 plus récents** (`slice(-3).reverse()`). Le plus récent est devant (bas-droite), pleine opacité ; les 2 derrière sont `translateY(-14px*depth) scale(1 - 0.05*depth)`, opacité 0.6, `transformOrigin: bottom right` — le look « collapsed » de sonner. Chaque toast a un **bouton ✕** (top-right) pour le fermer. Conteneur `height:0` comme ancre absolue.
- **Barre de temps** : réduite **3px → 2px**, et **teintée `color-mix(in srgb, currentColor 45%, transparent)`** au lieu de blanc — `currentColor` = le texte rouge du toast → la barre matche la carte au lieu d'un trait blanc criard. Appliqué à la réplique in-player ET aux toasts sonner (`[data-sonner-toast]::after`, `currentColor` = couleur de texte richColors par type).

## 2026-07-06 (suite 20) — toasts player : barre de compte à rebours + vraie pile en fullscreen

Retours user : (1) ajouter sous chaque notif une petite barre blanche indiquant le temps restant ; (2) en fullscreen les notifs doivent **s'empiler** comme en fenêtré (avant : 2 slots fixes subNotice/chatWarning → une nouvelle notif identique écrasait la précédente).

- **Pile réelle in-player** : remplacé les états `subNotice`/`chatWarning` par une **file** `playerToasts: {id,msg,dur}[]` (id auto-incrémenté). `pushPlayerToast(msg,dur)` ajoute + programme le retrait ; `dismissPlayerToast(id)` filtre. `showPlayerNotice(msg,dur)` route : fenêtré → `toast.error` (sonner), fullscreen/pseudo-FS iOS → `pushPlayerToast`. `showSubNotice` = wrapper 3500 ms ; chat = 2600 ms. Timers nettoyés à l'unmount.
- **Barre de compte à rebours** : keyframe `toastCountdown` (scaleX 1→0). Réplique in-player : `<span>` absolu en bas, `animation: toastCountdown {dur}ms linear forwards` (conteneur `overflow:hidden` + `position:relative`). Toasts sonner fenêtrés : `[data-sonner-toast]::after` (sonner 1.0.3 n'a pas de barre native) animé sur 4 s (durée par défaut), coins bas via `border-bottom-*-radius: inherit` (pas d'`overflow:hidden` pour ne pas rogner le closeButton). Masqué sur `[data-removed=true]`.

## 2026-07-06 (suite 19) — notices subs/chat : vrai toast sonner en fenêtré, réplique in-player en fullscreen

Retour user (suite de la suite 17) : il veut le **vrai toast sonner** du site (carte rouge richColors, bas-droite) en mode fenêtré, et **la même chose répliquée dans le player** en plein écran (où un toast sur `<body>` est masqué).

- `inFullscreenNow()` : helper qui teste `fullscreenElement || webkitFullscreenElement || iosPseudoFsRef.current` (le pseudo-fullscreen iOS CSS masque aussi les toasts `<body>`). `iosPseudoFsRef` = mirror de l'état `iosPseudoFs` (synced via effect).
- `showSubNotice` et le handler `partyChat` (pas de party) : **fenêtré → `toast.error(msg)`** (sonner, exactement le style du site) ; **fullscreen → `setSubNotice`/`setChatWarning`** qui alimentent la réplique in-player.
- Réplique in-player restylée aux **couleurs exactes de sonner 1.0.3 richColors "error" (dark)** : bg `hsl(358,76%,10%)`, bordure `hsl(357,89%,16%)`, texte `hsl(358,100%,81%)`, + icône cercle-exclamation rouge, gras 600 — identique au toast fenêtré. Toujours portalée dans `playerElState`, bas-droite (`right:16, bottom:88`), empile subs+chat.
- `toast.error` (rouge) et non `warning` (ambre) pour coller au SS fourni par le user.

## 2026-07-06 (suite 18) — Ctrl+R rotait la vidéo au lieu de recharger

Bug : `comboFromEvent` ne garde que le `event.code` physique (ex. `keyr`) et **ignore les modificateurs**. Donc `Ctrl+R` matchait le binding `rotate` (r) et `preventDefault()` tuait le reload navigateur. Idem pour tout chord OS (Cmd+L, Ctrl+T…).

Fix dans le dispatcher clavier (`UniversalPlayer`, `onKey`) : on **bail avant le lookup si `ctrlKey || metaKey` est actif**, sauf si la touche pressée EST elle-même un modificateur (`code` commence par `control`/`meta`) — pour ne pas casser un binding standalone sur Ctrl/Meta. L'éditeur ne peut de toute façon pas binder de combo Ctrl/Meta, donc un tel chord est toujours celui du navigateur.

## 2026-07-06 (suite 17) — notices player (subs incrustés / chat) au format toast du site (bas-droite, fullscreen-safe)

Retour user : les bannières in-player « sous-titres incrustés » (bas-centre) et « rejoins une party » (haut-centre) marchaient mais ne ressemblaient pas aux toasts sonner du reste du site (petite carte en bas-droite). On veut le même look **tout en restant visible en plein écran**.

- Un vrai `toast()` sonner rend dans `document.body` → invisible quand `.vds-player` est l'élément fullscreen. Donc on ne peut pas juste réutiliser sonner.
- Solution : une **pile de toasts in-player** unique, portalée dans `playerElState` (createPortal), stylée comme la carte sombre de sonner (rounded 12, `rgba(10,10,10,0.94)`, bordure blanche 12 %, blur, ombre), positionnée **bas-droite** (`right:16, bottom:88` pour passer au-dessus de la barre de contrôle). `pointer-events:none` sur le conteneur, `auto` sur chaque carte (clic = dismiss).
- `subNotice` et `chatWarning` (états existants) sont routés dans cette même pile et **empilés** (gap 8). Supprimé les deux anciens blocs (bas-centre + haut-centre). Timers d'auto-dismiss inchangés (3,5 s / 2,6 s).

## 2026-07-06 (suite 16) — countdown négatif + trads manquantes (schedule) + keys tooltip + onglet Découvrir

Retours user :
- **Compte à rebours "à ne pas manquer" affichait des valeurs négatives** (`-1 j / -3 h / -34 min / -53 s`) : quand l'heure de diffusion cible est déjà passée, `countDown` devient négatif et `Math.floor` propage le signe sur chaque unité. Corrigé dans `useCountdownSeconds` : `Math.max(0, rawCountDown)` en tête de `getReturnValues` → on affiche 0/0/0/0 jusqu'à ce que `update()` charge le prochain épisode.
- **"Don't miss out!" / "Coming Up Next!" en dur** dans `components/home/schedule.js` (jamais traduits). Extraits en `home.dontMissOut` / `home.comingUpNext` (en + fr : « À ne pas manquer ! » / « Prochainement »).
- **Tooltip de l'éditeur de raccourcis : noms de touches en dur en français** (`capGlyph` retournait « Espace », « Entrée », « Flèche gauche »…). Passe par `shortcuts.keys.*` (en+fr), `capGlyph(code, t)`. Les labels imprimés SUR les caps AZERTY (ù, *, ;) restent tels quels.
- **Onglet FR "Découverte" → "Découvrir"** (`nav.discover`).

## 2026-07-06 (suite 15) — layout raccourcis corrigé + icône chat + ghosts Entrée/Espace + chat non-fullscreen

Retours user (2e passe sur les raccourcis) :
- **Layout corrigé (v4→v5)** : `$`=frameFwd, `^`=frameBack, `p`=prevEp, `o`=PiP, `s`=stats, `d`=cast, `f`=fullscreen, `c`=subs, `v`=screenshot, `b`=lien, `n`=nextEp, `;`=rateDown, `:`=rateUp. `keym`/`keyg`/`keyi` deviennent libres. Bump storage sinon les maps v4 sauvegardées écrasent les nouveaux défauts.
- **Icône chat** = SVG Material "chat" fourni par le user (bulle + lignes de texte), remap `translate(0,24) scale(0.025)`.
- **Ghost de drag** : retiré le cap de largeur à 240px (l'Espace prend enfin sa vraie largeur ; Chrome snapshot les images larges tant que le ghost est opaque + on-screen). Enter = moitié haute de la case (rectangle large 1.5u × 1 rangée), pas le bounding box 2 rangées.
- **Chat non-fullscreen ne force plus le plein écran** : le handler `partyChat` dispatch juste `aniscroll:openPartyChat`. En fullscreen → `FullscreenChat` (gate `active`) ouvre + focus ; fenêtré → `WatchPartyPanel` (gate `!document.fullscreenElement`) focus son composer. Exactement un des deux réagit.
- **Message d'erreur "pas dans une party" visible en fullscreen** : `toast.error` rend dans `document.body` → invisible quand le player est l'élément fullscreen. Remplacé par une bannière éphémère (`chatWarning`) rendue DANS le player (z-60, auto-dismiss 2.6 s).

## 2026-07-06 (suite 14) — ghost Entrée trop petit + megaplay sous les menus + doublon seek ±5s

Retours user :
- **Ghost de drag de la touche Entrée trop petit** : `onDragStart` mesurait `e.currentTarget` (le cap intérieur) qui porte `transform: scale(0.9)` au survol — or une touche est TOUJOURS survolée au moment où on la saisit → rect 10 % trop petit. Corrigé : on mesure le **parent** (la case de grille, jamais scalée) et on retire l'inset `GAP_PX`. Pour l'ISO Enter (forme en L, `h:2`) le ghost prend la **moitié haute** (tuile 1 rangée large) plutôt que le bounding box 2 rangées — marqué via `data-enter="1"`.
- **Gros bouton play (megaplay) par-dessus les menus** : `CenterPlayButton` (z-index 15) couvrait chapitres/settings/sous-titres Vidstack. Il n'apparaît qu'avant le 1er play (`everStarted`), donc visible si position reprise mais jamais lancée. Corrigé : on lui passe `menuOpen={vdsMenuOpen}` (état déjà suivi via `data-open`) → `return null` quand un menu est ouvert, réapparaît à la fermeture.
- **Doublon raccourci seek ±5s** : `seekBackwardLong`/`seekForwardLong` (j/l) faisaient exactement le même ±5s que `seekBackward`/`seekForward` (flèches). Supprimé les deux actions "Long" (type union, catalog, defaults, switch, icônes, i18n en/fr).
- **cycleServer (z) suit l'ordre d'affichage** : le handler dans [...info].js itérait sur l'ordre brut de `lib/servers` filtré par confirmed only. Réécrit pour reproduire EXACTEMENT l'ordre du sélecteur : `[...multi, ...vo, ...vf]` (chaque groupe fastest-first via `getServersByLang`) filtré par la même règle `shouldShow` (actif toujours visible, failed masqué, iframe toujours visible, sinon confirmed). Dépend maintenant aussi de `failedServers`.
- **Nouveau layout de raccourcis par défaut** (SS user = source de vérité) : gros reshuffle de `DEFAULT_KEYBINDINGS`. Rangée haute : cycleServer=e, rotate=r, PiP=i, prevEp=o, frameBack=p, frameFwd=^. Home : partyChat=t, stats=d, cast=f, fullscreen=g, ambient=l, mute=m(semicolon), OP=ù(quote), ED=*(backslash) — **skipIntro/Outro quittent PgUp/PgDn**. Rangée basse : subs=x, screenshot=c, copyLink=v, nextEp=b, rateDown=,(keym), rateUp=;(comma), rateReset=!(slash). Volume reste sur flèches (confirmé user). **Bump storage v3→v4** sinon les maps sauvegardées (anciennes positions) écrasaient les nouveaux défauts au merge.
- **Nouveau raccourci "parler dans le chat" sur `t`** (`partyChat`) : action ajoutée (type/catalog/défaut/icône bulle/i18n en+fr). Handler : si pas de `party` → toast `party.chatNeedsParty` ; sinon entre en plein écran (le chat est fullscreen-only) puis dispatch `aniscroll:openPartyChat`. `FullscreenChat` écoute l'event (gate `active`), ouvre le panneau + focus le composer. Pas de re-trigger : le composer est `contentEditable`, le guard clavier ignore déjà `isContentEditable`.

## 2026-07-06 (suite 13) — w2g create 500 (zadd NX cassé dans le shim REST) + icônes ambient/reset + drag espace

Retours user (SS console : `/api/v2/watch2gether/create` → 500) :
- **Impossible de créer une room** : `createRoom` → `addMember` fait `redis.zadd(orderKey, "NX", ts, userId)` (syntaxe ioredis : flag NX en tête). Le shim REST (`lib/redisRest.ts`) faisait `const [score, member] = args` → `score = Number("NX") = NaN`, `member = ts`. Upstash REST **rejette un score NaN par un 500** → tout le create tombe. **Bug transverse** : cassait TOUS les `zadd` avec flag NX (ordre membres w2g, `touchPresence`, cache saison…). Corrigé : `zadd` du shim **épluche les flags de tête** (NX/XX/GT/LT/CH) en objet d'options Upstash avant de lire la paire score/member. `zrange` gère aussi `WITHSCORES` (passe `{withScores:true}`, sortie aplatie comme ioredis). Vérifié contre la signature `@upstash/redis@1.38` (`zadd(key, opts, {score,member})`).
- **Icône raccourci "Ambient lights"** = même glyphe que le toggle Settings > Ambient (Material `lightbulb_outline`), pour la cohérence.
- **Icône `rateReset`** = SVG fourni par le user : cadran Material "speed" complet avec **aiguille en haut-droite** (vitesse neutre), remap `translate(0,24) scale(0.025)`.
- **Drag de la barre espace enfin réparé** : le ghost de `setDragImage` était créé à la **taille réelle** de la touche (~500px pour l'espace) ET **hors écran** (`-9999px`) → Chrome **annule le drag** dans ce cas. Ghost repassé en **tuile fixe 44px** rendue **à l'écran** (`top:0;left:0;z-index:-1`) → toutes les touches (espace inclus) se glissent.
- `tsc`/`lint` ok.

---

## 2026-07-06 (suite 12) — Raccourcis : action ambient, cap vitesse x2, ghost de drag opaque, icônes

Retours user :
- **Nouvelle action `toggleAmbient`** (activer/couper les ambient lights) : handler `setAmbientCtx(!ctxAmbient)`, catalogue (groupe view), default sur cap "p"/`keyp` (libre depuis le retrait de seekToEnd), i18n fr/en, icône ampoule+rayons. Catalogue = 37.
- **Vitesse plafonnée à x2** : `rateUp` `Math.min(2,…)` + clamp interne de `onRateChange` (4→2). (Note perf : à x2 le `<video>` décode/joue nativement 2× plus vite ; pas de « skip de frames » applicatif possible/pertinent — c'est le décodeur qui suit ou non. Rien à optimiser côté JS.)
- **Debug raccourci retiré** (le vrai fix était le garde `!event.request`, cf. suite 11).
- **rateReset** : aiguille **verticale centrée** (neutre) + arc demi-cercle symétrique + badge reset (au lieu du cadran Material asymétrique).
- **Ghost de drag = tuile opaque** construite (fond `#20242c` + icône) au lieu du clone de la touche : le clone était quasi-transparent (fill sur enfants absolus) → le navigateur en faisait un halo ovale flou. Rectangle net désormais, à la vraie taille de la touche.
- `tsc`/`lint`/JSON ok.

---

## 2026-07-06 (suite 11) — Raccourcis : FIX vitesse (garde !event.request), pavé num, icônes, hint

Retours user :
- **Vitesse ne faisait rien — CAUSE trouvée** : `onRateChange(next)` **retourne tôt si `!event?.request`** (ligne ~1562, pour ignorer les auto-resets de Vidstack). Les raccourcis l'appelaient **sans event** → no-op. FIX : les handlers `rateDown/rateUp/rateReset` posent `video.playbackRate` **directement** (effet immédiat) PUIS `onRateChange(r, { request: true })` (persistance + sync Vidstack).
- **Pavé numérique** : les touches émettent `event.code = "NumpadN"`, pas `DigitN` → aucun match. `comboFromEvent` **replie `numpadN` → `digitN`** (Num Lock requis pour émettre NumpadN).
- **Debug raccourcis** : log `[shortcut] {code, combo, action, hasVideo, rate}` derrière `localStorage.scDebug === "1"`.
- **Escape ferme** : listener déjà en place (suite 9), inchangé — capture sur window + stopPropagation.
- **rateReset** : remplace la roue-« soleil » du SVG par le **speedometer** (cadran de rateUp/Down) + badge flèche-reset en haut-droite.
- **frameBackward** : flèche décalée +1px à droite.
- **Hint du haut** : 2e phrase retirée (dragHint fr/en = juste « Glissez-déposez une icône sur la touche voulue. »).
- `tsc`/`lint`/JSON ok.

---

## 2026-07-06 (suite 10) — Raccourcis : tooltip en mots, cap "m" clair, retrait seekToEnd, icône reset-speed

Retours user :
- **Tooltip au survol = NOM de la touche en toutes lettres** (avant : symboles `↵ ⌫ ⇧`). `capGlyph` renvoie maintenant "Entrée", "Espace", "Échap", "Retour arrière", "Flèche gauche/droite/haut/bas", "Verr. Maj", "Maj gauche/droite", "AltGr", "Menu", etc.
- **Cap "m" trop foncé** : son code physique est `semicolon` (pas `key*`), donc `isMain` le classait "non-principal". Ajouté `semicolon` à `MAIN_PUNCT` → clair comme les autres lettres.
- **Retrait de l'action `seekToEnd`** ("Aller à la fin") : supprimée du type, catalogue, defaults (libère le cap "p"/`keyp`), handler, icône, i18n fr/en. Catalogue = 36 actions.
- **Icône `rateReset`** = SVG Material "speed + gear" fourni (compteur avec engrenage de réglage), remap `translate(0,24) scale(0.025)`.
- `tsc`/`lint`/JSON ok.

---

## 2026-07-06 (suite 9) — Raccourcis : FIX codes AZERTY rangée du bas, Escape ferme, icônes échangées

Retours user :
- **Vitesse (et `,`) ne marchaient toujours pas** — CAUSE : les `event.code` de la **rangée du bas** étaient faux. `event.code` nomme la position **physique QWERTY** ; sur AZERTY les caps `, ; : !` sont aux positions physiques **KeyM / Comma / Period / Slash**, pas `comma/period/slash/intlbackslash`. Corrigé : cap ","→`keym`, ";"→`comma`, ":"→`period`, "!"→`slash`. Defaults ajustés (rotate→`keym`, rateDown→`comma`, rateUp→`period`, rateReset→`slash`). Storage bump **v3**. (Les autres rangées étaient déjà correctes.)
- **Escape ferme l'éditeur** : `useEffect` keydown (capture) → `onClose()` sur `Escape`.
- **seek ±5 : icône = juste texte « −5 » / « +5 »** (plus de flèche circulaire).
- **Échange épisode ↔ frame** : les icônes cadre-photo + flèche vont sur `frameBackward/frameForward` (image préc./suiv.) ; `prevEpisode/nextEpisode` reprennent les chevrons |◄ / ►|.
- **Flèche du cadre frameBackward** décalée à droite (plus de superposition avec le bord).
- **Mute** : ✕ encore décalée à droite.
- `tsc`/`lint` ok.

---

## 2026-07-06 (suite 8) — Raccourcis : FIX matching (event.code), rotate remplace mirror, seek ±5, nouvelles icônes

Retours user, dont un **bug fonctionnel majeur** :
- **« la plupart des boutons ne marchent pas » (chiffres rangée du haut, rateDown, …)** — CAUSE RACINE : le matching se faisait sur `event.key`. Sur **AZERTY**, la rangée des chiffres et une bonne part de la ponctuation (`; : ! ^ $ * ù`) n'émettent leur caractère qu'**avec Shift** ; une frappe simple donne `&é"'(-è_ç…`, donc le combo stocké (`"1"`, `";"`) ne matchait jamais. FIX : tout le système passe à **`event.code`** (position physique, indépendante du layout et de Shift). `comboFromEvent` = `e.code.toLowerCase()`. Les caps de l'éditeur portent maintenant leur `event.code` (`digit1`, `keyq`=cap "a", `semicolon`=cap "m", …) + un `label` d'affichage AZERTY. Defaults réécrits en codes. **Bump storage key → `aniscroll:keybindings:v2`** pour jeter les anciennes valeurs key-based.
- **`mirror` → `rotate` (rotation 90°)** : action, catalogue, handler (cycle 0/90/180/270 via `transform: rotate()`), i18n (fr/en), icône (SVG Material "rotate 90°" fourni). Plus d'action `mirror`.
- **seek ±10 → ±5** : `seekBackwardLong`/`seekForwardLong` passent à 5s ; icônes = flèche circulaire replay/forward avec un **« 5 »** au centre.
- **prevEpisode/nextEpisode** : nouvelle icône = cadre photo Material + montagnes, **flèche gauche (prev) / droite (next)**.
- **mute** : ✕ décalée plus à droite, détachée du haut-parleur.
- **rateUp** = miroir horizontal du cadran, badge `+` en haut-droite (inchangé depuis suite 7).
- Drag = clone de la vraie touche (suite 7) : devrait régler l'aperçu bizarre de l'espace ; à confirmer en interaction réelle.
- `tsc`/`lint`/JSON ok ; 37/37 defaults sur le board, aucun doublon.

---

## 2026-07-06 (suite 7) — Éditeur raccourcis : clavier ×1.5, icônes +, drag = vraie forme de touche, rateUp miroir

Retours user (SS) :
- **Clavier ×1.5 (pas 1.8)** : `max-w` `min(1400px,94vw)` → `min(1200px,92vw)`.
- **Icônes bien plus grandes** : `width/height` 17→26px.
- **Aperçu de drag = vraie forme/taille de la touche** : `onDragStart` clone maintenant `e.currentTarget` (l'élément touche réel) à sa `getBoundingClientRect()` et le passe à `setDragImage` — donc glisser la barre espace donne un ghost large, l'Enter ISO sa forme en L, etc. (avant : carré fixe 44px figé à l'ancienne taille). Retrait de l'`id="sc-icon-*"` et du ghost synthétique devenus inutiles.
- **rateUp = miroir horizontal (axe Y) de rateDown** : le cadran est mirroré (`translate(23,22.5) scale(-0.02,0.02)`) → aiguille sort à gauche ; le badge **+ reste en haut-droite** (non mirroré). rateDown inchangé (ouverture à droite + −).
- `tsc`/`lint` ok.

---

## 2026-07-06 (suite 6) — Éditeur raccourcis : gap uniforme px, clavier ×1.8, ghost de drag, Enter highlight opaque, icône vitesse pleine

Retours user (SS) :
- **Rendu bizarre au drag de l'espace** (aperçu étiré à la taille de la touche large) : `onDragStart` crée un **ghost custom** de taille fixe (44px) qui copie l'icône (via `id="sc-icon-<action>"` posé sur le `<svg>` de la touche) et le passe à `setDragImage`, puis le retire au tick suivant. Aperçu de drag identique quelle que soit la largeur de touche.
- **Rose du Enter bizarre au survol-drop** : le highlight `isDrop` passait par un rgba **0.35** → les 2 rects superposés de l'Enter ISO doublaient l'alpha (patch plus foncé au croisement). Passé en **couleur opaque** `#6f2338` → forme en L uniforme.
- **Espacement ×3 + gap uniforme** : le padding `%` n'était pas uniforme (grille 16×5 non carrée → colonnes très espacées, rangées serrées). Remplacé par un **inset px fixe** (`GAP_PX=6`) → gap identique sur les 4 côtés.
- **Clavier ×1.8** : `max-w` fixe → `min(1400px, 94vw)`.
- **Icône vitesse refaite** (aiguille non centrée / ouverture à gauche) : retour au **path Material "speed" complet** (cadran + aiguille centrée intégrée), scale 0.02, l'aiguille sort par l'**ouverture à droite** ; même cadran pour down/up, seul le badge −/+ change (coin haut-droite). Vérifié en zoom.
- `tsc`/`lint` ok.

---

## 2026-07-06 (suite 5) — Éditeur raccourcis : espacement +, clavier +, badge vitesse en haut-droite

Retours user (SS) :
- **Espacement encore trop petit** : `GAP` inset 0.9→1.4.
- **Clavier un peu plus grand** : `max-w` 720→820px.
- **Badge −/+ des icônes vitesse illisible (superposé au cadran)** : cadran réduit (`scale(0.021)`) et décalé en bas-gauche (`translate(-1.5,25.5)`) pour libérer le coin haut-droite ; le badge y est placé, agrandi et arrondi (− = rect rx1, + = croix épaisse). Aiguille resserrée en conséquence. Vérifié en zoom : cadran + aiguille + badge distincts dès 18px.
- `tsc`/`lint` ok.

---

## 2026-07-06 (suite 4) — Éditeur raccourcis : plus d'espacement, `- = ^ $ ù *` en clair, icônes vitesse "speedometer"

Retours user (2 SS) :
- **Touches encore trop serrées/collées** : `GAP` inset 0.45→0.9 (espacement franc entre touches, comme le 2e SS de réf).
- **`- = ^ $ ù *` ajoutés au groupe clair** : `isMain` = `[a-z0-9]` **plus** `MAIN_PUNCT` (Set `, ; : ! - = ^ $ ù *`) — passage regex→Set pour ne pas avoir à échapper `- $ ^ *`. Reste foncé : tab, entrée, espace, nav, modificateurs, capslock.
- **Icônes rateDown/rateUp refaites** d'après le SVG Material "speed" fourni : cadran (dial) commun + aiguille orientée (bas-gauche = ralentir, bas-droite = accélérer) + badge −/+. Le path Material est en viewBox `0 -960 960 960` → remis dans `0 0 24 24` via `<g transform="translate(0,24) scale(0.025)">` (piège : PAS de flip `-0.025`, sinon le cadran disparaît hors-cadre). Aiguille + badge dessinés directement en 24×24.
- `tsc`/`lint` ok ; vérif réplique (clavier + zoom des 2 icônes vitesse).

---

## 2026-07-06 (suite 3) — Éditeur raccourcis : clavier plus compact, teinte foncée constante, `,;:!` en clair

Retours user (screenshot) :
- **Clavier trop gros / touches collées** : `max-w` 860→720px et `GAP` inset 0.2→0.45 (touches à nouveau distinctes, board plus compact — sur le SS il débordait à ~1120px).
- **Teinte foncée indépendante de l'action** : le fond ne dépend plus de `action` — `isMain` (alphanumérique) → `#20242c`, tout le reste → `#181b21`, **avec ou sans action**. Une touche nav vide reste plus sombre qu'une touche lettre vide. La distinction assigné/vide se fait par la présence de l'icône, plus par la couleur.
- **`, ; : !` reclassés "main"** (couleur claire comme lettres/chiffres) : regex `isAlnum`→`isMain` = `[a-z0-9,;:!]`. (`^ $ ù *` restent dans le groupe foncé.)
- `tsc`/`lint` ok ; vérif réplique + screenshot.

---

## 2026-07-06 (suite 2) — Éditeur raccourcis : touches jointives, non-alphanum plus sombres, icônes OP/ED partagées

Retours user (screenshot) :
- **Espacement resserré** : `GAP` inset 0.55→0.2 (touches quasi jointives, comme la réf).
- **Touches non-lettres/chiffres plus sombres** : nouveau test `isAlnum` (`[a-z0-9ùç^$]`) — les touches alphanumériques gardent `#20242c` (assigné) / `#131519` (vide un peu foncé), tout le reste (nav, modificateurs, ponctuation, espace, entrée…) prend `#181b21` quand assigné, même vide sinon — lisible comme un vrai clavier où la zone de frappe se distingue du reste.
- **skipIntro/skipOutro réutilisent l'icône du menu Settings > Automation** (badge cadre arrondi + monogramme "OP"/"ED", `SettingsToggleRow` dans `UniversalPlayer.tsx`) au lieu d'un chevron générique — même glyphe aux deux endroits où l'action apparaît.
- `tsc`/`lint` propres ; vérif visuelle via réplique + screenshot headless.

---

## 2026-07-06 (suite) — Éditeur raccourcis : tout assignable, Enter ISO, fond flou, header minimal

Retours user (5 points) :
- **Toutes les touches assignables** (plus de touches « mortes » plus foncées) : les modificateurs ont maintenant un code = `event.code` minuscule (`shiftleft`, `shiftright`, `controlleft`, `metaleft`, `altleft`, `altright`, `capslock`, `contextmenu`) — ça distingue les 2 Shift (même `event.key`). `comboFromEvent` retourne désormais le code seul pour un modificateur pressé (sans se préfixer lui-même) ; le handler inline d'UniversalPlayer (qui ignorait les modificateurs et dupliquait la normalisation) est remplacé par `comboFromEvent` — source unique.
- **Enter en vraie forme ISO** : deux rects arrondis superposés (moitié haute pleine largeur 1.5u, moitié basse 1.25u alignée droite) — tous les coins convexes restent arrondis (un `clip-path` aurait donné des coins vifs). Capslock rétabli à 1.75u, ghost 1.25u. Icône centrée sur la moitié haute.
- **Toutes les actions assignées par défaut, aucune désassignation possible** : `skipIntro`=pageup, `skipOutro`=pagedown (37/37 liées, plus de `null`). Tray supprimée. `getKeybindings()` **purge les valeurs null/vides** du localStorage (anciennes versions permettaient l'unbind) pour que le défaut reprenne la main.
- **Header minimal juste au-dessus du clavier** : texte raccourcis à gauche, Réinitialiser + croix à droite. Hint bas + `keyboardHint` (locales) supprimés. Tooltip pill = absolute au-dessus du board (plus de rangée réservée).
- **Fond = flou** (`backdrop-filter: blur(20px)` + noir 45 %), plus de sheet noire ; **clavier réduit** (max-w 1040→860, icônes 19→17px, bezel p-3/r-18, touches r-8).
- `tsc`/`lint`/JSON ok ; réplique + screenshot headless conformes.

---

## 2026-07-06 — Éditeur raccourcis : clavier AZERTY 75 % (nav en ligne), fix icône espace

Retours SS (2e screenshot) : ordre de touches exact demandé, style laptop 75 %. Le commit `507b782` (fait entre deux sessions) avait déjà l'AZERTY mais avec un **pavé nav détaché** à droite (trou au milieu) — pas conforme à l'ordre donné. Corrections :
- **Layout 75 %** : les touches nav sont **en ligne** en bout de rangée — `delete` (fin R1), `home` (après Enter, R2), `pageup` (fin R3), `↑`+`pagedown` (fin R4), `←↓→` (fin R5). Plus de cluster `NAV` séparé ; chaque rangée totalise exactement **16 unités**.
- **Enter ISO sur 2 rangées** (w1.5, h2) ; capslock réduit à 1.5u pour que la moitié basse du Enter ne chevauche pas `*`. Nouvelle notion `ghost` dans `Key` = cellule sous le Enter, **non rendue** (sinon elle se dessinerait par-dessus).
- **Fix bug icône espace au drag** : icône SVG en taille fixe (19px) centrée en absolu — ne s'étire plus avec la touche large (déjà dans `507b782`, confirmé avec le nouveau layout).
- Coordonnées toujours **calculées** (walk gauche→droite par rangée) — zéro x manuel, zéro collision.
- Vérif : réplique HTML générée depuis les sources + screenshot Edge headless (rangées alignées, Enter tall OK, espace OK). `tsc`/`lint` propres ; les 35 defaults pointent tous vers des touches présentes.
- Piège local (nouvelle machine, chemin OneDrive) : Edge headless ne résout pas les chemins courts `LUC~1.DEL` en URL `file:///` — utiliser le chemin long complet.

---

## 2026-07-05 (suite 4) — Éditeur raccourcis : polish visuel SS + retrait 2 actions

Retours SS : le clavier ne collait toujours pas. Corrections :
- **Fond noir pur, zéro bordure** partout (bezel `#0b0c0f` arrondi 22px sur `#000`, touches `#20242c`/`#15171c` **sans bordure**). Couleurs alignées sur le SS.
- **Toutes les touches** animent au hover (rétract `scale(0.9)`), y compris les vides (avant : seules les assignées).
- **Plus de désassignation** : suppression du double-clic-pour-libérer et de la tray « drop to unbind ». Déposer une action sur une touche occupée **échange** les deux (aucune action perdue). Les actions hors board vivent dans une tray fine ; les y déposer évince le résident vers la tray.
- **Retrait de `cycleAspect` (ratio d'image) et `toggleTheater` (mode cinéma)** (demande user). L'event `aniscroll:toggleTheater` n'est plus émis.
- **Icônes refaites** (jugées moches/cassées) : `rateDown/Up` (triangle + badge −/+), `seekBackwardLong/Long` (double-chevron replay/forward-10, distinct des ±5s), `mirror` (2 triangles autour d'un axe), `skipIntro/Outro` nettoyés.
- Vérif visuelle : réplique HTML statique générée depuis les sources (ROWS/defaults/icons) + screenshot headless Edge (le dev server Next ne build pas en local — `@upstash/redis`/`ably` absents, cf. entrées précédentes ; ne PAS `npm install` ces paquets, ça prune des deps hors-lockfile). Rendu conforme au SS.
- Catalogue = **39 actions**. `tsc`/`lint`/JSON propres, defaults sans collision.

---

## 2026-07-05 (suite 3) — Éditeur raccourcis refait « keyboard-only » (design SS) + 4 actions

Retour user : le two-pane (liste à gauche + clavier) ne correspondait pas au SS. Il veut **QUE le clavier**, centré, sans encadré ni liste latérale ; **hover d'une touche = tooltip « Touche : Action »** + la touche **rétrécit** (anim `scale(0.9)`) ; **defaults = exactement ceux du SS** (mêmes icônes sur mêmes touches).

### Refonte [ShortcutEditor.tsx](components/watch/primary/ShortcutEditor.tsx)
- Plein écran, **clavier seul centré** (plus de carte/bordure autour, plus de colonne d'actions à gauche). Barre du haut = titre + Réinitialiser + fermer.
- **Tooltip flottant** au survol (pill noire au-dessus du clavier), **key retract** au hover.
- Drag & drop **touche → touche** pour déplacer une icône ; **double-clic** = libérer. Les actions **non placées** vivent dans une **tray fine sous le clavier** (se cache quand tout est placé ; déposer une icône dedans = retirer). C'est le seul « réservoir » pour rebinder une action absente du board, tout en gardant la vue principale = clavier pur.
- Defaults **calqués sur le SS** (icône par touche : ↺ en fin de row1, theater/subs/PiP/jump/link/loop en row2, brightness/flip/cast/fullscreen/frame-step en row3, screenshot/aspect/prev/next/mute/vol en row4, play sur Espace + rewind/vol/ffwd autour). `skipIntro/skipOutro` **non bindés par défaut** (le SS n'en a pas), draggables depuis la tray.

### 4 actions de plus (demande user)
- **Aller à % (1–9)** : 9 actions `seekPct10…90` → saute à N×10 % de la durée (façon YouTube). Number-row 1–9 par défaut. Icône = barre de progression + digit.
- **Miroir horizontal** (`mirror`) : toggle `transform: scaleX(-1)` sur le `<video>` (indépendant de `cycleAspect` qui, lui, joue sur `objectFit`).
- (rappel itération précédente : `cycleServer`, `copyTimestamp`.) Catalogue = **41 actions**.
- Vérifs : `tsc` propre (hors préexistants), `next lint` 0 warning, JSON valides, pas de collision de touche dans les defaults (script de check).

---

## 2026-07-05 (suite 2) — Raccourcis : éditeur drag&drop, fix décalage menu, 2 actions de plus

Itération sur la feature raccourcis (retours SS du user).

### Éditeur repensé en drag & drop ([ShortcutEditor.tsx](components/watch/primary/ShortcutEditor.tsx))
- Nouveau modèle (demande user, inspiré d'une réf de clavier) : **glisser une action** de la liste **sur une touche** pour l'assigner (avant : clic-action puis appuie-touche). Déposer sur la liste = désassigner ; **double-clic** sur une touche = libérer ; on peut aussi soulever l'icône d'une touche pour la déplacer.
- **Clavier épuré** : plus AUCUNE lettre imprimée sur les touches. Une touche assignée affiche l'icône de son action, sinon vide. Le **nom de la touche s'affiche seulement au survol** (tooltip). Style aligné sur la réf (bezel quasi-noir, touches plates).
- Defaults redistribués sur le clavier à la manière de la réf (icônes éparpillées) dans [keybindings.ts](lib/prefs/keybindings.ts).

### Fix décalage « Lumières d'ambiance » (et toutes les lignes injectées)
- Les rows `.as-menu-row` avaient `padding: 0 12px` alors que Vidstack natif utilise `--media-menu-item-padding: 10px` (vérifié dans `node_modules/@vidstack/.../menus.css` L315) → icône+label poussés ~2px trop à droite vs Speed/Qualité. Corrigé : `padding: var(--media-menu-item-padding, 10px)` dans [globals.css](styles/globals.css).

### Retrait du toggle « Statistiques vidéo » du menu (demande user)
- Plus de ligne stats dans le menu du lecteur ; l'overlay stats s'ouvre uniquement via son **raccourci clavier** (`toggleStats`). La ligne « Configurer les raccourcis » reste.

### 2 actions ajoutées (+ propositions)
- **`cycleServer`** (changer de lecteur) : le player n'a pas la liste des serveurs → il émet un CustomEvent `aniscroll:cycleServer` ; la watch page ([watch/[...info].js](pages/en/anime/watch/[...info].js)) écoute et avance vers le **prochain serveur confirmé** (fallback = liste complète), wrap-around, toast `player.switchedTo`. Même pattern que `toggleTheater`.
- **`copyTimestamp`** (copier le lien horodaté) : copie l'URL courante avec `?t=<sec>` + toast « à 12:34 ». Le player **honore `?t=` au chargement** (prioritaire sur le resume sauvegardé, consommé une fois puis retiré de l'URL via `replaceState`).
- Catalogue = **30 actions** désormais. i18n fr/en (`shortcuts.actions.cycleServer/copyTimestamp`, `stats.timestampCopied/Failed`, `player.switchedTo`).
- Vérifs : `tsc` propre (hors `ably`/`@upstash/redis` préexistants), `next lint` 0 warning, JSON valides.

---

## 2026-07-05 (suite) — Raccourcis clavier configurables + clavier visuel + stats vidéo

Demande user (screenshot d'un clavier physique avec icônes sur les touches) : assigner des touches aux actions du lecteur, même design que le SS, réglable dans le lecteur ET les settings globaux.

### Système de raccourcis (data-driven)
- [lib/prefs/keybindings.ts](lib/prefs/keybindings.ts) : catalogue de **28 actions** (`ShortcutAction`), map `action -> combo` en localStorage (`aniscroll:keybindings`), même pattern que `playerPrefs.ts` (CustomEvent + hook `useKeybindings`). Combos normalisés (`"shift+s"`, `"arrowright"`), helpers `comboFromEvent`/`comboLabel`/`comboToAction`. Defaults sensés (k=play, ←/→=±5s, ↑/↓=volume, m=mute, f=fullscreen, n/p=ep suiv/préc, s/d=skip intro/outro, etc.).
- **Handler central** dans [UniversalPlayer.tsx](components/watch/primary/UniversalPlayer.tsx) : un seul `keydown` en **capture phase** (gagne sur les hotkeys natifs Vidstack → `preventDefault`+`stopPropagation` quand on possède la touche). Ignore les champs de saisie + le blocage watch-party. Dispatcher `runAction(action)` → op impérative sur le `<video>`/player/hls.
- **Piège hooks** : le dispatcher a besoin de helpers définis tard (`subtitleTracks`, `selectSubtitleTrack`, `togglePip`…) donc `runAction` vit après les early-returns iframe. Mais `useRef`/`useEffect` ne peuvent PAS être après un early return (rules-of-hooks). Fix : ref `runActionRef` + `useEffect` déclarés **en haut** (avant tout return), le dispatcher est **publié** dans la ref plus bas (simple assignation, pas un hook). Sur le chemin iframe l'assignation ne s'exécute jamais → ref null → handler no-op (correct : pas de `<video>` à piloter).

### Clavier visuel (overlay) — [ShortcutEditor.tsx](components/watch/primary/ShortcutEditor.tsx)
- Reproduit le SS : bezel quasi-noir, touches sombres, **icône de l'action peinte sur la touche assignée**, tooltip flottant « S : Skip Intro ». Layout QWERTY en data (`ROWS`), touches mortes (Shift/Ctrl) non assignables.
- Modèle d'édition retenu (question au user) : **clic action → appuie une touche**. Liste d'actions groupée à gauche ; cliquer une action « écoute » puis capture la 1re touche (window keydown capture, ignore les modificateurs seuls, Esc annule). Une touche = une seule action (retire le combo des autres actions). Chip du combo + bouton clear + reset global.
- Chargé en **`next/dynamic` ssr:false** (overlay lourd, rare) depuis le lecteur ET les settings. Icônes SVG dans [shortcutIcons.tsx](components/watch/primary/shortcutIcons.tsx).

### Stats vidéo — [VideoStats.tsx](components/watch/primary/VideoStats.tsx)
- Panneau « stats for nerds » : lit le `<video>` + l'instance hls.js (résolution, FPS, bitrate, bande passante estimée, buffer, frames perdues, serveur). Poll ~2 Hz via rAF (pas de `useMediaState` → ne re-rend pas le player). Sibling overlay (survit au fullscreen).
- **Screenshot → presse-papiers** : `captureScreenshot()` dessine la frame sur un canvas → `ClipboardItem` (fallback download si pas de support clipboard-image ; toast d'erreur si canvas tainted = source noCors).

### Entrées + divers
- Bouton « Configurer les raccourcis » dans le menu Settings du lecteur **et** dans Settings globaux (section Lecteur) → même overlay. + ligne toggle « Stats vidéo » dans le menu lecteur.
- Ajout **`prevEpisodeHref`** (le lecteur n'avait que `nextEpisodeHref`) — dérivé de `episodeNavigation.prev` dans [watch/[...info].js](pages/en/anime/watch/[...info].js), passé aux 2 usages `UniversalPlayer` (HLS + iframe).
- Actions directes-only (seek/volume/screenshot/skip) = no-op gracieux sur embeds iframe (megaplay) : pas de `<video>` accessible.
- i18n fr+en (`shortcuts.*`, `stats.*`). Vérifs : `tsc` propre sur les fichiers touchés (seules erreurs = `ably`/`@upstash/redis` manquants, préexistantes), `next lint` 0 warning, JSON valides.

### Graphify (méta)
- Le user avait installé **Graphify** (graphe de connaissance du repo, `graphify query "..."`) pour réduire la conso de tokens. Je ne l'utilisais pas car le hook PreToolUse ne se déclenche que sur `Bash` grep/find, pas sur mes tools `Grep`/`Glob`. → **Mémoire durable ajoutée** ([[graphify]] dans MEMORY.md) : consulter `graphify query` en premier pour localiser du code. CLI v0.8.27, output `graphify-out/` (gitignored).

---

## 2026-07-05 — Onglet Découverte (feed swipe façon TikTok) + panneau « For You »

Documentation rétroactive de l'onglet **Découverte** (`nav.discover`, présent dans [NavBar.tsx](components/shared/NavBar.tsx) et [MobileNav.tsx](components/shared/MobileNav.tsx) → `/en/discover`), jamais journalisé jusqu'ici. Portage du projet de référence AniScroll (MAUI, `Index.razor` + `SwipeSettings.cs`) vers Next/React.

### Feed vertical plein écran ([discover.tsx](pages/en/discover.tsx))
- Cartes plein-viewport empilées, navigation **verticale** (molette/drag = épisode suivant/précédent, seuil `cardHeight * 0.06`) et **horizontale** (swipe = action de liste). Gesture unifiée dans [useCardDrag.ts](components/discover/useCardDrag.ts).
- **Perf** : `RENDER_WINDOW=5` (on ne rend que ±5 cartes autour de l'index), `ScrollCard` **memoïsé** (un re-render parent — ex. une traduction qui se résout — ne doit pas re-rendre toutes les cartes en plein swipe, ça faisait stuttrer). Hauteur de carte = `window.innerHeight` re-mesurée au resize.
- **Pagination** : fetch serveur via `/api/v2/discover/<page>` (Redis-cached côté serveur → les visiteurs concurrents partagent un seul appel AniList amont). Préchargement de la page suivante quand l'index arrive à `PRELOAD_THRESHOLD=6` de la fin ; dédup via `seenIds`.
- **Traductions** : `prefetchTranslations` réchauffe le cache de synopsis dans la langue active dès le chargement de la page → pas de flash anglais quand on swipe jusqu'à la carte (no-op si UI en anglais).

### Swipe = action de liste AniList ([swipeSettings.ts](lib/discover/swipeSettings.ts))
- Swipe **droite/gauche** assigne un **statut AniList** à l'anime actif (`SaveMediaListEntry`). Défauts : droite = `COMPLETED`, gauche = `PLANNING`. Réglable dans [ScrollerSettingsPanel.tsx](components/discover/ScrollerSettingsPanel.tsx) parmi 6 statuts (CURRENT/REPEATING/COMPLETED/PLANNING/PAUSED/DROPPED), persisté en `localStorage` (`discover_swipe_settings`).
- **Pas de custom lists** : le projet de réf avait un backend de listes maison ; ici on n'expose que le set de statuts AniList.
- **Hints de swipe** : pills icône+label aux bords de la carte active + « feathers » (dégradés construits inline depuis la couleur hex du statut, `featherGradient`). Couleurs statut = miroir des tokens `as-*` de `tailwind.config.js`. Glyphes SVG portés verbatim de `GetSwipeHintIcon`.
- **Undo** : chaque swipe est mémorisé (`swiped` map) ; revenir sur une carte déjà swipée affiche un **badge Undo** qui `DeleteMediaListEntry` (connecté) ou retire l'entrée locale (déconnecté). Déconnecté → les choix sont stockés dans `localStorage` (`discover_swipes`) pour ne pas être perdus.

### Boutons d'action sur la carte ([ScrollCard.tsx](components/discover/ScrollCard.tsx))
- Row **Info + Watch** en bas de la carte. Info → `/en/anime/<id>` ; Watch → deep-link direct dans le player megaplay (`.../watch/<id>/megaplay?...num=1`).
- Le clic sur le poster/titre honore la préférence « click target » (Settings → Browsing) : `info` (page info) ou `watch` (player direct) via `animeHref`.
- Badge épisodes : même logique que le Hero de la page info (`7/12` en cours, `1208+` si total inconnu, sinon total ou `N/A`).

### Panneau « For You » (recommandations) ([ForYouPanel.tsx](components/discover/ForYouPanel.tsx))
- Bouton **Sparkles** (haut-droite du feed) ouvre un overlay de recommandations personnalisées basées sur la **liste AniList** de l'utilisateur (`/api/v2/recommend`, moteur dans [lib/recommend/engine.ts](lib/recommend/engine.ts)).
- Deux modes : **all** / **planning**. Chaque carte affiche le **« pourquoi »** (raisons de la reco via `reasonsToProse`), tags, stats.
- **Regenerate/reroll** : `shownRef` traque tous les ids déjà montrés + `round` counter → chaque régénération demande 10 fresh jamais retournés. À la fin du batch → bouton Regenerate ; « start over » repart d'une ardoise propre. Nécessite d'être connecté (sinon `signin` hint).

### Leçons / pièges
- La memoïsation de `ScrollCard` est **essentielle**, pas cosmétique : sans elle, la résolution async d'une traduction re-rendait toutes les cartes et se battait avec les écritures DOM inline du hook de drag → swipe saccadé.
- Bien distinguer ces « openings/boutons Découverte » des **boutons OP/ED de la page info** (entrée 2026-07-02) : sujets sans rapport malgré le vocabulaire proche.

---

## 2026-07-03 (suite 2) — Section Épisodes : perf, badges, harmonisation ; rating décimal ; fixes saison

Série de fixes sur la page info (section Épisodes) + la popup de rating, guidée par screenshots du user.

### Perf : liste d'épisodes virtualisée (One Piece 1168 ep)
- **Symptôme** : revenir sur l'onglet ONE PIECE depuis Films / OP-ED laggait (montage de 1168 lignes DOM d'un coup).
- **Fix** : hook `useWindowedSlice` (dans [Episodes.tsx](components/anime/v2/Episodes.tsx)) — fenêtrage maison sans dépendance. Les 3 vues (détaillée/compacte/grille) ne rendent que les lignes visibles (~15) + overscan, avec un spacer de hauteur totale (scrollbar juste). Hauteurs de ligne fixes par vue (98 / 46 / pitch grille mesuré depuis la largeur du conteneur). Le `scrollTop` du conteneur partagé est remonté dans `Episodes` et passé aux vues. Validé en isolation (haut/milieu/bas/grille/petite-liste). Grille : `perRow` mesuré via `clientWidth`.

### Badge nombre d'épisodes sur l'onglet
- L'onglet « Épisodes » n'avait pas de badge (comme Personnages/Illustrations) car `info.episodes` est **null** pour les anime en cours (One Piece). Callback `onEpisodeCount` : `Episodes` remonte la vraie longueur chargée vers `Tabs`/`InfoPageMobile`. Fallback avant chargement : `info.episodes` → `nextAiringEpisode - 1` (diffusés). Bouton saison ONE PIECE : affiche juste le **nombre** (retrait de « EP » et « · Xmin »).

### Harmonisation des pills saison / Films / OP-ED
- **Problème** (screenshot) : chaque pill était dans son propre wrapper `seasonTabs` bordé (boîte-dans-boîte) + la pill saison était atténuée à `opacity 0.7` → les 3 semblaient dépareillées.
- **Fix** : wrapper `seasonTabs` rendu transparent (juste layout) ; les 3 partagent un style unique (fond accent + bordure accent si actif, `bg-3` + `line-2` sinon, hauteur 46px uniforme). Plus d'atténuation.

### Bug « Films » multi-saison + titre page-film
- **Films actif global** : `filmsActive = activeKind === "films"` allumait la ligne Films de **toutes** les saisons. Corrigé en **par-saison** : `films.some((v) => v.id === activeSeasonId)` (en mode films, `activeSeasonId` = premier film id de la saison choisie).
- **Titre pill sur page-film ré-ancrée** (Phantom Rouge) : affichait le titre du film au lieu de la série. Quand `active.id !== info.id` (cas `selfIsBonusFilm`), on affiche `pickTitle(active.title)` (la série, ex. « Hunter x Hunter (2011) »). `active.label` est toujours « Season N », donc il fallait le vrai titre depuis `SeasonEntry.title`.

### Rating décimal (demi-étoiles)
- La popup de fin d'anime ([RateModal.tsx](components/shared/RateModal.tsx)) n'avait que des étoiles entières (1-10) → impossible de mettre 8,5. Chaque étoile = **deux demi-zones cliquables** (gauche = X.5, droite = X.0) + overlay de demi-remplissage (clip width 50%). Score en POINT_10_DECIMAL, `score*10` reste entier pour AniList (multiples de 0.5). Ligne de score formatée selon la locale (`toLocaleString` → « 8,5/10 » en FR).

### Bug saison : film-préquelle compté comme saison (Jujutsu Kaisen 0)
- **Symptôme** (screenshot) : JJK 0 (id 131573, **MOVIE** 2021, PREQUEL de S1) apparaissait comme « Season 2 » dans le picker, coincé entre S1 (2020) et la vraie S2 (2023).
- **Cause** : `resolveFranchiseSeasons` ([resolveSeason.ts](lib/anilist/resolveSeason.ts)) comptait **tout** MOVIE non-exclu comme saison (ligne `isSeasonLike(m) || format==="MOVIE"`). `findBonusFilms` n'excluait que **SIDE_STORY**, pas les **PREQUEL** movies. Intention (commentaire) : seul un MOVIE **SEQUEL** (nouveau contenu, ex. Chainsaw Man: Reze-hen) = vraie saison.
- **Fix** : `findBonusFilms` capte aussi les **PREQUEL** MOVIE → JJK 0 est exclu du décompte saison (via `excludedFilmIds`) ET listé comme film bonus. `format === "MOVIE"` garantit qu'un PREQUEL vers une vraie saison TV n'est jamais capté. Caches bumpés `seasonList:v13→v14`, `bonusFilms:v7→v8`.
- **Vérifié live** : JJK → S1/S2/S3 seulement + JJK 0 en film bonus ; HxH Phantom Rouge / Last Mission toujours films bonus (pas de régression).

### Bug : film-recompilation classé « film » et non « compilation » (JJK: Execution)
- **Symptôme** : « JUJUTSU KAISEN: Execution » (re-montage de l'arc Shibuya S2 + début Culling Game S3, 2025) apparaissait comme film normal dans la section Films, pas en **Compilations**. Il est atteint via PREQUEL (depuis S3) donc `findBonusFilms` le prenait en `kind:"movie"`.
- **Fausse piste** : un edge **PARENT → TV** ne distingue pas — **tout** film de franchise en a un (Phantom Rouge a un PARENT vers la série HxH). L'utiliser reclassait à tort les vrais films en compilation.
- **Signal fiable = le titre** : ces recompilations portent le marqueur japonais « Tokubetsu Henshuu-ban » / « …Henshuu-ban » (特別編集版 = édition spécialement re-montée). Élargi `RECAP_TITLE_RE` ([helpers.ts](components/anime/v2/helpers.ts)) : `henshuu-?ban | soushuuhen | 特別編集版 | 編集版`. `resolveFranchiseBonusFilms` reclasse un film chargé en `kind:"compilation"` quand `isRecapTitle(film)` matche (le film est chargé pour l'enrichissement, on a donc son titre complet).
- **Vérifié live** : JJK Execution → compilation ; JJK 0 + HxH Phantom Rouge / Last Mission restent `movie`. Cache `bonusFilms:v8→v9`.

### Bug : popup de rating persistante entre animes
- **Symptôme** : ne pas remplir la popup de fin d'anime, quitter, ouvrir un AUTRE anime → la popup réapparaît avec le nouvel anime.
- **Cause** : `ratingModalState` vit dans `WatchPageProvider` (app-wide, survit à la nav SPA). `isOpen` restait `true` et se re-liait au `dataMedia` du nouvel anime.
- **Fix** : effet dans [watch/[...info].js](pages/en/anime/watch/[...info].js) qui remet `isOpen:false` au changement de `info?.id`.

### Cohérence liste locale / AniList (fixes connexes plus tôt dans la session)
- **Statut fantôme** : Hero montrait un statut local (« Re-visionnage ») absent d'AniList → `fullSyncFromAniList` devient **miroir strict** (drop des entrées local-only quand sync ON). Barre « vu » des épisodes ([episodeLists.tsx](components/watch/secondary/episodeLists.tsx)) : suit la source d'autorité (local si sync off, AniList si on) au lieu de lire `mediaListEntry` en dur.

---

## 2026-07-03 (suite) — Megaplay routé via Worker + synchro AniList ON par défaut avec choix de sens

Deux chantiers indépendants dans la même session.

### Fix : « Megaplay manque souvent alors que la vidéo existe »
- **Cause racine** : `extractMegaplay` ([lib/extractors.js](lib/extractors.js)) fetchait `megaplay.buzz` **en direct**. Or megaplay est **derrière Cloudflare** (vérifié : `Server: cloudflare`, `CF-RAY`), qui 403/challenge les **IP datacenter AWS de Vercel**. → marche en local (IP résidentielle) mais échoue souvent en prod → le chip disparaît. **Exactement la même classe de bug qu'anime-sama**, déjà réglée en passant par le Worker CF.
- **Fix** : helper `fetchMegaplay()` qui route la page embed **et** `getSources` via `fetchViaWorker` (requête depuis le réseau Cloudflare → passe), avec **fallback fetch direct** si le Worker est absent/injoignable (dev local). Le Worker met déjà le bon Referer `megaplay.buzz` ([worker/src/index.js](worker/src/index.js) `detectReferer`) et repasse le JSON verbatim — pas besoin de `X-Requested-With` ni de Referer par-requête (vérifié en live à travers le Worker).
- **Commentaires périmés corrigés** : (1) la route `/stream/ani/<aniListId>` n'est **pas** morte (répond en <0,5 s, vrai fallback — testé Frieren ani/154587) ; (2) la page ne **410 plus** sans Referer (renvoie 200). Le « file not found » de megaplay est un **200 avec `<title>Error - MegaPlay</title>`** → le check HTML existant le rattrape même à travers le Worker (le Worker ne wrappe pas ce cas en erreur).
- **Rien d'autre en cause** : routage MAL→AniList, regex `data-id`, `episode`/`aniId` par-entrée envoyés par le client = tous corrects. Aucun changement serveur/client nécessaire. **Le Worker doit être déployé** (il l'était déjà) pour que le fix prenne effet en prod.
- Vérifié end-to-end en forçant le chemin Worker : routes MAL + AniList résolvent (1 stream + 9 pistes de sous-titres), épisode inexistant → `file not found`, fallback direct OK.

### Feature : synchro AniList activée par défaut + choix de sens (au lieu du message d'écrasement)
- **Demande** : (1) sync ON par défaut quand l'utilisateur se connecte, (2) remplacer le message « votre liste va être écrasée » par un **choix de sens** — soit AniList écrase le local, soit **le local est poussé vers AniList** (ajoute les anime du site), (3) **toast** de confirmation à la connexion (style « Entrée de liste enregistrée »).
- **Nouveau sens `local → AniList`** : `fullSyncToAniList()` ([lib/list/syncEngine.ts](lib/list/syncEngine.ts)) pousse chaque entrée locale via `SaveMediaListEntry` (ajoute OU met à jour). **Ne supprime jamais** rien côté AniList (les entrées présentes seulement sur AniList sont laissées telles quelles) — c'est bien « ajouter ma liste du site », pas un remplacement. Séquentiel (1 mutation à la fois) pour rester sous la limite AniList (90 req/min), best-effort par entrée, patch du cache client au fil de l'eau.
- **Popup au 1er login** (choix retenu via question) : composant réutilisable [SyncDirectionModal](components/shared/SyncDirectionModal.tsx) à 2 boutons (« Utiliser ma liste AniList » = hard-override / « Utiliser ma liste AniScroll » = push). Piloté par `SyncBootstrap` dans [_app.tsx](pages/_app.tsx), **placé DANS `<SessionProvider>`** (sinon pas de `useSession()` — `MyApp` est au-dessus du provider).
- **Garde anti-nag** : nouveau flag `directionChosen` dans [syncPrefs.ts](lib/prefs/syncPrefs.ts). `enabled` passe à `true` par défaut (inoffensif pour les invités : `getAniListSession` renvoie `null` sans token). **Piège évité** : le resync de fond de `_app` (pull AniList→local, non-destructif mais overriding) est **gaté sur `directionChosen`** — sinon un nouvel utilisateur avec une liste locale la perdrait avant d'avoir pu choisir « pousser vers AniList ». `cancel` compte comme répondu (sync reste ON, aucun reconcile) pour ne pas rouvrir à chaque navigation.
- **Toast** : `toast.success` avec `description` (supporté par sonner 1.0.3) — titre « Synchronisation AniList activée » + sous-ligne. Même style que le screenshot fourni.
- **Settings** : le toggle master ouvre désormais le même `SyncDirectionModal` (au lieu du confirm à sens unique). Clés i18n `confirmTitle/Body/Enable` supprimées, ajout de `pushed/enabledToast/enabledToastDesc/directionTitle/directionBody/dir{From,To}{Title,Desc}` (fr + en).
- Vérifs : `tsc --noEmit` OK, `next lint` OK sur les fichiers touchés, JSON fr/en valides. Flux runtime non piloté (gated derrière l'auth AniList réelle) — logique/types/lint validés.

### Itération 2 — miroir strict, 3ᵉ option, popup = activation, déconnexion (retours user)
- **Bug du statut fantôme** (screenshots user) : le Hero affichait « Re-visionnage » (liste **locale**) alors que l'éditeur affichait « Pas dans la liste » (cache **AniList**). **Cause racine** : `fullSyncFromAniList` (resync de fond non-destructif) **conservait les entrées local-only** (absentes d'AniList) — une entrée `REPEATING` locale périmée survivait et contredisait AniList.
- **Fix « miroir strict »** (choix retenu via question) : quand sync est ON, AniList est **la seule source de vérité**. Les entrées local-only sont désormais **abandonnées** au resync (plus de carry-over lignes 155-158). La progression locale en avance reste défendue via `reconcileEntry` **mais uniquement** pour les anime présents aussi sur AniList (pas de « progression hors-ligne » pour un anime jamais sur AniList). L'entrée fantôme existante est purgée au prochain resync de fond. On **garde** le local comme cache résilient (offline) — il ne peut simplement plus contredire AniList.
- **3ᵉ option « Ne pas synchroniser »** : `SyncDirection` devient `"fromAniList" | "toAniList" | "off"`. Bouton dans le modal + gestion dans `_app` et `settings`.
- **Revirement : la popup EST l'activation** (avant : auto-`enabled:true` + toast dès la connexion, puis popup). Désormais le 1er login **ouvre la popup sans rien activer** ; choisir un sens active la sync (+ toast), « Ne pas synchroniser » la laisse off. → `DEFAULT_SYNC_PREFS.enabled` repasse à **`false`** (avant `true`) : plus aucune sync silencieuse pour un invité/indécis, et « off » devient un choix collant. Le `directionChosen` est ce qui gate le resync de fond (inchangé).
- **Déconnexion → sync OFF** : l'effet de `SyncBootstrap` détecte `!isConnected` et remet `enabled:false` **+ `directionChosen:false`** (reset) → une reconnexion re-pose la question. Écriture gardée (`if p.enabled || p.directionChosen`) pour ne pas spammer un `storage` event à chaque render, et no-op pour un invité pur.
- **Piège** : `SyncBootstrap` vit **dans** `<SessionProvider>` (déjà le cas) et l'effet ne dépend plus de `t` (retiré des deps une fois le toast déplacé hors de l'effet).
- Vérifs : `tsc --noEmit` OK, `next lint` OK, JSON valides.

---

## 2026-07-03 — Player : autoplay fiable (multi-lecteurs) + bouton play one-shot + icônes OP/ED + menu uniformisé

Session de debug guidée par les logs console du user (captures d'écran successives). Le fond `UniversalPlayer.tsx`.

### Autoplay — la bonne stratégie et les vrais pièges
- **Merge distant conflictuel** au départ : `origin/dev` avait déjà `e4f1025`/`138a59e` (autoplay unmuted-first + fallback muted + gros bouton play). Résolu en **gardant la stratégie distante** + y greffant le fix remount (résolution live de `playerEl`, jamais capturé une fois).
- **Ordre CRUCIAL = muted-first, PUIS unmute** (pas l'inverse). Le piège : sans user-activation, Chrome n'émet **pas** de `NotAllowedError` sur un unmuted-first — il **résout `play()` puis PAUSE** l'élément (message console *« Unmuting failed and the element was paused because the user didn't interact… »*). Donc le `catch(NotAllowedError)` ne fire jamais → on croit jouer alors que c'est en pause. → On joue **muté** (toujours accepté, jamais pausé), puis on tente `muted=false`, et si `video.paused` repasse à true (mitigation, **asynchrone** — vérifier après 2 `requestAnimationFrame`), on re-mute + relance + `unmutePending` (unmute au 1er geste).
- **Bug « change de lecteur → pas d'autoplay »** : l'effet marquait `started=true` dès `!video.paused`. Or un `play()` en vol sur un élément `readyState:0` reporte `paused=false` un instant → faux positif → l'`AbortError` (« play() interrupted by a new load », swap de source hls.js sur fallback Sibnet) n'était jamais rejoué. **Fix** : ne latch `started` que si `!paused && readyState>=2` (frame réelle). L'`AbortError` ne latch rien → le poll/events rejouent sur la nouvelle source.
- **Bug « activer l'autoplay en cours ne lance rien »** : la garde `currentTime>1 → return` bloquait une vidéo **en pause** que le user venait d'activer. **Fix** : la garde ne s'applique plus qu'à une vidéo **qui joue déjà** (`currentTime>1 && !video.paused`). Une vidéo en pause au-delà de 1s = demande de lancement légitime.
- **Poll auto-réparant** : un seul `setInterval` (100ms, plafond ~10s) qui, à chaque tick, (re)bind les events `canplay/loadeddata/loadstart` sur le **`<video>` courant** (pas le conteneur Vidstack, recréé au switch) et rappelle `tryPlay`. Guard `inFlight` pour ne pas chevaucher les `play()`. Court-circuit des sources **iframe/embed** (`streamData.iframe` sans clientExtract vidmoly) : pas de `<video>` à piloter, l'autoplay dépend du `allow` de l'iframe (megaplay marche seul).
- **Diagnostic** : `NEXT_PUBLIC_DEBUG_SOURCE=1` dans `.env.local` (gitignored) active `dwarn`. Pour du debug ponctuel j'ai utilisé des `console.log` inconditionnels colorés `[AP]` — **retirés avant push**. Les `dwarn` sont client-side (console navigateur), pas dans le log du dev server.
- **« Ne marche pas pour tous les lecteurs »** : diagnostic par logs = ce n'est PAS l'autoplay. vidmoly → `play() OK` avec son ✅. Certains (mewstream/sibnet) → **flux 403 / hlsError** = le CDN refuse le stream, pas de vidéo à lancer. **Chantier séparé** (extraction de source), hors autoplay.

### Bouton play central — one-shot
- Ne s'affiche QUE si **autoplay OFF** (`if (autoplay) return null`) — avec autoplay ON la vidéo part seule.
- **One-shot** : latch `everStarted` (via `useEffect` sur `!paused`) → une fois la lecture commencée, le gros bouton disparaît **définitivement** ; les pauses suivantes utilisent le petit play/pause en bas à gauche. (Avant : réapparaissait à chaque pause.)

### Icônes OP / ED (menu Automatisation)
- Les lignes « Passer l'intro/outro » partageaient l'icône `fast_forward`. Remplacées par des **badges OP / ED** (concept #3 choisi par le user via artifact de 5 propositions) : `<rect>` arrondi outline + `<text>` monogramme, `currentColor` (passe accent quand actif).
- `SettingsToggleRow` gagne une prop optionnelle **`iconNode`** (SVG multi-éléments) en plus de `iconPath` (single path). `iconNode` prime. **Labels inchangés** (demande explicite du user).

### Menu Settings — uniformisation + fix ambient
- **Lignes injectées trop petites/serrées** vs items natifs (Vitesse/Qualité) : le `style` inline ne reprenait pas la hauteur/padding/font-size natifs. **Fix CSS** : classe `.as-menu-row` (globals.css) pinnant `min-height: var(--media-menu-item-height,40px)`, `padding: 0 12px`, `font-size: var(--media-menu-font-size,15px)`, appliquée à `SettingsToggleRow`/`SettingsActionRow`/`SettingsSubmenuRow`/`SettingsSubmenuHeader`.
- **« Lumières d'ambiance » disparaissait en sous-menu Automatisation** : il n'était rendu que dans la branche `else` (menu principal), et le sous-panneau remplace toute la liste. **Fix** : « Lumières d'ambiance » désormais **épinglé en tête du sous-panneau** aussi (rendu dans la branche `automationOpen` avant le header retour).

---

## 2026-07-02 (suite 3) — Player : gros bouton play central + autoplay

- **Bouton play central** (`CenterPlayButton` dans `UniversalPlayer.tsx`) : visible quand
  `paused && canPlay`, sibling du `<MediaPlayer>` (comme `SkipOverlay`), z-index 15, container
  pointer-events-none / bouton pointer-events-auto. Clic = **démarre AVEC son** (unmute sauf mute
  intentionnel). Style : 56px, fond accent `#E94560` + glow (comme les boutons play de l'app) —
  1re version (80px, cercle noir translucide) jugée hors-style + trop grosse par le user.
- **Autoplay — itérations** :
  - v1 : `muted=true` puis `play()` → toujours OK mais « play et mute » (rejeté).
  - v2 : unmuted-first, **pas de fallback muted** → sur navigateur qui bloque, la vidéo **ne
    démarrait pas du tout** (rejeté : « ne lit pas la vidéo automatiquement »).
  - **v3 (retenu)** : unmuted-first → si `NotAllowedError`, **fallback MUTED** (toujours autorisé,
    la vidéo démarre) → **unmute au 1er geste** utilisateur (pointerdown/keydown/touchstart, capture
    +passive, ne perturbe pas le toggle Vidstack). Mute intentionnel respecté. Latch `started` pour
    ne pas relancer à chaque re-buffer.
- **Pourquoi pas l'attribut HTML `autoplay` ?** (question user) : même politique navigateur (bloqué
  ou muet sans geste/MEI, exactement comme `play()`), et il fire avant que hls.js n'ait attaché la
  source → déclenche la mitigation « Unmuting failed » de Chrome qui laisse le player en pause (déjà
  documenté ligne ~3199 : on ne passe PAS `autoplay` à Vidstack). L'approche JS fait strictement
  mieux (muted-fallback + unmute-au-geste, impossible avec l'attribut seul).

---

## 2026-07-02 (suite 2) — Polish Films/OP-ED : miniatures clip, Chronicle, retour saison, perf

Retours SS user (6 points). Tous vérifiés sur données AniList live avant/après.

### 1 — Bouton "OP / ED" → **"Opening / Ending"** (+ trads)
- `locales/{en,fr}.json` clé `anime.opEd` → "Opening / Ending", `defaultValue` maj dans `Episodes.tsx`.

### 2 — `FilmsPanel` : **Compilations AVANT Films**
- Ordre des sections inversé (le user veut les recaps d'abord). Un seul reorder JSX.

### 3 — One Piece : **retour saison cassé** depuis Films/OP-ED
- Bug : `SeasonPicker` n'ouvrait le dropdown QUE si `hasMany` et ne remettait jamais `panel="episodes"`.
  Mono-saison (One Piece, variantes supprimées v12) → `hasMany` faux → clic mort, coincé dans Films.
- Fix : nouvelle prop `onActivate` ; le clic sur la pilule fait `if (!highlight) onActivate()` (revient
  aux épisodes) **puis** ouvre le menu si `hasMany`. Curseur pointer quand `!highlight`.

### 4 — Miniatures OP/ED = **frame du clip lui-même** (plus le label sur l'image)
- `ThemeThumb` : la cover saison peint dessous (placeholder instantané), puis un `<video muted
  preload=metadata>` attaché **seulement à l'entrée dans le viewport** (IntersectionObserver,
  rootMargin 300px) et seeké ~⅓ pour éviter le noir → fond over via opacity. Fallback = cover si
  le clip ne charge pas. Badge OP/ED retiré de l'image → petit chip texte à côté du titre.
- Lazy = une longue liste (One Piece 70+ thèmes) ne fetch pas 70 métadonnées d'un coup.

### 5 — Perf OP/ED (« arrive après toute la page / charge pas parfois »)
- Cause : 2 appels AnimeThemes séquentiels (resolveSlug → fetchThemes) à chaque cold start sans CDN.
- Fix : **cache Turso** (réutilise `season_cache` via `seasonCacheGet/Set`, clé `themes:v1:…`) dans
  `pages/api/v2/themes/[id].ts`. Warm reads instantanés, plus de round-trip upstream. On ne cache
  PAS un échec upstream (récupère à la vue suivante) ; on cache une liste vide légitime.

### 6 — Page **Chronicle** (digest multi-saisons) : dropdown saisons + panneau Films
- Chronicle (119113) = MOVIE avec **4 edges PARENT** vers les saisons SnK, aucune chaîne
  PREQUEL/SEQUEL → le walk s'effondrait sur lui-même (pas de dropdown, doublon).
- Nouveau `franchiseAnchorId` : si le start est un MOVIE avec **≥2 PARENT** saisons de la même
  franchise → ré-ancre sur la saison la plus ancienne (16498). Utilisé par `resolveFranchiseSeasons`
  ET `resolveFranchiseBonusFilms`. Seuil ≥2 = cible les digests entiers, épargne les sequels-film
  (1 PARENT) et les recaps mono-saison (Roar of Awakening → S2 seule).
- `Episodes.tsx` : `selfIsBonusFilm` = info.id ∈ bonusFilms → `panel` démarre sur **"films"** (on
  atterrit sur le digest qu'on est venu voir, pas sa liste 1-épisode).
- Caches bumpés : `seasonList:v12→v13`, `bonusFilms:v6→v7`.
- Vérif live : anchor(119113)=16498 ; SnK seasons S1..S4 ; digests=[Chronicle]. ✓

### 7 — Retours suite (même session)
- **Pilule Chronicle affichait le titre du film** au lieu de "Season 1" : la source active
  restait `info.id` (119113, absent de la seasonList). Fix `Episodes.tsx` : `defaultEpisodeId` =
  `seasonList[0].id` quand `selfIsBonusFilm` → la pilule lit "Season 1" et les liens épisodes
  pointent une vraie saison. Suffixe durée `· {info.duration}min` masqué si `activeSeasonId !== info.id`
  (évitait "25 EP · 120min", la durée du film sur une saison TV).
- **Filtres manquants dans Films / Opening-Ending** : la barre recherche était gated
  `panel === "episodes"`. Sortie du gate → visible partout ; sub/dub + vues restent épisodes-only.
  Placeholder adapté par panneau. `FilmsPanel`/`OpEdPanel` prennent `filter` (match label/année ;
  song/artiste/slug) + état "aucun résultat". Filtre **remis à zéro au changement de panneau**.
- **Miniatures vidéo OP/ED peu fiables** ("marchent moins bien / se chargent pas") : le seek d'un
  frame dans des dizaines de webm (range requests) échouait souvent ET les chargements concurrents
  rendaient la lecture du clip elle-même instable. **Rollback → miniature = cover saison** (statique,
  fiable). Le chip OP/ED reste à côté du titre (pas sur l'image). Leçon : pas de still par thème sur
  l'API AnimeThemes ; le frame-vidéo comme vignette coûte trop cher en fiabilité.

### 8 — Vues (détaillé / compact / grille) pour Films & Opening-Ending
- Le sélecteur de vue était épisodes-only → sorti du gate (sub/dub reste épisodes-only). `view`
  passé à `FilmsPanel`/`OpEdPanel`. Tooltip grille générique (`gridView`) hors épisodes (« Grille de
  numéros » n'a de sens que pour les épisodes).
- `FilmsPanel` : `FilmRow` gagne `compact` (ligne dense num·titre·meta·chevron) ; nouveau `FilmTile`
  (grille de posters 2:3, tag RÉSUMÉ en overlay). Helpers `useFilmText`/`coverEl` partagés.
- `OpEdPanel` : `ThemeRow` gagne `compact` ; nouveau `ThemeTile` (grille 16:9 cover + chip + play
  overlay + song/artiste dessous). `chipStyle()` partagé.

---

## 2026-07-02 (suite) — Films/OP-ED en onglets (remplacent la liste) + section Compilations

Retours user sur l'itération précédente (2 demandes).

### 1 — Films & OP/ED : dropdowns → **boutons-onglets** qui remplacent la liste
- Décision (question au user) : cliquer bascule le **panneau principal** (à la place des
  épisodes), onglets **mutuellement exclusifs** (pas d'accordéon). La saison reste un dropdown.
- `Episodes.tsx` : nouvel état `panel: "episodes" | "films" | "oped"`. `SeasonPicker` gagne
  `highlight` (dim quand un onglet Films/OP-ED est actif) et remet `panel="episodes"` au pick.
  Nouveau `TabButton` (même pilule que la saison, toggle). Barre recherche/dub/vues cachée hors
  panneau épisodes.
- Supprimé : `FilmsPicker` (dead) + `OpEdPicker.tsx` (remplacé). Nouveaux panneaux inline :
  [FilmsPanel.tsx](components/anime/v2/FilmsPanel.tsx), [OpEdPanel.tsx](components/anime/v2/OpEdPanel.tsx)
  (hook `useOpEdThemes` extrait → le bouton affiche le compteur, le panneau rend sans refetch).
  Rendu **façon épisodes** (rows cover/titre/meta ; OP-ED groupé par saison, clic = modal clip NC).

### 2 — différencier vrais films vs **compilations d'arc** (section séparée)
- **Signal vérifié sur données brutes AniList** (One Piece id 21) : `SIDE_STORY`=vrai film
  standalone (15), `SUMMARY`/`COMPILATION`=recap d'un arc (2 : Alabasta 2007, Chopper 2008 —
  pile les 2 du SS user). C'est **le `relationType`** qui tranche, rien d'autre.
- `resolveSeason.ts` : `FilmVariant.kind` = `"movie" | "compilation"`. `findBonusFilms`→`movie`,
  `findMultiSeasonDigestFilms`→`compilation`, nouveau **`findCompilationFilms`** (tout recap
  MOVIE d'arc, dédup vs films déjà classés — attrape les recaps mono-arc que le digest multi-
  saison ratait). `resolveFranchiseBonusFilms` concatène + trie films avant compils.
- Cache **bumpé `bonusFilms:v3→v4`** (shape changée : `kind` + compils incluses) → évince l'ancien.
- UX : `FilmsPanel` rend 2 sections **Films** / **Compilations** (intitulé gardé, tag `RÉSUMÉ`).
  i18n en/fr (`anime.compilations`, `compilationsHint`, `compilationTag`).
- **Piège évité** : les 2 SUMMARY apparaissent AUSSI en dual-format de la saison (dropdown saison
  « Films ») ET dans Compilations — **volontaire** (mêmes films, 2 accès légitimes), pas un doublon-bug.
- Type-check + ESLint propres (hors Prisma préexistant). Mobile OK (composant `Episodes` partagé).

---

## 2026-07-02 — Dropdown OP/ED (clips AnimeThemes) + fix détecteur multi-lecteur [commit ceeffe5]

Deux chantiers **indépendants** demandés dans le même prompt.

### Partie 1 — nouveau dropdown OP/ED sur la page info (joue les clips NC AnimeThemes)
- Demande : à côté du dropdown Film, un 3e dropdown **au rendu identique** au dropdown Saison,
  mais listant openings/endings — compteur OP/ED + liste, **groupé PAR SAISON** (« Saison → OP/ED,
  Saison → OP/ED »). Clic = joue le clip.
- **Source tranchée (question au user)** : clip **NC AnimeThemes** (`v.animethemes.moe/*.webm`),
  PAS un saut intra-épisode via timecodes. C'est donc distinct du détecteur de skip (offline).
- [lib/animethemes/themes.ts](lib/animethemes/themes.ts) : client **runtime** (jumeau JS du
  client python offline `tools/opening-detector/oped/animethemes.py`). id→slug (`/resource`)→
  themes (`/anime/{slug}`), garde la meilleure vidéo par thème (NC puis résolution).
- [pages/api/v2/themes/[id].ts](pages/api/v2/themes/[id].ts) : `GET /api/v2/themes/{anilistId}?malId=` ,
  cache long (métadonnée statique), **fail-soft** (jamais de 500 sur la page info).
- [components/anime/v2/OpEdPicker.tsx](components/anime/v2/OpEdPicker.tsx) : le picker (chrome
  copié 1:1 sur `SeasonPicker` de `Episodes.tsx`) + modal `<video>` NC. Fetch des thèmes **par
  saison** (chaque `SeasonEntry` a `id`/`idMal`), s'auto-cache si loading ou 0 thème.
- Câblé dans [Episodes.tsx](components/anime/v2/Episodes.tsx) après saison+films → couvre
  **desktop ET mobile** (composant partagé, `InfoPageMobile` réutilise `Episodes`). i18n en/fr.
- **Vérifié live** : MAL 16498 → slug `shingeki_no_kyojin` → OP1/OP2/ED1/ED2 + vidéos NC 1080p.

### Partie 2 — détecteur de skip robuste aux durées vidéo différentes selon le lecteur
- Demande : « faire l'opération sur plusieurs lecteurs car en fonction du lecteur la durée
  vidéo n'est pas la même ». Tranché : **pipeline offline** `tools/opening-detector` (pas runtime).
- **Le cœur du problème** : même épisode, hosts différents = encodes différents = **durée totale
  différente** (cold-open trimmé, ad-cards, padding). Un timecode détecté sur host A est faux sur
  host B — **pire pour l'ED** qui est ancré depuis la fin (`-sseof`) : un delta de durée décale
  tout le start absolu.
- **Décision clé** : réconcilier l'ED sur **secondes-depuis-la-fin** (`duration - start`),
  quantité **indépendante de la durée**. L'OP se réconcilie sur le start absolu.
  [oped/multi_host.py](tools/opening-detector/oped/multi_host.py) : détecte par host (durée
  propre à chacun) puis consensus (médiane, drop outliers >±4s, pondéré par votes). Émet
  `from_end_start/end`, `canonical_duration`, `hosts_agree/total`, `spread`.
- `resolve_episodes_multi()` ([adapter_aniscroll.py](tools/opening-detector/oped/adapter_aniscroll.py))
  résout l'épisode sur CHAQUE host (sibnet,embed4me,lpayer,sendvid,uqload), groupé par ep.
- `batch_detect.py --multi-host` : branche **opt-in** (coûte N hosts/ep) émettant les champs robustes.
  `probe_multihost.py` + section README.
- **Testé unitairement (synthétique)** : 3 hosts 1420/1440/1435s → **ED from_end=90.0s spread=0.0**
  (immunité durée prouvée) ; OP outlier +40s **correctement rejeté** (agree=3/4).

### Piège / restant
- **Piège here-string PowerShell** : `@'…'@` a collé un `@` parasite sur le sujet du commit (2×) →
  amend via `git commit -F fichier` (heredoc bash) pour un sujet propre avant push.
- **TODO couplé** : l'importeur JSONL→DB doit **propager** `from_end_*`/`canonical_duration` en mode
  multi-host ; et `SkipOverlay` devra **re-dériver l'ED** depuis `from_end` vs la durée réelle du
  `<video>` actif (elle la connaît déjà) pour boucler la robustesse au runtime.
- Type-check + ESLint propres (hors erreurs Prisma préexistantes = `npx prisma generate`).

---

## 2026-07-01 (suite 2) — Diag résolution vidéo + fix panels fusionnés + films bonus SIDE_STORY

Question de départ : « faut-il une API anime-sama externe (type TMCooper/AnimeSamaApi) pour
fixer les mauvaises vidéos/saisons ? » → **Non.** On a déjà mieux (scraping via CF Worker,
extraction m3u8, `player_map` vérifié). Une API externe se prend un 403 Cloudflare et fait
perdre l'infra. Les erreurs sont dans le **mapping** (ID AniList → slug/saison/offset), pas
dans le scraping.

### Diagnostic (audit borné)
- `scripts/audit-players.mjs --min-popularity=20000 --rate=40` sur dev (2395 titres).
  **Le mapping marche bien** : ~1% de `wrong-season` réels sur animesama. Le gros des
  « flagged » = `missing-player` (absence, pas mauvais contenu) — **voiranime quasi mort**
  (~5-10% résolus), animesama VF a bcp de trous.
- **Piège** : `flagged=98%` trompeur ; c'est le breakdown par TYPE qui compte
  (`wrong-season` vs `missing-player`), pas le compteur brut.

### Fix 1 — panels fusionnés (Gintama & co) [commit 0074778]
- Cause : `resolveMergedOffset` ([pages/api/v2/source/index.js](pages/api/v2/source/index.js))
  n'offsettait QUE si `somme(prequels)+ownEps == panelLen` (panel se **terminant** à la saison).
  Les long-runners (Gintama 365ep = S1..S4 concaténés) ont un panel **plus long** → test échoue
  → S2 servait l'ep 1 de S1.
- Fix : ancrer sur `fullChain`, accepter que le panel **continue** au-delà de la saison tant que
  `fullChain+ownEps <= panelLen`. Gardes conservées (tokyo-ghoul-re reste refusé).
  **Ne corrige PAS DBZ Kai** (chaîne PREQUEL AniList cassée : seul prequel = SPECIAL 1ép) →
  override nécessaire.

### Fix 2 — films bonus SIDE_STORY vs saisons [commit fababa4]
- Cause : tout MOVIE de franchise comptait comme saison sauf compilation re-cut. Un film
  side-story (HxH: Phantom Rouge) passait en « Saison 2 ».
- **Signal directeur = `relationType`** : `SEQUEL`→vraie saison (Reze S2, inchangé) ·
  `SIDE_STORY`→film bonus (Phantom Rouge, exclu) · `COMPILATION/ALTERNATIVE/PARENT`→dual-format
  re-cut (Mugen Train, inchangé).
- `findBonusFilms()` collecte les SIDE_STORY→MOVIE ; ids exclus de `resolveFranchiseSeasons`
  **et** `numberByChronology` (badge « ·S2 » ne peut plus diverger). `resolveBonusFilms()`
  (cache Redis `bonusFilms:v1:`) → SSR → InfoPage/Mobile → Tabs → Episodes → nouveau
  **`FilmsPicker`** (2e dropdown, caché si pas de film bonus).
- **Piège évité** : Reze n'est JAMAIS SIDE_STORY (vérifié) → pas de faux-exclu. Pire cas
  résiduel = film-suite rare dans le dropdown Films au lieu d'une saison (dégradation douce).

### Restant
- DBZ Kai (chaîne cassée) → `season_override` manuel.
- Mauvais slugs (Tokyo Ghoul √A → tokyo-24-ku) → bug `findAnimeSamaSlug`.
- voiranime quasi mort → à creuser.

### Env / piège
- **Redis/Upstash injoignable en DNS localement** (`ENOTFOUND ...upstash.io`) → walk AniList
  non-caché → endpoint inspect **inutilisable en dev local** (timeout). Validé par simulation +
  push sur dev, pas end-to-end local.

---

## 2026-07-01 (suite) — Saisons : unification liste/label, franchise canonique, films numérotés, anime « sans saison »

Suite aux captures : 3 régressions post-livraison corrigées + gestion des animes sans vraie saison.

### Décisions
- **Cause racine** : deux constructions de franchise divergentes — le moteur `resolveSeason.ts`
  (`buildFranchise` + Fribb, alimentait `seasonInfo`/le label) et le walk legacy
  `resolveSeasonListUncached` (sans Fribb, alimentait le **sélecteur** et la **carte**). D'où
  label vs sélecteur incohérents. **Fix = unifier le sélecteur sur le moteur.**
- **Nouvelle fonction** `resolveFranchiseSeasons(startId)` ([lib/anilist/resolveSeason.ts](lib/anilist/resolveSeason.ts))
  produit la liste `SeasonEntry[]` canonique. `resolveSeasonList` la consomme (fallback legacy
  si exception). Bump `seasonList:v6→v7`.
- **Canonicité (P3, contenu manquant)** : `buildFranchise` **rebase sur la racine** (remonte tous
  les PREQUEL puis descend en SEQUEL). Résultat : la liste est identique quelle que soit la page.
  Vérifié : SNK depuis S1 (16498) et S3 (99147) → **même liste de 6 entrées**.
- **Restriction TMDB (P2, remakes)** : quand Fribb est cohérent, `buildFranchise` retire les
  nœuds du walk dont `tmdb.tv` diffère du start → un remake sort de la timeline de l'original.
  ⚠️ Fribb inactif en local (pas de Turso) — mais le **rebasage canonique corrige déjà** le cas
  transverse : page film Zeta 1967 montre désormais la vraie timeline UC (1979→1985→1986→…) SANS
  Origin 2019 (avant : [1979 S1, Origin 2019 S2], inversion). Fribb en prod affinera la séparation.
- **Films numérotés (P1)** : `findFilmVariants` (déplacé dans resolveSeason.ts pour éviter un cycle
  d'import) dédoublonne par id + numérote (`index` 1-based, trié par année) → « Film 1/2/3 ».
  Vérifié : Zeta a bien Film 1/2/3 (A New Translation I/II/III).
- **UX sous-section groupée** ([components/anime/v2/Episodes.tsx](components/anime/v2/Episodes.tsx))
  : une saison avec films rend un en-tête de saison non répété + sous-lignes indentées « Épisodes »
  / « Film N ». i18n `formatFilmNumbered` (« Film {{n}} »).
- **Anime « sans saison »** (Gundam Origin, films/OVA isolés) : détecté par `seasonList.length <= 1`.
  Label du sélecteur = **titre de l'anime** (pas « Season 1 » trompeur) ; badge « · S1 » du bouton
  REGARDER supprimé quand `seasonInfo.total <= 1` ([components/anime/v2/Hero.tsx](components/anime/v2/Hero.tsx)).

### Leçons / pièges
- **Ne PAS conclure trop vite d'une capture** : « Gundam cassé (S6) » = en réalité du **cache Redis
  prod obsolète**. Vérifié en local (sans cache) : Origin=1 entrée, 1979=S1→S2→S3, tous corrects.
  Le seul vrai bug était sur les pages transverses (film 1967). ⇒ purger `seasonChain:*`/`seasonList:*`
  en prod après déploiement.
- **Le garde-fou d'année seul ne suffit pas pour les remakes** : 1979→Origin(2019) en SEQUEL passe
  (une suite peut être plus récente). C'est la **canonicité + Fribb** qui règle ça, pas le seuil d'année.
- Cycle d'import évité : `findFilmVariants` vit dans resolveSeason.ts, seasonChain l'importe (pas l'inverse).
- **À déployer en prod** : purger le cache Redis saisons + peupler Fribb (`node scripts/refresh-fribb.mjs`
  avec Turso) pour activer la restriction TMDB fine.

## 2026-07-01 — Mapping des saisons : moteur multi-signaux + carte des relations + dual-format

Refonte de la numérotation des saisons pour corriger l'ordre faux (Gundam : le remake *The Origin* 2019 s'affichait comme S1 en chaînant l'original 1979 en S2 ; SNK S1 diffusait des épisodes de la S2), + ajout d'une carte des relations et du dual-format épisodes/film.

### Décisions
- **Aucune source n'est fiable seule** (mesuré sur les vraies données) : Fribb se trompe (Bungo Stray Dogs : `season.tmdb` = 1,1,2,3,3 → collisions, TMDB fusionne des saisons), AniList mislabellise les relations (le Gundam 1979 est tagué `SEQUEL` du remake 2019), les titres ne sont pas toujours numérotés. → **moteur multi-signaux arbitré par les DATES** ([lib/anilist/resolveSeason.ts](lib/anilist/resolveSeason.ts)) : cascade override manuel → Fribb validé → numéro du titre → compteur chronologique ; l'**année de diffusion est l'arbitre d'ordre** (un numéro final ne peut jamais violer l'ordre des années).
- **Garde-fous partagés** dans [lib/anilist/seasonDetection.ts](lib/anilist/seasonDetection.ts) (réexportés depuis [components/anime/v2/helpers.ts](components/anime/v2/helpers.ts) pour éviter un cycle d'import) : `edgeYearMonotonic` (rejette un `SEQUEL` vers une année antérieure / `PREQUEL` vers une année postérieure), `isChainableRelation` (ne chaîne QUE `PREQUEL`/`SEQUEL` — jamais `ALTERNATIVE`/`PARENT`, ce qui garde original et remake séparés : Gundam original vs Origin, HxH 1999 vs 2011 = deux « Saison 1 »), `isRecapTitle` (un recap ne compte jamais comme une saison).
- **Fribb = un signal validé, pas autoritaire** : [lib/fribb/fribbMap.ts](lib/fribb/fribbMap.ts) ingère `anime-list-mini.json` (5,8 Mo) dans la table `fribb_map` ; `isFribbGroupConsistent()` rejette un groupe avec collision de `season.tmdb`, fusion (moins de saisons TMDB que d'entrées AniList) ou `tmdb.tv` divergent. Refresh via [scripts/refresh-fribb.mjs](scripts/refresh-fribb.mjs) (ETag/304, hebdo). Table `season_override` = dernier mot manuel.
- **Streaming** : `detectSeasonNumber` ([pages/api/v2/source/index.js](pages/api/v2/source/index.js)) passe par le moteur → le sélecteur de panneau anime-sama utilise le même numéro que la fiche (corrige le mauvais épisode SNK). Offsets `computeSeasonSizes`/`resolveMergedOffset` durcis (exclusion des recaps, plage de tolérance élargie).
- **Carte des relations** : [components/anime/v2/RelationsGraph.tsx](components/anime/v2/RelationsGraph.tsx), overlay pannable/zoomable maison (pas de lib graphe), réutilise `relations`+`seasonList` (aucune requête en plus). Bouton sur la section Relations (desktop + mobile), i18n en/fr.
- **Dual-format** : `SeasonEntry.variants` apparie le film de compilation à sa saison via les relations AniList `COMPILATION`/`ALTERNATIVE`/`PARENT` de format MOVIE (pas via Fribb, dont l'appariement film↔saison n'est pas 1:1). Le sélecteur d'épisodes affiche « · Épisodes » + « · Film » ; choisir le film charge son id AniList MOVIE, déjà géré par le chemin `isMovie`/`filmSeason` existant.

### Leçons / pièges
- **`getServerSideProps` ne sérialise pas `undefined`** : `findFilmVariants()` renvoyait `undefined` quand pas de film → erreur 500 « Error serializing `.seasonList[0].variants` ». Corrigé en renvoyant `null` (et type `variants?: […] | null`).
- **Ne pas surinterpréter une capture d'écran** : le champ Fribb `season=12` de BSD n'était PAS un numéro de saison mais l'artefact d'une entrée sur une fiche TMDB divergente ; une capture TMDB (« 1 saison de 60 ép ») m'avait fait croire à tort à un regroupement total. Toujours vérifier les données brutes.
- **Invalidation `player_map`** : colonne `algo_version` + constante `SEASON_ALGO_VERSION=2` → les lignes `heuristic` héritées (calculées avec l'ancienne logique) sont ignorées à la lecture et recalculées. Migration défensive `ALTER TABLE ADD COLUMN` idempotente pour les DB existantes.
- **Cycle d'import évité** : `seasonDetection.ts` réexporte les garde-fous depuis `helpers.ts` (source pure), pas l'inverse.
- **Vérifié en dev** : Gundam 108039 → `{number:1,total:1}` (S1 autonome) ; Gundam 80 → S1 + suites 2/3 ; SNK 16498 → S1/total:4 ; HxH 136 → S1 autonome ; Demon Slayer 101922 → une saison porte `variants:[{id:112151,MOVIE,"…Mugen Train"}]`. Type-check propre (hors erreurs Prisma préexistantes = client non généré en local). `npm install` échoue sur le build natif `@tensorflow/tfjs-node` (outils C++ absents) → utiliser `npm install --ignore-scripts` en local.
- **Fribb pas actif sans Turso** : en local sans DB, le moteur retombe sur le garde-fou d'année du walker — ce qui suffit déjà à corriger Gundam. Pour activer Fribb en prod : lancer `node scripts/refresh-fribb.mjs` avec les variables Turso, puis le planifier.

---

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
