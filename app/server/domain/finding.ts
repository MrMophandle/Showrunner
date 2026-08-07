import type { Store } from '../db/store.ts'
import { findArtifact } from './artifact.ts'
import { findFact, type Fact } from './fact.ts'
import { newId } from './id.ts'

/**
 * Findings, and the record that a check ran (4.1–4.3).
 *
 * This is the schema every other E3 issue writes into. It stores what a check said and
 * enforces nothing with it — the three rules below are what keep it that way, and each of
 * them is a mistake this repo has already paid for once somewhere else.
 *
 * ## Severity and confidence are two values, forever (invariant 4)
 *
 * "Never render a weak check as a green checkmark." They answer different questions — how
 * bad this is if true, and how sure the check is that it is true — and the gate room prints
 * them side by side, "severity high · confidence certain". A single combined `priority` is
 * the classic collapse, and it is one-way: once two numbers are one, nothing downstream can
 * tell a certain triviality from a guessed catastrophe. Both are required on every draft,
 * neither has a default, and 0010 refuses a value outside its set.
 *
 * The deterministic tier is `certain` because that is what the tier MEANS (4.2) — free,
 * structural, no model involved. It is not a value those checks happen to carry.
 *
 * ## A clean run is a record, not an absence
 *
 * `recordCheckPass` is the ONLY way a finding is written, and it writes the pass first and
 * unconditionally. A check that found nothing still leaves a row saying which check ran,
 * against which artifact at which version, and when.
 *
 * Two readers that do not exist yet depend on that. D11's cried-wolf tracking (E3-6)
 * computes a ratio — findings dismissed against times fired — and without the denominator
 * there is no ratio. And the fixture's controls: rules 2 and 3 of *The hull and the void*
 * are obeyed on purpose throughout ep01's script (E1-7), so their SILENCE is the
 * measurement. "The check ran and said nothing" is a different sentence from "the check
 * never ran", and only the pass row tells them apart. Silence with nothing behind it is
 * invariant 4's failure mode one level up.
 *
 * ## Findings are records, never state
 *
 * There is no `is_blocking` flag here and no `blocked` column anywhere, because D12 —
 * deterministic findings block the next stage and never Ryan's gate — is a COMPUTATION over
 * open deterministic findings, and E3-3 builds it. This module marks the tier. Whether that
 * amounts to a wall is somebody else's read of these rows, computed fresh, the way artifact
 * staleness and arc drift already are (1.3, D8).
 *
 * `status` follows the same rule and is derived, never stored: a finding is `open` until a
 * disposition row closes it. That is `fact.status` over `fact_closure` exactly (0007).
 *
 * ## The anchor lands on the material, and it lands by quote
 *
 * "Clicking lands on the material, highlighted" (4.3). An anchor is artifact + version +
 * scene + the quoted span, and the quote is what the UI searches for. NOT an offset: a
 * script is a markdown file that E3-5's rewrites revise, and a character offset rots on the
 * first edit above it — silently, because it still points at something.
 *
 * `quote: ''` is legal and means there is no span to highlight. Both of E3-0's checks are
 * canon-graph checks: they are about an entity in the artifact's provenance, not about a
 * sentence in its text. The gate room renders those on the verdict board rather than inline.
 *
 * The anchor carries its own artifact because it is a different question from the pass's.
 * They agree in the ordinary case and diverge at the continuity board: E3-1's rules run
 * against the BOARD and land in the SCRIPT's scene 4, which is what the gate renders.
 *
 * ## A pass also records what it was HANDED, and what it could not reach (E3-2, 0012)
 *
 * The two additions above hold the semantic tier's third answer, which the deterministic
 * tier does not have. A rule that reads rows either fires or does not; a check that reads a
 * SCOPE can also fail to reach part of it, and 4.2's honest confidence is what that costs.
 *
 * `scope` is every fact the pass ran with, quoted or not. It is what makes a MEASURED
 * silence different from an absent one: a `check_pass` row says the world-rules check ran,
 * and only these rows say rule 2 was in front of it when it ran. That is this module's own
 * argument for the pass row, applied one level down — and it is a historical record for
 * `artifact_version`'s reason, since canon moves on and re-deriving the scope later answers
 * a different question.
 *
 * `gaps` are the third kind of nothing. A gap is about the SCOPE, never about the artifact:
 * "her species is undecided, so no physiology is in scope" is not a complaint a rewrite could
 * answer, so it is not a finding, does not reach the verdict board, and does not land in
 * D11's numerator where dismissing it would count against a check that was right to abstain.
 * Nor is it a silence: a pass at zero findings with a gap on it is not a clean run, which is
 * why `gapCount` sits beside `findingCount` rather than being folded into it.
 */

