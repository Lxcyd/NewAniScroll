# Détecteur OP/ED v2

Réécriture à zéro, décidée le 29/09/2026. La v1 (`../opening-detector/`) avait empilé des replis sans jamais être mesurée contre une vérité humaine. Elle reste en place, intacte, tant que la v2 n'a pas fait ses preuves.

**Objectif** : ne servir que des bornes justes. S'abstenir vaut toujours mieux que se tromper. Si la v2 ne bat pas AniSkip sur la mesure (voir plus bas), on garde AniSkip.

## Principe

1. **Référence = le média AnimeThemes, et rien d'autre.**
   - On garde l'audio `.ogg`, les vidéos `.webm` et la durée mesurée sur le fichier.
   - On ignore les métadonnées : ni plages d'épisodes, ni ordre. Chaque épisode est testé contre **tous** les thèmes de la série.
2. **Empreinte dense** : Chromaprint brut, un mot de 32 bits toutes les 0,124 s (`fp/chroma.py`).
3. **Comparaison exhaustive** (`match/ber.py`). Pour chaque décalage possible, on compte les bits différents trame par trame. Une trame concorde sous `MATCH_BITS` (10 sur 32), après une médiane glissante sur 0,6 s.
4. **La continuité comme preuve.**
   - Un vrai générique a le même mixage que la référence. Il concorde du début à la fin, sans trou, à décalage constant (dérive nulle).
   - Une chanson reprise en musique de scène, sous des dialogues ou des effets, concorde par morceaux.
5. **Contrôle image** (**informatif depuis le 02/10/2026** : le son seul décide de servir, ce contrôle rejetait des génériques valides — Railgun S ep6 ED, Cyberpunk ep1) : un ED complet posé sur l'épilogue du dernier épisode a un audio parfait, et le sauter couperait l'histoire. L'audio donne l'alignement exact, donc l'image se compare au même temps relatif que la vidéo de référence.
6. **Décision** : servir, tronqué ou abstention, avec un code de raison. Les seuils sont calibrés sur des cas réels (phase P1), jamais raisonnés à la main.

## Règles de décision et de bornes (état au 02/10/2026)

