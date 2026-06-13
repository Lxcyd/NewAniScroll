# DEVLOG

Journal des modifs de dev, pour garder le contexte entre les sessions (survit aux `/clear`).
Ordre anti-chronologique (le plus récent en haut). Une entrée = une session/sujet, avec **décisions** et **leçons/pièges**, pas juste les commits (git les a déjà).

> Convention : dates absolues. Branche de travail = `dev` (push auto, voir mémoire). Le Worker Cloudflare se déploie **à la main** (`cd worker && npx wrangler deploy`) — un `git push` ne le déploie pas.

---

## 2026-06-13 — Lecteur : VidNest, fix Megaplay, warm-up du Worker

### Contexte
Parti de « ajouter le lecteur VidNest (vidnest.fun) », fini sur un fix Megaplay + une optimisation du cache Worker. Plusieurs allers-retours parce que mes mesures locales étaient trompeuses (voir Leçons).

### Décisions prises
1. **VidNest ajouté puis RETIRÉ.** VidNest est un agrégateur qui sert la **même source MegaCloud** (`cdn.mewstream.buzz`) que Megaplay : sur 12 titres testés, 9 renvoyaient le **m3u8 identique**. Quelques cas marginaux où VidNest avait plus de sous-titres (Dandadan : 43 vs 5) n'ont pas justifié un 2ᵉ chip qui sert le même flux. → retiré (extracteur + serveur + dispatch + preconnects).
2. **Megaplay corrigé** : il expose `/stream/mal/<malId>/` **et** `/stream/ani/<anilistId>/` (les deux vérifiés live). On essaie MAL d'abord, **fallback AniList** — ça récupère les titres sans MAL id mappé. Avant, un MAL id manquant → « no MAL id » et échec.
3. **Worker : pré-chauffe des playlists** (pas des segments). À chaque résolution m3u8, le Worker fait un `ctx.waitUntil` (non bloquant) qui fetch les playlists enfants (master → variantes, petits fichiers texte) pour les mettre dans `caches.default` sous la **même clé** que la requête du player. Supprime le pic de résolution du manifest sans concurrencer les segments.

### Leçons / pièges (IMPORTANT pour les futures sessions)
- ⚠️ **Mesurer la latence CDN depuis la machine locale MENT.** Le **même segment** a donné **73 000 ms en direct CDN vs 836 ms via le Worker prod**. La connexion locale (FR) → CDN `mewstream` est lente/erratique (0,3 s à 70+ s). **Seul juge fiable = le Worker déployé / le navigateur sur dev.aniscroll.com.** Ne pas conclure « c'est lent » sur des chiffres `localhost → Worker → CDN`.
- ⚠️ **1re version du warm = régression.** Elle warmait 2 niveaux (master → variante → **segments**), soit ~12 fetch multi-MB en parallèle → saturait l'I/O du Worker et **étranglait** la vraie requête du player sur les titres froids. Corrigé : **playlists only, depth 1, séquentiel**. Si on retouche le warm, ne JAMAIS warmer les segments binaires.
- Le **cache edge existait déjà** (`caches.default` côté Worker + `Cache-Control: s-maxage=86400, immutable`). 1er viewer paie le CDN, suivants → HIT ~300 ms. Vérifié `cf-cache-status: HIT`, `age` qui monte.
- Megaplay/VidNest tapent le même écosystème CDN : `cdn.mewstream.buzz`, `s1.streamzone1.site`, `s2.cinewave2.site`, sous-titres sur `*.lostproject.club`. **Tous exigent `Referer: https://megaplay.buzz/`** (vérifié : les autres referers → 403). C'est passé via `streams[].referer` → proxy `&referer=`.
- VidNest (si jamais on le réintègre) : API `https://new.vidnest.fun/hianime/anime/{anilistId}/{ep}/{sub|dub}` et `/anitaku/{id}/{ep}/{sub|dub}/hd-2`. Réponse `{encrypted, data}` où `data` = **Base64 à alphabet permuté** (`RB0fpH8ZEy…+/=`) → UTF-8 → JSON. Pas du vrai chiffrement. (Code retiré, mais l'algo est ici si besoin.)
- **Bug console bénin** : `AbortError: play() interrupted by pause()` au changement de serveur (course Vidstack/hls.js). Pas lié à la lenteur, pas corrigé.

### État déployé / à faire
- Branche `dev` : commits `0e559f8` (hover Watch&More) → `c293a70` (warm playlists).
- **Worker prod déployé** = version `d0548957` (warm playlists only). Code commité = `c293a70`, cohérent avec le déployé.
- ⏳ **À valider par l'utilisateur sur dev.aniscroll.com** (pas en local) : fluidité JJK + un titre moins populaire (Steins;Gate). Si encore lent EN PROD → c'est le CDN source sur ce titre, seule vraie option = changer de serveur/source pour ces titres (aucun cache ne sauve un CDN à 24 s/segment au 1er hit).

### Aussi fait cette session (sans rapport)
- **Anim hover « Watch & More »** restaurée sur la page info (desktop) : classe `.siteBtn` dans `components/anime/v2/styles.module.css` (translateX au hover + scale à l'active), portée depuis le `.platform-row` du projet de référence. Les styles inline ne permettant pas `:hover`. Commit `0e559f8`.

---

<!-- Modèle pour une nouvelle entrée :

## YYYY-MM-DD — Titre court

### Contexte
### Décisions prises
### Leçons / pièges
### État déployé / à faire
-->
