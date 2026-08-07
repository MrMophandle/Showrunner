import type { Store } from '../db/store.ts'
import { findArtifact, provenanceOf, type Artifact } from './artifact.ts'
import type { CanonEntity } from './canon.ts'
import { factsInScope, type Override } from './fact.ts'
import { recordCheckPass, type CheckPass, type FindingDraft } from './finding.ts'

/**
 * The structural tier (3.4, 4.2): **deterministic, free, certain**.
 *
 * These are the canon-graph checks — the half of 4.2's first tier that is not the continuity
 * board (E3-1). They call no model, cost nothing, and answer with `confidence: certain`,
 * because that is what the tier means: there is no reading involved, only a join. A check
 * here either found the thing or it did not.
 *
 * Both read exactly the entities the artifact declares it touches (invariant 2) —
 * `provenanceOf`, then `factsInScope` per entity, never the whole bible. And both LEAVE A
 * RECORD WHETHER OR NOT THEY FIND ANYTHING: `runStructuralChecks` writes one check pass per
 * check, always, because a clean run is a measurement and not an absence (see
 * domain/finding.ts).
 *
 * **Neither check enforces anything.** A deterministic finding blocks the next stage and
 * never Ryan's gate (D12), and that wall is a computation over open deterministic findings
 * built in E3-3. What is here is the finding.
 *
 * ## Why these two have no span to quote
 *
 * A text check anchors at the sentence it argues with. These do not argue with sentences —
 * they argue with the artifact's PROVENANCE, which is the list of entities loaded into
 * check scope in the first place. So the anchor is the artifact itself (its own scene, when
 * it belongs to one) with an empty quote, and the gate room renders them on the verdict
 * board rather than inline. That is the honest anchor; inventing a span by searching the
 * text for a character's name would be a guess dressed as a `certain` finding.
 */

/**
 * The checks this tier runs, kebab-case like every other id in the app. A closed set, and
 * `runStructuralChecks` calls each one by name in plain TypeScript below — no catalogue, no
 * registry, no configurable list of checks (the Archon rule). Adding one is an edit there
 * with a test, exactly as adding a stage to `runner/stages.ts` is.
 */
export const STRUCTURAL_CHECK = ['stale-exception', 'retired-reappearance'] as const
export type StructuralCheck = (typeof STRUCTURAL_CHECK)[number]

/**
 * Runs the whole tier over one artifact and records what each check said, including the
 * ones that said nothing.
 *
 * One transaction: two passes are one run of the tier, and a half-recorded run would tell
 * E3-6 that one check fires half as often as its sibling.
 */
export function runStructuralChecks(store: Store, artifactId: string): CheckPass[] {
  const artifact = findArtifact(store, artifactId)
  if (!artifact) throw new Error(`No such artifact: ${artifactId}`)

  return store.transaction(() => [
    recordCheckPass(store, {
      checkKey: 'stale-exception',
      tier: 'deterministic',
      artifactId: artifact.id,
      findings: checkStaleExceptions(store, artifact),
    }),
    recordCheckPass(store, {
      checkKey: 'retired-reappearance',
      tier: 'deterministic',
      artifactId: artifact.id,
      findings: checkRetiredReappearance(store, artifact),
    }),
  ])
}

/**
 * **The ground moved beneath an exception.**
 *
 * D22's addendum: an individual exception is a fact on a character naming the inherited fact
 * it displaces, and it displaces the LINEAGE rather than the row — edit the species fact and
 * the exception carries forward onto the successor. What that cannot infer is that the
 * exception still makes sense against what the species now says.
 *
 * `factsInScope` already derives exactly that, at read time, and E2-1 built `Override.stale`
 * for this issue to surface. **This check does not recompute it.** It reads what the scope
 * helper hands over and turns a stale override into an anchored finding — which is the
 * whole reason the flag is computed there rather than remembered anywhere.
 *
 * Severity `medium`: nothing in the artifact is wrong and the exception is still canon and
 * still applies. What is owed is a ruling — Ryan looking at the exception beside what now
 * stands where it was written, and deciding whether it still says what he meant.
 */
export function checkStaleExceptions(store: Store, artifact: Artifact): FindingDraft[] {
  const findings: FindingDraft[] = []

  for (const entity of provenanceOf(store, artifact.id)) {
    for (const override of factsInScope(store, entity.id).overrides) {
      if (!override.stale) continue
      findings.push({
        concern: staleExceptionConcern(entity, override),
        severity: 'medium',
        confidence: 'certain',
        anchor: { sceneId: artifact.sceneId },
        entityId: entity.id,
        // The exception, the inherited fact it was written against, and — when there is one
        // — what stands in that fact's place today. The card quotes them in that order,
        // because that is the order the sentence needs them in.
        factIds: [
          override.by.id,
          override.overridden.id,
          ...(override.displaces ? [override.displaces.id] : []),
        ],
      })
    }
  }
  return findings
}

function staleExceptionConcern(entity: CanonEntity, override: Override): string {
  const opening =
    `The ground moved beneath ${entity.name}’s exception — revisiting it is a ruling. ` +
    'The exception is still canon and still applies; '

  return override.displaces
    ? `${opening}the inherited fact it was written against has been superseded, so it now ` +
        'displaces a successor nobody ruled it against.'
    : `${opening}the inherited fact it was written against is gone — reverted, or no longer ` +
        'reached by the edge it travelled — so it displaces nothing at all.'
}

/**
 * **A retired entity is back.**
 *
 * Standing is a declaration Ryan made about the show — "declared intent, not a count" (3.1,
 * E2-0's column) — and appearance is computed from provenance, which is E1's rule and the
 * reason `artifact_provenance` carries a real foreign key. Neither is new state and this
 * check invents none: it joins the two and reports where they disagree.
 *
 * Severity `high`: `retired` means the show is done with them, and an artifact built on them
 * says otherwise. One of the two is wrong — the standing, or the episode — and either answer
 * is Ryan's. Confidence `certain`, because there is nothing here to be unsure about; the
 * declaration says `retired` and the provenance row exists.
 *
 * Flashbacks and archive footage are exactly why this argues rather than vetoes (invariant
 * 3): a legitimate one gets dismissed with a note, which is a record, and D11 counts it.
 */
export function checkRetiredReappearance(store: Store, artifact: Artifact): FindingDraft[] {
  return provenanceOf(store, artifact.id)
    .filter((entity) => entity.standing === 'retired')
    .map((entity) => ({
      concern:
        `${entity.name} is declared retired, and this ${artifact.kind} is built on them. ` +
        'Standing is a declaration about the show and provenance is what the episode ' +
        'actually touches — the two disagree, and one of them is wrong.',
      severity: 'high' as const,
      confidence: 'certain' as const,
      anchor: { sceneId: artifact.sceneId },
      entityId: entity.id,
    }))
}