Le **son décide seul**. Code : `decide.py` (servir ou s'abstenir), `run.theme_bounds` et `match/audio_edges.py` (bornes). Chaque seuil porte dans le code le cas mesuré qui l'a fixé.

**Servir**

| Cas | Condition | Exemple |
| --- | --- | --- |
| Reconnu en entier | couverture ≥ 95 %, aucun trou > 1 s, dérive ≤ 1 trame | la quasi-totalité |
| Tête ou queue non reconnue | corps parfait hors des 15 s de bord | UBW ep3 ED1 |
| Fin seule | le thème est noyé sous le dialogue, puis seul (≤ 6 bits) au moins 15 s jusqu'à sa dernière note, dans les 5 dernières minutes | Railgun S ep12, ep14 |

**S'abstenir**

- Thème au **milieu de l'épisode** (début après 8 min et fin à plus de 5 min de la fin) sans les images du générique (≥ 80 %) : une chanson de générique sur une scène n'est pas un générique. C'est le seul endroit où l'image décide.
- **Référence qui contient du dialogue** (AnimeThemes : `overlap` = Transition / Over), reconnue en entier, sans version propre de la même chanson : rien ne prouve où la chanson devient seule (Railgun S ep11, ep23).
- Deux séquences distinctes du même type : conflit.

**Bornes**

- **Début** = première note du thème dans l'épisode. Le silence de tête des clips AnimeThemes est du rembourrage.
- **Début retardé** tant que le son de l'épisode recouvre la chanson (`decide.head_cut`, ± 0,3 s) : Railgun S ep6, 9,9 s de scène sous l'ED. Le générique servi est alors plus court que le thème.
- **Fin** = dernière note, prolongée tant que l'épisode reste muet, au plus jusqu'au bout du fichier de référence (`audio_edges.mute_end`) : le dernier carton tient à l'écran sans musique.
- **Référence avec dialogue** : la version propre de la même chanson pose le début quand elle existe (Frieren ep28, ED1 contre ED1v3). Sinon, en fin seule, le début est la première plage propre d'au moins 2,5 s — fragile, la page le signale.
- Un thème qui contient un **vrai silence** se déclare à la main dans `refs/silences.json`.
- Jamais de calage sur les images (rejeté par Luc le 01/10/2026). Dire de quel côté vient un son en trop, par les formes d'onde ou le spectre, a été essayé et écarté.

**Limites connues**

- Scène qui continue à l'image mais sans autre son que la chanson : invisible au son, la borne reste à la première note (Railgun S ep16).
- Un son d'épisode discret sous toute la chanson (8 à 13 bits) : abstention (Railgun S ep24, Kimetsu ep26).

## Ce qui a été écarté, et pourquoi

- **AniPlaylist** : n'héberge aucun audio, seulement des liens Spotify, Apple Music et Deezer vers les versions longues.
- **YouTube** : contraire à ses conditions d'utilisation, yt-dlp est fragile, et on ne distingue pas la version TV de la version longue.
- **Extraits de 30 s iTunes et Deezer** : tirés de la version longue, ils permettent de localiser mais jamais de certifier des bords.
- **Détection de texte ou de crédits par IA** : les VOSTFR ont des sous-titres incrustés, donc du texte en permanence. C'est reporté, et ce ne sera rouvert que si la mesure montre des erreurs que ce modèle corrigerait.
- **Position dans l'épisode et « 90 s »** : ce sont des indices, jamais des portes. La v1 a eu trois bugs sur la position.

## Mesure

Chaque lot est scoré contre la vérité relevée par Luc. On calcule :
- la précision des cases servies (les deux bords à ±1 s près) ;
- la **borne haute de Wilson à 95 % du taux d'erreur** ;
- la couverture.

AniSkip est scoré sur les mêmes cases. Avec 0 erreur sur 100 cases, on ne peut garantir que moins de 3 % d'erreur ; pour garantir moins de 1 %, il faut environ 300 cases.

**Critère pour remplacer AniSkip** : sur le holdout, mesuré une seule fois, la borne haute du taux d'erreur doit être sous 1 %, **et** meilleure qu'AniSkip.

## Arborescence

| Dossier | Rôle |
| --- | --- |
| `fetch/`, `bridge/` | Couche de téléchargement **copiée de la v1** : résolution des lecteurs, cache HLS/MP4, décodage ffmpeg. `fetch/probe.py` sert de test de fumée. |
| `refs/animethemes.py` | Récupère les références par MAL id, et met en cache les réponses d'API et les médias. |
| `fp/chroma.py` | Empreinte Chromaprint via ffmpeg. |
| `match/ber.py` | Matrice de bits différents, apparitions, mesures de continuité. |
| `decide.py` | Servir ou s'abstenir, par lecteur. |
| `run.py` | Lot : liste d'animés → JSONL par épisode et par lecteur. |
| `match/audio_edges.py` | Calage à l'échantillon et queue muette. |
| `match/image.py` | Comparaison d'images (milieu d'épisode, ou `--images`). |
| `eval/regress.py` | Non-régression de la décision, hors ligne, sur les empreintes en cache. |
| `eval/publish.py` | Fusion d'une relance, planches, `cells.js` de la page de relevé. |
| `eval/edge_strips.py`, `eval/sheet.py` | Planches d'images autour des bornes, pour relire. |
| `lot.py`, `lot.ps1` | Lot catalogue et son superviseur (voir « Lot catalogue »). |
| `archive.py` | Son de chaque générique entendu, gardé sans perte sur le disque d'archive. |
| `eval/status.py` | État du lot, registre, bilan d'un palier. |
| `eval/replay.py` | Rejeu des décisions et des bornes hors ligne, depuis l'archive. |
| `eval/sentinels.py` | Sentinelles de qualité et épisodes témoins du lot. |

## Lancer

