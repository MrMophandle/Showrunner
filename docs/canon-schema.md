# The canon schema

**This document is canon schema version 1.**

This is the document you hand a Claude session, along with your source material, to get a
show's canon back as sheets. It ships with the app, it is versioned, and it describes the
format the app's reader actually accepts — not a format somebody hopes it accepts.

It is written for three readers, in this order:

1. **A new showrunner** starting an empty show, who has a world in their head or in a pile
   of notes and needs it to become canon the app can check scripts against.
2. **A Claude session** given this document and that pile of notes, asked to draft the
   sheets. Everything a session needs to produce a sheet the reader accepts is in here;
   nothing else is required, and that is a condition this document is tested against.
3. **A migration** bringing an existing show across. Same pipeline, pointed at the old
   repository instead of at a person.

The parser lives in `app/server/fixture/sheet.ts` (the format) and `app/server/fixture/read.ts`
(what the shapes must contain, and every refusal). If this document and those two files ever
disagree, the files are right and this document has a bug — see [§10](#10-this-documents-version).

---

## 1. What a pack is

A **pack** is a directory of markdown files. It is the whole input: no database, no JSON, no
identifiers, no dates.

```
show.md                       the show, and its seasons
canon/<category-key>/
  _category.md                one category: its fields, what its checks apply to, the
                              relation types it allows, and what a check should do
  <entity-slug>.md            one entity: identity, relations, prose body, facts
```

That is all a founding pack needs. Two more directories exist in a full show —
`arc/<arc>.md` and `episode/<nn>-<slug>/` — and they are **not** part of a founding pack;
see [what this document does not cover](#what-this-document-does-not-cover).

A minimal pack that is nonetheless complete is in `docs/canon-schema-example/`, and every
example in this document is one of its files, quoted byte for byte. The much larger worked
example — five categories, seven entities, an arc, two episodes and a script — is
`fixtures/greyharbor/`. Read this document; then read that show.

**Filenames.** The directory under `canon/` is the category's key and must match the `key`
the category declares inside itself. Entity filenames are yours; a slug of the entity's name
is the convention, and only the `# Title` inside the file names the entity. A file whose name
begins with `_` is not read as an entity, which is why the category sheet is `_category.md`.

---

## 2. The sheet format — four rules

Every file in a pack, whatever it holds, is parsed by the same four rules. There are four
and no more, because these files are copied by hand far more often than they are parsed.

```markdown
# Title                     the entity's name, the category's name, the show's name
> blurb                     a line or two of what this is, directly under the title
## Section                  everything until the next `## `; `### ` stays inside as prose
- key: value                a field, split at the FIRST `: `
  wrapped like this         two spaces of indent continues the line above
```

There is no YAML front matter and no JSON sidecar. Front matter would put half of every
sheet in a second language with its own quoting rules, and a sidecar would let the prose and
the data drift apart in two files nobody diffs together. The cost is a small parser; the
benefit is that `canon/character/ottilie-bray.md` reads as a character sheet to a person and
as a record to the app, with no third artifact in between.

Seven things follow from those rules, and all seven bite in practice:

- **The colon needs its space.** `- standing: core` is a field. `- standing:core` is not —
  it is read as a line of prose, and the field will be reported missing.
- **The split is at the first `: ` only.** `- aliases: Til, the clerk` and
  `- landing criteria: she says it out loud: to one person` both work.
- **Whether a bullet is a field or a statement is the section's business, not the bullet's.**
  `## Show`, `## Category`, `## Identity` and `## Relations` are read as `key: value`, and a
  bullet without a `: ` in one of them is ignored. `## Facts` is read as whole statements, so
  a colon there is harmless and stays in the text: `- hearing: she reads the tide by ear`
  becomes exactly that sentence, colon and all — which is why §5.5 asks you not to write
  facts that way.
- **Sections the reader does not need are ignored, never refused.** `## Wardrobe` on a
  character or `## Notes` on a category breaks nothing. Every sheet below lists the sections
  that are *required*; the rest of the file is yours, because a sheet is a place to write
  things down and not a form.
- **Wrapped lines indent by exactly two spaces.** That is how a fact gets to be a paragraph
  without becoming one very long line. Three spaces, a tab, or none, and the line becomes
  prose instead of part of the bullet above it.
- **A blurb is the `> ` block directly under a heading**, folded onto one line. The first
  line that is not `> ` ends it; anything after is ordinary prose.
- **Prose is welcome everywhere.** Any section may carry paragraphs alongside its bullets,
  and the reader keeps them. Explaining a decision on the sheet is normal and encouraged —
  the sheets in `docs/canon-schema-example/` do it, and so does every sheet in the fixture.

---

## 3. `show.md`

<!-- example: show.md -->
```markdown
# Salt March

> A tidal crossing two cities walk twice a year, and the people who make a living
> off the walkers. The smallest pack that still founds: one season, two categories,
> three entities.

## Show

- key: saltmarch
- title: Salt March

## Seasons

- 1: The Spring Walk

## What this pack is for

Salt March is the example pack for `docs/canon-schema.md`. It is not a fixture and
no test is written against its story — what the tests check is that every sheet in
here is one the reader accepts, and that the blocks quoted in the document are
these files, byte for byte.

Copy this directory, change `key` and `title`, keep the categories you want, and
write your own entities. Nothing here is in it because Salt March needs it. It is
here because it is the shape.
```

**Required:** the `# ` title, a `## Show` section with `key` and `title`, and a `## Seasons`
section. Everything else on the sheet is yours.

- **`key`** is the show's handle, lowercase and without spaces by convention. It names the
  show's directory on the artifact volume, so it never changes.
- **Seasons** are `- <number>: <title>`. The key must be an integer. A pack for a show that
  has not planned a second season declares one season, and adding another later is an edit.

---

## 4. The category sheet — `canon/<key>/_category.md`

A category is a *kind* of canon: character, location, faction, species, technology, timeline,
house style, world rules. **A category is data.** Adding one is a directory and a markdown
file, not engineering, and that promise is the whole reason this document can exist: a show
whose world needs a `vessel` category writes one.

<!-- example: canon/character/_category.md -->
```markdown
# Character

> Someone who acts in the story. The category every other one ends up pointing at.

## Category

- key: character
- applies to: premise-brief, outline, script, scene-text, shot-image, tts-take

## Fields

- standing: core / recurring / one-shot / retired. Declared intent, not a count —
  how often someone actually appears is computed from artifact provenance.
- status: active / historical / candidate.
- aliases: what else the scripts call them, comma separated.

## Relation types

- species → species · cardinality: exactly-one · required: yes · inverse: members · inherits facts: yes
- walks-with → character · cardinality: any · required: no · inverse: walked-with

`species` is required (D22), and it is what makes a rule about a body land on a
person: a check reading a scene only knows what the channel does to Ottilie
because her sheet says what she is. When a character's species genuinely is not
decided, the sheet declares the literal word `unknown` — never blank, because a
blank is indistinguishable from a sheet nobody finished.

`inherits facts: yes` says the Fennlander sheet's facts load into check scope with
every character that declares Fennlander. Facts travel the declared edge only, one
way: a character inherits from its species, a species inherits nothing from its
members, and two Fennlanders inherit nothing from each other. `walks-with` carries
no facts, which is the default and the reason nothing is written on it.

An inverse is not a second declaration. `members` is navigable from the species
side because this line names it; the species category declares no `members` of its
own.

## Check instructions

Read the artifact against exactly the facts loaded for this character and for the
species it declares. Behaviour that contradicts a fact is a finding anchored at the
scene where it happens — say which fact, and quote it.
```

Four sections are required, and each answers a different question.

### 4.1 `## Category` — where this category applies

- **`key`** must equal the directory name. `canon/character/_category.md` declares
  `key: character` or the pack is refused, naming the file.
- **`applies to`** is a comma-separated list of artifact kinds. It is what decides which
  checks fire where: a `character` check reads scripts and shot images; a `timeline`
  category might read only outlines. The vocabulary is fixed — see [§6](#6-the-vocabularies).

### 4.2 `## Fields` — what an entity of this category is made of

`- name: description`, in the order they should be read. Fields name the parts of an
entity's prose body and give a fact somewhere to belong. They are yours to choose; the three
in the example (`standing`, `status`, `aliases`) are conventional because every category has
them, not because the reader requires those names.

**This list is documentation, not a schema the reader enforces.** Declaring a field called
`age` does not make the reader look for `- age:` on an entity sheet, and does not stop it
either — it is read by you, and by the model that drafts and checks this category's entities.
The keys the reader actually takes off an entity are §5.1's three.

### 4.3 `## Relation types` — the edges this category is allowed to have

**Relations are typed, and an undeclared type is invalid.** A checker cannot traverse an
edge whose meaning nobody wrote down, so free verbs are refused rather than guessed at. One
bullet declares one type:

```
- species → species · cardinality: exactly-one · required: yes · inverse: members · inherits facts: yes
```

The arrow is `→` (U+2192) and the separator is `·` (U+00B7), each with a space on either
side. `->` is not an arrow and a comma is not a separator; both are refused, naming the file.

| Part | Meaning |
|---|---|
| `name → target category` | The edge's name, and the category key it must point at. Required. |
| `cardinality` | `exactly-one`, `at-most-one`, or `any`. How many edges of this type one entity may declare. Required. |
| `required` | `yes` or `no`. Whether an entity of this category must have one. Required. |
| `inverse` | The name the edge is navigable by **from the far end**. Required. |
| `inherits facts` | `yes` or `no`. Whether the target's facts load into check scope with the entity that declares the edge. Optional; left off means no. |

**The target category must be one this pack declares.** A `species → species` line in a pack
with no `canon/species/` directory is refused.

**An inverse is not a second declaration.** `members` is navigable from a species because
the *character* category named it; the species category declares nothing of the sort. That
is what makes blast radius computable from both ends — "who would this change reach?" is
answerable from the species side without the species knowing its members exist. Two
declarations may not share an inverse at the same far end, and an inverse may not collide
with a type that end already declares.

A category may point at **itself** — `walks-with → character`, declared by `character`. Both
rules above then apply to that one category's own list: the inverse must not already be some
other declaration's inverse there, and must not be the name of a type it declares. So
`walks-with` takes the inverse `walked-with`, and could not have taken `walks-with`.

**`inherits facts` travels one way: declarer → target.** A character inherits from the
species it points at. A species inherits nothing from its members, and two members inherit
nothing from each other. Left off, facts do not travel — which is legal, visible in the
declaration, and the honest way for it to fail. Written wrong it is refused: the value is
`yes` or `no` and nothing else, because a typo silently meaning "no" is a check reporting
clean on facts it never read.

### 4.4 `## Check instructions` — what a reviewer pass does with this category

Prose, read by a model at check time. Write it as instructions to a careful reader who has
the in-scope facts in front of them and nothing else. Say what counts as a violation, say
what the finding should name, and say what should **not** be reported — a category whose
instructions invite atmosphere gets findings about atmosphere.

A category with no relation types is legal and normal; a leaf category says so:

<!-- example: canon/species/_category.md -->
```markdown
# Species

> What a body can survive. The category that makes a rule about the world land on
> a person.

## Category

- key: species
- applies to: premise-brief, outline, script, scene-text, shot-image

## Fields

- standing: core / recurring / one-shot / retired.
- status: active / historical / candidate.
- aliases: comma separated.

## Relation types

None, and a category that declares none is legal. This one is a leaf: the edge
that matters is declared at the other end, by `character`, and `members` is
navigable from a species only because that declaration named it as its inverse.

## Check instructions

A species' facts load into check scope with every character that declares it. That
is the whole point of the category — physiology is written once, here, and
inherited. When an inherited fact is wrong for one character, the fix is a fact on
that character naming what it overrides, never a quiet edit here, which would
silently move every member.
```

---

## 5. The entity sheet — `canon/<key>/<slug>.md`

One entity: a person, a place, a rule, a piece of technology. The `# ` title is its name,
and **names are unique across a show** — they are how sheets point at each other, so a
duplicate is a refusal rather than a coin toss.

<!-- example: canon/character/ottilie-bray.md -->
```markdown
# Ottilie Bray

> The guide the spring walk is sold on. Knows the channel; is paid by the city she
> likes least.

## Identity

- standing: core
- status: active
- aliases: Til

## Relations

- species: Fennlander

## Body

Ottilie has taken the spring crossing nineteen times and has lost two walkers,
both in the same hour of the same year, and she gives that number before anyone
asks so that nobody gets to discover it. She is contracted by the eastern city
because the eastern city pays on the day, and she is careful to be seen not caring
which side of the flats she sleeps on.

Her authority on the sand is absolute and ends the moment the walk does. Off the
flats she is a marsh woman in a city that has opinions about those, and the
contract she signs each spring is a little worse than the one before it.

## Facts

- Ottilie Bray has guided nineteen spring crossings and lost two walkers, both on
  the same crossing.
- Ottilie is contracted by the eastern city, which pays her on the day the walk
  ends.
- Ottilie will not start a crossing after the third bell, whatever she is offered
  for it.
```

### 5.1 `## Identity` — required

- **`standing`** — `core`, `recurring`, `one-shot`, or `retired`. Declared intent, not a
  count: how often someone actually appears is computed from what the episodes touch.
- **`status`** — `active`, `historical`, or `candidate`. See [§5.7](#57-candidate-sheets-and-what-a-pack-is-claiming).
- **`aliases`** — optional, comma separated. What else the scripts call them.

Those three are read and anything else in the section is ignored, so `- age: 41` is legal and
inert. Put that kind of detail in the body, or in a fact, where something will read it.

### 5.2 `## Relations` — the sheet's edges

`- type: target`, where `type` is a relation type the category declares and `target` is
another entity's **name**, exactly as its own sheet's title spells it. This section is the
one optional section: leave it out when the entity declares no edges at all.

**Matching is literal.** `fennlander` does not find `Fennlander`, and a leading article is
part of the name — `The Farrow Glass Company` is not `Farrow Glass Company`. Names are how
sheets point at each other, so the reader will not guess at a near miss; it says the target
is not an entity in this show, and names the file that pointed at it.

Everything the declaration promised is enforced here. An undeclared type is refused. A
target that does not exist is refused. A target of the wrong category is refused. A second
edge of an `exactly-one` or `at-most-one` type is refused. Every refusal names the file.

### 5.3 `unknown` — the honest answer, and never a blank

A required relation whose answer genuinely is not decided is declared as the literal word
`unknown`:

```
- species: unknown
```

Three states, and they are three different things:

| On the sheet | What it means |
|---|---|
| no line at all | Nobody has said. A sheet somebody did not finish — and for a required type, refused. |
| `unknown` | Declared unknown. Somebody looked; the world has not decided. |
| a name | The edge. |

In the database this is **a relation row with no target**, not a sentinel `unknown` entity
in your species category. That matters to you as a pack author in three ways: an `unknown`
never appears in the canon library as a thing in the world; every character declaring it is
*not* claiming to share a species with every other one; and it occupies the slot, so
resolving it later is a replacement with a before — which is what a proposal needs in order
to be rulable at all.

`unknown` satisfies a `required` relation. Absent does not.

**It is legal on any relation type, not only a required one.** An optional edge has three
answers too, and they are worth telling apart: the faction nobody has decided a spokesman for
declares `speaks-through: unknown`, which is a different claim from leaving the line off. Use
it when somebody looked; leave the line off when the question has not come up. The difference
costs nothing to write and is the difference between a gap you can work through and a gap
nobody can see.

### 5.4 `## Body` — required

The prose sheet. Sectioned however the category's fields suggest, or not sectioned at all.
This is what makes a draft good rather than merely consistent: the body is what a writing
agent reads to sound like your show, and it is not checkable. Facts are the checkable half;
this is the other one, and a pack with facts and no bodies produces correct, lifeless drafts.

`### ` sub-headings stay inside the section as prose, so a long body may be structured.

### 5.5 `## Facts` — required, and at least one

Atomic checkable statements, one per bullet. **A sheet with no facts on it checks nothing**,
so an entity sheet with an empty `## Facts` section is refused.

Write them the way a check has to read them:

- **One claim per bullet.** A bullet with three claims in it produces a finding that quotes
  all three and is about one.
- **Whole sentences, not `key: value`.** A fact is a statement about the entity; a bullet
  with a colon in it becomes the statement `"appearance: tall"`, which is not what anyone
  wants quoted back at them in a finding.
- **Falsifiable beats atmospheric.** "Cycling the No. 4 lock takes ninety seconds" is
  checkable; "the lock is slow" is not. The deterministic checks in particular read numbers.
- **Name the exception where there is one.** A rule written so a check can say what it
  looked for and did not find produces a finding an author can argue with, which is the only
  kind worth having.
- **Prose in the section is not a fact.** Only the bullets are read, so a paragraph
  explaining why these facts matter is free.

**Facts on a sheet carry no status, no lineage, and no dates.** There is nowhere to write
"ratified" and that is deliberate: a file that declared its own facts ratified would be canon
written by an import, and canon is only ever written by the showrunner approving a proposal.
Lineage — which episode established a fact, which ruling ratified it — is written by that
approval and by nothing else.

### 5.6 A sheet with no edges at all

`## Relations` is the one section an entity sheet may leave out entirely — when its category
declares no relation types, or when it declares some and this entity has none of them. The
species sheet is the first case, and its facts are the ones [§8.3](#83-inheritance-and-exceptions)'s
inheritance carries onto every character that declares it:

<!-- example: canon/species/fennlander.md -->
```markdown
# Fennlander

> Marsh-born, and built for a crossing that drowns other people. No more immune to
> the tide than anyone else once it is in.

## Identity

- standing: core
- status: active
- aliases: marsh-born

## Body

Fennlanders have lived on the flats long enough that the language has no separate
word for ground and for water you can stand on. They are heavy-boned and slow over
distance, and they read a sandbar by the sound the water makes leaving it — a
skill the pilgrim cities pay for twice a year and mock the rest of the time.

None of it outruns a tide. A Fennlander caught in the channel when it fills goes
under like anyone else, and knows it earlier.

## Facts

- A Fennlander hears the turn of the tide about twenty minutes before it shows on
  the flats.
- A Fennlander cannot outwalk the flood across open sand; the water crosses the
  flats faster than a person runs.
- Fennlanders are heavy-boned and tire on long dry road, which is why they guide
  the crossing and never the road on either side of it.
```

### 5.7 `candidate` sheets, and what a pack is claiming

<!-- example: canon/character/corin-vale.md -->
```markdown
# Corin Vale

> The clerk sent to time the crossing and price it. A whole sheet nobody has ruled
> on — this is what a candidate looks like.

## Identity

- standing: recurring
- status: candidate
- aliases: the clerk

`status: candidate` is the only line that makes this sheet different from
Ottilie's, and it is an instruction to the loader: register the identity, raise
nothing. Somebody proposes Corin when Corin is actually written into an episode,
and the showrunner rules that promotion the way every other change to canon is
ruled.

## Relations

- species: unknown
- walks-with: Ottilie Bray

Declared unknown, not left blank (D22). Corin came in on the road from somewhere
else and nobody on the flats has asked; `unknown` says a person looked and the
world has not decided, which is a different thing from a sheet nobody finished. It
is legal, it is tracked, and it satisfies the required `species` at ratification —
so promoting Corin without answering the question is possible on purpose.

## Body

Corin was sent to time the crossing and price it: how many hours of guide, how
many walkers lost against how many paid for, and whether the eastern city is
buying the safest way over or only the oldest one. The instructions do not say who
wants to know.

The counting is honest and the questions are not asked out loud, which is a
combination Ottilie recognised inside a day and has said nothing about.

## Facts

- Corin Vale was sent to time and price the spring crossing, and files to the city
  rather than to the walk.
- Corin has walked the flats once, behind Ottilie, and wrote down where she
  stopped.
```

`status: candidate` is an instruction, and it is the one line that changes what happens to a
sheet: **a candidate sheet registers its identity and proposes nothing at all.** The file
stays a draft on disk, the database says `candidate`, and the two agree. Somebody proposes it
later, on purpose, when the show actually needs it — and because nothing was proposed, none
of its facts and none of its edges have been written either.

This is what a Claude session drafting from source material should produce for anything it
is not certain about. A pack of forty candidate sheets is a legitimate pack: it says "here
is everything I found, none of it is canon, rule what you want." A pack that marks everything
`active` is claiming the showrunner already agreed.

**A candidate sheet is not a licence to be sloppy.** The reader holds it to the format like
any other — a `candidate` character with no `species` line is refused, naming the file, the
same as an active one. What `candidate` buys is that nothing is *proposed*, not that less has
to be *written*. If the answer is not known, that is what `unknown` is for.

**Two ways out of `candidate`, and both are somebody deciding.** Before the pack is loaded,
change the line to `active` and the load raises its promotion. After the pack is loaded, the
identity is already registered and promoting it is an action in the app, which raises the very
same proposal from the very same sheet. What never happens is a candidate quietly becoming
canon because a loader ran again.

---

## 6. The vocabularies

Fixed sets. A value outside them is refused, and the refusal lists the alternatives.

<!-- vocabulary -->
```
standing: core / recurring / one-shot / retired
status: active / historical / candidate
cardinality: exactly-one / at-most-one / any
declared-unknown target: unknown
applies to: premise-brief / outline / script / scene-text / continuity-board / shot-manifest / shot-image / tts-take / mix / timeline / render / publish-kit
```

These are asserted against the app's own definitions by a test, so this list cannot quietly
fall behind the code: change one in the app and the test fails here. Whether that change also
raises this document's version is [§10](#10-this-documents-version) — removing a value does,
adding one does not.

---

## 7. What happens to a pack: load, found, rule

This is the part that surprises people, and it is the single most important thing in this
document: **loading a pack writes no canon.**

### 7.1 Loading raises

The loader reads the pack and does two different things with it, because two different rules
apply.

**Categories are written straight.** A category is schema, and schema is data — and it could
not go through a proposal even if that were wanted, because a proposal's subject is an
entity and a category is not one. So `canon/*/_category.md` becomes rows immediately:
fields, applicable artifact kinds, check instructions, relation type declarations.

**Every entity sheet not marked `candidate` becomes a promotion proposal.** Not rows — a
*proposal*, carrying the whole sheet: standing, aliases, prose body, every fact, every edge.
It is raised by the loader, it belongs to no episode, and it sits in the queue until somebody
rules it.

**Every candidate sheet becomes an identity and nothing else.** No proposal is raised for it
at all.

At the end of a load nothing about your world is true yet. The load reports what it raised
and says so.

### 7.2 Founding rules

**Founding** is the separate, deliberate act of ruling that stack. It walks the promotions
the loader raised, one at a time, through the same approval the app uses everywhere else —
the same call the gate over a script makes, the same one the canon bench makes. There is no
bulk write, no `--found` flag on the loader, and no force.

One at a time is not ceremony. Each promotion is a sheet the showrunner is approving, and
approving it is what writes its facts, its edges, its standing and its prose. A sheet that
cannot become canon aborts the whole founding rather than leaving half a show ratified —
fix the sheet and found again; nothing was written, so there is nothing to unpick.

**`required` is enforced here**, at the moment a sheet becomes canon, and this is worth being
exact about because two different things enforce it at two different times:

- **The pack reader** refuses any character sheet with no `species` line, `candidate` sheets
  included, naming the file. A pack is meant to be complete before anyone is asked to rule
  any part of it.
- **The database** enforces it at ratification, never at the individual edge write — a row is
  built one edge at a time and is ragged in between. So a candidate *row* may be half-written
  while somebody is building it; a candidate *sheet* may not, and canon may not.

`unknown` satisfies the requirement at both.

### 7.3 After founding, the pack is provenance

**The sheets are founding documents, not a sync source.** Load, found, and from then on canon
lives in the database and moves by proposals. Edit a sheet afterwards and it diverges
silently — that is correct, not a bug. Re-loading never raises a second stack and never
reconciles canon back out of files.

So: the pack is how a show *starts*. It is not how a show is *edited*. Editing canon is a
proposal, ruled at a gate, with a before and an after — which is the only way anything in
this app changes what is true.

### 7.4 Today's seams, honestly

`npm run fixture:load` loads the Grey Harbor fixture specifically. Loading an arbitrary pack
and founding it is code today — `loadFixture(store, paths, dir)` then `foundCanon(store, showId)`
— and giving it a screen is the new-show flow (E8). The pack format is what both read, which
is why this document is worth writing before that screen exists.

---

## 8. Canon after founding — what your facts become

You do not write any of this in a pack. It is here because it decides how to write the pack.

### 8.1 Proposals are the only way canon changes

Every change — a new fact, an edge, a promotion, overturning something ratified, an arc
landing — is a **proposal** with five parts: the change itself; the usage context that made
it necessary; the implications; the alternatives; and who raised it and what was decided.
Agents propose. Checks propose. Imports propose. Loaders propose. **Only the showrunner
approving one writes canon.**

A ruling is one of three, and all three are kept forever: **ratify**, **reject with a note**,
or **defer**. A rejection's note is read back by later writing runs, so "no, and here is why"
is a durable instruction rather than a deleted draft.

### 8.2 Facts are append-only, and time is a ruling number

A fact row is never edited and never deleted. Superseding one closes it and opens its
successor at the same ruling, so "what was canon as of episode 4" is answerable — and
answerable by *ruling*, a monotonic counter, rather than by a date. A date maps onto a
ruling, never the reverse.

The consequence for a pack author: a fact you write is going to be quoted back, in a finding,
against a script, with a lineage attached. Write it as something you would want to see
quoted.

### 8.3 Inheritance and exceptions

A fact-carrying edge — `inherits facts: yes` — loads the target's facts into check scope with
the entity that declares it. That is how a species' physiology reaches every character that
declares it without being copied onto each one.

When an inherited fact is wrong for one individual, the fix is **a fact on that individual
that names what it overrides**, never a quiet edit to the source, which would silently move
every member. An exception displaces the *lineage*, not the row: edit the species fact later
and the exception carries forward onto the successor, visibly marked as written against
something that has since moved.

You do not write overrides in a founding pack — there is nothing yet to except. You write
them later, as proposals, when a script needs one.

---

## 9. Drafting a pack with a Claude session

The empty-show story, concretely. This is the intended use of this document.

1. **Decide your categories first.** Every show has characters. Most have locations. Take
   `world-rules` if your world has physics a scene can be wrong about; take `species` if a
   world rule has to land differently on different bodies; take `house-style` if you want
   drafts checked against how the show sounds. Skip the rest until you want them.
2. **Write the category sheets before any entity sheet.** The relation types are what the
   entity sheets are *allowed* to say — an undeclared type is invalid, so declaring them
   afterwards means rewriting the sheets.
3. **Hand this document and your source material to a Claude session.** A prompt that works:

   > Read the attached canon schema document. It is the complete specification for a format
   > called a canon pack. Then read my source material.
   >
   > Draft a canon pack for my show: `show.md`, one `_category.md` per category, and one
   > entity sheet per entity you find in the source material. Follow the format exactly —
   > it is parsed, and anything outside the vocabularies is refused.
   >
   > Rules for this draft:
   > - Mark **every** entity sheet `status: candidate`. I decide what gets proposed, not you.
   > - Facts must come from my source material. Do not invent one to fill a sheet. If an
   >   entity has nothing checkable yet, say so in the body and give it the one or two facts
   >   the material actually supports.
   > - Where a required relation is not answered by the material, declare it `unknown`.
   >   Never leave it blank and never guess.
   > - Note anything you had to decide, on the sheet, in prose.

4. **Read the sheets.** They are markdown; that is the point. Fix what is wrong here, where a
   wrong sheet costs an edit rather than a ruling.
5. **Decide what to put to a ruling.** On a sheet you are happy with, change
   `status: candidate` to `active`. That is the whole promotion mechanism at this stage: it
   says "propose this one". Leave everything else `candidate`.
6. **Load the pack.** Each active sheet becomes a promotion proposal; each candidate becomes a
   registered identity and nothing else. Nothing is canon yet either way.
7. **Found it**, and rule the stack one sheet at a time. Every sheet you ratify is canon with
   your ruling on it. Every sheet you reject keeps its note, and later writing runs read it. A
   sheet you left a candidate stays a draft until the day an episode needs it, and promoting
   it then raises a proposal from that same sheet.

Step 7 is the product. Everything before it is a draft, and this document exists so a draft
arrives in a shape you can rule on rather than a shape you have to retype.

---

## 10. This document's version

**Canon schema version 1.**

The version describes **the format the reader accepts** — the four sheet rules, the required
sections, the relation-type grammar, and the vocabularies in [§6](#6-the-vocabularies).
It does not describe the app's database schema, which changes by migration underneath a
stable pack format and has its own numbering.

**What a version bump means.** The version rises when a pack written against the previous
version would no longer be read the same way: a new required section, a changed separator, a
value removed from a vocabulary, a relation-type part becoming mandatory. It does not rise
for a clarification, a better example, or a value **added** to a vocabulary, since a pack
that does not use the new value is unaffected.

**What a bump means for existing shows.** Nothing automatic, and that is the point of
[§7.3](#73-after-founding-the-pack-is-provenance): once a show is founded, its canon lives in
the database, and the pack that founded it is provenance. A version bump therefore never
migrates anybody's canon. It changes what a *new* pack must look like, and it means an old
pack re-read by a new reader may be refused — which is a refusal at load time, naming the
file, and never a silent misreading.

**Where the version is asserted.** `app/server/fixture/schema-doc.test.ts` reads this file
and checks four things, so it cannot quietly diverge from the parser it documents:

1. Every example quoted here is byte-for-byte identical to its file in
   `docs/canon-schema-example/`.
2. Every file in `docs/canon-schema-example/` is quoted here — no example may exist
   unreferenced, and none may be referenced without existing.
3. The whole example pack round-trips through `read.ts`, with the values this document says
   it has, and then loads and founds through the real proposal flow.
4. Every vocabulary in [§6](#6-the-vocabularies) equals the app's own definition of it, and
   the version stated here is the version that test pins.

Changing a vocabulary in the code fails that test. Fixing the test means editing this
document, which is where the version number is, which is the point.

---

## What this document does not cover

- **Arc sheets and episode sheets.** A show's spine — arcs with waypoints and landing
  criteria, episodes with their lifecycle, artifacts and arc positions — is not part of a
  founding pack, because it is not something a drafting session should invent. The formats
  are real and the worked example is `fixtures/greyharbor/arc/` and
  `fixtures/greyharbor/episode/`.
- **The database schema.** Tables, columns and migrations live in `app/server/db/`, and the
  reasoning for each lives in the migration that made it.
- **Checks.** What a check does with your facts, how findings are anchored and how
  confidence is reported is the check system's business; your `## Check instructions` are
  the input to it.
- **Importing an existing show.** Same pipeline pointed at an old repository, plus the one
  hard part this document does not solve: deciding what in a second load is a *change* to
  something already ratified rather than a new sheet. That is a diffing loader, and it is
  deliberately not smuggled in as "idempotency".
