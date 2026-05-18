# Changelog

All notable changes to AniScroll appear here. Most recent first.

The format follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
- **Changelog button** in the navbar so users can see what changed without
  diving into git history.
- **Admin** entry in the profile dropdown for users matching the
  `ADMIN_USERNAMES` env var (comma-separated list).
- **Admin dashboard refresh** with real Turso stats (anime / fanart counts),
  user analytics, manual scrape tools, and IP ban management.
- **Metadata page** in admin with bulk-refresh + per-anime editor.

### Changed
- AniList outage now falls back to Turso for the homepage carousels instead
  of returning empty data.
- Navbar layout is unified across every page (symmetric padding, centered
  search bar, no per-page variations).

### Fixed
- Subtitle font-size now scales with the player in fullscreen (Plyr-style
  CSS pattern, no JS observers).
- Background toggle for subtitles actually removes the blur + fill (was
  leaking `backdrop-filter: blur(8px)` from Vidstack defaults).
- Autoplay no longer fights Chrome's mitigation when unmuting — defaults
  to muted, relies on the browser's Media Engagement Index for eventual
  unmuted promotion.

## [2026-05-12] — Rebrand

### Changed
- Renamed Moopa → **AniScroll** across the UI (titles, meta tags, manifest,
  email contact, footer, navbar, OG images).
- Replaced favicon and OG images with the new torii logo.

### Removed
- Footer GitHub / Donate / Ko-fi / language switch buttons.

## [2026-05-09] — Player overhaul

### Added
- YouTube-ambilight-style projector stack for the ambient lights effect.
- Live thumbnail hover preview on the scrubber (HLS + MP4 sources).
- Chromecast button via the Google Cast SDK.

### Fixed
- Subtitle menu no longer clipped to the player bounds; renders above the
  controls with the same animation as the Settings menu.

## [Earlier]

History before this point lives in [git log](https://github.com/).
