/** Extracts every agent prompt, loop body, gate message and gate rejection prompt out of a
 *  directory of Archon workflow YAML files, rewrites Archon's `$` variables into the engine's
 *  `{{...}}` syntax, and writes one file per prompt plus an index and any output schemas.
 *
 *  The program is deterministic and hermetic: it reads only the files it is pointed at, writes
 *  only under `outDir`, consults no clock, network or environment, and orders both the index and
 *  the unmapped report by the input's own names. Running it twice on the same inputs produces
 *  byte-identical outputs.
 *
 *  Prompt text moves verbatim. The only change made to a prompt's body is the variable rewriting
 *  of `rewrite.ts`, which is why the show's own name, its characters and its canon paths survive
 *  the move untouched — a prompt is show data (spec §7.4). */

import path from "node:path";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { isMap, isScalar, isSeq, parseDocument, type Document, type YAMLMap } from "yaml";
import { rewriteVariables, type Override } from "./rewrite.js";

export interface ExtractOptions {
  workflowsDir: string;
  outDir: string;
  overridesFile?: string;
  /** nodeId → field names to add to that node's `output_format.required` when absent. This is how
   *  F-05 is paid: a prompt reading `{{results.<node>.verdict}}` needs `verdict` to be required,
   *  or the SDK may legally omit it and the render then throws. */
  schemaRequiredAdd?: Record<string, string[]>;
}

export interface PromptIndexEntry {
  /** The file's basename under `outDir`. */
  file: string;
  kind: "agent" | "loop" | "reject" | "gate";
  /** The workflow file's basename. */
  workflow: string;
  nodeId: string;
  /** The gate this file belongs to, set on a gate message and on a gate's rejection prompt. */
  gateId?: string;
  /** The 1-based `[first, last]` line span of the block's body in the workflow file, excluding the
   *  `prompt: |` indicator line itself — the same convention the Plan C inventory's tables use. */
  line: [number, number];
  /** The model, with a leading `@` stripped, so the value names a key of the show config's
   *  `models` object rather than Archon's alias syntax. A node that declares no model inherits the
   *  workflow's top-level `model` when the file declares one. */
  model?: string;
  /** Recorded only where the YAML declares it. An undeclared context is left absent rather than
   *  defaulted, because "Archon was not told" and "Archon was told fresh" are different facts and
   *  the engine requires the decision to be made explicitly. */
  context?: "fresh" | "shared";
  allowedTools?: string[];
  timeoutMs?: number;
  idleTimeoutMs?: number;
  until?: string;
  maxIterations?: number;
  maxAttempts?: number;
  dependsOn?: string[];
  when?: string;
  /** The basename of this node's schema file, when the node declares an `output_format`. */
  schema?: string;
}

export interface UnmappedForm {
  /** The workflow file's basename. */
  file: string;
  nodeId: string;
  form: string;
}

export interface ExtractResult {
  index: PromptIndexEntry[];
  unmapped: UnmappedForm[];
}

const INDEX_FILE = "index.json";

function asString(v: unknown): string | undefined { return typeof v === "string" ? v : undefined; }
function asNumber(v: unknown): number | undefined { return typeof v === "number" && Number.isFinite(v) ? v : undefined; }
function asBoolean(v: unknown): boolean | undefined { return typeof v === "boolean" ? v : undefined; }
function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
function asStringList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
}

/** Archon writes a model alias as `"@writer"`; the show config's `models` key is `writer`. */
function stripModelAt(model: string): string { return model.startsWith("@") ? model.slice(1) : model; }

/** `fresh_context: false` is the only way a workflow asks for a shared context, so it maps to
 *  "shared" and any other declared value maps to "fresh". A node that declares neither
 *  `fresh_context` nor `context` returns undefined and the index records no context at all. */
function contextOf(freshContext: boolean | undefined, context: string | undefined): "fresh" | "shared" | undefined {
  if (freshContext !== undefined) return freshContext === false ? "shared" : "fresh";
  if (context !== undefined) return context === "fresh" ? "fresh" : "shared";
  return undefined;
}

/** Turns a byte offset into a 1-based line number. */
function lineCounterFor(src: string): (offset: number) => number {
  return (offset: number) => {
    const limit = Math.max(0, Math.min(offset, src.length));
    let line = 1;
    for (let i = 0; i < limit; i++) if (src[i] === "\n") line++;
    return line;
  };
}

interface Site { text: string; line: [number, number] }

/** The text of a string scalar under `map[key]`, with the 1-based line span of its body. A block
 *  scalar's node begins at its `|` or `>` indicator, and the body starts on the following line. */
