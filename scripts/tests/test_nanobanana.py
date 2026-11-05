"""The shared Gemini image client, lib/nanobanana.py (spec 2026-11-04 §3.1).

What this file pins is the client's surface and the three behaviours both callers depend on: the
names the episode renderer and the face designer import, the key redaction every returned string
passes through, and the status a depleted balance (HTTP 402) comes back as. The client's deeper
behaviour — the retry policy, the cost cap, the JPEG-to-PNG transcode, the atomic write — is
pinned in tests/test_nano_banana_generate.py, which has exercised that code since the ep04 pilot
and kept its tests through the 2026-11-04 move.
"""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from lib import nanobanana as nb


def test_the_library_exposes_the_client_names():
    for name in ("MODEL", "MAX_IMAGES", "KEY_SETUP", "CREDITS_LINE", "redact", "client",
                 "encode_refs", "jpeg_to_png", "is_client_error", "refusal_diagnostic",
                 "write_atomic", "api_call", "generate_image"):
        assert hasattr(nb, name), name


def test_redact_hides_the_key(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "sk-SECRET-123")
    assert "SECRET" not in nb.redact("failed with key sk-SECRET-123 in the url")


def test_generate_image_writes_png_and_counts(tmp_path, monkeypatch):
    png = b"\x89PNG\r\n\x1a\n" + b"0" * 32
    monkeypatch.setattr(nb, "api_call", lambda prompt, parts: ("ok", png))
    out = tmp_path / "s01-establishing.png"
    counter = {"calls": 0}
    status = nb.generate_image("a quay at dawn", [], str(out), counter)
    # The status vocabulary is the one the renderer has always branched on: "ok", "refused",
    # "error:<msg>". run() tests `== "refused"` and `.startswith("error:")`, so the move must not
    # invent a new word for success.
    assert status == "ok"
    assert out.read_bytes() == png
    assert counter["calls"] == 1


def test_a_402_status_names_the_credits_remedy(tmp_path, monkeypatch):
    """A depleted AI Studio balance is the one 4xx with a remedy the operator can act on, and the
    per-shot result row in nano-banana-generate.py's run() is where that operator is looking."""
    class Boom(Exception):
        code = 402
    def fail(prompt, parts):
        raise Boom("402 PAYMENT_REQUIRED")
    monkeypatch.setattr(nb, "api_call", fail)
    monkeypatch.setattr(nb, "is_client_error", lambda exc: True)
    status = nb.generate_image("a quay at dawn", [], str(tmp_path / "x.png"), {"calls": 0})
    assert status.startswith("error:")      # the renderer reports it as ERROR (…), not as a refusal
    assert nb.CREDITS_LINE in status


def test_a_402_is_not_retried(tmp_path, monkeypatch):
    """A 402 is deterministic: the same payload against the same empty balance gets the same
    rejection. It must bill exactly one call and spend no backoff sleep."""
    slept, attempts = [], {"n": 0}
    class Boom(Exception):
        code = 402
    def fail(prompt, parts):
        attempts["n"] += 1
        raise Boom("402 PAYMENT_REQUIRED")
    monkeypatch.setattr(nb, "api_call", fail)
    monkeypatch.setattr(nb.time, "sleep", lambda s: slept.append(s))
    counter = {"calls": 0}
    nb.generate_image("a quay at dawn", [], str(tmp_path / "x.png"), counter)
    assert attempts["n"] == 1 and counter["calls"] == 1
    assert slept == []
