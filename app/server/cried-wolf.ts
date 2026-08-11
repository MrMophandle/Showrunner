import type { Store } from './db/store.ts'
import { findArtifact, type Artifact } from './domain/artifact.ts'
import { concernGroups } from './domain/concern.ts'
import { findingsIn, type Finding } from './domain/finding.ts'
import { overriddenVersions } from './runner/gate.ts'

/**
 * **D11's cried-wolf tracking: reviewing the reviewers, as a query and a sentence.**
 *
 * "Ryan is the final gate; beneath it, cried-wolf tracking per check surfaces 'tune this
 * check?' maintenance prompts." This is that, and it is deliberately nothing more.
 *
 * ## Nothing here acts, and no threshold in this file changes any behaviour
 *
 * The sentence is a QUESTION Ryan reads. No check is disabled, demoted, deprioritised,
 * re-weighted or auto-tuned by any number below, and nothing in the app branches on a ratio.
 * A system that switched its own reviewers off would be ruling on them, which is invariant 1's
 * cousin and invariant 5's letter ("nothing runs without a click") said about not-running.
 * `MIN_RULED_CONCERNS` and the majority test decide whether a sentence RENDERS and nothing
 * else; if either of them ever gates anything else, that is the bug.
 *
 * ## Computed, never remembered — there is no table under this
 *
 * Every input already exists: `check_pass` (E3-0, and the zero-finding rows are the whole
 * reason it exists), `finding` and `finding_disposition` (E3-0, E3-5), `check_gap` (E3-2),
 * and `gate_ruling`'s override verb (E1). This module writes nothing, caches nothing and adds
 * no column — the freshness pattern (1.3), which is also why a dismissal a moment old changes
 * the answer with no invalidation anywhere. The shape of the read is two queries over the
 * window (its passes, and the firings in it), then one hydrated read and one override read
 * per artifact those firings are anchored in; if a real show ever makes that too slow, the
 * fix is an index before it is a table, and a table needs an argument in writing.
 *
 * ## The three numbers, and what each of them is FOR
 *
 * **Readings** — every pass in the window, including the silent ones. This is D11's floor and
 * the reason 0010 writes a pass at zero findings: a check that reads twelve drafts and never
 * complains is a MEASUREMENT (`the hull and the void`'s rules 2 and 3 are obeyed on purpose
 * throughout ep01, and their silence is the point), and a check that never ran is an absence.
 * Such a check has no ratio, appears in no sentence, and is never asked about.
 *
 * **Firings** — one per `finding` row. E3-5 made re-firing routine, so this counts twins, and
 * it is right that it does: a rule that keeps saying the same thing at every rewrite is
 * exactly what the denominator is for.
 *
 * **Concerns** — firings folded through `domain/concern.ts`. The RATIO counts these, because
 * a check that fired nine times at one contradiction has not found nine things, and without
 * the fold a rewrite-heavy episode would inflate its checks' numbers with twins of one
 * concern and every ratio would measure how often Ryan rewrites.
 *
 * ## The ratio's denominator is RULED concerns, and abstentions are neither side
 *
 * A concern reaches one of five verdicts, and only three of them are in the ratio:
 *
 *   * `dismissed` — he put it down with a note (4.3's third button). Against the check.
 *   * `overridden` — he approved the draft it was standing on as an explicit override.
 *     Against the check, the same way. An override is BLANKET — one ruling over every finding
 *     standing at that version, possibly from several checks and possibly because of only one
 *     of them — and counting it against each of them is the honest reading of what the ledger
 *     records. It is attributed by EXACT version, never through `overriddenThrough`'s max
 *     (`gate.ts` says why): a finding whose draft was already gone was not standing at that
 *     gate, and crediting the override with it would put a number in the sentence that no
 *     click on the record could account for.
 *   * `confirmed` — the draft it argued with was rewritten, and the check read the material
 *     again and did not say it. FOR the check. **It is a computation, never a row**: E3-5
 *     ruled a `cleared` disposition out forever (`domain/finding.ts`) because it would be
 *     remembered state beside a computed answer AND a mark against a check that was right.
 *   * `standing` — still open against the current draft. He has not ruled on it yet.
 *   * `unread` — the draft is gone and nothing has read the new one, so nobody knows.
 *
 * The last two are UNRULED and sit outside both sides. So does a `check_gap`: a check that
 * said "could not look" was neither right nor wrong (0012), and folding gaps into either side
 * would punish the one honesty invariant 4 exists to protect. Both are reported beside the
 * ratio rather than inside it, so a bench can show them without them ever moving a number.
 *
 * ## The window, and what it is a window on
 *
 * The window bounds the READINGS — "how has this check behaved lately". A concern's VERDICT
 * is a property of its whole life, resolved across every firing of it there has ever been:
 * a dismissal older than the window still stands, exactly as `stage-wall.ts` reads it, so the
 * wall and this sentence can never disagree about one concern.
 */

