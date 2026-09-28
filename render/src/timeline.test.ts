/**
 * The timeline parser is the render project's one boundary, so it is the one thing tested here.
 * No composition is mounted and no film is rendered: a real render needs a staged episode and
 * takes hours, and the assemble pipeline is where it first runs.
 *
 * The fixture is an invented show, as every test fixture in this repository is. A render test
 * that named a real show would be the show literal this task exists to remove.
 */

import { describe, expect, it } from "vitest";

import { parseTimeline } from "./timeline";

/** The shape `build-timeline.py` writes, at its smallest: one shot, one title card. */
const timelineJson = () => ({
  fps: 30,
  width: 1024,
  height: 576,
  audio: "ep01/audio.wav",
  durationInFrames: 240,
  crossfadeFrames: 30,
  shots: [{ src: "ep01/images/s01-a.png", from: 0, durationInFrames: 240, id: "s01-a" }],
  title: {
    from: 0,
    durationInFrames: 60,
    fadeFrames: 60,
    text: "A SHOW",
    fontFamily: "Georgia, 'Times New Roman', serif",
    colors: {
      background: "#05070a",
      type: "#d4d8b8",
      glow: "rgba(152, 160, 96, 0.25)",
      stage: "#0f1004",
    },
  },
});

describe("parseTimeline", () => {
  it("parses a minimal timeline, keeps the frame size and the crossfade, and makes the title card optional", () => {
    const timeline = parseTimeline(timelineJson());
    // width, height and crossfadeFrames are read by Root.tsx and Episode.tsx, so the parser must
    // carry them through rather than drop them as keys it was not asked about.
    expect(timeline.width).toBe(1024);
    expect(timeline.height).toBe(576);
    expect(timeline.crossfadeFrames).toBe(30);
    expect(timeline.audio).toBe("ep01/audio.wav");
    expect(timeline.shots).toEqual([
      { src: "ep01/images/s01-a.png", from: 0, durationInFrames: 240, id: "s01-a" },
    ]);
    expect(timeline.title?.text).toBe("A SHOW");
    expect(timeline.title?.colors.stage).toBe("#0f1004");

    // An episode whose manifest marks no title-card gap gets no `title` key at all, and that is
    // a valid timeline: Episode.tsx falls back to its own neutral stage colour.
    const json = timelineJson() as Record<string, unknown>;
    delete json["title"];
    expect(parseTimeline(json).title).toBeUndefined();
  });

  it("throws naming title.text when the title card has no words", () => {
    const json = timelineJson();
    delete (json.title as Partial<typeof json.title>).text;
    expect(() => parseTimeline(json)).toThrow("timeline.json: title.text is missing");
  });

  it("honours a show that shoots at 24 fps", () => {
    const timeline = parseTimeline({ ...timelineJson(), fps: 24, crossfadeFrames: 24 });
    expect(timeline.fps).toBe(24);
    expect(timeline.crossfadeFrames).toBe(24);
  });
});
