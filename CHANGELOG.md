# Changelog

All notable changes to AniScroll appear here. Most recent first.

## [v0.0.2] — Episode scores & sturdier players (2026-06-10)

✨ **New: per-episode Scores tab.** Every anime now has a **Scores** tab with a
colour-coded grid of community ratings for each episode (MyAnimeList, out of
10), laid out season by season so you can spot the best arcs at a glance. Open
it fullscreen to pan and zoom freely, and it adapts its layout to your screen
(portrait on mobile, landscape on desktop). The average shown is the mean of all
episode scores — distinct from the anime's overall rating.

🎬 **Players: right episodes, more of them.** We overhauled how seasons are
matched on anime-sama and voir-anime so multi-season shows no longer serve the
wrong season's episodes (e.g. a Season 2 quietly playing Season 1), and fixed a
matching bug that hid working voir-anime players for many popular series. Lots
more anime now have a playable VF/VOSTFR source.

### Added
- Per-episode **Scores** tab with a colour-coded season grid, fullscreen
  pan/zoom, and a responsive (portrait/landscape) layout.
- Auto-resume: your watch position is saved and restored across players and
  devices, and an episode auto-completes when you move to the next one.

### Changed
- The home recommendations no longer surface anime that haven't aired yet.
- The Episodes season picker now shows "Not yet released" for upcoming seasons
  instead of a bare format label.

### Fixed
- Multi-season shows now resolve the correct season on anime-sama / voir-anime
  (no more Season 2 playing Season 1).
- Restored missing voir-anime players for many series whose episodes live under
  a slightly different URL.
- Missing VF episodes for early One Piece, site icons in External Sites, the
  greeting translation, and the changelog appearing under the navbar.

## [v0.0.1] — Public Beta (2026-06-04)

👋 Welcome to AniScroll | a fast, clean place to watch anime, with no ads
and no tracking getting in your way. 🔗 Sign in with your AniList account to
sync your list and keep your watch progress across devices, or just dive
straight in.

🚧 This is our first public beta, so it's still rough around the edges. you'll
likely run into bugs, broken episodes or the odd glitch. If an episode won't
load or something looks off, hit the **report button**: pick what's wrong (won't
play, wrong subtitles, bad skip timings…) and it sends us the anime and episode
automatically so we can track the problem down and fix it fast. Your feedback is
what shapes the app from here. 🙏

🩷 Thank you for joining AniScroll during its early access. We're committed to
building a fast, reliable and ad-free streaming experience, and your support
helps make that possible.
