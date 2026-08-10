import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { costOfRun, projectLLMCost, spentSentence, type CostTotals } from '../cost.ts'
import type { Store } from '../db/store.ts'
import {
  artifactsOf,
  declareProvenance,
  recordArtifact,
  recordInputs,
  reviseArtifact,
  type Artifact,
  type ArtifactKind,
} from '../domain/artifact.ts'
import { positionsOf } from '../domain/arc.ts'
import { categoriesForArtifactKind } from '../domain/category.ts'
import { craftChecksFor } from '../domain/craft.ts'
import { delineateScript } from '../domain/delineate.ts'
import { routedNoteSentence, notesOwedBy } from '../domain/routing.ts'
import {
  advanceOnApproval,
  notYetReachedBecause,
  stayedAt,
  type LifecycleMove,
} from '../domain/lifecycle.ts'
import {
  delineateScenes,
  episodeInShow,
  episodeLabel,
  type Episode,
  type EpisodeInShow,
  type EpisodeLifecycle,
} from '../domain/spine.ts'
import {
  composeWriteContext,
  nameAppearingIn,
  producedBy,
  type ArcInContext,
  type EntityInContext,
  type FactReach,
  type WriteContext,
  type WriteStep,
} from '../domain/write-context.ts'
import { writeIfAbsent, type LibraryPaths } from '../library.ts'
import type { LLMEffort } from '../llm/adapter.ts'
import { CLAIM_EXTRACTION, extractTheCanonClaims } from './claim-step.ts'
import {
  correctionLoop,
  correctionNoteLines,
  MAX_CORRECTION_ROUNDS,
  type CorrectionOutcome,
  type Producer,
  type ProducerBrief,
} from './correction-loop.ts'
import type { Stage, StageCatalogue, StageOffer, Step, StepContext } from './step.ts'
import { checkTextAgainstCanon, TEXT_CHECK_CALL } from './text-check-step.ts'

