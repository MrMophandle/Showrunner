import type { Store } from './db/store.ts'
import { shows } from './domain/spine.ts'

/**
 * What the cockpit calls its own rooms (E5-0, #80).
 *
 * ── Why this is on the server ───────────────────────────────────────────────────
 * E4-7 ruled that **nothing in `app/web/` may hold a refusal string**, after the gate's
 * one refusal turned out to be three different sentences in three places and the
 * browser's copy was the one Ryan actually read. #80 extends that to the whole chrome:
 * no button label, no room name, no honest "not built yet" is authored in a component.
 *
 * That extension is what puts this module here. The shell's navigation is copy — eight
 * room names and eight plain-words explanations — and a name that lives in a `.tsx` file
 * is a name nothing can test and nobody can find. It also makes Ryan's second criterion
 * enforceable in one place: **every destination below carries its explanation**, the
 * `SectionHeader` component refuses to render without one, and the two facts meet at the
 * type rather than at a reviewer's attention.
 *
 * ── What it deliberately is not ─────────────────────────────────────────────────
 * Not a route table the server dispatches on — the SPA does its own routing and the
 * server serves `index.html` for every non-API path, as it already did. These are
 * ADDRESSES: what each room is called, where it lives, and what it can honestly say
 * about itself today. It is data about the product, not a workflow description, and
 * adding a screen is a code change here plus a screen — never a config file (the Archon
 * rule).
 *
 * ── Standing is honest, one room at a time ──────────────────────────────────────
 * `built` means a screen renders its own content. `stub` means the address is live, the
 * chrome is around it, and the issue that fills it is named. `later-epic` means the same,
 * and the epic is named instead. At no point does an address 404 and at no point does a
 * room claim to be something it is not — the whole point of shipping the shell before
 * the screens is that every door exists from the first commit, including the old one.
 */

/** A const array and a union, never a TS `enum` — the server runs under type stripping. */
export const COCKPIT_STANDING = ['built', 'stub', 'later-epic', 'scaffolding'] as const
export type CockpitStanding = (typeof COCKPIT_STANDING)[number]

export interface Destination {
  /** Stable id — the shell matches a route to a screen by this, never by the name. */
  id: string
  /**
   * Where it lives. A room about one thing also answers at its bare address, so every
   * destination in the bar is a link and none of them is a dead end: `/episode` says
   * "pick one", `/episode/ep05-id` opens that one.
   */
  path: string
  /** The room's name, in the words the mockups' own breadcrumbs use. */
  name: string
  /**
   * The same thing in Ryan's words, one line — the second criterion, at the top level.
   * `SectionHeader` will not render a heading without one of these.
   */
  explains: string
  standing: CockpitStanding
  /**
   * The standing in three words, said first and said bold — "Not built yet." It is a
   * separate field from the sentence because the screen already carries the room's NAME
   * in its title, and an empty state that opens by repeating the title says nothing with
   * the one line a reader is guaranteed to read.
   */
  lead: string
  /**
   * What it cannot do yet, and who fixes it. Null once the room is built. Honest rather
   * than apologetic: it names the issue, so the answer to "when" is one click away.
   */
  notYetBecause: string | null
  /** How you get here when you did not type the address. Empty for the home screen. */
  reachedFrom: string
}

export interface CockpitShow {
  id: string
  key: string
  title: string
}

export interface CockpitView {
  /** The eight rooms (D24), in the order the floor sends you to them. */
  destinations: Destination[]
  /**
   * The bare-bones operating page, still serving (E1-8 → E4-7). It is not one of the
   * eight and it is not a room; it is every mechanism four epics built, on one unstyled
   * page, and it stays reachable until #86 retires it. **No mechanism in this app is
   * reachable only through a page that is gone** — that is the whole reason it is in
   * this list rather than in a comment.
   */
  scaffolding: Destination
  shows: CockpitShow[]
  /**
   * What the show switcher says about itself. A menu, and it stays a menu until show #2
   * (5.x) — so with one show it says so rather than pretending to be a chooser.
   */
  switcherExplains: string
}

/**
 * The eight rooms of D24. Their names are the mockups' own — every breadcrumb in
 * `mockups/` ends in one of these — and their explanations are what each screen is FOR,
 * said without a schema noun where one can be avoided and beside its translation where
 * one cannot.
 */
const ROOMS: readonly Omit<Destination, 'standing' | 'lead' | 'notYetBecause'>[] = [
  {
    id: 'floor',
    path: '/',
    name: 'the floor',
    explains: 'everything in flight, and what is waiting on you at the top',
    reachedFrom: '',
  },
  {
    id: 'episode-room',
    path: '/episode',
    name: 'the episode room',
    explains: 'one episode whole — its scenes, what has been written, what it has cost',
    reachedFrom: 'an episode on the floor',
  },
  {
    id: 'gate-room',
    path: '/gate',
    name: 'the gate room',
    explains: 'the draft you are ruling on, readable, with what the reviewers said about it',
    reachedFrom: 'an episode waiting on you, on the floor or in its room',
  },
  {
    id: 'canon-library',
    path: '/canon',
    name: 'the canon library',
    explains: 'what is true in this show, who established it, and when it became true',
    reachedFrom: 'the bar, or any name on a screen',
  },
  {
    id: 'review-desk',
    path: '/review',
    name: 'the review desk',
    explains: 'one image at a time, beside the reference it was checked against',
    reachedFrom: 'a queue of stills waiting on the floor',
  },
  {
    id: 'screening-room',
    path: '/screening',
    name: 'the screening room',
    explains: 'the cut episode, watched all the way through, before it goes out',
    reachedFrom: 'an assembled episode at its final gate',
  },
  {
    id: 'season-map',
    path: '/season',
    name: 'the season map',
    explains: 'the whole season at once — every arc, and which episode moved it last',
    reachedFrom: 'the bar',
  },
  {
    id: 'arc-page',
    path: '/arc',
    name: 'the arc page',
    explains: 'one arc: what it is, its waypoints in order, and the episodes that landed them',
    reachedFrom: 'the season map, or a name in the canon library',
  },
]