À lancer depuis ce dossier, car les caches sont relatifs.

```
python -m fetch.probe ../opening-detector/datasets/anime.gt10.json 16498 1 vostfr
python run.py --anime-list out/all.list.json --out out/lot.jsonl [--hosts megaplay] [--images]
python -m eval.regress out/all.tail.jsonl --against out/regress.json
python -m eval.publish out/all.tail.jsonl out/all.list.json --merge out/relance.jsonl
```

`run.py` reprend un fichier de sortie existant : le supprimer pour recalculer. Après tout changement de `decide.py`, `eval.regress` doit rester à zéro écart, ou chaque écart doit être voulu.

`OPED_HLS_CACHE` réutilise les segments déjà téléchargés par la v1 (clé stable, sans jeton).

## Lot catalogue (03/10/2026)

Tout le catalogue (1 824 animés, 45 366 épisodes-langues), par popularité, sur plusieurs jours. Conçu pour que rien n'oblige à le refaire.

```
powershell -ExecutionPolicy Bypass -File lot.ps1 [-Limit 20] [-RetryErrors]   # lancer ou reprendre
python -m eval.status                      # où en est le lot
python -m eval.status --palier 20          # bilan des 20 premiers animés
python -m eval.replay --only 16049         # rejouer un animé hors ligne et comparer au lot
```

Arrêter proprement : créer `out/catalogue.stop`. Reprendre : relancer `lot.ps1`. Plafonner le débit : écrire un nombre de Mo/s dans `out/debit.txt` (relu toutes les 30 s).

**Ce qui est gardé, par lecteur-épisode**