/**
 * **The writing line, as stages** (E4-1/E4-2/E4-3, 1.1, 4.4) — the premise, the outline, the
 * script.
 *
 * One stage is one writing step: compose the desk, make one call, file what came back, run
 * the panel over it, correct it while the panel has something to say, and present whatever
 * it ends on for Ryan's ruling. The script stage does one more thing on the far side of that
 * ruling — it reads the approved draft for what it claims of canon (E4-4). Then, and only
 * then, the episode moves on.
 *
 * ## The desk is the only door onto canon, and that is the whole point
 *
 * `composeWriteContext` (E4-0) is what this reads, and it reads nothing else: no
 * `canonAsOf`, no `entitiesOfShow`, no `factsInScope`, no query of its own. A second
 * composer that "happens to agree" is the failure E4-0 exists to prevent — it agrees until
 * the day one of them learns something (the audience filter, a new inclusion door, a note
 * origin) and then two writers are handed two different worlds. If a later step needs
 * something canon-shaped that the desk does not carry, it goes in the desk.
 *
 * The proof is a captured prompt, not a comment, and it is made twice: `write-step.test.ts`
 * and `outline-stage.test.ts` each assert that a fact a LATER episode ratified is absent from
 * the prompt while one an EARLIER episode ratified is present, and that no entity the desk
 * left out appears anywhere in it. Only a prompt composed from the desk passes all of those at
 * once — which is the standard a third writing step is held to as well.
 *
 * ## Ryan's notes arrive through the desk too — there is no second channel
 *
 * The correction loop hands a producer `brief.ruling`, and this producer deliberately does
 * not read it. A rejection is a `gate_note` row; the desk reads those rows and composes the
 * sentence around them ("your round 1 rejection of the ep02 premise-brief, routed at premise
 * depth"), which is what a rewrite needs and what a bare array of strings cannot say. Reading
 * both would print his note twice; reading the argument instead of the record would lose the
 * attribution. What DOES come off the brief is `brief.findings` — the checks' own words about
 * the last draft, which are this loop's and die with it (`correction-loop.ts`).
 *
 * ## Provenance is declared out of what was WRITTEN
 *
 * Invariant 2 runs the other way for a writer: there is no upstream declaration to read,
 * because this step is what writes one. So the draft is matched against the entities the desk
 * handed over, through the desk's own matcher (`nameAppearingIn`), and what it names is what
 * it declares it touches. Two consequences, both wanted: a brief about Ilse convenes the
 * character check and nothing else (4.1), and an entity the writer was never handed can never
 * end up in provenance — a check would then be reading canon the writer never saw.
 *
 * It is additive across rounds, like every provenance write. A rewrite that stops mentioning
 * somebody has not un-touched them: the artifact is the record of what it has been about, and
 * the desk reads exactly that back so a rewrite does not forget a character the last draft
 * invented (write-context.ts).
 *
 * ## An outline is INTENT, and `num_scenes` is not its to decide (E4-2, 1.1, D3)
 *
 * The outline step is the second consumer of everything above and it adds no machinery at all
 * — everything new about it is what the step is FOR rather than how it runs. **An outline is
 * prose about the story's movement: what turns, in what order, and what the audience knows
 * after each turn.** It is not a scene list, and the ask below says so in as many words,
 * because the trap is a helpful model rather than a careless one: asked for structure, a model
 * writes a numbered grid, and a grid handed downstream is a scene count decided by the step
 * with the least right to decide it.
 *
 * Scenes are DERIVED from the written episode and never prescribed to it. `num_scenes` is an
 * output of the SCRIPT; the script writer reads the outline as intent and the scenes fall
 * where the story breaks. So there is no `scenes` field on anything here, this step writes no
 * scene row, and — the part that is easy to lose — **nothing parses the draft at all.** The
 * completion is filed verbatim, exactly as the premise's is. A parser that lifted "movements"
 * out of an outline would be the scene list arriving through the back door, with the added
 * insult of being inferred rather than asked for.
 *
 * ## And the script, where the scenes finally fall (E4-3, 1.1, D3)
 *
 * The third step is the second one again with a bigger ask — and one thing no other writing
 * step does: **when a script draft lands, its scenes are derived from it.** `num_scenes` is an
 * output and this is where the output happens (`domain/delineate.ts` holds the convention and
 * the identity rule; `delineateScenes` holds the write).
 *
 * Three properties, and each of them is a decision:
 *
 *   * **Per landed draft, inside the loop.** Findings anchor by scene, the continuity board is
 *     one row per scene, and the panel runs the moment the producer returns — so a draft
 *     checked against the PREVIOUS draft's grid would anchor this round's findings in last
 *     round's scenes. Delineation at approval would be a whole correction loop reading a stale
 *     grid, so it happens here, before the checks read a word.
 *   * **Derived before the bytes land.** A reply whose scenes cannot be read out of it is a
 *     reply nobody can use, so it throws before `writeIfAbsent` — which is what makes the
 *     runner's retry (invariant 5) buy a NEW draft rather than re-read the broken one three
 *     times. It is the same shape as `parseExtraction` and `readTextCheckReply`: nothing trusts
 *     the model, and nothing salvages half an answer. It has the same price, too, and the price
 *     is the point: three script calls for one draft, billed honestly, and then it is Ryan's
 *     with the attempt history rather than a scene grid nobody can anchor in.
 *   * **The ask names no count.** E4-2 kept a grid out of the outline so that this step could
 *     collect the restraint, and collecting it means the script writer decides how many scenes
 *     there are — the ask says the count is the writer's, and says not to match the outline's
 *     movements one for one. What the ask DOES name is the heading convention, because a scene
 *     is its heading and two the same cannot be told apart afterwards.
 *
 * ## And then what the script did to canon (E4-4, 1.2, D8)
 *
 * The script stage carries a third step the other two do not, and it runs on the far side of
 * the gate: `extractTheCanonClaims` reads the draft Ryan approved and raises what it claimed —
 * fact deltas riding the episode, and one landing per arc position it declares, each with the
 * subject the writer answered. **It raises and stops.** Nothing about it writes canon; the
 * proposals wait for him at the completion sweep (`domain/episode-canon.ts`).
 *
 * The whole argument for where it sits — after the gate, inside this run, before the close —
 * is in `claim-step.ts`. What belongs here is the consequence for this file: the button's cost
 * sentence grows a clause for the spend that lands after the approval, because one click buys
 * the whole run and the sentence has to cover the whole run.
 *
 * ## Where "it already has one" is enforced, and where it deliberately is not
 *
 * An episode that already has an artifact of this kind has nothing for the stage that writes
 * that kind to do, and that is said in `offerOn` — which is where a run is started from, and
 * which the API refuses with the same string (D15, `operating.ts`). It is **not** re-checked
 * inside the producer, which
 * breaks the usual "every step checks its own preconditions" rule on purpose: once the loop
 * owns a draft it must be free to rewrite it, and there is no honest way for a producer to
 * tell its own draft from one that was there before the run — every discriminator available
 * (a gate that has not opened yet, an attempt counter, a file path) is wrong on the resumed
 * path this app is built for. The precondition is about whether a run should START, so it
 * lives where runs start.
 *
 * What holds unconditionally is the rule underneath it: **files are never overwritten.** Each
 * round writes its own path through `writeIfAbsent`, so a hand-made draft survives on the
 * volume whatever anybody enqueues — D20 is kept by the bytes, not by the button.
 *
 * ## The second precondition: a writing step writes from something RULED (E4-2)
 *
 * The outline is written from an approved premise-brief, and the column that says whether one
 * was approved is the lifecycle — because an approval is the only thing that moves it
 * (`domain/lifecycle.ts`). So `offerOn` consults `notYetReachedBecause`, and an episode still
 * at `premise` is refused in words before the click rather than by a run that spends a call
 * and then discovers there is nothing upstream. The desk would have said so too — its
 * `upstream.note` reads "ep02 has no premise-brief yet" — but a producer discovering it has
 * already started a run, and "preconditions before the button" is a promise about screens.
 *
 * It is declared once, for every writing stage, by the same builder that carries the lifecycle
 * seam. On the premise stage it can never fire (premise is the first stop), which is not an
 * exemption but the same fact E4-1 recorded from the other side.
 *
 * ## And the wall, which the outline is the first real stage to stand behind (D12)
 *
 * `work: 'produces'` is what puts D12's wall in front of a stage, and E4-1 could not
 * demonstrate it: the premise is the FIRST artifact an episode has, so an episode with
 * material standing against it always has a brief already, and "nothing to do" answers ahead
 * of the wall — correctly. The outline is the first stage in this app that produces from
 * material an episode really has, so a deterministic finding standing against the ep02
 * premise-brief refuses the ep02 outline with the wall's own sentence, and stops refusing it
 * the moment Ryan rules on the finding. Nothing here implements that; it is `stage-wall.ts`
 * computing over live rows, and the only thing this file does is declare honestly what it does
 * with the material.
 *
 * ## The lifecycle seam is structural, not a convention
 *
 * Every writing stage is built by `writingStage` below, and it puts the closing step on
 * every one of them: a gate approved (or overridden) is what moves the episode on, through
 * `advanceOnApproval` (domain/lifecycle.ts), which owns the four rules. A stage cannot be
 * added to this file without it, which is the difference between a seam and a habit.
 *
 * ## The smoke path, documented and not run
 *
 * `npm test` never reaches the network. To watch a real premise get written, on real money,
 * by hand:
 *
 *     LIBRARY_DIR=/tmp/showrunner-smoke PORT=4460 npm run fixture:load
 *     LIBRARY_DIR=/tmp/showrunner-smoke PORT=4460 npm start
 *     # then POST the run: {"episodeId": "<ep02>", "stage": "write-the-premise"}
 *     # approve its gate, and POST again with "stage": "write-the-outline"
 *
 * **Always with `LIBRARY_DIR` at a scratch path and never on 4455** — a bare boot migrates
 * and writes Ryan's own library (#49).
 */

