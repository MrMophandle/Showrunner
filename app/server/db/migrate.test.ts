import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate, MIGRATION_DIR, migrationsOnDisk, RESERVED_TABLE_NAME } from './migrate.ts'
import { openStore, type Store } from './store.ts'

let store: Store

beforeEach(() => {
  store = openStore(':memory:')
})

afterEach(() => {
  store.close()
})

/** The tables E1-2 owns. A later epic adds to this list; it never alters what is here. */
const SPINE_TABLE = [
  'arc',
  'arc_edit',
  'arc_waypoint',
  'artifact',
  'artifact_input',
  'artifact_provenance',
  'artifact_revision',
  'canon_entity',
  'episode',
  'episode_arc_position',
  'scene',
  'season',
  'show',
]

/** The tables E1-3 owns: the run ledger and the named locks. No pipeline lives here. */
const RUNNER_TABLE = ['resource_lock', 'run', 'step', 'step_attempt']

/**
 * The tables E1-5 owns: the append-only log, and (from 0004) the kinds it will accept.
 * Still no topic and no subscription beside them.
 */
const EVENT_TABLE = ['event', 'event_kind']

/** The tables E1-4 owns: the decision object, its rounds, their rulings, and the notes. */
const GATE_TABLE = ['gate', 'gate_note', 'gate_round', 'gate_ruling']

/**
 * The tables E1-6 owns: what every call cost, and what a show may spend in a week. E6
 * writes its image and audio rows into `cost_entry` too — that is why there is no second
 * table waiting to be added for them.
 */
const COST_TABLE = ['cost_entry', 'show_budget']

/**
 * The tables E2-0 owns: the canon graph. `canon_entity` is NOT here — 0006 grows E1-2's
 * table with ADD COLUMN and never rebuilds it, because `artifact_provenance` holds a
 * foreign key into it and SQLite has no ADD CONSTRAINT.
 */
const CANON_TABLE = [
  'canon_category',
  'category_artifact_kind',
  'category_field',
  'entity_reference',
  'relation',
  'relation_type',
]

/**
 * The tables E2-1 owns: the facts, the closures that end their validity ranges, and the
 * ruling anchor their lineage points at. `canon_ruling` is deliberately thin — E2-2 grows
 * it into the full disposition ledger by ADD COLUMN rather than adding a sibling, which is
 * why no `proposal_ruling` or `disposition` is waiting to be added to this list.
 */
const FACT_TABLE = ['canon_ruling', 'fact', 'fact_closure']

/**
 * The tables E2-2 owns: the proposal and the four parts of the change it carries.
 * `canon_ruling` is NOT here — 0008 grows E2-1's ledger with ADD COLUMN, which is the one
 * structural mistake this migration could have made and the reason 0007's header says so.
 */
const PROPOSAL_TABLE = [
  'proposal',
  'proposal_alternative',
  'proposal_fact',
  'proposal_reference',
  'proposal_relation',
]

/**
 * The one table E2-3 owns. Its three flows are otherwise pure proposal-raising, and the two
 * proposal kinds they add (`revert`, `landing`) cost no SQL at all — which is what 0007 and
 * 0008 bought by refusing a CHECK on `kind`. `episode` is not rebuilt either: `abandoned_at`
 * is an ADD COLUMN, because an episode dies at any lifecycle stage.
 */
const EPISODE_CANON_TABLE = ['proposal_landing']

/**
 * The tables E3-0 owns: the record that a check ran, what it found, the facts a finding
 * quotes, and what Ryan did about it. Nothing here is a lock — there is no `blocked` table
 * and no `is_blocking` column, because D12's stage wall is a computation over open
 * deterministic findings (E3-3), the way artifact staleness is a computation over edges.
 */
const CHECK_TABLE = ['check_pass', 'finding', 'finding_disposition', 'finding_fact']

/**
 * The tables E3-1 owns: the continuity board (3.2b). Four, and each is a different question
 * the free rules ask — the scene grid itself, who is in each scene, what the geography costs
 * to cross, and which species the void kills. Nothing here is a flag either: a board finding
 * is `deterministic` and D12's wall is still E3-3's computation.
 */
const BOARD_TABLE = ['board_hazard', 'board_presence', 'board_scene', 'board_transit']

/**
 * The two E3-2 owns: what a semantic check was HANDED, and what it could not reach. Both
 * hang off `check_pass` and neither is state — `check_pass_fact` is the scope a pass ran
 * with, kept because canon moves on afterwards, and `check_gap` is the third kind of
 * nothing (fact.ts) that a zero-finding pass would otherwise be mistaken for.
 */
const SCOPE_TABLE = ['check_gap', 'check_pass_fact']

const EVERY_TABLE = [
  ...BOARD_TABLE,
  ...CHECK_TABLE,
  ...SCOPE_TABLE,
  ...EPISODE_CANON_TABLE,
  ...SPINE_TABLE,
  ...RUNNER_TABLE,
  ...EVENT_TABLE,
  ...GATE_TABLE,
  ...COST_TABLE,
  ...CANON_TABLE,
  ...FACT_TABLE,
  ...PROPOSAL_TABLE,
  'schema_migration',
].sort()

function tableNames(s: Store): string[] {
  return s
    .all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .map((row) => row.name)
}