/**
 * How far back "lately" reaches. Ninety days, and the reason it is time and not a count of
 * findings is that a check tuned six months ago should not be judged on what it did before —
 * `check_pass_by_check` is indexed `(check_key, ran_at)` for exactly this question (0010).
 *
 * It is a default rather than a rule: `criedWolf` takes a `since`, and E3-7's bench may well
 * want to ask about one season instead.
 */
export const CRIED_WOLF_WINDOW_DAYS = 90

/**
 * How many ruled concerns it takes before the question is worth asking at all.
 *
 * Three, because two is a coincidence and one is an anecdote. A check that fired once and was
 * dismissed once is at 100%, and asking Ryan to tune it on that would be the maintenance
 * prompt crying wolf about the checks — which is the failure this module would be embarrassed
 * to ship. The cost of the floor is a real wolf-crier staying quiet for one more finding.
 */
export const MIN_RULED_CONCERNS = 3

/** What became of one concern. Only the first three are in D11's ratio. */
export const CONCERN_VERDICT = [
  'dismissed',
  'overridden',
  'confirmed',
  'standing',
  'unread',
] as const
export type ConcernVerdict = (typeof CONCERN_VERDICT)[number]

/** One concern, however many times the check said it, and what became of it. */
export interface ConcernRecord {
  checkKey: string
  verdict: ConcernVerdict
  /** The words the check used, from its latest firing. */
  concern: string
  /** Every firing of it, oldest first — the rows every number here was computed from. */
  findingIds: string[]
  /** Ryan's note, when he put it down. '' when he has not. */
  note: string
}

/** One check's behaviour over the window — the bookkeeping E3-7's bench renders. */
export interface CheckRecord {
  checkKey: string
  /** Every pass in the window. The silent ones are why this is a measurement (0010). */
  readings: number
  /** Readings that found nothing at all. A number, never an absence. */
  silent: number
  /** Things it could not look at (0012). Reported, and in neither side of the ratio. */
  gaps: number
  /** `finding` rows in the window. Twins count, and that is the point. */
  firings: number
  /** Those firings, folded into the concerns behind them. */
  concerns: ConcernRecord[]
  dismissed: number
  overridden: number
  confirmed: number
  /** dismissed + overridden + confirmed — the ratio's denominator, and nothing else. */
  ruled: number
  /** Concerns nobody has ruled on: still standing, or in a draft nothing has re-read. */
  unruled: number
  /** The maintenance prompt, or null when this check is not crying wolf. A QUESTION. */
  tune: string | null
}

export interface CriedWolfScope {
  showId: string
  /** ISO timestamp. Defaults to `CRIED_WOLF_WINDOW_DAYS` ago. */
  since?: string
}

/**
 * **Every check that has read anything for this show inside the window, alphabetically.**
 *
 * Including the ones with nothing to answer for: a control that fires at nothing belongs on
 * the bench with its twelve silent readings on it, and hiding it would turn a measured
 * silence back into an absence one screen after 0010 spent a table preventing exactly that.
 * What such a check never gets is a `tune` sentence.
 */
