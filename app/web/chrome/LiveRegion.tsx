import { useEffect, useRef } from 'react'

/**
 * The region that holds still (E5-0, #80) — Ryan's first criterion, as a component.
 *
 * ── The defect this exists to end ───────────────────────────────────────────────
 * He ruled the E4 drill off mid-run: *"a giant wall of changing text… I find myself
 * literally doing a find on the webpage looking for the button in question."* Nothing
 * mechanical was wrong. What was wrong is that every SSE event grew the page under the
 * line he was reading, so the thing he was looking at was never where he left it.
 *
 * A convention ("don't reflow") would be honoured differently by eight screens. A
 * primitive is honoured identically by all of them, and `held-still.ts` fails a test when
 * one is not.
 *
 * ── The guarantee, and how it is kept ───────────────────────────────────────────
 * **Every part of this region is a fixed box.** The heading, the latest-wins line, the
 * streamed prose and the log each declare a height in `chrome.css`, so the region's own
 * height is a sum of constants. Content arriving cannot change it, which means nothing
 * below it can move — that is the whole mechanism, and it is CSS rather than cleverness.
 *
 * Three shapes of update, three treatments, matching what a step actually emits
 * (`runner/step.ts`):
 *
 * - **`progress()` is latest-wins.** One line, replaced in place. The element is the same
 *   node across every update — React keeps it because it is the same element in the same
 *   position — and it is clipped rather than wrapped, so a long sentence cannot grow it.
 * - **`chunk()` is accumulating.** Chunks concatenate into one growing line inside a box
 *   that never grows: the text scrolls leftward within its own clip as it arrives, so the
 *   line always shows what the model is saying now.
 * - **Transitions arrive in space already reserved.** The log is a `height`, not a
 *   `max-height`. A max-height box grows from nothing up to its maximum as rows land,
 *   shoving everything under it the entire way — the scaffolding's exact defect, in a
 *   nicer font.
 *
 * ── Idle is a state, not an absence ─────────────────────────────────────────────
 * When nothing is running the region still renders and still occupies its box, dashed and
 * quiet. A region that appeared when a run started would move the page by existing, which
 * is the same failure arriving from the other direction.
 *
 * ── It holds no copy ────────────────────────────────────────────────────────────
 * `heading`, `latest` and every entry sentence are the server's — `EventRecord.summary`
 * is a machine-written sentence and this renders it. The browser writes none of them.
 */

/** One transition, as the log lists it. Both fields come off the event record. */
export interface LiveEntry {
  /** `event.seq` — monotonic, and the React key. Order by it, never by the timestamp. */
  seq: number
  /** The event's own sentence. Composed on the server; rendered, not written, here. */
  sentence: string
}

export interface LiveRegionProps {
  /**
   * Stable identity. The region keeps this across every update, for the life of the
   * screen — it is how `held-still.ts` finds the same region before and after, and how a
   * screen addresses one region among several.
   */
  id: string
  /** "Generating · holds image-api lock", or what an idle region calls itself. */
  heading: string
  /** The latest `progress()` line. Null renders an empty line that still holds its row. */
  latest: string | null
  /** Every `chunk()` so far, in order. Concatenated as the producer coalesced them. */
  stream: readonly string[]
  /** The transitions, oldest first. Omitted entirely when a screen wants no log. */
  entries?: readonly LiveEntry[]
  /** Nothing is running. The box stays; its colour goes quiet. */
  idle?: boolean
}

export function LiveRegion({
  id,
  heading,
  latest,
  stream,
  entries,
  idle = false,
}: LiveRegionProps) {
  const streamBox = useRef<HTMLParagraphElement>(null)
  const logBox = useRef<HTMLOListElement>(null)
  const text = stream.join('')

  /**
   * Keep the streamed line showing its newest end. The box is clipped, so without this
   * the line would freeze on the first few words and go dead while the model talked.
   * Scrolling INSIDE a fixed box moves nothing outside it — which is why this is safe to
   * do on every chunk and why the guarantee above is unaffected.
   */
  useEffect(() => {
    const box = streamBox.current
    if (box) box.scrollLeft = box.scrollWidth
  }, [text])

  /**
   * The same, downward, for the log: a new row lands at the bottom of a box that is
   * already the height it will stay, and the box scrolls to it.
   */
  const newest = entries?.at(-1)?.seq
  useEffect(() => {
    const box = logBox.current
    if (box) box.scrollTop = box.scrollHeight
  }, [newest])

  return (
    <section
      id={id}
      className={`live-region ${idle ? 'live-region--idle' : ''}`.trim()}
      aria-labelledby={`${id}-heading`}
    >
      <p className="live-region__heading" id={`${id}-heading`}>
        {heading}
      </p>
      {/*
       * Announced, because it is one short sentence that replaces itself — exactly what a
       * polite live region is for. `aria-atomic` so the whole line is read rather than the
       * words that changed.
       */}
      <p className="live-region__latest" aria-live="polite" aria-atomic="true">
        {latest}
      </p>
      {/*
       * NOT announced. Reading half-formed model prose aloud, a chunk at a time, would
       * make this screen unusable with a screen reader — invariant 4's spirit one layer
       * out: do not present a partial thing as a finished one.
       */}
      <p className="live-region__stream" ref={streamBox} aria-live="off">
        {text}
      </p>
      {entries !== undefined && (
        <ol className="live-region__log" ref={logBox} aria-live="polite" aria-relevant="additions">
          {entries.map((entry) => (
            <li className="live-region__entry" key={entry.seq}>
              <span className="live-region__seq">{entry.seq}</span>
              {entry.sentence}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