/** The stage names, as they are persisted on `run.stage` and as the API takes them. */
export const PREMISE_STAGE = 'write-the-premise'
export const OUTLINE_STAGE = 'write-the-outline'
export const SCRIPT_STAGE = 'write-the-script'

/**
 * The writing line as a map from the lifecycle stop an episode is AT to the stage that does
 * that stop's work — the thing E4-2 could not close because there was a hole in it (#62).
 *
 * It is `Partial` and it always will be: `assets`, `assembled` and `published` are E6's and
 * E7's, and a map that pretended to cover them would be a button promising work no code does.
 * `operating.ts` is what decides what a card offers when there is no writing left to do.
 */
export const WRITING_STAGE: Partial<Record<EpisodeLifecycle, string>> = {
  premise: PREMISE_STAGE,
  outline: OUTLINE_STAGE,
  script: SCRIPT_STAGE,
}

/**
 * The effort behind every draft, and it is one number for all three steps on purpose.
 *
 * `medium` is the writing tier: below the checks' `high` (4.2 gives thinking to the pass that
 * has to hold three facts and a scene in mind at once) and well above extraction's `low`,
 * because writing is neither transcription nor adjudication. What VARIES between the steps is
 * how much prose comes back, and that is the ask's business below rather than this one's.
 */
export const WRITE_EFFORT: LLMEffort = 'medium'

/** What the closing step returns: the ruling, where it left the episode, and what it cost. */
export interface WriteClose {
  artifactId: string
  /**
   * How the round that closed the gate was ruled. `reject` is E4-5's: every note was routed
   * away from this draft, so nothing was rewritten and nothing moved (D21).
   */
  verdict: 'approve' | 'override' | 'reject'
  gateRound: number
  /** Where the approval left the episode on the lifecycle, and why (domain/lifecycle.ts). */
  lifecycle: LifecycleMove
  spend: CostTotals
  sentence: string
}

/**
 * The writing stages this build ships — the whole line, since E4-3. Each one is a line here
 * and an entry in `WRITING` below: TypeScript and a test, never a row (Archon).
 */
export function writeStages(library: LibraryPaths): StageCatalogue {
  return {
    [PREMISE_STAGE]: writingStage(library, 'premise', PREMISE_STAGE),
    [OUTLINE_STAGE]: writingStage(library, 'outline', OUTLINE_STAGE),
    [SCRIPT_STAGE]: writingStage(library, 'script', SCRIPT_STAGE),
  }
}

/**
 * What one writing step is asked for, how much prose that is, and where the ceiling sits.
 *
 * ## Why the three numbers travel together
 *
 * E4-1 had one `WRITE_CALL` and one `WRITE_MAX_TOKENS`, which was right while there was one
 * step. They are per-step here because the steps are not the same size — a premise-brief is
 * 300 words, an outline is 700, and E4-3's script is thousands — and the two numbers are the
 * two halves of the same fact: what the button promises before the click and what the call is
 * allowed to spend making good on it. Split across two tables they would drift into a stage
 * that projects one draft and truncates another; keyed by step in one table they cannot.
 *
 * `call` is deliberately generous against what is really sent: the desk carries every core
 * entity's prose, its facts, the season's arcs, and — from the outline on — the whole ruled
 * artifact above. Over-stating is the safe direction for a number on a button, and the ledger
 * afterwards is what was actually spent (cost.ts).
 *
 * `maxTokens` is generous for a second reason: Opus thinks by default and thinking is billed
 * as output, so a ceiling a model's reasoning eats before a word is written is a truncated
 * artifact that reads as a finished one.
 */
interface WritingAsk {
  /** What the model is asked for, in the words it is asked in. */
  instructions: string[]
  /** What one call of it is projected to cost, for the button (cost.ts). */
  call: { promptTokens: number; outputTokens: number }
  /** The ceiling on one draft. Hitting it is filed, and Ryan is told (invariant 4). */
  maxTokens: number
}

/**
 * What each writing step is asked for.
 *
 * A TypeScript object in a TypeScript file, like `CRAFT_REVIEWER` and for the same reason
 * (craft.ts): what a premise IS reads the same for Grey Harbor and for Dead Light, there is
 * no sheet for it to live on, and nothing reads this to decide what to run. It is not a
 * stage described in data — the stages are the functions below (Archon).
 */
