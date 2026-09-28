"""The show's configuration, as the Python steps read it.

One convention, for every script in this directory:

    import sys
    from lib import showconfig as sc

    root = os.path.abspath(sc.show_root(sys.argv))   # strips --show-root; else the working dir
    cfg = sc.load(root)               # <root>/showrunner.json, required keys checked
    os.chdir(root)                    # show-relative paths (Production/<ep>/...) resolve from here

The root is made absolute BEFORE anything else, because a relative --show-root would otherwise mean
one directory to load() and a different one to every path resolved after the chdir. load() runs
BEFORE the chdir, so a wrong --show-root fails by naming showrunner.json rather than by failing to
enter a directory.

The engine runs a script step with the show root as the working directory (`cwd: ctx.showRoot` in
`engine/src/script-step.ts`), so `showrunner.json` is found without a flag; `--show-root <path>`
exists for an operator running a script by hand from somewhere else. Paths inside the config are
relative to the show root unless they begin with "/", which is what `path()` implements.

The required-key set here is the same one the engine's loader enforces in
`engine/src/show-config.ts`: showName, showSlug, promptsDir, models.medium, models.large,
models.writer, airMap, output.nasRoot. Both loaders read the same file, so a config that satisfies
one satisfies the other.
"""

from __future__ import annotations

import json
import os
import re

SHOW_CONFIG_FILE = "showrunner.json"

SHOW_ROOT_FLAG = "--show-root"


class ShowConfigError(Exception):
    """A show config that cannot be read, parsed, or trusted to hold a key a script needs."""


class UnmappedEpisodeId(ShowConfigError):
    """A production id the show's airMap does not place in a season.

    Its own class because it is the one config fault a script may legitimately absorb: an episode
    written before its air slot was settled still needs a name for its outputs. Every other
    ShowConfigError means the config is wrong and must reach the operator.
    """


# The keys every show config must carry, as dotted paths. Mirrors engine/src/show-config.ts.
_REQUIRED: tuple[tuple[str, ...], ...] = (
    ("showName",),
    ("showSlug",),
    ("promptsDir",),
    ("models", "medium"),
    ("models", "large"),
    ("models", "writer"),
    ("airMap",),
    ("output", "nasRoot"),
)

# The engine's id grammar, mirrored from engine/src/ids.ts: an aired id carries its own season, a
# production id does not and must be looked up in airMap.
_AIRED_ID = re.compile(r"^s(\d{2})e(\d{2})$")


def load(show_root: str | None = None) -> dict:
    """Read and check `<show_root or cwd>/showrunner.json`, and return it as a dict.

    Raises ShowConfigError naming the file when it cannot be read or parsed, and naming the first
    missing required key by its dotted path when the file is short of one.
    """
    root = os.getcwd() if show_root is None else show_root
    file = os.path.join(root, SHOW_CONFIG_FILE)
    try:
        with open(file, encoding="utf-8") as fh:
            raw = fh.read()
    except OSError as err:
        raise ShowConfigError(f"{SHOW_CONFIG_FILE} could not be read at {file}: {err}") from err
    try:
        cfg = json.loads(raw)
    except ValueError as err:
        raise ShowConfigError(f"{SHOW_CONFIG_FILE} at {file} is not valid JSON: {err}") from err
    if not isinstance(cfg, dict):
        raise ShowConfigError(f"{SHOW_CONFIG_FILE} at {file} must be a JSON object")
    for keys in _REQUIRED:
        node: object = cfg
        for key in keys:
            if not isinstance(node, dict) or key not in node:
                raise ShowConfigError(
                    f"{SHOW_CONFIG_FILE} at {file} is missing required key {'.'.join(keys)}"
                )
            node = node[key]
    return cfg


