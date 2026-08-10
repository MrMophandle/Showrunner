/**
 * "The thing Ryan was looking at is still where he left it" — as an assertion (E5-0, #80).
 *
 * ── What it is for ──────────────────────────────────────────────────────────────
 * He ruled the E4 drill off mid-run: *"a giant wall of changing text… I find myself
 * literally doing a find on the webpage looking for the button in question."* Nothing
 * mechanical was wrong. What was wrong is that every event grew the page under the thing
 * he was reaching for.
 *
 * `LiveRegion.tsx` is the fix. This is what fails when a screen stops using it properly.
 * Every screen in this epic composes the region, and every screen's test calls `heldStill`
 * around its own update — so "nothing reflows" is a failing test rather than a house rule
 * that decays over five issues.
 *
 * ── What it measures, honestly ──────────────────────────────────────────────────
 * jsdom has no layout engine. `getBoundingClientRect()` returns zeros there, so a test
 * that "measured pixels" would be measuring nothing and would pass on a page that shoved
 * itself off the bottom of the screen. Booting a real browser in CI to get real pixels
 * would put a browser download on every `npm test`, which is not a price this repo has
 * agreed to pay. (The real-browser measurement was taken once, by hand, against a booted
 * app; the numbers are in #80.)
 *
 * So this asserts the conditions under which a browser **cannot** move the element — a
 * stronger statement than one measurement, which only ever says "it did not move that
 * time". An element's distance from the top of the document is the sum of the heights of
 * everything laid out above it. It can therefore only move if something above it changes
 * the space it takes, and something above it can only do that if it is free to grow.
 *
 * ── The rule, in one sentence ───────────────────────────────────────────────────
 * **Above the element being read, nothing may change except inside a box whose CSS fixes
 * its size.** A box is fixed if it declares a `height` that is not `auto`, or if it is
 * taken out of flow entirely (`position: absolute` / `fixed`), and it only counts if it
 * does NOT contain the element being read — content growing inside a box that surrounds
 * you still pushes you down inside it.
 *
 * That is precisely what `.live-region`'s four fixed boxes give and what a plain `<div>`
 * of appended lines does not. `chrome.test.tsx` proves both directions: the region passes,
 * and a naive region built the scaffolding's way fails.
 */

/** Where a violation was found, and what to do about it. */
export interface Reflow {
  /** A short path to the offending element — "div.wrap > section.run > div". */
  where: string
  why: string
}

export class ReflowError extends Error {
  readonly reflows: readonly Reflow[]

  constructor(reflows: readonly Reflow[]) {
    super(
      'the page moved under the element being read:\n' +
        reflows.map((reflow) => `  · ${reflow.where} — ${reflow.why}`).join('\n'),
    )
    this.name = 'ReflowError'
    this.reflows = reflows
  }
}

/** "div.wrap > section.live-region > p.live-region__latest" — a message worth reading. */
function pathTo(element: Element, root: Element): string {
  const steps: string[] = []
  let at: Element | null = element
  while (at !== null && at !== root.parentElement) {
    const tag = at.tagName.toLowerCase()
    const id = at.id === '' ? '' : `#${at.id}`
    const first = at.classList.item(0)
    steps.unshift(`${tag}${id}${first === null ? '' : `.${first}`}`)
    at = at.parentElement
  }
  return steps.join(' > ')
}

/** Does this element's own CSS stop it growing with its content? */
function boxIsFixed(element: Element): boolean {
  const style = getComputedStyle(element)
  if (style.position === 'absolute' || style.position === 'fixed') return true
  const height = style.height
  return height !== '' && height !== 'auto'
}

/**
 * Is everything inside this element free to change without moving `reading`? True when
 * the element, or something between it and the root, fixes its own size AND does not
 * contain `reading`.
 */
function sealed(element: Element, reading: Element, root: Element): boolean {
  let at: Element | null = element
  while (at !== null && at !== root.parentElement) {
    if (!at.contains(reading) && boxIsFixed(at)) return true
    at = at.parentElement
  }
  return false
}

