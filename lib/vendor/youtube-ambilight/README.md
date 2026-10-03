# youtube-ambilight (vendored)

Le moteur de rendu de l'extension « Ambient light for YouTube » de Wessel Kroos,
https://github.com/WesselKroos/youtube-ambilight — licence MIT, voir `LICENSE`.

Copié **sans modification** au commit `2207e621d8dee43b6b91ea822111849ba00e72e3`
(`src/scripts/libs/`) :

- `projector-webgl.js`, `projector-2d.js`, `projector-shadow.js`
- `canvas-webgl.js`, `generic.js`

Remplacés par AniScroll (l'original dépend d'API d'extension ou de Sentry) :

- `sentry-reporter.js` — console au lieu de Sentry
- `storage.js` — localStorage au lieu de `chrome.storage`

Leur orchestrateur (`ambientlight.js`, lié au DOM de YouTube) n'est pas copié :
`components/watch/primary/ambilightEngine.ts` en reprend les calculs de tailles
et le cycle `resize` / `rescale` / `draw` pour notre lecteur.

Pour mettre à jour : retélécharger ces cinq fichiers à un nouveau commit, puis
vérifier que leurs imports pointent toujours vers `./sentry-reporter` et
`./storage`.
