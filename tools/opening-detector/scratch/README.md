# scratch/ — scripts d'analyse jetables

Scripts one-shot écrits pour répondre à **une** question pendant une session
(mesurer un plafond, comparer deux sources, rejouer un cas…). Ils ne font pas
partie du pipeline et peuvent être cassés par une évolution de `oped/` sans que
ce soit un bug — le pipeline, lui, c'est `batch_detect.py`, `detect_anime.py`,
`season_pass.py` et `oped/` à la racine du dossier.

## Convention

- Ils s'ancrent sur la **racine de l'outil**, pas sur `scratch/` :
  `HERE = Path(__file__).resolve().parent.parent` (Python) /
  `const HERE = resolve(dirname(fileURLToPath(import.meta.url)), "..")` (Node).
  Donc `HERE / "out/…"`, `HERE / "cache/…"`, `HERE / "datasets/anime.X.json"`.
- Les imports `from oped…` exigent `sys.path.insert(0, str(HERE))` avant l'import,
  puisque `scratch/` n'est plus le dossier contenant le package.
- On les lance depuis la racine du repo :
  `python tools/opening-detector/scratch/_x.py`.

Les listes d'anime qu'ils consomment/produisent vivent dans [`../datasets/`](../datasets/).