describe('the migrations runner', () => {
  it('applies every numbered file in order and records what it applied', () => {
    const applied = migrate(store)

    expect(applied.map((m) => m.number)).toEqual(migrationsOnDisk().map((m) => m.number))
    expect(applied.map((m) => m.number)).toEqual([...applied.map((m) => m.number)].sort((a, b) => a - b))
    expect(applied.length).toBeGreaterThan(0)

    const recorded = store.all<{ number: number; name: string }>(
      'SELECT number, name FROM schema_migration ORDER BY number',
    )
    expect(recorded.map((r) => r.number)).toEqual(applied.map((m) => m.number))
  })

  it('is idempotent — a second run applies nothing', () => {
    migrate(store)

    expect(migrate(store)).toEqual([])
  })

  it('creates exactly the spine tables and the run ledger, and nothing else', () => {
    migrate(store)

    expect(tableNames(store)).toEqual(EVERY_TABLE)
  })

  it('has claimed every reserved name — 0008 took the last one', () => {
    migrate(store)

    // 0001's block is spent: 0006 took three, 0007 took `fact`, 0008 took `proposal`. The
    // list stays here and stays empty, because it is what a later epic adds to when it
    // reserves a name of its own — and what proves nothing is quietly squatting on one.
    expect(RESERVED_TABLE_NAME).toEqual([])
    expect(tableNames(store)).toEqual(
      expect.arrayContaining([
        'relation',
        'relation_type',
        'canon_category',
        'fact',
        'proposal',
      ]),
    )
  })
})

/**
 * 0004 rebuilds `event` to trade the `kind` CHECK for a foreign key into `event_kind`.
 * Rebuilding the audit trail is the one thing in this schema that could quietly lose
 * history, so it is proved rather than trusted: a log written under 0003 has to come out
 * the other side byte for byte, still numbered the same, still un-editable.
 */
/** Everything up to `upTo`, applied by hand, so a later migration meets a library with rows in it. */
function applyThrough(upTo: number): void {
  store.exec(`CREATE TABLE IF NOT EXISTS schema_migration (
    number INTEGER PRIMARY KEY, name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))`)
  for (const migration of migrationsOnDisk().filter((m) => m.number <= upTo)) {
    store.exec(readFileSync(join(MIGRATION_DIR, migration.file), 'utf8'))
    store.run(
      'INSERT INTO schema_migration (number, name) VALUES (?, ?)',
      migration.number,
      migration.name,
    )
  }
}

describe('0004 · rebuilding the event log', () => {
  function writeThreeEvents(): void {
    store.run("INSERT INTO show (id, key, title) VALUES ('show1', 'greyharbor', 'Grey Harbor')")
    store.run("INSERT INTO season (id, show_id, number) VALUES ('season1', 'show1', 1)")
    store.run("INSERT INTO episode (id, season_id, number, title) VALUES ('ep5', 'season1', 5, 'The Quiet Deck')")
    store.run("INSERT INTO run (id, episode_id, stage) VALUES ('run1', 'ep5', 'write')")
    for (const [kind, summary] of [
      ['run-queued', 'write is queued'],
      ['run-started', 'write is running'],
      ['step-chunk', 'Debt has a temperature.'],
    ]) {
      store.run(
        'INSERT INTO event (kind, run_id, episode_id, summary, detail) VALUES (?, ?, ?, ?, ?)',
        kind!,
        'run1',
        'ep5',
        summary!,
        '{"stage":"write"}',
      )
    }
  }

  it('carries every row across with its seq, and keeps numbering above the highest', () => {
    applyThrough(3)
    writeThreeEvents()
    const before = store.all('SELECT * FROM event ORDER BY seq')

    // Everything from 0004 on, whatever has been added since — the subject here is that
    // 0004 ran against a log with rows in it, not how many migrations exist today.
    expect(migrate(store).map((m) => m.number)).toEqual(
      migrationsOnDisk()
        .map((m) => m.number)
        .filter((number) => number > 3),
    )

    expect(store.all('SELECT * FROM event ORDER BY seq')).toEqual(before)
    // AUTOINCREMENT reads sqlite_sequence, and the explicit-seq copy has to have moved it —
    // otherwise the next append reuses seq 1 and every SSE id a browser holds goes stale.
    expect(
      store.get<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = 'event'"),
    ).toEqual({ seq: 3 })
    store.run(
      "INSERT INTO event (kind, run_id, episode_id, summary) VALUES ('gate-opened', 'run1', 'ep5', 'the ep05 script gate is open')",
    )
    expect(store.get<{ seq: number }>('SELECT MAX(seq) AS seq FROM event')).toEqual({ seq: 4 })
  })

  it('leaves the log append-only — the triggers survive the rebuild', () => {
    applyThrough(3)
    writeThreeEvents()
    migrate(store)

    expect(() => store.run("UPDATE event SET summary = 'never happened' WHERE seq = 1")).toThrow(
      /append-only/,
    )
    expect(() => store.run('DELETE FROM event WHERE seq = 1')).toThrow(/append-only/)
    expect(store.get<{ n: number }>('SELECT COUNT(*) AS n FROM event')).toEqual({ n: 3 })
  })
})

/**
 * 0006 grows `canon_entity` rather than rebuilding it. The reason is one table over:
 * `artifact_provenance` carries a foreign key into it, put there in E1-2 precisely because
 * SQLite has no ADD CONSTRAINT — rebuild the entity table and that edge is what breaks.
 * Ryan's library already holds entities and provenance from the E1 drill, so this is proved
 * against rows rather than against an empty file.
 */
