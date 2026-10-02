# /// script
# dependencies = []
# ///
"""render-video: run the Remotion render and turn Remotion's own progress into ::progress lines.

The render was the pipeline's one legitimately silent step. `npx remotion render … --log=error`
prints nothing at all for the ten to forty minutes it runs, so the run view could show only a step
in flight with no evidence of life, and the fourteen-minute stall rule had to be special-cased for
it. This wraps the render instead: it spawns Remotion, parses Remotion's own frame counter, and
prints one `::progress {"done":N,"total":M,"unit":"frames"}` line per interval, which the script
executor turns into step_progress events (`engine/src/script-step.ts`).

MEASURED, not guessed. Against Remotion 4.0.487 (`render/package.json`) on 2026-10-02, with the
child's stdout and stderr on a PIPE rather than a TTY, `--log=info` prints exactly this -- 462
progress lines and 15 other lines in the first 20,000 bytes:

    Bundling 100%
    Composition          Episode
    Rendered 0/63280
    Rendered 1/63280, time remaining: 3h 33m 2s
    Rendered 2/63280, time remaining: 1h 48m 37s

Three facts from that measurement shape the parser below.

* FRAMES, never a percentage: `Rendered <done>/<total>`, with an ETA appended from the second
  report on. `Bundling 6%` is the webpack bundle's percentage rather than the render's, and is
  forwarded as an ordinary line; so is `[renderMedia()] Rendering frames 0-63279`.
* NEWLINE-separated, with no carriage returns and no ANSI escapes: Remotion detects the non-TTY
  and prints plain lines (zero `\\r` bytes in 20,000). The reader still splits on both `\\n` and
  `\\r`, because the same code under a TTY -- an operator running this by hand -- gets the
  redrawn-in-place progress bar instead, where `\\r` is the only thing between one report and the
  next.
* ONE REPORT PER FRAME. A 63,280-frame episode would be 63,280 step_progress events in the run
  log and in the console's projection of it, so the reports are throttled to one per
  `--progress-interval` second.

`--log=info` is Remotion's default and the lowest level that prints the frame counter at all:
`--log=error`, which this step passed before, prints nothing, and `--log=verbose` prints the same
counter buried in five `[Tab n, delayRender()]` lines per frame, every one of which would become
its own script_line.

Prints RENDER_OK <out> as its last line. A failed render exits with REMOTION's exit code, not 1,
carrying Remotion's own last line as the one-line reason.

Usage: render-video.py <episode> --render-dir <path> --composition <id> --out <path>
                       [--progress-interval <seconds>] [--show-root <path>]
"""
import os
import re
import subprocess
import sys
import time

from lib import showconfig as sc

# Remotion's frame counter, as measured (see above). The ETA that follows the count from the
# second report on is deliberately not captured: the run view computes its own rate and ETA from
# the step_progress timestamps, and two ETAs that disagree are worse than one.
_RENDERED = re.compile(r"^Rendered\s+(\d+)\s*/\s*(\d+)\b")

# The unit noun the run view puts beside the count.
UNIT = "frames"

# The log level measured to print the frame counter with the least noise around it.
LOG_LEVEL = "info"

DEFAULT_PROGRESS_INTERVAL = 1.0

USAGE = ("usage: render-video.py <episode> --render-dir <path> --composition <id> --out <path> "
         "[--progress-interval <seconds>] [--show-root <path>]")


class RenderFailed(Exception):
    """Remotion exited non-zero. Carries the exit code, because this step's exit code is
    Remotion's own: a render that died at frame 60,000 of 63,280 must not reach the operator as
    the exit 1 that a missing flag gets."""

    def __init__(self, code: int, cause: str) -> None:
        super().__init__(f"remotion exited {code}: {cause or 'no output'}")
        self.code = code


def flag(argv: list[str], name: str) -> str | None:
    """The value of `--name <value>` or `--name=<value>` in argv, or None when absent.

    Both spellings, as `--show-root` and `--render-root` accept both. The flag is NOT removed from
    argv: the only positional this script reads is the episode id at argv[1], which sits before
    every flag, so nothing downstream depends on the flags' places.
    """
    for at, token in enumerate(argv):
        if token == name:
            if at + 1 >= len(argv) or argv[at + 1].startswith("--"):
                raise sc.ShowConfigError(f"{name} needs a value")
            return argv[at + 1]
        if token.startswith(name + "="):
            value = token[len(name) + 1:]
            if value == "":
                raise sc.ShowConfigError(f"{name} needs a value")
            return value
    return None


def required(argv: list[str], name: str) -> str:
    value = flag(argv, name)
    if not value:
        sys.exit(f"render-video: {name} <value> is required ({USAGE})")
    return value