| Quoi | Où | Sert à |
| --- | --- | --- |
| Résultat, une ligne par épisode-langue, en ajout seul | `out/catalogue/<mal>.jsonl` | La dernière ligne d'un épisode fait foi. Chaque ligne porte la version, le commit et la date. |
| Empreinte de l'épisode | `cache/ep/*.npz` | Rejouer la décision. |
| Son de chaque candidat, de 20 s avant à 20 s après la référence, FLAC 16 bits 11 kHz | `H:\oped-archive\<mal>\` | Rejouer les bornes. Le lot calcule ses bornes **sur ce fichier**, donc le rejeu rend les mêmes. |
| Audio des références | `H:\oped-archiveefsudio\` | Rejeu (déplacé là quand l'animé est fini). |
| Niveaux de la queue de chaque générique | champ `env` de la ligne | Régler la règle du silence de fin sans rouvrir le son. |

Sauvegarde des résultats, du registre et des empreintes sur `D:\oped-backup` et `H:\oped-backup` à chaque animé terminé. Les segments téléchargés vivent sur `D:\oped-tmp` et sont supprimés dès que le lecteur-épisode est écrit.

**Ce qui est téléchargé.** Le lecteur le moins cher passe en premier (`lot.GUIDE_ORDER` : frembed a une piste son à part, ~18 Mo par épisode) en tête + fin (10 min + 7 min) ; il dit aux autres où écouter, et eux ne lisent que 30 s de part et d'autre de chaque thème qu'il a entendu. Un lecteur qui n'y retrouve pas un type attendu repasse en tête + fin, puis en entier s'il n'a toujours pas d'OP (`run._detect_host`, champ `timing.niveau`). ansembed ne propose parfois que du 1080p à 8 Mb/s : sans ce guidage, le catalogue ferait plus de 15 To.

**Pannes.** Une panne reste `detect_error`, jamais « pas de générique ». Deux essais sur le champ, puis deux passes de reprise en fin d'animé, puis `-RetryErrors`. Dix épisodes d'affilée en panne sur un lecteur : ce lecteur est mis en pause 30 min, 1 h, 2 h ; les autres continuent.

**CDN de Vidmoly (ansembed, vidmoly-va).** Il lâche les connexions nouvelles dès qu'on en ouvre trop, alors qu'une connexion gardée ouverte débite 10 Mo/s. Les connexions sont réutilisées, deux au plus pour toute la famille (`fetch/hls_cache.py`).

**Nos quotas.** Aucun appel à aniscroll.com. Le pont de résolution lit les pages des lecteurs en direct au lieu de passer par le Worker Cloudflare (`OPED_DIRECT`, `bridge/resolve.mjs`) ; un repli sur le Worker est plafonné à 5 000 appels par jour et compté dans l'état.

**Sentinelles** (pause du lot, code de sortie 3) : désaccord entre deux lecteurs qui servent le même fichier ; chute de la part d'épisodes avec générique d'un lecteur par rapport au palier 1 ; hausse des bornes non calées à l'échantillon ; trois épisodes témoins de Railgun S refaits toutes les 2 h (`out/temoins.json`).

**Changer une règle après le lot** : modifier `decide.py` ou `match/audio_edges.py`, puis `python -m eval.replay --write out/rejeu`. Aucun téléchargement. Sans changement de code, le rejeu rend les bornes du lot à l'identique (contrôlé sur Railgun S : 120 sur 120 au millième).

## P1 : est-ce une fausse bonne idée ? (29/09/2026)

**Échantillon** : 17 épisodes VOSTFR tirés de gt10, avec un lecteur par épisode (scripts `spike/p1.py` et `spike/p1b.py`, retirés le 02/10/2026 : voir l'historique git).
- 7 épisodes 2 « propres ».
- 10 pièges connus d'après les verdicts de la v3 : chanson utilisée comme musique de scène, OP utilisé comme générique de fin, ED posé sur l'épilogue, ED spécial.

Chaque épisode est comparé à **toutes** les références de sa série.

**Audio : couverture de la référence à décalage fixe.**

| Apparition | Couverture | Trous > 1 s | Médiane (bits différents /32) |
| --- | --: | --: | --: |
| Vrais génériques (14/14) | 0,99 – 1,00 | 0 | 0 – 4 |
| Chanson en musique de scène / sous dialogues (8) | 0,21 – 0,72 | 4 – 14 | 5 – 13 |
| Alignements parasites (refrain répété, autre thème) | ≤ 0,45 | – | ≥ 11 |

Il n'y a aucun recouvrement : l'écart entre le pire vrai (0,99) et le meilleur faux (0,72) est large. La dérive est nulle partout (0 ou 1 trame).

**Image : même temps relatif que la vidéo de référence.** La référence est décodée à sa cadence native ; à 2 images/s, les plans rapides faisaient chuter les vrais génériques jusqu'à 0,44.

| Cas audio-complet | Images concordantes |
| --- | --: |
| Vrais génériques (19) | 0,89 – 1,00 (médiane ≥ 0,99) |
| Même chanson, autres images : OP de Cyberpunk ep1 en générique de fin, ED1v3 testé sur un épisode ordinaire, ED1 testé sur l'ep28 de Frieren | 0,00 – 0,02 |

**Verdict : GO**, sous réserve de la taille de l'échantillon (17 épisodes, étiquetés par les verdicts de Claude et non par Luc). Les seuils de départ sont les suivants :
- couverture ≥ 0,95 ;
- aucun trou > 1 s ;
- images ≥ 0,80 (seuil retiré de la décision le 02/10/2026, gardé comme information).

La marge de chaque côté des seuils est large.

**À noter pour P2** : l'empreinte Chromaprint couvre environ 2,7 s de moins que le fichier de référence. La fin se calcule donc avec la durée du fichier, pas avec celle de l'empreinte.

## Lot gt10 (29/09/2026, 3e passe)

64 épisodes, 256 couples lecteur-épisode, VOSTFR et VF, `out/gt10.jsonl`.

| Contrôle | Résultat |
| --- | --- |
| Cellules jugées justes (v1 trouvée + verdict Claude ou Luc), lecteur par lecteur, bords à ±1,5 s | **322/322** (erreur ≤ 1,2 % à 95 %) |
| AniSkip sur les mêmes cellules | 179/317 (56 % ; 70 % à ±5 s) |
| « Pas un générique » (chanson en musique de scène) | 18/18 rejetés |
| Erreurs SERVIES par la v1 (décalages de 7 à 21 s) | 5/5 corrigées |
| Contradictions entre lecteurs du même fichier (> 1 s) | 3, toutes sur JJK ep24 megaplay (+1,5 s, à trancher) |
| Pannes de transport | 0 après second essai |

**Ce n'est pas encore une mesure de précision.** Ces cellules viennent de ce que la v1 avait trouvé, et c'est Claude qui les a jugées. La vérité se construit sur la page « Relevé OP/ED v2 » (https://claude.ai/artifact/WVk2AsiQcHKa8bkq3WD9Sv) : 260 cases, dont 74 abstentions, où « Il en manque un » mesure ce que la v2 laisse passer.

**Corrections apportées pendant le lot** (historique : les bornes ne se calent plus sur les images, voir « Règles de décision et de bornes »)

- **Fin** = dernière image qui concorde, à la cadence native. Les clips NCBD ont 0 à 4,6 s de silence ou de noir en queue.
- **Fenêtre vidéo** demandée 12 s plus tôt, puis filtrée par horodatage : la recherche HLS d'ansembed atterrissait environ 4 s trop tard.
- **Cartons de crédits** : deux images quasi unies de même luminance concordent, quel que soit leur texte.
- **Décalage image/son** : on cherche le meilleur à ±3 s. Chez frembed, Railgun ep1 a ses images 2 s après la chanson ; le début est alors calé sur les images.
- **Le recul du début sur un plan fixe a été retiré.** Il reculait à tort de 2,5 à 4 s.

**Faiblesses connues**

- **Lenteur** : environ 1,5 min par épisode, car chaque épisode est téléchargé en entier sur chaque lecteur. Pistes :
  - ne lire en entier qu'un lecteur par groupe de fichiers identiques ;
  - chercher d'abord dans les 6 premières et 6 dernières minutes.
- **Chanson complète posée sur d'autres images** (OP rejoué sur des crédits déroulants, ED sur l'épilogue) : la v2 s'abstenait toujours ; depuis le 02/10/2026 elle sert au son (choix de Luc). Deux garde-fous : au milieu de l'épisode (début après 8 min et fin à plus de 5 min de la fin), les images du générique restent exigées (`milieu_episode`) ; et si le son de l'épisode recouvre le début de la chanson, le début servi attend que la chanson soit seule (`mixed_head`). Pour distinguer les deux, il faudrait savoir reconnaître des crédits. C'est la seule place d'un éventuel modèle de texte.
- **Abstentions sur les derniers épisodes** quand les crédits passent sur des scènes dialoguées. C'est voulu.

## Questions ouvertes pour Luc (29/09/2026)

Tranchées depuis : le début est la première note ; la fin suit le silence de l'épisode ; un OP joué en fin d'épisode garde l'étiquette de son thème ; Frieren ep28 est servi à partir du moment où la chanson est seule. Le texte d'origine est gardé ci-dessous.

- **Plan fixe avant la musique** (Railgun ep2 : nuages environ 2 s avant) : ce plan fait-il partie de l'OP ? Tes verdicts disent « début faux » sur ansembed et megaplay, mais « juste » sur frembed, avec le même décalage.
- **Fin de l'ED quand les crédits durent plus longtemps que la chanson** (derniers épisodes) : faut-il la placer à la fin de la chanson ou à la fin des crédits ?
- **OP joué en générique de fin** (ep1 de Cyberpunk, Kimetsu, Railgun) : faut-il le servir comme ED ? La v2 l'étiquette d'après sa place (fin d'épisode), pas d'après le nom du thème.
- **ED spécial référencé par AnimeThemes** : l'ep28 de Frieren a sa propre version, ED1v3, qui commence sur la dernière scène (Himmel), avant les crédits. L'audio et les images concordent à 100 % avec cette version. Faut-il la servir comme ED, ou s'abstenir parce qu'elle contient de l'histoire ?