const WRITING: Record<WriteStep, WritingAsk> = {
  premise: {
    call: { promptTokens: 8000, outputTokens: 1200 },
    maxTokens: 4000,
    instructions: [
      'Write the premise-brief for this episode: what goes wrong, who it goes wrong for, and',
      'why it matters now rather than in some other episode. Prose — 150 to 300 words, no',
      'headings, no bullet points, no preamble, and no title.',
      '',
      'Three things it has to do:',
      '',
      '1. **Stand on the canon above and not beside it.** Use the entities you have been',
      '   given, by the names they carry, so that what this brief touches is readable from',
      '   the brief itself. What you were not given, you were not given: do not reach for a',
      '   character, a place or a rule that is not above.',
      '2. **Be about a change.** Say what is true at the start and what is true at the end.',
      '   A situation is not a premise.',
      '3. **Obey the world rules and the house style exactly.** They are the prose the show',
      '   does not get to bend.',
      '',
      'You may invent what the episode needs — a fault, an object, a piece of weather. What',
      'you invent is a CLAIM and not canon: nothing here writes canon, and only Ryan ruling a',
      'proposal ever does (invariant 1).',
      '',
      'Return the brief and nothing else.',
    ],
  },
  /**
   * **The outline: intent, never a scene list** (1.1, D3, 4.1).
   *
   * Half of this ask is a prohibition, and it earns the room. Asked for "the structure of the
   * episode", a helpful model returns a numbered grid — which is a scene count, decided before
   * anybody has written a line, by the step with the least right to decide it. The refusal is
   * stated with its reason rather than as a formatting rule, because a model told only "no
   * numbers" writes the same grid with dashes.
   */
  outline: {
    // The prompt carries the ruled brief on top of the desk, and the answer is two to three
    // times a premise. Both numbers are the outline's own, and E4-3's script will be larger
    // again — which is the whole reason they are keyed by step.
    call: { promptTokens: 10000, outputTokens: 2400 },
    maxTokens: 6000,
    instructions: [
      'Write the outline for this episode: **the movement of the story**, in prose. What turns,',
      'in what order, and what the audience knows after each turn that they did not know before',
      'it. 400 to 700 words. Head each movement with a short line naming it — “Morning, inboard”,',
      '“The pier”, “After” — and write the movement itself as prose beneath it.',
      '',
      '**This is not a scene list, and that is the one thing it must not become.** Do not number',
      'anything, do not break it into scenes, and do not say anywhere how many there will be.',
      'Scenes are DERIVED from the written episode and never prescribed to it: the script is',
      'written from this as INTENT, and the scenes fall where the story turns out to break. An',
      'outline that hands the script a grid has decided something it cannot know — the count',
      'would be about an episode nobody has written yet — and the script writer would obey it.',
      '',
      'Four things it has to do:',
      '',
      '1. **Keep the premise-brief above.** It is ruled, and it is what you are writing from.',
      '   The outline is that brief moved through time; it is not a second draft of it, and it',
      '   does not get to change what the episode is about.',
      '2. **Turn.** Each movement leaves something different true from what was true when it',
      '   started. A movement that only continues the last one is two movements’ worth of words',
      '   spent on one, and it is the thing this artifact exists to expose before a script does.',
      '3. **Say what the audience learns, and when.** Withholding is a decision — name it. If a',
      '   thing is known to a character and not to the audience, say so where it happens.',
      '4. **Stand on the canon above and obey the world rules and the house style exactly.**',
      '   They are the prose the show does not get to bend. Use the entities you were given, by',
      '   the names they carry; what you were not given, you were not given.',
      '',
      'You may invent what the episode needs. What you invent is a CLAIM and not canon: nothing',
      'here writes canon, and only Ryan ruling a proposal ever does (invariant 1).',
      '',
      'Return the outline and nothing else.',
    ],
  },
  /**
   * **The script: the outline written, and the scenes where they fall** (1.1, D3, 4.1).
   *
   * The outline above it carries no grid, on purpose and at some cost (E4-2). This is the ask
   * that collects the restraint: the count is stated to be the writer's, and the one thing that
   * would quietly hand it back — "one scene per movement" — is refused in words with its reason,
   * because a model given a numbered outline and a scene format will pair them off.
   *
   * What the ask DOES fix is the heading, because a scene is its heading
   * (`domain/delineate.ts`): the format is stated exactly, and so is the rule that two scenes
   * may not share one, since two identical headings cannot be told apart in the text afterwards
   * and every span after the first would be wrong.
   */
  script: {
    // The prompt is the outline's desk plus the whole ruled outline (700 words) plus this ask,
    // and the desk grows with canon — over-stating is the safe direction for a number on a
    // button (E3-7's rule, and the ledger afterwards is what was really spent).
    //
    // The output is the one number here that is not a guess at a prompt. The fixture's own
    // six-scene script is ~1,100 tokens and it is a demonstration rather than an episode; a
    // full episode of this show is several times it, so 9,000 is the generous shape of one.
    // The CEILING is nearly three times the projection for the reason E4-1 recorded: Opus
    // thinks by default, thinking is billed as output, and a ceiling the reasoning eats before
    // a word is written is a truncated script that reads as a finished one.
    call: { promptTokens: 16000, outputTokens: 9000 },
    maxTokens: 24000,
    instructions: [
      'Write the script for this episode. Break it into scenes where the story breaks, and head',
      'every scene exactly like this:',
      '',
      '    ## 1 · INT. GREY HARBOR STATION — MESS DECK — 06:10',
      '',
      '    > One line saying what this scene does.',
      '',
      'An ordinal, a middle dot, then the heading: inside or outside, where, and when. Number',
      'them in the order you write them. Under the heading put the one-line summary as a',
      'blockquote, and under that the scene itself — action in the present tense, and each',
      'speaker’s name on its own line above what they say.',
      '',
      '**Every heading must differ from every other one.** A scene IS its heading: that is how',
      'a note, a finding or a rewrite says which scene it means, so two scenes called the same',
      'thing cannot be told apart afterwards. Say the hour, or the side of the hull, or which',
      'pass at the pier.',
      '',
      '**How many scenes there are is yours to decide, and nothing above has decided it.** The',
      'outline is INTENT — the movement of the story — and it is deliberately not a scene list.',
      'Do not pair its movements off against scenes: one movement may take three scenes and',
      'three movements may take one. Write the episode, and count the scenes afterwards.',
      '',
      'Five things it has to do:',
      '',
      '1. **Be the outline, written.** It is ruled, and it is what you are writing from. Every',
      '   movement in it happens here, in the order it happens there, and nothing that is not in',
      '   it becomes the point of the episode.',
      '2. **Put every scene in a place, at a time.** The heading says both. Where a scene runs',
      '   straight on from the one before it, say CONTINUOUS in place of the clock — and mean it,',
      '   because a body cannot be in two places at one time and the continuity board reads',
      '   these headings to find out.',
      '3. **Obey the world rules and the house style exactly.** They are the prose the show does',
      '   not get to bend. What the rules make impossible does not happen off screen either.',
      '4. **Stand on the canon above.** Use the entities you were given, by the names they carry.',
      '   What you were not given, you were not given.',
      '5. **Put it on screen.** What the audience cannot see or hear is not in the script — no',
      '   interiority, no narration of what somebody is thinking. If it matters, it happens.',
      '',
      'You may invent what the episode needs. What you invent is a CLAIM and not canon: nothing',
      'here writes canon, and only Ryan ruling a proposal ever does (invariant 1).',
      '',
      'Return the script and nothing else.',
    ],
  },
}

