import type { EpisodeRow, RunView, StepRow } from "../shared/types.js";

/** The client's projections: every judgment the four surfaces make about the data the server
 *  hands them, as functions of their arguments and a clock the caller passes in.
 *
 *  They live outside the components for one reason. There is no DOM in this repository's test
 *  suite (`vitest.config.ts`: `environment: "node"`, and no jsdom is installed), so anything
 *  asserted through a rendered component could not be asserted at all — and these are the
 *  judgments worth asserting: a stall label that turns amber at the wrong minute, a tab title
 *  that misses an episode waiting on the showrunner, or a rejection note composed in an order
 *  that depends on which shot was clicked first are all failures nobody would notice by looking.
 *
 *  Every one of them takes `now` rather than reading the clock, so a test states the moment it is
 *  asking about. The default is `Date.now()`, which is what a component passes. */

/** How long a run may go without an event before the Run page calls it stalled: spec §6.6's
 *  fourteen minutes, which is longer than the slowest legitimate agent step and shorter than any
 *  silence an operator should sit through. */
export const STALL_MS = 14 * 60_000;

/** The one step of the episode pipeline that is legitimately silent for hours — the Remotion
 *  render, which has a four-hour timeout and (until Plan E's Task 7 gives it progress events)
 *  writes nothing between its start and its finish. */
export const RENDER_STEP_ID = "render";

/** The three kinds of stage, which are the three colours the Board and the Run page draw:
 *  a `NEEDS_` stage is blocked on the showrunner's own work, a `DRAFT_` stage is work in flight
 *  or waiting at a gate, and everything else is a milestone the episode has passed. */
export type StageKind = "needs" | "draft" | "approved";

function at(now: Date | number): number {
  return typeof now === "number" ? now : now.getTime();
}

/** Milliseconds between `iso` and `now`, clamped at zero, or undefined when `iso` is absent or
 *  not a timestamp. Clamped because the console and the worker can be on different machines: a
 *  clock a second behind the log's would otherwise draw a negative age. */
function since(iso: string | undefined, now: Date | number): number | undefined {
  if (iso === undefined || iso === "") return undefined;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return undefined;
  return Math.max(0, at(now) - then);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** A duration as the console says it: minutes and seconds under an hour ("12m 05s"), hours and
 *  minutes past one ("3h 07m"). Two units, never three: the third is noise at every altitude the
 *  console draws. */
export function duration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total >= 3600) return `${Math.floor(total / 3600)}h ${pad(Math.floor((total % 3600) / 60))}m`;
  return `${Math.floor(total / 60)}m ${pad(total % 60)}s`;
}

/** How long ago `sinceIso` was, in the form above — or "—" for a timestamp that is absent or
 *  unreadable, which is the honest answer for a run that has not written an event yet. */
export function elapsed(sinceIso: string | undefined, now: Date | number = Date.now()): string {
  const ms = since(sinceIso, now);
  return ms === undefined ? "—" : duration(ms);
}

/** Whether a run has been silent long enough to want attention. A run with no last event at all
 *  is not stalled: it has not started, and the Board says "no runs" rather than colouring it. */
export function stalled(lastEventAt: string | undefined, now: Date | number = Date.now(), thresholdMs = STALL_MS): boolean {
  const ms = since(lastEventAt, now);
  return ms !== undefined && ms >= thresholdMs;
}

/** A stage string as the operator reads it, and the kind that colours it. The underscores become
 *  spaces because the stage is a label here and not an identifier. */
export function stageLabel(stage: string): { kind: StageKind; text: string } {
  const text = stage.replace(/_/g, " ");
  if (stage.startsWith("NEEDS_")) return { kind: "needs", text };
  if (stage.startsWith("DRAFT_")) return { kind: "draft", text };
  return { kind: "approved", text };
}

/** The first line of a multi-line string, trimmed: what a Board row and a rail line have space
 *  for of a step's error or result. */
export function firstLine(text: string | undefined): string {
  if (text === undefined) return "";
  const line = text.split("\n")[0];
  return line === undefined ? "" : line.trim();
}

/** A step's progress as one line: the count, the unit, the rate when the log supports one, and
 *  the ETA when the rate is positive.
 *
 *  The rate is reported per minute rather than per second once it falls below a tenth of a unit a
 *  second, because "0.0/s" is what a loop one scene every four minutes would otherwise read as —
 *  a number that looks like a stuck step rather than a slow one. */
