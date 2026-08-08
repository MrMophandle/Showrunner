import type { ArtifactKind } from './artifact.ts'
import type { CheckSubject } from './text-check.ts'

/**
 * The craft reviewers (D13, 4.5): **the passes that read an artifact as craft rather than
 * against canon** — story shape, pacing, dialogue, and the hook.
 *
 * They ride `CheckSubject`, which is the whole point of this file being short. A craft
 * reviewer is composed by the same composer, answered in the same shape, and read by the same
 * parser as a category check; nothing here knows how to build a prompt or how to read a reply.
 * If a craft reviewer ever needs a second composer or a second parser, the seam has failed and
 * the answer is to fix the seam, not to fork it.
 *
 * ## Why these are CODE and categories are DATA
 *
 * A category is a kind of canon, and 3.2 makes it data because a show's world is the show's
 * business: adding `technology` is an edit to a sheet, and its check instructions are prose
 * about ITS world. A craft reviewer is about no world at all. It reads the same way for Grey
 * Harbor and for Dead Light, it has no entities, no fields, no relation types, and no sheet to
 * live on — which is exactly the argument `text-check.ts` already made for putting the
 * waypoint-drift instructions in code. These follow that precedent rather than inventing a
 * second one.
 *
 * It is also what makes D13 keepable. **Story-craft is mandatory equipment**, and equipment a
 * show could delete a row to remove is not mandatory — it is a default. There is no table
 * here to empty, no `applies to` to blank, and no argument to `craftChecksFor` that omits one.
 * The only way story-craft stops being convened is somebody deleting it from the array below,
 * and the test that fails that day is the enforcement.
 *
 * ## The one thing code decides about convening, stated plainly
 *
 * Convening is decided by declarations (3.2, 4.1): a category fires because its sheet says it
 * applies to this artifact kind. This file is the exception that proves it — `appliesTo` below
 * is a TypeScript array, because there is no declaration to read it from. It is narrow on
 * purpose: a dialogue reviewer is not convened on an outline, because an outline has no
 * dialogue in it and paying for a model to say so is the failure mode 4.1's second half
 * exists to prevent.
 *
 * ## What their keys collide with
 *
 * A show whose sheets declared a category called `pacing` would collide with the reviewer of
 * that name, exactly as one declaring `waypoint-drift` would. That is why the keys are written
 * down here in one place rather than inline at four call sites.
 */

/**
 * D13's named reviewer. It is a constant rather than a string in three places so that
 * "convened without being asked for" has something to point at — and so a search for the word
 * lands on this file and its test rather than on a prompt.
 */
export const MANDATORY_CRAFT = 'story-craft'

/** One reviewer: what it is called, where it reads, and what it is told to do. */
export interface CraftReviewer {
  /** The `check_pass.check_key`, kebab-case like every other check key. */
  key: string
  /** How it names itself in a prompt heading and on the verdict board. */
  label: string
  /** The artifact kinds it is convened on. Code, and the declared exception — see above. */
  appliesTo: readonly ArtifactKind[]
  /** What the reviewer is told to do — a category's `check_instructions`, in code. */
  instructions: string
}

/**
 * Every artifact kind that is read as prose. Named once so a reviewer's `appliesTo` is a
 * subset of something rather than four hand-typed lists that drift.
 */
const WRITTEN: readonly ArtifactKind[] = ['premise-brief', 'outline', 'script', 'scene-text']

/**
 * The four, in the order a panel convenes them — story-craft first, because it is the one
 * that reads the whole shape and the one that is not optional.
 *
 * Every instruction below says what a finding must CONTAIN rather than how to find one, for
 * the same reason `WAYPOINT_INSTRUCTIONS` does: the parser enforces the shape, and asking for
 * anything looser only produces replies that fail the step. Each of them also says what it is
 * NOT to raise, because four reviewers reading one script will otherwise all raise the same
 * concern in four voices and the gate room will render one cluster with four cards saying the
 * same thing.
 */
