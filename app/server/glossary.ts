/**
 * The cockpit's own words, defined for the operator (#99).
 *
 * ── Why the definitions are written here rather than lifted ─────────────────────
 * #99 ruled that the domain nouns STAY on screen — `gate`, `finding`, `proposal`, `arc`,
 * `waypoint` — and gain a definition a reader can reach without leaving the page. What it
 * ALSO ruled is that those definitions may not be copied out of `CLAUDE.md` or the concept
 * doc. Both of those are written to settle arguments between the people building this app,
 * so their sentences carry citations, pattern names and rulings-by-reference — the exact
 * register the sweep exists to get off the glass. A definition lifted from a design document
 * would reintroduce, inside a tooltip, the thing the sweep took out of the sentence.
 *
 * So every line below is written fresh, to the register rule: it names its subject, states
 * the condition it is in, says who acts, and finishes its grammar. `glossary.test.ts` asserts
 * all four mechanically, and asserts that no definition appears verbatim in `CLAUDE.md`.
 *
 * ── Why it is on the server ─────────────────────────────────────────────────────
 * The same rule that puts the room names in `cockpit.ts`: nothing in `app/web/` authors a
 * word Ryan reads. A definition is copy, so it is composed here, tested here, and travels
 * to the browser on `GET /api/cockpit` with the room names it belongs beside.
 *
 * ── Where a mark appears, and why not everywhere ────────────────────────────────
 * `SectionHeader` renders its `explains` line through `Glossed`, and that is the only place
 * in the cockpit that marks a term. It is one call site and it covers every screen, because
 * every section in this cockpit is required to carry an explanation.
 *
 * The restraint is deliberate. A mark on every occurrence of every noun turns a screen into
 * a field of underlines, and an underline that is everywhere stops reading as "there is help
 * here" and starts reading as texture — which is the same failure as a sentence nobody can
 * parse, arrived at from the other side. The explanation line is also the one place this
 * cockpit already licenses a schema noun to stand: `SectionHeader` refuses to render a name
 * without its plain words, so the noun and its translation are already together there, and
 * the tooltip deepens a line that is doing that job rather than decorating one that is not.
 * Nothing inside a button, a count, a cost line or an artifact's own text is marked — a mark
 * inside a click target is a second thing to hit, and a mark on a number explains nothing.
 */

/** One word the cockpit uses, and what it means to the person operating it. */
export interface GlossaryEntry {
  /** The headword, as it is written in the definition's own subject. */
  term: string
  /**
   * What it means, in the operator register. One or two complete sentences: what the thing
   * is, what state it is in, and who acts on it.
   */
  definition: string
  /**
   * The spellings a sentence may use for it, lowercase. Every form is matched on whole
   * words only. A form that is also ordinary English in this copy — "run" the verb, "close"
   * the verb, "check" the verb — is deliberately left out, because a mark on the wrong word
   * is worse than no mark at all.
   */
  marks: readonly string[]
}

/**
 * The ruled set (#99), plus the words the sweep met while rewriting the screens. They are
 * ordered the way an operator meets them: the ruling verbs first, then canon, then the
 * story spine, then the machinery, then the readings on a finding.
 */