export function criedWolf(store: Store, scope: CriedWolfScope): CheckRecord[] {
  const since = scope.since ?? windowOpenedAt(CRIED_WOLF_WINDOW_DAYS)
  const passes = passesInWindow(store, scope.showId, since)

  // Read once per artifact and shared by every concern anchored in it — hydrating a finding
  // costs two subqueries, and the alternative asks for the same rows once per firing.
  const anchored = new Map<string, Finding[]>()
  const artifacts = new Map<string, Artifact | undefined>()
  const overrides = new Map<string, number[]>()
  const findingsOf = (artifactId: string): Finding[] =>
    anchored.get(artifactId) ?? set(anchored, artifactId, findingsIn(store, artifactId))
  const artifactOf = (artifactId: string): Artifact | undefined =>
    artifacts.has(artifactId)
      ? artifacts.get(artifactId)
      : set(artifacts, artifactId, findArtifact(store, artifactId))
  const overridesOf = (artifactId: string): number[] =>
    overrides.get(artifactId) ?? set(overrides, artifactId, overriddenVersions(store, artifactId))

  const records = new Map<string, Draft>()
  const draftFor = (checkKey: string): Draft =>
    records.get(checkKey) ?? set(records, checkKey, blank(checkKey))

  for (const pass of passes) {
    const draft = draftFor(pass.check_key)
    draft.readings += 1
    draft.gaps += pass.gap_count
    draft.firings += pass.finding_count
    // Zero findings AND nothing it could not look at. A pass with a gap on it is not a clean
    // run, and counting it as one would be 0012's whole argument thrown away at the last step.
    if (pass.finding_count === 0 && pass.gap_count === 0) draft.silent += 1
  }

  for (const firing of firingsInWindow(store, scope.showId, since)) {
    const draft = draftFor(firing.check_key)
    draft.fired.add(firing.id)
    draft.anchoredIn.add(firing.artifact_id)
  }

  for (const draft of records.values()) {
    // The concerns in play are the ones a firing in the window belongs to — but each is
    // resolved across its WHOLE life, so a dismissal older than the window still stands.
    for (const artifactId of draft.anchoredIn) {
      for (const group of concernGroups(findingsOf(artifactId))) {
        if (group[0]!.checkKey !== draft.checkKey) continue
        if (!group.some((finding) => draft.fired.has(finding.id))) continue
        draft.concerns.push(
          concernRecord(store, group, artifactOf(artifactId), overridesOf(artifactId)),
        )
      }
    }
  }

  return [...records.values()]
    .sort((one, other) => one.checkKey.localeCompare(other.checkKey))
    .map(finish)
}

/** Just the maintenance prompts, in the same order — what E3-7 prints above the bench. */
export function tunePrompts(store: Store, scope: CriedWolfScope): string[] {
  return criedWolf(store, scope)
    .map((record) => record.tune)
    .filter((sentence) => sentence !== null)
}

// ── One concern's verdict ───────────────────────────────────────────────────────

/**
 * What became of one concern, from every firing of it and the two rulings that can land on
 * one — read in the order that keeps the more specific record on top.
 *
 * **Dismissal first, override second.** A dismissal is Ryan's answer to THIS finding with his
 * words on it; an override is a blanket ruling over whatever happened to be standing at that
 * version. Both count against the check identically, so the order changes no number — it
 * changes which record the bench shows him, and the one with his note in it is the one that
 * explains itself. The EARLIEST dismissal in the group, matching `inheritedDismissal`: a
 * re-dismissal is an echo, and the first note is the one that says why.
 *
 * `confirmed` is the one that has to be earned twice over: the draft the concern argued with
 * must be GONE, and somebody must have READ the material again afterwards. Either alone is
 * not evidence — a rewrite nobody re-checked is never-checked rendering as checked-clean (the
 * collapse `remediation.ts` exists to prevent), and a re-read of an unchanged draft is just
 * the check saying it again. Neither, and the concern is standing.
 */
