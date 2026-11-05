"""The Gemini image client every image in the show goes through: the episode renderer
(`nano-banana-generate.py`) and the face designer (`design-visual.py`). Moved here from the
renderer on 2026-11-04 (spec 2026-11-04 §3.1) so there is one client, one retry policy and one
remedy line for a depleted balance.

What this module owns: the key check and its setup text, the client, reference-image encoding, the
API call with its retry and client-error classification, the JPEG-to-PNG workaround, the refusal
diagnostic, the atomic write, and the key redaction. What it does not own: anything about a
particular image. Which shots exist, what a prompt says, which reference images a subject
contributes and whether a rendered frame passes the show's audit laws all stay with the caller.

`generate_image` returns one of three status strings, and both callers branch on them: `"ok"`
(out_path now holds a complete PNG), `"refused"` (the model declined and nothing was written), or
`"error:<message>"` (a transport fault, a 4xx, or a local write failure — nothing was written).
"""
import base64
import os
import re
import sys
import tempfile
import time

MODEL = "gemini-3-pro-image"          # Nano Banana Pro (verified live docs, Task 2)
ASPECT_RATIO = "16:9"                  # response_format: cinematic frame
IMAGE_SIZE = "2K"                      # response_format: uppercase K per docs
# The docs list image/png as valid, but the live validator rejects it with a
# hard 400 naming image/jpeg as the ONLY supported value (ep04 pilot,
# 2026-07-27). The API is ground truth. We request JPEG and transcode to PNG on
# the way out — see jpeg_to_png. Do not "fix" this back to image/png.
OUTPUT_MIME = "image/jpeg"
MAX_CALLS = 60                         # hard cost cap per run (~$8)
MAX_IMAGES = 8                         # total reference images per API call

KEY_SETUP = """GEMINI_API_KEY is not set. One-time setup (5 min):
  1. https://aistudio.google.com/apikey -> Create API key (enable billing on the
     project: paid tier = no visible watermark + real rate limits).
  2. Add to ~/.zshenv:  export GEMINI_API_KEY="<key>"
  3. Open a new terminal (or `source ~/.zshenv`) and re-run."""

# The one 4xx with a remedy the operator can act on without reading a traceback. It rides in the
# status string so it reaches the per-shot result row the renderer prints, which is where an
# operator watching a paid run is actually looking.
CREDITS_LINE = ("Google AI Studio credits are depleted (HTTP 402) — "
                "top up at https://ai.studio/projects, then resume the run")


def redact(text) -> str:
    """Strip the API key out of anything we return, print or log.

    Some Google transports carry the key as a ?key= query param, so an
    exception's str() can embed it — and these strings get printed by the
    orchestrator. Never let one reach a log."""
    s = str(text)
    key = os.environ.get("GEMINI_API_KEY")
    return s.replace(key, "<redacted>") if key else s


def client():
    if not os.environ.get("GEMINI_API_KEY"):
        sys.exit(KEY_SETUP)
    from google import genai
    return genai.Client()                        # reads GEMINI_API_KEY


def encode_refs(image_paths: list[str]) -> list[dict]:
    """Read + b64-encode the reference images. Local I/O only — NO network.

    Kept out of api_call so a local failure (a ref deleted between assembly
    and generation) can't burn a call against the cost cap."""
    parts = []
    for p in image_paths:
        with open(p, "rb") as f:
            parts.append({"type": "image",
                          "data": base64.b64encode(f.read()).decode(),
                          "mime_type": "image/png"})
    return parts


def jpeg_to_png(data: bytes) -> bytes:
    """Transcode the API's JPEG output to PNG bytes.

    The model will only emit image/jpeg, but the entire pipeline addresses a
    shot as <shot-id>.png — prompts.json ids, image-audit, registry-append,
    build-timeline, the Remotion render, IMAGE-SHEET.md. Converting at this one
    boundary keeps every consumer unchanged. No extra quality loss: the server
    already did the only lossy step."""
    from io import BytesIO
    from PIL import Image
    buf = BytesIO()
    Image.open(BytesIO(data)).convert("RGB").save(buf, format="PNG")
    return buf.getvalue()


# Deterministic failures: the request itself is wrong, so every retry produces
# the identical 4xx while still billing a call against MAX_CALLS.
CLIENT_ERROR_TOKENS = ("invalid_request", "invalid_argument", "permission_denied",
                       "unauthenticated", "not_found", "api key not valid")


def is_client_error(exc) -> bool:
    """True for a deterministic 4xx (malformed request / auth / not found).

    Retrying one can never succeed: the ep04 pilot burned 3 of 60 budgeted
    calls re-sending the same rejected payload. 5xx and raw network faults are
    NOT client errors — those keep their exponential-backoff retries."""
    for attr in ("status_code", "code", "status"):
        v = getattr(exc, attr, None)
        if isinstance(v, int) and 400 <= v < 500:
            return True
    v = getattr(getattr(exc, "response", None), "status_code", None)
    if isinstance(v, int) and 400 <= v < 500:
        return True
    s = str(exc).lower()
    if re.search(r"error code: 4\d\d\b", s):
        return True
    return any(tok in s for tok in CLIENT_ERROR_TOKENS)