describe('0006 · growing canon_entity, not rebuilding it', () => {
  function writeAnEntityWithProvenance(): void {
    store.run("INSERT INTO show (id, key, title) VALUES ('show1', 'greyharbor', 'Grey Harbor')")
    store.run("INSERT INTO season (id, show_id, number) VALUES ('season1', 'show1', 1)")
    store.run("INSERT INTO episode (id, season_id, number, title) VALUES ('ep1', 'season1', 1, 'The Long Pier')")
    store.run(
      "INSERT INTO canon_entity (id, show_id, category_key, name) VALUES ('ent1', 'show1', 'character', 'Tobin Wick')",
    )
    store.run("INSERT INTO artifact (id, episode_id, kind) VALUES ('art1', 'ep1', 'script')")
    store.run("INSERT INTO artifact_provenance (artifact_id, entity_id) VALUES ('art1', 'ent1')")
  }

  it('keeps every entity row and the provenance edge pointing at it', () => {
    applyThrough(5)
    writeAnEntityWithProvenance()

    expect(migrate(store).map((m) => m.number)).toEqual(
      migrationsOnDisk().map((m) => m.number).filter((number) => number > 5),
    )

    expect(store.get('SELECT id, show_id, category_key, name FROM canon_entity')).toEqual({
      id: 'ent1',
      show_id: 'show1',
      category_key: 'character',
      name: 'Tobin Wick',
    })
    expect(store.get('SELECT * FROM artifact_provenance')).toEqual({
      artifact_id: 'art1',
      entity_id: 'ent1',
    })
    // The edge is still ENFORCED, not merely still present: RESTRICT is what makes an
    // entity an episode was built on undeletable, and a rebuilt table loses it silently.
    expect(() => store.run("DELETE FROM canon_entity WHERE id = 'ent1'")).toThrow(/FOREIGN KEY/i)
  })

  it('gives an entity registered before E2 the anatomy it never declared', () => {
    applyThrough(5)
    writeAnEntityWithProvenance()
    migrate(store)

    // `candidate` is the truthful default: nothing ratified this row (invariant 1). Standing
    // is NULL because "not declared yet" and "declared one-shot" are different states.
    expect(
      store.get('SELECT category_id, standing, status, aliases, body FROM canon_entity'),
    ).toEqual({ category_id: null, standing: null, status: 'candidate', aliases: '', body: '' })
  })
})

/**
 * 0007 grows `relation_type` the same way, and for the same kind of reason one table over:
 * `relation` holds a foreign key into it. 0006 shipped and applies on real volumes, so the
 * added column is proved against a graph with edges in it rather than an empty file.
 */
describe('0007 · growing relation_type, not rebuilding it', () => {
  function writeADeclaredEdge(): void {
    store.run("INSERT INTO show (id, key, title) VALUES ('show1', 'greyharbor', 'Grey Harbor')")
    store.run(
      "INSERT INTO canon_category (id, show_id, key, name) VALUES ('cat1', 'show1', 'character', 'Character')",
    )
    store.run(
      "INSERT INTO canon_category (id, show_id, key, name) VALUES ('cat2', 'show1', 'species', 'Species')",
    )
    store.run(
      `INSERT INTO relation_type (id, category_id, name, target_category_id, cardinality, required, inverse_name)
            VALUES ('rt1', 'cat1', 'species', 'cat2', 'exactly-one', 1, 'members')`,
    )
    store.run(
      `INSERT INTO canon_entity (id, show_id, category_key, category_id, name)
            VALUES ('ent1', 'show1', 'character', 'cat1', 'Tobin Wick')`,
    )
    store.run(
      `INSERT INTO canon_entity (id, show_id, category_key, category_id, name)
            VALUES ('ent2', 'show1', 'species', 'cat2', 'Halvani')`,
    )
    store.run(
      "INSERT INTO relation (id, relation_type_id, from_entity_id, to_entity_id) VALUES ('rel1', 'rt1', 'ent1', 'ent2')",
    )
  }

  it('keeps every declaration and the edges written under it', () => {
    applyThrough(6)
    writeADeclaredEdge()

    expect(migrate(store).map((m) => m.number)).toEqual(
      migrationsOnDisk().map((m) => m.number).filter((number) => number > 6),
    )

    expect(store.get('SELECT id, name, cardinality, required, inverse_name FROM relation_type')).toEqual({
      id: 'rt1',
      name: 'species',
      cardinality: 'exactly-one',
      required: 1,
      inverse_name: 'members',
    })
    expect(store.get('SELECT id, from_entity_id, to_entity_id FROM relation')).toEqual({
      id: 'rel1',
      from_entity_id: 'ent1',
      to_entity_id: 'ent2',
    })
    // Still ENFORCED, not merely still present — a rebuilt table loses the edge silently.
    expect(() => store.run("DELETE FROM relation_type WHERE id = 'rt1'")).toThrow(/FOREIGN KEY/i)
  })

  it('leaves an edge declared before E2-1 carrying no facts, and refuses a third answer', () => {
    applyThrough(6)
    writeADeclaredEdge()
    migrate(store)

    // The honest default: nobody declared that facts travel this edge, so they do not. The
    // fixture's character sheet is what turns it on for `species` (D22).
    expect(store.get('SELECT inherits_facts FROM relation_type')).toEqual({ inherits_facts: 0 })
    expect(() =>
      store.run("UPDATE relation_type SET inherits_facts = 2 WHERE id = 'rt1'"),
    ).toThrow(/inherits_facts is 0 or 1/)
  })
})

/**
 * 0008 does to `canon_ruling` what 0007 did to `relation_type` and 0006 did to
 * `canon_entity`: ADD COLUMN, never a rebuild. The reason is two tables over — `fact` and
 * `fact_closure` both hold foreign keys into the ledger, and `seq` IS the clock canon is
 * read by, so a rebuilt ledger is a renumbered history. A sibling disposition table would
 * be the same failure by another route: half an order is no order.
 */