function concernRecord(
  store: Store,
  group: Finding[],
  artifact: Artifact | undefined,
  overriddenAt: number[],
): ConcernRecord {
  const latest = group[group.length - 1]!
  // By KIND rather than by "has a disposition": `FINDING_DISPOSITION` is one member and E3-5
  // argued it stays one, but a kind added later would be a different answer from Ryan, and it
  // must not fall into this side of a ratio by default.
  const dismissal = group.find((finding) => finding.disposition?.kind === 'dismissed')
  const overridden = group.find((finding) => overriddenAt.includes(finding.anchor.version))
  const draftIsGone = artifact !== undefined && artifact.version > latest.anchor.version

  const verdict: ConcernVerdict = dismissal
    ? 'dismissed'
    : overridden
      ? 'overridden'
      : !draftIsGone
        ? 'standing'
        : readAgainSince(store, latest.passId)
          ? 'confirmed'
          : 'unread'

  return {
    checkKey: latest.checkKey,
    verdict,
    concern: latest.concern,
    findingIds: group.map((finding) => finding.id),
    note: dismissal?.disposition?.note ?? '',
  }
}

/**
 * **Did this check read the same material again, after the pass that raised this concern?**
 *
 * The second half of `confirmed`, and the only part of a verdict that needs the store. The
 * check's own material, not the finding's: a board rule reads the BOARD and anchors in the
 * SCRIPT (E3-1), and "did the rule run again" is a question about the board.
 *
 * That a twin did NOT come back needs no clause of its own. A twin is a later firing of the
 * same concern, so if one had come back it would be this group's `latest` and its draft would
 * be the current one — which never reaches here at all.
 *
 * Ordered by `(ran_at, rowid)` and never by `ran_at` alone: two passes in one transaction —
 * which is exactly what `applyRewrite`'s one motion writes — land in the same millisecond.
 */
function readAgainSince(store: Store, passId: string): boolean {
  return (
    store.get<{ n: number }>(
      `SELECT COUNT(*) AS n
         FROM check_pass later
         JOIN check_pass raising ON raising.id = ?
        WHERE later.check_key = raising.check_key
          AND later.artifact_id = raising.artifact_id
          AND (later.ran_at > raising.ran_at
               OR (later.ran_at = raising.ran_at AND later.rowid > raising.rowid))`,
      passId,
    )!.n > 0
  )
}

// ── The sentence ────────────────────────────────────────────────────────────────

/**
 * "world-rules — you have dismissed 3 of its last 4 ruled concerns … Tune this check?"
 *
 * Every number in it is reconstructible from rows Ryan can click through: the put-down count
 * and the confirmed count come from the concerns on the record, each of which names the
 * findings it was computed from. The readings and the silences ride with them because a ratio
 * without its denominator on screen is the same failure as a silence without a pass row.
 *
 * It ends in a question mark and it always will. Nothing acts on it.
 */
function tuneSentence(record: Omit<CheckRecord, 'tune'>): string | null {
  const putDown = record.dismissed + record.overridden
  if (record.ruled < MIN_RULED_CONCERNS) return null
  // A majority: a check whose findings he puts down more often than not is, by definition,
  // crying wolf more than it helps. This comparison is the only thing either threshold does.
  if (putDown * 2 <= record.ruled) return null

  const parts = [
    record.dismissed > 0 ? `${record.dismissed} dismissed with a note` : '',
    record.overridden > 0 ? `${record.overridden} approved over at a gate` : '',
  ].filter((part) => part !== '')

  const silent = record.silent > 0 ? `, and found nothing in ${record.silent} of them` : ''
  const gaps =
    record.gaps > 0 ? `, and could not look ${record.gaps} time${plural(record.gaps)}` : ''

  return (
    `${record.checkKey} — you have dismissed ${putDown} of its last ${record.ruled} ruled ` +
    `concern${plural(record.ruled)}: ${parts.join(', ')}, against ${record.confirmed} ` +
    `confirmed by a rewrite. It fired ${record.firings} time${plural(record.firings)} over ` +
    `${record.concerns.length} concern${plural(record.concerns.length)} in ${record.readings} ` +
    `reading${plural(record.readings)}${silent}${gaps}. Tune this check?`
  )
}