def show_root(argv: list[str]) -> str:
    """Take the --show-root flag out of argv and return its path; else the working directory.

    Both spellings are accepted -- "--show-root <path>" and "--show-root=<path>" -- because an
    operator types whichever one their shell history has. The flag (and, in the two-token form, its
    value) is REMOVED from the list in place, so the caller's positional arguments keep their usual
    places (sys.argv[1] stays the episode id) and argparse never sees the flag.

    The path is returned as typed; the caller makes it absolute before using it.
    """
    for at, token in enumerate(argv):
        if token == SHOW_ROOT_FLAG:
            if at + 1 >= len(argv):
                raise ShowConfigError(f"{SHOW_ROOT_FLAG} needs a path")
            root = argv[at + 1]
            del argv[at : at + 2]
            return root
        if token.startswith(SHOW_ROOT_FLAG + "="):
            root = token[len(SHOW_ROOT_FLAG) + 1 :]
            if root == "":
                raise ShowConfigError(f"{SHOW_ROOT_FLAG} needs a path")
            del argv[at]
            return root
    return os.getcwd()


_MISSING = object()


def value(cfg: dict, *keys: str, default: object = _MISSING) -> object:
    """The config value at `keys` — the one way a script reads a non-path setting.

    Raises ShowConfigError naming the dotted key path when the key is absent and no default was
    given, so a show config short of a key fails by name rather than by KeyError.
    """
    node: object = cfg
    for key in keys:
        if not isinstance(node, dict) or key not in node:
            if default is not _MISSING:
                return default
            raise ShowConfigError(f"{SHOW_CONFIG_FILE}: {'.'.join(keys)} is missing")
        node = node[key]
    return node


def path(cfg: dict, *keys: str, root: str) -> str:
    """The config value at `keys`, resolved against the show root unless it is already absolute.

    Raises ShowConfigError naming the dotted key path when it is absent or is not a string.
    """
    dotted = ".".join(keys)
    node = value(cfg, *keys)
    if not isinstance(node, str) or node == "":
        raise ShowConfigError(f"{SHOW_CONFIG_FILE}: {dotted} must be a non-empty string")
    return node if os.path.isabs(node) else os.path.join(root, node)


def format_filename(
    pattern: str, *, slug: str, season: int, episode: int, episode_id: str = ""
) -> str:
    """Render an output filename pattern, e.g. "{slug} S{season:02d}E{episode:02d}.wav"."""
    try:
        return pattern.format(slug=slug, season=season, episode=episode, episode_id=episode_id)
    except (KeyError, IndexError, ValueError) as err:
        raise ShowConfigError(f"filename pattern {pattern!r} cannot be rendered: {err}") from err


def season_of(cfg: dict, episode_id: str) -> tuple[int, int]:
    """The (season, episode) an id airs in.

    An aired id (sXXeYY) carries the answer and airMap is never consulted for one; a production id
    (epNN) is looked up in airMap. A production id the map does not place raises UnmappedEpisodeId
    (a ShowConfigError), which a caller may absorb; every other fault raises a plain
    ShowConfigError, so no script ever names an output file from a guessed slot.
    """
    if not isinstance(episode_id, str) or episode_id == "":
        raise ShowConfigError(f"no season for episode id {episode_id!r}: it is not a string")
    aired = _AIRED_ID.match(episode_id)
    if aired:
        season, episode = int(aired.group(1)), int(aired.group(2))
        if season == 0 or episode == 0:
            raise ShowConfigError(
                f"no season for episode id {episode_id!r}: season and episode start at 1"
            )
        return season, episode
    air_map = cfg.get("airMap")
    if not isinstance(air_map, dict):
        raise ShowConfigError(f"{SHOW_CONFIG_FILE}: airMap is missing or is not an object")
    slot = air_map.get(episode_id)
    if slot is None:
        raise UnmappedEpisodeId(
            f"no season for episode id {episode_id!r}: it is not an aired id (sXXeYY) "
            f"and it is not in airMap"
        )
    if not isinstance(slot, (list, tuple)) or len(slot) != 2:
        raise ShowConfigError(
            f"{SHOW_CONFIG_FILE}: airMap.{episode_id} must be [season, episode]"
        )
    return int(slot[0]), int(slot[1])


def progress(done: int, total: int, unit: str, message: str | None = None) -> None:
    """Print one `::progress` line, the engine's unit-of-work contract (spec 6.7).

    `engine/src/script-step.ts` parses stdout lines beginning "::progress " as JSON and emits them
    as step_progress events; every other line it forwards as a script_line.
    """
    payload: dict[str, object] = {"done": int(done), "total": int(total), "unit": unit}
    if message is not None:
        payload["message"] = message
    print("::progress " + json.dumps(payload), flush=True)
