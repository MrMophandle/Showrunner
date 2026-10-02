import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { EpisodeRow, SseMessage } from "../shared/types.js";

/** The client's one way of talking to the console's server: a fetch hook, a POST, one SSE channel
 *  shared by every page, and the context the app's chrome (the show's name and the Board's rows)
 *  is read through.
 *
 *  The server is the only origin this client talks to. There is no second base url, no api key and
 *  no retry policy beyond the SSE channel's reconnect: the console answers for one show on one
 *  machine, usually the same machine.
 *
 *  `useApi` and `useSSE` are ported from console v1 (`console/src/api.ts`), with two changes. The
 *  SSE channel is one `EventSource` for the whole app rather than one per hook, because the server
 *  holds a subscription per connection and a page with four hooks would hold four. And the
 *  messages are read from the default `message` event rather than from named ones: this server
 *  sends every notice as `data:` with no `event:` line, and the vocabulary is in the payload's own
 *  `type` (`shared/types.ts`'s `SseMessage`). */

/** What `GET /api/show` answers. Declared here rather than in `shared/types.ts` because the
 *  server builds that response inline from its `ShowContext` and the engine's `STAGES`, and this
 *  is the client's reading of it; a shared declaration would be a second thing to keep in
 *  agreement with a route that has no view model of its own. */
export interface ShowInfo {
  showName: string;
  showSlug: string;
  operator: string;
  episodesDir: string;
  productionDir: string;
  stages: string[];
  engineVersion: string;
}

/** One entry of the artifact route's directory listing (`server/artifacts.ts`'s `DirEntry`).
 *  Declared here for the same reason as `ShowInfo`: the server's own declaration lives in a module
 *  that imports `node:fs`, which the client must never pull into its bundle. */
export interface DirEntry {
  name: string;
  size: number;
  isDir: boolean;
}

/** A failed request, carrying the status the server answered and the message it answered with.
 *  The status matters to one caller in particular: the Gate page tells a 409 "the gate moved"
 *  from a 409 "the gate is not open" from a 409 "a worker holds this run", and all three are the
 *  engine's own wording, which the console must not paraphrase. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The server's error body is `{error: "<message>"}` on every route. Anything else — an empty
 *  body, HTML from a proxy, a truncated stream — falls back to the status line, which is still
 *  something the operator can act on. */
function errorFrom(status: number, statusText: string, text: string): ApiError {
  let parsed: unknown;
  try { parsed = text === "" ? undefined : JSON.parse(text); } catch { parsed = undefined; }
  const message = isRecord(parsed) && typeof parsed["error"] === "string" ? parsed["error"] : (text.trim() === "" ? `${status} ${statusText}` : text.trim());
  return new ApiError(status, message);
}

/** A GET, parsed as JSON, throwing `ApiError` on anything but a 2xx. */
export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { Accept: "application/json" } });
  const text = await res.text();
  if (!res.ok) throw errorFrom(res.status, res.statusText, text);
  return JSON.parse(text) as T;
}

/** A GET, as text: how every artifact that is rendered rather than played is read — markdown, a
 *  diff, a json file, a run's troubleshooting log. */
export async function getText(path: string): Promise<string> {
  const res = await fetch(path);
  const text = await res.text();
  if (!res.ok) throw errorFrom(res.status, res.statusText, text);
  return text;
}

/** A POST with a JSON body, answered with JSON. Every action route takes this shape, and every
 *  refusal is a 4xx carrying `{error}` — a 409 from the engine most of the time, which is the
 *  message the page shows verbatim. */
export async function post<T = unknown>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw errorFrom(res.status, res.statusText, text);
  return (text === "" ? undefined : JSON.parse(text)) as T;
}

/** Posts a question and reads the plain-text answer as it arrives, calling `onChunk` for every
 *  chunk. Ported from console v1's `streamAction`, including the one `TextDecoder` reused across
 *  every chunk: a fresh decoder per chunk turns a multi-byte character split across two network
 *  chunks into replacement characters instead of reassembling it. */
export async function postStream(path: string, body: unknown, onChunk: (chunk: string) => void): Promise<void> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw errorFrom(res.status, res.statusText, await res.text().catch(() => ""));
  if (res.body === null) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onChunk(decoder.decode(value, { stream: true }));
  }
  const tail = decoder.decode();
  if (tail !== "") onChunk(tail);
}

/** What a fetch hook holds. `data` keeps its last-good value through a failure so a page shows
 *  what it had with an error beside it rather than unmounting on a blip — v1's behaviour, and the
 *  right one for a console watched on a tablet over wifi. `status` is the status of the last
 *  failure, which the Gate page needs: a 404 there means "no gate is open", not "something broke".
 */
export interface ApiState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  status: number | null;
  refetch: () => void;
}

/** Fetches `path` as JSON, re-fetching when `path` changes or `refetch()` is called. A `null` path
 *  fetches nothing and reports neither loading nor an error, which is how a page waits for the id
 *  it needs (the Gate page's artifacts, say) without a second component. */
export function useApi<T>(path: string | null): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<number | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (path === null) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setStatus(null);
    getJson<T>(path)
      .then((json) => {
        if (cancelled) return;
        setData(json);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setStatus(err instanceof ApiError ? err.status : null);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [path, tick]);

  const refetch = useCallback(() => { setTick((t) => t + 1); }, []);
  return { data, loading, error, status, refetch };
}

