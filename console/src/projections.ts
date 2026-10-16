import type { BibleRow, BibleState, EpisodeRow, RunStatus, RunView, ShowInfo, StepRow } from "../shared/types.js";

/** The client's projections: every judgment the four surfaces make about the data the server
 *  hands them, as functions of their arguments and a clock the caller passes in.
 *
 *  They live outside the components for one reason: they are the judgments worth asserting, and a
 *  judgment inside a component is asserted only by rendering one. A stall label that turns amber
 *  at the wrong minute, a tab title that misses an episode waiting on the showrunner, or a
 *  rejection note composed in an order that depends on which shot was clicked first are all
 *  failures nobody would notice by looking. (This file's header used to say the suite had no DOM
 *  at all; since Plan H's ruling H-10 a test may opt into jsdom with a per-file pragma — see
 *  `vitest.config.ts` and `test/client/ProgressBar.test.tsx`. The argument for keeping these
 *  functions out here is unchanged and is the one above: a pure function is the cheaper and more
 *  exact place to assert a judgment, not the only possible one.)
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

/** Whether a Board row's "since the last event" clock reads amber: the run has been silent past
 *  the stall threshold **and** it is a run that could be moving — `running` or `crashed`. An idle
 *  or completed run is quiet because it has finished, and a run parked at a gate is quiet because
 *  it is waiting for the person reading the Board.
 *
 *  **A run asleep until a usage limit resets is exempt** (Plan I). It is silent for hours by
 *  design, the engine's own sentence under its stage chip says why, and amber means "this may be
 *  stuck" — the same reasoning `silentRender` applies to a render that reports no frames. The
 *  exemption is keyed on the row's `waitingNote`, as every other judgment about a limit wait is,
 *  because the run itself reads `running`: a worker is holding it and beating its lock.
 *
 *  A function rather than a condition written inline in the page, so the Board's own markup
 *  carries no judgment. **What it shares with `stallState` is the rule, not the code**: both
 *  exempt a limit wait from the amber, and each keys that exemption on the shape it is handed —
 *  this one on `EpisodeRow.waitingNote`, the row-level summary the server derives through
 *  `waitingOf`, and `stallState` on the `note` of the `RunView`'s own step rows. They are not one
 *  predicate because they are not one question: a Board row is one line about a whole run, and
 *  `stallState` also has a render's silence and "no events yet" to answer for and no run status to
 *  read. The two comments name each other so the next reader of either finds the other. */
