import type { Store } from '../db/store.ts'
import type { ArtifactKind } from './artifact.ts'
import { newId } from './id.ts'

/**
 * Categories as data (3.2), and the relation types they declare (D23).
 *
 * A category is a kind of canon — character, location, species, world rules — and what
 * makes it *data* is that adding one is an edit rather than engineering: its fields, the
 * artifact kinds its checks apply to, its check instructions, and its allowed relation
 * types are rows, not a TypeScript object somebody has to redeploy. That promise is what
 * 3.5's empty-show story rests on (hand a schema document to a Claude session; get sheets
 * back), and it is why nothing in this module knows the word `character`.
 *
 * **A relation type is a declaration, not an edge.** Declaring `species → species ·
 * exactly-one · required · inverse: members` says what a character is allowed to have; it
 * writes no relation and touches no entity. The edges are domain/relation.ts, and they are
 * refused unless they match something declared here.
 *
 * **The inverse is not a second declaration.** `members` is navigable from a species
 * because the character category named it — the species category declares nothing of the
 * sort. So an inverse has to be unique at the end it is navigable from, or a traversal by
 * name would return a mixed bag of edges that mean different things; both refusals are in
 * `declareRelationType`, and the first of them is also a UNIQUE index.
 *
 * **`required` is declared here and enforced at ratification (E2-2)** — never at insert.
 * An entity is built one write at a time and is ragged in between; a candidate is allowed
 * to be incomplete, and canon is not. What this module and relation.ts *do* enforce is
 * everything answerable from one write: the type is declared, the target is the right
 * category, and there is room for the edge under its cardinality.
 *
 * **A declaration also says whether facts travel it** (`inheritsFacts`, E2-1). D22 rules
 * that a species' facts load into check scope with its members; the mechanism is general
 * and the word `species` is not, so the category declares it the way it declares an
 * inverse. Facts travel the declared edge only, one way — a character inherits from the
 * species it points at, a species inherits nothing from its members. Left off, facts do not
 * travel: legal, visible in the declaration, and the honest way for it to fail. The
 * traversal itself is `factsInScope` in domain/fact.ts.
 */

/** How many edges of one type an entity may declare (D23). `required` is separate, by ruling. */
export const RELATION_CARDINALITY = ['exactly-one', 'at-most-one', 'any'] as const
export type RelationCardinality = (typeof RELATION_CARDINALITY)[number]

/** One field of a category's sheets — what the prose body is sectioned by (3.1). */
export interface CategoryField {
  name: string
  description: string
}

/**
 * A relation type as it is written on a `_category.md` sheet: the shape the fixture reader
 * parses and this module persists. The target category is named by key, because that is
 * what a sheet can say — ids are the store's business.
 */
export interface RelationTypeDeclaration {
  name: string
  targetCategory: string
  cardinality: RelationCardinality
  required: boolean
  /** The name the edge is navigable by from the far end — blast radius from both sides. */
  inverse: string
  /**
   * Whether the target's facts load into check scope with the entity that declares this
   * edge (D22, E2-1). Absent means no, which is what a sheet that never mentions it means.
   */
  inheritsFacts?: boolean
}

/** A declaration once it is in the store, with the ids the graph is actually wired by. */
export interface RelationType extends RelationTypeDeclaration {
  id: string
  categoryId: string
  targetCategoryId: string
  inheritsFacts: boolean
}

export interface CanonCategory {
  id: string
  showId: string
  key: string
  name: string
  blurb: string
  fields: CategoryField[]
  /** The artifact kinds this category's checks fire on (3.2, 4.1). */
  appliesTo: ArtifactKind[]
  /** What a reviewer pass is told to do with this category's entities. Read by an LLM. */
  checkInstructions: string
  relationTypes: RelationType[]
  createdAt: string
}

export interface CategoryDraft {
  showId: string
  key: string
  name: string
  blurb?: string
  fields?: CategoryField[]
  appliesTo?: ArtifactKind[]
  checkInstructions?: string
}

/**
 * Declares a category. Its relation types come after, through `declareRelationType`,
 * because a declaration points at a category that may not exist yet — `part-of → location`
 * points at its own, and character → species is only declarable once Species is. A show's
 * categories are therefore two passes, and pretending otherwise would only work for shows
 * whose categories happen to sort in dependency order.
 */