const SYSTEM =
  'You are writing episodes of a television show with its showrunner. You are handed the ' +
  'canon this episode’s audience already knows, the arcs it is written under, and whatever ' +
  'the showrunner has already said about it. Answer with the artifact you were asked for and ' +
  'nothing else: no preamble, no explanation of your choices, no notes to the showrunner.'

// ── The stage ───────────────────────────────────────────────────────────────────

function writingStage(library: LibraryPaths, step: WriteStep, name: string): Stage {
  const producer = writer(library, step)
  return {
    name,
    // It writes the next artifact, which is what puts D12's wall in front of it (step.ts).
    // The premise is the first thing an episode has, so in practice there is never material of
    // its own standing against it; the OUTLINE is the first stage in this app the wall can
    // really refuse, and `outline-stage.test.ts` is where it stands up and falls down again.
    work: 'produces',
    steps: [
      correctionLoop(producer, checkTextAgainstCanon(library, producedBy(step))),
      // The extraction, on the script alone (E4-4). It reads the draft Ryan has just APPROVED,
      // which is why it is here rather than inside the loop, and it is inside this run so that
      // the launch click he already made is the one that pays for it (`claim-step.ts` argues
      // both). It sits BEFORE the close so the closing step's `costOfRun` covers what it spent
      // and so the episode still moves on last, when the stage's work is really finished.
      //
      // The premise and the outline are deliberately not extracted. A premise-brief's claims
      // are the script's claims three drafts earlier — the same facts, raised twice, ruled
      // twice, and the second ruling arguing with prose the first one has already replaced.
      // The script is the artifact the episode ships, and its claims are the episode's.
      ...(step === 'script' ? [extractTheCanonClaims(library, producer.name)] : []),
      advancePastTheGate(step, producer.name),
    ],
    offerOn: (store, episode): StageOffer => offerFor(store, episode, step),
  }
}

/**
 * What running this stage on this episode would say, cost and need — E3-7's declaration, and
 * the whole of the button (step.ts, `StageOffer`).
 *
 * **The reviewers can only be an upper bound, and it says so.** How many category checks
 * convene depends on who the brief turns out to be about (4.1), and the brief does not exist
 * yet; what is knowable before the click is how many categories DECLARE this kind, how many
 * arc positions the episode declares, and the craft reviewers the kind is read by. Counting
 * the declared categories over-states, which is the safe direction — a button that
 * under-states is a button that lies cheaply.
 *
 * **The two preconditions, in this order.** "There is already one of those" comes first,
 * because it is the answer with nothing left to do behind it: an episode holding a draft
 * wants a ruling or an edit whatever its column says, and telling Ryan to go and approve
 * something upstream would send him to fix a problem that has already been overtaken. Only
 * then the lifecycle — nothing written, and nothing ruled to write it from.
 */
function offerFor(store: Store, episode: Episode, step: WriteStep): StageOffer {
  const kind = producedBy(step)
  const label = episodeLabel(episode.number)
  const where = episodeInShow(store, episode.id)
  const reviewers =
    where === undefined
      ? 0
      : categoriesForArtifactKind(store, where.show.id, kind).length +
        positionsOf(store, episode.id).length +
        craftChecksFor(kind).length

  const write = projectLLMCost(WRITING[step].call)
  const panel = projectLLMCost({ ...TEXT_CHECK_CALL, calls: reviewers })
  const standing = writtenOfKind(store, episode.id, kind)
  // **The already-has-one refusal yields to an unanswered note, and to nothing else** (E4-5,
  // D21). A note standing against this artifact is work this stage owes and nobody else can
  // do; until a newer version of it exists the note is unanswered, and that is derived rather
  // than flagged (`domain/routing.ts`). Nothing regenerates because of it — what changes is
  // that the button is pressable and says why.
  //
  // **`notesOwedBy` and not the desk's reader** (#76): the desk drops a note Ryan wrote at this
  // artifact's own gate, because it has read those as ordinary rejections since E4-0 and would
  // otherwise print his words to a writer twice. Read here that exclusion drops the only note a
  // PRESENTING gate can write — it has no producer behind it, so its rejections are always
  // written over the artifact they name — and an episode holding an artifact no writing gate
  // ever approved had no door out of its lifecycle stop. Two questions, two functions.
  const routed = standing ? notesOwedBy(store, standing.id) : []

  return {
    sentence:
      routed.length > 0
        ? `Write the ${label} ${kind} again from the writer’s desk — ` +
          `${routedNoteSentence(routed, `the ${label} ${kind}`)}`
        : `Write the ${label} ${kind} from the writer’s desk and present it for your ruling — ` +
          `“${episode.title}”, one call, then up to ${reviewers} reviewer${
            reviewers === 1 ? '' : 's'
          } read it`,
    cost:
      `${write.sentence} + up to ${panel.sentence} to check it, per draft — and the loop ` +
      `stops at ${MAX_CORRECTION_ROUNDS} drafts (invariant 5)` +
      // The spend that lands on the far side of the gate, said before the click that buys it
      // (E4-4). One click covers the whole run, so the sentence has to cover the whole run:
      // a cost that arrives after a ruling is still a cost Ryan agreed to, and a button that
      // left it out would be a button that lies cheaply.
      (step === 'script'
        ? `, then ${CLAIM_EXTRACTION.sentence} after you approve it, to read what the script ` +
          'claims of canon into proposals for your ruling'
        : ''),
    callsModel: true,
    nothingToDoBecause:
      standing === undefined
        ? notYetReachedBecause(store, episode.id, step)
        : routed.length > 0
          ? null
          : alreadyWrittenBecause(label, standing),
  }
}

