"""Exits 3 after writing its real complaint and THEN a progress line, both to stderr.

The step's error must be the complaint, not the progress line: a `::progress` line is a
unit-of-work report and is never the last stderr line, whichever stream it arrives on.
"""
import sys

print("about to fail")
print("the reason", file=sys.stderr, flush=True)
print('::progress {"done":1,"total":1,"unit":"x"}', file=sys.stderr, flush=True)
sys.exit(3)
