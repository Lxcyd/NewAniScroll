# anime-moments — reperage des plans marquants d'une saison

Trouve, dans un anime, les plans **visuellement singuliers**, et les decoupe en
boucles WebM + posters JPEG — le materiau des fonds animes.

Outil **hors-ligne** : il ne touche ni Redis ni Turso, ne tourne jamais sur le
chemin d'une requete, et ne consomme aucun quota de prod. Le calcul se fait une
fois, la sortie va en base, le site lit une ligne.

**Autonome.** Rien n'est importe de `tools/opening-detector` : cet outil doit
pouvoir evoluer et casser sans toucher au detecteur OP/ED, qui alimente la prod.
Il embarque son propre resolveur (`resolve.mjs`). La seule dependance partagee
est `lib/extractors.js`, la bibliotheque d'extraction de l'application elle-meme.

```
python find_moments.py --slug cyberpunk-edgerunners --season saison1 \
       --lang vostfr --start 1 --end 10 --top 10 --out out/cyberpunk.json

python extract_loops.py --in out/cyberpunk.json --out-dir out/loops
```

| fichier | role |
|---|---|
| `resolve.mjs` | slug anime-sama -> URLs de flux directes |
| `find_moments.py` | echantillonne, classe, ecrit le JSON des moments |
| `extract_loops.py` | decoupe les boucles WebM + posters JPEG |

Dependances : `numpy`, et `ffmpeg`/`ffprobe` dans le PATH.

---

## Le critere : la singularite, pas le rythme

**Premiere version, abandonnee : la densite de coupes.** On comptait les
changements de plan (`scdet`) et on classait par densite. Ca marche pour trouver
les fusillades — et ca rate structurellement tout le reste.

Preuve mesuree le 27/08/2026, Cyberpunk saison 1 : le classement par coupes ne
contenait **pas** la scene de la Lune (ep10, 24:09), la plus connue de la serie.
Elle est faite de plans longs et tenus ; sur le seul critere mesure, elle etait
en bas du tableau. La densite de coupes mesure le **rythme de montage**, pas
l'importance.

**Version actuelle : l'ecart de palette.** Ce qui rend un plan memorable, c'est
qu'il ne ressemble a rien d'autre dans son episode. On caracterise chaque image
cle par sa palette — moyenne et ecart-type RVB, saturation, luminance — et on
classe par ecart **robuste** a la mediane de l'episode.

Sur le meme lot, la Lune prend **3 places du top 10**. Verifie a l'image, pas au
chiffre : les frames sorties ont ete ouvertes et regardees une par une.

| | densite de coupes | palette |
|---|---|---|
| mesure | le rythme | la singularite |
| trouve la Lune | non | **oui, 3 fois** |
| decode | toutes les frames | une image cle en 64x36 |
| saison de 10 episodes | 6 min 16 s | 11 min 06 s |

C'est le meme principe que `pick_landmarks` dans le detecteur OP/ED : **ce qui
est rare est ce qui compte**. Une frame banale ne se relocalise pas, et ne marque
pas non plus.

### Mediane, pas moyenne

Le score est un ecart a la **mediane**, normalise par la MAD. Avec une moyenne et
un ecart-type, un plan tres atypique tirerait la statistique vers lui et se
masquerait lui-meme.

### L'etendue de la scene

Un instant ne fait pas une boucle. On elargit autour du pic **tant que les images
voisines restent atypiques** (55 % du score du pic). Trois moments du lot Cyberpunk
depassent ainsi 9 s — dont la Lune, a 14,5 s.

Quand le plan singulier est isole entre deux images cles, l'etendue vaut zero : on
retombe alors sur une fenetre fixe de 8 s centree, plafonnee a 15 s.

**Limite connue** : l'echantillonnage ne prend que les images cles, espacees
d'environ 4 s. Les bornes sont donc justes a ±4 s pres. Les affiner demanderait un
redecodage fin autour des seuls moments retenus — quelques secondes par clip, pas
fait ici.

---

## Le format de sortie : WebM + poster, jamais de GIF

