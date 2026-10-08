/** The show key's grammar, in the one module both halves of the console can read.
 *
 *  This file exists for the reason `shared/types.ts` exists and obeys the same rule: **it imports
 *  nothing**, and in particular nothing from `node:`, because the client bundles it and a value
 *  import from a module that reads the filesystem would drag `node:fs` into the browser. The
 *  server's `server/registry.ts` re-exports `SHOW_KEY` from here, so every server importer keeps
 *  the one name it already had and the two halves cannot come to hold two regexes. */

/** What a show key may be: a leading letter or digit, then up to 63 more of letter, digit,
 *  underscore or hyphen.
 *
 *  The grammar is narrow because the key is the one string that reaches a URL path segment, a map
 *  lookup and a log line, and it is validated once — in the server's show middleware — for all of
 *  them (spec §4.4's fence). No dot, so a key can never be `.` or `..`; no slash, so it cannot
 *  become two segments; no leading hyphen or underscore, so a key cannot be read as a flag by
 *  anything that passes it on; and a bound of 64 characters, so a key cannot be the whole of a
 *  path length.
 *
 *  **The New-show form reads the same regex, and that is why this is not in `server/`.** The form
 *  says "that is not a key" while the key is being typed, which is a label and not a fence — the
 *  fence is the middleware's, and `registerShow` and `loadShows` apply it again. A third copy of
 *  the grammar in the page would be the copy that drifts, and the drift reads as a form that
 *  accepts a key the server then refuses, or warns about one it would have taken. */
export const SHOW_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