function scalarSite(map: YAMLMap<unknown, unknown> | undefined, key: string, src: string, lineOf: (offset: number) => number): Site | undefined {
  if (map === undefined) return undefined;
  const node = map.get(key, true);
  if (!isScalar(node) || typeof node.value !== "string") return undefined;
  const text = node.value;
  const range = node.range;
  if (range === undefined || range === null) return { text, line: [1, 1] };
  const start = range[0];
  const valueEnd = range[1];
  const indicator = src[start];
  const isBlock = indicator === "|" || indicator === ">";
  const first = lineOf(start) + (isBlock ? 1 : 0);
  const last = Math.max(first, lineOf(Math.max(start, valueEnd - 1)));
  return { text, line: [first, last] };
}

/** The 1-based line span of a collection node, used for a node's `output_format` block. */
function collectionLines(map: YAMLMap<unknown, unknown>, key: string, lineOf: (offset: number) => number): [number, number] | undefined {
  const node = map.get(key, true);
  if (!isMap(node) && !isSeq(node)) return undefined;
  const range = node.range;
  if (range === undefined || range === null) return undefined;
  const first = lineOf(range[0]);
  return [first, Math.max(first, lineOf(Math.max(range[0], range[1] - 1)))];
}

function childMap(map: YAMLMap<unknown, unknown> | undefined, key: string): YAMLMap<unknown, unknown> | undefined {
  if (map === undefined) return undefined;
  const node = map.get(key, true);
  return isMap(node) ? node : undefined;
}

async function loadOverrides(file: string): Promise<Override[]> {
  const raw = await readFile(file, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`overrides file ${file} must hold a JSON array`);
  return parsed.map((item, i) => {
    const record = asRecord(item);
    const pattern = record ? asString(record["pattern"]) : undefined;
    const replacement = record ? asString(record["replacement"]) : undefined;
    if (pattern === undefined || replacement === undefined) {
      throw new Error(`overrides file ${file}: entry ${i} needs a string "pattern" and a string "replacement"`);
    }
    const nodeId = asString(record?.["nodeId"]);
    return { pattern, replacement, ...(nodeId !== undefined ? { nodeId } : {}) };
  });
}

/** Appends the fields `schemaRequiredAdd` names for this node to the schema's `required` list,
 *  skipping any already present. The order is the schema's own order followed by the added fields
 *  in the order given, so the output is stable. */
function withRequiredAdded(schema: Record<string, unknown>, add: string[] | undefined): Record<string, unknown> {
  if (add === undefined || add.length === 0) return schema;
  const existing = asStringList(schema["required"]) ?? [];
  const merged = [...existing];
  for (const field of add) if (!merged.includes(field)) merged.push(field);
  return { ...schema, required: merged };
}

