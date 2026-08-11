import { useEffect, useState, type ReactNode } from 'react'
import type { CockpitView, Destination } from '../../server/cockpit.ts'
import { EmptyState } from './EmptyState.tsx'
import { locate, onLinkClick, useLocation, type Located } from './router.ts'

/**
 * The shell: eight rooms and one bar (E5-0, #80; retired down to eight by E5-6, #86).
 *
 * ── What the mockups gave, and what they did not ────────────────────────────────
 * They gave the breadcrumb, identically in all seven screens that have one: "← the floor
 * · Dead Light S1 · the canon library". That is navigation that says where you are, and
 * it is lifted verbatim into `chrome.css`.
 *
 * They did not give a way to GET anywhere. The link graph in `mockups/` has holes in it —
 * the canon library and the season map link back to the floor, and the floor links to
 * neither. Ryan's third criterion is that **no flow requires find-in-page**; a link graph
 * with holes fails it before a single screen is built. So the shell adds the doors, and
 * every value it draws them with is one the mockups already say: the wordmark is the
 * floor's `.app`, the links are `.crumb`'s size and ink, the current room is marked in
 * amber because amber means "your attention" everywhere else in this cockpit. Nothing
 * visual is invented; the arrangement is new because it had to be.
 *
 * ── Every door stayed open until #86, and then one closed ───────────────────────
 * The bar carried nine addresses for one epic: the eight rooms and the old operating page,
 * which kept working and said when it retired. It retired. **At no commit in this epic was
 * a mechanism reachable only through a page that is gone** — every door the scaffolding
 * held was enumerated, given a home on a screen and asserted there before a line of it came
 * down (#86), which is what made the ninth address safe to remove rather than merely due.
 *
 * The bar carries eight now, and `whereWeAre` still answers for `/operating`: it is a path
 * nobody claims, so it lands on the floor like any other typo. A retired address may stop
 * being a door; it may not become a dead end.
 *
 * ── It holds no copy ────────────────────────────────────────────────────────────
 * Every room name, every explanation and every "not built yet" comes from
 * `GET /api/cockpit` (`server/cockpit.ts`). The one string in this file is the skip link,
 * and it is about the document rather than about the product.
 */

/** A screen, as the shell mounts it: whatever the address was holding, and the chrome. */
export interface ScreenProps {
  /** The id in the address — an episode, a gate, an arc — or null at the bare address. */
  id: string | null
  destination: Destination
  cockpit: CockpitView
}

/** What a built screen registers under. E5-1..5 fill this in, one room at a time. */
export type Screens = Readonly<Record<string, (props: ScreenProps) => ReactNode>>

export function Shell({ screens }: { screens: Screens }) {
  const [cockpit, setCockpit] = useState<CockpitView | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const location = useLocation()

  // A read, and the only one the shell does. Opening the cockpit starts nothing, costs
  // nothing and rules nothing (invariant 5).
  useEffect(() => {
    void (async () => {
      try {
        setCockpit((await (await fetch('/api/cockpit')).json()) as CockpitView)
      } catch (error) {
        setProblem(`The API did not answer: ${String(error)}`)
      }
    })()
  }, [])

  const here = cockpit === null ? null : whereWeAre(cockpit, location)

  /**
   * The browser tab says which room you are in. It is wayfinding for the same reason the
   * bar is — a row of tabs all saying "Showrunner" is a row Ryan has to open one at a
   * time — and the name is the server's, like every other name here.
   */
  useEffect(() => {
    if (here !== null) document.title = `Showrunner — ${here.name}`
  }, [here])

  if (cockpit === null || here === null) {
    return (
      <div className="wrap">
        <p>{problem ?? 'The API has not answered yet.'}</p>
      </div>
    )
  }

  return (
    <>
      <a className="skip-link" href="#screen">
        Skip to this screen
      </a>
      {/*
       * `data-room` is how a screen gets its own page width without a screen knowing about
       * the shell or the shell knowing about a screen. `drift.test.ts` records that the
       * mockups genuinely disagree about `--wrap` on purpose — the season map is wider and
       * the floor narrower, a nine-column grid against a three-card row — and this is the
       * hook that lets the token be per-screen overridable, as that decision says it is.
       */}
      <div className="wrap" data-room={here.id}>
        <Bar cockpit={cockpit} here={here} />
        <main id="screen">
          <Room here={here} id={location.rest} screens={screens} cockpit={cockpit} />
        </main>
      </div>
    </>
  )
}