def _is_payment_required(exc) -> bool:
    """True for the 402 a depleted AI Studio balance answers with.

    A subset of is_client_error, read separately only so generate_image can hand the operator
    CREDITS_LINE instead of a raw transport message. Private because neither caller needs it:
    what a caller reads is the status string. The attribute scan repeats is_client_error's rather
    than factoring it out, so that the 4xx classification moved here on 2026-11-04 stays
    byte-for-byte what the ep04 pilot's findings tuned."""
    for attr in ("status_code", "code", "status"):
        if getattr(exc, attr, None) == 402:
            return True
    if getattr(getattr(exc, "response", None), "status_code", None) == 402:
        return True
    s = str(exc).lower()
    return "payment_required" in s or bool(re.search(r"error code: 402\b", s))


def refusal_diagnostic(interaction) -> str:
    """One line describing an output-less response, so the first live run can
    confirm the real safety-block shape (the docs never showed one). Shape
    only — type + attribute names, never the payload."""
    attrs = ", ".join(sorted(a for a in dir(interaction)
                             if not a.startswith("_")))
    return redact(f"REFUSED (no output_image): response type="
                  f"{type(interaction).__name__} attrs=[{attrs}]")


def write_atomic(out_path: str, data: bytes) -> None:
    """Write via temp file + os.replace so out_path only ever exists complete.

    The pipeline skips any shot whose PNG exists; a half-written file would be
    silently treated as finished and could ship in an episode."""
    folder = os.path.dirname(os.path.abspath(out_path))
    fd, tmp = tempfile.mkstemp(dir=folder, prefix=".nbg-", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.chmod(tmp, 0o644)                     # mkstemp makes 0600; os.replace
                                                 # keeps it. Every other image in
                                                 # the folder is 0644 — match it.
        os.replace(tmp, out_path)                # atomic within a filesystem
    except Exception:
        try:
            os.unlink(tmp)                       # never leave a stray temp
        except OSError:
            pass
        raise


def api_call(prompt: str, image_parts: list[dict]):
    """One Gemini call. -> ('ok', png_bytes) | ('refused', None).

    Requests JPEG (the only mime_type this model accepts) and returns PNG bytes
    so callers — and the files on disk — stay PNG throughout.

    Takes ALREADY-ENCODED image parts (see encode_refs) so this function is
    purely network. Raises on transport errors (caller retries). EXACT call
    shape per the Interactions API documented at
    https://ai.google.dev/gemini-api/docs/image-generation (verified Task 2,
    Step 1) — adjust here only.
    """
    api = client()
    content = [{"type": "text", "text": prompt}] + list(image_parts)
    interaction = api.interactions.create(
        model=MODEL,
        input=content,
        response_format={"type": "image", "mime_type": OUTPUT_MIME,
                         "aspect_ratio": ASPECT_RATIO, "image_size": IMAGE_SIZE},
    )
    img = getattr(interaction, "output_image", None)
    if img is None or not getattr(img, "data", None):
        print(refusal_diagnostic(interaction))   # safety decline / empty output
        return ("refused", None)
    return ("ok", jpeg_to_png(base64.b64decode(img.data)))


def generate_image(prompt, image_paths, out_path, call_counter):
    """-> 'ok' | 'refused' | 'error:<msg>'. Writes out_path only on 'ok'."""
    if call_counter["calls"] >= MAX_CALLS:
        sys.exit(f"COST CAP: {MAX_CALLS} API calls reached — aborting. "
                 f"Re-run to continue (idempotent).")
    try:
        image_parts = encode_refs(image_paths)    # local: must not bill a call
    except Exception as e:
        return f"error:{redact(e)}"

    last = None
    for attempt in range(3):                      # transport retries
        try:
            call_counter["calls"] += 1            # an API call is now happening
            status, data = api_call(prompt, image_parts)
        except SystemExit:
            raise
        except Exception as e:                    # network/5xx/etc
            last = e
            if is_client_error(e):                # 4xx: identical every time
                # Fail fast, bill exactly one. A 402 is the one 4xx the operator can clear
                # himself, so its status carries the remedy rather than only the transport's
                # message (spec 2026-11-04 §3.1).
                if _is_payment_required(e):
                    return f"error:{redact(e)} — {CREDITS_LINE}"
                return f"error:{redact(e)}"
            time.sleep(2 ** attempt)
            continue
        if status == "refused":
            return "refused"
        # The paid call already succeeded — that's billed no matter what
        # happens next. A LOCAL write failure (full/read-only volume) can't
        # possibly turn out differently on retry, so it must not re-enter this
        # loop and bill two more calls for the same zero output.
        try:
            write_atomic(out_path, data)
        except Exception as e:
            return f"error:{redact(e)}"
        return "ok"
    return f"error:{redact(last)}"
