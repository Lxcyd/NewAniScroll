# Megaplay — à retester (établi le 2026-07-16)

## Le point en une phrase

Megaplay décodait normalement le matin du 16/07 et ne décodait plus le soir,
sur le **même CDN**, après qu'on l'a sondé très intensivement toute la journée.
Avant d'en conclure quoi que ce soit : **retester à froid**, c'est gratuit et ça
tranche.

## Ce qui est établi (vérifié, pas supposé)

Run cyberpunk du 16/07, 10 eps × 4 lecteurs, VO+VF :

- megaplay a **décodé en direct** les eps 2, 3, 5, 6, 7 en VOSTFR — pas depuis
  un cache : `find cache/ -iname "*megaplay*"` ne contient **aucun** fichier
  cyberpunk. Ces décodages ont bien eu lieu ce jour-là, sur `cdn.mewstream.buzz`.
- Les eps 4, 8, 9, 10 ont échoué (sonde retombée sur le fallback 1440.0, corrigé
  depuis — voir commit `a43cd83`).
- **En fin de journée, plus aucun épisode ne décode.** ffprobe ne voit qu'un
  stream `png/video`, zéro audio, sur les 10 épisodes.

État du flux tel que mesuré le soir du 16/07 :

- `master.m3u8` annonce pourtant `CODECS="avc1.640032,mp4a.40.2"` en 1920x1080 —
  l'audio EXISTE côté manifeste.
- Les segments (`/segment/<token>`, sans extension) commencent par un en-tête PNG
  authentique : `89 50 4e 47 0d 0a 1a 0a ... IHDR`. Ce n'est pas une extension
  trompeuse, c'est un vrai enrobage.
- Le playlist mélange des segments publicitaires tiers (`p16-ad-sg.ibyteimg.com`).
- Relever `-analyzeduration` / `-probesize` (testé jusqu'à 20M/50M) ne change
  **rien** — le conseil de ffmpeg est une fausse piste ici.

## Les deux hypothèses (on ne sait pas laquelle est vraie)

1. **On s'est fait rate-limiter / bloquer temporairement.** On a sondé megaplay
   des dizaines de fois dans la journée. L'enrobage PNG serait alors une réponse
   anti-abus servie à notre IP, pas l'état normal du service.
   → Le test de demain redécodera normalement.

2. **Megaplay a durci sa protection le 16/07.** Coïncidence de timing avec nos
   tests, mais possible.
   → Le test de demain échouera de la même façon.

L'hypothèse 1 est la plus probable (rien ne marchait plus *après* nos sondes, et
tout marchait *avant*), mais ce n'est qu'une inférence — d'où le test.

## Le test de demain

**Important : depuis une IP différente si possible** (partage de connexion
mobile, VPS…). Depuis la même IP, un blocage encore actif donnera le même échec
que l'hypothèse 2 et on ne pourra pas les distinguer.

```bash
cd tools/opening-detector
python - <<'PY'
import subprocess
from oped.adapter_aniscroll import resolve_episodes_multi
by_ep = resolve_episodes_multi('cyberpunk-edgerunners','saison1','vostfr',4,4,
                               mal_id=42310, va_slug='cyberpunk-edgerunners')
e = [x for x in by_ep[4] if x.get('host') == 'megaplay'][0]
cmd = ['ffprobe','-v','error','-headers',f"Referer: {e['referer']}\r\n",
       '-allowed_extensions','ALL','-allowed_segment_extensions','ALL',
       '-extension_picky','0',
       '-show_entries','stream=codec_type,codec_name','-of','csv=p=0', e['url']]
r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
print(r.stdout.strip() or '(aucun stream)')
PY
```

**Lecture du résultat :**

- `audio,aac` apparaît → **hypothèse 1**. C'était transitoire, il n'y a jamais rien
  eu à corriger. Relancer le run cyberpunk pour confirmer bout en bout.
- Toujours `png,video` seul, **depuis une autre IP** → **hypothèse 2**. C'est l'état
  normal du service : écarter megaplay explicitement du détecteur (comme le filtre
  VF existant dans `resolve_episodes_multi`), avec le motif écrit dans le code,
  plutôt que de le laisser échouer ~20 fois par anime sur le backfill.

## Ce qui n'est PAS une option

Défaire l'enrobage PNG, ou falsifier des en-têtes / une identité machine pour
paraître être un client autorisé. C'est un contournement de protection
anti-scraping. Si l'hypothèse 2 se confirme, la réponse est d'écarter megaplay,
pas de le forcer.

## Contexte : ça n'est pas bloquant

- sibnet / vidmoly / vidmoly-va couvrent **18/18** OP et ED en VO, spreads
  0.1–0.2s après le fix de la sonde. Le plancher de service demande 2 lecteurs
  d'accord — il y en a 3.
- megaplay est **déjà exclu d'office en VF** (pas de signal de langue dans son
  embed → risque de stream mal étiqueté). Le réparer ne servirait qu'en VO.
- Reste à mesurer : combien d'animes sont **megaplay-only** dans l'export
  (`export-oped-anime-list.mjs`, 33 719 panels) ? Si ~0, le sujet est clos.

## Aussi en attente

Le **fix Sibnet** (chip qui disparaît au clic — backoff 800/1600/3200ms + le
chemin du clic ne publie plus `absent`) est commité (`c7b8a31`) mais **validé par
le lint uniquement**. Il touche tout le site : à tester en vrai en cliquant un
chip Sibnet à froid.