def relay(chunks, interval: float, clock=time.monotonic):
    """Turn Remotion's output into ("progress", (done, total)) and ("line", text) items, in order.

    A generator over raw chunks rather than a loop wrapped around a print, so the throttle's rule
    is testable against a fake clock with no child process involved.

    The throttle has three parts. The FIRST report is emitted at once, because a render that has
    reached frame 1 is a render that is alive and that is the fact the run view was missing for ten
    minutes. After it, at most one report per `interval` seconds. And the LAST report seen is
    flushed at end of stream unless its count was already emitted -- without that flush, a render
    whose final report lands inside the interval would stand at 63,100/63,280 in the log while the
    finished file sat on disk.
    """
    last_at: float | None = None
    last_done: int | None = None
    pending: tuple[int, int] | None = None
    for chunk in chunks:
        # Both separators. The measurement found only "\n" under a pipe, but the same render under
        # a TTY redraws one line in place, where "\r" is the only separator there is.
        for line in re.split(r"[\r\n]", chunk):
            if line == "":
                continue
            hit = _RENDERED.match(line)
            if hit is None:
                yield ("line", line)
                continue
            report = (int(hit.group(1)), int(hit.group(2)))
            now = clock()
            if last_at is None or now - last_at >= interval:
                last_at, last_done, pending = now, report[0], None
                yield ("progress", report)
            else:
                pending = report
    if pending is not None and pending[0] != last_done:
        yield ("progress", pending)


def main() -> None:
    # The engine runs this with the show root as the working directory; --show-root <path> is for
    # an operator running it from somewhere else. The render directory is made absolute BEFORE the
    # chdir, and for the same reason build-timeline.py's --render-root is: it is an engine path and
    # must not follow the show.
    render_dir = os.path.abspath(required(sys.argv, "--render-dir"))
    root = os.path.abspath(sc.show_root(sys.argv))
    sc.load(root)
    os.chdir(root)
    ep = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else ""
    if not ep:
        sys.exit(f"render-video: episode id missing ({USAGE})")
    composition = required(sys.argv, "--composition")
    # Made absolute only AFTER the chdir, so a relative --out means show-relative. The absolute
    # form is what Remotion must receive: Remotion runs with cwd = the render directory, where a
    # show-relative path would resolve inside the engine checkout rather than in the show
    # repository the video belongs to (render/README.md).
    out = os.path.abspath(required(sys.argv, "--out"))
    interval_arg = flag(sys.argv, "--progress-interval")
    interval = DEFAULT_PROGRESS_INTERVAL if interval_arg is None else float(interval_arg)
    if interval < 0:
        sys.exit(f"render-video: --progress-interval must not be negative ({USAGE})")

    os.makedirs(os.path.dirname(out), exist_ok=True)
    print(f"  render: {composition} -> {out}")
    print(f"  remotion: cwd={render_dir} REMOTION_EPISODE={ep} --log={LOG_LEVEL}")
    # An argv LIST, never a shell string (spec §4.4): the output path is a path in the show
    # repository, and a show directory carrying a space would otherwise become two arguments.
    # REMOTION_EPISODE is the one setting that has to travel in the environment rather than in
    # argv, because it is Remotion's own interface and not this script's (render/README.md: an
    # unset value throws rather than guessing an episode).
    argv = ["npx", "remotion", "render", composition, out, f"--log={LOG_LEVEL}"]
    env = dict(os.environ, REMOTION_EPISODE=ep)
    # stderr is merged into stdout so Remotion's own ordering of its two streams survives and one
    # reader serves both; the failure reason is then Remotion's last line whichever stream it
    # chose. bufsize=1 is line buffering, so a report is read when it is printed rather than when
    # a 4 KB block fills -- which, at one report per frame, would be a minute of lag.
    proc = subprocess.Popen(argv, cwd=render_dir, env=env, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, bufsize=1)
    last_line = ""
    for kind, value in relay(proc.stdout, interval):
        if kind == "progress":
            sc.progress(value[0], value[1], UNIT)
        else:
            last_line = value
            print(value, flush=True)
    code = proc.wait()
    if code != 0:
        raise RenderFailed(code, last_line)
    # The last stdout line is this step's RESULT, which the executor records and a later prompt
    # reads; the progress lines above are never recorded as one.
    print(f"RENDER_OK {out}")


if __name__ == "__main__":
    try:
        main()
    except RenderFailed as err:
        # The one fault the house guard cannot express. Every other script exits 1 on every
        # failure; this one hands Remotion's exit code through, so the log distinguishes a render
        # that broke from a render that was never started.
        print(f"render-video: {err}", file=sys.stderr)
        sys.exit(err.code)
    except (sc.ShowConfigError, FileNotFoundError, ValueError) as err:
        sys.exit(f"render-video: {err}")