export function declareCategory(store: Store, draft: CategoryDraft): CanonCategory {
  return store.transaction(() => {
    if (findCategory(store, draft.showId, draft.key)) {
      throw new Error(
        `This show already declares a \`${draft.key}\` category. A category is data — edit ` +
          'the one that is there rather than declaring a second.',
      )
    }

    const id = newId('cat')
    store.run(
      `INSERT INTO canon_category (id, show_id, key, name, blurb, check_instructions)
            VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      draft.showId,
      draft.key,
      draft.name,
      draft.blurb ?? '',
      draft.checkInstructions ?? '',
    )
    ;(draft.fields ?? []).forEach((field, index) => {
      store.run(
        'INSERT INTO category_field (category_id, ordinal, name, description) VALUES (?, ?, ?, ?)',
        id,
        index + 1,
        field.name,
        field.description,
      )
    })
    for (const kind of draft.appliesTo ?? []) {
      store.run('INSERT INTO category_artifact_kind (category_id, kind) VALUES (?, ?)', id, kind)
    }

    return findCategoryById(store, id)!
  })
}

export function declareRelationType(
  store: Store,
  categoryId: string,
  declaration: RelationTypeDeclaration,
): RelationType {
  return store.transaction(() => {
    const category = findCategoryById(store, categoryId)
    if (!category) throw new Error(`No such category: ${categoryId}`)

    const target = findCategory(store, category.showId, declaration.targetCategory)
    if (!target) {
      throw new Error(
        `The ${category.key} category declares \`${declaration.name}\` pointing at a ` +
          `\`${declaration.targetCategory}\` category, and this show has no \`${declaration.targetCategory}\` ` +
          'category. A relation type is a row rather than code — declare the target category first.',
      )
    }
    if (category.relationTypes.some((type) => type.name === declaration.name)) {
      throw new Error(
        `The ${category.key} category already declares \`${declaration.name}\`.`,
      )
    }

    // Two ways an inverse can stop being a name that means one thing at the far end. Both
    // are refused here rather than discovered by a traversal that returns the wrong edges.
    const clash = relationTypeByInverse(store, target.id, declaration.inverse)
    if (clash) {
      throw new Error(
        `\`${declaration.inverse}\` is already navigable from the ${target.key} category — ` +
          `it is the inverse of \`${clash.name}\`. An inverse names one kind of edge from ` +
          'the far end, so two declarations cannot share one.',
      )
    }
    if (target.relationTypes.some((type) => type.name === declaration.inverse)) {
      throw new Error(
        `\`${declaration.inverse}\` is already a relation type the ${target.key} category ` +
          'declares. An inverse that collides with a declared type makes a traversal by ' +
          'that name ambiguous, which is what D23 exists to prevent.',
      )
    }

    const id = newId('rtype')
    store.run(
      `INSERT INTO relation_type
              (id, category_id, name, target_category_id, cardinality, required, inverse_name,
               inherits_facts)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      categoryId,
      declaration.name,
      target.id,
      declaration.cardinality,
      declaration.required ? 1 : 0,
      declaration.inverse,
      declaration.inheritsFacts === true ? 1 : 0,
    )
    return findRelationTypeById(store, id)!
  })
}

export function findCategory(
  store: Store,
  showId: string,
  key: string,
): CanonCategory | undefined {
  const row = store.get<CategoryRow>(
    'SELECT * FROM canon_category WHERE show_id = ? AND key = ?',
    showId,
    key,
  )
  return row && hydrateCategory(store, row)
}

export function findCategoryById(store: Store, id: string): CanonCategory | undefined {
  const row = store.get<CategoryRow>('SELECT * FROM canon_category WHERE id = ?', id)
  return row && hydrateCategory(store, row)
}

/**
 * Every category of a show, with its fields, kinds and declarations loaded. Three small
 * queries per category rather than one join: a show has a handful of categories, they are
 * read whole every time, and the flat rows a join produces would have to be regrouped by
 * hand into exactly this shape.
 */
export function categoriesOf(store: Store, showId: string): CanonCategory[] {
  return store
    .all<CategoryRow>('SELECT * FROM canon_category WHERE show_id = ? ORDER BY key', showId)
    .map((row) => hydrateCategory(store, row))
}

/**
 * The categories whose checks fire on this kind of artifact (4.1) — the question asked at
 * every artifact boundary, which is why `category_artifact_kind` is a table.
 */
export function categoriesForArtifactKind(
  store: Store,
  showId: string,
  kind: ArtifactKind,
): CanonCategory[] {
  return store
    .all<CategoryRow>(
      `SELECT c.* FROM canon_category c
         JOIN category_artifact_kind k ON k.category_id = c.id
        WHERE c.show_id = ? AND k.kind = ?
        ORDER BY c.key`,
      showId,
      kind,
    )
    .map((row) => hydrateCategory(store, row))
}

export function relationTypesOf(store: Store, categoryId: string): RelationType[] {
  return store
    .all<RelationTypeRow>(`${SELECT_TYPE} WHERE t.category_id = ? ORDER BY t.rowid`, categoryId)
    .map(hydrateRelationType)
}

export function findRelationType(
  store: Store,
  categoryId: string,
  name: string,
): RelationType | undefined {
  const row = store.get<RelationTypeRow>(
    `${SELECT_TYPE} WHERE t.category_id = ? AND t.name = ?`,
    categoryId,
    name,
  )
  return row && hydrateRelationType(row)
}

/**
 * The declaration that makes `inverseName` navigable from this category — the far end of
 * the edge. `relationTypeByInverse(species, 'members')` finds the character category's
 * `species` declaration, which is how a traversal from a species reaches its members
 * without the species category declaring anything (D23).
 */
export function relationTypeByInverse(
  store: Store,
  targetCategoryId: string,
  inverseName: string,
): RelationType | undefined {
  const row = store.get<RelationTypeRow>(
    `${SELECT_TYPE} WHERE t.target_category_id = ? AND t.inverse_name = ?`,
    targetCategoryId,
    inverseName,
  )
  return row && hydrateRelationType(row)
}

// ── Rows ────────────────────────────────────────────────────────────────────────

interface CategoryRow {
  id: string
  show_id: string
  key: string
  name: string
  blurb: string
  check_instructions: string
  created_at: string
}

interface RelationTypeRow {
  id: string
  category_id: string
  name: string
  target_category_id: string
  /** Joined in: a declaration names its target by key on the sheet, and by id in the graph. */
  target_category_key: string
  cardinality: RelationCardinality
  required: number
  inverse_name: string
  inherits_facts: number
}

const SELECT_TYPE = `
  SELECT t.id, t.category_id, t.name, t.target_category_id, t.cardinality, t.required,
         t.inverse_name, t.inherits_facts, c.key AS target_category_key
    FROM relation_type t
    JOIN canon_category c ON c.id = t.target_category_id`

function hydrateCategory(store: Store, row: CategoryRow): CanonCategory {
  return {
    id: row.id,
    showId: row.show_id,
    key: row.key,
    name: row.name,
    blurb: row.blurb,
    fields: store.all<{ name: string; description: string }>(
      'SELECT name, description FROM category_field WHERE category_id = ? ORDER BY ordinal',
      row.id,
    ),
    appliesTo: store
      .all<{ kind: ArtifactKind }>(
        'SELECT kind FROM category_artifact_kind WHERE category_id = ? ORDER BY rowid',
        row.id,
      )
      .map((kind) => kind.kind),
    checkInstructions: row.check_instructions,
    relationTypes: relationTypesOf(store, row.id),
    createdAt: row.created_at,
  }
}

const hydrateRelationType = (row: RelationTypeRow): RelationType => ({
  id: row.id,
  categoryId: row.category_id,
  name: row.name,
  targetCategory: row.target_category_key,
  targetCategoryId: row.target_category_id,
  cardinality: row.cardinality,
  required: row.required === 1,
  inverse: row.inverse_name,
  inheritsFacts: row.inherits_facts === 1,
})

export function findRelationTypeById(store: Store, id: string): RelationType | undefined {
  const row = store.get<RelationTypeRow>(`${SELECT_TYPE} WHERE t.id = ?`, id)
  return row && hydrateRelationType(row)
}