describe('0008 · growing canon_ruling, not rebuilding it', () => {
  function writeARatifiedFact(): void {
    store.run("INSERT INTO show (id, key, title) VALUES ('show1', 'greyharbor', 'Grey Harbor')")
    store.run("INSERT INTO season (id, show_id, number) VALUES ('season1', 'show1', 1)")
    store.run(
      "INSERT INTO episode (id, season_id, number, title) VALUES ('ep2', 'season1', 2, 'Dry Stores')",
    )
    store.run(
      "INSERT INTO canon_entity (id, show_id, category_key, name) VALUES ('ent1', 'show1', 'character', 'Mara')",
    )
    store.run("INSERT INTO canon_ruling (kind) VALUES ('ratification')")
    store.run(
      `INSERT INTO fact (id, entity_id, field, statement, established_in, ratified_by)
            VALUES ('fact1', 'ent1', 'conduct', 'Mara refuses to carry arms.', 'ep2', 1)`,
    )
  }

  it('keeps every ruling at its seq, and the lineage pointing at it', () => {
    applyThrough(7)
    writeARatifiedFact()

    expect(migrate(store).map((m) => m.number)).toEqual(
      migrationsOnDisk()
        .map((m) => m.number)
        .filter((number) => number > 7),
    )

    // The number a validity range is measured in. A rebuild that renumbered it would have
    // moved every fact in the library to a different moment in time.
    expect(store.get('SELECT seq, kind FROM canon_ruling')).toEqual({
      seq: 1,
      kind: 'ratification',
    })
    expect(store.get('SELECT id, ratified_by FROM fact')).toEqual({
      id: 'fact1',
      ratified_by: 1,
    })
    // Still ENFORCED, not merely still present.
    expect(() => store.run('DELETE FROM canon_ruling WHERE seq = 1')).toThrow(
      /a ruling is history/,
    )
  })

  it('gives a ruling made before E2-2 the disposition columns it never carried', () => {
    applyThrough(7)
    writeARatifiedFact()
    migrate(store)

    // A ruling from before proposals existed disposed of nothing and was convened at no
    // gate. NULL says exactly that, and '' is the empty note rather than a missing one.
    expect(store.get('SELECT proposal_id, gate_id, note FROM canon_ruling')).toEqual({
      proposal_id: null,
      gate_id: null,
      note: '',
    })
  })

  it('rules a proposal once — a second disposition is a constraint violation', () => {
    migrate(store)
    store.run("INSERT INTO show (id, key, title) VALUES ('show1', 'greyharbor', 'Grey Harbor')")
    store.run(
      "INSERT INTO canon_entity (id, show_id, category_key, name) VALUES ('ent1', 'show1', 'character', 'Mara')",
    )
    store.run(
      "INSERT INTO proposal (id, entity_id, kind, raised_by) VALUES ('prop1', 'ent1', 'fact-delta', 'writer')",
    )
    store.run("INSERT INTO canon_ruling (kind, proposal_id) VALUES ('rejection', 'prop1')")

    expect(() =>
      store.run("INSERT INTO canon_ruling (kind, proposal_id) VALUES ('ratification', 'prop1')"),
    ).toThrow(/UNIQUE/i)
    // The partial index leaves the ledger's own rulings alone — E2-1's ratifications and
    // E2-3's reverts dispose of no proposal, and there may be any number of them.
    store.run("INSERT INTO canon_ruling (kind) VALUES ('ratification')")
    store.run("INSERT INTO canon_ruling (kind) VALUES ('revert')")
    expect(store.get('SELECT COUNT(*) AS n FROM canon_ruling')).toEqual({ n: 3 })
  })
})

/**
 * 0009 grows `episode` the way 0008 grew `canon_ruling` and 0006 grew `canon_entity`: ADD
 * COLUMN, never a rebuild. Four tables hold foreign keys into `episode` — `scene`,
 * `artifact`, `episode_arc_position`, `proposal` — and SQLite has no ADD CONSTRAINT, so a
 * rebuilt episode table is a rebuilt half of the schema. The tempting alternative was
 * widening 0001's `CHECK (lifecycle IN (…))` to admit 'abandoned', which would have cost
 * exactly that rebuild AND said the wrong thing: an episode dies at any stage and keeps the
 * stage it reached.
 */
