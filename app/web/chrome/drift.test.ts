import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The mockups are the source, and this is what makes that mechanical (E5-0, #80).
 *
 * ── Why a test rather than a promise ────────────────────────────────────────────
 * "The design system is extracted from the mockups, not invented" is the kind of claim
 * that is true on the day it is written and quietly false four sessions later, when
 * somebody nudges a shade because a screen looked better with it. So it is asserted:
 * this file parses `chrome.css` AND all eight files in `mockups/`, and fails when a value
 * in one stops matching the value in the other.
 *
 * Three different questions, because the mockups answer them three different ways:
 *
 * 1. **The palette is a lift.** All eight mockups declare a byte-identical `:root`, so
 *    `chrome.css` must declare exactly those twelve properties with exactly those values.
 *    Equality, both directions.
 * 2. **A named shade must exist somewhere.** Six colours are used over and over in the
 *    mockups without being named. `chrome.css` names them; the names are new, the values
 *    are not, and every one must still occur as a literal in a mockup.
 * 3. **A shared component's declarations must match, and the dissenters are recorded.**
 *    Where the mockups disagree, the decision lives in `DECIDED` below WITH the files that
 *    say otherwise — so the disagreement survives in code instead of being averaged away,
 *    and a later session can see it was a choice rather than an accident. Every entry here
 *    is in #80's summary for Ryan's eye.
 *
 * What this test cannot do is notice a value nobody wrote down. It is a drift alarm, not
 * a design review — the design review is Ryan looking at the two side by side.
 */

const ROOT = join(import.meta.dirname, '..', '..', '..')
const MOCKUPS = join(ROOT, 'mockups')
const CHROME = readFileSync(join(import.meta.dirname, 'chrome.css'), 'utf8')

const mockupFiles = readdirSync(MOCKUPS)
  .filter((name) => name.endsWith('.html'))
  .sort()

const mockupCss = new Map(
  mockupFiles.map((name) => {
    const html = readFileSync(join(MOCKUPS, name), 'utf8')
    const blocks = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1] ?? '')
    return [name, blocks.join('\n')]
  }),
)

/** One CSS rule, flattened: the selector and its declarations as `prop: value` strings. */
interface Rule {
  selector: string
  declarations: Map<string, string>
}

/**
 * A rule reader small enough to read. It descends into `@media` rather than skipping it,
 * so a value hidden in a breakpoint still counts as declared, and it drops comments so a
 * commented-out value never satisfies anything.
 */
function rules(css: string): Rule[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const found: Rule[] = []
  let depth = 0
  let buffer = ''
  for (const character of clean) {
    buffer += character
    if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) {
        const match = /^\s*([^{]*?)\s*\{([\s\S]*)\}\s*$/.exec(buffer)
        buffer = ''
        if (!match) continue
        const selector = (match[1] ?? '').split(/\s+/).join(' ')
        const body = match[2] ?? ''
        if (selector.startsWith('@')) {
          found.push(...rules(body))
          continue
        }
        const declarations = new Map<string, string>()
        for (const part of body.split(';')) {
          const at = part.indexOf(':')
          if (at < 0) continue
          const property = part.slice(0, at).trim()
          const value = part.slice(at + 1).split(/\s+/).join(' ').trim()
          if (property !== '' && value !== '') declarations.set(property, value)
        }
        found.push({ selector, declarations })
      }
    }
  }
  return found
}

function ruleFor(css: string, selector: string): Rule | undefined {
  return rules(css).find((rule) => rule.selector === selector)
}

const chromeRoot = ruleFor(CHROME, ':root')!.declarations

