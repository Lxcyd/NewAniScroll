# Handoff: Anime Info Page

## Overview

A detailed info page for an anime title (used here: *Solo Leveling*), inspired by AniList / MyAnimeList. The page contains:

1. A sticky **top navigation bar** with logo, primary nav, search, notifications and avatar.
2. A **hero section** with a banner image, cover art, title art (logo image), inline stats, genre/studio chips, a "Watch Now" CTA, a list-status picker (Watching / Completed / …), favorite and share buttons.
3. A **tab bar** (Overview / Episodes / Characters / Artworks) with the **Overview** tab being the main subject of this handoff.
4. The Overview tab uses a **V12 layout**: a 320 px left sidebar containing **Details**, a scrollable **Tags** list and a scrollable **External Sites** list, beside a main column containing **Relations** (horizontal card row), a **Trailer** player, and a **Popularity** stats strip.
5. A **Recommendations** carousel below.

## About the Design Files

The files in this bundle are **design references created in HTML/JSX prototypes** — they show the intended look, layout and behavior. They are **not production code to copy directly**.

Your task is to **recreate these designs in the target codebase's existing environment** (React, Vue, SwiftUI, native, etc.), using its established patterns, design tokens and component library. If no environment exists yet, pick the most appropriate framework for the project and implement the designs there.

The prototype uses:
- React 18 (via UMD)
- Inline JSX transpiled in-browser by Babel Standalone
- Plain JS style objects (no CSS framework, no Tailwind, no styled-components)
- CSS variables defined in a `<style>` block in `Anime Info.html`

## Fidelity

**High-fidelity (hifi).** Pixel values, hex colors, font sizes, weights and spacings shown in the files are intended as the final values. Recreate pixel-perfectly using your codebase's existing libraries and patterns.

## Design Tokens

All colors and shared values live as CSS custom properties on `:root` in `Anime Info.html`. Lift these into your design system as tokens.

### Colors

| Token | Value | Usage |
|---|---|---|
| `--bg-0` | `#0a0b10` | App background |
| `--bg-1` | `#10121a` | Sidebar card surfaces |
| `--bg-2` | `#161924` | Default card surface |
| `--bg-3` | `#1d2030` | Inset / pill background |
| `--line` | `#252938` | Default border |
| `--line-2` | `#2f3447` | Stronger border, scrollbar thumb |
| `--txt-0` | `#f4f5f8` | Primary text |
| `--txt-1` | `#c4c8d4` | Body text |
| `--txt-2` | `#8a8fa3` | Secondary text |
| `--txt-3` | `#5e6478` | Muted / kicker text |
| `--accent` | `#ff3b5c` | Brand red |
| `--accent-2` | `#ff5c78` | Lighter red |
| `--accent-soft` | `rgba(255,59,92,0.12)` | Accent backgrounds |
| `--gold` | `#f6c544` | Ratings (stars) |
| `--blue` | `#4a8fff` | Info / studios |
| `--green` | `#2dd47a` | Success / completion |
| `--purple` | `#b07cff` | Novel/manhwa accent |

### Typography

Three Google Fonts:

- **Inter** — UI, weights 400 / 500 / 600 / 700 / 800. Default font.
- **Space Grotesk** — display numbers and the OTAKU.HUB logo, weights 500 / 600 / 700. `letter-spacing: -0.01em`. Applied via `.display` class.
- **JetBrains Mono** — kbd shortcuts, small tags, episode numbers, percentages. Applied via `.mono` class.

```html
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
```

