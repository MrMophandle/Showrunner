/**
 * The timeline is the one file this render project reads, and the only place a show speaks to it.
 *
 * `build-timeline.py` writes `timeline.json` from the show's `showrunner.json`: the frame rate
 * (`video.fps`), the frame size (`visual.shotFrame`), the crossfade (`video.crossfadeSeconds`),
 * and the title card's own typography (`video.titleCard` -- text, font, colours and fade). This
 * project therefore holds no show literal: it draws what the timeline says. Plan C finding F-12
 * is the ruling that put the card's typography in the timeline beside the timing it already
 * carried.
 *
 * `parseTimeline` is the boundary. Everything downstream of it is typed and may be read without
 * further checking; a malformed timeline fails here, at the fetch, naming the first field that is
 * wrong -- not four hours later inside a component.
 */

/** One still, with its place on the clock. `src` is a path under the render project's public/. */
export interface Shot {
  src: string;
  from: number;
  durationInFrames: number;
  id: string;
}

/**
 * The title card's four colours. `stage` is not the card's own colour: it is the letterbox the
 * episode sits on, which the show picks alongside the card and which travels with it.
 */
export interface TitleCardColors {
  background: string;
  type: string;
  glow: string;
  stage: string;
}

/** The title card: when it plays (the episode's own timing) and how it is set (the show's). */
export interface TitleCard {
  from: number;
  durationInFrames: number;
  fadeFrames: number;
  text: string;
  fontFamily: string;
  colors: TitleCardColors;
}

/**
 * The timeline as `build-timeline.py` writes it.
 *
 * `width`, `height` and `crossfadeFrames` are as load-bearing as `fps`: `Root.tsx` returns the
 * first two from `calculateMetadata` and `Episode.tsx` hands the third to every shot.
 *
 * `title` is optional because the script writes it only for an episode whose audio manifest marks
 * a segment `title_card_before`; an episode with no card has no `title` key at all.
 */
export interface Timeline {
  fps: number;
  durationInFrames: number;
  width: number;
  height: number;
  crossfadeFrames: number;
  audio: string;
  shots: Shot[];
  title?: TitleCard;
}

const WHERE = "timeline.json";

function fail(path: string, complaint: string): never {
  throw new Error(`${WHERE}: ${path} ${complaint}`);
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === undefined || value === null) {
    fail(path, "is missing");
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  return value as Record<string, unknown>;
}

function number(host: Record<string, unknown>, key: string, path: string): number {
  const value = host[key];
  if (value === undefined || value === null) {
    fail(path, "is missing");
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(path, "must be a number");
  }
  return value;
}

function text(host: Record<string, unknown>, key: string, path: string): string {
  const value = host[key];
  if (value === undefined || value === null) {
    fail(path, "is missing");
  }
  if (typeof value !== "string") {
    fail(path, "must be a string");
  }
  return value;
}

function parseColors(value: unknown): TitleCardColors {
  const colors = object(value, "title.colors");
  return {
    background: text(colors, "background", "title.colors.background"),
    type: text(colors, "type", "title.colors.type"),
    glow: text(colors, "glow", "title.colors.glow"),
    stage: text(colors, "stage", "title.colors.stage"),
  };
}

function parseTitle(value: unknown): TitleCard {
  const title = object(value, "title");
  return {
    from: number(title, "from", "title.from"),
    durationInFrames: number(title, "durationInFrames", "title.durationInFrames"),
    fadeFrames: number(title, "fadeFrames", "title.fadeFrames"),
    text: text(title, "text", "title.text"),
    fontFamily: text(title, "fontFamily", "title.fontFamily"),
    colors: parseColors(title["colors"]),
  };
}

function parseShots(value: unknown): Shot[] {
  if (value === undefined || value === null) {
    fail("shots", "is missing");
  }
  if (!Array.isArray(value)) {
    fail("shots", "must be an array");
  }
  return value.map((entry, at) => {
    const shot = object(entry, `shots[${at}]`);
    return {
      src: text(shot, "src", `shots[${at}].src`),
      from: number(shot, "from", `shots[${at}].from`),
      durationInFrames: number(shot, "durationInFrames", `shots[${at}].durationInFrames`),
      id: text(shot, "id", `shots[${at}].id`),
    };
  });
}

/**
 * Validate a parsed `timeline.json` and return it typed, throwing on the FIRST field that is
 * missing or of the wrong type, named by its dotted path -- `timeline.json: title.text is missing`.
 *
 * Fields the timeline carries but this project does not read are ignored, not rejected: a show or
 * a later plan may add keys, and a renderer that refused an unfamiliar timeline would be a worse
 * neighbour than one that draws what it understands.
 */
export function parseTimeline(json: unknown): Timeline {
  const raw = object(json, "the timeline");
  const timeline: Timeline = {
    fps: number(raw, "fps", "fps"),
    durationInFrames: number(raw, "durationInFrames", "durationInFrames"),
    width: number(raw, "width", "width"),
    height: number(raw, "height", "height"),
    crossfadeFrames: number(raw, "crossfadeFrames", "crossfadeFrames"),
    audio: text(raw, "audio", "audio"),
    shots: parseShots(raw["shots"]),
  };
  const title = raw["title"];
  if (title !== undefined && title !== null) {
    timeline.title = parseTitle(title);
  }
  return timeline;
}