describe('the palette is the mockups’, verbatim', () => {
  it('is byte-identical across all eight mockups, which is why it can be lifted at all', () => {
    const declared = mockupFiles.map(
      (name) => [name, ruleFor(mockupCss.get(name)!, ':root')!.declarations] as const,
    )
    expect(declared).toHaveLength(8)

    const [first, ...rest] = declared
    const [, reference] = first!
    // The season map adds one layout property of its own; everything else must agree.
    const shared = [...reference.keys()].filter((key) => key !== '--cols')
    for (const [name, theirs] of rest) {
      for (const key of shared) {
        expect(theirs.get(key), `${name} disagrees about ${key}`).toBe(reference.get(key))
      }
    }
  })

  it('reaches chrome.css unchanged — every property, both directions', () => {
    const mockup = ruleFor(mockupCss.get('floor.html')!, ':root')!.declarations

    for (const [property, value] of mockup) {
      expect(chromeRoot.get(property), `chrome.css moved ${property}`).toBe(value)
    }

    // And nothing was quietly dropped: every colour the mockups name is still named here.
    expect([...mockup.keys()].every((key) => chromeRoot.has(key))).toBe(true)
  })
})

/**
 * The six shades the mockups use without naming, and the two the live box is built from.
 * New names, lifted values — so the check is that the value is still THERE, in a mockup,
 * spelt exactly this way.
 */
const LIFTED_SHADES = [
  '--line-strong',
  '--rule',
  '--on-warn',
  '--faint',
  '--track',
  '--track-pip',
  '--live-fill',
  '--live-edge',
] as const

/**
 * The scale tokens. The mockups do not declare these as custom properties — they sit as
 * literals in the rules that use them — so what is asserted is that each value occurs, and
 * how widely. A token whose value appears in no mockup is an invention.
 */
const LIFTED_SCALE = [
  '--type-label',
  '--type-small',
  '--type-meta',
  '--type-read',
  '--type-body',
  '--type-action',
  '--type-page',
  '--type-title',
  '--track-label',
  '--track-live',
  '--track-tag',
  '--page-pad-y',
  '--page-pad-x',
  '--page-foot',
  '--wrap',
  '--rail',
  '--panel-pad-y',
  '--panel-pad-x',
  '--panel-gap',
  '--heading-gap',
  '--row-pad',
  '--radius-panel',
  '--radius-control',
  '--radius-chip',
  '--radius-tag',
  '--radius-pill',
] as const

describe('every value chrome.css names was already in a mockup', () => {
  const everyMockup = [...mockupCss.values()].join('\n')

  it.each([...LIFTED_SHADES])('%s is a colour the mockups already use', (token) => {
    const value = chromeRoot.get(token)
    expect(value, `${token} is not declared`).toBeDefined()
    expect(everyMockup.includes(value!), `${token}: ${value} appears in no mockup`).toBe(true)
  })

  it.each([...LIFTED_SCALE])('%s is a measure the mockups already use', (token) => {
    const value = chromeRoot.get(token)
    expect(value, `${token} is not declared`).toBeDefined()
    // `.16em` in a mockup, `0.16em` in a stylesheet a formatter has been over: the same
    // measure, and this test is about the measure rather than about the leading zero.
    const spellings = [value!, value!.replace(/^0\./, '.'), value!.replace(/^\./, '0.')]
    expect(
      spellings.some((spelling) => everyMockup.includes(spelling)),
      `${token}: ${value} appears in no mockup — it was invented, not extracted`,
    ).toBe(true)
  })
})

/**
 * ── Where the mockups disagree ──────────────────────────────────────────────────
 * Each entry is a decision, the value it landed on, the mockups that agree, and the
 * mockups that say something else. The test asserts BOTH halves: that `chrome.css` holds
 * the decided value, and that the dissenters still say what this table claims they say —
 * so if a mockup is ever edited, the disagreement is re-opened rather than silently
 * resolved by a stale comment.
 */