/**
 * Which room this address is. An address nobody claims is the floor — it is the home
 * screen, and a typo should land somewhere real rather than on a page saying nothing.
 */
export function whereWeAre(cockpit: CockpitView, location: Located): Destination {
  const head = location.head === '' ? '' : `/${location.head}`
  return cockpit.destinations.find((room) => room.path === head) ?? cockpit.destinations[0]!
}

/**
 * The bar. It says where you are twice — in ink and in `aria-current` — because a colour
 * is not a statement, and because a screen reader deserves the same answer an eye gets.
 */
function Bar({ cockpit, here }: { cockpit: CockpitView; here: Destination }) {
  return (
    <nav className="shell-bar" aria-label="the cockpit">
      <span className="shell-mark">Showrunner</span>
      <Switcher cockpit={cockpit} />
      <ul className="shell-doors">
        {cockpit.destinations.map((room) => (
          <li key={room.id}>
            <Door room={room} here={here} />
          </li>
        ))}
      </ul>
    </nav>
  )
}

function Door({ room, here }: { room: Destination; here: Destination }) {
  const at = room.id === here.id
  return (
    <a
      className="shell-door"
      href={room.path}
      onClick={onLinkClick(room.path)}
      aria-current={at ? 'page' : undefined}
      data-standing={room.standing === 'built' ? undefined : room.standing}
      // The explanation, for a pointer and for a reader — the second criterion applied to
      // the bar itself, where there is no room to print it beside every name.
      title={room.explains}
    >
      {room.name}
    </a>
  )
}

/**
 * The show switcher — a menu, and it **stays a menu until show #2** (5.x). With one show
 * it renders as a disabled select saying so, rather than as a chooser with one choice:
 * a control that looks operable and is not is the same lie as a button with no cost on it.
 */
function Switcher({ cockpit }: { cockpit: CockpitView }) {
  const only = cockpit.shows.length < 2
  return (
    <label className="shell-switcher-label">
      <span className="visually-hidden">{cockpit.switcherExplains}</span>
      <select className="shell-switcher" disabled={only} title={cockpit.switcherExplains}>
        {cockpit.shows.map((show) => (
          <option key={show.id} value={show.id}>
            {show.title}
          </option>
        ))}
        {cockpit.shows.length === 0 && <option>{cockpit.switcherExplains}</option>}
      </select>
    </label>
  )
}

/**
 * The room itself — the screen if one is built, and the honest empty state if not.
 *
 * The empty state is not a placeholder. It says the room is not built, it names the epic
 * that builds it, and it says how you would have got here so the address is not a
 * cul-de-sac. A blank page with a spinner would be three lies in one.
 *
 * **It used to offer the old operating page**, because while that page stood, a room with no
 * screen still had somewhere its mechanism worked. #86 retired the page and the two rooms
 * left here are E6's: nothing in this build generates an image or assembles a cut, so there
 * is no door to hand over. Saying so is the honest version, and inventing one would be
 * exactly the promise `cockpit.ts`'s table refuses to make.
 */
function Room({
  here,
  cockpit,
  id,
  screens,
}: {
  here: Destination
  cockpit: CockpitView
  id: string | null
  screens: Screens
}) {
  const built = screens[here.id]
  if (built !== undefined) return <>{built({ id, destination: here, cockpit })}</>

  return (
    <>
      <h1>{here.name}</h1>
      <p className="crumb">{here.explains}</p>
      <EmptyState lead={here.lead} sentence={here.notYetBecause ?? here.explains}>
        {here.reachedFrom !== '' && <p className="crumb">Reached from {here.reachedFrom}.</p>}
      </EmptyState>
    </>
  )
}

/** Exported for the tests, which locate a path without a browser to ask. */
export { locate }