/**
 * The episode's artifact of this kind, whatever slot it sits in — and therefore whether this
 * stage has anything to do at all.
 *
 * **Slot-agnostic on purpose, and deliberately wider than what the producer looks for.** The
 * producer owns the singular slot and writes only there; this question is "does a premise for
 * this episode exist", and a brief E1's retired demo stage wrote into its own slot is still a
 * premise for this episode. A hand-made asset always wins and re-runs fill gaps only (D20):
 * the answer to "there is one already" is to rule on it or edit it, never to write a second.
 *
 * **Exported because the sentence that refuses on it promises a gate** (E4-5). "Rule on it at
 * its gate" has to open over the artifact this question found, slot and all, or the refusal
 * points at a door that is not there — which is exactly ep02's demo-era brief in Ryan's own
 * library. `present-step.ts` asks this rather than the checks' narrower one, and the two
 * questions stay different on purpose: a check reads the draft the producer owns.
 */
export function writtenOfKind(
  store: Store,
  episodeId: string,
  kind: ArtifactKind,
): Artifact | undefined {
  return artifactsOf(store, episodeId).find((artifact) => artifact.kind === kind)
}

/** One sentence, two readers — the disabled button states it and the API refuses with it. */
const alreadyWrittenBecause = (label: string, standing: Artifact): string =>
  `${label} already has ${article(standing.kind)} ${standing.kind}${
    standing.slot === '' ? '' : `, in slot “${standing.slot}”`
  } — rule on it at its gate, or edit it directly (E4-5).`

/**
 * "a premise-brief", "an outline" — the article an artifact kind takes.
 *
 * A vowel test rather than a lookup table, because `ArtifactKind` grows and a table would be
 * missing its newest member on the day it was added, silently and in Ryan's face. E4-1 wrote
 * "a ${kind}" while there was one writing stage and it read correctly; E4-2 was the second
 * kind to reach the sentence and it read "a outline", which is what a second consumer is for.
 */
const article = (kind: ArtifactKind): string => (/^[aeiou]/i.test(kind) ? 'an' : 'a')

// ── The producer ────────────────────────────────────────────────────────────────

/**
 * The writing half of the stage: compose the desk, make one call, file the draft.
 *
 * The two rules the loop enforces rather than trusts (`correction-loop.ts`) are both kept
 * here: a round whose draft is already on the volume makes no second call, and every round
 * writes a NEW VERSION of the artifact, because the round history IS the versions.
 */
