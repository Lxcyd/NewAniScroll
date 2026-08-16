/**
 * AniList's trailer id, cleaned before anything is built from it.
 *
 * THE CASE THAT FORCED THIS, so nobody softens the check later: Attack on Titan
 * (AniList 16498) carries `"LHtdKWJdif4\t"` — a real YouTube id with a TAB
 * stapled to the end. Passed straight through, the embed loaded an id that does
 * not exist and sat in state -1 for ever: the card revealed a black rectangle on
 * its 4 s backstop, the trailer never played, and the same tab was quietly
 * poisoning `i.ytimg.com/vi/<id>/mq1.jpg` (the stills the glow and the black-bar
 * probe both read). One character in someone else's database, four broken things.
 *
 * TRIMMED AND THEN VALIDATED, rather than trimmed alone. A YouTube id is exactly
 * eleven characters of `[A-Za-z0-9_-]`; anything else is not an id we can play,
 * and the honest answer for it is "no trailer" — a card that keeps its artwork,
 * not a player parked on a black frame waiting for a video that will never load.
 * Whitespace is the fault seen in the wild; the shape test is what catches the
 * next one without needing to know what it looks like.
 */
export function youtubeTrailerId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}
