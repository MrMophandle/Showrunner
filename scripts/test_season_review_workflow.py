"""The Season Desk workflow's setup node — the guard that keeps a validated
season id from running five agents against the WRONG season's files.

`deadlight-season-review.yaml`'s body is hardcoded to season 1: every craft
lens reads `Canon/season-1.md`, the apply node edits it, and the commit node
`git add`s it. The setup node validates `sN` shape + `Canon/season-N.md`
existence, which is necessary but NOT sufficient — without the third check
these tests pin, `s2` would validate and then convene season 1 while the
report is titled a season-2 review, and commit the result. That is the one
place the console can cause a wrong write to `Canon/`.

The node's bash is extracted from the YAML and run for real (no yaml parser
dependency — the repo's python tests run under a bare `uv run --with pytest`),
so these assert what Archon actually executes, not a paraphrase of it.
"""

import os
import re
import subprocess
import textwrap

HERE = os.path.dirname(os.path.abspath(__file__))
WORKFLOW = os.path.join(HERE, "..", "workflows", "deadlight-season-review.yaml")

SETUP_RE = re.compile(r"^  - id: setup\n    bash: \|\n(.*?)^    timeout:", re.S | re.M)


def _workflow_text():
    with open(WORKFLOW, encoding="utf-8") as fh:
        return fh.read()


def _setup_script():
    m = SETUP_RE.search(_workflow_text())
    assert m, "could not find the setup node's bash block in deadlight-season-review.yaml"
    return textwrap.dedent(m.group(1))


def _run_setup(root, arguments):
    env = dict(os.environ)
    env["ARGUMENTS"] = arguments
    return subprocess.run(
        ["bash", "-c", _setup_script()],
        cwd=str(root), env=env, capture_output=True, text=True, timeout=30)


def _mk_repo(tmp_path, seasons=(1,)):
    (tmp_path / "Canon").mkdir()
    for n in seasons:
        (tmp_path / f"Canon/season-{n}.md").write_text(f"# Season {n}\n")
    return tmp_path


def test_setup_accepts_s1_and_emits_it(tmp_path):
    root = _mk_repo(tmp_path, seasons=(1,))
    result = _run_setup(root, "s1")
    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout == "s1"


def test_setup_refuses_a_malformed_season_id(tmp_path):
    root = _mk_repo(tmp_path, seasons=(1,))
    result = _run_setup(root, "season two")
    assert result.returncode == 1
    assert "must look like" in result.stdout


def test_setup_refuses_a_season_with_no_canon_file(tmp_path):
    root = _mk_repo(tmp_path, seasons=(1,))
    result = _run_setup(root, "s3")
    assert result.returncode == 1
    assert "Canon/season-3.md not found" in result.stdout


def test_setup_refuses_s2_even_when_canon_season_2_exists(tmp_path):
    """The finding: shape + existence both pass for s2 once Canon/season-2.md
    is on disk, and the body would then convene season 1 under a season-2
    heading and commit it. The refusal must fire on the season id itself."""
    root = _mk_repo(tmp_path, seasons=(1, 2))
    result = _run_setup(root, "s2")
    assert result.returncode == 1
    assert "still reads and commits season 1's files" in result.stdout
    assert "Canon/season-1.md" in result.stdout
    # The user-facing sentence must say what unblocks it, not just refuse.
    assert "Parameterize the body" in result.stdout


def test_guard_matches_the_body_it_protects(tmp_path):
    """Drift guard. The refusal above is only honest while the body really is
    hardcoded to season 1. If a later change parameterizes the lens prompts /
    apply / commit nodes, this test fails on purpose — that is the signal to
    widen (or delete) the s1-only guard rather than leave it refusing a season
    the workflow could by then actually convene."""
    text = _workflow_text()
    body = text[text.index("  - id: season-status"):]
    assert "Canon/season-1.md" in body, (
        "the season-review body no longer names Canon/season-1.md — if it is now "
        "parameterized, revisit the s1-only refusal in the setup node")
