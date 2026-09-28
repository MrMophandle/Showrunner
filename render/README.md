# `render/` — the Remotion project

This is the engine's renderer: a single Remotion composition, `Episode`, that turns one episode's
staged stills and mixed audio into a video file. It is part of the engine, not of any show.

**The render project contains no show literal.** Everything a show decides about how an episode
looks — the frame rate, the frame size, the crossfade length, and the title card's words, font and
colours — reaches this project through `timeline.json` and nothing else. Changing shows means
changing `showrunner.json` in the show repository; nothing under `render/src` moves.

## The one file it reads

`scripts/build-timeline.py` writes `Production/<episode>/video/timeline.json` in the show
repository from the show's `showrunner.json`, then stages a copy of it — together with the
episode's stills and its mixed WAV — into `render/public/<episode>/`. Remotion serves static
files only from `public/`, so the staging step is what makes the episode visible to the render.

`render/src/timeline.ts` is the boundary. `parseTimeline` validates the file and returns it typed,
throwing on the first field that is missing or of the wrong type, named by its dotted path
(`timeline.json: title.text is missing`). Everything downstream of that call is typed and needs no
further checking, and a malformed timeline fails in the first seconds rather than hours into a
render.

| Timeline key | Written from (show config) | Read by |
|---|---|---|
| `fps` | `video.fps` | `Root.tsx` → `calculateMetadata` |
| `durationInFrames` | the mix's length plus `audio.tailOutSeconds` | `Root.tsx` → `calculateMetadata` |
| `width`, `height` | `visual.shotFrame` | `Root.tsx` → `calculateMetadata` |
| `crossfadeFrames` | `video.crossfadeSeconds` | `Episode.tsx` → each shot's fade |
| `audio` | the staged mix's path under `public/<episode>/` | `Episode.tsx` → `<Audio>` |
| `shots[]` | the episode's shot list | `Episode.tsx` → one Ken Burns sequence each |
| `title.from`, `.durationInFrames` | the episode's own title-card gap | `Episode.tsx` → the card's sequence |
| `title.fadeFrames` | `video.titleCard.fadeSeconds` | `Episode.tsx` → the card's fade-out |
| `title.text`, `.fontFamily` | `video.titleCard.text`, `.fontFamily` | `Episode.tsx` → the card's type |
| `title.colors.background`, `.type`, `.glow` | `video.titleCard.colors` | `Episode.tsx` → the card |
| `title.colors.stage` | `video.titleCard.colors.stage` | `Episode.tsx` → the letterbox behind every shot |

`title` is optional: an episode whose audio manifest marks no title-card gap has no `title` key,
and `Episode.tsx` then falls back to black for the letterbox. Keys the timeline carries that this
project does not read are ignored, not rejected.

## Running it

Two things must be set before a render, and the project supplies a default for neither:

- **`REMOTION_EPISODE`** names the episode to render, and selects `public/<episode>/`. There is no
  fallback: a render that guessed an episode could quietly produce the wrong film, and the mistake
  would not be visible for hours. An unset or empty value throws
  `REMOTION_EPISODE is not set: the assemble pipeline names the episode to render`.
- **The composition id**, named on the command line. It is `Episode` here and `video.compositionId`
  in the show config; the assemble pipeline passes one to the other. It is not in the timeline,
  because the id selects the composition whose `calculateMetadata` goes on to fetch the timeline —
  it has to be known first.

```
cd render
npm install
REMOTION_EPISODE=<episode> npx remotion render Episode ../Production/<episode>/video/episode.mp4 --log=error
```

A full-length render takes hours. `npm run studio` opens the same composition for inspection.

## Tests

`npm test` runs the timeline parser's tests under vitest, and `npm run typecheck` runs
`tsc --noEmit` over `src`. Neither renders anything: a real render needs a staged episode and
hours of wall-clock, so it is exercised by the assemble pipeline, not by this package's tests.

## `public/` is empty on purpose

`public/` is the per-episode staging directory `build-timeline.py` fills. It is tracked as an
empty directory with a `.gitkeep` so the default staging root exists on a fresh clone; its
contents — hundreds of megabytes of stills and audio per episode — are ignored by git.