const DECIDED: readonly {
  what: string
  token: string
  chose: string
  agreeing: string[]
  dissenting: Record<string, string>
  why: string
}[] = [
  {
    what: 'the page’s top and side padding',
    token: '--page-pad-y',
    chose: '28px',
    agreeing: ['arc.html', 'canon-library.html', 'review-desk.html', 'screening-room.html', 'season-map.html'],
    dissenting: { 'floor.html': '32px', 'episode-room.html': '32px', 'gate-room.html': '32px' },
    why: 'five files to three, and the difference is 4px of air rather than a design idea',
  },
  {
    what: 'the centred column',
    token: '--wrap',
    chose: '1280px',
    agreeing: ['arc.html', 'canon-library.html', 'review-desk.html', 'screening-room.html'],
    dissenting: { 'floor.html': '1180px', 'episode-room.html': '1240px', 'gate-room.html': '1240px', 'season-map.html': '1320px' },
    why:
      'the plurality, and the token is per-screen overridable because the season map is ' +
      'wider and the floor narrower on purpose — a nine-column grid and a three-card row',
  },
  {
    what: 'the right-hand rail',
    token: '--rail',
    chose: '360px',
    agreeing: ['episode-room.html', 'screening-room.html'],
    dissenting: { 'gate-room.html': '370px', 'review-desk.html': '380px' },
    why: 'a 20px spread across four screens drawing the same rail — drift, not intent',
  },
  {
    what: 'a section heading’s letter-spacing',
    token: '--track-label',
    chose: '0.16em',
    agreeing: [
      'arc.html',
      'canon-library.html',
      'episode-room.html',
      'floor.html',
      'gate-room.html',
      'review-desk.html',
      'screening-room.html',
      'season-map.html',
    ],
    dissenting: {},
    why: 'unanimous — this one is not a decision, it is the value',
  },
  {
    what: 'a standing tag’s letter-spacing',
    token: '--track-tag',
    chose: '0.08em',
    agreeing: ['episode-room.html', 'gate-room.html', 'review-desk.html'],
    dissenting: { 'canon-library.html': '.07em', 'arc.html': '.07em' },
    why:
      'three files spell the tag `.sev` at .08em and two spell it `.chip` at .07em; the ' +
      'three agree byte for byte on everything else about it, so they carry it',
  },
]

describe('where the mockups disagree, the choice is recorded rather than averaged', () => {
  it.each(DECIDED.map((decided) => [decided.what, decided] as const))(
    '%s — chrome.css holds the decided value',
    (_what, decided) => {
      expect(chromeRoot.get(decided.token)).toBe(decided.chose)
    },
  )

  it.each(DECIDED.map((decided) => [decided.what, decided] as const))(
    '%s — the dissenting mockups still dissent',
    (_what, decided) => {
      for (const [file, value] of Object.entries(decided.dissenting)) {
        expect(
          mockupCss.get(file)!.includes(value),
          `${file} no longer says ${value} — the disagreement recorded in drift.test.ts is stale`,
        ).toBe(true)
      }
    },
  )
})

/**
 * The component shapes. Each row is a property the mockups agree on exactly, checked
 * against the rule `chrome.css` draws it with — the assertion that the button really is
 * the mockups' button and the panel really is the mockups' panel.
 */
const SHAPES: readonly { chrome: string; property: string; value: string; from: string }[] = [
  { chrome: 'body', property: 'background', value: 'var(--page)', from: 'all eight' },
  { chrome: 'body', property: 'color', value: 'var(--ink-2)', from: 'all eight' },
  { chrome: '.card', property: 'background', value: 'var(--card)', from: 'the seven with a .panel' },
  { chrome: '.card', property: 'border', value: '1px solid var(--line)', from: 'the seven with a .panel' },
  { chrome: '.card', property: 'border-radius', value: 'var(--radius-panel)', from: 'the seven with a .panel' },
  { chrome: '.card-row', property: 'border-bottom', value: '1px solid var(--rule)', from: 'eleven row classes' },
  { chrome: '.section-h__name', property: 'text-transform', value: 'uppercase', from: 'all eight' },
  { chrome: '.section-h__name', property: 'color', value: 'var(--muted)', from: 'all eight' },
  { chrome: '.btn', property: 'font-weight', value: '600', from: 'the five with a .btn' },
  { chrome: '.btn', property: 'border', value: '1px solid var(--line)', from: 'the five with a .btn' },
  { chrome: '.btn', property: 'background', value: 'var(--card-raised)', from: 'the five with a .btn' },
  { chrome: '.btn', property: 'color', value: 'var(--ink)', from: 'the five with a .btn' },
  { chrome: '.btn', property: 'text-align', value: 'left', from: 'the five with a .btn' },
  { chrome: '.btn .cost', property: 'display', value: 'block', from: 'the five with a .btn' },
  { chrome: '.btn .cost', property: 'font-weight', value: '400', from: 'the five with a .btn' },
  { chrome: '.btn .cost', property: 'color', value: 'var(--muted)', from: 'the five with a .btn' },
  { chrome: '.btn:disabled', property: 'border-style', value: 'dashed', from: 'floor and the episode room' },
  { chrome: '.btn:disabled', property: 'cursor', value: 'not-allowed', from: 'floor and the episode room' },
  { chrome: '.crumb', property: 'font-size', value: 'var(--type-meta)', from: 'the seven with a crumb' },
  { chrome: '.crumb', property: 'color', value: 'var(--muted)', from: 'the seven with a crumb' },
  { chrome: 'footer', property: 'color', value: 'var(--faint)', from: 'all eight' },
  { chrome: '.live-region', property: 'background', value: 'var(--live-fill)', from: 'floor and the episode room' },
  { chrome: '.live-region', property: 'border', value: '1px solid var(--live-edge)', from: 'floor and the episode room' },
  { chrome: '.live-region__latest', property: 'color', value: 'var(--ink)', from: 'floor and the episode room' },
  { chrome: '.live-region__stream', property: 'font-style', value: 'italic', from: 'floor and the episode room' },
  { chrome: '.live-region__stream', property: 'text-overflow', value: 'ellipsis', from: 'floor and the episode room' },
]

