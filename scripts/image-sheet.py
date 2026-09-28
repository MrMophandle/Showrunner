# /// script
# dependencies = []
# ///
"""image-sheet: prompts.json -> a human-readable IMAGE-SHEET.md for the episode.

The showrunner's shot list at a glance: every image, who renders it (the local
engine vs Nano Banana), whether it's in place yet, and — for the Nano Banana
shots — a clean brief to paste into Nano Banana. Standard artifact per episode.

Usage: image-sheet.py <episode> [--show-root <path>]
Writes Production/<ep>/images/IMAGE-SHEET.md.
"""
import json, os, re, sys

from lib import showconfig as sc


def scaffold_patterns(scaffold):
    """-> (prefix regex, suffix regex) that strip the show's ambient prompt scaffolding.

    Every ambient prompt this show writes opens with one of a few standing phrases and closes
    with a standing exposure clause (visual.ambientPromptScaffold). The sheet shows what a shot is
    OF, so the scaffolding is stripped: the leading entries are matched as opening phrases, the
    last as the closing clause. A show whose list holds one entry gets a suffix rule only.
    """
    phrases = [str(p) for p in scaffold if str(p)]
    if not phrases:
        return None, None
    *prefixes, suffix = phrases
    pre = (re.compile(r"^.*?(?:" + "|".join(re.escape(p) for p in prefixes) + ")", re.S)
           if prefixes else None)
    post = re.compile(r",?\s*" + re.escape(suffix.strip()) + r".*$", re.S)
    return pre, post


def subject(prompt, pre=None, post=None):
    """One ambient prompt, with the show's standing scaffolding stripped off both ends."""
    s = pre.sub("", prompt or "") if pre else (prompt or "")
    s = post.sub("", s) if post else s
    s = s.strip().rstrip(",")
    return (s[:1].upper() + s[1:]) if s else (prompt or "")[:120]

def main():
    # The engine runs this with the show root as the working directory; --show-root <path> is for
    # an operator running it from somewhere else.
    root = os.path.abspath(sc.show_root(sys.argv))
    cfg = sc.load(root)
    os.chdir(root)
    ep = sys.argv[1] if len(sys.argv) > 1 else ""
    if not ep:
        sys.exit("image-sheet: episode id missing "
                 "(usage: image-sheet.py <episode> [--show-root <path>])")
    pre, post = scaffold_patterns(sc.value(cfg, "visual", "ambientPromptScaffold", default=[]))
    casting_dir = str(sc.value(cfg, "visual", "castingPileDir"))
    style_doc = os.path.basename(str(sc.value(cfg, "visual", "style")))
    base = f"Production/{ep}/images"
    doc = json.load(open(f"{base}/prompts.json"))
    shots = doc["shots"]
    def present(sid): return os.path.exists(f"{base}/{sid}.png")

    nano = [s for s in shots if s.get("type") == "character"]
    local = [s for s in shots if s.get("type") != "character"]
    n_done = sum(present(s["id"]) for s in nano)
    l_done = sum(present(s["id"]) for s in local)

    L = []
    L.append(f"# {ep} — Image Sheet")
    L.append("")
    L.append(f"**{len(shots)} images total** — "
             f"**{len(nano)} by you** (Nano Banana), **{len(local)} by the engine** (local Z-Image).")
    L.append("")
    L.append(f"Rule ({style_doc}): the local engine renders environments, props, and "
             "faceless human extras only — **never a named character or any alien**. "
             "Everything with an identity is a Nano Banana shot.")
    L.append("")

    # ── YOUR SHOTS ────────────────────────────────────────────────────────
    todo = [s for s in nano if not present(s["id"])]
    done = [s for s in nano if present(s["id"])]
    L.append("---")
    L.append(f"## 🎨 Your shots — Nano Banana  ({n_done}/{len(nano)} in place)")
    L.append("")
    L.append("Make each in Nano Banana using the named reference sheet(s) from "
             f"`{casting_dir}/` (they carry the likeness — the brief describes the "
             f"shot). Save as **exactly** the filename shown into `Production/{ep}/images/`.")
    L.append("")
    L.append(f"### To make  ({len(todo)})")
    L.append("")
    for s in todo:
        refs = ", ".join(s.get("refs", [])) or "—"
        L.append(s["id"] + ".png")                       # bare filename, own line — easy copy
        L.append("")
        L.append(f"refs: **{refs}**  ·  {s.get('scene','')}")
        L.append("")
        L.append("> " + (s.get("brief", "").strip() or "*(no brief)*").replace("\n", "\n> "))
        L.append("")
    if done:
        L.append(f"### Already in place  ({len(done)})")
        L.append("")
        for s in done:
            refs = ", ".join(s.get("refs", [])) or "—"
            L.append(f"- ✅ {s['id']}.png  ·  refs: {refs}  ·  {s.get('scene','')}")
        L.append("")

    # ── ENGINE SHOTS ──────────────────────────────────────────────────────
    L.append("---")
    L.append(f"## ⚙️ Engine shots — local Z-Image  ({l_done}/{len(local)} in place)")
    L.append("")
    L.append("Generated automatically on your GPU. Listed for reference — nothing for you to do.")
    L.append("")
    L.append("| ✓ | File | Subject |")
    L.append("|---|------|---------|")
    for s in local:
        mark = "✅" if present(s["id"]) else "⬜"
        L.append(f"| {mark} | `{s['id']}.png` | {subject(s.get('prompt',''), pre, post)[:110]} |")
    L.append("")

    out = f"{base}/IMAGE-SHEET.md"
    open(out, "w").write("\n".join(L) + "\n")
    print(f"IMAGE_SHEET {ep}: {out}  ({len(nano)} nano [{n_done} done], {len(local)} local [{l_done} done])")


if __name__ == "__main__":
    try:
        main()
    except (sc.ShowConfigError, FileNotFoundError) as err:
        sys.exit(f"image-sheet: {err}")
