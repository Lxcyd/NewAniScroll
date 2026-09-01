# DEVLOG — Pages, saisons, relations & sources de donnees

Le catalogue et les pages : numerotation des saisons, graphe de franchise,
hero, navbar, onglets de la fiche, et les sources d'images (TMDB, fanart,
ani.zip, Fribb).

Le plus recent en premier. L'index general est dans `../DEVLOG.md`.

## 2026-08-30 — Le profil se pare de l'anime prefere, et cesse d'etre reserve a AniList

**Le point de depart** : `/en/profile/[user]` etait une page AniList et rien
d'autre. Son `getServerSideProps` interrogeait `graphql.anilist.co` et rendait
`notFound` si la reponse etait vide, si bien qu'un compte AniScroll n'avait
aucun profil — la barre de navigation l'envoyait vers `/en/settings#account`
pour ne pas le poser sur un 404 — et un visiteur non connecte encore moins. La
banniere, elle, etait celle du profil AniList, ou un aplat gris quand il n'y en
avait pas.

**La regle demandee**, mot pour mot dans l'ordre : l'anime *prefere* du
proprietaire habille son profil, et « prefere » se decide par **sa note
d'abord ; a egalite, favori ou pas ; a egalite, le nombre de revisionnages ; a
egalite, la note moyenne de l'anime ». Sans liste, la couleur du site. Un compte
AniList sans liste garde sa propre banniere.

### Ce qu'il faut retenir

**1. Une chaine de comparateurs, pas un score pondere.** C'est la lecture
litterale de la demande et c'est aussi la seule honnete : un 9/10 ne doit
jamais perdre contre un 8/10 qui se trouve etre un favori. Chaque critere ne
parle que si le precedent est a egalite (`lib/profile/favorite.ts`).

**2. Le quatrieme critere est le seul qui coute une requete, donc il n'est
cherche que la ou il peut encore changer la reponse.** `tiedHead()` rend le
groupe encore ex aequo apres les trois premiers criteres — presque toujours un
seul titre — et la note moyenne n'est resolue que pour lui, plafonnee a 8. Un
profil AniList n'y passe jamais : `meanScore` arrive deja dans la requete de
liste. Une liste locale de 300 titres non notes, elle, serait 300 appels sans ce
plafond.

**3. Les trois sources sont normalisees vers une seule forme
(`lib/profile/types.ts`).** AniList, la sauvegarde cloud d'un compte AniScroll,
et le `localStorage` de l'appareil disent la meme chose avec des noms
differents — et surtout des **echelles de note differentes**. La requete AniList
demande donc `score(format: POINT_10_DECIMAL)`, qui est deja le format de la
liste locale : sans ca les deux moities du classement ne sont pas comparables et
le tri du premier critere est du bruit.

**4. L'invite a sa page a lui, et elle ne peut pas en etre une autre.** Sa liste
ne vit que dans son navigateur : lui donner une URL publique serait promettre un
lien qui ne montre rien a personne d'autre. D'ou `/en/profile/me`, sans SSR, en
`noindex`, ou toute la chaine (classement, banniere) tourne cote client contre
`/api/v2/profile-banner` — le meme endpoint partage et cache a l'edge que le
selecteur de banniere interroge.

**5. Le choix manuel vit sur la ligne du compte (`users.profile_banner`), pas
dans `user_data`.** C'est une page publique : tous les visiteurs doivent voir la
banniere choisie, alors que `user_data` est la sauvegarde privee par appareil.
Corollaire : l'URL stockee est ecrite par l'utilisateur puis servie a tout le
monde, donc elle passe par une liste blanche d'hotes (`isAllowedBannerUrl`) —
sans quoi c'est un champ d'image arbitraire sur une page publique. Un invite,
lui, garde son choix en `localStorage`.

**6. Par defaut, rien n'est fige.** Tant que le proprietaire ne choisit pas, le
profil se re-habille tout seul quand ses gouts bougent. Le bouton « revenir a
l'automatique » est toujours a un clic.