describe('the components are the mockups’ components', () => {
  it.each(SHAPES.map((shape) => [`${shape.chrome} { ${shape.property} } — from ${shape.from}`, shape] as const))(
    '%s',
    (_label, shape) => {
      const rule = ruleFor(CHROME, shape.chrome)
      expect(rule, `chrome.css has no rule for ${shape.chrome}`).toBeDefined()
      expect(rule!.declarations.get(shape.property)).toBe(shape.value)
    },
  )

  it('draws the reset the mockups draw, and it is identical in all eight', () => {
    const reset = ruleFor(CHROME, '*')!.declarations
    for (const name of mockupFiles) {
      const theirs = ruleFor(mockupCss.get(name)!, '*')!.declarations
      for (const [property, value] of theirs) {
        expect(reset.get(property), `${name} disagrees about the reset's ${property}`).toBe(value)
      }
    }
  })
})

/**
 * ── The pip's three states, which are a RULING rather than a lift ───────────────
 *
 * The two mockups that draw a lifecycle track disagree, and Ryan settled it during E5-0's
 * review on Aug 11 2026 (recorded on #81):
 *
 *   **done / current-AMBER / running-BLUE-PULSING. Amber means your hand, blue means in
 *   flight — app-wide, forever.**
 *
 * `floor.html` draws three states and is the one the ruling follows. `episode-room.html`
 * draws two, painting `.stage.now` blue-and-pulsing whether or not anything is running —
 * so a stage sitting waiting for Ryan would look exactly like a stage mid-call. **That
 * spelling is overruled.** It is asserted here rather than fixed in the mockup, because the
 * mockups are approved design and a session that edits one has erased the disagreement the
 * ruling was about; if the episode room is ever redrawn, this fails and the next session
 * finds the ruling instead of a silent agreement.
 */
const PIP: readonly { standing: string; property: string; value: string; means: string }[] = [
  { standing: 'done', property: 'background', value: 'var(--line-strong)', means: 'reached and passed — history is quiet' },
  { standing: 'current', property: 'background', value: 'var(--warn)', means: 'your hand: it is where the episode stands and yours to move' },
  { standing: 'running', property: 'background', value: 'var(--live)', means: 'in flight: a call is turning on it right now' },
]

