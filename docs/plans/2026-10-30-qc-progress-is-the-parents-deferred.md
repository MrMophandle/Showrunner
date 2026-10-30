# QC Progress Is the Parent's — deferred record

**Status (2026-10-30).** Branch `qc-progress` from 31b682c: 77c1d06 (the forwarder, the three parents, the tests) and the hardening commit after review. pytest 316 passed; the show-name grep clean; `scripts/tts-generate.py` unchanged.

## What the branch built
The three audio QC steps (pace, truncation, breath) re-run the renderer as a child through `scripts/lib/child.py`'s `run_forwarding`, which pipes the child's stdout and prints every line as it arrives except `::progress` lines, so the engine records a QC step's own rounds as its progress and never the child's restarting segment count. Pace and truncation name the re-roll count in their round message. Plan ruling F-11 holds (same interpreter, the script beside the parent, the episode id on argv, no new session, lines forwarded in order).

## Rulings
| id | ruling | why |
|---|---|---|
| R-01 | `tts-generate.py` keeps its full-episode count (skipped segments included) | its own comment: the bar measures the episode, so a resumed render reads 300/455, not 0/155 |
| R-02 | the parent drops the child's `::progress` lines rather than re-labelling them | the engine attributes a progress line to the running step; a child's count is not the parent's work |
| R-03 | the spawn test asserts `CalledProcessError` on a failing child instead of `check=True` | `check` is not a `Popen` argument; the property under test is the same |
| R-04 | `errors="replace"` on the child's text decode | a non-UTF-8 byte must not fail a QC step (review) |

## Deferred
- The round message (`round N: K segments re-rolled`) has no test of its own; the terminal full-bar line, which carries no message, is what `test_qc_progress.py` asserts. Cost if wrong: a wrong count in a message nobody reads from a test.
- `progressLabel` on the console does not show a progress message, so the Board reads "2/3 rounds" and the message is visible only where the console renders it; showing it on the Board is a console change.
- The pre-existing 65 "authored pause 0.05s" warnings from `validate-manifest.py` on s02e01 are unexamined.