/**
 * Everything laid out above `reading`, written down: structure and text, in document
 * order, stopping the moment `reading` is reached. A sealed box contributes a marker and
 * nothing from inside it — which is the whole point, since what happens in there cannot
 * reach out.
 *
 * Two renders with the same signature cannot place `reading` differently. Two renders
 * with different signatures might not either — a changed class name is in here and moves
 * nothing — so this errs toward failing, and that is the right side to err on for an
 * assertion whose job is to protect a promise.
 */
function flowAbove(root: Element, reading: Element): string {
  const parts: string[] = []
  let reached = false

  const walk = (node: Node): void => {
    if (reached) return
    if (node === reading) {
      reached = true
      return
    }
    if (node.nodeType === 3 /* text */) {
      parts.push(`"${node.textContent ?? ''}"`)
      return
    }
    if (node.nodeType !== 1 /* element */) return

    const element = node as Element
    parts.push(`<${element.tagName.toLowerCase()} ${element.id} ${element.className}`)
    if (element !== root && sealed(element, reading, root)) {
      parts.push('[sealed]')
      return
    }
    for (const child of [...node.childNodes]) walk(child)
    parts.push('>')
  }

  walk(root)
  return parts.join('|')
}

/** The deepest elements whose content changed — for a message that names one thing. */
function blame(root: Element, reading: Element, before: Map<Element, string>): Reflow[] {
  const changed = [...before.keys()].filter(
    (element) => root.contains(element) && element.innerHTML !== before.get(element),
  )
  const deepest = changed.filter(
    (element) => !changed.some((other) => other !== element && element.contains(other)),
  )
  const loose = deepest.filter((element) => !sealed(element, reading, root))

  if (loose.length > 0) {
    return loose.map((element) => ({
      where: pathTo(element, root),
      why:
        'its content changed and nothing between it and the page fixes a height, so it ' +
        'grows with whatever arrives and carries everything below it down. Compose a ' +
        'LiveRegion, or give the box a height — never a max-height, which grows the same ' +
        'way and only stops later',
    }))
  }

  return [
    {
      where: pathTo(reading, root),
      why:
        'something above it was inserted, removed, reordered, or changed its text ' +
        'outside a fixed box. Nothing above a reading eye may change size',
    },
  ]
}

/**
 * Watch `reading` while `act` happens, and throw unless it was impossible for it to move.
 *
 * `root` is the screen; `reading` is the element Ryan's eye or hand is on — the button he
 * is reaching for, the sentence he is halfway through.
 *
 * ```ts
 * await heldStill(screen, screen.querySelector('#rule-on-ep06')!, () => {
 *   act(() => { events.append({ kind: 'step-progress', summary: 'Shot 9 of 14', … }) })
 * })
 * ```
 */
export async function heldStill(
  root: Element,
  reading: Element,
  act: () => void | Promise<void>,
): Promise<void> {
  if (!root.contains(reading)) {
    throw new Error('the element being read is not inside the root being watched')
  }

  const signature = flowAbove(root, reading)
  const content = new Map<Element, string>(
    [root, ...root.querySelectorAll('*')].map((element) => [element, element.innerHTML]),
  )

  await act()

  if (!root.contains(reading)) {
    throw new ReflowError([
      {
        where: pathTo(reading, root),
        why: 'it was removed from the page, which is the most complete way to lose it',
      },
    ])
  }

  if (flowAbove(root, reading) !== signature) {
    throw new ReflowError(blame(root, reading, content))
  }
}

/**
 * The same element, not merely an identical one. Geometry is what `heldStill` protects;
 * this protects the thing geometry cannot see — a React remount replaces the node, and
 * with it goes focus, a caret, a text selection and any scroll position inside it. A
 * screen that keeps its shape but re-creates its nodes still loses Ryan's place.
 */
export function stillTheSameNode(before: Element, after: Element | null): void {
  if (before !== after) {
    throw new Error(
      'the element was replaced rather than updated — it looks the same and is not the ' +
        'same node, so focus, selection and scroll position inside it are gone. Something ' +
        'above it changed its key, its element type, or its position among its siblings',
    )
  }
}