export function progressLabel(p: NonNullable<StepRow["progress"]>): string {
  const parts: string[] = [p.total > 0 ? `${p.done}/${p.total} ${p.unit}`.trim() : `${p.done} ${p.unit}`.trim()];
  const rate = p.ratePerSec;
  if (rate !== undefined && rate > 0) {
    parts.push(rate >= 0.1 ? `${Math.round(rate * 10) / 10}/s` : `${Math.round(rate * 600) / 10}/min`);
  }
  if (p.etaSec !== undefined && Number.isFinite(p.etaSec)) parts.push(`ETA ${duration(p.etaSec * 1000)}`);
  return parts.join(" · ");
}

/** Whether the run's in-flight step is a render that has not reported any progress.
 *
 *  This is the Run page's one exemption from the stall clock, and it is keyed on the absence of
 *  progress rather than on the step id alone (the SDD ledger's T7 ↔ T6 ruling, 2026-10-02): the
 *  render is silent only until Plan E's Task 7 teaches it to report frames, and keying on
 *  progress means the exemption stops applying by itself on the day that lands, with no edit
 *  here. A render that is reporting frames and has still gone quiet for fourteen minutes is a
 *  stalled render, and the page says so. */
export function silentRender(view: Pick<RunView, "position" | "steps">): boolean {
  if (view.position?.stepId !== RENDER_STEP_ID) return false;
  const row = view.steps.find((s) => s.id === RENDER_STEP_ID);
  return row !== undefined && row.status === "running" && row.progress === undefined;
}

/** The "time since the last event" label and whether it is amber — the one number that is beside
 *  all three altitudes of the Run page, because it is the one that answers "is this still
 *  happening?" for a step whose own output says nothing. */
export function stallState(
  view: Pick<RunView, "lastEventAt" | "position" | "steps">, now: Date | number = Date.now(), thresholdMs = STALL_MS,
): { text: string; amber: boolean } {
  if (silentRender(view)) return { text: "render running (silent)", amber: false };
  const ms = since(view.lastEventAt, now);
  if (ms === undefined) return { text: "no events yet", amber: false };
  return { text: `${duration(ms)} since the last event`, amber: ms >= thresholdMs };
}

/** The rejection note a flagged contact sheet composes: one line per flagged shot, `<shot id>:
 *  <what is wrong with it>`, and the literal "redo" for a shot the operator flagged without
 *  saying why — which is the common case, and means "this one again" rather than nothing.
 *
 *  Ordered by shot id and not by the order the shots were clicked, so the note the fix agent
 *  reads is in the order of the sheet the operator was looking at, and so that re-flagging a shot
 *  does not reshuffle a note that was half written. Ported in purpose from console v1's
 *  `composeShotRejection`, whose single-line `reject <ids> — ` form carried no per-shot reason. */
export function composeShotRejection(flags: Record<string, string>): string {
  return Object.keys(flags).sort().map((id) => {
    const note = (flags[id] ?? "").trim();
    return `${id}: ${note === "" ? "redo" : note}`;
  }).join("\n");
}

/** The notes field recomposed for a new flag set, and the block to remember having written.
 *
 *  Words-in-the-field, never-in-the-wire: flagging a shot writes into the textarea the operator is
 *  about to send, so they can see and edit exactly what the fix agent will read. Which means the
 *  previously composed block has to be found and replaced rather than appended to, or six clicks
 *  would leave six copies of the list in the note.
 *
 *  It is found by exact match on the block this page last composed — passed in as `previousBlock`
 *  — and not by a pattern. Console v1 matched its one-line form with a regex (`/^reject .*? — /`,
 *  `GateCenters.tsx`), which worked because that form ended in a marker; this form is several
 *  lines of `<shot>: <reason>` with no closing marker, and a pattern for it would eventually eat a
 *  line the operator wrote themselves. The composed block is kept at the top, separated from their
 *  own prose by a blank line, and clearing the last flag takes the block back out entirely rather
 *  than leaving the blank line and a heading behind. */
