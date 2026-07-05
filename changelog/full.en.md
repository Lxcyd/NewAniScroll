# Changelog

All notable changes to AniScroll appear here. Most recent first.

## [v0.0.6] — Discover & recommendations (2026-07-05)

### Added
- **Discover tab**: a full-screen, TikTok-style vertical feed to browse trending
  anime. Scroll up or down to move between cards.
- **Swipe to sort**: swipe a card right or left to add it to your AniList. By
  default, right = "Completed" and left = "Planning".
- **Swipe settings**: choose the status assigned to each direction from Watching,
  Rewatching, Completed, Planning, Paused and Dropped.
- **Undo**: scroll back to a card you already swiped to remove the action in one
  click (the AniList entry is deleted).
- **Info & Watch buttons**: on every card, open the info page or jump straight
  into playback.
- **"For You"**: a personalised recommendation panel based on your AniList, with
  the reasoning behind each suggestion. Two modes (all / planning) and a button
  to generate fresh picks.

## [v0.0.5] — Info pages, seasons & players (2026-07-03)

### Added
- **Movies, Compilations and Opening / Ending tabs** on an anime's page: instead
  of one long list, dedicated tabs that replace the episode list.
- **Opening / Ending**: browse and watch a show's openings and endings, grouped
  by season, with three views (detailed, compact, grid).
- **Compilations**: recap movies (arc summaries) are now separated from real
  movies, in their own section.
- **Relations map**: a pannable, zoomable overview of how a franchise's seasons,
  movies and spin-offs connect.
- **Half-star ratings**: rate an anime in half-points (8.5/10) when you finish
  its last episode.
- **Choose sync direction**: on sign-in, choose whether your AniList replaces
  your local list, or your site list is pushed to AniList — instead of a plain
  overwrite warning.

### Changed
- **Reworked season numbering**: a new multi-signal engine arbitrated by air
  dates fixes season order (no more Season 2 showing Season 1, or a remake
  ranked before the original). Verified franchises: Attack on Titan, Hunter x
  Hunter, Gundam, Jujutsu Kaisen, Demon Slayer…
- **Bonus movies sorted correctly**: side-story and prequel movies (e.g. Hunter
  x Hunter: Phantom Rouge, Jujutsu Kaisen 0) are no longer counted as seasons.
- **Faster episode list**: very long shows (One Piece, 1000+ episodes) now open
  instantly and scroll smoothly.
- **Reorganised episode view**: harmonised season / Movies / Opening-Ending
  tabs, an episode-count badge, and search and filters available everywhere.

### Fixed
- **Sturdier players**: the Megaplay player, which often failed in production
  even when the video existed, is fixed (requests routed to get past anti-bot
  protection).
- **More reliable autoplay**: the video starts on its own for more players, and
  turning on autoplay mid-way actually starts playback.
- **Multi-season on anime-sama**: long concatenated shows (Gintama…) finally
  play the correct season.
- The rating dialog no longer reappears by mistake when opening another anime.

## [v0.0.4] — Watch together (2026-06-26)

### Added
- **Watch together**: watch an episode in sync with friends. Create a room,
  share a 4-digit code or invite link, and everyone's playback stays in step.
- **Room chat**: live chat next to the player, with a full emoji picker and a
  set of anime stickers — searchable in English and French.
- **Host moderation**: the host can transfer host, mute a member, block a
  member's playback, lock the room (private), and kick or ban.
- **Episode sync**: changing episode, server or sub/dub follows everyone in the
  room automatically.
- **Fullscreen chat**: a toggleable chat overlay so you can keep talking while
  watching fullscreen.

## [v0.0.3] — Settings reimagined, themes & profile (2026-06-14)

### Added
- **Reworked Settings page**: a side menu that stays in view, with one section
  per topic so everything is easy to find.
- **Custom theme**: pick your accent colour, applied live across the whole app.
- **Reworked profile page**: banner, avatar and stats, with your list grouped
  by status like "My list".
- **Rate on finish**: a dialog offers to rate an anime when you finish its last
  episode (toggleable in settings).
- **Open on watch or info page**: choose whether clicking an anime opens its
  info page or jumps straight into playback — and it resumes at the episode you
  were on.
- **Hide spoilers**: blur episode thumbnails and hide episode titles and
  descriptions throughout the app.
- **Notification settings**: turn each kind of alert on or off (new episodes,
  sequels, resume reminders).
- **Sync threshold**: set how far into an episode counts as watched (80% by
  default).
- **Default server**: pick the player tried first.
- **Force maximum quality** and **start muted** in the player.
- **Share card**: sharing an anime now shows a rich preview (cover, title,
  score) on Discord and social.
- **Clear watch history** and **restore default settings** in a new Advanced
  section.

### Changed
- Deleting your local list now lives in Settings, behind a confirmation.
- Signing in and enabling sync now fully replaces the local list with your
  AniList list.
- Reworked watch history: search, date grouping and one-click resume.

## [v0.0.2] — Episode scores & sturdier players (2026-06-10)

### Added
- **Scores** tab: community ratings for every episode, colour-coded and laid
  out season by season (fullscreen pan/zoom, responsive).
- Auto-resume: watch position saved and restored across players and devices.

### Changed
- Home recommendations no longer show anime that haven't aired yet.
- The season picker shows "Not yet released" for upcoming seasons.

### Fixed
- Multi-season shows now play the correct season (no more Season 2 serving
  Season 1) on anime-sama / voir-anime.
- Restored missing voir-anime players for many series.
- Missing VF for early One Piece episodes, External Sites icons, the greeting
  translation, and the changelog appearing under the navbar.

### Removed
- The AnimeSaturn player was removed.

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
