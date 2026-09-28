"""The collective-populator guard: does an image brief invent uncredited characters?

A character brief that says "the crew" or "a few figures" makes an image model draw people
nobody named -- wrong headcount, and once a real-world flag patch on an invented figure. The show
states the law in its own visual-style document; this module is the mechanical reading of it.

**The show supplies the vocabulary; this module supplies the grammar.** The banned phrases are a
parameter (`visual.collectivePopulatorBans` in the show's showrunner.json) because "the crew" is
this show's cast language. The two escape grammars below are NOT config: a headcount prefix and
the capping idiom are facts about English, and a show cannot sensibly redefine them.

Two callers import this module: `nano-banana-generate.py`, which refuses to spend on a dirty brief
before any API call, and `populator-check.py`, which is the same refusal run on its own as a
pipeline step ahead of the image branch.
"""

from __future__ import annotations

import re
from typing import Sequence

# "both" is a definite headcount of two and belongs here: ep10's s03/s09 briefs said "rim
# separation on both figures" with both people named and in refs, and the guard refused to spend
# on it.
_COUNT_WORD = r"(?:\d+|one|two|three|four|five|six|both|exactly)"

# The capping idiom is not always "no figures" -- it is usually "no OTHER figures in the frame",
# which is the strongest possible statement of the very rule this guard enforces. Allow one
# qualifier between.
_NO_ESCAPE = r"\bno\s+(?:other|more|additional|further\s+)?\s*$"

# Bare nouns (and "crew members") only violate the law when NOT preceded by an explicit headcount
# -- "three people:", "six crew members" name a fixed cast size and are exactly what the law
# wants. Checked separately from the show's banned phrases so that headcount-qualified uses of
# "people"/"figures" pass. These three are generic English rather than any one show's vocabulary,
# so they stay in code beside the grammars that qualify them.
_QUALIFIABLE_WORDS = ("crew members", "people", "figures")


def find_collective_populators(brief: str, phrases: Sequence[str]) -> list[str]:
    """-> the offending substrings of `brief`, verbatim and in their original case.

    An empty list means the brief is clean. `phrases` is the show's banned-phrase list
    (`visual.collectivePopulatorBans`); it is matched case-insensitively as a substring, and a
    match directly preceded by "no " (the house-style capping idiom, which NEGATES extras rather
    than inventing them) is not a violation.
    """
    hits: list[str] = []
    covered: list[tuple[int, int]] = []

    def _overlaps(a: tuple[int, int], b: tuple[int, int]) -> bool:
        return not (a[1] <= b[0] or b[1] <= a[0])

    for phrase in phrases:
        for m in re.finditer(re.escape(phrase), brief, re.IGNORECASE):
            covered.append((m.start(), m.end()))
            prefix = brief[:m.start()]
            if re.search(_NO_ESCAPE, prefix, re.IGNORECASE):
                continue                      # "no other figures..." -- the capping idiom
            hits.append(brief[m.start():m.end()])

    for phrase in _QUALIFIABLE_WORDS:
        for m in re.finditer(re.escape(phrase), brief, re.IGNORECASE):
            span = (m.start(), m.end())
            if any(_overlaps(span, c) for c in covered):
                continue                      # already judged above (e.g. "the crew members")
            prefix = brief[:m.start()]
            if re.search(rf"\b{_COUNT_WORD}\s*$", prefix, re.IGNORECASE):
                continue                      # "three people:", "six crew members"
            if re.search(_NO_ESCAPE, prefix, re.IGNORECASE):
                continue                      # "no ... figures"
            hits.append(brief[m.start():m.end()])

    return hits


def violations(shots: Sequence[dict], phrases: Sequence[str]) -> list[tuple[str, list[str]]]:
    """-> [(shot id, matched phrases)] for every shot whose brief breaks the law.

    An empty list means every brief is clean. Shots are read as the image prompt file writes
    them: a dict with "id" and "brief".
    """
    found = [(str(s.get("id", "?")), find_collective_populators(str(s.get("brief", "")), phrases))
             for s in shots]
    return [(sid, hits) for sid, hits in found if hits]


def report_lines(found: Sequence[tuple[str, list[str]]]) -> list[str]:
    """One line per offending shot, naming the shot id and the phrases it matched."""
    return [f"  {sid}: matched {', '.join(sorted(set(hits)))}" for sid, hits in found]
