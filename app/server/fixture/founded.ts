import type { Store } from '../db/store.ts'
import { entitiesOfShow, type CanonEntity } from '../domain/canon.ts'
import { foundCanon, type Founding } from '../domain/founding.ts'
import type { Show } from '../domain/spine.ts'
import type { LibraryPaths } from '../library.ts'
import { loadFixture, type LoadReport } from './load.ts'
import { FIXTURE_DIR } from './read.ts'

/**
 * **Grey Harbor, founded** — the one line a test writes when it needs a show with CANON in
 * it rather than a show with sheets beside it.
 *
 * `loadFixture` leaves six promotion proposals standing in the queue, because loading
 * raises and never rules (D25). Most tests before E2 wanted exactly that. Everything from
 * E3 on wants the other side of it: facts to check an artifact against, a species whose
 * physiology loads with its members, a standing to render. This runs both halves in the
 * order Ryan would — load, then found — and hands back what each produced.
 *
 * **It founds through the real API, and that is the whole reason it exists.** A helper that
 * INSERTed the fixture's facts would be faster, would pass the same assertions, and would
 * mean every later epic's tests ran against a state the app cannot produce — which is the
 * failure D25 names and `fixtures before features` is supposed to prevent. So: `loadFixture`
 * raises, `foundCanon` rules, and a test that wants canon gets it the way canon happens.
 *
 * Sefa Doule stays a candidate through all of it, on purpose — the fixture's own answer to
 * "what does unofficial look like", and the thing E5's canon library has to render
 * differently from the six sheets Ryan ruled.
 */
export interface FoundedFixture {
  show: Show
  /** What the load did — tallies, files, and the candidate sheets it left alone. */
  load: LoadReport
  /** What the founding ruled, and what it deliberately left for Ryan. */
  founding: Founding
  /** Every identity in the show, by the name its sheet carries. */
  entities: Map<string, CanonEntity>
  /** `harbor.entity('Tobin Wick')` — hydrated after the founding, so standing is on it. */
  entity(name: string): CanonEntity
}

export function greyHarborFounded(
  store: Store,
  paths: LibraryPaths,
  dir: string = FIXTURE_DIR,
): FoundedFixture {
  const load = loadFixture(store, paths, dir)
  const founding = foundCanon(store, load.show.id, {
    note: `founded ${load.show.title} from the sheets in ${dir}`,
  })

  // Read AFTER the founding: a promotion writes standing, aliases and prose onto the row,
  // so an entity map built before it would hand every caller the pre-ruling copy.
  const entities = new Map(
    entitiesOfShow(store, load.show.id).map((entity) => [entity.name, entity]),
  )

  return {
    show: load.show,
    load,
    founding,
    entities,
    entity(name: string): CanonEntity {
      const found = entities.get(name)
      if (!found) {
        throw new Error(
          `Grey Harbor has no entity called “${name}”. It has: ${[...entities.keys()].join(', ')}.`,
        )
      }
      return found
    },
  }
}