/** The same, as text: the hook every artifact pane reads its file through. */
export function useTextApi(path: string | null): ApiState<string> {
  const [data, setData] = useState<string | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<number | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (path === null) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setStatus(null);
    getText(path)
      .then((text) => {
        if (cancelled) return;
        setData(text);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setStatus(err instanceof ApiError ? err.status : null);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [path, tick]);

  const refetch = useCallback(() => { setTick((t) => t + 1); }, []);
  return { data, loading, error, status, refetch };
}

// ── the one channel ───────────────────────────────────────────────────────────────────────────

const SSE_PATH = "/api/events";

/** How long to wait before reconnecting a dropped channel. `EventSource` retries on its own in
 *  most browsers, but not when the connection is closed outright — a console restarted for an
 *  upgrade is exactly that case — so the reconnect is driven explicitly rather than left to an
 *  implementation detail. Two seconds: long enough not to hammer a server that is coming up,
 *  short enough that the operator does not notice the gap. */
const RECONNECT_MS = 2_000;

type Listener = (m: SseMessage) => void;

const listeners = new Set<Listener>();
const liveListeners = new Set<(live: boolean) => void>();
let source: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let live = false;

function setLive(value: boolean): void {
  if (live === value) return;
  live = value;
  for (const fn of [...liveListeners]) fn(value);
}

/** A message off the wire, or undefined when it is not one this client knows. A notice it cannot
 *  read is dropped rather than thrown: the channel is a convenience — every page can still be
 *  refreshed by hand — and a malformed line must not take the connection down with it. */
function parseMessage(raw: string): SseMessage | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return undefined; }
  if (!isRecord(parsed)) return undefined;
  const type = parsed["type"];
  if (type === "episodes") return { type: "episodes" };
  if (type === "hello") {
    const operator = parsed["operator"];
    const showName = parsed["showName"];
    if (typeof operator !== "string" || typeof showName !== "string") return undefined;
    return { type: "hello", operator, showName };
  }
  if (type === "run") {
    const episodeId = parsed["episodeId"];
    const runId = parsed["runId"];
    const offset = parsed["offset"];
    if (typeof episodeId !== "string" || typeof runId !== "string" || typeof offset !== "number") return undefined;
    return { type: "run", episodeId, runId, offset };
  }
  return undefined;
}

function connect(): void {
  if (source !== null || listeners.size === 0) return;
  const es = new EventSource(SSE_PATH);
  source = es;
  es.onopen = () => { setLive(true); };
  es.onmessage = (event: MessageEvent) => {
    const message = parseMessage(typeof event.data === "string" ? event.data : "");
    if (message === undefined) return;
    setLive(true);
    for (const fn of [...listeners]) {
      try { fn(message); } catch { /* one page's handler failing is not the channel's problem */ }
    }
  };
  es.onerror = () => {
    es.close();
    if (source === es) source = null;
    setLive(false);
    if (listeners.size > 0 && reconnectTimer === null) {
      reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, RECONNECT_MS);
    }
  };
}

function closeIfIdle(): void {
  if (listeners.size > 0) return;
  if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  source?.close();
  source = null;
  setLive(false);
}

/** Subscribes to the console's one SSE channel for as long as the component is mounted. Every
 *  subscriber shares one `EventSource`; the channel opens with the first subscriber and closes
 *  with the last. */
export function useSSE(onMessage: (m: SseMessage) => void): void {
  const ref = useRef(onMessage);
  ref.current = onMessage;
  useEffect(() => {
    const fn: Listener = (m) => { ref.current(m); };
    listeners.add(fn);
    connect();
    return () => { listeners.delete(fn); closeIfIdle(); };
  }, []);
}

/** Whether the channel is open, for the one dot in the header that says so. A console whose
 *  channel has dropped looks identical to an idle one otherwise, which is the worst way to watch
 *  a four-hour render. */
export function useSseLive(): boolean {
  const [value, setValue] = useState(live);
  useEffect(() => {
    const fn = (v: boolean): void => { setValue(v); };
    liveListeners.add(fn);
    setValue(live);
    return () => { liveListeners.delete(fn); };
  }, []);
  return value;
}

/** Coalesces a burst of calls into one, at most once per `ms`.
 *
 *  This is what keeps the Run page's `?after=` fetches honest. The server publishes one notice per
 *  appended batch of lines, and a render at full tilt appends ten times a second: a fetch per
 *  notice would be ten requests a second for a page that can only draw once a frame. The window
 *  opens on the first call and the fetch happens at its end, so a steady stream of notices is one
 *  fetch every `ms` rather than — as a trailing debounce would give — no fetch at all until the
 *  stream stops. */
export function useCoalesced(fn: () => void, ms = 250): () => void {
  const ref = useRef(fn);
  ref.current = fn;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; }
  }, []);
  return useCallback(() => {
    if (timer.current !== null) return;
    timer.current = setTimeout(() => { timer.current = null; ref.current(); }, ms);
  }, [ms]);
}

/** A clock that ticks, for the elapsed and stall labels. Nothing on the page is animated; this is
 *  the one thing that re-renders on its own, because "eleven minutes since the last event" is a
 *  number that has to keep counting while an operator watches it. */
export function useNow(everyMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()); }, everyMs);
    return () => { clearInterval(timer); };
  }, [everyMs]);
  return now;
}

// ── the chrome ────────────────────────────────────────────────────────────────────────────────

/** What every page can read without fetching it again: the show the console is pointed at, and the
 *  Board's rows. The rows are fetched by the app rather than by the Board because the document
 *  title is the alerting story and must be right on a Run page too — an episode that starts
 *  waiting has to reach the tab of whatever page the operator is looking at. */
export interface ConsoleData {
  show: ShowInfo | null;
  showError: string | null;
  rows: EpisodeRow[] | null;
  rowsError: string | null;
  rowsLoading: boolean;
  refetchRows: () => void;
}

export const ConsoleContext = createContext<ConsoleData>({
  show: null, showError: null, rows: null, rowsError: null, rowsLoading: true, refetchRows: () => {},
});

export function useConsole(): ConsoleData {
  return useContext(ConsoleContext);
}
