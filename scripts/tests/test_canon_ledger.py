import json, subprocess, sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "canon-ledger.py"

def make_show(tmp_path: Path) -> Path:
    root = tmp_path / "show"
    (root / "Episodes" / "s02e01").mkdir(parents=True)
    (root / "showrunner.json").write_text(json.dumps({
        "showName": "Harbor Light", "showSlug": "HarborLight", "promptsDir": "prompts",
        "models": {"medium": "m", "large": "l", "writer": "w"}, "airMap": {}, "output": {"nasRoot": "/nas"}}))
    return root

ROWS = [{"where": "outline.md beat 7", "deviation": "the crew is four, not six", "canon": "Canon/characters/Vale/vale.md:18", "provenance": "premise", "evidence": "Episodes/s02e01/premise.md"}]

def run(root: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(SCRIPT), *args], cwd=root, capture_output=True, text=True)

def test_creates_the_ledger_with_the_header_and_pending_rows(tmp_path):
    root = make_show(tmp_path)
    r = run(root, "s02e01", "--pass", "outline", "--run", "r1", "--rows", json.dumps(ROWS))
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip().splitlines()[-1] == "LEDGER_OK 1 new rows, 1 total"
    text = (root / "Episodes" / "s02e01" / "canon-ledger.md").read_text()
    assert text.startswith("# Canon ledger — s02e01\n")
    assert "| # | Where | The deviation | Canon it departs from | Provenance | Evidence | Disposition |" in text
    assert "| 1 | outline.md beat 7 | the crew is four, not six | Canon/characters/Vale/vale.md:18 | premise | Episodes/s02e01/premise.md (outline pass, run r1) | PENDING |" in text

def test_is_idempotent_and_numbers_new_rows_after_existing_ones(tmp_path):
    root = make_show(tmp_path)
    run(root, "s02e01", "--pass", "outline", "--run", "r1", "--rows", json.dumps(ROWS))
    again = run(root, "s02e01", "--pass", "script", "--run", "r1", "--rows", json.dumps(ROWS + [{**ROWS[0], "where": "script.md SCENE TWO"}]))
    assert again.stdout.strip().splitlines()[-1] == "LEDGER_OK 1 new rows, 2 total"
    text = (root / "Episodes" / "s02e01" / "canon-ledger.md").read_text()
    assert text.count("| PENDING |") == 2
    assert "| 2 | script.md SCENE TWO |" in text

def test_zero_rows_writes_nothing(tmp_path):
    root = make_show(tmp_path)
    r = run(root, "s02e01", "--pass", "outline", "--run", "r1", "--rows", "[]")
    assert r.returncode == 0
    assert r.stdout.strip().splitlines()[-1] == "LEDGER_OK 0 new rows, 0 total"
    assert not (root / "Episodes" / "s02e01" / "canon-ledger.md").exists()

def test_refuses_malformed_rows(tmp_path):
    root = make_show(tmp_path)
    assert run(root, "s02e01", "--pass", "outline", "--run", "r1", "--rows", "not json").returncode != 0
    assert run(root, "s02e01", "--pass", "outline", "--run", "r1", "--rows", json.dumps([{"where": "x"}])).returncode != 0


# ── beyond the brief: the key, the pass, and the cells ───────────────────────────────────────

def test_the_same_deviation_from_a_later_run_is_not_appended_again(tmp_path):
    """The idempotency key is (Where, The deviation) after cell() normalisation, and Evidence is
    deliberately outside it: the Evidence cell carries "(<pass> pass, run <runId>)", so a key that
    included it would never match across the outline pass and the script pass, or across the
    re-run a canon-gate rejection causes, and one deviation would reach the end-of-episode canon
    moment as two PENDING rows."""
    root = make_show(tmp_path)
    run(root, "s02e01", "--pass", "outline", "--run", "r1", "--rows", json.dumps(ROWS))
    later = run(root, "s02e01", "--pass", "script", "--run", "r9",
                "--rows", json.dumps([{**ROWS[0], "evidence": "Episodes/s02e01/script.md"}]))
    assert later.stdout.strip().splitlines()[-1] == "LEDGER_OK 0 new rows, 1 total"
    text = (root / "Episodes" / "s02e01" / "canon-ledger.md").read_text()
    assert text.count("| PENDING |") == 1
    assert "run r9" not in text

