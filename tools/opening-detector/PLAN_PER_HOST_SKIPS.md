# Plan — Per-host OP/ED storage + auto re-run + displayed-hosts-only

## Contexte / pourquoi

Aujourd'hui `oped_skips` stocke **une ligne réconciliée** par `(mal_id, episode, lang, kind)` :
l'OP est un **temps absolu unique** partagé par tous les lecteurs. Or on a mesuré que
l'OP est **spécifique à l'encode** — SnK ep1 : OP à `2:02` sur sibnet mais `2:19` sur
megaplay (17 s d'écart, encodes de durées différentes). Un temps unique est donc
incorrect pour au moins un lecteur. L'ED est déjà réprojeté via `from_end_*`, mais pas l'OP.

La demande :
1. **Stocker le résultat par lecteur** (chaque encode a son propre OP/ED).
2. **Re-passer automatiquement** sur un lecteur quand on en **ajoute** un ou qu'on **corrige**
   un bug qui le remet (ex : le fix de-PNG megaplay d'aujourd'hui) — sans re-tout-refaire.
3. **La DB ne contient QUE les lecteurs affichés à l'utilisateur** (aucune ligne pour un
   host qui n'apparaît pas dans le sélecteur de `lib/servers.js`).

## Modèle de données

### Nouvelle table `oped_host_skips` (une ligne par lecteur/épisode/langue)
PK = `(mal_id, episode, lang, host)`. La ligne existe **dès que le host a été traité**,
même sans hit (colonnes OP/ED nullables) — c'est ce qui distingue « traité, rien trouvé »
de « pas encore traité ».

```
mal_id, episode, lang, host,
op_start, op_end,                         -- null si pas d'OP sur cet encode
ed_start, ed_end, ed_from_end_start, ed_from_end_end,
duration,                                 -- durée de CET encode (réprojection ED)
op_votes, ed_votes, source, confirmed_by_video,
algo_version,                             -- version de l'algo/host au moment du run
serve,                                    -- gate par-host (voir plus bas)
updated_at
```

`oped_skips` (réconcilié) reste comme **fallback** rétro-compatible (API inchangée par défaut).

### Registre canonique des hosts ↔ serveurs affichés
Source de vérité = `lib/servers.js`. Les serveurs dont `source ∈ {animesama, voiranime, megaplay}`
mappent 1:1 vers un host détecteur, via `(host, lang)` :

| host détecteur | lang | serveur app |
|---|---|---|
| megaplay | vostfr | `megaplay` (multi) |
| sibnet | vostfr/vf | `animesama-sibnet-vo` / `animesama-sibnet` |
| sendvid | vostfr/vf | `animesama-sendvid-vo` / `animesama-sendvid` |
| vidmoly | vostfr/vf | `animesama-vidmoly-vo` / `animesama-vidmoly` |
| vidmoly-va | vostfr/vf | `voiranime-vidmoly-vo` / `voiranime-vidmoly` |
| uqload | vostfr/vf | `animesama-uqload-vo` / `animesama-uqload` |

→ **Allowlist affichée = {megaplay, sibnet, sendvid, vidmoly, vidmoly-va, uqload}**.
Le détecteur (`MULTI_HOSTS`) est actuellement **{sibnet, sendvid, megaplay, vidmoly, vidmoly-va}** :
il **manque `uqload`** (qui EST affiché). On l'ajoute pour que « détecté » = « affiché ».

### Fichier partagé `tools/opening-detector/host_versions.json`
```json
{ "sibnet": 1, "sendvid": 1, "megaplay": 2, "vidmoly": 1, "vidmoly-va": 1, "uqload": 1 }
```
- **Ajouter un host** = nouvelle clé.
- **Corriger un host** = incrémenter sa version (megaplay est déjà à **2** après le fix de-PNG).
Lu par le batch Python ET les scripts Node → une seule source de vérité.

## Flux

### 1. Détection (batch) — ne refait que le nécessaire
- `scripts/export-oped-coverage.mjs` : dump depuis `oped_host_skips` un
  `coverage.json` = `{ "<mal>:<lang>": { host: algo_version_traité } }`.
- `batch_detect.py --coverage coverage.json` : pour chaque anime, hosts à (re)faire =
  ceux **absents** OU dont `version_traitée < host_versions.json`. Les autres sont sautés.
  → un host ajouté ou une version bumpée déclenche un re-run **ciblé** sur ce seul host.
- Sortie JSONL **par host** : `{ mal_id, episode, lang, host, algo_version, op:{…}|null, ed:{…}|null }`.
  (`detect_anime.py`/`multi_host.py` calculent déjà le per-host — on l'émet tel quel au lieu du réconcilié.)

### 2. Import — garde la DB propre
- `scripts/import-oped-host-skips.mjs` :
  - **Rejette** toute ligne dont `host ∉ allowlist affichée` (garde-fou dur).
  - Upsert des lignes par host avec `algo_version`.
  - **Purge** : `DELETE FROM oped_host_skips WHERE host NOT IN (allowlist)` — enlever un
    serveur de `lib/servers.js` nettoie automatiquement ses lignes.
  - Recalcule aussi la ligne réconciliée `oped_skips` (consensus sur les hosts détectés) pour
    le fallback.

### 3. Serve — l'app utilise le bon encode
- `/api/v2/skip/{malId}/{episode}?server=<id>` : si `server` fourni, on mappe `server→(host,lang)`
  et on renvoie la ligne **de ce host** (OP absolu correct pour son encode ; ED réprojeté via
  `from_end` sur la durée réelle du `<video>`). Sans `server`, fallback sur le réconcilié actuel.
- Client : `SkipOverlay`/`prefetchSkips` passent l'`activeServer`. Rétro-compatible (param optionnel).

## Fichiers touchés
- **Nouveau** : `lib/hostRegistry.(js|ts)` (map host↔server + allowlist, dérivé de `lib/servers.js`),
  `tools/opening-detector/host_versions.json`, `tools/opening-detector/oped/host_registry.py`,
  `lib/db/opedHostSkips.ts`, `scripts/import-oped-host-skips.mjs`, `scripts/export-oped-coverage.mjs`.
- **Modifiés** : `tools/opening-detector/oped/adapter_aniscroll.py` (+uqload),
  `tools/opening-detector/batch_detect.py` (resume par version + emit per-host),
  `pages/api/v2/skip/[malId]/[episode].ts` (param `server`), `lib/skip/prefetchSkips.ts`,
  `components/watch/primary/SkipOverlay.tsx`.

## Ordre d'exécution
1. Registre partagé host↔server + allowlist + `host_versions.json` (+ uqload au détecteur).
2. Table + module `oped_host_skips` (get/upsert/purge).
3. Importer per-host (allowlist + purge) + recompute réconcilié.
4. Export coverage + resume-par-version dans `batch_detect.py`.
5. Serve par-`server` + client. (Phase serve, activable une fois la DB peuplée.)

## Vérification
- Rejouer JJK ep1 + SnK ep1 (les 2 hosts+ qu'on a) → `oped_host_skips` a une ligne par host
  affiché, OP par encode (SnK: sibnet 2:02, megaplay 2:19, chacun juste).
- Bump fictif d'une version dans `host_versions.json` → l'export coverage + batch ne repassent
  QUE ce host.
- Insérer une ligne d'un host non-affiché → l'import la rejette ; la purge la supprime.
- `?server=animesama-sibnet-vo` vs `?server=megaplay` renvoient des OP différents et corrects.