function writer(library: LibraryPaths, step: WriteStep): Producer {
  const kind = producedBy(step)
  const find = (context: StepContext): Artifact | undefined =>
    // The singular slot, and only it. What the OFFER asks is a wider question — see
    // `alreadyWritten` — and answering both with one read would have this producer adopt a
    // demo-era artifact as the draft it is rewriting.
    artifactsOf(context.store, context.episodeId).find(
      (artifact) => artifact.kind === kind && artifact.slot === '',
    )

  return {
    name: `write-the-${kind}`,
    find,

    async produce(context: StepContext, brief: ProducerBrief): Promise<void> {
      const desk = composeWriteContext(context.store, library, {
        episodeId: context.episodeId,
        step,
      })
      const where = desk.where
      const filePath = join(
        where.show.key,
        `s${pad(where.season.number)}e${pad(where.episode.number)}`,
        `${kind}-round-${brief.round}.md`,
      )
      const onDisk = join(library.artifactDir, filePath)

      // ── The draft for this round ─────────────────────────────────────────────
      // Already there — a crash between writing it and recording the row, or Ryan's own
      // hand? It is what he rules on, and no call is made for it. Re-runs fill gaps only
      // (D20), and here that rule is worth money as well as bytes.
      let text: string
      let called = false
      if (existsSync(onDisk)) {
        context.progress(
          `Round ${brief.round}’s draft was already in the library — kept as it stands, and no ` +
            'call made for it',
        )
        text = readFileSync(onDisk, 'utf8')
      } else {
        context.progress(desk.sentence)
        const ceiling = WRITING[step].maxTokens
        const completion = await context.llm.complete({
          system: SYSTEM,
          prompt: composeWritePrompt(desk, brief),
          maxTokens: ceiling,
          effort: WRITE_EFFORT,
        })
        text = `${completion.text.trim()}\n`
        called = true
        // 'max_tokens' means the draft stops mid-sentence. It was paid for and it is real, so
        // it is filed and it goes to the panel and to Ryan like any other draft — but he is
        // told, rather than handed something truncated that reads as finished (invariant 4).
        if (completion.stopReason === 'max_tokens') {
          context.progress(
            `The model stopped at the ${ceiling}-token ceiling — the draft below stops ` +
              'mid-sentence',
          )
        }
      }

      // ── The scenes, derived, before a single byte lands ──────────────────────
      // Scenes are an OUTPUT of the written episode (1.1, D3) and this is the step whose draft
      // has them. It runs here — before the file, before the row, and therefore before the
      // panel the loop is about to convene — for two separate reasons:
      //
      //   * a draft whose scenes cannot be read out of it is a reply nobody can use, and
      //     throwing before `writeIfAbsent` is what makes the runner's retry buy a NEW draft
      //     rather than re-read the broken one three times (invariant 5); and
      //   * findings anchor by SCENE, so the grid a round is checked against must be this
      //     round's. Delineating at approval instead would run a whole correction loop against
      //     the last draft's scenes.
      const drafted = step === 'script' ? delineateScript(text, draftLabel(desk, step)) : undefined

      if (called) {
        mkdirSync(dirname(onDisk), { recursive: true })
        // Belt and braces with the check above: the same rule, once for the money and once
        // for the bytes. Nothing this app writes may land on a file already there.
        writeIfAbsent(onDisk, text)
      }
      if (drafted) {
        // Re-delineated every version, and a scene is its heading — so a rewrite that moves a
        // scene keeps its id and its anchors, and one that renames a scene raises a new one
        // (`domain/delineate.ts`).
        delineateScenes(context.store, context.episodeId, drafted)
        context.progress(
          `${draftLabel(desk, step)} breaks into ${drafted.length} scene${
            drafted.length === 1 ? '' : 's'
          } — derived from the draft, never asked for`,
        )
      }

      // ── The row, and what it declares it touches ─────────────────────────────
      const touches = desk.entities
        .filter((held) => nameAppearingIn(text, held.entity) !== undefined)
        .map((held) => held.entity.id)

      // ── The freshness edge, declared out of what it READ ─────────────────────
      // The desk handed this step the ruled artifact above it, so the draft is built from that
      // artifact at that version — and saying so is what makes "edit the outline and the
      // script says it was built from a draft the outline has moved past" a computation over
      // edges rather than a thing anybody remembers (1.3, `domain/artifact.ts`). The fixture's
      // own episodes have carried these edges since E1-7; before E4-5 nothing the APP wrote
      // did, so a hand edit upstream staled nothing it had written itself.
      //
      // Re-recorded every round, never only on the first: `recordInputs` moves the edge to the
      // version standing now, which is what makes a rewrite AFTER an upstream edit come back
      // fresh instead of staying stale forever.
      const builtFrom = desk.upstream.artifact
        ? [{ artifactId: desk.upstream.artifact.id }]
        : []

      const standing = find(context)
      if (!standing) {
        recordArtifact(context.store, {
          episodeId: context.episodeId,
          kind,
          filePath,
          touches,
          builtFrom,
        })
        return
      }
      declareProvenance(context.store, standing.id, touches)
      if (builtFrom.length > 0) recordInputs(context.store, standing.id, builtFrom)
      reviseArtifact(context.store, standing.id, {
        summary:
          brief.findings.length > 0
            ? `rewritten against ${brief.findings.length} finding(s) from round ${brief.round - 1}`
            : `rewritten against your ruling on round ${brief.round - 1}`,
        filePath,
      })
    },
  }
}

// ── The closing step: the ruling moves the episode on ───────────────────────────

/**
 * What happens on the far side of the gate: the episode moves, and the run says what it
 * spent doing it.
 *
 * It is a second step rather than a tail on the first for the reason E1's demo already had
 * one — a ruling has to visibly send the run ONWARD rather than merely un-pause it — and for
 * a second reason that is E4's: `advanceOnApproval` runs exactly once per approval, on a step
 * that is idempotent and re-runnable, and never inside the loop that may still be arguing
 * with itself.
 */
function advancePastTheGate(step: WriteStep, producerName: string): Step<WriteClose> {
  return {
    name: `advance-past-the-${step}-gate`,
    inputs: [producerName],

    async execute(context: StepContext): Promise<WriteClose> {
      const outcome = context.input<CorrectionOutcome>(producerName)
      // **An approval is the only thing that moves an episode on** (E4-1). A rejection whose
      // notes were all routed elsewhere ends the stage without one, so this says where the
      // episode stayed rather than passing a rejection through the function that advances on
      // approvals (`domain/lifecycle.ts`).
      const where = episodeInShow(context.store, context.episodeId)
      const lifecycle =
        outcome.verdict === 'reject'
          ? stayedAt(
              context.store,
              context.episodeId,
              `${where ? episodeLabel(where.episode.number) : 'The episode'} stays at ${step} — ` +
                `you rejected it and routed ${
                  outcome.routed.length === 1 ? 'the note' : 'every note'
                } elsewhere, and a rejection is not an approval.`,
            )
          : advanceOnApproval(context.store, context.episodeId, step)
      const spend = costOfRun(context.store, context.runId)
      const sentence =
        `${
          outcome.verdict === 'override'
            ? 'Overridden'
            : outcome.verdict === 'reject'
              ? 'Rejected and routed away'
              : 'Approved'
        } at round ` + `${outcome.gateRound} · ${lifecycle.sentence} · ${spentSentence(spend)}`

      context.progress(sentence)
      return {
        artifactId: outcome.artifactId,
        verdict: outcome.verdict,
        gateRound: outcome.gateRound,
        lifecycle,
        spend,
        sentence,
      }
    },
  }
}

// ── The prompt ──────────────────────────────────────────────────────────────────

/**
 * The desk, as the words a model is handed — **composed out of the `WriteContext` and out of
 * nothing else.**
 *
 * Exported so a test can read it without a runner, and so E4-7's "what the writer was handed"
 * inspector renders the same string that was sent rather than a reconstruction of it.
 */
