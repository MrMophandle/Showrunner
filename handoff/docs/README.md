# Showrunner — the design documents

Start here if you're about to write an epic's issue file, or you need to know what
was ruled and why.

## What's authoritative

| Document | What it is | Authority |
|---|---|---|
| `concept-and-architecture.md` | The ruled design: domain, orchestration, canon, checks, screens, build plan. Decisions **D1–D19** in-section, **D20–D24** in the addendum at the end. | **The source of truth.** Nothing overrides it except a later ruling from Ryan. |
| `D20-image-backends.md` | The image-generation carry-forward from the Dead Light console, in detail — backends, routing, lock semantics, and the operational rules that made it work. | Expands D20. Read before writing E6. |
| `E1-spine-issues.md` | The E1 issue file, as originally drafted. | **Superseded** — the GitHub issues are authoritative (see below). |
| `../CLAUDE.md` | The distilled standing brief, pre-dating E1-0. | Draft. E1-0 (issue #1) writes the real one at repo root. |
| `../../mockups/` | Eight approved screen mockups + their README. | Approved. E5 builds to them. |

**Rulings after the export live in the addendum**, not in the sections they amend.
The sections carry `→ Amended by D…` pointers where a ruling changed them — follow
them. As of Aug 4 2026 the addendum holds:

- **D20** image generation: three backends routed per shot; `gpu` covers local image
  gen *and* TTS; hand-made assets always win; retries bounded at 2.
- **D21** review-desk reject is routed, not rewound.
- **D22** every character declares a species (required typed relation).
- **D23** relation types are declared per category, with inverses.
- **D24** arcs get their own page — the screen set is eight, not seven.

## Where the issues live

GitHub Issues on `MrMophandle/Showrunner`, one milestone per epic (D18).
**E1 · The spine** is filed as issues #1–#9 and is the worked example of the format.

The GitHub issues are authoritative over `E1-spine-issues.md`: six of the nine were
amended on Aug 4 2026 to absorb D20–D24 (see each issue's body). If you need the E1
format as a template, read the live issues, not the file.

## Writing an epic's issue file

Per 6.3, issue files are written **epic-by-epic, just before the epic starts** —
not all up front. When it's E2's turn:

1. **Read the whole concept doc, addendum included.** Then re-read the sections that
   epic owns (E2 → Section 3; E3 → Section 4; E4 → 1.1 + 4; E5 → Section 5 + the
   mockups; E6 → Section 5.5/5.6 + `D20-image-backends.md`).
2. **Check §6.2 for that epic's `→ Scope grew` note.** E2, E5, and E6 all gained
   scope after the original export.
3. **Check what E1 reserved but didn't build.** E1-2 (issue #3) reserves table names
   for facts, proposals, relations, and relation-type declarations — E2 fills them,
   and should not need to alter E1's tables.
4. **Write one issue per Opus session** (6.1). Every issue carries three parts:
   - **Context to load** — the exact sections and prior artifacts, so the session
     doesn't have to hunt.
   - **Deliverable** — what exists when it's done, concretely.
   - **Done** — a *machine-checkable* condition. "Tests pass" is not one; "a planted
     contradiction produces an anchored finding whose rewrite remediation fixes it" is.
5. **Sequence the issues** and state the dependencies at the end of the file, as E1 does.
6. **State the epic exit** at the top: the thing *Ryan operates*, not reads about.
   Ryan gates epics, not issues (6.1).

## Working agreements that bind every session

- One issue, one session. Leave the repo green; if unfinished, write `HANDOFF.md`.
- **Fixtures before features** — the Grey Harbor fixture backs all tests. Never burn
  real generation money in a test.
- **The Archon rule** — no workflow DSL, no configurable workflow engine. Stages are
  TypeScript. If you're building a generic workflow system, stop.
- **Only ratification writes canon.** Everything else proposes.