/**
 * The three tiers of 4.2, as far as they exist. `media` arrives with E6's image and audio
 * checks; adding it is a widened union here plus a test, which is what 0010 bought by
 * refusing a CHECK on the column (the Archon rule, and 0007's reasoning about ruling kinds).
 */
export const CHECK_TIER = ['deterministic', 'text'] as const
export type CheckTier = (typeof CHECK_TIER)[number]

/** How bad this is if it is true. */
export const FINDING_SEVERITY = ['low', 'medium', 'high'] as const
export type FindingSeverity = (typeof FINDING_SEVERITY)[number]

/**
 * How sure the check is that it is true. A separate axis from severity and never folded
 * into it (invariant 4). `certain` belongs to the deterministic tier and is not available
 * to a model's opinion of its own reading.
 */
export const FINDING_CONFIDENCE = ['certain', 'high', 'medium', 'low'] as const
export type FindingConfidence = (typeof FINDING_CONFIDENCE)[number]

/**
 * What closes a finding. One member today: E3-0 builds the dismissal, whose note 4.4 says
 * rides future runs. **E3-5 adds `cleared`** — a rewrite landed and the scene-scoped
 * re-check no longer fires it — as a widened union with a test, never a CHECK to rebuild.
 */
export const FINDING_DISPOSITION = ['dismissed'] as const
export type FindingDispositionKind = (typeof FINDING_DISPOSITION)[number]

/** Derived from the disposition row, never stored. */
export type FindingStatus = 'open' | FindingDispositionKind

/** One reviewer pass: which check ran, against what, when — and how much it said. */
export interface CheckPass {
  id: string
  /** kebab-case, and free text: E3-2 derives its keys from the show's declared categories. */
  checkKey: string
  tier: CheckTier
  artifactId: string
  /** The version it read. The artifact moves on; the pass stays readable against v2. */
  artifactVersion: number
  /** The scene it was narrowed to (D14, E3-5). NULL is the whole artifact. */
  sceneId: string | null
  ranAt: string
  /** Counted from the findings, never stored. **Zero is the measurement, not an absence.** */
  findingCount: number
  /**
   * How much of its scope it could not reach (E3-2). Counted the same way, and separate from
   * `findingCount` on purpose: zero findings and one gap is not a clean run.
   */
  gapCount: number
}

/**
 * One fact a pass was handed, whether or not any finding quoted it — the denominator of a
 * measured silence, and invariant 2 kept as a record rather than only as a promise.
 */
export interface ScopeFact {
  fact: Fact
  /** Whose scope it was in. The same fact reaches one pass through two entities. */
  entityId: string
  /** The declaration it travelled (D22, D23). '' when it is the entity's own fact. */
  via: string
}

/**
 * Which kind of nothing a gap hit, from `INHERITANCE_CASE` in fact.ts — the same closed set,
 * because a gap in a check's scope is a gap in what `factsInScope` could reach. A TypeScript
 * union widened with a test, never a CHECK on the column (0007's reasoning).
 */
export const CHECK_GAP_REASON = ['declared-unknown', 'undeclared', 'source-has-no-facts'] as const
export type CheckGapReason = (typeof CHECK_GAP_REASON)[number]

/** What one check could not check, and why. A record about the scope, not about the artifact. */
export interface CheckGap {
  id: string
  passId: string
  /** From the pass that raised it, like a finding's. */
  checkKey: string
  /** Who could not be checked. NULL when the gap is about the artifact rather than an entity. */
  entityId: string | null
  reason: CheckGapReason
  /** The declaration whose far end was empty. '' when the gap is not about an edge. */
  via: string
  /** The sentence Ryan reads — "could not check … — species undecided". */
  detail: string
}