const plural = (count: number): string => (count === 1 ? '' : 's')

// ── Rows ────────────────────────────────────────────────────────────────────────

interface PassRow {
  id: string
  check_key: string
  finding_count: number
  gap_count: number
}

/**
 * Every reading in the window, with what it said counted the way 0010 counts it — subqueries
 * rather than columns, so neither number can drift from the rows it counts.
 *
 * Scoped by show through the artifact the CHECK read, which is not always the one its
 * findings are anchored in: a board rule reads the BOARD and lands in the SCRIPT (E3-1).
 * The reading is the unit here, so the reading's own artifact is what places it in a show.
 */
function passesInWindow(store: Store, showId: string, since: string): PassRow[] {
  return store.all<PassRow>(
    `SELECT p.id, p.check_key,
            (SELECT COUNT(*) FROM finding f WHERE f.pass_id = p.id) AS finding_count,
            (SELECT COUNT(*) FROM check_gap g WHERE g.pass_id = p.id) AS gap_count
       FROM check_pass p
       JOIN artifact a ON a.id = p.artifact_id
       JOIN episode e ON e.id = a.episode_id
       JOIN season s ON s.id = e.season_id
      WHERE s.show_id = ? AND p.ran_at >= ?`,
    showId,
    since,
  )
}

interface FiringRow {
  id: string
  check_key: string
  /** Where the finding is ANCHORED, which is where every twin of it will be too. */
  artifact_id: string
}

/**
 * The firings in the window, as ids and nothing more.
 *
 * Deliberately unhydrated: this only has to say which concerns are in play and which
 * artifacts to go and read. The hydrated findings — with the quoted facts `concernKey` needs —
 * come from one `findingsIn` per anchor artifact, which is also the read that reaches the
 * twins raised BEFORE the window opened.
 */
function firingsInWindow(store: Store, showId: string, since: string): FiringRow[] {
  return store.all<FiringRow>(
    `SELECT f.id, p.check_key, f.artifact_id
       FROM finding f
       JOIN check_pass p ON p.id = f.pass_id
       JOIN artifact a ON a.id = p.artifact_id
       JOIN episode e ON e.id = a.episode_id
       JOIN season s ON s.id = e.season_id
      WHERE s.show_id = ? AND p.ran_at >= ?`,
    showId,
    since,
  )
}

interface Draft {
  checkKey: string
  readings: number
  silent: number
  gaps: number
  firings: number
  /** The findings this check raised INSIDE the window — what picks the concerns in play. */
  fired: Set<string>
  /** The artifacts those firings are anchored in — where their whole history lives. */
  anchoredIn: Set<string>
  concerns: ConcernRecord[]
}

const blank = (checkKey: string): Draft => ({
  checkKey,
  readings: 0,
  silent: 0,
  gaps: 0,
  firings: 0,
  fired: new Set(),
  anchoredIn: new Set(),
  concerns: [],
})

function finish(draft: Draft): CheckRecord {
  const count = (verdict: ConcernVerdict): number =>
    draft.concerns.filter((concern) => concern.verdict === verdict).length

  const dismissed = count('dismissed')
  const overridden = count('overridden')
  const confirmed = count('confirmed')
  const record = {
    checkKey: draft.checkKey,
    readings: draft.readings,
    silent: draft.silent,
    gaps: draft.gaps,
    firings: draft.firings,
    concerns: draft.concerns,
    dismissed,
    overridden,
    confirmed,
    ruled: dismissed + overridden + confirmed,
    unruled: count('standing') + count('unread'),
  }
  return { ...record, tune: tuneSentence(record) }
}

/** The instant the window opens. Milliseconds, matching `strftime('%Y-%m-%dT%H:%M:%fZ')`. */
const windowOpenedAt = (days: number): string =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

function set<K, V>(map: Map<K, V>, key: K, value: V): V {
  map.set(key, value)
  return value
}