export const CRAFT_REVIEWER: readonly CraftReviewer[] = [
  {
    key: MANDATORY_CRAFT,
    label: 'the story-craft reviewer',
    appliesTo: WRITTEN,
    instructions: [
      'Read this as a story. You are not checking it against canon and you have been handed',
      'none — you are reading the shape.',
      '',
      'Three questions, and a finding answers one of them:',
      '',
      '1. **Story shape.** What shape is this episode telling, and does it finish telling it?',
      '   Name the shape you think it is reaching for and the beat that is missing or in the',
      '   wrong place. "It drags" is not a finding; "the reversal lands before anything is at',
      '   stake, so there is nothing to reverse" is.',
      '2. **Trope usage — knowing or cliché.** A familiar move used deliberately is craft; the',
      '   same move used because it came to hand is not. Name the trope, say which of the two',
      '   this is, and quote the line that decides it. If the script knows what it is doing',
      '   with a familiar shape, that is not a finding, and saying so is not your job either.',
      '3. **Setup and payoff.** Something is set up and never paid, or paid and never set up.',
      '   Quote the setup; say where the payoff should have landed and what it would have',
      '   looked like on screen. A setup deliberately left for a later episode is a real',
      '   answer — raise it at low confidence and say so rather than not raising it.',
      '',
      'Do not raise line-level rhythm (that is the pacing reviewer), how people talk (dialogue),',
      'or whether the opening earns attention (hook). One concern per finding.',
    ].join('\n'),
  },
  {
    key: 'pacing',
    label: 'the pacing reviewer',
    appliesTo: ['outline', 'script', 'scene-text'],
    instructions: [
      'Read this for pace, and for nothing else. You have been handed no canon.',
      '',
      'A finding is a span where the episode spends time it does not buy anything with, or',
      'buys something it did not spend enough on. Quote the span and say which it is:',
      '',
      '- **Spent and unbought** — a run of lines that repeats what the audience already has.',
      '  Say what the scene knows after it that it did not know before it. If the answer is',
      '  "nothing", that is the finding.',
      '- **Bought and unspent** — a turn the episode does in one line that it needed three to',
      '  earn. Say what the audience is being asked to accept on no evidence.',
      '',
      'Length is not pace. A long scene that keeps changing what is true is not a finding, and',
      'a short one that changes nothing is. Do not raise story shape, dialogue, or the hook.',
    ].join('\n'),
  },
  {
    key: 'dialogue',
    label: 'the dialogue reviewer',
    appliesTo: ['script', 'scene-text'],
    instructions: [
      'Read the dialogue, and only the dialogue. You have been handed no canon, so do not',
      'argue that somebody is out of character — that is the character check’s job and it has',
      'the sheets. Argue from the lines in front of you.',
      '',
      'A finding is one of these, quoted at the line it lands on:',
      '',
      '- **Two people with one voice.** Two characters whose lines would swap without anyone',
      '  noticing. Quote both and say what would have to differ.',
      '- **Said, not played.** A line that states the subtext instead of carrying it, or that',
      '  tells the audience something the scene has already shown them.',
      '- **Nobody talks like that.** A line whose register belongs to the writer rather than',
      '  the speaker. Say which speaker, and what they would have said instead.',
      '',
      'Do not raise pace, story shape, or the hook.',
    ].join('\n'),
  },
  {
    key: 'hook',
    label: 'the hook reviewer',
    appliesTo: WRITTEN,
    instructions: [
      'Read the opening and the ending, and judge whether they hold. You have been handed no',
      'canon.',
      '',
      'Two questions:',
      '',
      '1. **The open.** What question does the first page put in the audience’s head, and how',
      '   many lines does it take to get there? Quote the line where the question lands. If',
      '   there is no such line, the finding is that there is none, and the anchor is the span',
      '   the episode spends instead.',
      '2. **The out.** What does the last beat leave open, and is it a question or a stop?',
      '   Quote it, and say what an audience is meant to want next.',
      '',
      'An episode may deliberately open quiet and close closed. If that is what this is, say',
      'so at low confidence rather than raising it as a defect. Do not raise pace, dialogue, or',
      'story shape.',
    ].join('\n'),
  },
]

/**
 * The craft reviewers this artifact kind convenes, in roster order.
 *
 * It takes a kind and nothing else. There is no options argument, no show, and no store — so
 * there is no seam through which story-craft could be asked for and left out, which is the
 * whole of D13's "mandatory" as code can hold it.
 */
export function craftChecksFor(kind: ArtifactKind): CheckSubject[] {
  return CRAFT_REVIEWER.filter((reviewer) => reviewer.appliesTo.includes(kind)).map(
    (reviewer): CheckSubject => ({
      key: reviewer.key,
      label: reviewer.label,
      instructions: reviewer.instructions,
      reference: [],
      // A craft reviewer is about the artifact, not about an entity in it — and it is handed
      // no canon at all, which is what makes the parser refuse a citation without anybody
      // adding an exemption to it (`readsCanon`, text-check.ts).
      subjectEntityIds: [],
      readsCanon: false,
    }),
  )
}
