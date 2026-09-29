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
5. **Contrôle image** : un ED complet posé sur l'épilogue du dernier épisode a un audio parfait, et le sauter couperait l'histoire. L'audio donne l'alignement exact, donc l'image se compare au même temps relatif que la vidéo de référence.
6. **Décision** : servir, tronqué ou abstention, avec un code de raison. Les seuils sont calibrés sur des cas réels (phase P1), jamais raisonnés à la main.

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
| `spike/p1.py` | Porte GO/NO-GO : la continuité sépare-t-elle les vrais génériques des musiques reprises ? |

## Lancer

À lancer depuis ce dossier, car les caches sont relatifs.

```
python -m fetch.probe ../opening-detector/datasets/anime.gt10.json 16498 1 vostfr
OPED_HLS_CACHE=../opening-detector/cache/hls python -m spike.p1
```

`OPED_HLS_CACHE` réutilise les segments déjà téléchargés par la v1 (clé stable, sans jeton).

## P1 : est-ce une fausse bonne idée ? (29/09/2026)

**Échantillon** : 17 épisodes VOSTFR tirés de gt10, avec un lecteur par épisode (`spike/p1.py`, `spike/p1b.py`).
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
- images ≥ 0,80.

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

**Corrections apportées pendant le lot**

- **Fin** = dernière image qui concorde, à la cadence native. Les clips NCBD ont 0 à 4,6 s de silence ou de noir en queue.
- **Fenêtre vidéo** demandée 12 s plus tôt, puis filtrée par horodatage : la recherche HLS d'ansembed atterrissait environ 4 s trop tard.
- **Cartons de crédits** : deux images quasi unies de même luminance concordent, quel que soit leur texte.
- **Décalage image/son** : on cherche le meilleur à ±3 s. Chez frembed, Railgun ep1 a ses images 2 s après la chanson ; le début est alors calé sur les images.
- **Le recul du début sur un plan fixe a été retiré.** Il reculait à tort de 2,5 à 4 s.

**Faiblesses connues**

- **Lenteur** : environ 1,5 min par épisode, car chaque épisode est téléchargé en entier sur chaque lecteur. Pistes :
  - ne lire en entier qu'un lecteur par groupe de fichiers identiques ;
  - chercher d'abord dans les 6 premières et 6 dernières minutes.
- **Chanson complète posée sur d'autres images** (OP rejoué sur des crédits déroulants, ED sur l'épilogue) : la v2 s'abstient toujours. Pour distinguer les deux, il faudrait savoir reconnaître des crédits. C'est la seule place d'un éventuel modèle de texte.
- **Abstentions sur les derniers épisodes** quand les crédits passent sur des scènes dialoguées. C'est voulu.

## Questions ouvertes pour Luc

- **Plan fixe avant la musique** (Railgun ep2 : nuages environ 2 s avant) : ce plan fait-il partie de l'OP ? Tes verdicts disent « début faux » sur ansembed et megaplay, mais « juste » sur frembed, avec le même décalage.
- **Fin de l'ED quand les crédits durent plus longtemps que la chanson** (derniers épisodes) : faut-il la placer à la fin de la chanson ou à la fin des crédits ?
- **OP joué en générique de fin** (ep1 de Cyberpunk, Kimetsu, Railgun) : faut-il le servir comme ED ? La v2 l'étiquette d'après sa place (fin d'épisode), pas d'après le nom du thème.
- **ED spécial référencé par AnimeThemes** : l'ep28 de Frieren a sa propre version, ED1v3, qui commence sur la dernière scène (Himmel), avant les crédits. L'audio et les images concordent à 100 % avec cette version. Faut-il la servir comme ED, ou s'abstenir parce qu'elle contient de l'histoire ?
