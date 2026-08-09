# scripts/ — outils hors-app

Tous ces scripts se lancent **depuis la racine du repo** (ils lisent `.env.local`
et écrivent dans `scripts/out/`, chemins relatifs au cwd) :

```bash
node scripts/<dossier>/<script>.mjs
node --env-file=.env.local scripts/oped/import-oped-skips.mjs …
```

| Dossier | Contenu |
| --- | --- |
| `cache/` | remplissage et purge des caches Redis/Upstash + ingestion Fribb : `refresh-cache`, `warm-cache`, `warm-images`, `purge-season-cache`, `refresh-fribb` |
| `fanarts/` | pipeline fanarts (récupération, classification WD14, migrations DB) |
| `oped/` | export/import des timings OP/ED entre le détecteur et Turso ; `lib/opedPlausibility.mjs` = garde-fous partagés |
| `player-map/` | table `player_map` Turso : seed, vérification, purge, réparation |
| `audit/` | audits ponctuels et repros de bugs (lecteurs, panneaux de langue, hydratation, visiteurs) |
| `gen/` | générateurs d'assets statiques (stickers, mots-clés emoji) |
| `out/` | sorties de run — **git-ignoré**, rien à conserver ici |

Lancés par la CI (`.github/workflows/`) : `cache/refresh-cache`, `cache/refresh-fribb`,
`cache/warm-cache`, `cache/warm-images`, `fanarts/refresh-fanarts`,
`fanarts/classify-fanarts`, `fanarts/download-wd14-model`. Déplacer l'un d'eux
impose de mettre à jour le workflow correspondant.