**Verifie sur dev.aniscroll.com** (CDP, `tools/browser-check`) : profil AniList
`Sora` -> Shaman King (note 10, favori, 3 revisionnages — la chaine complete
jusqu'au troisieme critere, confirmee par une requete AniList independante) ;
invite sans liste -> plaque `--brand-primary` ; invite avec liste semee ->
Fullmetal Alchemist (10 contre 10 avec One Piece, departage aux revisionnages).
**Non exerce sur un vrai compte AniScroll sans AniList** : le chemin est ecrit
et compile, mais aucun tag reel n'etait sous la main.

### Ce que le premier jet avait rate (corrige le jour meme)

**Le classement etait juste ; c'est la liste des candidats qui ne l'etait
pas.** Sur une vraie liste de 683 entrees, **297 sont "Prevu" sans un seul
episode vu**, et onze d'entre elles — toutes notees 10 — occupaient tout le haut
du classement devant des series reellement regardees (`Orb`, `Takopi`, `PLUTO`…
que le proprietaire n'a jamais lances). Sur AniList, **une note posee sur un
titre prevu est une attente, pas un verdict** : c'est une donnee d'un autre
genre que les autres, et la moyenner avec elles n'a pas de sens. Ces entrees
sortent donc des candidats. Ce qui a ete commence au moins une fois reste
eligible — abandonne et en pause compris, parce que ce sont des verdicts. Le
premier du classement, lui, n'a pas bouge : le bug ne se voyait qu'a partir du
2e rang, donc **la banniere elle-meme etait bonne et seule la liste du selecteur
trahissait le probleme**. Sans le retour de l'utilisateur sur « Orb, je ne l'ai
pas vu », rien ne l'aurait signale.

**Un clic qui enregistre est un clic qui piege.** Le selecteur figeait la
banniere des la premiere tuile touchee : parcourir la galerie gelait le profil
sur la derniere image regardee, et le symptome remonte a ete « la banniere
change toute seule » — l'utilisateur ne pouvait pas relier son propre clic
d'exploration a un enregistrement. Le clic ne fait plus que selectionner, un
bouton confirme, et la tuile en place est marquee.

**Le flou "inexplique" etait delibere — au mauvais endroit.** Le hero floute
une affiche verticale faute de mieux, ce qui est defendable. Le selecteur
heritait du meme traitement : affiches floutees et agrandies, bannieres fines de
1000x185 etirees en 16:9. **Un selecteur doit montrer ce qu'il propose** : tout
ce qui n'est pas au format large s'affiche entier sur un fond sombre, avec son
format ecrit dessus.

**Le zoom lent recadrait.** La plaque respirait avec un Ken-Burns de 1.06 a
1.16 — donc elle coupait, ce qui est exactement ce qu'une banniere choisie dans
les illustrations de l'anime ne doit pas faire. Supprime, et la bande se
dimensionne desormais sur le 16:9 de l'illustration (`min(56.25vw, 80vh)`) :
sur un ecran large, l'image est visible en entier.

### Deuxieme passe : ce qui compte comme verdict, et image vs banniere

**"Terminé" est le vrai filtre, pas "commence".** La passe precedente excluait
les titres jamais lances ; il restait le fond du probleme. Une note posee avant
la fin n'est pas un verdict sur l'oeuvre — c'est une attente ("Prevu") ou une
impression a mi-parcours ("En cours"), et c'est regulierement un 10 qui ne
survit pas au denouement. Seuls `COMPLETED` et `REPEATING` restent candidats
(683 entrees -> 187). `REPEATING` est la raison pour laquelle le test n'est pas
litteralement "completed" : un re-visionnage veut dire que l'oeuvre a ete finie
au moins une fois, le verdict le plus fort qui soit. En pause et abandonne sont
dehors : l'histoire n'a jamais ete vue jusqu'au bout, la note ne porte pas sur
le meme objet.

**Une illustration et une banniere ne se portent pas pareil.** Un fond 16:9 est
une IMAGE : elle passe derriere toute la zone d'en-tete et le profil se lit
dessus. Une banniere AniList 1900x400, ou un fanart 1000x185, est composee comme
un bandeau — il n'y a rien au-dessus ni en dessous du cadrage a reveler, donc
l'agrandir ne fait que la grossir : elle reste un bandeau (`plateMode`). Le
format voyage avec le choix jusque dans la banniere epinglee, parce que rien ne
permet de le deduire de l'URL. La decision pure vit dans `types.ts` et non dans
`banner.ts` : ce dernier atteint la base des fanarts, et le hero — qui pose la
question — ne doit pas trainer un client libSQL dans le bundle navigateur.

**Le voile doit defiler avec l'image qu'il attenue.** Le fond a d'abord ete pose
en `position: fixed`, pour le parallaxe. Un voile fixe est cale sur la FENETRE :
des que la page defilait, le haut du viewport — la partie volontairement claire
du degrade — se glissait sous la rangee de statistiques et la rendait
illisible. En `absolute`, couvrant bande + statistiques et se terminant dans le
noir plein, le raccord avec le contenu est invisible. *(Cette conclusion a ete
reprise le jour meme : voir la troisieme passe. Le `fixed` etait le bon choix,
c'est le degrade qui etait le mauvais outil.)*

**Piege d'outillage, a noter pour la prochaine fois** : `Page.captureScreenshot`
apres un `scrollTo` en headless a rendu deux etats superposes (les memes pastilles
de filtre dessinees a deux hauteurs), ce qui donnait l'illusion d'un bug de mise
en page deja corrige. Mesurer la geometrie via `Runtime.evaluate`, et capturer
avec `clip` + `captureBeyondViewport` plutot que de faire defiler la page.

### Troisieme passe — le fond tient, et plus rien n'est recadre

Deux reproches : « j'ai une image en plein ecran mais quand je scroll elle n'est
plus la », et « image et banniere sont zoomees ».

**Un fond qui disparait au defilement n'est pas un fond.** La deuxieme passe
avait tire la mauvaise lecon de l'echec du `fixed` : ce n'etait pas la fixite
qui posait probleme, c'etait d'avoir voulu qu'un voile fixe joue le role d'un
degrade calcule sur la position du nom et des cartes, qui, eux, bougent. Le fond
redevient donc `fixed` et couvre tout le viewport, et **le voile devient
independant du defilement** : un voile uni. Chaque element qui doit rester
lisible par-dessus une image quelconque porte desormais son propre contraste
(ombre portee sur le nom, fond sombre + flou sur les cartes de statistiques). Le
raccord avec la liste, lui, est dessine **dans le flux** (`.as-page-seam`), donc
il reste colle au contenu quoi qu'il arrive.

**Un aplat opaque annule un fond fixe.** Le contenu etait peint sur `bg-primary`
plein : au bout d'un ecran de defilement, l'illustration etait definitivement
recouverte — exactement le reproche. Il devient un **voile a 90 %**
(`.as-page-under`), et l'image transparait sous la liste et le pied de page.
Applique sans condition, sans avoir a savoir s'il y a une illustration : 90 % de
`#0c0d10` pose sur le `#0c0d10` de la page redonne `#0c0d10`.

**Le zoom venait d'une etiquette perimee, pas d'une mise a l'echelle.** La
banniere epinglee du compte de test etait une bande fanart **1000x185**
enregistree avec la source `background` (l'epinglage precede le stockage du type
d'illustration, et l'API retombe sur `background` par defaut). Elle etait donc
portee en papier peint plein ecran, ou elle perdait **62 % d'elle-meme**. Lecon :
*la source declaree est une etiquette, et une etiquette vieillit ; les
proportions de l'image, non.* Elle ne sert plus que de premiere hypothese le
temps du premier rendu, puis la mesure decide — au-dela de 3:1 c'est une bande,
en deca un fond. La mesure ne coute aucun telechargement (`new Image()` sur une
URL que `next/image` a deja chargee).

Dans la meme veine, les hauteurs de bande etaient choisies en `vh`, ce qui
garantit un recadrage des que la fenetre n'a pas la bonne forme. Premiere
correction : caler la bande sur le **4.75:1** dans lequel AniList dessine ses
propres bannieres (1900x400). Insuffisant, et pour la meme raison que l'erreur
precedente — **une banniere fanart fait 5.4:1** (1000x185), donc `object-cover`
lui rognait toujours les bords (le `D` de DARLING et le second `XX`
disparaissaient). Deviner la forme d'une image qu'on vient de mesurer n'a aucun
sens : la bande prend la proportion **exacte** de l'illustration, plafonnee, et
`object-contain` garantit qu'un cas plafonne est borde plutot que coupe.
Recadrage mesure : 64 % → 12 % → **0 %**.

**Bug trouve par le releve, sans rapport avec la demande** : le profil affichait
« 0 anime » a un visiteur anonyme. La requete AniList etait abandonnee a 6 s ;
mesure sur la liste reelle (824 entrees) : **3,8 s / 11,7 s / 4,5 s**. Environ un
chargement sur trois rendait donc un profil vide — et `0`, ce n'est pas
« inconnu », c'est un chiffre faux. Delai porte a 14 s. Le vrai defaut de fond
reste entier : une requete tierce lente et bloquante sur le chemin critique du
SSR.

Le papier peint plein ecran avait le meme defaut, en plus discret : `cover` en
rognait 10 %. La couche nette passe en `object-contain` — l'illustration est vue
entiere — et **une seconde copie de la meme image**, agrandie et floutee, comble
les bandes que cela laisse. Aucune requete de plus (meme URL, deja en cache) :
un letterbox vide annoncerait que l'image ne rentre pas ; la, le cadre est fait
de l'image elle-meme.

**Preserver une image puis ecrire dessus n'a pas de sens.** L'avatar et le pseudo
se posaient au milieu de la bande, pile sur le logo. Sous une bande, l'identite
descend donc dessous, l'avatar mordant sur le bord pour relier les deux ;
au-dessus d'un papier peint elle ne bouge pas, car y etre lue sur l'image EST le
parti pris et la place ne manque pas. Dans la foulee le voile lourd de la bande
disparait : il servait a rendre un nom lisible, il ne restait qu'a noircir le
tiers bas d'une illustration pour rien.

**Verifie sur dev** (fenetre 1600x900) : illustration 1920x1080 → `fixed`, boite
inchangee a `@y0` apres 500 px de defilement, **0 % rogne** (bordee a 10 % par sa
propre copie floutee) ; bande 1000x185 → mode bande, 1584x293 (soit 5.41:1, la
proportion exacte de l'image), 0 % rogne et 0 % borde ; visiteur anonyme →
383 animes, 683 lignes.

### Quatrieme passe — le fond revient au plein cadre, et l'invite a la meme page

**Retour en arriere assume sur le papier peint.** L'illustration entiere, cadree
par sa propre copie floutee, a ete essayee puis retiree a la demande : les
bandes floutees coutent plus que les ~10 % que `cover` fait perdre. La bande,
elle, garde `object-contain` — la, le recadrage detruit une composition et il
n'existe aucune autre facon de la montrer entiere. Deux besoins differents, deux
reponses differentes : ce n'est pas une incoherence.

**Le design du profil ne dependait pas des donnees mais du fait d'avoir un
compte.** Un invite tombait sur une page a part. Il retrouve la meme coquille —
hero, plaque de l'anime prefere, statistiques, liste groupee — sur
`/en/my-list` (`components/profile/LocalProfile.tsx`). Ne pas etre connecte
change **d'ou vient la liste, pas ce que vaut la page**. Ce n'est pas appele un
profil et ca n'a pas d'URL partageable : une liste qui ne vit que dans un
navigateur n'est pas un profil que quelqu'un pourrait visiter. `/en/profile/me`
reste en redirection, l'URL ayant pu etre mise en lien ou en historique.

Voir aussi `devlog/comptes.md` pour les trois etats d'identite dont cette page
est desormais la vitrine — et, meme date, la panne AniList qui cassait la
connexion en silence.


## 2026-08-29 — Deux "Season 1" a la file : le garde qui empechait de compter

**Le symptome**, vu sur la fiche Jujutsu Kaisen : le selecteur de saisons
alignait `Season 1 (2020)`, `Season 1 (2023)`, `Season 3 Part 1 (2026)`. Deux
lignes indiscernables, et un 3 qui sortait de nulle part.

**La cause** est dans `nextSeasonNumber` — a l'epoque, la meme regle recopiee a
trois endroits (`seasonChain`, `resolveSeason` deux fois). Elle testait
`continuesSameWork` AVANT le numero lu dans le titre. Or ce test compare les
titres une fois leur numero retire, et `seasonTitleBase("JUJUTSU KAISEN Season
2")` rend `"jujutsu kaisen"` : la meme chose que la saison 1. La S2 heritait donc
du compteur au lieu de l'avancer.

Le garde n'est pas une erreur en soi, il a ete pose pour un vrai cas : SAO
« Alicization - War of Underworld Part 2 » s'intitule nativement *2nd Season*, et
s'y ancrer ramenait le compteur de 4 a 2. **Ce qui separe les deux situations
n'est pas le titre, c'est le SENS du saut** : un numero qui avance vient du titre
de la franchise, un numero qui recule vient de la numerotation interne d'un
sous-titre. Premiere correction : le numero du titre reprend la main quand il est
plus GRAND que le compteur.

### Ce que la correction ne voyait pas, et le banc qui l'a trouve

Corriger sur le cas signale ne dit rien du reste du catalogue. D'ou
`tools/season-audit` : il fait tourner le **vrai** `resolveSeasonList` (via
`jiti`, pas une reimplementation) sur une quarantaine de franchises et signale
deux formes precises — un numero repete par deux entrees dont AUCUNE ne porte de
marque de partie, et un compteur qui recule. Le doublon avec `Part` est
legitime : une saison coupee en deux cours porte deux fois le meme numero.

Verdict du premier passage : **4 franchises sur 40**, et une que la premiere
correction ne couvrait pas.

| franchise | affiche | attendu |
|---|---|---|
| Attack on Titan | S1 S2 S3 S3P2 **S3 S3P2** | S1 S2 S3 S3P2 **S4 S4P2** |
| My Hero Academia | S1..S6 S7 **S7** | S1..S6 S7 **S8** |

Meme famille, par l'autre porte : « Attack on Titan: The Final Season » ne porte
AUCUN numero. La branche « numero plus grand » ne s'appliquait pas, et
`continuesSameWork` — vrai, comme presque toujours dans une franchise — retenait
le compteur a 3.

**La lecon** : `continuesSameWork` ne devait jamais avoir le pouvoir de decider
qu'une saison n'en est pas une. Dans une franchise il est presque toujours vrai,
puisque c'est justement ce qui fait une franchise. Il ne sert plus qu'a une
chose, empecher un numero de titre de faire reculer le compteur ; ce qui inhibe
le +1 est desormais la seule marque de continuation (`Part 2`, `Cour 2`,
`The Final Chapters`).

Regle finale, dans `nextSeasonNumber` (helpers.ts), ecrite une fois pour les
trois appelants :

    numero du titre > compteur   -> on s'y ancre
    marque de continuation       -> herite du compteur
    numero du titre              -> on s'y ancre, sauf si l'entree prolonge
                                    la precedente (numerotation interne)
    sinon                        -> compteur + 1

`seasonChain:v11` / `seasonList:v22`. Sans le tag, les mauvais numeros tenaient
sept jours.

## 2026-08-29 — La vignette d'episode passe a TMDB, qui CHOISIT

**Le constat**, capture a l'appui : pour Cyberpunk ep2, la fiche TMDB montre un
plan et notre tuile un autre. TMDB tient **cinq** stills pour cet episode et
publie celui que ses votes designent (`still_path`, 1920x1080) ; ani.zip n'a
qu'une screencap TVDB, native 640x360, et rien au-dessus. La regle en vigueur —
« TMDB ne comble que les trous laisses par ani.zip » — nous faisait donc preferer
l'image la moins bonne, choisie par personne.

Pire, elle produisait une incoherence a l'ecran : `img` venait d'ani.zip et
`imgHd` de TMDB, donc **la tuile et le poster du lecteur montraient deux plans
differents du meme episode**.

TMDB passe devant. La regle d'origine avait une raison de securite — une saison
mal mappee ne laisse plus un trou, elle remplace une image juste par une fausse —
et ce sont maintenant les deux gardes de `getTmdbEpisodeStills` (coherence du
groupe Fribb, plancher sur le nombre d'episodes) qui portent seuls cette charge.
A verifier avant de les assouplir.

**Au passage, une taille qui n'existait pas.** TMDB annonce `w92/w185/w300/
original` pour les stills : au-dessus de 300, `original` semblait la seule
option, et 1920 px sur une liste de dix tuiles n'en est pas une. Mesure du jour :
les listes de `/configuration` sont **indicatives**, le CDN sert n'importe quel
jeton de taille pour n'importe quel chemin. `w780` repond 200 et pese 59 ko — la
tuile devient nette sur un ecran HiDPI et coute MOINS que les 138 ko de la
screencap TVDB qu'elle remplace.

`tmdbStills:v2` (les URL stockees portent la taille) et `episode:v8` (les listes
tiennent 30 jours).

## 2026-08-15 — Le graphe des relations se dessinait deux fois

**Le symptôme** : sur SAO, Fate ou One Piece, le plateau se réorganisait tout
seul une seconde ou deux après son apparition. Pas « quelques cartes
s'ajoutent » — mesuré à la frame avec un enregistreur `requestAnimationFrame`
injecté avant le code de l'app :

| anime | 1er jet | 2e jet | écart | cartes déjà posées qui bougent | zoom |
|---|---|---|---|---|---|
| SAO | 13 @3,2 s | 19 @4,6 s | 1,43 s | **13/13**, 1 change de colonne, 1010 px | 0,318 → 0,276 |
| Fate/stay night | 23 @5,2 s | 42 @7,7 s | 2,42 s | **23/23**, 2 colonnes, 2523 px | 0,138 → 0,109 |
| One Piece | 54 @6,1 s | 60 @7,5 s | 1,35 s | **54/54**, 9859 px | 0,043 → 0,038 |

**La cause, et elle était écrite dans le fichier** : `RelationsGraph` marchait la
franchise deux fois — un brouillon depuis la page ouverte, puis le vrai plateau
depuis la racine de la franchise (pour que toutes les pages d'une franchise
dessinent la même image). Le commentaire du composant disait déjà pourquoi ces
deux marches ne peuvent pas coïncider : l'ordre de traversée décide du sens
d'une paire litigieuse (SAO II appelle le pilote de Fatal Bullet un PARENT, le
pilote appelle II un OTHER) et dagre range sur le sens. Le premier jet était
donc, par construction, une image jetable. Elle était affichée quand même.

**Deux aggravants** : le recadrage (`fitView`) était un `useEffect`, donc chaque
nouvelle mise en page était peinte une frame à `scale(1)` en haut à gauche avant
de se recadrer (12 ms sur SAO, 13 ms sur One Piece) ; et il est clé sur
`width x height`, donc il réinitialise aussi le zoom et le décalage du lecteur.

**La correction** : la marche part côté serveur (`lib/anilist/franchiseTree.ts`,
transcrite et non paraphrasée — un réécriture équivalente atterrit sur une autre
image), derrière `/api/v2/relations/tree?id=`. Une seule réponse, donc une seule
image. Le recadrage passe en `useLayoutEffect`. Vérifié : 1 seul état rendu au
lieu de 3-4, et le plateau final est **au pixel** celui d'avant.

**Le piège de mesure** : en local, l'endpoint mettait 45 s (One Piece) à 80 s
(Fate) et répondait tronqué. Sur dev : 0,2 à 1,7 s, complet. La différence n'est
pas le code — c'est que **le cache de réponses AniList est dans Upstash**
(30 min), injoignable en local, donc chaque marche re-interroge AniList et se
fait étrangler par le limiteur 28/min. Ne jamais conclure sur une latence
mesurée en local. Voir [[no-local-player-testing]].

**Ce que le déplacement rend plus risqué, et le garde-fou** : la marche était
6-8 requêtes ayant chacune son timeout, elle est maintenant une seule. D'où un
budget de 15 s au-delà duquel elle répond ce qu'elle a avec `partial: true`,
mis en cache quelques minutes au lieu d'un jour — la requête suivante, sur un
cache plus chaud, va plus loin.

**Coût** : il baisse. Avant, la clé de cache du CDN était une liste d'ids dont
la composition changeait avec la traversée (6 entrées par franchise) ; c'est
maintenant une URL par anime, 24 h, plus un mémo par instance qui indexe TOUS
les membres de la franchise (l'arbre est identique depuis n'importe quelle
page — vérifié). Le nombre de requêtes AniList en amont est inchangé.


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

## 01/09/2026 — Le profil : un voile de trop, et une grille qui bougeait par bonds

### `.as-page-under` supprimee

Deux couches faisaient le meme travail au-dessus du papier peint. La plaque
porte deja `.as-page-scrim`, degrade calibre pour ca : 0,72 sous la navbar
transparente, **0,28 dans tout le corps**, 0,6 au pied. Par-dessus,
`.as-page-under` posait un aplat de `rgba(12,13,16,0.9)` sur tout le contenu du
profil. 0,28 puis 0,9, cela fait ~0,93 de noir plat entre l'illustration et
l'oeil : sous le hero, le papier peint n'existait plus.

La regle qui autorise un scrim aussi leger est ecrite juste au-dessus de lui —
tout ce qui doit rester lisible sur une image quelconque porte SON PROPRE
contraste : le pseudo une ombre, les cartes `.as-stat-card`, les puces un flou.
Un second drap sur toute la page est ce qu'on ajoute quand cette regle n'est pas
suivie ; il ne repare aucune carte, il cache l'illustration. Le commentaire qui
remplace la regle dans `globals.css` dit pourquoi elle ne doit pas revenir.

Quatre emplois retires (`profile/[user].tsx` et `LocalProfile.tsx`, contenu et
pied de page). Le `relative z-10` reste : il repond a une autre question, celle
de l'empilement au-dessus de la plaque fixe en z-0.

### La grille de widgets suit enfin le curseur

Le deplacement suivait deja la main au pixel (`offset`), mais le
**redimensionnement, non** : `onMove` n'ecrivait que la taille arrondie. Le bloc
avancait donc d'une colonne d'un coup, et comme il portait la transition de
200 ms des blocs au repos, chaque bond arrivait avec 200 ms de retard. C'est ce
que « il manque une animation » designait : il y en avait une, elle etait
posee sur le mauvais bloc.

Le partage est desormais celui de react-grid-layout :

- le bloc tenu ne porte **aucune** transition et affiche sa taille libre, non
  arrondie (`livePixels`, calculee depuis le rectangle de DEPART — partir de la
  disposition courante le ferait rebondir a chaque franchissement de case) ;
- les autres gardent les 200 ms `ease-in-out` et se referment autour de lui ;
- le fantome existe maintenant aussi pour le redimensionnement, et glisse
  (`transition-[left,top,width,height] duration-100`) au lieu d'apparaitre ;
- au relachement, `drag` repasse a null : le bloc recupere sa transition dans le
  meme rendu et se pose sur la case en 200 ms, sans une ligne de plus.

`dragId` devient `drag = {id, mode, x, y, w, h}` : le rendu a besoin du
rectangle de depart, et un ref lu pendant le rendu ne redeclenche rien.

### Suite : la couture, et la Roulette du soir

`.as-page-seam` part avec le voile. Elle fondait sur 140 px vers
`rgba(12,13,16,0.9)` pour rejoindre `.as-page-under` ; celui-ci n'existant plus,
elle fondait vers une couleur que plus rien ne peignait et ne faisait que
tracer une bande sombre en travers du papier peint — a l'endroit precis ou le
papier peint est cense continuer. `.as-page-scrim` est desormais la SEULE couche
au-dessus de l'illustration.

Le bloc `roulette` (« Roulette du soir ») est retire du catalogue : l'entree
dans `BLOCKS`, `RouletteBlock`, `plannedPool` — qui n'avait qu'elle pour
appelant — le cas dans `ProfileOverview`, et les deux traductions. Les
dispositions deja enregistrees qui le contiennent ne cassent pas :
`sanitizeLayout(stored, isKnownBlock)` jette les identifiants inconnus et
`compact` referme le trou.

### Les widgets du profil : trois gestes au lieu de sept boutons

En mode reorganisation, chaque bloc portait dans son en-tete deux fleches
monter/descendre, un selecteur de quatre tailles types (S M L XL) et une croix.
Sept commandes serrees dans une barre, sur une carte qui fait parfois une seule
colonne de large — et **toutes en double d'un geste qui existait deja** : les
fleches refaisaient le glisser-deposer, les tailles refaisaient la poignee du
coin bas-droit.

Il ne reste que les gestes. Le moins qui les remplace est repris des cartes du
graphe des relations (`gStyles.nodeClose`) : pas de cadre, pas de fond, glisse
dans le coin haut-droit, `M200-440v-80h560v80H200Z`. Le raisonnement y est deja
ecrit — une croix cerclee poserait une seconde pastille sur une carte qui en
porte deja une (ici la couleur du bloc) et se lirait comme un element du bloc
plutot que comme une commande.

Il est place **a cote** de l'en-tete et non dedans : l'en-tete EST la poignee de
deplacement, un bouton pose dessus devrait arreter la propagation du
`pointerdown` pour ne pas demarrer un glissement. L'en-tete gagne un `pr-6` en
edition, sinon un titre long passe sous le moins.

Retires avec eux, faute d'appelant : `IconButton`, `move()`, et dans
`lib/profile/grid.ts` les exports `SIZES`, `reflow` et `readingOrder` — ces deux
dernieres n'existaient que pour les fleches, qui raisonnaient en ordre de
lecture et pas en coordonnees. Cote traductions, `moveUp`, `moveDown` et le
groupe `size`, et le `hint` ne promet plus « ou choisis une taille type ».

### La carte entiere devient la poignee

`react-grid-layout` sans `draggableHandle` : on attrape un bloc la ou on le
voit. Le `pointerdown` passe de l'`<header>` a la `<section>`, et ce qui doit y
echapper arrete la propagation — le coin de redimensionnement (deja, dans
`startDrag`) et le moins — soit exactement le role du `draggableCancel` de la
bibliotheque.

Une chose que le depot n'a pas a resoudre et nous si : **les blocs sont pleins
de liens**. Une jaquette, un titre, un bouton « reprendre ». Des lors que la
carte entiere se glisse, chaque glissement part de l'un d'eux et finit en
navigation. En edition le corps devient donc inerte
(`[&_*]:pointer-events-none` + `select-none`) : reorganiser, c'est ranger, pas
parcourir. Le contenu reste visible, il ne repond plus ; le moins et le coin
sont ailleurs dans la carte et gardent le leur.

`touchAction: none` passe sur la section, sinon un glissement au doigt fait
defiler la page.

## 01/09/2026 — La disposition du profil appartient au profil, pas au lecteur

« En n'etant pas proprietaire je dois voir la meme chose que lui. » On ne le
voyait pas, et pour une raison qui n'etait pas un bug mais un mauvais
emplacement.

`aniscroll:profileLayout` etait une cle **locale**, sauvegardee avec la
categorie `prefs` — c'est-a-dire sur le compte de **celui qui regarde**. Un
visiteur n'avait donc, au mieux, que sa propre disposition sous la main, et
`ProfileOverview` s'en protegeait en lui servant la grille par defaut
(`isOwner && stored.layout ? … : defaultLayout(…)`). Consequence : ce qu'un
proprietaire rangeait, personne d'autre ne le voyait jamais — et deux
proprietaires partageant un navigateur se marchaient dessus.

Elle devient une colonne `profile_layout` de `users`, a cote de
`profile_banner`, publique pour exactement la meme raison : c'est ainsi que le
profil se presente aux autres. Lue au rendu serveur dans `[user].tsx`, nettoyee
la (`sanitizeLayout`) pour que la premiere peinture soit deja la bonne, et
passee a `ProfileOverview` en `accountLayout` — la meme valeur pour tout le
monde.

**Ce qui n'est PAS aligne, et pourquoi.** Les blocs `source: "device"` —
reprendre la lecture, vu recemment — lisent la progression de l'appareil qui
affiche la page. Servis a un visiteur, ils montreraient **sa** lecture a lui
sous le nom d'un autre. Rien ne peut les remplacer par la donnee du profil : elle
n'existe pas cote serveur. `visibleTo` les retire donc toujours pour un
visiteur. Tout le reste — favoris, statuts, notes, genres, formats, studios,
saison, personnages — est desormais identique des deux cotes, a la case pres.

Details qui comptent :

- **Ecriture differee de 500 ms.** `commit` est appele a chaque mouvement du
  pointeur ; une requete par pixel n'a aucun sens. Le dernier etat gagne, ce qui
  est la semantique voulue.
- **Reprise des dispositions existantes.** Celles rangees avant ce changement
  sont dans le localStorage de leur auteur et nulle part sur son compte. Au
  premier chargement en proprietaire, si le compte n'a rien, la disposition de
  l'appareil est adoptee et poussee — une fois. Sans ca, tout le monde
  retrouvait la grille par defaut le jour du deploiement.
- **`PUT /api/v2/account/profile-layout`** nettoie ce qui entre au lieu de se
  contenter de le valider : la charge vient d'un navigateur, donc elle n'est
  jamais de confiance, et celle-ci sera **relue par d'autres que son auteur**.
- `lib/prefs/profileLayout.ts` reste pour le seul cas sans compte : le profil
  local d'un invite.

### Rattrapage : la grille etait deja sur le serveur

Premier constat apres deploiement : un visiteur voyait toujours quatre blocs.
Normal — `users.profile_layout` etait vide pour tout le monde, et la reprise
depuis le localStorage ne se declenche que quand le PROPRIETAIRE ouvre son
propre profil. Un profil restait donc sur la grille par defaut pour tous ses
visiteurs jusqu'a ce que son proprietaire repasse.

Sauf que la disposition etait deja lisible cote serveur : `aniscroll:profileLayout`
est une cle locale, donc deja poussee dans la categorie `prefs` du compte par
cloudSync. Le rendu serveur de `[user].tsx` la lit maintenant quand la colonne
est vide (`getAllData(account.id)` → `prefs` → cette cle), et **l'ecrit dans la
colonne au passage** pour que la lecture supplementaire ne se reproduise pas.

Une ecriture declenchee par un GET, ce qui se justifie ici et seulement ici :
elle est idempotente, elle ne fait que deplacer la donnee du proprietaire d'un
endroit a l'autre, et elle s'eteint d'elle-meme des qu'elle a servi.

## 01/09/2026 — Voir l'activite de lecture d'un AUTRE profil

Les blocs « Reprendre la lecture » et « Vu recemment » n'apparaissaient pas sur
le profil de quelqu'un d'autre. Ce n'etait pas de la pudeur : ils lisaient le
localStorage du navigateur qui AFFICHE la page, donc servis a un visiteur ils
auraient montre **sa** lecture a lui sous le nom du proprietaire. `visibleTo`
les masquait pour cette seule raison, et c'etait la bonne reponse tant que la
source etait celle-la.

Elle ne l'est plus. Rien n'a eu besoin d'etre collecte : les deux stores dont
ils dependent sont **deja sauvegardes sur le compte** par cloudSync —
`artplayer_settings` sous la categorie `recent`, `aniscroll:progress` sous
`progress`. Il n'y avait qu'a les deballer, exactement comme
`localListFromCloudPayload` le fait pour la liste.

### Le decoupage

- `lib/profile/history.ts` : la mise en forme sort de `readHistory` dans
  `rowsFromRaw(raw, limit)`. La garde `typeof window` restait la seule chose qui
  empechait ce code de tourner cote serveur ; le reste etait deja isomorphe. Une
  seule mise en forme pour les deux vues du meme historique.
- `lib/profile/activity.ts` (nouveau) : `historyFromCloud`, `progressFromCloud`,
  `decorateRows`, `activityFromCloud`. Le `decorate()` de DeviceBlocks prend
  desormais la table de progression **en parametre** au lieu d'appeler
  `getProgress` — celui-ci lit le localStorage et renvoie donc toujours `null`
  hors navigateur : l'avancement de tout le monde serait reste a zero sans que
  rien n'echoue.
- `lib/watch/progress.ts` : `readProgressMap()` exporte, pour que le chemin
  navigateur passe par le meme `decorateRows` (un `getProgress` par ligne
  reparserait le localStorage a chaque appel).
- `DeviceBlocks` : les deux blocs prennent `rows?: ActivityRow[]`. Fourni → ce
  que le serveur a reconstruit. Absent → le hook local, inchange.

**Le proprietaire chez lui garde sa source locale**, deliberement : elle est
plus fraiche que la derniere synchronisation et elle se met a jour PENDANT qu'il
regarde (`PROGRESS_EVENT`). Lui servir sa propre sauvegarde lui montrerait un
episode de retard sur ce qu'il vient de lancer.

### Le cout, parce que c'est la vraie contrainte

Cette page est en `getServerSideProps` : chaque vue est un MISS, et tout ce
qu'on demande est paye a chaque visite. Deux regles, donc.

**Zero ecriture ajoutee.** `progress` et `recent` sont deja pousses par
cloudSync (`DEBOUNCE_MS = 5000`). On ne recopie surtout PAS l'activite dans une
colonne de `users` comme on l'a fait pour la disposition : ca imposerait une
ecriture a chaque tick de progression.

**Une lecture, jamais deux, et souvent zero.** Les categories sont choisies
AVANT de lire, pas filtrees apres : `list` (jusqu'a 1 Mo) seulement pour un
compte sans AniList, `prefs` seulement tant que `profile_layout` est vide,
`progress`/`recent` seulement si la grille les affiche. La ligne `users` etant
deja en main (`findByTag`), une colonne renseignee donne la disposition sans
rien demander — un profil qui a retire ces deux blocs ne coute pas un octet de
plus qu'avant. Et `getData(userId, kinds)` remplace `getAllData` sur ce chemin.

Au passage, les deux `getAllData` que la page faisait (branche « compte sans
AniList », rattrapage de disposition) fusionnent avec celle-ci : sur ces
chemins-la, le nombre d'appels **baisse**.

### Le garde-fou est aussi le seul moyen de ne rien publier

L'activite n'est calculee que si la disposition contient `resume` ou `recents`.
Ce n'est pas qu'une economie : la disposition etant publique, « je retire le
bloc » doit vraiment retirer la donnee. Sans ce test, elle resterait lisible
dans `__NEXT_DATA__` alors que plus rien ne l'afficherait — il n'y a pas de
reglage de visibilite, retirer le bloc EST le reglage.

### Les textes tutoyaient le lecteur

« Rien en cours sur cet appareil », « il te reste 12 min », « Reprendre » : rien
de tout cela ne vaut sur le profil d'un autre. Cinq cles `*Other` ajoutees, et
`resume.title` devient « Regarde en ce moment » pour un visiteur.

### Verifie

21 assertions sur le decodage (`npx tsx`, script jetable) : tri par date,
renommages, `createdAt` ISO → epoch, pourcentage et minutes restantes, `done`
vrai quand `time === duration` (ce qu'ecrit `markComplete`), duree inconnue,
ligne sans `aniId` numerique jetee, lien de lecture avec et sans provider, et
tous les cas degeneres — payload absent, mauvaise cle, JSON illisible, `"{}"`
qu'ecrit `clearAllProgress`, `"null"`. Plus `tsc --noEmit` et `next lint`.

Le chemin « zero requete » est verifie par lecture et non mesure : le garde-fou
est un `kinds.length ?` sur un tableau construit juste au-dessus.

### La categorie qui ne se synchronisait jamais

Deux profils, deux symptomes, une seule cause. Sur celui de Winou, un visiteur
voyait « Regarde en ce moment : Frieren ep 8, il y a 6 j » pendant que
l'interesse avait Wistoria ep 12 sous les yeux. Sur celui de Lxcyd, le visiteur
voyait « Rien en cours. » et le proprietaire un episode 4 en cours.

`cloudSync` marque une categorie sale sur un evenement, et **il n'en existait
aucun pour `recent`**. La liste des ecouteurs le disait a qui la lisait :
`onList`, `onQueue`, `onProgress`, `onPlayer`, `onPrefs` — pas de `onHistory`.
`recent` n'etait donc pousse que par un `pushAll()` complet : a l'inscription,
ou en repondant « garder cet appareil » a la fenetre de conflit. Entre deux, la
copie du compte etait gelee, pendant que `progress` (qui a son
`aniscroll:progress-tick`) restait a jour — d'ou l'episode vieux de six jours
avec une progression fraiche appliquee dessus.

Le defaut est **anterieur** a ce chantier. Il etait simplement invisible tant
que `artplayer_settings` ne servait qu'a l'appareil qui l'ecrit ; il devient
voyant des lors qu'il nourrit le profil public.

Deux pieces :

- `HISTORY_EVENT` + `touchHistory()` dans `lib/profile/history.ts`, appele apres
  **chaque** ecriture du store : les deux du lecteur, les quatre de
  `recently-watched.js`, les quatre de `content.tsx`, celle de
  `clearAllProgress`. Cette derniere est redondante — son appelant pousse deja
  tout de suite — mais la regle ne souffre pas d'exception, sinon c'est le
  prochain appelant qui oubliera. `cloudSync` ecoute et marque `recent`.
- Un rattrapage pour les comptes deja figes : `mark("recent")` au demarrage
  **si et seulement si** `readRevs().recent === undefined`, c'est-a-dire « cet
  appareil n'a jamais vu de revision pour cette categorie ». La condition
  s'eteint des la premiere poussee reussie (`writeRevs` enregistre la revision
  renvoyee par le POST), donc pas de requete par session ensuite. Et si
  l'historique local est vide, `pushKinds` ne fait aucune requete du tout.

Cout : nul. `mark()` est debounce a 5 s et `pushKinds` envoie toutes les
categories sales dans **une seule** requete — `recent` voyage donc avec
`progress`, qui part de toute facon quand on regarde un episode.

### Les widgets, un par un : bornes de taille, et « reprendre la lecture »

Premiere passe de finition sur la grille du profil, widget par widget.

**Le chrome de la carte.** Le moins qui retire un bloc et le coin qui le
redimensionne etaient dessines chacun a sa maniere : `right-3 top-3` et
`opacity-60` par-dessus `text-white/60` pour l'un (soit un gris deux fois plus
pale), `bottom-0 right-0` + `p-[7px]` pour l'autre. Les deux commandes de la
carte se repondent maintenant en diagonale : meme boite de 28 px, meme retrait
de 7 px, meme `text-white/60`. L'en-tete passe de `pr-6` a `pr-7` pour la
largeur reelle du bouton.

**Les bornes de taille.** Un bloc peut desormais declarer `min` / `max` en
unites de grille (`[w, h]` dans `BLOCKS`, comme `size`). La contrainte vit dans
`lib/profile/grid.ts` — `Bounds`, `clampSize` — et s'applique aux **trois**
endroits ou une taille est decidee : le coin (`resizeItem`), l'apercu qui suit
le curseur (`livePixels`, sinon la carte se laisse tirer puis revient en arriere
au relachement) et `sanitizeLayout`, pour les dispositions ecrites avant
qu'un bloc n'ait un minimum. `WidgetGrid` ne consulte aucun catalogue : il
recoit une fonction `limits`.

La notation retenue est **hauteur × largeur** — « 1×2 » = une ligne, deux
colonnes. `BLOCKS` garde l'ordre `[w, h]` de ses autres champs ; c'est
`blockBounds()` qui traduit.

**`resume`.** Borne a 1×2 minimum, 2×4 maximum : sous deux colonnes la vignette
et le titre ne cohabitent plus, au-dela de deux lignes la carte est un grand
vide autour d'une seule ligne d'historique. Plus rien n'y est en pixels fixes —
la vignette tire sa largeur de la hauteur offerte (16/9, plafonnee a 46 % de la
carte), le titre passe sur **deux** lignes (`line-clamp-2`) au lieu d'etre
tronque, ce qui est le cas courant a la plus petite taille. Un bouton « fiche »
rejoint « reprendre » : il pointe vers `/en/anime/<id>` en dur, pas vers
`animeHref`, qui avec la preference « clic = lecture » renverrait la ou mene
deja tout le reste du bloc. Le triangle de lecture est celui du lecteur
(vidstack, `PlayButton.Play`) — coins arrondis, meme glyphe que celui sur lequel
on retombe en arrivant. Et sa pastille orange disparait de l'en-tete : elle sert
a distinguer des blocs qui se ressemblent, or celui-ci porte deja son
illustration. D'ou `dot: false` dans `BLOCKS` et `color` devenu optionnel dans
`BlockChrome`.