describe('0009 · abandonment is a column on episode, not a lifecycle stage', () => {
  it('gives a populated episode table the column, keeping every row where it was', () => {
    applyThrough(8)
    store.run("INSERT INTO show (id, key, title) VALUES ('show1', 'greyharbor', 'Grey Harbor')")
    store.run("INSERT INTO season (id, show_id, number) VALUES ('season1', 'show1', 1)")
    store.run(
      `INSERT INTO episode (id, season_id, number, title, lifecycle)
            VALUES ('ep1', 'season1', 1, 'The Long Pier', 'script')`,
    )
    store.run("INSERT INTO scene (id, episode_id, ordinal, heading) VALUES ('sc1', 'ep1', 1, 'EXT.')")

    expect(migrate(store).map((m) => m.number)).toEqual(
      migrationsOnDisk()
        .map((m) => m.number)
        .filter((number) => number > 8),
    )

    // The stage it reached is still there, and NULL is alive.
    expect(store.get('SELECT id, lifecycle, abandoned_at FROM episode')).toEqual({
      id: 'ep1',
      lifecycle: 'script',
      abandoned_at: null,
    })
    // The foreign key a rebuild would have had to re-point still points.
    expect(store.get('SELECT episode_id FROM scene')).toEqual({ episode_id: 'ep1' })
  })

  it('leaves the lifecycle CHECK exactly as 0001 wrote it — abandonment is orthogonal', () => {
    migrate(store)
    store.run("INSERT INTO show (id, key, title) VALUES ('show1', 'greyharbor', 'Grey Harbor')")
    store.run("INSERT INTO season (id, show_id, number) VALUES ('season1', 'show1', 1)")

    expect(() =>
      store.run(
        `INSERT INTO episode (id, season_id, number, title, lifecycle)
              VALUES ('ep1', 'season1', 1, 'The Long Pier', 'abandoned')`,
      ),
    ).toThrow(/CHECK constraint failed/)

    // An episode abandoned at 'premise' keeps 'premise'. That is the whole point.
    store.run(
      `INSERT INTO episode (id, season_id, number, title, abandoned_at)
            VALUES ('ep1', 'season1', 1, 'The Long Pier', '2026-08-06T00:00:00.000Z')`,
    )
    expect(store.get('SELECT lifecycle, abandoned_at FROM episode')).toEqual({
      lifecycle: 'premise',
      abandoned_at: '2026-08-06T00:00:00.000Z',
    })
  })

  it('takes no CHECK-widening for its two new proposal kinds — the payoff 0007 bought', () => {
    migrate(store)
    store.run("INSERT INTO show (id, key, title) VALUES ('show1', 'greyharbor', 'Grey Harbor')")
    store.run(
      "INSERT INTO canon_entity (id, show_id, category_key, name) VALUES ('ent1', 'show1', 'character', 'Mara')",
    )

    // `revert` and `landing` are a widened TypeScript union in domain/proposal.ts and
    // nothing else. Had 0008 put a CHECK on `kind`, this line would have been a rebuild.
    for (const kind of ['revert', 'landing']) {
      store.run(
        'INSERT INTO proposal (id, entity_id, kind, raised_by) VALUES (?, ?, ?, ?)',
        `prop_${kind}`,
        'ent1',
        kind,
        'ryan',
      )
    }
    expect(store.all('SELECT kind FROM proposal ORDER BY kind')).toEqual([
      { kind: 'landing' },
      { kind: 'revert' },
    ])
  })
})

/**
 * 0010 is the first migration in a while that only ADDS tables — nothing here grows or
 * rebuilds anything E1 or E2 applied, which is what it means for the finding to be a new
 * record rather than a new state on something that already exists. What it is proved
 * against is a library with an EPISODE, a SCRIPT, PROVENANCE and RATIFIED CANON already in
 * it, because those are the four things a finding points at and every one of them is a
 * foreign key that has to still hold afterwards.
 */
