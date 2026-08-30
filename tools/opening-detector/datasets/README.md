# datasets/ — listes d'anime en entrée des runs

Chaque fichier est un JSON de la forme attendue par
`batch_detect.py --anime-list datasets/<fichier>`. Ce sont des **entrées**, pas
des résultats : les résultats de run vont dans `../out/` (git-ignoré).

| Fichier | Rôle |
| --- | --- |
| `anime.test.json`, `anime.sample.json`, `anime.sample6.json`, `anime.cyberpunk.json`, `anime.cp-dc.json` | micro-lots de smoke test |
| `anime.bench.json` | lot de référence pour comparer deux versions du détecteur |
| `anime.full.json` | le catalogue complet exporté depuis la prod |
| `anime.gated.json` | `full` filtré par les gates (AnimeThemes-only, etc.) |
| `anime.hard.json`, `anime.hard2.json` | cas durs extraits d'un run précédent — **échantillon biaisé**, ne pas en tirer de taux de couverture globaux |
| `anime.audit*.json` | sous-lots d'audit manuel |
| `anime.retry.json`, `anime.seed.json` | générés par `../scratch/_build_retry_list.py` / `_build_seed_list.py` |
| `anime.top50.json`, `anime.top50.weights.json` | top 50 popularité, avec/sans pondération |