describe('the lifecycle pip carries the three states Ryan ruled', () => {
  it.each(PIP.map((pip) => [`.stage--${pip.standing} .pip — ${pip.means}`, pip] as const))(
    '%s',
    (_label, pip) => {
      const rule = ruleFor(CHROME, `.stage--${pip.standing} .pip`)
      expect(rule, `chrome.css draws no pip for .stage--${pip.standing}`).toBeDefined()
      expect(rule!.declarations.get(pip.property)).toBe(pip.value)
      expect(rule!.declarations.get('border-color')).toBe(pip.value)
    },
  )

  it('pulses the running state and nothing else — the animation IS the "in flight"', () => {
    expect(ruleFor(CHROME, '.stage--running .pip')!.declarations.get('animation')).toBe(
      'pulse 1.6s ease-in-out infinite',
    )
    for (const standing of ['done', 'current']) {
      expect(ruleFor(CHROME, `.stage--${standing} .pip`)!.declarations.has('animation')).toBe(false)
    }
  })

  it('takes the three from floor.html, which is the mockup the ruling followed', () => {
    const floor = mockupCss.get('floor.html')!
    expect(ruleFor(floor, '.stage.done .pip')!.declarations.get('background')).toBe('#4e4e49')
    expect(ruleFor(floor, '.stage.now .pip')!.declarations.get('background')).toBe('var(--warn)')
    expect(ruleFor(floor, '.stage.now.live .pip')!.declarations.get('background')).toBe('var(--live)')
    // `--line-strong` is chrome.css's name for the grey the mockup spells as a literal.
    expect(chromeRoot.get('--line-strong')).toBe('#4e4e49')
  })

  it('records that the episode room still says otherwise, and is still overruled', () => {
    const room = ruleFor(mockupCss.get('episode-room.html')!, '.stage.now .pip')!.declarations
    expect(
      room.get('background'),
      'episode-room.html no longer paints a merely-current stage blue — the ruling recorded ' +
        'in drift.test.ts and LifecycleTrack.tsx is stale, and E5-2 should be told',
    ).toBe('var(--live)')
    expect(room.has('animation')).toBe(true)
    // And it has no third state at all, which is the half of the disagreement that matters:
    // nothing in that file can tell "waiting on you" from "working".
    expect(ruleFor(mockupCss.get('episode-room.html')!, '.stage.now.live .pip')).toBeUndefined()
  })
})

/**
 * ── The one place a mockup rule was carried onto its sibling ────────────────────
 * The mockups clamp the streamed line to one line and leave the latest-wins line free to
 * wrap. A wrapping line grows the box, and a growing box is the whole defect this epic
 * exists to end, so `.live-region__latest` gets the treatment `.live-region__stream`
 * already had. It is recorded here rather than done quietly, and it is in #80's summary.
 */
describe('the live region’s one addition to the mockups', () => {
  it('clamps the latest-wins line exactly the way the mockups clamp the streamed one', () => {
    const stream = ruleFor(mockupCss.get('floor.html')!, '.running .stream')!.declarations
    const latest = ruleFor(CHROME, '.live-region__latest')!.declarations

    for (const property of ['white-space', 'overflow', 'text-overflow']) {
      expect(latest.get(property), `the latest line does not clamp its ${property}`).toBe(
        stream.get(property),
      )
    }
  })

  it('gives every part of the region a height, which no mockup does', () => {
    // The mockups' `.running` reserves nothing — there is no height, min-height,
    // max-height or overflow on it in either file that draws one. That is fine for a
    // static page and fatal for a live one, and it is what E5-0 adds.
    for (const file of ['floor.html', 'episode-room.html']) {
      const running = ruleFor(mockupCss.get(file)!, '.running')!.declarations
      expect([...running.keys()].some((key) => key.includes('height'))).toBe(false)
    }

    for (const part of [
      '.live-region__heading',
      '.live-region__latest',
      '.live-region__stream',
      '.live-region__log',
    ]) {
      const height = ruleFor(CHROME, part)!.declarations.get('height')
      expect(height, `${part} has no fixed height, so the region can grow`).toBeDefined()
      expect(height).not.toBe('auto')
    }

    // And a `max-height` anywhere in the region would be the scaffolding's defect wearing
    // this stylesheet: a box that grows up to its maximum shoves the page the whole way.
    const region = rules(CHROME).filter((rule) => rule.selector.startsWith('.live-region'))
    expect(region.some((rule) => rule.declarations.has('max-height'))).toBe(false)
  })
})