describe('0010 · findings, added beside a populated library', () => {
  function writeAnEpisodeWithCanon(): void {
    store.run("INSERT INTO show (id, key, title) VALUES ('show1', 'greyharbor', 'Grey Harbor')")
    store.run("INSERT INTO season (id, show_id, number) VALUES ('season1', 'show1', 1)")
    store.run(
      "INSERT INTO episode (id, season_id, number, title) VALUES ('ep1', 'season1', 1, 'The Long Pier')",
    )
    store.run("INSERT INTO scene (id, episode_id, ordinal, heading) VALUES ('sc4', 'ep1', 4, 'EXT. HULL')")
    store.run(
      "INSERT INTO canon_entity (id, show_id, category_key, name) VALUES ('ent1', 'show1', 'species', 'Halvani')",
    )
    store.run("INSERT INTO canon_ruling (kind) VALUES ('ratification')")
    store.run(
      `INSERT INTO fact (id, entity_id, statement, ratified_by)
            VALUES ('fact1', 'ent1', 'A Halvani in unprotected vacuum dies inside two minutes.', 1)`,
    )
    store.run("INSERT INTO artifact (id, episode_id, kind, file_path) VALUES ('art1', 'ep1', 'script', 'ep01/script.md')")
    store.run("INSERT INTO artifact_provenance (artifact_id, entity_id) VALUES ('art1', 'ent1')")
  }

  it('adds its four tables and alters none of the nine migrations before it', () => {
    applyThrough(9)
    writeAnEpisodeWithCanon()
    const before = Object.fromEntries(
      tableNames(store).map((name) => [name, store.all<unknown>(`SELECT * FROM ${name}`)]),
    )

    expect(migrate(store).map((m) => m.number)).toEqual(
      migrationsOnDisk()
        .map((m) => m.number)
        .filter((number) => number > 9),
    )

    // Every table that existed before, with every row exactly where it was. The only new
    // names are E3-0's four, E3-1's four and E3-2's two — every migration past 9 adds tables
    // and grows nothing, which is what it means for a check, a board and a check's own scope
    // to be new records rather than new state on something that already exists.
    for (const [name, rows] of Object.entries(before)) {
      if (name === 'schema_migration') continue
      expect({ [name]: store.all<unknown>(`SELECT * FROM ${name}`) }).toEqual({ [name]: rows })
    }
    expect(tableNames(store).filter((name) => !(name in before))).toEqual(
      [...BOARD_TABLE, ...CHECK_TABLE, ...SCOPE_TABLE].sort(),
    )
  })

  it('records a pass with no findings, and one anchored at a scene of the script', () => {
    applyThrough(9)
    writeAnEpisodeWithCanon()
    migrate(store)

    // The clean run first, because it is the one a schema is most likely to have made
    // impossible: a check pass carries no finding and needs none.
    store.run(
      `INSERT INTO check_pass (id, check_key, tier, artifact_id, artifact_version)
            VALUES ('pass1', 'world-rules', 'text', 'art1', 1)`,
    )
    expect(store.get('SELECT COUNT(*) AS n FROM finding WHERE pass_id = ?', 'pass1')).toEqual({ n: 0 })

    store.run(
      `INSERT INTO check_pass (id, check_key, tier, artifact_id, artifact_version)
            VALUES ('pass2', 'world-rules', 'text', 'art1', 1)`,
    )
    store.run(
      `INSERT INTO finding
         (id, pass_id, artifact_id, artifact_version, scene_id, quote, concern, entity_id,
          severity, confidence)
       VALUES ('find1', 'pass2', 'art1', 1, 'sc4', 'three minutes in coveralls',
               'Tobin is outside for three minutes; the Halvani fact says two.', 'ent1',
               'high', 'high')`,
    )
    store.run("INSERT INTO finding_fact (finding_id, ordinal, fact_id) VALUES ('find1', 0, 'fact1')")
    store.run(
      "INSERT INTO finding_disposition (finding_id, disposition, note) VALUES ('find1', 'dismissed', 'the collar counts as protection')",
    )

    expect(store.get('SELECT severity, confidence FROM finding')).toEqual({
      severity: 'high',
      confidence: 'high',
    })
    expect(store.get('SELECT fact_id FROM finding_fact')).toEqual({ fact_id: 'fact1' })
    expect(store.get('SELECT disposition, note FROM finding_disposition')).toEqual({
      disposition: 'dismissed',
      note: 'the collar counts as protection',
    })
  })

  it('holds every edge a finding points at, and refuses to move once written', () => {
    migrate(store)
    writeAnEpisodeWithCanon()
    store.run(
      `INSERT INTO check_pass (id, check_key, tier, artifact_id, artifact_version)
            VALUES ('pass1', 'world-rules', 'text', 'art1', 1)`,
    )
    store.run(
      `INSERT INTO finding (id, pass_id, artifact_id, artifact_version, scene_id, concern, entity_id, severity, confidence)
            VALUES ('find1', 'pass1', 'art1', 1, 'sc4', 'a concern', 'ent1', 'high', 'certain')`,
    )
    store.run("INSERT INTO finding_fact (finding_id, ordinal, fact_id) VALUES ('find1', 0, 'fact1')")

    // Enforced, not merely declared: an entity a check has spoken about and a fact it quoted
    // are not things anything else may take away underneath the record.
    expect(() => store.run("DELETE FROM canon_entity WHERE id = 'ent1'")).toThrow(/FOREIGN KEY/i)
    expect(() => store.run("DELETE FROM fact WHERE id = 'fact1'")).toThrow(/never deleted/)
    expect(() => store.run("UPDATE finding SET concern = 'never said that'")).toThrow(
      /a later pass/,
    )

    // But the cascade above stays open, which is the asymmetry `gate_ruling` carries in
    // 0004: an artifact deleted with its episode takes its passes and findings with it.
    store.run("DELETE FROM artifact WHERE id = 'art1'")
    expect(store.get('SELECT COUNT(*) AS n FROM check_pass')).toEqual({ n: 0 })
    expect(store.get('SELECT COUNT(*) AS n FROM finding')).toEqual({ n: 0 })
    expect(store.get('SELECT COUNT(*) AS n FROM finding_fact')).toEqual({ n: 0 })
  })
})

/**
 * 0011 lands on a library that already has an episode, its scenes, a script with provenance,
 * ratified canon and E3-0's checks in it — which is every foreign key the board points at.
 * It adds four tables and grows nothing, and the proof is the same one 0010 got: the rows
 * that were there are still there, byte for byte, and SQLite's own integrity and
 * foreign-key checks pass on the far side.
 */
