import { useRef, useState } from "react";

/** One audio file a gate is asking about, played over the artifact route's Range support.
 *
 *  Ported from console v1's `AudioSeek`, with its scene seek replaced by a plain one. v1 had a
 *  timeline to seek into; a gate does not — `audio-gate` asks about a whole mix and
 *  `casting-gate` about a directory of reference takes. What survives the port is the part that
 *  matters: one `<audio>` element with `preload="metadata"`, so the browser asks for the first
 *  bytes and the duration rather than the whole file, and every scrub afterwards is a `Range`
 *  request the console's artifact route answers with a 206 (`server/artifacts.ts`). A thirty-
 *  megabyte mix is listened to from the middle without ever transferring the start.
 *
 *  The seek box takes `m:ss` because that is how a note about a mix is written — "the breath at
 *  4:12" — and typing 252 into a seconds field is a conversion the operator should not be doing.
 */

/** Seconds as `m:ss`, for the readout. */
function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** `m:ss`, `mm:ss` or a bare number of seconds as seconds, or undefined when it is neither. */
export function parseClock(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  const colon = /^(\d+):([0-5]?\d)$/.exec(trimmed);
  if (colon !== null) return Number(colon[1]) * 60 + Number(colon[2]);
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return undefined;
}

export function AudioSeek({ src, label }: { src: string; label: string }) {
  const ref = useRef<HTMLAudioElement | null>(null);
  const [at, setAt] = useState(0);
  const [seekText, setSeekText] = useState("");

  function nudge(by: number): void {
    const el = ref.current;
    if (el === null) return;
    el.currentTime = Math.max(0, el.currentTime + by);
  }

  function seek(): void {
    const el = ref.current;
    const target = parseClock(seekText);
    if (el === null || target === undefined) return;
    el.currentTime = target;
    void el.play();
  }

  return (
    <div className="audio-seek">
      <div className="audio-seek-label mono">{label}</div>
      <audio
        ref={ref}
        src={src}
        controls
        preload="metadata"
        onTimeUpdate={(e) => { setAt(e.currentTarget.currentTime); }}
      />
      <div className="audio-seek-controls">
        <button type="button" className="btn" onClick={() => { nudge(-10); }}>−10s</button>
        <button type="button" className="btn" onClick={() => { nudge(10); }}>+10s</button>
        <span className="mono audio-seek-at">{clock(at)}</span>
        <input
          className="audio-seek-input mono"
          type="text"
          inputMode="numeric"
          placeholder="m:ss"
          value={seekText}
          onChange={(e) => { setSeekText(e.target.value); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); seek(); } }}
        />
        <button type="button" className="btn" onClick={seek} disabled={parseClock(seekText) === undefined}>seek</button>
      </div>
    </div>
  );
}
