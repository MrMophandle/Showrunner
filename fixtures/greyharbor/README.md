# Grey Harbor — the fixture show

A synthetic mini-show: one season, two episodes, six canon entities across five
categories, one arc, and two defects planted in a script on purpose.

It is not test data. It is two things:

- **The worked example.** Starting an empty show (3.5) means copying this
  directory, renaming it, and editing. Every shape in here is complete for that
  reason — the shapes you copy are the shapes you keep.
- **The show the later epics are written against.** E3's checks fire on the
  planted defects. E4 writes into this season. E5 renders these screens. A shape
  that is wrong here gets copied, not corrected.

```bash
npm run fixture:load                 # seeds ./library (or $LIBRARY_DIR)
npm run fixture:load -- /some/where  # seeds that volume instead
```

Run it twice. The second run walks the whole fixture, finds everything already
there, and writes nothing — that is what idempotent means here. It is not a
guard: delete an episode from the library, run it again, and the episode comes
back.

## What is in here

```
show.md                    the show, its season, and what the fixture is for
canon/<category>/
  _category.md             fields, applicable artifact kinds, check instructions,
                           and the relation types this category allows (D23)
  <entity>.md              one entity: identity, relations, prose body, facts
arc/<arc>.md               statement, and waypoints with landing criteria (D24)
episode/<nn>-<slug>/
  episode.md               number, lifecycle, arc position, artifacts, and — for
                           episode 1 — what is planted in the script and why
  premise.md               \
  outline.md                > the artifacts, hand-written, never generated
  script.md                /
```

| | |
|---|---|
| **Show** | Grey Harbor (`greyharbor`) — a working station on a shipping lane that stopped carrying ships |
| **Season 1** | Slack Water |
| **s01e01** | *The Long Pier* — mid-script: premise, outline, script at draft 1, six scenes, on the arc at waypoint 2 |
| **s01e02** | *Dry Stores* — un-started: a number and a title, no artifacts, **vanilla** (touches no arc) |
| **Characters** | Ilse Renn, Tobin Wick — both declare `species: Halvani` (D22) |
| **The rest** | Grey Harbor Station (location), Halvani (species), Kestrel-pattern containment collar (technology), The hull and the void (world rules) |
| **Arc** | *What the harbor is for* — season scope, character kind, three waypoints |

## The sheet format

Four rules, because these files are copied by hand far more often than they are
parsed:

```markdown
# Title                     the entity's name, the arc's name, the scene's heading
> blurb                     a line or two of what this is, under the title or a heading
## Section                  everything until the next `## `; `### ` stays inside as prose
- key: value                a field, split at the FIRST colon
  wrapped like this         two spaces of indent continues the line above
```

No YAML front matter and no JSON sidecar: front matter puts half the sheet in a
second language with its own quoting rules, and a sidecar lets prose and data
drift apart in two files nobody diffs together. `app/server/fixture/sheet.ts`
parses it; `read.ts` says what the shapes must contain and refuses the rest.

## The two planted defects

Both are in `episode/01-the-long-pier/script.md`, and **that file says nothing
about either of them** — a script that announced its own bugs would test a
checker's reading of a hint rather than of a script. The full write-up, including
which check should fire and what it should *not* report, is in
`episode/01-the-long-pier/episode.md`.

In short:

1. **World rules, scene 4.** Tobin Wick works the relay housing at the head of
   the Long Pier in his coveralls for three minutes. It takes four entities in
   scope to make that a violation rather than an oddity: the rule (outside the
   hull is vacuum unless a hardsuit or an active field is in the way), the
   location (the Long Pier is outside the pressure hull), the species (a Halvani
   dies in vacuum inside two minutes — in scope only because Tobin declares
   `species: Halvani`), and the technology (all four collars are still on the
   rack). Delete the species line and the scene stops being checkable, which is
   the argument for D22 in one move.
2. **Continuity, scenes 5 and 6.** Ilse is in the harbourmaster's office at
   07:20 and at the head of the Long Pier in the scene marked CONTINUOUS. Dual
   presence — the deterministic kind (3.2b), caught by counting rows on the
   continuity board with no model involved.

Rules 2 and 3 of *The hull and the void* are obeyed everywhere in the script, on
purpose. A run that reports them is crying wolf, and this fixture is where that
can be measured.

## The rules this fixture is held to

- **Nothing generates.** No LLM call, no image, no TTS, in the fixture or its
  loader. The script was typed by hand and lives in the repository. Fixtures
  before features exists so tests never spend money.
- **Identities only.** `fixture:load` calls `registerEntity` and stops there.
  The facts, relations, standings and prose on these sheets are drafts; they
  become canon when a proposal is ratified at a gate, and by no other route
  (invariant 1). E2 grows the loader into that flow. **Nothing here may become a
  bulk insert into a canon table**, however convenient it would be for E7's Dead
  Light import.
- **One path into the database.** The loader uses the same typed domain
  functions the app does. There are no hand-written INSERTs in it and there must
  not be — a loader with its own SQL is the one that never gets updated.
- **A hand-made asset always wins** (D20). Artifact files are written only when
  absent. Edit `script.md` in the library and re-run the load: it reports the
  file as differing and leaves it alone.
- **Entity names are unique per show.** They are how sheets point at each other,
  so a duplicate is a load-time error rather than a coin toss.
- **Scenes are derived** (D3). There is no scene list in `episode.md` and no
  scene count anywhere: `fixture:load` reads the headings out of the script.

## Using it from a test

Tests that need a show *with canon in it* load the fixture:

```ts
const paths = initLibrary(mkdtempSync(join(tmpdir(), 'showrunner-')))
const store = openLibraryStore(paths)
const report = loadFixture(store, paths)
```

Tests that need only somewhere to hang a run, a cost row or an event on do not —
`createShow` / `createSeason` / `createEpisode` is three lines and keeps the test
about the thing it is testing. Loading a canon library to prove a lock is held is
how a unit test turns into a fixture test.

## Copying it for a real show

1. Copy the directory, rename it, and change `key` and `title` in `show.md`.
2. Keep the categories you want; delete the rest. Adding one is a directory and
   a `_category.md`, not engineering (3.2).
3. Edit each `_category.md`'s relation types **before** writing entities — an
   undeclared relation type is invalid (D23), so the declarations are what the
   sheets are allowed to say.
4. Write the entities. Every character needs a `species`, pointing at a species
   entity or at the literal word `unknown` (D22). Never blank.
5. Write the arc statement first and the waypoints after it. If you cannot write
   what landing a waypoint looks like on screen, the waypoint is not a waypoint
   yet (D24).
6. Delete the planted defects. They are ours, not yours.
