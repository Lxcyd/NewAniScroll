# DEVLOG — Detecteur OP/ED

L'outil hors-site `tools/opening-detector` : detection des generiques,
replis F1-F7, garde-fous P1-P8, audits et lots de mesure.

Le plus recent en premier. L'index general est dans `../DEVLOG.md`.

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
