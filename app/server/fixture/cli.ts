import { initLibrary, libraryRoot, openLibraryStore } from '../library.ts'
import { loadFixture, type LoadReport, type Tally } from './load.ts'

/**
 * `npm run fixture:load` — seed the Grey Harbor fixture into the library volume.
 *
 * It lives in `app/` rather than `scripts/` on purpose: `scripts/` is for the manual
 * things that must never run in CI (`smoke:llm` spends real money), and this is the
 * opposite — it spends nothing, generates nothing, and is safe to run anywhere, on
 * anything, as often as you like.
 *
 *   npm run fixture:load                 seeds ./library, or $LIBRARY_DIR
 *   npm run fixture:load -- /some/where  seeds that volume instead
 *
 * Run it twice; the second run is the interesting one. It walks the whole fixture, finds
 * everything already there, and writes nothing.
 *
 * **It raises; it does not rule.** Since E2-4 the load ends with a stack of promotion
 * proposals standing in the queue and no canon written (D25). Founding them is a separate,
 * deliberate act — Ryan's, at the canon bench (E2-6) — and this command deliberately has no
 * flag for it. A `--found` here would be auto-ratification wearing a switch: nothing in
 * this app writes canon without a click (invariant 5), least of all a shell script.
 */

const root = process.argv[2] ?? libraryRoot()
const paths = initLibrary(root)
const store = openLibraryStore(paths)

try {
  const report = loadFixture(store, paths)
  process.stdout.write(render(report, paths.root))
} finally {
  store.close()
}

function render(report: LoadReport, root: string): string {
  const lines = [
    `${report.show.title} (${report.show.key}) → ${root}`,
    '',
    row('seasons', report.seasons),
    row('episodes', report.episodes),
    row('categories', report.categories, 'declared'),
    row('relation types', report.relationTypes, 'declared'),
    row('canon entities', report.entities, 'registered'),
    row('promotions', report.promotions, 'raised'),
    row('arcs', report.arcs),
    row('waypoints', report.waypoints),
    row('arc positions', report.positions, 'declared'),
    row('artifacts', report.artifacts, 'recorded'),
    `  ${'scenes'.padEnd(16)}${report.scenes} derived from the scripts`,
    `  ${'artifact files'.padEnd(16)}${count(report.files, 'written')} written · ${count(report.files, 'kept')} already there`,
  ]

  // A file that no longer matches the repository is somebody's edit. It is never
  // overwritten (D20), so the only honest thing left to do is say it is there.
  for (const file of report.files.filter((f) => f.state === 'differs')) {
    lines.push(
      '',
      `  ! ${file.path} differs from the fixture and was left alone.`,
      '    A hand-made asset always wins. Delete it and load again to take the fixture’s copy.',
    )
  }

  // A candidate sheet is a draft nobody has proposed, so the loader raises nothing for it
  // and says which ones those were — otherwise "6 promotions from 7 sheets" reads as a bug.
  for (const name of report.candidates) {
    lines.push(
      '',
      `  · ${name} is a candidate sheet. Its identity is registered and NO promotion was`,
      '    raised — promoting it is somebody deciding to, at the bench.',
    )
  }

  // The sentence that stops this command becoming an import that writes canon (invariant 1),
  // and the one that says what is now waiting on Ryan.
  lines.push(
    '',
    'Nothing here was ratified and nothing generated. The sheets are on the queue as',
    'promotion proposals; canon moves when you rule them, and by no other route.',
    '',
  )
  return lines.join('\n')
}

function row(name: string, tally: Tally, verb = 'created'): string {
  return `  ${name.padEnd(16)}${tally.created} ${verb} · ${tally.found} already there`
}

function count(files: LoadReport['files'], state: string): number {
  return files.filter((file) => file.state === state).length
}