Mesure sur le meme plan de Cyberpunk :

| format | poids |
|---|---|
| WebM VP9, 1280x720, **14,5 s** | **591 Ko** |
| GIF, 640 px, **5 s** | 5 281 Ko |

Dix fois plus lourd, pour deux fois moins de definition et trois fois moins de
duree. Le GIF plafonne a 256 couleurs : sur du neon et des degrades il rend une
bouillie.

Le poster JPEG separe s'affiche pendant le chargement de la boucle — sans lui, un
fond animé montre un cadre vide au premier affichage. Il est pris au **milieu** du
clip : le premier cadre est souvent une transition, qui ne represente pas la scene.

---

## ⚠️ Vidmoly ne passe PAS par `getExtractor`

`lib/extractors.js` extrait la famille Vidmoly (vidmoly.\*, ansembed.net,
voembed.net) **via le Worker Cloudflare**, deliberement : le jeton du
`master.m3u8` se lie alors au Worker, ce qui est juste pour le NAVIGATEUR, dont
les segments transitent par ce meme Worker.

Pour un outil hors-ligne c'est exactement faux — ffmpeg tire depuis la machine
locale, et un jeton lie au Worker donne un **403 sur chaque segment**.
`resolve.mjs` fait donc l'extraction Vidmoly **en local**.

Signature a reconnaitre si ca ressurgit, lisible dans l'URL rendue :

| | ASN dans l'URL | master.m3u8 |
|---|---|---|
| via le Worker | `asn=132892` (Cloudflare) | **403** |
| extraction locale | `asn=15557` (FAI) | **200** |

Le detecteur OP/ED est tombe dans le meme piege avant nous ; son
`bridge/resolve.mjs` porte le meme avertissement.

## Les hotes

`--host ansembed` par defaut. **sibnet renvoie 403 des le 3e flux parallele** —
mesure le 27/08 : cinq episodes sur dix perdus a la premiere passe. Il fonctionne
parfaitement en lecture unitaire, mais ne supporte pas la charge.

`--workers 3` est le maximum raisonnable. Au-dela, les hotes limitent et on perd
plus en reessais qu'on ne gagne en parallelisme.

---

## Trois pieges d'outillage, tous rencontres

Chacun a produit un echec **silencieux**, qui ressemblait a un resultat legitime.

- **`-nostdin` est obligatoire.** Lance depuis une boucle qui lit un fichier,
  ffmpeg herite du flux d'entree, le prend pour des touches clavier et sort en
  deux secondes — avec un **code de succes** et une sortie vide. Signature : dix
  episodes a zero resultat en quinze secondes.
- **`-loglevel info`, jamais `error`, quand on lit `showinfo`.** Le filtre ecrit
  au niveau info : `-v error` supprime exactement ce qu'on veut recuperer.
- **Rediriger stderr vers un fichier, pas vers le pipe d'analyse.** Sans ca, un
  `403 Forbidden` de l'hote disparait dans le `grep` et l'echec ressemble a « cet
  episode n'a aucun moment ».

---

## Ce qui n'existe pas ailleurs

Verifie le 27/08/2026, deux recherches et cinq API interrogees :

| source | ce qu'elle a |
|---|---|
| trace.moe | image -> timecode. **Sens unique**, aucune enumeration |
| SkipDB | OP/ED crowdsources — **rien sur les 10 episodes de Cyberpunk** |
| anilay | OP/ED, 1 titre sur 6 peuple, a la seconde entiere |
| Anime Skip / AniSkip / IntroDB | OP/ED uniquement |

**Aucune base de « moments marquants » n'existe.** Il faudrait avoir decode tous
les animes pour la publier ; le seul qui l'ait fait (trace.moe) n'expose que la
recherche par image. D'ou cet outil.

Note utile : **trace.moe reste le bon outil dans l'autre sens**. Si tu pars d'une
capture trouvee ailleurs, il rend anime + episode + timecode a la seconde, sans
rien telecharger — 100 requetes/jour, sans cle.