def test_a_pipe_in_a_cell_does_not_break_the_table(tmp_path):
    """A reviewer quoting a line that holds a pipe would otherwise split one row into two
    columns, and existing_rows would read the wrong text back as the key."""
    root = make_show(tmp_path)
    rows = [{**ROWS[0], "deviation": "the log reads a | b, not a / b"}]
    r = run(root, "s02e01", "--pass", "outline", "--run", "r1", "--rows", json.dumps(rows))
    assert r.returncode == 0, r.stderr
    text = (root / "Episodes" / "s02e01" / "canon-ledger.md").read_text()
    assert r"the log reads a \| b, not a / b" in text
    row = [l for l in text.splitlines() if l.startswith("| 1 |")][0]
    assert row.count("|") - row.count(r"\|") == 8          # seven columns, eight unescaped bars
    again = run(root, "s02e01", "--pass", "script", "--run", "r2", "--rows", json.dumps(rows))
    assert again.stdout.strip().splitlines()[-1] == "LEDGER_OK 0 new rows, 1 total"

def test_a_multiline_cell_is_folded_onto_one_line(tmp_path):
    root = make_show(tmp_path)
    rows = [{**ROWS[0], "deviation": "the crew is four,\n  not six"}]
    run(root, "s02e01", "--pass", "outline", "--run", "r1", "--rows", json.dumps(rows))
    text = (root / "Episodes" / "s02e01" / "canon-ledger.md").read_text()
    assert "| 1 | outline.md beat 7 | the crew is four, not six |" in text

def test_an_unknown_pass_is_refused(tmp_path):
    root = make_show(tmp_path)
    r = run(root, "s02e01", "--pass", "beats", "--run", "r1", "--rows", json.dumps(ROWS))
    assert r.returncode != 0
    assert "outline or script" in r.stderr

def test_a_missing_episode_id_or_option_is_one_line_on_stderr(tmp_path):
    root = make_show(tmp_path)
    for args in (("--pass", "outline", "--run", "r1", "--rows", "[]"),
                 ("s02e01", "--run", "r1", "--rows", "[]"),
                 ("s02e01", "--pass", "outline", "--rows", "[]"),
                 ("s02e01", "--pass", "outline", "--run", "r1")):
        r = run(root, *args)
        assert r.returncode != 0, args
        assert len(r.stderr.strip().splitlines()) == 1, args
        assert r.stderr.startswith("canon-ledger: "), args

def test_the_show_root_flag_works_from_elsewhere(tmp_path):
    root = make_show(tmp_path)
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    r = subprocess.run([sys.executable, str(SCRIPT), "s02e01", f"--show-root={root}",
                        "--pass", "outline", "--run", "r1", "--rows", json.dumps(ROWS)],
                       cwd=elsewhere, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip().splitlines()[-1] == "LEDGER_OK 1 new rows, 1 total"
    assert (root / "Episodes" / "s02e01" / "canon-ledger.md").exists()

def test_the_episodes_directory_is_the_shows(tmp_path):
    """`episodesDir` is a show setting; the ledger is written where the show keeps its episodes."""
    root = make_show(tmp_path)
    cfg = json.loads((root / "showrunner.json").read_text())
    cfg["episodesDir"] = "Scripts"
    (root / "showrunner.json").write_text(json.dumps(cfg))
    r = run(root, "s02e01", "--pass", "outline", "--run", "r1", "--rows", json.dumps(ROWS))
    assert r.returncode == 0, r.stderr
    assert (root / "Scripts" / "s02e01" / "canon-ledger.md").exists()