const TERMS: readonly GlossaryEntry[] = [
  {
    term: 'gate',
    definition:
      'A stop where one artifact waits on your verdict. The run holds there until you ' +
      'approve it, reject it with a note, approve it over the findings, or close it.',
    marks: ['gate', 'gates'],
  },
  {
    term: 'ruling',
    definition:
      'Your verdict on one proposal or one gate. You rule once, and the app keeps every ' +
      'verdict you have given, including the ones you rejected.',
    marks: ['ruling', 'rulings'],
  },
  {
    term: 'ratify',
    definition:
      'You approve a proposal, and what it says becomes true in this show. Nothing else ' +
      'writes canon — not the model, not a check, not the runner.',
    marks: ['ratify', 'ratified', 'ratifies', 'ratifying', 'ratification'],
  },
  {
    term: 'defer',
    definition:
      'You park a proposal instead of deciding it. It stops riding its episode and waits ' +
      'until you come back to it.',
    marks: ['defer', 'deferred', 'deferral'],
  },
  {
    term: 'override',
    definition:
      'You approve an artifact although a finding argued against it. Your approval and the ' +
      'finding it went over are both kept on the record.',
    marks: ['override', 'overridden', 'overrides'],
  },
  {
    term: 'proposal',
    definition:
      'A written change to this show, waiting on you. Nothing in it counts until you ' +
      'ratify it.',
    marks: ['proposal', 'proposals'],
  },
  {
    term: 'canon',
    definition:
      'What is true in this show. Only your ratification puts anything into it.',
    marks: ['canon'],
  },
  {
    term: 'entity',
    definition:
      'One named thing in this show: a character, a location, a faction, a piece of ' +
      'technology. It carries a sheet, its facts and its links to other entities.',
    marks: ['entity', 'entities'],
  },
  {
    term: 'fact',
    definition:
      'One statement about an entity that a check can test, carrying the episode that ' +
      'established it and the ruling that made it true.',
    marks: ['fact', 'facts'],
  },
  {
    term: 'relation',
    definition:
      'A typed link from one entity to another, such as a character to their species. The ' +
      'type has to be declared for the category before an entity can use it.',
    marks: ['relation', 'relations'],
  },
  {
    term: 'candidate',
    definition:
      'An entity sheet that has been registered and not yet ratified. It sits on the ' +
      'queue, and nothing written on it counts as canon.',
    marks: ['candidate', 'candidates'],
  },
  {
    term: 'standing',
    definition:
      'How much of the show an entity carries: core, recurring, one-shot or retired.',
    marks: ['standing'],
  },
  {
    term: 'provisional',
    definition:
      'A fact an episode has written that you have not ruled on yet. Checks on that ' +
      'episode can see it; the rest of the show cannot.',
    marks: ['provisional'],
  },
  {
    term: 'riding',
    definition:
      'A proposal is attached to an episode and travels with it. Approving the episode ' +
      'brings the proposal to you; abandoning the episode parks it.',
    marks: ['riding', 'rides', 'ride'],
  },
  {
    term: 'founding',
    definition:
      'How a show begins. A loader writes the categories and raises one proposal per ' +
      'entity sheet, and you rule on that stack one sheet at a time.',
    marks: ['founding', 'founded'],
  },
  {
    term: 'revert',
    definition:
      'A proposal to overturn one fact you ratified earlier. Each fact comes back to you ' +
      'on its own, never all of them at once.',
    marks: ['revert', 'reverts', 'reverted'],
  },
  {
    term: 'arc',
    definition:
      'A story or a character followed across episodes, written as a statement with its ' +
      'waypoints in order.',
    marks: ['arc', 'arcs'],
  },
  {
    term: 'waypoint',
    definition:
      'One step along an arc, in order. An episode reaches it only when you ratify the pin ' +
      'that claims it.',
    marks: ['waypoint', 'waypoints'],
  },
  {
    term: 'pin',
    definition:
      'An episode claims it reaches a waypoint. The claim raises a proposal, and the arc ' +
      'has not moved until you rule on it.',
    marks: ['pin', 'pins', 'pinned'],
  },
  {
    term: 'landing',
    definition:
      'You ratified a pin, so the arc really did reach that waypoint in that episode.',
    marks: ['landing', 'landings', 'landed'],
  },
  {
    term: 'vanilla',
    definition:
      'An episode that declares no arc position. Not every episode advances an arc, and ' +
      'the season map tracks which ones do.',
    marks: ['vanilla'],
  },
  {
    term: 'lifecycle',
    definition:
      'The six stages an episode moves through: premise, outline, script, assets, ' +
      'assembled, published. An episode keeps the stage it reached even if you abandon it.',
    marks: ['lifecycle'],
  },
  {
    term: 'abandon',
    definition:
      'You stop an episode where it stands. It keeps the stage it reached, the proposals ' +
      'riding it are parked, and each fact it established comes back to you to overturn or keep.',
    marks: ['abandon', 'abandoned', 'abandoning'],
  },
  {
    term: 'scene',
    definition:
      'One numbered stretch of the written episode. The app reads scenes out of what was ' +
      'written; the model is never told how many to write.',
    marks: ['scene', 'scenes'],
  },
  {
    term: 'sweep',
    definition:
      'The pass at the end of an episode that brings every proposal still riding it to ' +
      'you at once, so you rule on them together.',
    marks: ['sweep'],
  },
  {
    term: 'provenance',
    definition:
      'The canon entities an artifact touches, listed on the artifact itself. A check reads ' +
      'those entities and no others.',
    marks: ['provenance'],
  },
  {
    term: 'stale',
    definition:
      'This artifact was built from a version of something that has changed since. The app ' +
      'compares the versions every time you open the screen.',
    marks: ['stale'],
  },
  {
    term: 'fresh',
    definition:
      'Everything this artifact was built from is still at the version it was built from.',
    marks: ['freshness'],
  },
  {
    term: 'blast radius',
    definition:
      'Everything that would go out of date if you ratify this change.',
    marks: ['blast radius'],
  },
  {
    term: 'check',
    definition:
      'One model call that reads an artifact against one category of canon or one craft ' +
      'standard, and writes down what it found. A check argues; it never decides.',
    marks: ['checks'],
  },
  {
    term: 'finding',
    definition:
      'One thing a check flagged, quoted against the lines it read. It carries a severity ' +
      'and a confidence, and it never overrules you.',
    marks: ['finding', 'findings'],
  },
  {
    term: 'severity',
    definition: 'How much a finding would cost you if it turns out to be right.',
    marks: ['severity'],
  },
  {
    term: 'confidence',
    definition:
      'How sure the check is that its finding is right. It is printed beside severity and ' +
      'never merged into it, because a serious guess and a certain quibble are not the same thing.',
    marks: ['confidence'],
  },
  {
    term: 'deterministic',
    definition:
      'Counted by code rather than read by a model. It costs nothing to run and gives the ' +
      'same answer every time.',
    marks: ['deterministic'],
  },
  {
    term: 'continuity board',
    definition:
      'A table of who and what is present, scene by scene. Code builds it by counting, so a ' +
      'contradiction on it blocks the next stage until you settle it.',
    marks: ['continuity board'],
  },
  {
    term: 'run',
    definition:
      'One pass of a stage over one episode. It starts when you click, and it stops at a ' +
      'gate or when the stage is finished.',
    marks: ['runs'],
  },
  {
    term: 'step',
    definition:
      'One unit of work inside a run. A step says what it reads and what it writes, and it ' +
      'can be picked up again where it stopped if the app is killed.',
    marks: ['steps'],
  },
]