Common sizes used in the design (no formal scale was defined — match what's in the files):

- Kicker labels (section titles): `11px / 700 / letter-spacing 0.14em / --txt-3`
- Body / synopsis: `14px / line-height 1.65 / --txt-1`
- Card body: `12.5px – 13.5px`
- Small badges: `10px – 11px`
- Display numbers (stats): `20px – 26px / Space Grotesk / 700`

### Spacing & radii

- Section gap: `28px` (vertical between major sections in Overview)
- Card padding: `16px` (Overview Details / scroll containers), `18px` (Sidebar component cards)
- Card radius: `12px` (most), `10px` (tag stat box), `9px` (site button), `8px` (small buttons), `7px` (chip), `999px` (pill chips)
- Border: `1px solid var(--line)` for most cards
- Box shadow used only on the hero cover and the "Watch Now" CTA — see hero.jsx for exact values

### Custom scrollbar

The scrollable Tags and External Sites containers in Overview use a custom 8px scrollbar. Definition in `Anime Info.html`:

```css
.custom-scroll::-webkit-scrollbar { width: 8px !important; display: block !important; }
.custom-scroll::-webkit-scrollbar-track { background: rgba(255,255,255,0.04) !important; border-radius: 4px; }
.custom-scroll::-webkit-scrollbar-thumb { background: var(--line-2) !important; border-radius: 4px; }
.custom-scroll::-webkit-scrollbar-thumb:hover { background: var(--txt-3) !important; }
.custom-scroll { scrollbar-width: thin !important; scrollbar-color: var(--line-2) rgba(255,255,255,0.04) !important; }
```

The page also defines a global scrollbar styled the same way.

The page-level `body { zoom: 0.75 }` is a prototype-only scaling trick to fit more on screen. **Drop this in your implementation** — your real app should render at 100% and rely on responsive sizing.

---

## Screens / Views

### 1. Top Bar (`topbar.jsx`)

Sticky bar (`position: sticky; top: 0; z-index: 50`), 60 px tall.

- Background: `rgba(10,11,16,0.85)` with `backdrop-filter: blur(16px)`. Bottom border: `1px solid var(--line)`.
- Padding: `0 28px`.
- **Left cluster** (gap 36 px):
  - **Logo**: hexagon SVG mark (22×22, stroke `#ff3b5c` 1.6, fill `rgba(255,59,92,0.12)`, central circle r=2.5 filled accent) + wordmark `OTAKU.HUB` in `.display` 16px/700, with the period in `var(--accent)`.
  - **Nav** (gap 4): `Home / Browse / Seasonal / My List / Schedule`. Each item: 8×12 px padding, 13.5px / 500. Active item: `--txt-0` color and a 4×4 accent dot 2 px below.
- **Right cluster** (gap 12):
  - **Search field**: 320 px wide, 8×12 padding, `--bg-2` bg, 8 px radius, magnifier icon left, `⌘K` kbd badge right (`--bg-3` bg, 4 px radius, 11px mono).
  - **Notification button**: 36×36, 8 px radius, bell icon, with 7×7 accent dot top-right.
  - **Avatar**: 36×36, 8 px radius, linear-gradient `135deg, #ff3b5c → #b07cff`, initials "HK" 12px/700 centered.

### 2. Hero (`hero.jsx`)

- **Banner**: 280 px tall, full-bleed `assets/banner.png` with `object-position: center 35%`. Vertical fade overlay from `rgba(10,11,16,0.15)` → `rgba(10,11,16,0.5)` → `--bg-0`.
- **Season pill** top-right (20 px from top, 28 px from right): "WINTER 2024 · S2 AIRING" with a 6×6 blue dot, `rgba(10,11,16,0.65)` bg + 10 px blur, `1px solid rgba(126,200,255,0.3)`, 999 radius, `#7ec8ff` text, 11px / 600 / `letter-spacing 0.08em`.
- **Content wrap** (max 1380 px, 28 px horizontal padding, `margin-top: -160px` so it overlaps the banner). 3-col grid: `240px | 1fr | auto`, column gap 32 px, `align-items: stretch`.
  - **Col 1** (cover stack, gap 14, `align-self: flex-start`):
    - Cover image 240 px wide, 12 px radius, `1px solid rgba(255,255,255,0.1)`, shadow `0 24px 60px rgba(0,0,0,0.7)`.
    - **Watch Now** button: full-width, gradient `135deg #ff3b5c → #e8294b`, 12 px radius, shadow `0 12px 30px -10px rgba(255,59,92,0.7), inset 0 1px 0 rgba(255,255,255,0.2)`. Inside: a 42×42 / radius 11 / `rgba(255,255,255,0.18)` play box, plus a label/episode stack: `WATCH NOW` 11px/700/`letter-spacing 0.14em` / opacity 0.9, then `S2 · EP 04` 15px/600.
  - **Col 2** (centered, `padding-top: 75`, `min-width: 0`):
    - `title-art.png` (max-height 300, drop-shadow `0 14px 36px rgba(0,0,0,0.7)`, `margin-top: -40`).
    - **Stats row** (gap 24, wraps): three stat blocks separated by 1×32 px `--line` dividers:
      1. ⭐ `8.61` (gold, 20px/700/Space Grotesk) `/10` (11.5px/--txt-2). Label `RATED #253` (10px/600/letter-spacing 0.1em/--txt-3).
      2. ❤ filled accent + `18,193` (20px/700). Label `FAVORITES · #73`.
      3. Film icon + `12 + 13` + `EP · 24min`. Label `S1 COMPLETE · S2 AIRING`.
    - **Chips row** (gap 8, wraps, centered):
      - Genre chips `Action`, `Adventure`, `Fantasy`, `Supernatural`: `rgba(255,59,92,0.12)` bg, `1px solid rgba(255,59,92,0.35)`, 999 radius, `#ff7a91` text, 5×11 padding, 12px/600.
      - 1×16 `--line-2` divider.
      - Studio chips `A-1 Pictures`, `Aniplex`: same shape but blue palette (`rgba(74,143,255,0.1)` bg / `0.3` border / `#7ec8ff`).
  - **Col 3** (`padding-top: 120`, `align-self: stretch`, `justify-content: center`):
    - **List-status picker** (min-width 320, padding-top 24):
      - Pill button (17×20 padding, 13 px radius). Background, border and text color all derived from the current list's color tint:
        - Watching `#22c55e`, Rewatching `#06b6d4`, Completed `#3b82f6`, Planning `#a855f7`, Paused `#f97316`, Dropped `#ef4444`.
        - Background = `<color>1a`, border = `1px solid <color>66`, text = `<color>`, 16px / 600.
        - 9×9 dot with `box-shadow: 0 0 6px <color>b3, 0 0 2px <color>` glow.
        - Down-chevron right.
      - On click, dropdown opens beneath (`top: calc(100% + 6px)`, `--bg-2` bg, 12 px radius, 6 px padding, 2 px gap, shadow `0 20px 40px rgba(0,0,0,0.5)`). Each item: 9×10 padding, 8 px radius, dot left, name, check icon right if selected. Selected item background = `<color>1a`.
    - Row (gap 10):
      - **Favorite** button 56×56 / radius 11. Inactive: `rgba(255,255,255,0.04)` bg / `--line-2` border / `--txt-1`. Active: `rgba(255,59,92,0.08)` bg / `rgba(255,59,92,0.3)` border / `--accent`, heart filled.
      - **Share** button (flex 1): 14×20 padding, radius 11, `rgba(255,255,255,0.04)` bg, `--line-2` border, share icon + "Share" 15px/600.

### 3. Tabs bar (`tabs.jsx`)

- Container: flex row, gap 4, bottom border `1px solid var(--line)`, 18 px margin-bottom.
- Each tab: 12×14 padding, 13.5px/600, `border-bottom: 2px solid` (transparent → accent), `transition: all 0.15s`, no wrap.
- Tab labels: `Overview`, `Episodes (25)`, `Characters (18)`, `Artworks (12)`.
- Active tab text: `--txt-0`. Inactive: `--txt-2`.
- Count pill next to label: `--bg-3` bg (or `--accent-soft` if active), 1×6 padding, 4 px radius, 10.5px/600, JetBrains Mono.

### 4. Overview tab (V12) — `tabs.jsx` → `<Overview>`

This is the main piece of this handoff.

#### Structure

```
<div overviewWrap, flex column gap 28>
  <Synopsis>
  <div grid 320px / 1fr, rows auto auto, columnGap 28, rowGap 18, items-stretch>
    Row 1 col 1: Details card
    Row 1 col 2: Relations
    Row 2 col 1: position:relative wrapper containing absolute fill flex-col gap 18
                 → Tags (flex:1, internal scroll)
                 → External Sites (flex:1, internal scroll)
    Row 2 col 2: flex column gap 28
                 → Trailer
                 → Popularity
  </div>
</div>
```

The `position: relative + absolute inset:0` trick on the sidebar's row-2 cell is critical: it lets row 2's height be determined by the **main** column (Trailer + Popularity), while the sidebar fills that height and scrolls internally. Without it the sidebar would push the row taller than the main column.

#### 4a. Synopsis

```
<section>
  <Kicker>SYNOPSIS</Kicker>
  <p style={synopsisText}>Body … <strong style={{color:'var(--txt-0)'}}>Seong Jin-U</strong> …</p>
  <div style={synopsisSrc}><em>Source: Crunchyroll</em></div>
</section>
```

- `synopsisText`: `14px / line-height 1.65 / --txt-1 / text-wrap: pretty`.
- `synopsisSrc`: `11px / --txt-3 / margin-top: 10 / italic`.

#### 4b. Details (sidebar, row 1)

- Wrapping `<section>` is `flex:1` with `min-height:0` and `padding-bottom:6` (the extra padding aligns its bottom precisely with the Relations cards which have a small scrollbar gutter).
- Kicker: `DETAILS`.
- Card container: `--bg-2` bg, `1px solid --line`, 12 px radius, 16 px padding. Inside: an `align-content: space-between` grid with `flex: 1` so rows distribute over the available height.
- Grid: 2 columns `auto 1fr`, `gap: 8px 16px`, font-size 12.5.
  - Key: `--txt-3`, 11.5px, `letter-spacing: 0.04em`.
  - Value: `--txt-1`, 500, `text-align: right`.
- Rows:
  - Format · TV Series
  - Status · Airing
  - Source · Web Novel
  - Aired · Jan 7 – Mar 31, 2024
  - Premiered · Winter 2024
  - Studios · A-1 Pictures
  - Producers · Aniplex
  - Rating · PG-13
  - Country · Japan / Korea

#### 4c. Relations (main, row 1) — `related.jsx`

A horizontal row of 5 cards with chevron connectors between them.

Nodes:

| Kind | Title | Meta | Color | Notes |
|---|---|---|---|---|
| NOVEL | Solo Leveling | Web Novel · 2016 | `#b07cff` | |
| MANHWA | Solo Leveling | Manhwa · 2018–21 | `#b07cff` | |
| S1 | Solo Leveling | Anime · 12 EP · ✓ | `#2dd47a` | |
| S2 | −Arise from the Shadow− | Anime · 13 EP · 4/13 | `#ff3b5c` | **current** |
| MOVIE | ReAwakening | Movie · 110 min | `#4a8fff` | |

Each card:
- Flex column, gap 8, `flex: 1 1 0`, `min-width: 150`, 10 px padding, 10 px radius, `1px solid`.
- For the current card: border = `<color>66`, bg = `linear-gradient(160deg, <color>14, var(--bg-2))`. Otherwise: `--line` border, `--bg-2` bg.
- **Cover**: aspect-ratio 3/4, 7 px radius, gradient backgrounds keyed by `cover` slug — see `related.jsx` for the exact gradients per node. Glyph text = the kind tag in `.display` 16px/700 / `rgba(255,255,255,0.85)`.
- Current node also shows an 8×8 accent dot top-right (8/8 inset) with a `box-shadow: 0 0 0 3px rgba(255,59,92,0.3)` halo.
- **Body**: small colored kind tag (9px/700/letter-spacing 0.08em, 2×6 padding, 4 px radius, color & border keyed to the node color with `14`/`44` suffixes), then title (12.5px/600, ellipsis), then meta (10.5px / `--txt-3`).
- **Connector**: between every pair, an 18 px wide div with a small right-chevron in `--txt-3`.

The row is `overflow-x: auto` (rarely used at 1280+ widths, but kept for safety).

#### 4d. Tags (sidebar, row 2 — top, scrollable)

- Section is `flex: 1; min-height: 0; display: flex; flex-direction: column`.
- Header row (flex, justify-between, margin-bottom 12):
  - `TAGS` kicker.
  - Spoiler toggle button (cursor pointer, 4×9 padding, 6 px radius, 10px/600/letter-spacing 0.06em, gap 6):
    - Off state: `--bg-2` bg, `--line` border, `--txt-2` text, eye-off icon, label `Show Spoilers`.
    - On state: `rgba(255,59,92,0.12)` bg, `rgba(255,59,92,0.4)` border, `--accent` text, eye icon, label `Hide Spoilers`.
- Scrollable card container: `--bg-2` / `--line` / 12 px radius / 16 px padding / `overflow-y: auto`, with class `custom-scroll` for the styled scrollbar. `flex:1, min-height:0`.
- Inside: flex column, gap 10.
- Each tag row: flex, align-items center, gap 10.
  - **Name** (12px): flex basis `0 0 145px`. Normal tags = `--txt-1`. Spoiler tags = `--accent` (just pink, no badge, no border, no background).
  - **Bar**: flex 1, height 6, `--bg-3` track, 3 px radius. Fill = `linear-gradient(90deg, --accent, #ff7a91)`, width = `<v>%`.
  - **Percent** (mono 10.5px / `--txt-2`): min-width 32, right-aligned.

When spoilers are off, the list is `TAGS_LONG`. When on, prepend `SPOILER_TAGS` (so they appear at the top of the list).

```js
const TAGS_LONG = [
  {t:'Dungeons', v:98}, {t:'Male Protagonist', v:92}, {t:'Urban Fantasy', v:90},
  {t:'Super Power', v:88}, {t:'Magic', v:85}, {t:'Cultivation', v:82},
  {t:'Survival', v:80}, {t:'Action', v:78}, {t:'Adventure', v:76},
  {t:'Gore', v:68}, {t:'Swordplay', v:62}, {t:'Anti-Hero', v:60},
  {t:'Alternate Universe', v:58}, {t:'Travel', v:48},
  {t:'Post-Apocalyptic', v:42}, {t:'Time Skip', v:38},
];
const SPOILER_TAGS = [
  {t:'Shadow Monarch', v:96, spoiler:true},
  {t:'Power-up Arc', v:88, spoiler:true},
  {t:'Time Manipulation', v:62, spoiler:true},
  {t:'Hidden Identity', v:54, spoiler:true},
];
```

#### 4e. External Sites (sidebar, row 2 — bottom, scrollable)

- Same outer wrapper as Tags (`flex: 1`, `min-height: 0`, flex column).
- Kicker `EXTERNAL SITES`.
- Same `custom-scroll` card container as Tags.
- Inside: single-column grid, gap 8.
- Each row is a `<button>` (full width, left border `3px solid <color>`):
  - 10×12 padding, `--bg-2` bg, `--line` border, 9 px radius.
  - Left: 32×32 logo box, 7 px radius, background = `<color>22`, color = `<color>`, 14px/700, with the site initial.
  - Name (13.5px/600/`--txt-0`).
  - Chevron right in `--txt-3`, `margin-left: auto`.

Sites (in order): MyAnimeList `#2e51a2` "M", AniList `#3577ff` "A", Official `#ff3b5c` "◆", X / Twitter `#1da1f2` "𝕏", Reddit `#ff4500` "r", Wikipedia `#a0a0a0` "W".

#### 4f. Trailer (main, row 2 — top)

- `aspect-ratio: 16/9`, 12 px radius, `1px solid --line`.
- Layered children:
  1. **Background**: `linear-gradient(135deg, #0a0a2a, #1a0a3a, #2a1a3a)`.
  2. **Overlay**: grid place-items center, `radial-gradient(circle at center, rgba(0,0,0,0.2), rgba(0,0,0,0.6))`.
  3. **Big play button**: 64×64, 32 radius, `rgba(255,59,92,0.95)` bg, shadow `0 12px 30px rgba(255,59,92,0.4)`. White play triangle 22px, `margin-left: 3`.
  4. **Info** absolute bottom-left (16, 16): kind `OFFICIAL TRAILER` (10px/700/letter-spacing 0.12em / `rgba(255,255,255,0.7)`), title `Solo Leveling Season 2 — Arise from the Shadow` (16px/600/white), meta `1:42 · Aniplex · 4.2M views` (11.5px / `rgba(255,255,255,0.6)`).

#### 4g. Popularity (main, row 2 — bottom)

- Kicker `POPULARITY`.
- Grid 4 columns, gap 10. Each stat box: 14×16 padding, `--bg-2` bg, `--line` border, 10 px radius.
  - Key label (10.5px / 600 / letter-spacing 0.1em / `--txt-3`).
  - Big value: `.display` 26px / 700 / letter-spacing -0.02em, colored per box.

| Key | Value | Color |
|---|---|---|
| Popularity | `#73` | `#ff7a91` |
| Rating | `#253` | `#f6c544` |
| Seasonal | `#1` | `#2dd47a` |
| Members | `482K` | `#7ec8ff` |

### 5. Other tabs (Episodes / Characters / Artworks)

These were prototyped earlier and are present in `tabs.jsx`. They share the same `--bg-2` / `--line` / 10–12 px radius card vocabulary as Overview. See the file for exact markup. The Overview tab is the focus of this handoff.

### 6. Recommendations carousel — bottom of page (`tabs.jsx` → `Recommendations`)

Rendered by `app.jsx` below the tabs container. Horizontal scroller (`scroll-snap-type: x mandatory`), one row, gap 14, `flex: 0 0 180px` per card. Each card = 3/4 cover with a green "% match" badge top-left and a 30×30 accent play button bottom-right, then title and `year · ⭐ score` meta.

Header row has the kicker + a bold "Because you're watching Solo Leveling" subtitle, with prev/next nav buttons that scroll the carousel by 520 px.

## Interactions & Behavior

- **List status picker** (hero): click pill → dropdown opens (`useState listOpen`). Click an item → updates `list` and closes the dropdown. The pill's color tint is keyed by the selected list.
- **Favorite** (hero): click toggles `fav`. Active = filled heart + accent border. Initial state in prototype = `true`.
- **Spoiler toggle** (Overview/Tags): click toggles `spoilers`. When `true`, spoiler tags are prepended to the tag list and rendered in `--accent`. Label switches between `Show Spoilers` / `Hide Spoilers` with eye / eye-off icons.
- **Tabs** (tab bar): click switches the active tab via `useState`.
- **Recommendations carousel**: prev/next buttons call `ref.current.scrollBy({ left: ±520, behavior: 'smooth' })`.
- **Hover**: a global `button:hover { filter: brightness(1.08) }` is applied in `app.jsx`. `button:disabled { cursor: not-allowed; opacity: 0.5 }`.
- **Sticky top bar**: `position: sticky; top: 0`.
- **All transitions** in the design use `0.15s` ease (default).

## State Management

Only local component state — no global store needed:

- `Hero`: `fav: boolean`, `list: string`, `listOpen: boolean`.
- `Tabs`: `tab: 'overview' | 'episodes' | 'characters' | 'artworks'`.
- `Overview`: `spoilers: boolean`.
- `Episodes`: `season: 'S1' | 'S2'`.

No data fetching is mocked — all data is inline. In a real app, replace the inline arrays (DETAILS, TAGS_LONG, SPOILER_TAGS, STATS_BOXES, SITES, RECS, etc.) with API responses.

## Assets

In `assets/`:

- `banner.png` — Hero banner (wide landscape).
- `cover.png` — Anime cover art (3/4 portrait).
- `title-art.png` — Stylized title logo image (transparent PNG, used in the hero center column).
- `solo-leveling-hero.png` — Alternative hero image (not used by the page; kept for reference).

In a real app, swap these with title-keyed assets from your media server / CDN.

Icons throughout are inline SVGs — no icon library is used. Copy them or replace with your codebase's icon system (Lucide, Heroicons, SF Symbols, etc.) — names indicated by their shapes (search, bell, chevron-down, chevron-right, play, star, heart, share, eye, eye-off, check, lock, …).

## Files

```
design_handoff_anime_info/
├── README.md                  ← this file
├── Anime Info.html            ← entry HTML (CSS variables, fonts, script tags)
├── components/
│   ├── app.jsx                ← root: Hero + Tabs + Recommendations
│   ├── topbar.jsx             ← sticky nav bar
│   ├── hero.jsx               ← banner + cover + title + stats + actions
│   ├── tabs.jsx               ← tab bar + Overview (V12) + Episodes/Characters/Artworks/Recs
│   ├── related.jsx            ← horizontal Relations row used inside Overview
│   └── sidebar.jsx            ← legacy sidebar (unused on the current page, kept for reference)
└── assets/
    ├── banner.png
    ├── cover.png
    └── title-art.png
```

To run the prototype locally without modification:

```bash
cd design_handoff_anime_info
python3 -m http.server 8000
# open http://localhost:8000/Anime%20Info.html
```

(The Babel-in-browser setup requires a real HTTP origin; opening the HTML via `file://` will not work because of CORS on the JSX files.)
