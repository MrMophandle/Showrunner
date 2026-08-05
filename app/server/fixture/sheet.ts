/**
 * The fixture sheet format: markdown a showrunner can read, with just enough shape
 * that a loader can execute it.
 *
 * A sheet is one canon entity, one category declaration, one arc, one episode, or one
 * script. The format is deliberately four rules and no more, because it is copied by
 * hand more often than it is parsed:
 *
 *   # Title              the entity's name, the arc's name, the scene's heading
 *   > blurb              one or two lines of what this is, under the title or a heading
 *   ## Section           everything until the next `## `; `### ` stays inside as prose
 *   - key: value         a field, split at the FIRST colon; wrapped lines indent by two
 *
 * There is no YAML front matter and no JSON sidecar. Front matter would put half the
 * sheet in a second language with its own quoting rules, and a sidecar would let the
 * prose and the data drift apart in two files nobody diffs together. The cost is this
 * module; the benefit is that `canon/character/ilse-renn.md` reads as a character
 * sheet to a person and as a record to the loader, with no third artifact in between.
 *
 * This parses shape only. What the shapes have to CONTAIN — a required species, a
 * declared relation type, an arc waypoint's landing criteria — is `read.ts`.
 */

export interface Section {
  name: string
  /** The `> …` lines directly under the heading, folded into one line. */
  quote: string
  /** The rest of the section, verbatim and trimmed. Sub-headings included. */
  text: string
  /** The `- …` lines, each folded onto one line. */
  bullets: string[]
}

export interface Sheet {
  /** Where it came from, so an error can say which file is wrong. */
  path: string
  title: string
  quote: string
  sections: Section[]
}

export interface Field {
  key: string
  value: string
}

export function parseSheet(path: string, source: string): Sheet {
  const lines = source.split('\n')

  const titleAt = lines.findIndex((line) => line.startsWith('# '))
  if (titleAt === -1) throw new Error(`${path}: no \`# \` title. Every sheet opens with one.`)

  const heads: number[] = []
  lines.forEach((line, index) => {
    if (index > titleAt && line.startsWith('## ') && !line.startsWith('### ')) heads.push(index)
  })

  const preamble = lines.slice(titleAt + 1, heads[0] ?? lines.length)
  const sections = heads.map((head, index) =>
    readSection(lines[head]!.slice(3).trim(), lines.slice(head + 1, heads[index + 1] ?? lines.length)),
  )

  return {
    path,
    title: lines[titleAt]!.slice(2).trim(),
    quote: quoteOf(preamble),
    sections,
  }
}

export function section(sheet: Sheet, name: string): Section | undefined {
  return sheet.sections.find((s) => s.name === name)
}

/**
 * Every `- key: value` bullet, in order. A bullet with no colon is prose, not a field.
 *
 * The split is at the FIRST colon and there is no cleverness about what a key may look
 * like — keys in this format include `landing criteria` and, in an episode's arc
 * positions, the arc's own name. A section of prose bullets (`## Facts`) is read with
 * `bullets`; calling `fields` on one is the caller's mistake, not something to guess at.
 */
export function fields(section: Section): Field[] {
  return section.bullets.map(asField).filter((f) => f !== undefined)
}

export function field(section: Section, key: string): string | undefined {
  return fields(section).find((f) => f.key === key)?.value
}

function asField(bullet: string): Field | undefined {
  const at = bullet.indexOf(': ')
  if (at === -1) return undefined
  return { key: bullet.slice(0, at).trim(), value: bullet.slice(at + 2).trim() }
}

function readSection(name: string, body: string[]): Section {
  const bullets: string[] = []
  const prose: string[] = []
  let open = false

  for (const line of body) {
    if (line.startsWith('- ')) {
      bullets.push(line.slice(2).trim())
      open = true
      continue
    }
    // Two spaces of indent continues the bullet above it — that is how a fact or a
    // landing criterion gets to be a paragraph without becoming one long line.
    if (open && /^ {2}\S/.test(line)) {
      bullets[bullets.length - 1] += ` ${line.trim()}`
      continue
    }
    open = false
    prose.push(line)
  }

  return {
    name,
    quote: quoteOf(body),
    text: prose
      .filter((line) => !line.startsWith('>'))
      .join('\n')
      .trim(),
    bullets,
  }
}

/** The leading `> ` block, folded to one line. Anything after the first break is prose. */
function quoteOf(body: string[]): string {
  const start = body.findIndex((line) => line.trim() !== '')
  if (start === -1 || !body[start]!.startsWith('> ')) return ''
  const quoted: string[] = []
  for (const line of body.slice(start)) {
    if (!line.startsWith('> ')) break
    quoted.push(line.slice(2).trim())
  }
  return quoted.join(' ')
}