describe('0011 · the continuity board, added beside a populated library', () => {
  function writeAScriptWithScenes(): void {
    store.run("INSERT INTO show (id, key, title) VALUES ('show1', 'greyharbor', 'Grey Harbor')")
    store.run("INSERT INTO season (id, show_id, number) VALUES ('season1', 'show1', 1)")
    store.run(
      "INSERT INTO episode (id, season_id, number, title) VALUES ('ep1', 'season1', 1, 'The Long Pier')",
    )
    store.run(
      `INSERT INTO scene (id, episode_id, ordinal, heading) VALUES
         ('sc5', 'ep1', 5, 'INT. HARBOURMASTER''S OFFICE — 07:20'),
         ('sc6', 'ep1', 6, 'EXT. THE LONG PIER — CONTINUOUS')`,
    )
    store.run(
      `INSERT INTO canon_entity (id, show_id, category_key, name) VALUES
         ('ent1', 'show1', 'species', 'Halvani'),
         ('ent2', 'show1', 'character', 'Ilse Renn'),
         ('ent3', 'show1', 'location', 'Grey Harbor Station')`,
    )
    store.run("INSERT INTO canon_ruling (kind) VALUES ('ratification')")
    store.run(
      `INSERT INTO fact (id, entity_id, statement, ratified_by) VALUES
         ('fact1', 'ent1', 'A Halvani in unprotected vacuum dies inside two minutes.', 1),
         ('fact2', 'ent3', 'Cycling the No. 4 lock takes ninety seconds in either direction.', 1)`,
    )
    store.run(
      "INSERT INTO artifact (id, episode_id, kind, file_path) VALUES ('art1', 'ep1', 'script', 'ep01/script.md')",
    )
    store.run("INSERT INTO artifact_provenance (artifact_id, entity_id) VALUES ('art1', 'ent1')")
    store.run(
      `INSERT INTO check_pass (id, check_key, tier, artifact_id, artifact_version)
            VALUES ('pass1', 'stale-exception', 'deterministic', 'art1', 1)`,
    )
  }

  it('adds its four tables, alters nothing, and leaves the file sound', () => {
    applyThrough(10)
    writeAScriptWithScenes()
    const before = Object.fromEntries(
      tableNames(store).map((name) => [name, store.all<unknown>(`SELECT * FROM ${name}`)]),
    )

    // Everything from 0011 on, whatever has been added since — the subject here is that the
    // board landed on a populated library, not how many migrations exist today.
    expect(migrate(store).map((m) => m.number)).toEqual(
      migrationsOnDisk().map((m) => m.number).filter((number) => number > 10),
    )

    for (const [name, rows] of Object.entries(before)) {
      if (name === 'schema_migration') continue
      expect({ [name]: store.all<unknown>(`SELECT * FROM ${name}`) }).toEqual({ [name]: rows })
    }
    expect(tableNames(store).filter((name) => !(name in before))).toEqual(
      [...BOARD_TABLE, ...SCOPE_TABLE].sort(),
    )

    expect(store.get('PRAGMA integrity_check')).toEqual({ integrity_check: 'ok' })
    expect(store.all('PRAGMA foreign_key_check')).toEqual([])
    // The runner's own rule, said again where it matters most: a migration applied twice
    // must be a no-op, because that is what every boot does.
    expect(migrate(store)).toEqual([])
  })

  it('holds a grid row, who is in it, what the crossing costs, and what the void kills', () => {
    migrate(store)
    writeAScriptWithScenes()
    store.run(
      "INSERT INTO artifact (id, episode_id, kind) VALUES ('board1', 'ep1', 'continuity-board')",
    )

    store.run(
      `INSERT INTO board_scene
         (board_id, scene_id, location, location_entity_id, environment, ship_position,
          elapsed_seconds, elapsed_label)
       VALUES ('board1', 'sc6', 'The Long Pier', 'ent3', 'exposed', '', 26400, 'CONTINUOUS')`,
    )
    store.run(
      `INSERT INTO board_presence (board_id, scene_id, character_name, entity_id, protection, arrives)
            VALUES ('board1', 'sc6', 'Ilse Renn', 'ent2', 'hardsuit', 1)`,
    )
    store.run(
      `INSERT INTO board_transit (board_id, from_location, to_location, seconds, fact_id)
            VALUES ('board1', 'Harbourmaster''s office', 'The Long Pier', 90, 'fact2')`,
    )
    store.run(
      `INSERT INTO board_hazard (board_id, entity_id, hazard, fact_id)
            VALUES ('board1', 'ent1', 'lethal-in-vacuum', 'fact1')`,
    )

    expect(store.get('SELECT environment, elapsed_seconds, ship_position FROM board_scene')).toEqual({
      environment: 'exposed',
      elapsed_seconds: 26400,
      ship_position: '',
    })
    expect(store.get('SELECT protection, arrives FROM board_presence')).toEqual({
      protection: 'hardsuit',
      arrives: 1,
    })
    expect(store.get('SELECT seconds, fact_id FROM board_transit')).toEqual({
      seconds: 90,
      fact_id: 'fact2',
    })
    expect(store.get('SELECT hazard, fact_id FROM board_hazard')).toEqual({
      hazard: 'lethal-in-vacuum',
      fact_id: 'fact1',
    })

    // A body cannot be present in a scene the board has no reading of — the composite edge
    // back to `board_scene`, enforced rather than assumed.
    expect(() =>
      store.run(
        `INSERT INTO board_presence (board_id, scene_id, character_name, protection)
              VALUES ('board1', 'sc5', 'Tobin Wick', 'none')`,
      ),
    ).toThrow(/FOREIGN KEY/i)

    // A fact a board quotes is not something anything else may take away underneath it.
    expect(() => store.run("DELETE FROM fact WHERE id = 'fact1'")).toThrow(/never deleted/)

    // But the board is derived, and it goes when what it was derived from goes: delete the
    // scene and its grid row and everyone in it go with it (D3's re-delineation).
    store.run("DELETE FROM scene WHERE id = 'sc6'")
    expect(store.get('SELECT COUNT(*) AS n FROM board_scene')).toEqual({ n: 0 })
    expect(store.get('SELECT COUNT(*) AS n FROM board_presence')).toEqual({ n: 0 })
  })
})

/**
 * 0012 lands on a library with an episode, a script, ratified canon and E3-0's check passes
 * already in it — every foreign key the semantic tier's two records point at.
 *
 * What is under test is the pair of distinctions the tables exist for. A pass that quotes a
 * fact in a finding and a pass that merely LOADED that fact are two different rows, so
 * "rule 2 was checked and said nothing" survives as a record rather than being inferred from
 * an absence. And a gap — "could not check, the species is undecided" — is neither of those
 * and is not a finding, so it hangs off the pass in a table of its own.
 */
