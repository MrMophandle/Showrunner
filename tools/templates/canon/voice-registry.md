# Voice registry

> **`Production/voice-refs/refs.json` is the source of truth.** That file holds every voice the pipeline can actually speak with — the reference WAV, its transcript, the direction, the speed and the LOCKED marker — and the audio steps read it and never read this file. This file is the prose about it: why a voice sounds the way it does, what was tried and rejected, how a name is pronounced, and anything an author needs that JSON has no room for. A character is castable when `refs.json` carries an entry whose status contains LOCKED, not when it is described here. Run `scripts/design-voice.py` to audition candidate voices; it writes the WAVs and you add the `refs.json` entry for the one you keep.

## Locked

## Auditioning

## Guest characters