/**
 * Which issue fills which room. E5-5 builds two of them, which is why this is a map from
 * a room to a sentence rather than a number beside a room — and the two E6 screens have
 * no issue yet, so they name their epic and say nothing they cannot back up.
 */
const NOT_YET: Readonly<
  Record<string, { standing: CockpitStanding; lead: string; because: string }>
> = {
  // The floor is not in this table any more: E5-1 (#81) built it, so it stands `built` and
  // its `notYetBecause` is null. A room leaves this map by being built, which is why the map
  // is the only place standing is decided. E5-2 (#82) took the episode room out the same way.
  'gate-room': {
    standing: 'stub',
    lead: 'Not built yet.',
    because:
      'E5-3 (#83) builds this room, and rules on what a fourth verb at a presenting gate ' +
      'would mean. Until then rulings are made on the old operating page.',
  },
  'canon-library': {
    standing: 'stub',
    lead: 'Not built yet.',
    because:
      'E5-4 (#84) builds this room. Until then the canon bench on the old operating page ' +
      'is where canon is read and ruled.',
  },
  'review-desk': {
    standing: 'later-epic',
    lead: 'Not built yet, and not E5’s.',
    because:
      'E6 builds the review desk, when there are images to review — nothing generates one ' +
      'yet, so there is nothing here to be missing.',
  },
  'screening-room': {
    standing: 'later-epic',
    lead: 'Not built yet, and not E5’s.',
    because:
      'E6 builds the screening room, when there is an assembled episode to watch — nothing ' +
      'assembles one yet, so there is nothing here to be missing.',
  },
  'season-map': {
    standing: 'stub',
    lead: 'Not built yet.',
    because:
      'E5-5 (#85) builds the season map and the arc page together. Until then arcs are ' +
      'read on the canon bench of the old operating page.',
  },
  'arc-page': {
    standing: 'stub',
    lead: 'Not built yet.',
    because:
      'E5-5 (#85) builds the arc page and the season map together. Until then a waypoint ' +
      'is declared from the canon bench on the old operating page.',
  },
}

/**
 * The old operating page. It keeps its own address for as long as it is the only place
 * some of these mechanisms can be reached from, which is until #86 — and the sentence
 * says so, because a door with no expiry date is a door nobody ever closes.
 */
const SCAFFOLDING: Destination = {
  id: 'operating',
  path: '/operating',
  name: 'the old operating page',
  explains: 'everything E1–E4 built, unstyled and on one page — still the only place most of it works',
  standing: 'scaffolding',
  lead: 'Still serving.',
  notYetBecause:
    'This is the page the cockpit replaces. It keeps working, at this address, until ' +
    'E5-6 (#86) retires it — no mechanism in this app is reachable only through a page ' +
    'that is gone.',
  reachedFrom: 'the bar, from every room',
}

/**
 * The eight rooms with their standing on them, and no store to ask — a room's name, address
 * and honesty about itself are facts about this build, not about a library.
 *
 * Exported because the floor's needs-you cards link INTO these rooms and say what each one
 * can do today (E5-1, #81). A card composing its own address would be a second copy of the
 * link graph, and the copy that drifted would be the one sending Ryan to a room the bar
 * does not have.
 */
export function destinationsOf(): Destination[] {
  return ROOMS.map((room): Destination => {
    const not = NOT_YET[room.id]
    return {
      ...room,
      standing: not?.standing ?? 'built',
      lead: not?.lead ?? '',
      notYetBecause: not?.because ?? null,
    }
  })
}

export function cockpitView(store: Store): CockpitView {
  const standing = shows(store).map(
    (show): CockpitShow => ({ id: show.id, key: show.key, title: show.title }),
  )

  return {
    destinations: destinationsOf(),
    scaffolding: SCAFFOLDING,
    shows: standing,
    switcherExplains: switcherSentence(standing),
  }
}

/**
 * The switcher, in one sentence. It **stays a menu until show #2** (5.x), so with one
 * show it says that rather than drawing a chooser with nothing to choose — and with none
 * it says how to get one, the same sentence `operatingView` already gives an empty
 * library.
 */
export function switcherSentence(standing: readonly CockpitShow[]): string {
  if (standing.length === 0) {
    return 'No shows in this library yet. `npm run fixture:load` seeds Grey Harbor — it spends nothing.'
  }
  if (standing.length === 1) {
    return `One show in this library: ${standing[0]!.title}. This stays a menu until there is a second.`
  }
  return `${standing.length} shows in this library. Everything on screen is scoped to the one you pick.`
}
