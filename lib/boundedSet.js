/**
 * Map.set with a size cap, for process-level memos. A Map keeps insertion
 * order, so re-inserting a key moves it to the back and the first key is the
 * least recently written: drop it once the cap is passed. On Vercel the
 * process dies young; on a long-lived Node server an unbounded memo is a leak.
 */
export function boundedSet(map, key, value, max) {
  map.delete(key);
  map.set(key, value);
  if (map.size > max) map.delete(map.keys().next().value);
}
