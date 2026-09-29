import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { episodePipeline, EPISODE_STAGE_MAP, EPISODE_PIPELINE_NAME } from "../src/pipelines/episode.js";
import { orderSteps } from "../src/pipeline.js";
import { validateStageMap } from "../src/stages.js";
import type { ShowConfig } from "../src/show-config.js";

export const show: ShowConfig = {
  showName: "Harbor Light", showSlug: "HarborLight", promptsDir: "prompts",
  models: { medium: "m", large: "l", writer: "w" }, airMap: { ep10: [1, 10] },
  output: { nasRoot: "/tmp/no-such-nas", mixFilename: "{slug} S{season:02d}E{episode:02d}.wav", videoFilename: "episode.mp4" },
  audio: { voiceRefsDir: "Production/voice-refs", voiceRegistry: "Canon/voice-registry.md" },
  visual: { refs: "Canon/refs.json", style: "Canon/visual-style.md", castingPileDir: "Canon/characters" },
  video: { compositionId: "Episode" },
  publish: { guide: "Canon/publishing-guide.md" },
};

describe("episodePipeline", () => {
  const p = episodePipeline({ show, episodeId: "s02e01", engineRoot: "/engine" });

  it("loads: unique ids, no cycle, every dependsOn and rerunOnReject known, and the stage map validates", () => {
    expect(p.name).toBe(EPISODE_PIPELINE_NAME);
    expect(() => orderSteps(p)).not.toThrow();
    expect(() => validateStageMap(EPISODE_STAGE_MAP, p)).not.toThrow();
    expect(p.steps).toHaveLength(73);
  });

  it("has the eight gates in run order, each opening its DRAFT_ stage", () => {
    const gates = orderSteps(p).filter((s) => s.kind === "gate").map((s) => s.id);
    expect(gates).toEqual(["outline-gate", "script-gate", "casting-gate", "audio-gate", "nano-banana-gate", "image-gate", "final-gate", "canon-gate"]);
    expect(Object.keys(EPISODE_STAGE_MAP.gates).sort()).toEqual([...gates].sort());
  });

  it("keeps the ordering rules as dependencies: images wait for the audio gate, canon waits for the publish kit", () => {
    const by = new Map(p.steps.map((s) => [s.id, s]));
    expect(by.get("visual-direction")?.dependsOn).toEqual(["audio-gate"]);
    expect(by.get("visual-direction")?.inputs).toContain("Production/s02e01/audio/HarborLight S02E01.wav");
    expect(by.get("canon-baseline")?.dependsOn).toEqual(["assemble-commit"]);
    expect(by.get("assemble-commit")?.dependsOn).toEqual(["stamp-finalized", "publish-kit"]);
  });

  it("never declares a directory as an input or output, and names the mix by the show's pattern", () => {
    for (const s of p.steps) for (const f of [...(s.inputs ?? []), ...(s.outputs ?? [])]) expect(f, `${s.id}: ${f}`).not.toMatch(/\/$/);
    const mix = p.steps.find((s) => s.id === "audio-mix");
    expect(mix?.outputs).toEqual(["Production/s02e01/audio/HarborLight S02E01.wav"]);
    expect(episodePipeline({ show, episodeId: "ep98", engineRoot: "/engine" }).steps.find((s) => s.id === "audio-mix")?.outputs).toEqual(["Production/ep98/audio/episode.wav"]);
  });

  it("runs scripts through uv against the engine's scripts project, with the episode id first", () => {
    const ctx = { runId: "r", episodeId: "s02e01", showRoot: "/show", results: {} };
    const stamp = p.steps.find((s) => s.id === "stamp-outline");
    expect(stamp?.kind === "script" && stamp.argv(ctx)).toEqual(["uv", "run", "--project", "/engine/scripts", "python", "/engine/scripts/status.py", "s02e01", "outline", "approved at outline-gate"]);
    const render = p.steps.find((s) => s.id === "render");
    expect(render?.kind === "script" && render.argv(ctx)).toEqual(["npx", "remotion", "render", "Episode", "/show/Production/s02e01/video/episode.mp4", "--log=error"]);
    expect(render?.kind === "script" && render.cwd).toBe("/engine/render");
    expect(render?.kind === "script" && render.env?.(ctx)).toEqual({ REMOTION_EPISODE: "s02e01" });
  });
});
