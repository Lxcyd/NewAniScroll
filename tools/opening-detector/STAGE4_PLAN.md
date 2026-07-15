# Stage 4 — Réécriture de `detect_op_ed` (image credited = autorité)

Plan de conception, à valider avant d'écrire du code prod.
Base : ROADMAP_FRAME_ACCURATE.txt §4. Stage 3 clos (commit c24c55b) :
`theme_t0` frame-accurate par consensus de landmarks natifs.

---

## 0. Ce qui existe aujourd'hui (à remplacer)

`detect_op_ed` (theme_bank.py) est une **cascade d'heuristiques** empilées au fil
des bugs. Par (hôte, kind) elle enchaîne :

1. `_match_best_version` → hit **audio** (projection `theme_t0..theme_t0+ref_dur`).
2. `_window_clipped` + fallback fenêtre élargie / épisode entier.
3. `_video_sourced_hit(CREDITED_ALIGN_MIN_VOTES)` → override crédité éventuel,
   gardé par `CREDITED_OVERRIDE_AGREE_BAND_S` vs l'audio "fort" (`_is_strong`).
4. sinon si audio faible/absent → `_video_sourced_hit` (NC, GOP-level).
5. `_apply_video` (confirme + étend les fondus, gardes `VIDEO_EDGE_*`).
6. raffinage : `_refine_credited_dense` (dense image) OU `_refine_hit` (RMS audio),
   `sharpen_audio_with_credited` + `DENSE_AUDIO_SHARPEN_BAND_S`.

Le tout repose sur des fenêtres `-sseof` relatives → `_abs_offset` +
`resolve_window_duration` pour rattraper l'overshoot du seek (bug megaplay).

**Problèmes** : ~8 constantes de garde qui se contredisent (vidmoly-va +15s venait
de la sélection "fenêtre au fill" + override audio) ; timeline relative fragile ;
le crédité n'est PAS l'autorité, il "override si d'accord". La fondation Stage 1-3
(horloge absolue + landmarks consensus) rend tout ça inutile.

---

## 1. Cible : un pipeline unique par (hôte, kind)

```
A. LOCATE  (audio grossier, ABSOLU)
   decode_audio_abs(fenêtre large absolue) → best_match vs refs audio
   → theme_t0 GROSSIER + VERSION (OP1 vs OP2) + ref crédité choisie
   Fallback image-coarse si audio absent (VF ducking / cold-open muet).

B. ALIGN   (landmarks natifs, ABSOLU)
   keyframe_hashes_abs(fenêtre native autour de theme_t0, fps=None)
   → anchor_by_landmarks(ep_vfp, ref.landmarks) → theme_t0 PRÉCIS (absolu)
   confiance = consensus_frac (Stage 3).

C. BORDS
   start = theme_t0
   end   = theme_t0 + ref_dur      (ref_dur = frames_natifs/fps du clip crédité)
   refine "end" optionnel pour ED TRIMÉS (garde-fou : rester proche de l'end).

D. LIVRER
   ThemeHit.start/end en secondes ABSOLUES. ED : from_end = ep_dur - t.
   confiance : n_accepted, consensus_frac (remplace votes/score comme gate image).
```

Clé : **l'audio ne fait plus que localiser+choisir la version**. La géométrie du
bord vient de l'image crédité (landmarks + ref_dur). Plus d'override, plus de
bandes d'accord, plus de `_abs_offset`.

---

## 2. Changements de signature (resolvers en ABSOLU)

`detect_op_ed` prend désormais des resolvers **absolus** (fournis par
detect_anime, qui connaît la durée probée) :

```python
detect_op_ed(
    episode_duration,
    op_refs, ed_refs,
    resolve_audio_abs   = (start_abs, dur) -> (Fingerprint, abs_start),
    resolve_video_abs   = (start_abs, dur, fps) -> VideoFingerprint,   # pts absolus
    # ref crédité déjà portée par ThemeReference (.landmarks, .ref_native_dur)
    op_search=(0.0, 300.0),          # fenêtre de LOCATE audio, absolue (début)
    ed_search=("from_end", 240.0),   # LOCATE audio, N s avant la fin
    refine_trimmed_ed=True,
)
```

**Supprimés** : `resolve_window`, `resolve_window_duration`, `resolve_video`,
`resolve_video_dense`, `op_window/ed_window` (relatifs), `_abs_offset`,
`_window_span`, `_window_clipped` (remplacé par : LOCATE sur fenêtre large →
ALIGN natif ciblé, pas de straddle possible), `min_score`, tous les
`*_OVERRIDE_*` / `*_SHARPEN_*` / `VIDEO_EDGE_*` / `CREDITED_ALIGN_MIN_VOTES`.

