# Changelog

All notable changes to AniScroll appear here. Most recent first.

## [v0.0.8] — New watch page (2026-08-29)

### Added
- **New watch page**: full width, a player sized from your screen height, and
  the episode list beside it instead of empty space. Below, the full synopsis,
  the info page's numbers and a recommendations rail.
- **The full episode list while you watch**: three layouts (thumbnails, rows,
  number grid), search by title or number, reversible order, each episode's
  real runtime and a progress bar.
- **Next episode**: under the list, a countdown and the air date in your own
  timezone, with an **Add a reminder** button — the site's bell will flag the
  release next time you visit.
- **Servers ranked on how they perform for you**: startup, stalls, speed and
  quality are measured while you watch, on your device only, and the fastest
  ones move to the front.
- **Language preference order**: sub, dub, multi — set once, and the server you
  pick sticks to that show.

### Changed
- **Episodes that haven't aired leave the list**, along with the "next episode"
  button. They left empty tiles and dead links behind.
- **Sharper episode thumbnails**: when TMDB holds several images for an
  episode, the one its votes single out is used. The thumbnail and the player's
  still finally show the same frame.
- **Faster startup**: the video is requested before the rest of the page.
- **Watch-together** shares the column with the episode list instead of pushing
  it off screen.
- **A leaner site**: half the base JavaScript, a watch page 20% lighter, player
  thumbnails five times lighter.

### Fixed
- **Season numbering**: Jujutsu Kaisen listed two "Season 1", Attack on Titan
  two "Season 3", and My Hero Academia's final season carried the previous
  season's number.
- **Openings that fade from white**: an episode starting on a white fade showed
  a blank white page. The episode's still covers it now, as it does for black.
- **Ambient light** picks up the picture's colours again.
- **A hiccup no longer switches player under your eyes**, and a dead upload no
  longer hides a dub track that works.
- **Finishing an episode no longer marks the ones you skipped as watched.**
- **Intro and outro skipping** on shows that had none.

## [v0.0.7] — Hover preview, franchise graph & artwork (2026-08-16)

### Added
- **Hover preview**: point at any cover on the site and a card opens with the
  **trailer playing on its own**, sound, the synopsis, and the same ratings and
  numbers as the info page — plus a button to add the show to your AniList. An
  **ambient light** picks up the video's colours around the card in real time.
- **Preview settings**: hover preview can be turned on or off in the settings,
  with its own trigger delay.
- **Franchise graph**: the Relations section is now a real board, in fullscreen
  — illustrated cards you can drag, wheel zoom, search, and two filter menus by
  type and format. The **watch order is numbered**, bonus and side entries stay
  off the main thread, sub-series are boxed, and the source manga now appears on
  the board. Titles you have completed are circled in green.
- **Richer Artwork tab**: the whole fanart.tv library, plus TMDB visuals
  (banners, posters, logos), with duplicates removed.
- **New player**: Ansembed joins the available servers, and the voir-anime
  player moves to voembed.net.
- **Episodes split across two files** (Re:Zero ep. 1 dub) are stitched back
  together and played as a single episode.
- **Watched at the end credits**: a setting to count an episode as watched as
  soon as the ending starts, instead of waiting for the very end.
- **Clicking the player's timestamp** copies the timestamped link.
- **Volume readout** now appears as soon as you hover the icon.

### Changed
- **Intro / outro skipping on many more episodes**: a chain of fallbacks takes
  over when a player doesn't answer, multi-part episodes are handled, and a
  failed detection is retried instead of being final.
- **An even lighter site**: ~46 kB less JavaScript on every page, covers served
  at the right size in grids, several pages made static, info-page tabs loaded
  on click, and a navigation bar that no longer recomputes on every frame while
  you scroll.
- **Player thumbnails**: roughly 10x faster pre-caching, no more empty slots on
  the bar, and the hover preview finally follows the cursor.
- **Discover** now only offers shows that are currently airing.
- **Trailers blocked in your country** are hidden instead of showing a broken
  player.
- **Home banner**: its height follows the window, the show's official logo is
  displayed, and hovering the poster rail pauses the rotation.

### Fixed
- **Films and side entries miscounted**: a film in the middle of a chain, a
  re-adaptation mistaken for a recap movie, or a prequel no longer count as
  seasons.
- **Off-by-one numbering** on shows whose first season is a prequel.
- **Missing episode thumbnails**: the cached list ignored one of its sources
  for 30 days.
- **The sibnet player works again.**
- **Episodes wrongly reported as missing**: a player that is briefly
  unreachable doesn't prove the episode doesn't exist.
- **Unreadable navigation bar** on some banners.
- **The language no longer flips** for a split second while the page loads.
- **Next-episode countdown** resetting itself to zero.

## [v0.0.6] — Player controls, real episode thumbnails & speed (2026-08-03)

### Added
- **Configurable keyboard shortcuts**: assign any key to any player action from
  a visual keyboard — drag an action's icon onto the key you want. Grouped by
  Playback, Navigation, Skip, Audio, Speed and View, with a reset to defaults.
- **Video stats panel**: resolution, FPS, bitrate, connection speed, buffer
  health and dropped frames while you watch — plus a screenshot button and
  "copy link at this timestamp".
- **Next-episode button** in the player's control bar, next to play.
- **Fullscreen survives an episode change**: moving to the next episode no
  longer kicks you out of fullscreen.
- **Real per-episode thumbnails**: episode rows now show the actual frame from
  each episode instead of a repeated placeholder, and real episode titles on
  shows where AniList lists none (Chainsaw Man…).
- **Sources page**: a credits page in the footer listing the open databases and
  communities whose data powers the site.
- **New player**: uqload is available as an additional anime-sama server.

### Changed
- **A much faster site**: the pages and requests everyone shares — the watch
  page, the episode lists, source resolution — are now served from the CDN
  instead of being recomputed for every visitor. Pages open quicker and the
  site holds up far better under load.
- **More accurate intro / outro skipping**, on more players: detection was
  reworked per player, so the Skip Intro and Skip Outro buttons appear on more
  episodes and land on the right second.
- **Player notices** (hardcoded subtitles, chat) now appear as regular toasts,
  stacked in the corner, and work in fullscreen too.
- **Readable navigation bar on light artwork**: the bar switches to dark text
  when the banner behind it is light, instead of turning invisible.

### Fixed
- **Wrong episode titles on sequels**: seasons 2+ of some shows listed season
  1's episode titles (Attack on Titan, Demon Slayer, Jujutsu Kaisen).
- **Watch together**: autoplay now starts for everyone in the room, and
  resetting a room works again.
- **The home page and schedule no longer break** when the cache is briefly
  unavailable.
- **Servers that wrongly appeared unavailable**: a player that failed once for a
  temporary reason is no longer hidden as if it had no source.
- A player selected by hand no longer shows as unavailable the moment you click
  it.

## [v0.0.5] — Discover, info pages, seasons & players (2026-07-05)

### Added
- **Discover tab**: a full-screen, TikTok-style vertical feed to browse trending
  anime. Scroll up or down to move between cards.
- **Swipe to sort**: swipe a card right or left to add it to your AniList. By
  default, right = "Completed" and left = "Planning".
- **Swipe settings**: choose the status assigned to each direction from Watching,
  Rewatching, Completed, Planning, Paused and Dropped.
- **Undo**: scroll back to a card you already swiped to remove the action in one
  click (the AniList entry is deleted).
- **"For You"**: a personalised recommendation panel based on your AniList, with
  the reasoning behind each suggestion. Two modes (all / planning) and a button
  to generate fresh picks.
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
