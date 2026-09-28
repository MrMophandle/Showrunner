import json, os
import numpy as np
import soundfile as sf
from conftest import load_script


def _load():
    # The scripts live one directory up, beside lib/; conftest resolves them and puts that
    # directory on sys.path so `from lib import showconfig` works from here.
    return load_script("truncation-qc.py")


tq = _load()
SR = 24000


def _speech(seconds, rng):
    """Speech-shaped signal: noise carrier under a ~4 Hz syllable envelope.

    The envelope is a cosine so that a whole number of quarter-seconds ends on a
    syllable PEAK -- which is what being cut off mid-word actually sounds like.
    (A sine ends in a trough, i.e. in a gap between syllables, and a detector is
    right not to flag that.)
    """
    t = np.arange(int(SR * seconds)) / SR
    return (rng.standard_normal(len(t)) * (0.5 + 0.5 * np.cos(2 * np.pi * 4 * t)) * 0.2).astype("float32")


def _release(x, seconds=0.25):
    """A normal end-of-sentence: the last quarter second tapers to silence."""
    out = x.copy()
    n = int(SR * seconds)
    out[-n:] *= np.linspace(1.0, 0.0, n)
    return out


def _episode(tmp_path, segments, wavs):
    """Write a minimal ep99 tree; segments is the tts-script list, wavs is {i: array}."""
    base = tmp_path / "Production/ep99"
    (base / "audio/segments").mkdir(parents=True)
    (base / "tts-script.json").write_text(json.dumps(
        {"episode": "ep99", "engine": "qwen3", "cast": {"narrator": {}}, "segments": segments}))
    for i, arr in wavs.items():
        sf.write(str(base / f"audio/segments/{i:04d}.wav"), arr, SR)
    return str(base)


# ── the detector ────────────────────────────────────────────────────────────

def test_hard_cut_scores_above_threshold_and_clean_decay_scores_below():
    """The whole feature is this separation. A take that stops mid-word ends at
    full speaking energy; a take that finishes ends in its own release."""
    rng = np.random.default_rng(0)
    body = _speech(3.0, rng)

    assert tq.tail_ratio(body, SR) > tq.THRESHOLD          # cut off mid-word
    assert tq.tail_ratio(_release(body), SR) < tq.THRESHOLD  # finished the sentence


def test_silence_does_not_divide_by_zero():
    """A segment with no speech in it must score 0.0, not NaN or a crash."""
    assert tq.tail_ratio(np.zeros(int(SR * 1.5), dtype="float32"), SR) == 0.0


def test_a_loud_ending_that_still_has_a_trim_pad_is_not_truncation(tmp_path):
    """The false-positive class that a tail-energy threshold alone cannot see.

    tts-generate's trim() keeps [first>0.01 - 30ms, last>0.01 + 30ms]. A take
    that FINISHED has quiet material after its last loud sample, so trim leaves
    a sub-0.01 pad on the end. A take the engine cut off has nothing after it,
    so it ends hot on its final sample with no pad at all. Short punchy lines
    ("Mm.", "Fly well,") can push tail energy over the threshold while still
    ending properly -- 8 of 10 threshold-only hits across the shipped episodes
    were exactly this. The pad is what separates them.
    """
    rng = np.random.default_rng(6)
    ended_properly = np.concatenate([
        _speech(2.0, rng),                                  # ends on a syllable peak
        np.zeros(int(SR * 0.030), dtype="float32")])        # ...then trim's 30ms pad
    segs = [{"i": 1, "speaker": "narrator", "text": "Fly well,"}]
    base = _episode(tmp_path, segs, {1: ended_properly})

    assert tq.trailing_pad_ms(ended_properly, SR) >= 25.0
    assert tq.find_truncated(base, {"segments": segs}) == []


def test_a_loud_ending_with_no_trim_pad_is_truncation(tmp_path):
    """Same loud ending, no pad -- the engine stopped mid-word."""
    rng = np.random.default_rng(6)
    cut = _speech(2.0, rng)
    segs = [{"i": 1, "speaker": "narrator", "text": "...but time."}]
    base = _episode(tmp_path, segs, {1: cut})

    assert tq.trailing_pad_ms(cut, SR) < 1.0
    assert tq.find_truncated(base, {"segments": segs}) == [1]


# ── which segments get flagged ──────────────────────────────────────────────

def test_flags_the_truncated_segment_and_leaves_the_good_one(tmp_path):
    rng = np.random.default_rng(1)
    good, bad = _release(_speech(3.0, rng)), _speech(3.0, rng)
    segs = [{"i": 1, "speaker": "narrator", "text": "fine."},
            {"i": 2, "speaker": "narrator", "text": "cut off"}]
    base = _episode(tmp_path, segs, {1: good, 2: bad})

    assert tq.find_truncated(base, {"segments": segs}) == [2]


def test_deliberate_cutoff_segments_are_never_flagged(tmp_path):
    """Interruptions are SUPPOSED to stop mid-word -- tts-generate slices them
    on purpose. Flagging them would re-roll them forever."""
    rng = np.random.default_rng(2)
    segs = [{"i": 1, "speaker": "Idris", "text": "But I never--", "cutoff": True,
             "tts_text_full": "But I never got the chance."}]
    base = _episode(tmp_path, segs, {1: _speech(3.0, rng)})

    assert tq.find_truncated(base, {"segments": segs}) == []


def test_flags_any_speaker_not_just_the_narrator(tmp_path):
    """Unlike breath-qc, truncation is a synthesis failure and hits every voice."""
    rng = np.random.default_rng(3)
    segs = [{"i": 1, "speaker": "Pell", "text": "Why are we in the medbay?"}]
    base = _episode(tmp_path, segs, {1: _speech(3.0, rng)})

    assert tq.find_truncated(base, {"segments": segs}) == [1]


# ── the re-roll ─────────────────────────────────────────────────────────────

def test_reroll_bumps_the_pinned_seed_and_deletes_the_take(tmp_path):
    """Seeds are pinned, so deleting alone would re-render the identical bad
    take. pace-qc's constant is the house convention for 'give me a new roll'."""
    rng = np.random.default_rng(4)
    segs = [{"i": 7, "speaker": "narrator", "text": "cut off"}]
    base = _episode(tmp_path, segs, {7: _speech(3.0, rng)})
    doc = {"segments": segs}

    tq.reroll(base, doc, [7])

    assert doc["segments"][0]["seed"] == 7 * 7919 + 13 + 104729
    assert not os.path.exists(f"{base}/audio/segments/0007.wav")


def test_reroll_bumps_an_already_bumped_seed_again(tmp_path):
    """A second round must move off the first re-roll, not recompute the default."""
    rng = np.random.default_rng(5)
    segs = [{"i": 7, "speaker": "narrator", "text": "cut off", "seed": 500000}]
    base = _episode(tmp_path, segs, {7: _speech(3.0, rng)})
    doc = {"segments": segs}

    tq.reroll(base, doc, [7])

    assert doc["segments"][0]["seed"] == 500000 + 104729