export function composeNotesWithFlags(
  notes: string, previousBlock: string, flags: Record<string, string>,
): { notes: string; block: string } {
  let rest = notes;
  if (previousBlock !== "") {
    const where = rest.indexOf(previousBlock);
    if (where !== -1) {
      rest = rest.slice(0, where) + rest.slice(where + previousBlock.length);
      // The separator this function put there, and nothing more: the operator's own blank lines
      // further down are theirs.
      if (rest.startsWith("\n\n")) rest = rest.slice(2);
      else if (rest.startsWith("\n")) rest = rest.slice(1);
    }
  }
  const block = composeShotRejection(flags);
  if (block === "") return { notes: rest, block };
  return { notes: rest === "" ? block : `${block}\n\n${rest}`, block };
}

/** The document title: the console's entire alerting story, since the spec rules out web
 *  notifications on a LAN (http is not a secure context) and the console makes no sound.
 *
 *  Four forms, read in order of what the person at the tab can do about them. An episode waiting
 *  on the showrunner wins everything, because only that one is a question addressed to them. A
 *  **failed or crashed** run comes next — `⚠ <id> FAILED` or `⚠ <id> CRASHED` — because it is a
 *  run that has stopped and will not restart itself, and a tab that reported it as idle let an
 *  episode sit broken for as long as nobody opened the Board. A run that is working is third,
 *  with the whole minutes since it last moved. Everything else is idle.
 *
 *  Each form names the first row in Board order that matches, so a show with two waiting episodes
 *  names the earlier one and the title does not flicker between them.
 *
 *  **An archived row matches no form and so is ignored.** Its status is "archived" — not waiting,
 *  not broken, not running — so a show whose whole first season is archived reads as idle, which
 *  it is: an archived episode was finished outside the engine and there is nothing for the person
 *  at the tab to do about it.
 *
 *  `showName` comes from `GET /api/show` and never from code: this repository names no show. */
export function titleFor(showName: string, rows: EpisodeRow[] | null, now: Date | number = Date.now()): string {
  const idle = `${showName} console`;
  if (rows === null) return idle;
  const waiting = rows.find((r) => r.status === "waiting");
  if (waiting !== undefined) return `⏸ ${waiting.id} NEEDS YOU — ${showName}`;
  const broken = rows.find((r) => r.status === "failed" || r.status === "crashed");
  if (broken !== undefined) return `⚠ ${broken.id} ${broken.status === "failed" ? "FAILED" : "CRASHED"} — ${showName}`;
  const running = rows.find((r) => r.status === "running");
  if (running !== undefined) {
    const minutes = Math.floor((since(running.lastEventAt, now) ?? 0) / 60_000);
    return `● ${running.id} ${running.stage} · ${minutes}m — ${showName}`;
  }
  return idle;
}

/** The schemes a link rendered from a gate's message or an episode's markdown may carry.
 *  Everything else — `javascript:`, `data:`, `vbscript:` — is dropped, and the link renders as
 *  plain text. The prose this is applied to was written by an agent or by a prompt file, so it is
 *  input and not markup, however much it looks like the latter. */
const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/** `href` if it is safe to put in the DOM, else undefined. A url with no scheme at all (a path,
 *  a fragment, a bare filename) is kept: those resolve against this console's own origin, which
 *  is the only origin it talks to.
 *
 *  **Tab, line feed and carriage return are stripped before the scheme is read, and the stripped
 *  string is what is returned.** A browser's URL parser removes those three characters from a url
 *  before it parses one, so `java<tab>script:alert(1)` — which `marked` keeps verbatim out of a
 *  markdown destination in angle brackets — has no scheme that this function would recognise, is
 *  classified as a relative url, and is navigated to as `javascript:alert(1)` by the browser that
 *  stripped the tab. Judging the same string the browser will judge is the whole fix. The prose
 *  this is applied to is a gate's rendered message and the episode's own markdown, which is agent
 *  output: input, however much it looks like markup. */
export function safeHref(href: string | null | undefined): string | undefined {
  if (href === null || href === undefined) return undefined;
  const cleaned = href.replace(/[\t\n\r]/g, "").trim();
  if (cleaned === "") return undefined;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(cleaned);
  const name = scheme?.[1];
  // No scheme at all is a relative url, which is this console's own origin.
  if (name === undefined) return cleaned;
  return SAFE_SCHEMES.has(`${name.toLowerCase()}:`) ? cleaned : undefined;
}
