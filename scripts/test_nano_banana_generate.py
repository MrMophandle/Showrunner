import importlib.util, json, os, time

def _load(name="nano-banana-generate"):
    here = os.path.dirname(os.path.abspath(__file__))
    spec = importlib.util.spec_from_file_location(
        name.replace("-", "_"), os.path.join(here, f"{name}.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)          # safe: script guards main()
    return mod

nbg = _load()

def test_normalize_key():
    assert nbg.normalize_key("Trent") == "trent"
    assert nbg.normalize_key("relic (style-token, at CANON shard scale)") == "relic"
    assert nbg.normalize_key("  Ansa ") == "ansa"

def _mk_bible(tmp_path):
    (tmp_path / "Canon/characters/Trent").mkdir(parents=True)
    sheet = tmp_path / "Canon/characters/Trent/Trent Reference.png"
    sheet.write_bytes(b"png")
    old = tmp_path / "Canon/characters/Trent/ep03-a.png"; old.write_bytes(b"a")
    mid = tmp_path / "Canon/characters/Trent/ep04-b.png"; mid.write_bytes(b"b")
    new = tmp_path / "Canon/characters/Trent/ep04-c.png"; new.write_bytes(b"c")
    now = time.time()
    os.utime(old, (now - 300, now - 300)); os.utime(mid, (now - 200, now - 200))
    os.utime(new, (now - 100, now - 100))
    bible = {"trent": {"identity": "Trent, ~28, fresh-faced", "kind": "human",
                       "ref": str(sheet)}}
    return bible

def test_assemble_refs_sheet_plus_two_newest(tmp_path):
    bible = _mk_bible(tmp_path)
    shot = {"id": "s1-x", "refs": ["Trent"], "brief": "b"}
    imgs, ids, missing = nbg.assemble_refs(shot, bible)
    assert missing == []
    assert imgs[0].endswith("Trent Reference.png")          # sheet first
    assert [os.path.basename(p) for p in imgs[1:]] == ["ep04-c.png", "ep04-b.png"]
    assert ids == ["TRENT (must match the attached reference images): Trent, ~28, fresh-faced"]

def test_assemble_refs_missing_key_flags_and_continues(tmp_path):
    bible = _mk_bible(tmp_path)
    shot = {"id": "s1-x", "refs": ["Trent", "mardo"], "brief": "b"}
    imgs, ids, missing = nbg.assemble_refs(shot, bible)
    assert missing == ["mardo"] and len(imgs) == 3

def test_assemble_refs_caps_at_8_dropping_stills_not_sheets(tmp_path):
    bible = {}
    for i in range(4):                    # 4 subjects × (1 sheet + 2 stills) = 12
        d = tmp_path / f"Canon/characters/C{i}"; d.mkdir(parents=True)
        s = d / f"C{i} Reference.png"; s.write_bytes(b"s")
        # Basenames unique per subject (real casting piles never share a
        # filename across different characters' folders) — the I3 fix dedupes
        # stills by basename, so identical names here would collide and this
        # test would stop exercising the cap logic it's actually for.
        (d / f"ep03-p{i}.png").write_bytes(b"p"); (d / f"ep04-q{i}.png").write_bytes(b"q")
        bible[f"c{i}"] = {"identity": f"c{i}", "kind": "human", "ref": str(s)}
    shot = {"id": "s1-x", "refs": [f"c{i}" for i in range(4)], "brief": "b"}
    imgs, ids, missing = nbg.assemble_refs(shot, bible)
    assert len(imgs) == 8
    sheets = [p for p in imgs if "Reference" in p]
    assert len(sheets) == 4               # all sheets survive; stills dropped

def test_compose_prompt_layers():
    shot = {"id": "s1-x", "brief": "OPHA gone completely still.", "refs": ["opha"]}
    p = nbg.compose_prompt(shot, ["OPHA (must match…): a dog-sized grub"], notes="too large")
    assert p.index("OPHA (must match") < p.index("OPHA gone completely still.")
    assert "low-key but clearly exposed" in p and "no text, no watermark" in p
    assert p.rstrip().endswith("PREVIOUS ATTEMPT REJECTED: too large. Fix exactly this.")
    # ep04 pilot: "Cinematic 16:9 frame" made the model PAINT letterbox bars in.
    # The ratio comes from response_format.aspect_ratio, not from prose.
    assert "Cinematic 16:9 frame" not in p, "the phrase that caused baked-in bars is back"
    assert "fills the entire frame edge to edge" in p and "full-bleed" in p

def test_assemble_refs_caps_at_8_with_many_sheets_prints_warning(tmp_path, capsys):
    """Regression test for FINDING 1: >8 sheets must cap at 8, dropping sheets defensively, with warning."""
    bible = {}
    for i in range(9):                    # 9 subjects × 1 sheet = 9 sheets (exceeds cap)
        d = tmp_path / f"Canon/characters/C{i}"; d.mkdir(parents=True)
        s = d / f"C{i} Reference.png"; s.write_bytes(b"s")
        bible[f"c{i}"] = {"identity": f"c{i}", "kind": "human", "ref": str(s)}
    shot = {"id": "s1-shot-id", "refs": [f"c{i}" for i in range(9)], "brief": "b"}
    imgs, ids, missing = nbg.assemble_refs(shot, bible)
    assert len(imgs) == 8, f"Expected 8 images, got {len(imgs)}"
    assert len(ids) == 8, f"Expected 8 identity lines, got {len(ids)}"
    captured = capsys.readouterr()
    assert "WARNING" in captured.out, "Expected warning message in output"
    assert "s1-shot-id" in captured.out, "Expected shot id in warning"

def test_assemble_refs_dedupes_by_normalized_key(tmp_path):
    """Regression test for FINDING 2: duplicate refs by different case should dedupe."""
    bible = _mk_bible(tmp_path)
    shot = {"id": "s1-x", "refs": ["Trent", "trent", "TRENT"], "brief": "b"}
    imgs, ids, missing = nbg.assemble_refs(shot, bible)
    assert missing == []
    # Should have 1 sheet + 2 stills = 3 images, not 3×3 = 9
    assert len(imgs) == 3, f"Expected 3 images (1 sheet + 2 stills), got {len(imgs)}"
    # Should have 1 identity line, not 3
    assert len(ids) == 1, f"Expected 1 identity line, got {len(ids)}"
    assert ids[0] == "TRENT (must match the attached reference images): Trent, ~28, fresh-faced"

def test_assemble_refs_dedupes_stills_by_basename_across_folders(tmp_path):
    """I3 regression: registry-append fans one group shot out into every
    ref'd character's folder, so the SAME still (identical bytes) lives at a
    different path per subject. A future shot ref'ing two of those subjects
    must not let that one photo occupy two reference-image slots — that
    displaces a genuinely distinct still and wastes conditioning budget for
    no benefit."""
    bible = {}
    for name in ("remo", "trent"):
        d = tmp_path / f"Canon/characters/{name.title()}"; d.mkdir(parents=True)
        sheet = d / f"{name.title()} Reference.png"; sheet.write_bytes(b"s")
        # The SAME group shot, fanned out into both folders under the same
        # basename — exactly what registry-append produces.
        (d / "ep04-s04-cabin-tension-crew.png").write_bytes(b"group-shot")
        bible[name] = {"identity": name, "kind": "human", "ref": str(sheet)}
    shot = {"id": "s1-x", "refs": ["remo", "trent"], "brief": "b"}
    imgs, ids, missing = nbg.assemble_refs(shot, bible)
    assert missing == []
    group_shot_hits = [p for p in imgs if os.path.basename(p) == "ep04-s04-cabin-tension-crew.png"]
    assert len(group_shot_hits) == 1, (
        f"the same-named still from two folders survived {len(group_shot_hits)} times, "
        "wasting a reference-image slot on a duplicate")
    # 2 sheets + 1 deduped still = 3 images, not 4.
    assert len(imgs) == 3, f"expected 3 images (2 sheets + 1 deduped still), got {len(imgs)}"


def test_generate_image_writes_png_and_counts(tmp_path, monkeypatch):
    out = tmp_path / "shot.png"
    monkeypatch.setattr(nbg, "_api_call", lambda prompt, imgs: ("ok", b"PNGBYTES"))
    counter = {"calls": 0}
    ret = nbg.generate_image("p", [], str(out), counter)
    assert ret == "ok" and out.read_bytes() == b"PNGBYTES" and counter["calls"] == 1

def test_generate_image_refusal_no_file(tmp_path, monkeypatch):
    out = tmp_path / "shot.png"
    monkeypatch.setattr(nbg, "_api_call", lambda prompt, imgs: ("refused", None))
    assert nbg.generate_image("p", [], str(out), {"calls": 0}) == "refused"
    assert not out.exists()

def test_generate_image_transport_retry_then_ok(tmp_path, monkeypatch):
    calls = {"n": 0}
    slept = []
    def flaky(prompt, imgs):
        calls["n"] += 1
        if calls["n"] < 3: raise ConnectionError("boom")
        return ("ok", b"X")
    monkeypatch.setattr(nbg, "_api_call", flaky)
    monkeypatch.setattr(nbg.time, "sleep", lambda s: slept.append(s))
    assert nbg.generate_image("p", [], str(tmp_path / "s.png"), {"calls": 0}) == "ok"
    # Backoff must be EXPONENTIAL, not constant: 2**0 then 2**1. Asserting the
    # recorded durations (not just the call count) is what rules out a
    # no-backoff or fixed-delay implementation.
    assert slept == [1, 2], f"expected exponential backoff [1, 2], got {slept}"

def test_cost_cap_aborts(monkeypatch, tmp_path):
    monkeypatch.setattr(nbg, "_api_call", lambda prompt, imgs: ("ok", b"X"))
    counter = {"calls": nbg.MAX_CALLS}
    import pytest
    with pytest.raises(SystemExit):
        nbg.generate_image("p", [], str(tmp_path / "s.png"), counter)

def test_error_string_redacts_api_key(tmp_path, monkeypatch):
    """FINDING 1: the returned error string is printed/logged by the orchestrator.
    Some Google transports put the key in a ?key= param, so it can ride along
    inside an exception message. It must never survive into the return value."""
    KEY = "AIzaSy-FAKE-TEST-KEY-do-not-use-0000"
    monkeypatch.setenv("GEMINI_API_KEY", KEY)
    def boom(prompt, imgs):
        raise ConnectionError(f"503 from https://host/v1beta/models?key={KEY}")
    monkeypatch.setattr(nbg, "_api_call", boom)
    monkeypatch.setattr(nbg.time, "sleep", lambda s: None)
    ret = nbg.generate_image("p", [], str(tmp_path / "s.png"), {"calls": 0})
    assert ret.startswith("error:")
    assert KEY not in ret, "API key leaked into the error string"
    assert "<redacted>" in ret

def test_refusal_diagnostic_reports_shape_and_redacts(monkeypatch):
    """FINDING 4: refusal stays TERMINAL (no retry), but must emit a shape
    diagnostic so the first live run can confirm the real safety-block form."""
    KEY = "AIzaSy-FAKE-TEST-KEY-do-not-use-0000"
    monkeypatch.setenv("GEMINI_API_KEY", KEY)
    class FakeInteraction:
        def __init__(self): self.block_reason = f"blocked key={KEY}"
    line = nbg._refusal_diagnostic(FakeInteraction())
    # Shape only: the type and the attribute NAMES, enough to identify the real
    # safety-block form on the first live run.
    assert "FakeInteraction" in line and "block_reason" in line
    # No attribute VALUES are emitted, so a key sitting in the payload can't
    # leak at all — stronger than redacting it after the fact.
    assert KEY not in line and "blocked key" not in line
    # _redact is still applied as a backstop; verify it directly.
    assert nbg._redact(f"boom key={KEY}") == "boom key=<redacted>"

def test_write_is_atomic_no_partial_file_or_temp_left(tmp_path, monkeypatch):
    """FINDING 2: a torn write must not leave a file at out_path — the pipeline
    skips shots whose PNG exists, so a truncated image would look 'done'."""
    out = tmp_path / "shot.png"
    monkeypatch.setattr(nbg, "_api_call", lambda prompt, imgs: ("ok", b"PNGBYTES"))
    monkeypatch.setattr(nbg.time, "sleep", lambda s: None)
    def failing_replace(src, dst): raise OSError("no space left on device")
    monkeypatch.setattr(nbg.os, "replace", failing_replace)
    counter = {"calls": 0}
    ret = nbg.generate_image("p", [], str(out), counter)
    assert ret.startswith("error:")
    assert not out.exists(), "a partial/failed write left a file at out_path"
    assert list(tmp_path.iterdir()) == [], f"temp left behind: {list(tmp_path.iterdir())}"
    # I2 regression: the API call already succeeded when the LOCAL write
    # failed. That must not re-enter the billed retry loop — a local disk
    # failure can't turn out differently on retry, so it must never bill a
    # second or third paid call for zero output.
    assert counter["calls"] == 1, (
        f"a local write failure billed {counter['calls']} paid API calls "
        "instead of stopping after the one that already succeeded")

def test_successful_write_leaves_only_the_png(tmp_path, monkeypatch):
    """FINDING 2, happy path: the temp file must be renamed away, not orphaned."""
    out = tmp_path / "shot.png"
    monkeypatch.setattr(nbg, "_api_call", lambda prompt, imgs: ("ok", b"PNGBYTES"))
    assert nbg.generate_image("p", [], str(out), {"calls": 0}) == "ok"
    assert [p.name for p in tmp_path.iterdir()] == ["shot.png"]

def test_local_ref_failure_does_not_bill_a_call(tmp_path, monkeypatch):
    """FINDING 3: a reference image that vanished between assembly and
    generation fails locally, before any network I/O — it must NOT consume
    budget. Contrast with the transport case below, where each retry is a real
    API call and SHOULD be billed."""
    monkeypatch.setattr(nbg.time, "sleep", lambda s: None)
    counter = {"calls": 0}
    ret = nbg.generate_image("p", [str(tmp_path / "gone.png")],
                             str(tmp_path / "s.png"), counter)
    assert ret.startswith("error:")
    assert counter["calls"] == 0, "a purely local failure burned API budget"

def test_transport_failures_do_bill_each_attempt(tmp_path, monkeypatch):
    """FINDING 3, other side: these attempts really did hit the API, so all
    three count against the 60-call cap."""
    def boom(prompt, imgs): raise ConnectionError("boom")
    monkeypatch.setattr(nbg, "_api_call", boom)
    monkeypatch.setattr(nbg.time, "sleep", lambda s: None)
    counter = {"calls": 0}
    assert nbg.generate_image("p", [], str(tmp_path / "s.png"), counter).startswith("error:")
    assert counter["calls"] == 3

def test_audit_parses_pass(monkeypatch):
    monkeypatch.setattr(nbg, "_audit_call",
        lambda prompt: 'Verdict: {"pass": true, "notes": ""}')
    ok, notes = nbg.audit_image({"id": "x", "brief": "b", "refs": ["trent"]}, "p.png")
    assert ok is True and notes == ""

def test_audit_parses_fail_with_notes(monkeypatch):
    monkeypatch.setattr(nbg, "_audit_call",
        lambda prompt: '{"pass": false, "notes": "three arms on Sable"}')
    ok, notes = nbg.audit_image({"id": "x", "brief": "b", "refs": []}, "p.png")
    assert ok is False and "three arms" in notes

def test_audit_unparseable_is_fail(monkeypatch):
    monkeypatch.setattr(nbg, "_audit_call", lambda prompt: "I looked at it, seems nice")
    ok, notes = nbg.audit_image({"id": "x", "brief": "b", "refs": []}, "p.png")
    assert ok is False and "unparseable" in notes

def test_audit_prompt_contains_laws_and_brief(monkeypatch):
    seen = {}
    def spy(prompt): seen["p"] = prompt; return '{"pass": true, "notes": ""}'
    monkeypatch.setattr(nbg, "_audit_call", spy)
    nbg.audit_image({"id": "x", "brief": "OPHA still in the corner", "refs": ["opha"]},
                    "some/path.png")
    p = seen["p"]
    assert "OPHA still in the corner" in p and "some/path.png" in p
    assert "EXACTLY TWO arms" in p and "watermark" in p.lower() and "thumb" in p

def test_audit_last_match_wins_over_early_agree(monkeypatch):
    """Regression test: when multiple verdicts agree, last-match uses the last."""
    monkeypatch.setattr(nbg, "_audit_call",
        lambda prompt: '{"pass": true, "notes": "early"}\n{"pass": true, "notes": "final"}')
    ok, notes = nbg.audit_image({"id": "x", "brief": "b", "refs": []}, "p.png")
    assert ok is True and notes == "final", "last-match should pick the last verdict's notes"

def test_audit_disagreement_fails_closed(monkeypatch):
    """Regression test: if multiple verdicts disagree on pass/fail, treat as fail."""
    monkeypatch.setattr(nbg, "_audit_call",
        lambda prompt: '{"pass": false, "notes": "first"}\n{"pass": true, "notes": "second"}')
    ok, notes = nbg.audit_image({"id": "x", "brief": "b", "refs": []}, "p.png")
    assert ok is False and "disagree" in notes

def test_audit_timeout_fails_closed(monkeypatch):
    """Regression test: timeout exception must not escape; fail-closed instead."""
    def boom_timeout(prompt):
        import subprocess
        raise subprocess.TimeoutExpired(["claude"], timeout=300)
    monkeypatch.setattr(nbg, "_audit_call", boom_timeout)
    ok, notes = nbg.audit_image({"id": "x", "brief": "b", "refs": []}, "p.png")
    assert ok is False and "timed out" in notes

def test_audit_call_surfaces_stderr_on_broken_invocation(monkeypatch):
    """I5 regression: a structurally broken `claude` invocation (bad auth,
    crashed CLI) prints nothing to stdout. Without capturing stderr, that's
    indistinguishable from a model replying in prose — both fail-closed as
    'unparseable' while 3 paid generations burn per shot with no clue why.
    Mocks nbg.subprocess.run — never invokes the real claude binary."""
    class FakeCompleted:
        stdout = ""
        stderr = "Error: not logged in. Run `claude login` first.\n"
    monkeypatch.setattr(nbg.subprocess, "run", lambda *a, **k: FakeCompleted())
    out = nbg._audit_call("any prompt")
    assert "not logged in" in out, "stderr from a broken invocation must surface"

def test_audit_call_returns_stdout_when_stderr_empty(monkeypatch):
    """I5, other side: a normal successful invocation is untouched — stdout
    passes through as before, with no stderr noise appended."""
    class FakeCompleted:
        stdout = '{"pass": true, "notes": ""}'
        stderr = ""
    monkeypatch.setattr(nbg.subprocess, "run", lambda *a, **k: FakeCompleted())
    out = nbg._audit_call("any prompt")
    assert out == '{"pass": true, "notes": ""}'

def test_audit_missing_binary_fails_closed(monkeypatch):
    """Regression test: missing claude binary must not escape; fail-closed instead."""
    monkeypatch.setattr(nbg, "_audit_call", lambda prompt: (_ for _ in ()).throw(FileNotFoundError("claude not found")))
    ok, notes = nbg.audit_image({"id": "x", "brief": "b", "refs": []}, "p.png")
    assert ok is False and "not found" in notes


def _mk_episode(tmp_path, bible_dirs=True):
    ep = tmp_path / "Production/ep99/images"; ep.mkdir(parents=True)
    canon = tmp_path / "Canon/characters/Opha"; canon.mkdir(parents=True)
    sheet = canon / "Opha Reference.png"; sheet.write_bytes(b"s")
    prompts = {"episode": "ep99", "shots": [
        {"id": "s1-amb", "type": "ambient", "prompt": "x", "seed": 1},
        {"id": "s2-opha", "type": "character", "refs": ["opha"], "brief": "OPHA still."},
        {"id": "s3-done", "type": "character", "refs": ["opha"], "brief": "done"},
        {"id": "s4-ghost", "type": "character", "refs": ["nobody"], "brief": "g"}]}
    (ep / "prompts.json").write_text(json.dumps(prompts))
    (ep / "s3-done.png").write_bytes(b"handmade")
    bible = {"opha": {"identity": "dog-sized grub", "kind": "creature",
                      "ref": str(sheet)}}
    return ep, bible

def test_run_states_and_partial(tmp_path, monkeypatch, capsys):
    ep, bible = _mk_episode(tmp_path)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(nbg, "load_bible", lambda path="x": bible)
    monkeypatch.setattr(nbg, "generate_image",
        lambda p, i, o, c: (open(o, "wb").write(b"g") and None) or "ok")
    monkeypatch.setattr(nbg, "audit_image", lambda s, p: (True, ""))
    rc = nbg.run("ep99", only=None, notes="", no_audit=False)
    out = capsys.readouterr().out
    assert "s2-opha  OK" in out and "s3-done  SKIPPED-exists" in out
    assert "s4-ghost  SKIPPED-no-ref" in out
    assert "NANO_PARTIAL 1/2" in out and rc == 1   # ghost counts, s3 skip doesn't

def test_run_retry_then_failed_audit_keeps_last(tmp_path, monkeypatch, capsys):
    ep, bible = _mk_episode(tmp_path)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(nbg, "load_bible", lambda path="x": bible)
    prompts_seen = []
    def gen(p, i, o, c):
        prompts_seen.append(p); open(o, "wb").write(b"bad"); return "ok"
    monkeypatch.setattr(nbg, "generate_image", gen)
    monkeypatch.setattr(nbg, "audit_image", lambda s, p: (False, "three arms"))
    rc = nbg.run("ep99", only=["s2-opha"], notes="", no_audit=False)
    out = capsys.readouterr().out
    assert len(prompts_seen) == 3                       # MAX_ATTEMPTS
    assert "PREVIOUS ATTEMPT REJECTED: three arms" in prompts_seen[1]
    assert "s2-opha  FAILED-AUDIT" in out and rc == 1
    assert (tmp_path / "Production/ep99/images/s2-opha.png").exists()  # last kept

def test_run_prints_audit_rejection_notes_as_they_happen(tmp_path, monkeypatch, capsys):
    """I5 regression: audit rejection notes were never printed, so an operator
    watching a run burn all MAX_ATTEMPTS retries had no visibility into which
    canon law was failing. Each rejected attempt must print its note live."""
    ep, bible = _mk_episode(tmp_path)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(nbg, "load_bible", lambda path="x": bible)
    monkeypatch.setattr(nbg, "generate_image",
        lambda p, i, o, c: (open(o, "wb").write(b"bad") and None) or "ok")
    monkeypatch.setattr(nbg, "audit_image", lambda s, p: (False, "three arms on Sable"))
    nbg.run("ep99", only=["s2-opha"], notes="", no_audit=False)
    out = capsys.readouterr().out
    assert "attempt-1 REJECTED: three arms on Sable" in out
    assert "attempt-2 REJECTED: three arms on Sable" in out

def test_only_deletes_and_regenerates_named_shot(tmp_path, monkeypatch, capsys):
    ep, bible = _mk_episode(tmp_path)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(nbg, "load_bible", lambda path="x": bible)
    monkeypatch.setattr(nbg, "generate_image",
        lambda p, i, o, c: (open(o, "wb").write(b"new") and None) or "ok")
    monkeypatch.setattr(nbg, "audit_image", lambda s, p: (True, ""))
    rc = nbg.run("ep99", only=["s3-done"], notes="less grime", no_audit=False)
    assert (tmp_path / "Production/ep99/images/s3-done.png").read_bytes() == b"new"
    out = capsys.readouterr().out
    assert rc == 0 and "NANO_OK 1/1" in out
    # The kept/restored outcome must be stated on BOTH paths. Failure has always
    # printed "(original restored)"; success printed nothing, so a showrunner
    # reading the log (or the console's streamed panel) had to know that silence
    # meant the new image stood. Found during Phase 2A acceptance, 2026-07-29.
    assert "s3-done  OK attempt-1 (new image kept)" in out
    # CRITICAL 1 regression: a successful --only regeneration must not leave
    # the backup of the hand-made original lying around.
    assert not (tmp_path / "Production/ep99/images/.s3-done.png.bak").exists()

def test_refused_is_terminal_no_retry(tmp_path, monkeypatch, capsys):
    ep, bible = _mk_episode(tmp_path)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(nbg, "load_bible", lambda path="x": bible)
    n = {"gen": 0}
    def gen(p, i, o, c): n["gen"] += 1; return "refused"
    monkeypatch.setattr(nbg, "generate_image", gen)
    rc = nbg.run("ep99", only=["s2-opha"], notes="", no_audit=False)
    assert n["gen"] == 1 and "s2-opha  REFUSED" in capsys.readouterr().out and rc == 1


def test_only_backup_restored_on_generation_failure(tmp_path, monkeypatch, capsys):
    """CRITICAL 1 regression: --only must never permanently destroy a hand-made
    image. If every retry fails the audit, the original bytes must come back,
    the backup must be gone, and the reported state must say so."""
    ep, bible = _mk_episode(tmp_path)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(nbg, "load_bible", lambda path="x": bible)
    monkeypatch.setattr(nbg, "generate_image",
        lambda p, i, o, c: (open(o, "wb").write(b"new-but-bad") and None) or "ok")
    monkeypatch.setattr(nbg, "audit_image", lambda s, p: (False, "three arms"))
    rc = nbg.run("ep99", only=["s3-done"], notes="", no_audit=False)
    out = capsys.readouterr().out
    png = tmp_path / "Production/ep99/images/s3-done.png"
    bak = tmp_path / "Production/ep99/images/.s3-done.png.bak"
    assert png.read_bytes() == b"handmade", "original hand-made image must be restored"
    assert not bak.exists(), "backup must not survive the run"
    assert "s3-done  FAILED-AUDIT (original restored)" in out
    assert rc == 1


def test_cost_cap_systemexit_mid_run_prints_summary_and_restores_backup(tmp_path, monkeypatch, capsys):
    """CRITICAL 2 regression: a cost-cap SystemExit raised mid-run must not
    leave the operator blind — the per-shot summary, the spend line, and the
    NANO_* tag must still print, and any outstanding --only backup must be
    restored rather than left as a missing original / stray .bak."""
    import pytest
    ep, bible = _mk_episode(tmp_path)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(nbg, "load_bible", lambda path="x": bible)
    calls = {"n": 0}
    def gen(p, i, o, c):
        calls["n"] += 1
        if calls["n"] == 1:
            open(o, "wb").write(b"g"); return "ok"
        raise SystemExit("COST CAP: 60 API calls reached — aborting.")
    monkeypatch.setattr(nbg, "generate_image", gen)
    monkeypatch.setattr(nbg, "audit_image", lambda s, p: (True, ""))
    with pytest.raises(SystemExit):
        nbg.run("ep99", only=["s2-opha", "s3-done"], notes="", no_audit=False)
    out = capsys.readouterr().out
    assert "s2-opha  OK" in out, "shots resolved before the abort must still be reported"
    assert "api calls:" in out, "spend line must print even when the run aborts"
    assert "NANO_" in out, "NANO_* tag must print even when the run aborts"
    png = tmp_path / "Production/ep99/images/s3-done.png"
    bak = tmp_path / "Production/ep99/images/.s3-done.png.bak"
    assert png.read_bytes() == b"handmade", "unresolved --only backup must be restored on abort"
    assert not bak.exists()


def test_notes_merged_with_audit_feedback_across_retries(tmp_path, monkeypatch, capsys):
    """IMPORTANT 3 regression: the operator's --notes must survive every retry,
    merged with (not replaced by) the audit's corrective feedback."""
    ep, bible = _mk_episode(tmp_path)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(nbg, "load_bible", lambda path="x": bible)
    prompts_seen = []
    def gen(p, i, o, c):
        prompts_seen.append(p); open(o, "wb").write(b"bad"); return "ok"
    monkeypatch.setattr(nbg, "generate_image", gen)
    monkeypatch.setattr(nbg, "audit_image", lambda s, p: (False, "three arms"))
    nbg.run("ep99", only=["s2-opha"], notes="make it darker", no_audit=False)
    assert len(prompts_seen) == 3
    assert "make it darker" in prompts_seen[1], "operator notes lost on retry"
    assert "three arms" in prompts_seen[1], "audit feedback missing on retry"
    assert "make it darker" in prompts_seen[2], "operator notes lost on final retry"
    assert "three arms" in prompts_seen[2]


def test_only_unknown_id_exits_without_touching_files(tmp_path, monkeypatch):
    """IMPORTANT 4 regression: a typo'd --only id must fail loudly, before any
    file is touched — never silently report NANO_OK having done nothing."""
    import pytest
    ep, bible = _mk_episode(tmp_path)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(nbg, "load_bible", lambda path="x": bible)
    done_before = (tmp_path / "Production/ep99/images/s3-done.png").read_bytes()
    with pytest.raises(SystemExit) as exc:
        nbg.run("ep99", only=["s2-opha", "nope-not-a-shot"], notes="", no_audit=False)
    assert "nope-not-a-shot" in str(exc.value)
    assert (tmp_path / "Production/ep99/images/s3-done.png").read_bytes() == done_before
    assert not (tmp_path / "Production/ep99/images/s2-opha.png").exists()
    assert not (tmp_path / "Production/ep99/images/.s3-done.png.bak").exists()


def test_only_refuses_to_clobber_a_pre_existing_backup(tmp_path, monkeypatch):
    """NEW FINDING regression (round 2, Important): a .bak already sitting on
    disk before this run started may be the TRUE original left behind by a
    previous --only run that was killed hard enough to skip even the finally
    sweep (kill -9, power loss, OOM). The run must refuse to touch either
    file and abort with a clear message naming the shot and the .bak path."""
    import pytest
    ep, bible = _mk_episode(tmp_path)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(nbg, "load_bible", lambda path="x": bible)
    png = tmp_path / "Production/ep99/images/s3-done.png"
    bak = tmp_path / "Production/ep99/images/.s3-done.png.bak"
    bak.write_bytes(b"true-original-from-a-killed-run")
    png_before, bak_before = png.read_bytes(), bak.read_bytes()
    with pytest.raises(SystemExit) as exc:
        nbg.run("ep99", only=["s3-done"], notes="", no_audit=False)
    msg = str(exc.value)
    assert "s3-done" in msg and ".s3-done.png.bak" in msg
    assert png.read_bytes() == png_before, "current PNG must be untouched"
    assert bak.read_bytes() == bak_before, "pre-existing backup must be byte-for-byte untouched"


def test_error_state_is_reported_distinctly_and_run_continues(tmp_path, monkeypatch, capsys):
    """COVERAGE GAP 1: the ERROR (...) state (transport exhausted, distinct
    from a model content refusal) must appear in the summary, must not be
    confused with REFUSED, and must not stop the run from processing the
    next shot."""
    ep, bible = _mk_episode(tmp_path)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(nbg, "load_bible", lambda path="x": bible)
    n = {"gen": 0}
    def gen(p, i, o, c):
        n["gen"] += 1
        return "error:503 from host"
    monkeypatch.setattr(nbg, "generate_image", gen)
    monkeypatch.setattr(nbg, "audit_image", lambda s, p: (True, ""))
    # s4-ghost has an unresolvable ref, so it is skipped without ever calling
    # generate_image — that skip, happening AFTER the s2-opha ERROR, is what
    # proves the run kept going past the terminal-per-shot ERROR.
    rc = nbg.run("ep99", only=["s2-opha", "s4-ghost"], notes="", no_audit=False)
    out = capsys.readouterr().out
    assert n["gen"] == 1
    assert "s2-opha  ERROR (error:503 from host)" in out
    assert "REFUSED" not in out
    assert "s4-ghost  SKIPPED-no-ref" in out, "run must continue past the ERROR shot"
    assert rc == 1


def test_run_no_audit_end_to_end_skips_the_audit_safety_net(tmp_path, monkeypatch, capsys):
    """TEST ADDITION (fix-wave review): no_audit=True must drive an actual
    generation through run() without ever calling audit_image. Previously
    only flag PARSING (main()) exercised no_audit — never the branch of run()
    that disables the paid-output safety net."""
    ep, bible = _mk_episode(tmp_path)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(nbg, "load_bible", lambda path="x": bible)
    monkeypatch.setattr(nbg, "generate_image",
        lambda p, i, o, c: (open(o, "wb").write(b"unaudited-bytes") and None) or "ok")
    audit_calls = {"n": 0}
    def spy_audit(s, p):
        audit_calls["n"] += 1
        return (True, "")
    monkeypatch.setattr(nbg, "audit_image", spy_audit)
    rc = nbg.run("ep99", only=["s2-opha"], notes="", no_audit=True)
    out = capsys.readouterr().out
    assert audit_calls["n"] == 0, "audit_image must never be called when no_audit=True"
    assert "s2-opha  OK attempt-1 (unaudited)" in out
    assert rc == 0
    assert (tmp_path / "Production/ep99/images/s2-opha.png").read_bytes() == b"unaudited-bytes"


def test_plain_run_leaves_existing_png_byte_for_byte_untouched(tmp_path, monkeypatch):
    """TEST ADDITION (fix-wave review): the binding 'hand-made images are
    never overwritten' constraint was previously only asserted via the
    SKIPPED-exists string. Prove the actual bytes (and mtime) of an existing
    PNG never change on a plain, non ---only run, and that generate_image is
    never even invoked for that shot."""
    ep, bible = _mk_episode(tmp_path)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(nbg, "load_bible", lambda path="x": bible)
    png = tmp_path / "Production/ep99/images/s3-done.png"
    before_bytes = png.read_bytes()
    before_mtime_ns = png.stat().st_mtime_ns
    touched = []
    def gen(p, i, o, c):
        touched.append(o)
        open(o, "wb").write(b"freshly-generated")
        return "ok"
    monkeypatch.setattr(nbg, "generate_image", gen)
    monkeypatch.setattr(nbg, "audit_image", lambda s, p: (True, ""))
    nbg.run("ep99", only=None, notes="", no_audit=False)
    assert str(png) not in touched, (
        "generate_image must never be called for a shot with an existing PNG")
    assert png.read_bytes() == before_bytes, "hand-made PNG bytes must be untouched"
    assert png.stat().st_mtime_ns == before_mtime_ns, (
        "hand-made PNG must not even be rewritten with identical bytes")


def test_nano_ok_bare_when_nothing_to_do(tmp_path, monkeypatch, capsys):
    """COVERAGE GAP 2: when every character shot already has a PNG, the
    active set is empty and the summary must print a bare NANO_OK, not
    'NANO_OK 0/0'."""
    ep, bible = _mk_episode(tmp_path)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(nbg, "load_bible", lambda path="x": bible)
    (ep / "s2-opha.png").write_bytes(b"already-there")
    (ep / "s4-ghost.png").write_bytes(b"already-there-too")
    rc = nbg.run("ep99", only=None, notes="", no_audit=False)
    out = capsys.readouterr().out
    assert "NANO_OK" in out and "NANO_OK 0/0" not in out
    lines = [ln.strip() for ln in out.splitlines()]
    assert "NANO_OK" in lines, "expected a bare NANO_OK line"
    assert rc == 0


# --- ep04 live-pilot findings (2026-07-27) -----------------------------------
# The first real API call 400'd on response_format.mime_type. The mocked suite
# had been green the whole time because nothing asserted the request shape.
# These four tests pin what the live API actually accepts.

def _tiny_jpeg_b64():
    """A real 4x4 JPEG, base64'd — the exact shape output_image.data arrives in."""
    import base64 as _b64
    from io import BytesIO
    from PIL import Image
    buf = BytesIO()
    Image.new("RGB", (4, 4), (12, 34, 56)).save(buf, format="JPEG")
    return _b64.b64encode(buf.getvalue()).decode()


class _FakeImg:
    def __init__(self, data): self.data = data

class _FakeInteraction:
    def __init__(self, data): self.output_image = _FakeImg(data)

class _FakeInteractions:
    def __init__(self, sink, data): self._sink, self._data = sink, data
    def create(self, **kw):
        self._sink.update(kw)
        return _FakeInteraction(self._data)

class _FakeClient:
    def __init__(self, sink, data): self.interactions = _FakeInteractions(sink, data)


def test_api_call_requests_jpeg_and_pins_aspect_and_size(monkeypatch):
    """FIX 4: pin the live-verified request contract. The API rejects
    mime_type=image/png with a hard 400 (ep04 pilot), so a silent regression
    back to PNG — or a dropped aspect_ratio/image_size — must fail here rather
    than at the paid call. Payload inspected via a fake client; no network."""
    sent = {}
    monkeypatch.setattr(nbg, "_client", lambda: _FakeClient(sent, _tiny_jpeg_b64()))
    status, data = nbg._api_call("a prompt", [])
    assert status == "ok"
    rf = sent["response_format"]
    assert rf["mime_type"] == "image/jpeg", (
        "the live API supports ONLY image/jpeg here — image/png 400s")
    assert rf["type"] == "image"
    assert rf["aspect_ratio"] == nbg.ASPECT_RATIO == "16:9"
    assert rf["image_size"] == nbg.IMAGE_SIZE == "2K"
    assert sent["model"] == nbg.MODEL


def test_api_call_transcodes_jpeg_response_to_png_bytes(monkeypatch):
    """FIX 1: the wire format is JPEG but every downstream consumer addresses
    <shot-id>.png, so _api_call must hand back genuine PNG bytes."""
    sent = {}
    monkeypatch.setattr(nbg, "_client", lambda: _FakeClient(sent, _tiny_jpeg_b64()))
    status, data = nbg._api_call("p", [])
    assert status == "ok"
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "output must be a real PNG, not the raw JPEG"
    from io import BytesIO
    from PIL import Image
    assert Image.open(BytesIO(data)).format == "PNG"


def test_generate_image_writes_a_real_png_end_to_end(tmp_path, monkeypatch):
    """FIX 1, through the writer: the file on disk must open as a PNG."""
    sent = {}
    monkeypatch.setattr(nbg, "_client", lambda: _FakeClient(sent, _tiny_jpeg_b64()))
    out = tmp_path / "shot.png"
    assert nbg.generate_image("p", [], str(out), {"calls": 0}) == "ok"
    from PIL import Image
    assert Image.open(out).format == "PNG"


def test_client_error_is_not_retried_and_bills_exactly_one_call(tmp_path, monkeypatch):
    """FIX 3: a 4xx is deterministic — the identical payload gets the identical
    rejection. The ep04 pilot spent 3 of 60 budgeted calls proving that. Must
    fail fast after ONE call, with no backoff sleep."""
    slept, n = [], {"calls": 0}
    def four_hundred(prompt, imgs):
        n["calls"] += 1
        raise RuntimeError("Error code: 400 - {'error': {'message': \"The value "
                           "'image/png' is not supported for "
                           "'response_format.mime_type'.\", 'code': 'invalid_request'}}")
    monkeypatch.setattr(nbg, "_api_call", four_hundred)
    monkeypatch.setattr(nbg.time, "sleep", lambda s: slept.append(s))
    counter = {"calls": 0}
    ret = nbg.generate_image("p", [], str(tmp_path / "s.png"), counter)
    assert ret.startswith("error:")
    assert counter["calls"] == 1, "a deterministic 4xx must burn exactly one call"
    assert n["calls"] == 1, "the 4xx was retried"
    assert slept == [], "no backoff should be spent on a client error"


def test_is_client_error_classification():
    """FIX 3: 4xx fails fast; 5xx and raw network faults keep their retries."""
    class WithStatus(Exception):
        status_code = 403
    assert nbg._is_client_error(WithStatus())
    assert nbg._is_client_error(RuntimeError("Error code: 400 - bad"))
    assert nbg._is_client_error(RuntimeError("code: 'invalid_request'"))
    assert nbg._is_client_error(RuntimeError("PERMISSION_DENIED"))
    # These must still retry.
    assert not nbg._is_client_error(ConnectionError("boom"))
    assert not nbg._is_client_error(RuntimeError("Error code: 503 - overloaded"))
    assert not nbg._is_client_error(TimeoutError("read timed out"))


def _capture_run(monkeypatch):
    seen = {}
    def fake_run(ep, only=None, notes="", no_audit=False):
        seen.update(ep=ep, only=only, notes=notes, no_audit=no_audit)
        return 0
    monkeypatch.setattr(nbg, "run", fake_run)
    return seen


def test_main_prefers_argv_over_arguments_env(monkeypatch):
    """FIX 2: $ARGUMENTS used to win, silently discarding --only/--notes and
    re-running the whole episode. That is the exact path the image-gate reject
    loop drives, so a re-roll would have regenerated every shot."""
    import sys as _sys, pytest
    seen = _capture_run(monkeypatch)
    monkeypatch.setenv("ARGUMENTS", "ep04")
    monkeypatch.setattr(_sys, "argv", ["nano-banana-generate.py", "ep04",
                                       "--only", "s03-opha-still-corner",
                                       "--notes", "smaller grub"])
    with pytest.raises(SystemExit) as e:
        nbg.main()
    assert e.value.code == 0
    assert seen["ep"] == "ep04"
    assert seen["only"] == ["s03-opha-still-corner"], "--only was dropped"
    assert seen["notes"] == "smaller grub", "--notes was dropped"


def test_main_falls_back_to_arguments_env_when_argv_empty(monkeypatch):
    """FIX 2, other side: the Archon bash node passes $ARGUMENTS and no argv.
    That invocation style must keep working."""
    import sys as _sys, pytest
    seen = _capture_run(monkeypatch)
    monkeypatch.setenv("ARGUMENTS", "ep04 --no-audit")
    monkeypatch.setattr(_sys, "argv", ["nano-banana-generate.py"])
    with pytest.raises(SystemExit) as e:
        nbg.main()
    assert e.value.code == 0
    assert seen["ep"] == "ep04" and seen["only"] is None and seen["no_audit"] is True


# --- ep04 pilot 2: baked-in letterbox + file mode --------------------------

def test_audit_laws_include_the_full_bleed_law(monkeypatch):
    """FIX B: the first pilot's frame had a 24px top / 189px bottom black band
    and the auditor PASSED it, because no law covered letterboxing. Law 8 must
    reach the auditor's prompt."""
    seen = {}
    def spy(prompt):
        seen["p"] = prompt
        return '{"pass": true, "notes": ""}'
    monkeypatch.setattr(nbg, "_audit_call", spy)
    nbg.audit_image({"id": "s1", "brief": "b", "refs": ["opha"]}, "/tmp/x.png")
    p = seen["p"]
    assert "8. FULL BLEED" in p
    assert "letterbox" in p and "asymmetric" in p
    assert "fill the frame edge to edge" in p


# --- collective-populator pre-flight (showrunner ruling, s04-opha-uneasy) ---
# The law lived only in prose (Canon/visual-style.md, "No collective
# populators in a character brief") until a live shot ("while the crew works
# on around her, unaware") invented four or five uncredited humans, one
# carrying a real-world flag patch. These tests pin the mechanical gate that
# now fails the run BEFORE any money is spent.

_REAL_MARDO_BRIEF = (
    "Cinematic 16:9 shot, dark hard science fiction, a low cramped dockside "
    "bar off the rim of a worn salvage station, one low warm light fixture "
    "as the key (low-key but clearly exposed, real shadow, cargo-noise "
    "atmosphere). At a scarred table sit three people: TRENT — the fit, "
    "fresh-faced, clean-cut young man of about 28 from his locked reference "
    "sheet, deliberately unworn and clean among a grimy crew, listening with "
    "a faint easy grin — and SABLE — the weathered, practical woman of "
    "about sixty, grey hair, worn denim work clothes and a tool belt from "
    "her locked reference sheet, quiet, listening without judgment. Across "
    "from them sits MARDO, a NEW guest character with no existing reference "
    "sheet: a worn dockside loading-floor worker, sober, gentle, unhurried, "
    "sincere without a trace of crank in him, turning a plain cup in his "
    "hands that he never drinks from, mid-way through telling them a "
    "secondhand story about a recovered ship where none of the dead had "
    "moved. The table has gone quiet around his telling. Design Mardo fresh "
    "from this description — an ordinary worn rim worker, weathered, "
    "plain-dressed, calm-faced. Low-key but clearly exposed, film grain, "
    "no text."
)


def test_find_collective_populators_the_crew_fails():
    hits = nbg.find_collective_populators(
        "OPHA is drawn tight while the crew works on around her, unaware.")
    assert any("the crew" in h.lower() for h in hits)


def test_find_collective_populators_real_mardo_brief_passes():
    """The already-approved s03-mardo-table-scene brief is a HEADCOUNT
    ('three people:') followed by named characters — exactly what the law
    wants — and must NOT trip the gate."""
    assert nbg.find_collective_populators(_REAL_MARDO_BRIEF) == []


def test_find_collective_populators_headcount_qualified_people_passes():
    assert nbg.find_collective_populators(
        "At the table sit three people: A and B and C.") == []


def test_find_collective_populators_a_few_figures_fails():
    hits = nbg.find_collective_populators(
        "In the background, a few figures move past unnoticed.")
    assert any("a few figures" in h.lower() for h in hits)


def test_find_collective_populators_capping_idiom_passes():
    """The house-style CAP — 'no other figures anywhere in the frame' — is
    the recommended fix, not a violation: it negates extras rather than
    inventing them (used verbatim in s02-galley-table-numbers and
    s04-cabin-tension-crew)."""
    assert nbg.find_collective_populators(
        "EXACTLY these three at the table — no other figures anywhere "
        "in the frame.") == []


def test_check_no_collective_populators_passes_silently_when_clean():
    nbg.check_no_collective_populators(
        [{"id": "s1-x", "brief": "TRENT alone at his station."}])  # no raise


def test_run_fails_preflight_before_backup_or_api_call(tmp_path, monkeypatch, capsys):
    """The showrunner's ruling: fail the run mechanically, before the .bak
    backup step and before any API call — the shot id and matched phrase must
    be in the message, and generate_image must never be reached."""
    import pytest
    ep, bible = _mk_episode(tmp_path)
    doc_path = ep / "prompts.json"
    doc = json.loads(doc_path.read_text())
    for s in doc["shots"]:
        if s["id"] == "s2-opha":
            s["brief"] = "OPHA still, while the crew works on around her, unaware."
    doc_path.write_text(json.dumps(doc))
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(nbg, "load_bible", lambda path="x": bible)
    calls = {"n": 0}
    monkeypatch.setattr(nbg, "generate_image",
        lambda p, i, o, c: calls.__setitem__("n", calls["n"] + 1) or "ok")
    with pytest.raises(SystemExit) as exc:
        nbg.run("ep99", only=None, notes="", no_audit=False)
    msg = str(exc.value)
    assert "s2-opha" in msg
    assert "the crew" in msg.lower()
    assert "named" in msg.lower() and "refs" in msg.lower()
    assert calls["n"] == 0, "API call must not happen once the pre-flight fails"
    # nothing backed up either — s3-done has no .bak, and its PNG is untouched
    assert (tmp_path / "Production/ep99/images/s3-done.png").read_bytes() == b"handmade"
    assert not (tmp_path / "Production/ep99/images/.s3-done.png.bak").exists()


def test_written_png_is_group_and_world_readable(tmp_path, monkeypatch):
    """FIX C: mkstemp creates 0600 and os.replace preserves it, so generated
    shots landed 0600 while every hand-made image in the folder is 0644 — a
    problem once these are rsync'd to the NAS or read by another process."""
    out = tmp_path / "shot.png"
    monkeypatch.setattr(nbg, "_api_call", lambda prompt, imgs: ("ok", b"PNGBYTES"))
    assert nbg.generate_image("p", [], str(out), {"calls": 0}) == "ok"
    assert (out.stat().st_mode & 0o777) == 0o644, oct(out.stat().st_mode & 0o777)


def test_capping_idioms_are_not_violations():
    """ep10 s03/s09: both briefs named every person, matched refs exactly, and
    capped the headcount explicitly — and the guard refused to spend anyway,
    on the very sentence that enforces what the guard wants. Two carve-outs
    were too narrow: "both" was not a count word, and the "no ..." escape
    required `no` immediately before the noun, so "no OTHER figures" missed it."""
    ok = ("Strong directional key light, bright rim separation on both figures, "
          "visible midtones, film grain. Two figures: Remo and Sarn, no other "
          "figures in the frame.")
    assert nbg.find_collective_populators(ok) == []

def test_a_real_collective_populator_is_still_caught():
    """The widened carve-outs must not open the door the guard exists to shut."""
    bad = "The crew works the deck while a few figures move in the background."
    assert nbg.find_collective_populators(bad) != []