export function quietRow(row: Pick<EpisodeRow, "status" | "lastEventAt" | "waitingNote">, now: Date | number = Date.now(), thresholdMs = STALL_MS): boolean {
  if (waitingNote(row) !== undefined) return false;
  return stalled(row.lastEventAt, now, thresholdMs) && (row.status === "running" || row.status === "crashed");
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

/** How long a gate's summary line may be before it is cut, with the ellipsis counted in. Long
 *  enough for the longest first line any gate template produces ("Images ready for s02e01 — view
 *  Production/s02e01/images/" is 56 characters), short enough that a message written as one
 *  unbroken paragraph cannot widen the page the expander was collapsed to protect. */
const GATE_SUMMARY_LIMIT = 140;

/** The first line of a gate's message, as the collapsed expander's summary says it.
 *
 *  **Why the first line is enough.** Every gate template in the show scaffold opens with one
 *  sentence naming what is ready and where it is — "Script drafted: Episodes/s02e01/script.md",
 *  "Outline ready: …", "Images ready for s02e01 — view …"
 *  (`tools/templates/prompts/*.gate.md`) — and everything after it is the reviewers' raw verdicts.
 *  So the first line is the half of the message that says what the gate is about, and the rest is
 *  the half Ryan asked to be folded away: the ruling of 2026-10-15, at the s02e01 script gate,
 *  where the page opened on seven reviewers' JSON and the script was below it.
 *
 *  **A pure function and not a slice in the page, because three things can go wrong with it and
 *  none of them is visible by looking at a rendered expander.** A message whose first line is
 *  blank would leave the summary reading "the gate's message — " with nothing after the dash. A
 *  message written as markdown whose first line is a heading would put "## what to check" on the
 *  screen, markers and all. And a message with no line breaks at all has a "first line" that is
 *  the whole wall of text, which would widen the page the collapse exists to protect.
 *
 *  It is therefore not `firstLine`, which trims one line and nothing else and is right for the
 *  step errors it serves. This one skips blank lines, strips the leading blockquote, heading and
 *  bullet markers, drops bold markers, collapses runs of whitespace, and caps the result at
 *  `GATE_SUMMARY_LIMIT`. The empty string is the honest answer for a message with nothing in it,
 *  and the caller renders the bare label rather than a dangling dash. */
export function gateSummaryLine(message: string): string {
  for (const raw of message.split("\n")) {
    const line = raw
      .replace(/^[\s>]+/, "")
      .replace(/^#{1,6}\s*/, "")
      .replace(/^[-*+]\s+/, "")
      .replace(/\*\*/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (line === "") continue;
    return line.length > GATE_SUMMARY_LIMIT ? `${line.slice(0, GATE_SUMMARY_LIMIT - 1).trimEnd()}…` : line;
  }
  return "";
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
  // A step asleep until a usage limit resets is the other legitimately quiet case (Plan I), and
  // the wait can run for five hours. The age is still printed — "4h 55m since the last event" is
  // true, and it is what the operator wants to know — but it is not amber, because the step
  // altitude below carries the engine's sentence saying what the silence is. The row's `note` is
  // the discriminator: a gate's waiting row carries none, and a gate is a stall worth colouring.
  // This is the same rule `quietRow` applies to a Board row, keyed there on the row's
  // `waitingNote` because that is the shape the Board is handed; the rule is shared, the predicate
  // is not.
  const sleepingOnLimit = view.steps.some((s) => s.note !== undefined && s.note !== "");
  return { text: `${duration(ms)} since the last event`, amber: !sleepingOnLimit && ms >= thresholdMs };
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

/** The sentence a Board row carries for a run that is asleep waiting out a Claude plan usage
 *  limit, or undefined for every other row — the engine's own words, never the console's
 *  (`EpisodeRow.waitingNote`, from the waiting step's `step_waiting` reason).
 *
 *  A function rather than a field read inline, for the reason every judgment in this file is one:
 *  the Board's row draws it, `titleFor` keys its `⏳` form on the same condition, and the two must
 *  not come to disagree about which rows are waiting on a limit. The empty string is treated as no
 *  note, so a reason the engine wrote blank draws nothing rather than an empty line under a chip. */
export function waitingNote(row: Pick<EpisodeRow, "waitingNote">): string | undefined {
  const note = row.waitingNote;
  return note === undefined || note.trim() === "" ? undefined : note;
}

/** When a usage limit resets, as the person at the tab reads a clock: `7:50 PM` on an en-US
 *  machine, `19:50` on a 24-hour one — the ISO the engine recorded, rendered in **the browser's**
 *  zone and locale.
 *
 *  The browser's and not the reset's: the operator is looking at the machine in front of them, and
 *  a time in the SDK's zone would be a number they have to convert before they know whether to
 *  wait. The engine's failure sentences keep the zone they were given, so the two are not in
 *  competition — the log says `7:50pm America/New_York` and the tab says what that is here.
 *
 *  Undefined for an absent or unparseable timestamp, which is why the title's form drops the
 *  `· resets <time>` clause rather than printing `Invalid Date` in a tab. */
export function resetLabel(iso: string | undefined): string | undefined {
  if (iso === undefined || iso === "") return undefined;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return undefined;
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** One run as the situation line reads it: the fields `runSituation` judges, and nothing else.
 *
 *  **A structural subset rather than `RunView`, because two differently shaped things carry the
 *  same run.** The Run page holds a whole `RunView` with its step rows; a Board row holds an
 *  `EpisodeRow`, which carries the run's state without its steps (`server/runs.ts`'s `episodeRow`
 *  keeps the gate's identity and not its message, for the same reason: twenty rows of prose is the
 *  Board's whole payload). Both are assignable to this, so each page calls `runSituation` with the
 *  object it already has — no adapter at either call site, and no second copy of the vocabulary.
 *  A `Pick<RunView, …>` could not serve: `RunView.openGate` carries a `message` that an
 *  `EpisodeRow`'s deliberately omits, so a row would not satisfy the `Pick`.
 *
 *  The two optional halves are what tells the callers apart. `steps` is the Run view's and gives
 *  its sentence the in-flight row's loop iteration and progress; `waitingNote` is the Board's
 *  row-level summary of a Plan I wait, which the server derives from the same step rows
 *  (`waitingOf`, `server/runs.ts`). A caller that has neither still gets a subject and a sentence. */
export interface SituationRun {
  status: RunStatus;
  position?: { stepId: string; startedAt: string };
  openGate?: { stepId: string; attempt: number; openedAt: string };
  failed?: { stepId: string; error: string };
  /** The engine's sentence for a run asleep until a usage limit resets, as the Board's row carries
   *  it (`EpisodeRow.waitingNote`). */
  waitingNote?: string;
  /** The one line of an archived episode's `archive.json` marker (`EpisodeRow.archiveNote`) —
   *  where the finished episode is and what made it, which is the whole of what an archived row
   *  has to say. */
  archiveNote?: string;
  /** Which round of the review panel the run is on, as both callers carry it (`RunView.round` and
   *  `EpisodeRow.round`). Absent for every run whose panel has written no `panel_round`. */
  round?: { n: number; costUsd: number };
  /** The run's step rows, which the Run view has and a Board row does not. */
  steps?: StepRow[];
}

/** What one surface says about one run: a subject, a sentence, and the name of the one move that
 *  fits. `action` is a name and not a button, because who may press it is the caller's question
 *  and not this judgment's (`SituationLine`, `src/components/SituationLine.tsx`). */
export interface Situation {
  subject: string;
  sentence: string;
  action?: "gate" | "resume" | "continue";
}

/** The five subjects, which are the whole vocabulary: a reader who has learnt these five has
 *  learnt every claim the console makes about who holds a run. "A worker is on it," keeps its
 *  comma because the sentence after it is the engine's own continuation of it — the reason the
 *  worker is not moving — while the others end their claim and let the sentence start again. */
const SUBJECT_WORKING = "A worker is on it.";
const SUBJECT_WORKING_WAIT = "A worker is on it,";
const SUBJECT_NEEDS_YOU = "Needs you.";
const SUBJECT_DONE = "Done.";
const SUBJECT_NOT_STARTED = "Not started.";

/** The time of day out of an ISO timestamp — `14:05:00` out of `2026-10-15T14:05:00.000Z` — and
 *  the whole string back for anything that is not one.
 *
 *  The log's own zone and not the browser's, which is the opposite of what `resetLabel` does, and
 *  deliberately: a reset time is a *future* moment the operator is deciding whether to wait for,
 *  so it belongs in the clock they are looking at, while a gate's `openedAt` is a moment they will
 *  go looking for in the run's log and the event feed, both of which print the log's timestamps.
 *  This is also the form the gate banner this line replaces used (`Run.tsx`'s `gate-banner`,
 *  before 2026-10-15), so the string on the screen has not moved. */
function clockTime(iso: string): string {
  const t = iso.indexOf("T");
  return t === -1 ? iso : iso.slice(t + 1, t + 9);
}

/** The in-flight step's own row, or undefined when nothing is in flight or the caller has no step
 *  rows (a Board row).
 *
 *  `position` names the step that started last and has not ended; the row beside it carries what
 *  that step is *doing* — its progress, its loop iteration, the engine's sentence for a wait. The
 *  lookup lives here because two surfaces need the same row: the Run page's step altitude draws
 *  it and `runSituation` writes the sentence about it, and a page that found the row its own way
 *  could draw one step underneath a line that named another. */
export function positionStep(run: Pick<SituationRun, "position" | "steps">): StepRow | undefined {
  const stepId = run.position?.stepId;
  if (stepId === undefined) return undefined;
  return run.steps?.find((s) => s.id === stepId);
}

/** How far through its attempts a loop step is — "iteration 3 of 15" — or undefined for a row
 *  that is not a loop or has had no iteration yet.
 *
 *  One function because the same words appear twice on the Run page: in the situation line's
 *  sentence and under the step altitude's elapsed time. It is **not** the step's progress, and the
 *  two numbers are usually different: the draft loop reports "2/12 scenes" against a cap of
 *  fifteen iterations (`StepRow.iteration`, `shared/types.ts`). */
export function iterationLabel(row: Pick<StepRow, "iteration"> | undefined): string | undefined {
  const it = row?.iteration;
  return it === undefined ? undefined : `iteration ${it.n} of ${it.max}`;
}

/** Which round of the review panel the run is on — "round 3" — or undefined for a run whose panel
 *  has written none, which is every round 1 (`roundOf`, `server/runs.ts`).
 *
 *  **"round 3" and not "round 3 of N", because there is no N.** Plan J's panel has no cap: the loop
 *  runs until every reviewer passes and the only stop is the weekly quota (ruling 1, "No round
 *  cap"). That is the opposite of `iterationLabel`, whose whole purpose is the denominator — "a loop
 *  on iteration 14 of 15 is about to fail" — and a round with nothing to be close to has nothing to
 *  be "of". The inventory asked this question directly (J-27) and this is the answer: the numerator
 *  alone, which still does the one job the line needs, telling round 3 from round 1.
 *
 *  **And no cost here.** The round's cost is on the gate head, where somebody is deciding whether
 *  to approve what it bought (`src/pages/Gate.tsx`), and in the gate's own message. On a Board of
 *  twenty rows it would be a figure that moves every few minutes beside a step id that is the thing
 *  being read, and `RunView.round` carries it for the surfaces that want it. */
export function roundLabel(run: Pick<SituationRun, "round">): string | undefined {
  const round = run.round;
  return round === undefined ? undefined : `round ${round.n}`;
}

/** The engine's sentence for a run that is asleep waiting out a Claude plan usage limit, from
 *  whichever of the two shapes the caller has: the Board's row-level `waitingNote`, or the step row
 *  the Run view holds.
 *
 *  The step-row rule is the server's own (`waitingOf`, `server/runs.ts`): status `waiting` **and** a
 *  non-empty `note`. A gate's waiting row carries no note, and `projectSteps` clears the note when
 *  the retry's `agent_query` starts — so a row that is both is a wait that is still being slept,
 *  and nothing else is. `stallState` reads the looser "any row with a note", which is right for its
 *  own question (whether to colour a silence) and would be wrong here: this sentence claims a
 *  worker is asleep right now. */
function sleepingNote(run: SituationRun): string | undefined {
  const rowNote = waitingNote(run);
  if (rowNote !== undefined) return rowNote;
  const sleeping = run.steps?.find((s) => s.status === "waiting" && s.note !== undefined && s.note.trim() !== "");
  return sleeping?.note;
}

/** Whether the system is working or waiting on the showrunner, and what for: one subject and one
 *  sentence, rendered by the Run view's status slot and by every row of the Board.
 *
 *  **It exists because a notice is not a status.** Ryan's ruling of 2026-10-15 followed a Run view
 *  showing "resumed — a worker is on it" beside an open script gate: the string was true when the
 *  POST answered and false a second later, because it recorded an action instead of stating the
 *  run's state. Every answer below is derived from the view the page has just fetched, so it
 *  changes on the same refetch the altitudes do (`Run.tsx`'s coalesced `refresh`) and there is no
 *  moment at which it can describe a state the run has left.
 *
 *  **One vocabulary, two surfaces.** The subject is one of the five fixed strings above, so twenty
 *  Board rows and the Run view make the same claim in the same words. `action` names the one move
 *  that fits, and the caller decides whether it may be offered: the Run page renders the two POSTs
 *  only on a show it can act on (`canAct`, ruling H-03) and the open gate always, because that one
 *  is a GET and reading is all a read-only show offers; the Board renders none of them, because its
 *  row's own action button is unchanged.
 *
 *  It re-derives nothing. The elapsed time is `elapsed`, the progress clause is `progressLabel` —
 *  the same function `ProgressBar` renders, so the line and the bar cannot disagree — the in-flight
 *  row is `positionStep`, the iteration clause is `iterationLabel`, the round clause is
 *  `roundLabel`, and a usage-limit wait is read the way the server reads it (`sleepingNote`).
 *
 *  **The round is said in the working sentence only** (Plan J, ruling 8). A run parked at the
 *  script gate has a round to report, and it is reported one click away in the gate's own head,
 *  where the person deciding whether to approve the panel's work is reading (`src/pages/Gate.tsx`)
 *  — and in the gate's rendered message. Saying it here as well would be two places to keep in
 *  agreement about one fact, and the Board's question about a parked run is who holds it, which the
 *  gate sentence already answers. A failed run says its round too, in the engine's own stop
 *  sentence: the weekly-quota failure names the round it stopped on, and the `failed` arm below
 *  prints that error's first line verbatim.
 *
 *  **The order of the checks is the status, except that a usage-limit wait outranks the working
 *  sentence.** Such a run reads `running`, because a worker is holding it and beating its lock
 *  (spec §4.2), so a line that took the status at its word would say "`draft` for 4h 55m" about a
 *  step that has been asleep since the afternoon — the reading Plan I exists to prevent. */
export function runSituation(run: SituationRun, now: Date | number = Date.now()): Situation {
  switch (run.status) {
    case "waiting": {
      const gate = run.openGate;
      if (gate === undefined) return { subject: SUBJECT_NEEDS_YOU, sentence: "This run is waiting for an answer." };
      return {
        subject: SUBJECT_NEEDS_YOU,
        sentence: `${gate.stepId} has been waiting for an answer since ${clockTime(gate.openedAt)} (attempt ${gate.attempt}).`,
        action: "gate",
      };
    }
    case "failed": {
      const failed = run.failed;
      // A failure the run's state no longer calls one has no step to name (`failedOf`,
      // `server/runs.ts`, answers undefined for a `step_failed` a later resume swept away), and
      // Resume is still the move: it runs the run again from wherever it stopped.
      if (failed === undefined) return { subject: SUBJECT_NEEDS_YOU, sentence: "This run failed. Resume runs it again from where it stopped.", action: "resume" };
      return {
        subject: SUBJECT_NEEDS_YOU,
        sentence: `Failed at ${failed.stepId}: ${firstLine(failed.error)}. Resume runs it again from there.`,
        action: "resume",
      };
    }
    case "crashed":
      return { subject: SUBJECT_NEEDS_YOU, sentence: "No process is holding this run. Continue puts a worker back on it.", action: "continue" };
    case "completed":
      return { subject: SUBJECT_DONE, sentence: "Nothing needs you." };
    case "archived":
      // An episode finished outside the engine. The marker's one line is the whole of what the row
      // has to say — where the finished episode is and what made it — and it is said here rather
      // than twice, which is why the Board's archived chip is the bare word (`Board.tsx`).
      return { subject: SUBJECT_DONE, sentence: run.archiveNote ?? "Finished outside the engine." };
    case "none":
      return { subject: SUBJECT_NOT_STARTED, sentence: "" };
    case "running": {
      const note = sleepingNote(run);
      if (note !== undefined) return { subject: SUBJECT_WORKING_WAIT, sentence: note };
      const position = run.position;
      if (position === undefined) return { subject: SUBJECT_WORKING, sentence: "a step is in flight" };
      const row = positionStep(run);
      let sentence = `${position.stepId} for ${elapsed(position.startedAt, now)}`;
      // The round and the loop's iteration share one parenthetical, the round first, because the
      // round is what *contains* the iteration: Plan J's panel re-runs the whole review round, and
      // any loop inside it is counting its own attempts within that round. The live pipeline cannot
      // produce both at once — a round's steps are one guard and seven agent steps, `revise` having
      // become a single fresh call per round (ruling 4) — but the order is decided here rather than
      // left to whichever clause happened to be appended first.
      const clauses = [roundLabel(run), iterationLabel(row)].filter((c) => c !== undefined);
      if (clauses.length > 0) sentence += ` (${clauses.join(", ")})`;
      if (row?.progress !== undefined) sentence += ` · ${progressLabel(row.progress)}`;
      return { subject: SUBJECT_WORKING, sentence };
    }
    default:
      // Every `RunStatus` is answered above; a status the wire grew that this code has not learnt
      // says so rather than rendering an empty line.
      return { subject: SUBJECT_WORKING, sentence: String(run.status) };
  }
}

/** The document title: the console's entire alerting story, since the spec rules out web
 *  notifications on a LAN (http is not a secure context) and the console makes no sound.
 *
 *  Five forms, read in order of what the person at the tab can do about them. An episode waiting
 *  on the showrunner wins everything, because only that one is a question addressed to them. A
 *  **failed or crashed** run comes next — `⚠ <id> FAILED` or `⚠ <id> CRASHED` — because it is a
 *  run that has stopped and will not restart itself, and a tab that reported it as idle let an
 *  episode sit broken for as long as nobody opened the Board. A run **asleep until a usage limit
 *  resets** is third — `⏳ <id> WAITING · resets 7:50 PM` — and the two neighbours are what place
 *  it: it ranks under `⚠` because a wait is a job the console is already doing and a failure is
 *  one only the operator can finish, and over the working form because a tab reading
 *  `● s02e01 DRAFT_SCRIPT · 94m` for a run that is asleep until the evening sends its reader
 *  looking for a hung step (Plan I, the display ruling). A run that is working is fourth, with the
 *  whole minutes since it last moved. Everything else is idle.
 *
 *  **The `⏳` form cannot be keyed on a status**, and that is the one subtlety here. The wait
 *  happens inside the worker with the run's lock heartbeat going (spec §4.2), so such a run reads
 *  `running` — a process really is holding it — and the row says it is waiting by carrying
 *  `waitingNote`. The check is therefore the note's presence, which is also why it must sit above
 *  the `running` form rather than inside it.
 *
 *  Each form names the first row in Board order that matches, so a show with two waiting episodes
 *  names the earlier one and the title does not flicker between them.
 *
 *  **An archived row matches no form and so is ignored.** Its status is "archived" — not waiting,
 *  not broken, not running — so a show whose whole first season is archived reads as idle, which
 *  it is: an archived episode was finished outside the engine and there is nothing for the person
 *  at the tab to do about it.
 *
 *  **The show is named by `showLabel`, which carries the key as well as the name**, because one
 *  console now holds every show on the machine and a name alone cannot tell two of them apart:
 *  the two repositories this console was measured against declare the **same** `showName` and the
 *  same `showSlug` (ruling H-02, inventory §2.1). A tab naming only that shared name, on a console
 *  holding both, would be asking for the showrunner without saying where.
 *
 *  **A read-only show is always idle**, whatever its rows say. Every one of the other three forms
 *  is a claim about something the reader can do — answer a gate, restart a run that has stopped,
 *  watch one that is working — and on a read-only show the console offers none of those: the
 *  server answers 403 to every POST to it, so the Gate page draws no answer and the action bar no
 *  recovery (ruling H-03). A tab reading `⏸ s02e01 NEEDS YOU` for a show whose gate cannot be
 *  answered here asks for a showrunner who would arrive and find no button, which is the one
 *  failure the title exists to prevent. The cost is recorded rather than hidden: a crashed run in
 *  a read-only show is not announced in the tab, because nothing in this console can continue it.
 *
 *  The name and the key both come from `GET /api/shows/<key>` and never from code: this
 *  repository names no show. */
export function titleFor(show: TitleShow, rows: EpisodeRow[] | null, now: Date | number = Date.now()): string {
  const label = showLabel(show);
  const idle = `${label} console`;
  if (show.readOnly || rows === null) return idle;
  const waiting = rows.find((r) => r.status === "waiting");
  if (waiting !== undefined) return `⏸ ${waiting.id} NEEDS YOU — ${label}`;
  const broken = rows.find((r) => r.status === "failed" || r.status === "crashed");
  if (broken !== undefined) return `⚠ ${broken.id} ${broken.status === "failed" ? "FAILED" : "CRASHED"} — ${label}`;
  const limited = rows.find((r) => waitingNote(r) !== undefined);
  if (limited !== undefined) {
    const resets = resetLabel(limited.waitingUntil);
    return `⏳ ${limited.id} WAITING${resets === undefined ? "" : ` · resets ${resets}`} — ${label}`;
  }
  const running = rows.find((r) => r.status === "running");
  if (running !== undefined) {
    const minutes = Math.floor((since(running.lastEventAt, now) ?? 0) / 60_000);
    return `● ${running.id} ${running.stage} · ${minutes}m — ${label}`;
  }
  return idle;
}

/** The three fields of a show that a title has to carry: what to call it, what tells it from
 *  another show of the same name, and whether anything in it can be acted on from this console. A
 *  `Pick` of `ShowInfo` rather than the whole of it, so a test states a show in three fields and
 *  not in nine. */
export type TitleShow = Pick<ShowInfo, "showName" | "key" | "readOnly">;

/** How a show is named wherever one show has to be told from another: `<showName> · <key>`.
 *
 *  One function shared by the chrome's link (`App.tsx`) and the document title (`titleFor`), so
 *  the header and the tab cannot name the same show two ways. The key is not decoration: the two
 *  shows this console was measured against declare the same `showName` and the same `showSlug`
 *  (inventory §2.1), and the key is the only thing that distinguishes them — it is also the
 *  segment in the url the operator is looking at, so a label that carries it can be matched
 *  against the address bar.
 *
 *  It takes the two fields it reads rather than `TitleShow`, because how a show is *named* has
 *  nothing to do with whether it may be written to. */
export function showLabel(show: Pick<ShowInfo, "showName" | "key">): string {
  return `${show.showName} · ${show.key}`;
}

/** The reason a Board row is a show's own read failure rather than an episode, or undefined when
 *  it is an ordinary row.
 *
 *  The server gathers the Board's rows per show and catches per show, so a show whose episode
 *  files throw — a malformed `images/prompts.json`, an unreadable `Canon/refs.json` — yields one
 *  row with an empty `id` carrying the reason instead of a 500 that names no show (ruling H-14,
 *  and `EpisodeRow.error` in `shared/types.ts`). That row has no episode, no stage anybody
 *  derived and no action anybody could take, so the Board must draw it as what it is rather than
 *  running it through the ordinary template, which would print an empty title beside a blank stage
 *  chip and a launch button for an episode that does not exist.
 *
 *  A function and not an inline test in the component, because this is the rule that decides which
 *  of two templates a row gets, and it is the kind of rule that is wrong silently: a Board that
 *  stopped recognising the row would show an empty row instead of the reason a whole show is
 *  missing. */
export function showReadFailure(row: EpisodeRow): string | undefined {
  if (row.id !== "") return undefined;
  const reason = row.error?.trim() ?? "";
  return reason === "" ? undefined : reason;
}

/** The one line a read-only show renders in place of a button whose POST the server would refuse.
 *
 *  `refused` says what is not on offer here, in the words of the place it is rendered; the rest is
 *  the same sentence everywhere, because the reason is the same everywhere. The key is named
 *  because a console holds several shows and the operator has to know which one is read-only
 *  without reading the address bar.
 *
 *  **Why a line and not a disabled button:** a read-only show refuses *every* POST with 403
 *  (`server/app.ts`'s show middleware, ruling H-03). The two shows this console was measured
 *  against name one NAS root and one final filename, so a single write in the retired tree
 *  overwrites a finished season — and a button that is offered and then refused teaches the
 *  operator that the console has a move it does not have. */
export function readOnlyLine(key: string, refused: string): string {
  return `${key} is read-only: ${refused}. Two registered shows can name one NAS root, and a write in the wrong tree would overwrite a finished season.`;
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

// ── the Bible page ────────────────────────────────────────────────────────────────────────────

/** Which of the Bible page's six panels one bible file gets.
 *
 *  Six and not nine, because three of the nine `BibleState`s share one panel (the three ways an
 *  approval is recorded all draw the finished file read-only) and two more share another (`stalled`
 *  and `failed` both draw a reason and a "start again"). The names are the panels' own, so the page
 *  renders one branch per name rather than one per state. */
export type BiblePanel = "questions" | "running" | "gate" | "approved" | "trouble" | "scaffold";

/** The state → panel table, as a `Record` rather than a `switch`, so that a tenth `BibleState`
 *  added to `shared/types.ts` is a compile error here instead of a file that silently renders
 *  nothing. */
const PANEL_BY_STATE: Record<BibleState, BiblePanel> = {
  pending: "questions",
  answering: "questions",
  running: "running",
  gate: "gate",
  approved: "approved",
  imported: "approved",
  "written-by-author": "approved",
  stalled: "trouble",
  failed: "trouble",
};

/** The panel one bible file's view gets: the mode is read **before** the state, which is the whole
 *  reason this is a function and not an inline test.
 *
 *  A scaffold file (`continuity-ledger`, `voice-registry`) reads `pending` for the life of the show
 *  — nothing ever writes a setup log for it, because the episode pipeline fills it
 *  (`shared/types.ts`'s `BibleRow`) — so a page that selected on the state alone would offer the
 *  author a question form and a "Write it" button for a file whose run route answers 409. The mode
 *  is the fact that settles it.
 *
 *  Takes the two fields it reads, so the Bible page can ask the question of a `BibleRow` from the
 *  rail or of the whole `BibleFileView`. */
export function biblePanelFor(row: Pick<BibleRow, "state" | "mode">): BiblePanel {
  if (row.mode === "scaffold") return "scaffold";
  return PANEL_BY_STATE[row.state];
}

/** The chip class the rail draws one bible state with, out of the stylesheet the Board already
 *  uses, so the two pages cannot come to mean different things by one colour: amber is "blocked on
 *  you", blue is "in flight", green is "a milestone that has been passed", red is "ended badly".
 *  A gate is amber for the same reason an episode waiting on the showrunner is. */
export function bibleChipClass(state: BibleState): string {
  switch (state) {
    case "pending": return "chip chip-none";
    case "answering": return "chip chip-draft";
    case "running": return "chip chip-running";
    case "gate": return "chip chip-waiting";
    case "approved": case "imported": case "written-by-author": return "chip chip-approved";
    default: return "chip chip-failed";
  }
}

/** Whether the question form holds anything that is not on disk.
 *
 *  **Compared trimmed**, both sides: an answer the author added a newline to is not a different
 *  answer, and a textarea holding only whitespace is an unanswered question — `writeAnswers`
 *  records those as `(blank)` either way. Absent and empty are the same thing on both sides, so a
 *  heading the saved record has never carried and a textarea nobody has typed in are equal.
 *
 *  It gates "Save answers", and it decides whether "Write it" posts the answers before it starts
 *  the run: the writer agent reads the answers off disk, and a browser that started a twenty-minute
 *  writer against answers still sitting in a textarea would be the one way this surface is worse
 *  than the terminal, which writes every answer the moment it is given. */
export function answersDirty(saved: Record<string, string>, current: Record<string, string>): boolean {
  for (const heading of new Set([...Object.keys(saved), ...Object.keys(current)])) {
    if ((saved[heading] ?? "").trim() !== (current[heading] ?? "").trim()) return true;
  }
  return false;
}

/** The three ways an approval is recorded, which is what `isApproved` counts and what the Finish
 *  panel's condition is written over. Exported because the rail labels them and the test asserts
 *  the set. */
export const BIBLE_APPROVED_STATES: readonly BibleState[] = ["approved", "imported", "written-by-author"];

/** Whether every gated bible file is approved — the condition the Finish panel appears under, and
 *  the client's half of `POST bible/finish`'s own refusal.
 *
 *  The two scaffold rows are skipped because they are never gated: `unapprovedBibleFiles`
 *  (`server/bible.ts`) skips them too, and a panel that waited for them would never appear at all.
 *  `null` — the rows have not answered yet — is false, so a Finish panel never flashes up for the
 *  length of a fetch and is then withdrawn. */
export function bibleFinishable(rows: BibleRow[] | null): boolean {
  if (rows === null || rows.length === 0) return false;
  return rows.every((row) => row.mode === "scaffold" || BIBLE_APPROVED_STATES.includes(row.state));
}

/** Whether a `setup` notice carries anything the open gate has not already been shown — the one
 *  question the Bible page's channel handler asks while a gate is on screen.
 *
 *  **The page does not refetch under an open gate**, because the attempt the author is reading is
 *  the attempt their answer will carry back as `expectedAttempt`; it raises a banner instead. The
 *  comparison here is what decides whether there is anything to raise one about: `at` is the
 *  notice's offset and `seen` the offset the view on screen was built from
 *  (`SetupRunView.offset`). A lock appearing or disappearing publishes the offset the store
 *  already holds — a run starting or stopping, with nothing new in the log — and the banner used to
 *  fire on those, telling the author "this file has written to its log since you opened the gate"
 *  when nothing had. A banner that cries wolf is a banner the author learns to ignore, and this is
 *  the one banner on the page that matters.
 *
 *  `seen` is `undefined` for a view with no run, where any notice is news. */
export function setupNoticeIsNews(at: number, seen: number | undefined): boolean {
  return at > (seen ?? 0);
}

/** A show name as a slug: every non-alphanumeric character removed, so "Harbor Lights" becomes
 *  "HarborLights". Nothing is lower-cased and nothing is substituted for a space.
 *
 *  **This is a copy of `slugFrom` in `tools/src/init/init.ts:117`, and it is a copy on purpose.**
 *  That function is exported from `@showrunner/tools` (`tools/src/index.ts`), but the module
 *  declaring it imports `node:path`, `node:fs/promises` and `@showrunner/engine` at its first three
 *  lines, so importing it here would pull `node:fs` into the browser bundle — the thing
 *  `shared/types.ts`' header forbids and the reason that file carries no value import from the
 *  engine. The New-show form must show the slug **before** the show is made, because the slug is
 *  rendered into `output.mixFilename` and into the names of files on the NAS, so deriving it on the
 *  server after the fact is not an option either.
 *
 *  The copy is pinned rather than trusted: `console/test/client/bible-projection.test.ts` imports
 *  `slugFrom` from `@showrunner/tools` — legal there, because the console's suite runs in Node — and
 *  asserts the two agree over a table of names. If the tools' rule changes, that test fails. */
export function showSlugFrom(name: string): string {
  return name.replace(/[^A-Za-z0-9]+/g, "");
}

/** The four answers a bible gate takes, as the engine's `GateChoice` spells them. */
export type GateChoiceKey = "approve" | "reject" | "myself" | "import";

/** The gate's four answers with the wording the author reads, in the order the terminal offers
 *  them.
 *
 *  **A copy of `GATE_CHOICES` in `tools/src/init/interview.ts`, for the reason `showSlugFrom`
 *  above records** — that module imports `node:fs/promises` and the engine — and pinned the same
 *  way: `console/test/client/bible-projection.test.ts` asserts these keys and labels equal
 *  `GATE_CHOICES`' imported from `@showrunner/tools`, in order. The wording is not the console's to
 *  improvise: the terminal and the browser must offer the same four answers and say the same thing
 *  about them, or an author who starts a setup in one and finishes it in the other is reading two
 *  different menus. A fifth answer invented here would be an answer `answerGate` has no meaning
 *  for. */
export const GATE_BUTTONS: readonly { key: GateChoiceKey; label: string }[] = [
  { key: "approve", label: "Approve this file as it stands" },
  { key: "reject", label: "Reject it with notes, and let the writer revise it" },
  { key: "myself", label: "I will write this one myself — write the empty template over it and approve" },
  { key: "import", label: "Import a file I already have — copy it over this one and approve" },
];


/** Whether the Shows page should say "no shows are registered yet" — true only when the console
 *  holds no shows **and** refused no registry entry.
 *
 *  The second half is the point. A machine whose every registry entry fails to load holds no shows,
 *  and the page used to draw the fresh-machine line for it: "no shows are registered yet — start
 *  one above". The remedy that line suggests is registering every show again, which is the wrong
 *  one and is destructive to look at — it is the same confusion `readRegistry`'s doc comment cites
 *  to make a malformed registry fatal rather than empty. `null` is "the list has not answered yet",
 *  which is not the empty machine either. */
export function showsPageIsEmpty(shows: unknown[] | null, failed: unknown[]): boolean {
  return shows !== null && shows.length === 0 && failed.length === 0;
}