/** Where a finding lands (4.3). `quote` is '' when there is no span to highlight. */
export interface FindingAnchor {
  artifactId: string
  version: number
  sceneId: string | null
  quote: string
}

/** Ryan's answer to one finding, kept forever — 4.4 reads the note back into later runs. */
export interface FindingDisposition {
  kind: FindingDispositionKind
  note: string
  at: string
}

export interface Finding {
  id: string
  passId: string
  /** From the pass that raised it. A finding carries no second copy of either. */
  checkKey: string
  tier: CheckTier
  anchor: FindingAnchor
  /** What the check said, at that version. A record, not a live view. */
  concern: string
  /** The canon entity the concern is about. NULL for a craft finding (E3-4) — no canon. */
  entityId: string | null
  /** The facts the card quotes with their lineage, in the order it quotes them. */
  facts: Fact[]
  severity: FindingSeverity
  confidence: FindingConfidence
  status: FindingStatus
  disposition: FindingDisposition | null
}

/**
 * What a check hands back. Severity and confidence are required — a check does not get to
 * have an opinion without saying how bad and how sure.
 */
export interface FindingDraft {
  concern: string
  severity: FindingSeverity
  confidence: FindingConfidence
  /** Defaults to the checked artifact at the checked version, with no scene and no span. */
  anchor?: {
    artifactId?: string
    version?: number
    sceneId?: string | null
    quote?: string
  }
  entityId?: string
  /** Fact ids, in the order the card should quote them. */
  factIds?: string[]
}

/** One fact the check was handed, as the composer of a scope reports it. */
export interface ScopeFactDraft {
  factId: string
  entityId: string
  /** The declaration it travelled. Left out for the entity's own facts. */
  via?: string
}

export interface CheckGapDraft {
  reason: CheckGapReason
  detail: string
  entityId?: string
  via?: string
}

export interface CheckPassDraft {
  checkKey: string
  tier: CheckTier
  artifactId: string
  /** Defaults to the artifact's current version — a check reads what is there now. */
  version?: number
  /** Set for a scene-scoped re-check (D14). */
  sceneId?: string | null
  /** Left out or empty, the pass is a clean run, and the row saying so is the point. */
  findings?: FindingDraft[]
  /**
   * Every fact this check ran with, in the order it was composed. A deterministic rule
   * leaves this off — it reads rows rather than a prompt, and `finding_fact` already says
   * which of them it quoted.
   */
  scope?: ScopeFactDraft[]
  /** What it could not reach. Left off, the pass reached everything it was given. */
  gaps?: CheckGapDraft[]
}

// ── Recording ───────────────────────────────────────────────────────────────────

/**
 * Records one pass of one check, and whatever it found — including nothing.
 *
 * **This is the only path that writes a finding**, and that is the design rather than a
 * convenience: a finding without a pass would be a complaint with no record of the run that
 * produced it, and E3-6's ratio would have a numerator and no denominator. The two are
 * written in one transaction for the same reason.
 */