describe('0012 · what a check was handed, and what it could not reach', () => {
  function writeAScriptWithCanonAndAPass(): void {
    store.run("INSERT INTO show (id, key, title) VALUES ('show1', 'greyharbor', 'Grey Harbor')")
    store.run("INSERT INTO season (id, show_id, number) VALUES ('season1', 'show1', 1)")
    store.run(
      "INSERT INTO episode (id, season_id, number, title) VALUES ('ep1', 'season1', 1, 'The Long Pier')",
    )
    store.run("INSERT INTO scene (id, episode_id, ordinal, heading) VALUES ('sc4', 'ep1', 4, 'EXT. THE LONG PIER')")
    store.run(
      `INSERT INTO canon_entity (id, show_id, category_key, name) VALUES
         ('ent1', 'show1', 'species', 'Halvani'),
         ('ent2', 'show1', 'character', 'Sefa Doule'),
         ('ent3', 'show1', 'world-rules', 'The hull and the void')`,
    )
    store.run("INSERT INTO canon_ruling (kind) VALUES ('ratification')")
    store.run(
      `INSERT INTO fact (id, entity_id, statement, ratified_by) VALUES
         ('fact1', 'ent1', 'A Halvani in unprotected vacuum dies inside two minutes.', 1),
         ('fact2', 'ent3', 'Sound does not carry outside the hull.', 1),
         ('fact3', 'ent3', 'The harbour language is idiom, not physics.', 1)`,
    )
    store.run(
      "INSERT INTO artifact (id, episode_id, kind, file_path) VALUES ('art1', 'ep1', 'script', 'ep01/script.md')",
    )
    store.run("INSERT INTO artifact_provenance (artifact_id, entity_id) VALUES ('art1', 'ent3')")
    store.run(
      `INSERT INTO check_pass (id, check_key, tier, artifact_id, artifact_version)
            VALUES ('pass1', 'world-rules', 'text', 'art1', 1)`,
    )
  }

  it('adds its two tables, alters nothing, and leaves the file sound', () => {
    applyThrough(11)
    writeAScriptWithCanonAndAPass()
    const before = Object.fromEntries(
      tableNames(store).map((name) => [name, store.all<unknown>(`SELECT * FROM ${name}`)]),
    )

    expect(migrate(store).map((m) => m.number)).toEqual([12])

    for (const [name, rows] of Object.entries(before)) {
      if (name === 'schema_migration') continue
      expect({ [name]: store.all<unknown>(`SELECT * FROM ${name}`) }).toEqual({ [name]: rows })
    }
    expect(tableNames(store).filter((name) => !(name in before))).toEqual(SCOPE_TABLE)

    expect(store.get('PRAGMA integrity_check')).toEqual({ integrity_check: 'ok' })
    expect(store.all('PRAGMA foreign_key_check')).toEqual([])
    expect(migrate(store)).toEqual([])
  })

  it('keeps the scope a pass ran with, so a rule that said nothing is still on the record', () => {
    migrate(store)
    writeAScriptWithCanonAndAPass()

    store.run(
      `INSERT INTO check_pass_fact (pass_id, ordinal, fact_id, entity_id, via) VALUES
         ('pass1', 0, 'fact2', 'ent3', ''),
         ('pass1', 1, 'fact3', 'ent3', ''),
         ('pass1', 2, 'fact1', 'ent2', 'species')`,
    )

    // The inherited one says which declaration it travelled — D22 in the record, not only in
    // the prompt. The pass's own facts carry '' rather than a NULL: the empty edge, never a
    // missing one, exactly as `quote` and `slot` elsewhere in this schema.
    expect(store.all('SELECT fact_id, entity_id, via FROM check_pass_fact ORDER BY ordinal')).toEqual([
      { fact_id: 'fact2', entity_id: 'ent3', via: '' },
      { fact_id: 'fact3', entity_id: 'ent3', via: '' },
      { fact_id: 'fact1', entity_id: 'ent2', via: 'species' },
    ])

    // A fact a pass was handed is not something anything else may take away underneath the
    // record — the same RESTRICT every other edge into `fact` carries.
    expect(() => store.run("DELETE FROM fact WHERE id = 'fact2'")).toThrow(/never deleted/)
    expect(() => store.run("UPDATE check_pass_fact SET fact_id = 'fact1' WHERE ordinal = 0")).toThrow(
      /what it was handed/,
    )
  })

  it('records a gap as its own row — not a finding, and not a silence', () => {
    migrate(store)
    writeAScriptWithCanonAndAPass()

    store.run(
      `INSERT INTO check_gap (id, pass_id, entity_id, reason, via, detail)
            VALUES ('gap1', 'pass1', 'ent2', 'declared-unknown', 'species',
                    'Could not check Sefa Doule against the vacuum rules — species undecided.')`,
    )

    expect(store.get('SELECT reason, via, entity_id FROM check_gap')).toEqual({
      reason: 'declared-unknown',
      via: 'species',
      entity_id: 'ent2',
    })
    // The pass it hangs off found nothing at all, and that is the point: zero findings and
    // one gap is a third sentence, distinct from the clean run this would otherwise read as.
    expect(store.get('SELECT COUNT(*) AS n FROM finding WHERE pass_id = ?', 'pass1')).toEqual({ n: 0 })

    expect(() => store.run("UPDATE check_gap SET reason = 'inherited'")).toThrow(/could not check/)
    expect(() => store.run("DELETE FROM canon_entity WHERE id = 'ent2'")).toThrow(/FOREIGN KEY/i)

    // Both go with the pass, and the pass goes with the artifact — the cascade 0010 left open.
    store.run("DELETE FROM artifact WHERE id = 'art1'")
    expect(store.get('SELECT COUNT(*) AS n FROM check_gap')).toEqual({ n: 0 })
    expect(store.get('SELECT COUNT(*) AS n FROM check_pass_fact')).toEqual({ n: 0 })
  })
})