/** The whole glossary, in the order it is defined. */
export function glossary(): GlossaryEntry[] {
  return TERMS.map((entry) => ({ ...entry, marks: [...entry.marks] }))
}

/** A run of a sentence: either plain words, or one marked term with its definition. */
export interface GlossedPiece {
  text: string
  /** Null for plain words. Otherwise the definition that belongs on this run. */
  definition: string | null
  /** The headword the definition is filed under. Null for plain words. */
  term: string | null
}

/**
 * Cut a sentence into plain runs and marked runs.
 *
 * The rules, in order: whole words only, longest form first, and **each term at most once
 * per sentence** — a sentence that says "gate" three times wears one mark, on the first.
 * A sentence with no glossary word in it comes back as a single plain run, which is what
 * makes this safe to wrap every explanation line in.
 *
 * It is a pure function of its two arguments and lives beside the words rather than in the
 * browser, so the cutting is tested here with the definitions it cuts against.
 */
export function markTerms(
  text: string,
  entries: readonly GlossaryEntry[] = TERMS,
): GlossedPiece[] {
  const forms = entries
    .flatMap((entry) => entry.marks.map((mark) => ({ mark, entry })))
    .sort((a, b) => b.mark.length - a.mark.length)

  const pieces: GlossedPiece[] = []
  const used = new Set<string>()
  let plain = ''
  let at = 0

  const isWord = (character: string | undefined): boolean =>
    character !== undefined && /[A-Za-z0-9]/.test(character)

  while (at < text.length) {
    const found = forms.find(({ mark, entry }) => {
      if (used.has(entry.term)) return false
      if (text.slice(at, at + mark.length).toLowerCase() !== mark) return false
      if (isWord(text[at - 1])) return false
      return !isWord(text[at + mark.length])
    })

    if (found === undefined) {
      plain += text[at]
      at += 1
      continue
    }

    if (plain !== '') pieces.push({ text: plain, definition: null, term: null })
    plain = ''
    pieces.push({
      text: text.slice(at, at + found.mark.length),
      definition: found.entry.definition,
      term: found.entry.term,
    })
    used.add(found.entry.term)
    at += found.mark.length
  }

  if (plain !== '') pieces.push({ text: plain, definition: null, term: null })
  return pieces
}