export async function extractPrompts(opts: ExtractOptions): Promise<ExtractResult> {
  const overrides = opts.overridesFile !== undefined ? await loadOverrides(opts.overridesFile) : [];
  await mkdir(opts.outDir, { recursive: true });

  const names = (await readdir(opts.workflowsDir)).filter((n) => n.endsWith(".yaml")).sort();

  // Each written file becomes one index row; `schemaRow` keeps a node's schema row after its
  // prompt row, so a lookup by nodeId finds the prompt.
  const rows: Array<{ entry: PromptIndexEntry; schemaRow: boolean }> = [];
  const unmapped: UnmappedForm[] = [];
  const seenUnmapped = new Set<string>();
  const writes: Array<{ file: string; body: string }> = [];

  for (const workflow of names) {
    const src = await readFile(path.join(opts.workflowsDir, workflow), "utf8");
    const doc: Document.Parsed = parseDocument(src);
    const lineOf = lineCounterFor(src);
    const workflowModel = asString(doc.get("model"));
    const nodesNode = doc.get("nodes", true);
    if (!isSeq(nodesNode)) continue;

    for (const item of nodesNode.items) {
      if (!isMap(item)) continue;
      const nodeJs = asRecord(item.toJS(doc)) ?? {};
      const nodeId = asString(nodeJs["id"]);
      if (nodeId === undefined) continue;

      const declaredModel = asString(nodeJs["model"]) ?? workflowModel;
      const model = declaredModel !== undefined ? stripModelAt(declaredModel) : undefined;
      const allowedTools = asStringList(nodeJs["allowed_tools"]);
      const timeoutMs = asNumber(nodeJs["timeout"]);
      const idleTimeoutMs = asNumber(nodeJs["idle_timeout"]);
      const dependsOn = asStringList(nodeJs["depends_on"]);
      const when = asString(nodeJs["when"]);
      const nodeContext = contextOf(asBoolean(nodeJs["fresh_context"]), asString(nodeJs["context"]));

      // Shared by every row this node produces. Written once so a gate row and its reject row
      // cannot drift apart on the node-level facts they both describe.
      const meta = {
        ...(model !== undefined ? { model } : {}),
        ...(allowedTools !== undefined ? { allowedTools } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
        ...(dependsOn !== undefined ? { dependsOn } : {}),
        ...(when !== undefined ? { when } : {}),
      };

      // One row per distinct (workflow, node, form), so a form a node uses twice is reported once.
      // The key is a JSON tuple rather than a joined string: no separator can collide with a
      // workflow name, a node id or a variable form.
      const record = (form: string): void => {
        const key = JSON.stringify([workflow, nodeId, form]);
        if (seenUnmapped.has(key)) return;
        seenUnmapped.add(key);
        unmapped.push({ file: workflow, nodeId, form });
      };

      // The schema, if the node declares one. It is written before the prompt rows so the prompt
      // row can name it.
      const outputFormat = asRecord(nodeJs["output_format"]);
      let schemaFile: string | undefined;
      if (outputFormat !== undefined) {
        schemaFile = `${nodeId}.schema.json`;
        const schema = withRequiredAdded(outputFormat, opts.schemaRequiredAdd?.[nodeId]);
        writes.push({ file: schemaFile, body: `${JSON.stringify(schema, null, 2)}\n` });
      }

      const loopMap = childMap(item, "loop");
      const loopJs = asRecord(nodeJs["loop"]);
      const approvalMap = childMap(item, "approval");
      const approvalJs = asRecord(nodeJs["approval"]);
      const onRejectMap = childMap(approvalMap, "on_reject");
      const onRejectJs = approvalJs ? asRecord(approvalJs["on_reject"]) : undefined;

      // A standalone agent prompt.
      const promptSite = scalarSite(item, "prompt", src, lineOf);
      if (promptSite !== undefined) {
        const r = rewriteVariables(promptSite.text, { nodeId }, overrides);
        for (const form of r.unmapped) record(form);
        const file = `${nodeId}.md`;
        writes.push({ file, body: r.text });
        rows.push({
          schemaRow: false,
          entry: {
            file, kind: "agent", workflow, nodeId, line: promptSite.line,
            ...meta,
            ...(nodeContext !== undefined ? { context: nodeContext } : {}),
            ...(schemaFile !== undefined ? { schema: schemaFile } : {}),
          },
        });
      }

      // A loop body. The loop's own `fresh_context` decides the context, not the node's.
      const loopSite = scalarSite(loopMap, "prompt", src, lineOf);
      if (loopSite !== undefined && loopJs !== undefined) {
        const r = rewriteVariables(loopSite.text, { nodeId }, overrides);
        for (const form of r.unmapped) record(form);
        const file = `${nodeId}.md`;
        const loopContext = contextOf(asBoolean(loopJs["fresh_context"]), asString(loopJs["context"])) ?? nodeContext;
        const until = asString(loopJs["until"]);
        const maxIterations = asNumber(loopJs["max_iterations"]);
        writes.push({ file, body: r.text });
        rows.push({
          schemaRow: false,
          entry: {
            file, kind: "loop", workflow, nodeId, line: loopSite.line,
            ...meta,
            ...(loopContext !== undefined ? { context: loopContext } : {}),
            ...(until !== undefined ? { until } : {}),
            ...(maxIterations !== undefined ? { maxIterations } : {}),
            ...(schemaFile !== undefined ? { schema: schemaFile } : {}),
          },
        });
      }

      // A gate's approval message. `gateId` is *not* passed to the rewrite here: a gate message is
      // shown before any rejection exists, so a `$REJECTION_REASON` in one is not resolvable and
      // must be reported rather than silently rewritten. The index's `gateId` is a different fact —
      // which gate this file belongs to — and is set on both gate rows.
      const messageSite = scalarSite(approvalMap, "message", src, lineOf);
      if (messageSite !== undefined) {
        const r = rewriteVariables(messageSite.text, { nodeId }, overrides);
        for (const form of r.unmapped) record(form);
        const file = `${nodeId}.gate.md`;
        writes.push({ file, body: r.text });
        rows.push({
          schemaRow: false,
          entry: {
            file, kind: "gate", workflow, nodeId, gateId: nodeId, line: messageSite.line,
            ...meta,
            ...(nodeContext !== undefined ? { context: nodeContext } : {}),
          },
        });
      }

      // A gate's rejection prompt. This is the one place `$REJECTION_REASON` resolves, and the
      // enclosing gate's id is what names the rejection result.
      const rejectSite = scalarSite(onRejectMap, "prompt", src, lineOf);
      if (rejectSite !== undefined) {
        const r = rewriteVariables(rejectSite.text, { nodeId, gateId: nodeId }, overrides);
        for (const form of r.unmapped) record(form);
        const file = `${nodeId}.reject.md`;
        const maxAttempts = onRejectJs ? asNumber(onRejectJs["max_attempts"]) : undefined;
        writes.push({ file, body: r.text });
        rows.push({
          schemaRow: false,
          entry: {
            file, kind: "reject", workflow, nodeId, gateId: nodeId, line: rejectSite.line,
            ...meta,
            ...(nodeContext !== undefined ? { context: nodeContext } : {}),
            ...(maxAttempts !== undefined ? { maxAttempts } : {}),
          },
        });
      }

      // The schema's own row. Every file the extractor writes has one, so index.json is a complete
      // manifest of the directory; its kind is the kind of the node the schema belongs to.
      if (schemaFile !== undefined) {
        const kind: PromptIndexEntry["kind"] = loopSite !== undefined ? "loop" : "agent";
        const schemaLine = collectionLines(item, "output_format", lineOf) ?? [1, 1];
        rows.push({
          schemaRow: true,
          entry: {
            file: schemaFile, kind, workflow, nodeId, line: schemaLine,
            ...meta,
            ...(nodeContext !== undefined ? { context: nodeContext } : {}),
            schema: schemaFile,
          },
        });
      }
    }
  }

  for (const { file, body } of writes) {
    await writeFile(path.join(opts.outDir, file), body, "utf8");
  }

  // Sorted by workflow, then node, then the node's prompt rows before its schema row, then file.
  rows.sort((a, b) =>
    a.entry.workflow.localeCompare(b.entry.workflow) ||
    a.entry.nodeId.localeCompare(b.entry.nodeId) ||
    Number(a.schemaRow) - Number(b.schemaRow) ||
    a.entry.file.localeCompare(b.entry.file));
  const index = rows.map((r) => r.entry);

  await writeFile(path.join(opts.outDir, INDEX_FILE), `${JSON.stringify(index, null, 2)}\n`, "utf8");
  return { index, unmapped };
}

// ---------------------------------------------------------------------------------------------
// CLI

const USAGE = "usage: extract-prompts --workflows <dir> --out <dir> [--overrides <file>] [--schema-required-add <nodeId>=<field>,...]";

interface ParsedArgs {
  workflows?: string;
  out?: string;
  overrides?: string;
  schemaRequiredAdd: Record<string, string[]>;
}

/** `--schema-required-add outline-check=verdict,pass --schema-required-add other=x` — a chunk with
 *  an `=` opens a node, and a bare chunk adds another field to the node most recently opened. */
export function parseSchemaRequiredAdd(value: string, into: Record<string, string[]>): void {
  let current: string | undefined;
  for (const chunk of value.split(",")) {
    const part = chunk.trim();
    if (part === "") continue;
    const eq = part.indexOf("=");
    if (eq !== -1) {
      current = part.slice(0, eq);
      const field = part.slice(eq + 1);
      const list = into[current] ?? [];
      if (field !== "" && !list.includes(field)) list.push(field);
      into[current] = list;
    } else if (current !== undefined) {
      const list = into[current] ?? [];
      if (!list.includes(part)) list.push(part);
      into[current] = list;
    }
  }
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { schemaRequiredAdd: {} };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--workflows" && value !== undefined) { parsed.workflows = value; i++; }
    else if (flag === "--out" && value !== undefined) { parsed.out = value; i++; }
    else if (flag === "--overrides" && value !== undefined) { parsed.overrides = value; i++; }
    else if (flag === "--schema-required-add" && value !== undefined) { parseSchemaRequiredAdd(value, parsed.schemaRequiredAdd); i++; }
    else throw new Error(`unrecognised argument ${JSON.stringify(flag ?? "")}\n${USAGE}`);
  }
  return parsed;
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.workflows === undefined || args.out === undefined) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const result = await extractPrompts({
    workflowsDir: args.workflows,
    outDir: args.out,
    ...(args.overrides !== undefined ? { overridesFile: args.overrides } : {}),
    ...(Object.keys(args.schemaRequiredAdd).length > 0 ? { schemaRequiredAdd: args.schemaRequiredAdd } : {}),
  });
  for (const entry of result.index) {
    process.stdout.write(`${entry.file}\t${entry.kind}\t${entry.workflow}\t${entry.nodeId}\n`);
  }
  process.stdout.write(`${result.index.length} file(s) written to ${args.out}, plus ${INDEX_FILE}\n`);
  if (result.unmapped.length > 0) {
    process.stderr.write(`${result.unmapped.length} unmapped variable form(s); every one needs an override or a plan decision:\n`);
    for (const u of result.unmapped) process.stderr.write(`  ${u.file}\t${u.nodeId}\t${u.form}\n`);
    return 1;
  }
  return 0;
}

const invokedAs = process.argv[1];
if (invokedAs !== undefined && import.meta.url === pathToFileURL(invokedAs).href) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err: unknown) => { process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`); process.exitCode = 1; },
  );
}
