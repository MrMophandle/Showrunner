/** A unified diff, coloured by line. Ported from console v1's `classifyDiffLine`/`DiffLines`
 *  (`console/src/components/GateCenters.tsx`), which is the one gate artifact that is neither
 *  prose nor a media file: `canon-gate` asks about a patch, and a patch read as plain text hides
 *  the only thing the question is about — which lines are going in and which are coming out.
 *
 *  Header lines are classified first, so a file header (`--- a/Canon/timeline.md`) or a bare `---`
 *  separator is never misread as a deleted line. */

export type DiffLineKind = "add" | "del" | "dim" | "context";

/** Whether a line is part of a diff's scaffolding rather than its content. */
function isDiffHeaderLine(line: string): boolean {
  if (line.startsWith("@@")) return true;
  if (line === "---" || line === "+++") return true;
  for (const prefix of ["--- ", "+++ ", "diff ", "index ", "new file mode", "deleted file mode", "old mode", "new mode", "similarity index", "rename from", "rename to", "copy from", "copy to", "Binary files"]) {
    if (line.startsWith(prefix)) return true;
  }
  return false;
}

/** One line's kind: added content, removed content, scaffolding, or context. */
export function classifyDiffLine(line: string): DiffLineKind {
  if (isDiffHeaderLine(line)) return "dim";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}

const CLASS: Record<DiffLineKind, string> = {
  add: "diff-add",
  del: "diff-del",
  dim: "diff-dim",
  context: "diff-context",
};

/** Renders a patch as mono, per-line-coloured text. A blank line renders a non-breaking space so
 *  its row does not collapse to no height. */
export function Diff({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <div className="diff mono">
      {lines.map((line, i) => (
        <div key={i} className={CLASS[classifyDiffLine(line)]}>{line === "" ? " " : line}</div>
      ))}
    </div>
  );
}