**Gardés** : `min_votes` (audio LOCATE), `full_fallback` (rebaptisé : élargir la
fenêtre de LOCATE si l'audio ne matche pas dans la fenêtre par défaut).

---

## 3. `ThemeReference` / `build_references` — câbler les landmarks NATIFS

⚠ **Loose end Stage 3.** Aujourd'hui `build_references` fait
`extract_keyframe_hashes(url_credited)` à **2fps** puis `pick_landmarks(vfp)` →
r_time quantifiés à 0,5 s → biais systématique sur toute projection.

FIX : décoder la ref crédité en **natif** pour les landmarks + `ref_native_dur` :
```python
vref = keyframe_hashes_abs(video_ref_url, 0.0, None, fps=None)  # natif, clip entier
landmarks = pick_landmarks(vref)             # r_time frame-exacts
ref_native_dur = float(vref.times.max())     # 89.972 s pour JJK ED1 (pas 89.5)
```
Cache : nouveau `.vfp.npz` natif (clé distincte, ex. `+cred.native`), pour ne pas
écraser le cache 2fps. `ThemeReference` gagne `ref_native_dur: float`.
(La `duration` audio reste pour le fill audio ; `ref_native_dur` sert au bord C.)

---

## 4. Impact cache (rebuild accepté par le user, ROADMAP §5)

- Fenêtres absolues → clés host-spécifiques (le start absolu varie par durée).
  Les anciens `.w-180.0_` / `.w0.0_240.0` deviennent obsolètes (non lus, non
  supprimés).
- Refs : nouveau cache natif landmarks (`+cred.native.vfp.npz`) en plus de
  l'existant. Refs audio `.fp.npz` inchangées (pas de réinvalidation).

---

## 5. Câblage appelants

**detect_anime.run_single_host** : remplacer les 5 closures relatives par 2
closures absolues :
```python
def resolve_audio_abs(start_abs, dur):
    samples, abs_start = decode_audio_abs(url, start_abs, dur, referer=ref)
    return fingerprint(samples), abs_start          # + cache clé (start_abs,dur)
def resolve_video_abs(start_abs, dur, fps):
    return keyframe_hashes_abs(url, start_abs, dur, fps=fps, referer=ref)
```
Retirer `resolve_window_duration` (plus de `-sseof`, plus d'overshoot à corriger).

**multi_host.detect_per_host / detect_op_ed_multi** : mêmes resolvers `_for` en
absolu. `reconcile_hits` devient un **contrôle de confiance** (spread/agree entre
hôtes) et NON une correction — chaque hôte est déjà frame-accurate en absolu.
`from_end` + `canonical_duration` conservés pour la re-projection runtime.

**Sortie** : `ThemeHit` garde `start/end/kind/slug/version` + champs de confiance
(`n_accepted`, `consensus_frac` au lieu de `votes/score` côté image). ⚠ Vérifier
les consommateurs de `votes/score/source/edge_*_source` (detect_anime print,
diag_*, batch_detect "spread", importeur DB) avant de retirer des champs — plutôt
les DEPRÉCIER (garder, valeurs par défaut) que casser.

---

## 6. Bord "end" pour ED trimés (C, refine optionnel)

Cas : un hôte coupe l'ED avant la fin du clip crédité (le +ref_dur dépasse le
vrai cut). `refine_edge_credited_video(edge_kind="end")` existe déjà mais
renvoyait None (bug Stage 3 non élucidé). À déboguer ici : vérifier fenêtres ref
& épisode natives + `ref_native_dur`. Garde-fou : n'accepter le nouveau end que
s'il est ANTÉRIEUR au +ref_dur et à < ~2 s (sinon garder +ref_dur).

---

## 7. Validation E2E (ROADMAP §5, données réelles)

```
python detect_anime.py --multi-host --langs vostfr,vf --start 3 --end 3 \
    --mal 40748 --va-slug jujutsu-kaisen
```
Attendus :
- megaplay ED ~21:15 (pas 21:10) ; vidmoly-va OP 3:11 (pas 3:28) ; trio inchangé.
- Métrique = `consensus_frac` PAR HÔTE (≥ ~0.6, tous landmarks à ±1 frame),
  PAS l'accord cross-host.
- Repères terrain JJK ED : carton cyan ~21:12 ; coupe じゅじゅさんぽ ~22:44.9.
- Non-régression SnK S1 (OP long cold-open) — le LOCATE audio doit élargir la
  fenêtre et trouver l'OP après le cold-open ~2 min.

---

## 8. Ordre d'exécution (incrémental, testable à chaque pas)

1. ✅ **Refs natifs** (§3, commit 84f185a) — `ThemeReference.ref_native_dur` +
   landmarks natifs dans `build_references`. Validé : JJK ED1 19 landmarks natifs,
   ref_native_dur=89.972.
2. ✅ **`detect_op_ed_v2`** (§1-2, commit 79c091b) en PARALLÈLE de l'ancien.
   Validé A/B sur JJK ep3 (proto_v2_ab.py) :
     OP1 credited img 76-94% : megaplay 3:12.12, sibnet 3:11.98, vidmoly 3:12.11
     ED1 credited : 21:15.11..22:45.09 (sibnet 21:14.96..22:44.93) vs GT 21:15/22:44.9
   Bug trouvé & corrigé : décodes natifs concurrents rate-limités par
   animethemes.moe → 0 frame caché en dur → OP toujours en fallback audio. Fix :
   `_native_ref_ok` (ne cache jamais un décode dégénéré) + `_decode_native_ref`
   (retry borné + LOCK sérialisant les décodes natifs lourds).
3. **→ PROCHAIN : Câbler run_single_host** (§5) sur detect_op_ed_v2 (resolvers
   absolus), valider single-host JJK + SnK (cold-open long : OP_SEARCH=300s
   doit couvrir ; sinon élargir).
4. **Câbler multi_host** (§5), valider E2E (§7).
5. **Supprimer** l'ancienne cascade + constantes mortes une fois le nouveau validé.

Risque principal : régresser le trio validé. Mitigation : l'ancien chemin reste en
place jusqu'à la bascule finale (étape 5).
```