export function composeWritePrompt(context: WriteContext, brief: ProducerBrief): string {
  const label = episodeLabel(context.where.episode.number)
  const kind = producedBy(context.step)
  const asked = WRITING[context.step]

  return [
    ...identity(context.where),
    '',
    `── WHAT YOU ARE WRITING FROM ──`,
    context.upstream.text === null
      ? (context.upstream.note ?? 'Nothing.')
      : `The ${label} ${context.upstream.expected}, whole:\n\n${context.upstream.text}`,
    '',
    `── CANON, AS THE ${label} AUDIENCE KNOWS IT ──`,
    'This is everything you have. It is what this episode’s audience already knows and no',
    'more — a later episode’s canon is not on this page, deliberately.',
    ...context.entities.flatMap((held) => entityLines(held)),
    '',
    `── THE ARCS ${label} IS WRITTEN UNDER ──`,
    ...arcLines(context.arcs, context.vanilla, label),
    ...noteLines(context.notes),
    // The CHECKS' half of the brief, and deliberately only that half: `brief.ruling` is
    // Ryan's, and it has already arrived above through the desk, with its round on it.
    ...correctionNoteLines({ ...brief, ruling: [] }),
    '',
    `── WRITE THE ${label} ${kind.toUpperCase()} ──`,
    ...asked.instructions,
  ].join('\n')
}

const identity = (where: EpisodeInShow): string[] => [
  `Show: “${where.show.title}”.`,
  `Season ${where.season.number}${where.season.title ? ` — “${where.season.title}”` : ''}, ` +
    `episode ${where.episode.number}: “${where.episode.title}”.`,
  `That episode is at the “${where.episode.lifecycle}” stage of its lifecycle, which is the ` +
    'stage it is DOING and not one it has finished.',
]

/** One entity: why it is here, its prose, what it brings, and what it could not answer. */
function entityLines(held: EntityInContext): string[] {
  const entity = held.entity
  const also = entity.aliases.length === 0 ? '' : ` · also called ${entity.aliases.join(', ')}`
  const lines = [
    '',
    `### ${entity.name} — ${entity.categoryKey}, standing ${entity.standing ?? 'undeclared'}${also}`,
    `On your desk because: ${held.reasons.map((reason) => reason.because).join('; ')}.`,
  ]
  if (entity.body.trim() !== '') lines.push('', entity.body.trim())

  if (held.facts.length > 0) {
    lines.push('', 'What is true about them:')
    for (const fact of held.facts) {
      const from =
        fact.inherited === null
          ? ''
          : ` — inherited from “${fact.inherited.source.name}”, along \`${fact.inherited.via}\``
      lines.push(`- ${fact.fact.statement} (${REACH[fact.reach]}${from})`)
    }
  }
  // Never folded into the facts. A writer told "her species is undecided" writes differently
  // from one told nothing at all (invariant 4, one layer off the checks).
  if (held.gaps.length > 0) {
    lines.push('', 'What canon has not decided about them:')
    for (const gap of held.gaps) lines.push(`- ${gap.because}.`)
  }
  return lines
}

/**
 * The audience-knowledge door a fact came through, in words a writer can act on.
 *
 * **Exported for E4-7's desk inspector**, and typed to the closed set rather than to `string`
 * so a fifth reach cannot be added without this map failing to compile. The inspector answers
 * "why did the writer know that" with the same four sentences the prompt below hands the model
 * — a second vocabulary on the screen would let Ryan read one thing and the writer be told
 * another, which is the whole failure the desk exists to make impossible.
 */
export const REACH: Record<FactReach, string> = {
  'show-level': 'show canon, true before the first episode',
  'established-earlier': 'established in an earlier episode, already on screen',
  'established-here': 'established in this episode',
  riding: 'claimed by this episode and not yet ruled — provisional, and yours to keep true',
}

function arcLines(arcs: ArcInContext[], vanilla: boolean, label: string): string[] {
  if (arcs.length === 0) return ['This show declares no arcs.']

  const lines = arcs.flatMap((held) => [
    '',
    `### ${held.arc.name} — a ${held.arc.kind} arc, scoped to the ${held.arc.scope}`,
    held.arc.statement,
    ...held.waypoints.map(
      (waypoint) =>
        `- waypoint ${waypoint.ordinal}, ${waypoint.name}: ${waypoint.description} ` +
        `Landing it looks like: ${waypoint.landingCriteria}`,
    ),
    held.position === null
      ? `${label} declares no position on this arc.`
      : `${label} is declared at waypoint ${held.position.waypoint.ordinal} — ` +
        `${held.position.waypoint.name}. Land it.`,
  ])

  if (vanilla) {
    lines.push(
      '',
      `${label} declares no position on any arc. That is **vanilla** — legal, tracked, and ` +
        'never a failure state. Do not invent a landing to have one.',
    )
  }
  return lines
}

/**
 * What Ryan has already said, newest first — his rejections of this artifact and the findings
 * he has put down elsewhere, each carrying the sentence the desk composed around it.
 *
 * The sentence is the load-bearing part: "your round 2 rejection of the ep02 outline, routed
 * at scene depth" is a different instruction from the same words with no attribution, and it
 * is why this is read off the desk rather than off the loop's `brief.ruling`.
 */
function noteLines(notes: WriteContext['notes']): string[] {
  if (notes.length === 0) return []
  return [
    '',
    '── WHAT THE SHOWRUNNER HAS ALREADY SAID ──',
    'Answer every one of these. They are his, verbatim, with where each was given.',
    '',
    ...notes.map((note) => `- ${note.sentence}: “${note.note}”`),
  ]
}

/** "The ep02 script draft" — what a delineation refusal calls the thing it could not read. */
const draftLabel = (desk: WriteContext, step: WriteStep): string =>
  `The ${episodeLabel(desk.where.episode.number)} ${producedBy(step)} draft`

const pad = (n: number): string => String(n).padStart(2, '0')
