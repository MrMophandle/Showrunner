# The cockpit mockups

Eight static HTML screens, **all approved by Ryan** (Aug 3–4 2026). No build step,
no dependencies, not wired to anything. **E5 builds to these.**

```bash
cd mockups && python3 -m http.server 4499
# then open http://localhost:4499/floor.html
```

They cross-link, so you can walk the whole cockpit: floor → episode room → gate room
→ season map → arc page. Open `floor.html` first; it's the home screen.

## The screens

| Screen | File | Spec | Built by | Approved |
|---|---|---|---|---|
| The floor (home) | `floor.html` | 5.1 | E5 | Aug 3 |
| The episode room | `episode-room.html` | 5.2 | E5 | Aug 3 |
| The gate room | `gate-room.html` | 5.3 | E5 | Aug 3 |
| The canon library | `canon-library.html` | 5.4 | E5 (needs E2) | Aug 4 |
| The review desk | `review-desk.html` | 5.5 | E6 | Aug 3 |
| The screening room | `screening-room.html` | 5.6 | E6 | Aug 3 |
| The season map | `season-map.html` | 5.7 | E5 | Aug 4 |
| The arc page | `arc.html` | 5.8 (D24) | E5 (needs E2) | Aug 4 |

Mockup order was D16; the arc page was added later by D24.

## Mock content is deliberately consistent

Every screen shows the same fictional moment of *Dead Light* Season 1, so the set
reads as one system rather than eight unrelated pages. Keep this consistency if you
edit them — a contradiction between screens reads as a bug in the design.

- **ep03 "Hull Song"** — published.
- **ep04 "Signal Fade"** — assembled, waiting at its final gate (the screening room).
- **ep05 "The Quiet Deck"** — mid-assets, image run live holding `image-api`, TTS
  queued behind it, 7 stills waiting at the review desk.
- **ep06 "Cold Ledger"** — script gate, round 2, one red continuity finding.
- **ep07 "Meridian"** — outline not yet written; **vanilla** (touches no arc).
- **ep08 "Undertow"** — premise drafted, not greenlit; its outline button is blocked.
- Arcs: *the beacon* (at wp3), *Vessa ↔ Ferro · trust* (wp2), *Mara's ledger*
  (the hanging thread, cold since ep02), *Trent · the quiet mutiny*.

## What each screen is proving

Beyond layout, each screen demonstrates a ruled behavior. Preserve these when building:

- **Every button is a full sentence** — verb + object + scope + cost. No "Launch".
- **Blocked actions render disabled with the reason in words**, evaluated *before* the
  button renders — never a failure after launch.
- **Severity and confidence are always shown separately**, never collapsed into a
  checkmark. Image checks flag; they never rule.
- **One artifact, one ruling.** No batch verdicts anywhere.
- **Gates render their artifact** — readable script, viewable image, playable take.
- **Honest empty and in-flight states** at every stage.
- **Freshness is computed** and explained in words ("built from script v3; your
  scene-3 edit made v4").

## Ruled but NOT rendered

Design Ryan ruled in conversation that the mockups don't yet show. Build to these
anyway; they are as ruled as anything in the HTML.

**Screening room — the reject composer** (ruled Aug 3 2026). Pressing reject expands
the ruling bar in place (same pattern as the review desk, which *is* rendered and
interactive — press `X` there to see it). It is never a popup; the player stays on
screen. It contains:
- The timestamped notes already dropped during the watch, carried in automatically —
  each editable and removable in place. Clicking a note's timestamp jumps the playhead
  back to that moment.
- One optional **overall note** for the verdict-level thought that belongs to no
  timestamp. It rides the rejection as context for every reopened step but routes
  nowhere by itself; routing depth lives on the timestamped notes.
- A confirm button restating the whole consequence, e.g. "File the rejection — 3 notes
  routed: 1 take, 1 image, 1 scene rewrite → its 2 shots, 3 takes, remix · ~$0.62".
- `Esc` cancels with nothing filed; the notes stay held.

Two edge cases, both ruled:
- Rejecting with **zero** dropped notes makes the overall note **required** — a
  rejection must say why (4.7).
- **Approving** with unfiled notes warns first: "you have 3 unfiled notes — approve
  anyway and they're recorded as dismissed observations, not routed."

## Known scope of the mockups

They are HTML and CSS only. The review desk's reject composer has a little JavaScript
so the interaction can be felt; nothing else is interactive. There is no data layer,
no responsive design below ~800px, and no accessibility pass — all three are E5's job,
not the mockups'.
