import { describe, it, expect } from "vitest";
import { rewriteVariables, type Override } from "../src/rewrite.js";

describe("rewriteVariables", () => {
  it("rewrites the episode id forms, including the sentence-period case", () => {
    const r = rewriteVariables("Episode $setup.output. Then $setup.output/x and $EP_ID and $EP.", { nodeId: "n" }, []);
    expect(r.text).toBe("Episode {{episodeId}}. Then {{episodeId}}/x and {{episodeId}} and {{episodeId}}.");
    expect(r.unmapped).toEqual([]);
  });
  it("rewrites step results and fields", () => {
    expect(rewriteVariables("$tone-check.output and $outline-canon-check.output.verdict", { nodeId: "n" }, []).text)
      .toBe("{{results.tone-check}} and {{results.outline-canon-check.verdict}}");
  });
  it("rewrites the rejection reason with the enclosing gate id", () => {
    expect(rewriteVariables("per: $REJECTION_REASON", { nodeId: "fix", gateId: "outline-gate" }, []).text).toBe("per: {{results.outline-gate:rejection}}");
    expect(rewriteVariables("per: $REJECTION_REASON", { nodeId: "fix" }, []).unmapped).toEqual(["$REJECTION_REASON"]);
  });
  it("applies overrides first and reports what is left", () => {
    const r = rewriteVariables("The full request is: $ARGUMENTS and $season-status.output", { nodeId: "outline" }, [{ pattern: "The full request is: $ARGUMENTS", replacement: "Read the premise." }]);
    expect(r.text).toBe("Read the premise. and {{results.season-status}}");
    expect(r.unmapped).toEqual([]);
    expect(rewriteVariables("$ARGUMENTS", { nodeId: "n" }, []).unmapped).toEqual(["$ARGUMENTS"]);
  });
  it("a wildcard override applies regardless of node", () => {
    expect(rewriteVariables("see Canon/season-1.md", { nodeId: "any" }, [{ nodeId: "*", pattern: "Canon/season-1.md", replacement: "Canon/season-{{season}}.md" }]).text).toBe("see Canon/season-{{season}}.md");
    expect(rewriteVariables("see Canon/season-1.md", { nodeId: "any" }, [{ nodeId: "other", pattern: "Canon/season-1.md", replacement: "X" }]).text).toBe("see Canon/season-1.md");
  });
  it("matches an override's literal only at a boundary, so a near-miss rewrites nothing", () => {
    // One character short of the form it means to retire. Without the trailing boundary this would
    // match the first thirty characters and leave a bare "S" behind — a corruption no later rule
    // can see. With it the pattern matches nothing, and the extractor reports it as never used.
    const near = rewriteVariables("The full request is: $ARGUMENTS", { nodeId: "n" }, [{ pattern: "The full request is: $ARGUMENT", replacement: "WRONG" }]);
    expect(near.text).toBe("The full request is: $ARGUMENTS");
    expect(near.unmapped).toEqual(["$ARGUMENTS"]);
    // A `$` before the pattern is not a boundary either: this must not strand the sigil.
    expect(rewriteVariables("$ARGUMENTS", { nodeId: "n" }, [{ pattern: "ARGUMENTS", replacement: "WRONG" }]).text).toBe("$ARGUMENTS");
    // A pattern that does end at a boundary still matches, mid-sentence and all.
    expect(rewriteVariables("see Canon/season-1.md here", { nodeId: "n" }, [{ pattern: "Canon/season-1.md", replacement: "Z" }]).text).toBe("see Z here");
  });
  it("records which overrides actually fired", () => {
    const fires: Override = { pattern: "alpha", replacement: "A" };
    const idle: Override = { pattern: "beta", replacement: "B" };
    const used = new Set<Override>();
    expect(rewriteVariables("alpha only", { nodeId: "n" }, [fires, idle], used).text).toBe("A only");
    expect(used.has(fires)).toBe(true);
    expect(used.has(idle)).toBe(false);
  });
  it("leaves POSIX parameter expansions and dollar amounts alone", () => {
    expect(rewriteVariables("${SID#s} costs $5 and ${N}", { nodeId: "n" }, [])).toEqual({ text: "${SID#s} costs $5 and ${N}", unmapped: [] });
  });
});