export function recordCheckPass(store: Store, draft: CheckPassDraft): CheckPass {
  return store.transaction(() => {
    const artifact = findArtifact(store, draft.artifactId)
    if (!artifact) throw new Error(`No such artifact: ${draft.artifactId}`)
    // Resolved once. A check reads one version, and every finding it raises against that
    // artifact was found at the same one — two reads could straddle a revision.
    const checked = { id: artifact.id, version: draft.version ?? artifact.version }

    const id = newId('pass')
    store.run(
      `INSERT INTO check_pass (id, check_key, tier, artifact_id, artifact_version, scene_id)
            VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      draft.checkKey,
      draft.tier,
      checked.id,
      checked.version,
      draft.sceneId ?? null,
    )

    // The scope first: what the check was handed is true before anything it said about it,
    // and a pass whose findings were written and whose scope was not would be a report card
    // with no exam paper behind it. One transaction, so that never happens.
    ;(draft.scope ?? []).forEach((loaded, ordinal) => {
      store.run(
        'INSERT INTO check_pass_fact (pass_id, ordinal, fact_id, entity_id, via) VALUES (?, ?, ?, ?, ?)',
        id,
        ordinal,
        loaded.factId,
        loaded.entityId,
        loaded.via ?? '',
      )
    })
    for (const finding of draft.findings ?? []) raiseFinding(store, id, checked, finding)
    for (const gap of draft.gaps ?? []) recordGap(store, id, gap)
    return findCheckPass(store, id)!
  })
}

/** One thing the check could not reach. Private, for `raiseFinding`'s reason. */
function recordGap(store: Store, passId: string, draft: CheckGapDraft): void {
  store.run(
    'INSERT INTO check_gap (id, pass_id, entity_id, reason, via, detail) VALUES (?, ?, ?, ?, ?, ?)',
    newId('gap'),
    passId,
    draft.entityId ?? null,
    draft.reason,
    draft.via ?? '',
    draft.detail,
  )
}

/**
 * One finding, hung off the pass that found it. Private on purpose — see `recordCheckPass`.
 *
 * The anchor's artifact defaults to the one the check read, which is right for every check
 * but the continuity board's; a check that lands its findings somewhere else says so, and
 * the version it names is resolved against THAT artifact rather than inherited.
 */
function raiseFinding(
  store: Store,
  passId: string,
  checked: { id: string; version: number },
  draft: FindingDraft,
): void {
  const anchoredIn = draft.anchor?.artifactId ?? checked.id
  const version = draft.anchor?.version ?? versionOf(store, anchoredIn, checked)

  const id = newId('find')
  store.run(
    `INSERT INTO finding
       (id, pass_id, artifact_id, artifact_version, scene_id, quote, concern, entity_id,
        severity, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    passId,
    anchoredIn,
    version,
    draft.anchor?.sceneId ?? null,
    draft.anchor?.quote ?? '',
    draft.concern,
    draft.entityId ?? null,
    draft.severity,
    draft.confidence,
  )

  ;(draft.factIds ?? []).forEach((factId, ordinal) => {
    store.run(
      'INSERT INTO finding_fact (finding_id, ordinal, fact_id) VALUES (?, ?, ?)',
      id,
      ordinal,
      factId,
    )
  })
}

/** The version an anchor lands at: the checked one, or the far artifact's current one. */
function versionOf(store: Store, artifactId: string, checked: { id: string; version: number }): number {
  if (artifactId === checked.id) return checked.version
  const elsewhere = findArtifact(store, artifactId)
  if (!elsewhere) throw new Error(`No such artifact: ${artifactId}`)
  return elsewhere.version
}

/**
 * Ryan putting a finding down with a note — 4.3's third remediation button, "recorded".
 *
 * The note is required, and refusing an empty one is not fussiness: 4.4 says dismissal notes
 * feed future runs' context, E3-5 builds the reader that hands them to a writer, and E3-6
 * counts this row against the check that raised it. A dismissal with nothing in it teaches
 * nobody anything and still costs the check its credibility.
 *
 * **This rules nothing and writes no canon.** Dismissing a finding says the check was wrong
 * or does not matter here; if the WORLD was wrong, the remediation is a proposal (E3-5), and
 * only Ryan ratifying that proposal moves canon (invariant 1).
 */
export function dismissFinding(store: Store, findingId: string, note: string): Finding {
  return store.transaction(() => {
    const finding = findFinding(store, findingId)
    if (!finding) throw new Error(`No such finding: ${findingId}`)
    if (finding.disposition) {
      throw new Error(
        `That finding was already ${finding.disposition.kind} — “${finding.disposition.note}”. ` +
          'A disposition is kept forever (4.4); a later opinion is a later check pass.',
      )
    }
    if (note.trim() === '') {
      throw new Error(
        'Dismissing a finding takes a note. It is read back by later runs (4.4) and counted ' +
          'against the check that raised it (D11) — an empty one teaches nothing and still ' +
          'spends the check’s credibility.',
      )
    }

    store.run(
      'INSERT INTO finding_disposition (finding_id, disposition, note) VALUES (?, ?, ?)',
      findingId,
      'dismissed',
      note,
    )
    return findFinding(store, findingId)!
  })
}

// ── Reading ─────────────────────────────────────────────────────────────────────

export function findCheckPass(store: Store, id: string): CheckPass | undefined {
  const row = store.get<PassRow>(`${PASS_SELECT} WHERE p.id = ?`, id)
  return row && hydratePass(row)
}

/**
 * Every check that has run against this artifact, oldest first — including the ones that
 * found nothing, which is the whole reason the row exists.
 */
export function checkPassesOf(store: Store, artifactId: string): CheckPass[] {
  return store
    .all<PassRow>(`${PASS_SELECT} WHERE p.artifact_id = ? ORDER BY p.ran_at, p.rowid`, artifactId)
    .map(hydratePass)
}

/**
 * The facts this pass ran with, in the order they were composed — hydrated through
 * `findFact`, so each arrives with the lineage the gate room renders beside it.
 *
 * This is what makes "rule 2 was checked and said nothing" a record rather than an
 * inference. Read it against `findingsOfPass` and the difference between a rule that was in
 * front of the check and one that never reached it is a set subtraction.
 */
export function scopeOfPass(store: Store, passId: string): ScopeFact[] {
  return store
    .all<{ fact_id: string; entity_id: string; via: string }>(
      'SELECT fact_id, entity_id, via FROM check_pass_fact WHERE pass_id = ? ORDER BY ordinal',
      passId,
    )
    .map((row) => ({
      fact: findFact(store, row.fact_id)!,
      entityId: row.entity_id,
      via: row.via,
    }))
}

/** What this pass could not reach. Empty is an answer, and `CheckPass.gapCount` already said. */
export function gapsOfPass(store: Store, passId: string): CheckGap[] {
  return store
    .all<GapRow>(`${GAP_SELECT} WHERE g.pass_id = ? ORDER BY g.rowid`, passId)
    .map(hydrateGap)
}

/**
 * Everything any check has been unable to check about this entity, oldest first — the canon
 * library's gaps list from the checking side, where D22's `declaredUnknowns` is the same
 * question asked of the declaration.
 *
 * Every pass that loaded the entity records its own gap, because a gap is a property of the
 * scope ONE pass ran with: the world-rules check and the character check were each handed
 * the same hole, and each is entitled to say so. Folding them for a screen is the screen's
 * business, and doing it here would lose which checks were affected.
 */
export function gapsAbout(store: Store, entityId: string): CheckGap[] {
  return store
    .all<GapRow>(`${GAP_SELECT} WHERE g.entity_id = ? ORDER BY p.ran_at, g.rowid`, entityId)
    .map(hydrateGap)
}

export function findFinding(store: Store, id: string): Finding | undefined {
  const row = store.get<FindingRow>(`${FINDING_SELECT} WHERE f.id = ?`, id)
  return row && hydrate(store, row)
}

/** What one pass said. Empty is an answer, and `CheckPass.findingCount` already told you. */
export function findingsOfPass(store: Store, passId: string): Finding[] {
  return store
    .all<FindingRow>(`${FINDING_SELECT} WHERE f.pass_id = ? ${ORDER}`, passId)
    .map((row) => hydrate(store, row))
}

/**
 * Everything anchored in this artifact, in document order — the gate room's left column,
 * which renders one artifact with every finding sitting at its span.
 *
 * Anchored, not checked: a continuity-board finding lands here because it lands in this
 * script's scene 4, even though the pass that raised it read the board (E3-1).
 *
 * Narrow to a scene for D14's scene-scoped re-check (E3-5), which clears findings BY SCENE.
 * A finding with no scene is about the whole artifact and is not in any scene's list.
 */
export function findingsIn(
  store: Store,
  artifactId: string,
  scope?: { sceneId: string },
): Finding[] {
  const rows = scope
    ? store.all<FindingRow>(
        `${FINDING_SELECT} WHERE f.artifact_id = ? AND f.scene_id = ? ${ORDER}`,
        artifactId,
        scope.sceneId,
      )
    : store.all<FindingRow>(`${FINDING_SELECT} WHERE f.artifact_id = ? ${ORDER}`, artifactId)
  return rows.map((row) => hydrate(store, row))
}

// ── Rows ────────────────────────────────────────────────────────────────────────

interface PassRow {
  id: string
  check_key: string
  tier: CheckTier
  artifact_id: string
  artifact_version: number
  scene_id: string | null
  ran_at: string
  finding_count: number
  gap_count: number
}

/**
 * The counts are subqueries rather than columns (0010). Neither can drift from the rows it
 * counts, a pass that found nothing reports 0 rather than reporting nothing, and the two are
 * separate numbers because "found nothing" and "could not look" are separate answers.
 */
const PASS_SELECT = `
  SELECT p.id, p.check_key, p.tier, p.artifact_id, p.artifact_version, p.scene_id, p.ran_at,
         (SELECT COUNT(*) FROM finding f WHERE f.pass_id = p.id) AS finding_count,
         (SELECT COUNT(*) FROM check_gap g WHERE g.pass_id = p.id) AS gap_count
    FROM check_pass p`

const hydratePass = (row: PassRow): CheckPass => ({
  id: row.id,
  checkKey: row.check_key,
  tier: row.tier,
  artifactId: row.artifact_id,
  artifactVersion: row.artifact_version,
  sceneId: row.scene_id,
  ranAt: row.ran_at,
  findingCount: row.finding_count,
  gapCount: row.gap_count,
})

interface GapRow {
  id: string
  pass_id: string
  check_key: string
  entity_id: string | null
  reason: CheckGapReason
  via: string
  detail: string
}

/** The check's identity comes off the pass, as a finding's does — stored once, there. */
const GAP_SELECT = `
  SELECT g.id, g.pass_id, g.entity_id, g.reason, g.via, g.detail, p.check_key
    FROM check_gap g
    JOIN check_pass p ON p.id = g.pass_id`

const hydrateGap = (row: GapRow): CheckGap => ({
  id: row.id,
  passId: row.pass_id,
  checkKey: row.check_key,
  entityId: row.entity_id,
  reason: row.reason,
  via: row.via,
  detail: row.detail,
})

interface FindingRow {
  id: string
  pass_id: string
  check_key: string
  tier: CheckTier
  artifact_id: string
  artifact_version: number
  scene_id: string | null
  quote: string
  concern: string
  entity_id: string | null
  severity: FindingSeverity
  confidence: FindingConfidence
  /** From the LEFT JOIN. NULL in all three while the finding is still open. */
  disposition: FindingDispositionKind | null
  disposition_note: string | null
  disposition_at: string | null
}

/**
 * One SELECT, one hydrator — `fact.ts`'s rule, for its reason: a finding that grows a column
 * must not leave a second hand-built copy behind. The pass join carries the check's identity
 * (it is stored once, there), and the scene join is only for the ordering below.
 */
const FINDING_SELECT = `
  SELECT f.id, f.pass_id, f.artifact_id, f.artifact_version, f.scene_id, f.quote,
         f.concern, f.entity_id, f.severity, f.confidence,
         p.check_key, p.tier,
         d.disposition, d.note AS disposition_note, d.at AS disposition_at
    FROM finding f
    JOIN check_pass p ON p.id = f.pass_id
    LEFT JOIN scene s ON s.id = f.scene_id
    LEFT JOIN finding_disposition d ON d.finding_id = f.id`

/**
 * Document order: by the scene the finding sits in, then by the order the check raised them.
 * SQLite sorts NULL first in ASC, which is what a whole-artifact finding wants — it is not
 * at a span, so it belongs above the ones that are.
 */
const ORDER = 'ORDER BY s.ordinal, f.rowid'

function hydrate(store: Store, row: FindingRow): Finding {
  const disposition: FindingDisposition | null =
    row.disposition === null
      ? null
      : { kind: row.disposition, note: row.disposition_note ?? '', at: row.disposition_at! }

  return {
    id: row.id,
    passId: row.pass_id,
    checkKey: row.check_key,
    tier: row.tier,
    anchor: {
      artifactId: row.artifact_id,
      version: row.artifact_version,
      sceneId: row.scene_id,
      quote: row.quote,
    },
    concern: row.concern,
    entityId: row.entity_id,
    facts: quotedFacts(store, row.id),
    severity: row.severity,
    confidence: row.confidence,
    status: disposition?.kind ?? 'open',
    disposition,
  }
}

/** Hydrated through `findFact`, so a quoted fact arrives with the lineage the card renders. */
function quotedFacts(store: Store, findingId: string): Fact[] {
  return store
    .all<{ fact_id: string }>(
      'SELECT fact_id FROM finding_fact WHERE finding_id = ? ORDER BY ordinal',
      findingId,
    )
    .map((row) => findFact(store, row.fact_id)!)
}
