# /// script
# dependencies = []
# ///
"""canon-ledger: write the canon reviewer's deliberate deviations to the episode's ledger.
Spec §2.2: an agent adheres to canon; the showrunner overrides it; the ledger records the
overrides. The reviewer reads only, so it returns the rows in its verdict and this step writes
them — to Episodes/<episode>/canon-ledger.md, creating the file with its header when there is a
first row to write. A row whose Where and The-deviation cells already appear is not written again,
so a review that re-runs after a gate rejection does not duplicate the ledger. Disposition is
PENDING; the canon librarian marks rows ACCEPTED at the end-of-episode canon moment, and a
canon-gate rejection may mark one WITHDRAWN.
Prints LEDGER_OK <new> new rows, <total> total.
Usage: canon-ledger.py <episode> --pass <outline|script> --run <runId> --rows <json-array> [--show-root <path>]"""
import json, os, re, sys
from lib import showconfig as sc

FIELDS = ("where", "deviation", "canon", "provenance", "evidence")
HEADER = """# Canon ledger — {ep}

> Deliberate deviations from the canon store, recorded by the canon reviewer because their
> provenance is the showrunner's, not an agent's. Consumed at the end-of-episode canon moment:
> each ACCEPTED row becomes an AS SHIPPED canon change; each WITHDRAWN row is dropped.

| # | Where | The deviation | Canon it departs from | Provenance | Evidence | Disposition |
|---|---|---|---|---|---|---|
"""


def option(argv: list[str], name: str) -> str:
    if name not in argv or argv.index(name) + 1 >= len(argv):
        sys.exit(f"canon-ledger: {name} <value> is required")
    return argv[argv.index(name) + 1]


def cell(text: str) -> str:
    return " ".join(str(text).split()).replace("|", "\\|")


def existing_rows(text: str) -> list[tuple[str, str]]:
    rows = []
    for line in text.splitlines():
        m = re.match(r"^\| (\d+) \| (.*?) \| (.*?) \| ", line)
        if m:
            rows.append((m.group(2), m.group(3)))
    return rows


def main() -> None:
    root = os.path.abspath(sc.show_root(sys.argv))
    cfg = sc.load(root)
    os.chdir(root)
    ep = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else ""
    if not ep:
        sys.exit("canon-ledger: episode id missing (usage: canon-ledger.py <episode> --pass <outline|script> --run <runId> --rows <json>)")
    which = option(sys.argv, "--pass")
    if which not in ("outline", "script"):
        sys.exit("canon-ledger: --pass must be outline or script")
    run_id = option(sys.argv, "--run")
    try:
        rows = json.loads(option(sys.argv, "--rows"))
    except json.JSONDecodeError as err:
        sys.exit(f"canon-ledger: --rows is not JSON: {err}")
    if not isinstance(rows, list) or any(not isinstance(r, dict) or any(f not in r for f in FIELDS) for r in rows):
        sys.exit(f"canon-ledger: every row must be an object with {', '.join(FIELDS)}")

    episodes_dir = str(sc.value(cfg, "episodesDir", default="Episodes"))
    path = os.path.join(episodes_dir, ep, "canon-ledger.md")
    text = open(path, encoding="utf-8").read() if os.path.exists(path) else ""
    seen = existing_rows(text)
    new = [r for r in rows if (cell(r["where"]), cell(r["deviation"])) not in seen]
    if new:
        if not text:
            text = HEADER.format(ep=ep)
        n = len(seen)
        for r in new:
            n += 1
            evidence = f"{cell(r['evidence'])} ({which} pass, run {run_id})"
            text = text.rstrip("\n") + f"\n| {n} | {cell(r['where'])} | {cell(r['deviation'])} | {cell(r['canon'])} | {cell(r['provenance'])} | {evidence} | PENDING |"
        os.makedirs(os.path.dirname(path), exist_ok=True)
        open(path, "w", encoding="utf-8").write(text + "\n")
    print(f"LEDGER_OK {len(new)} new rows, {len(seen) + len(new)} total")


if __name__ == "__main__":
    try:
        main()
    except (sc.ShowConfigError, FileNotFoundError) as err:
        sys.exit(f"canon-ledger: {err}")
