import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import type { EpisodeRow, FailedShow, ShowInfo, ShowsList, SseMessage } from "../shared/types.js";

/** The client's one way of talking to the console's server: a fetch hook, a POST, one SSE channel
 *  shared by every page, and the context the app's chrome (the show's name and the Board's rows)
 *  is read through.
 *
 *  The server is the only origin this client talks to. There is no second base url, no api key and
 *  no retry policy beyond the SSE channel's reconnect: the console answers for every show on one
 *  machine, usually the same machine.
 *
 *  **Which show a request means is a segment of its url, not a mode this module holds.** Every api
 *  route lives under `/api/shows/<key>/` (ruling H-02: the key is the operator's, because the only
 *  identity fields a show config carries are `showName` and `showSlug` and the two shows this
 *  console was built against declare the same value for both), so `showPath` is the one place that
 *  spells that prefix and `useShowKey` is the one place that reads the key out of the url. The SSE
 *  channel is the exception: it stays one connection for every show, and each notice says which
 *  show it is about.
 *
 *  `useApi` and `useSSE` are ported from console v1 (`console/src/api.ts`), with two changes. The
 *  SSE channel is one `EventSource` for the whole app rather than one per hook, because the server
 *  holds a subscription per connection and a page with four hooks would hold four. And the
 *  messages are read from the default `message` event rather than from named ones: this server
 *  sends every notice as `data:` with no `event:` line, and the vocabulary is in the payload's own
 *  `type` (`shared/types.ts`'s `SseMessage`). */

/** `ShowInfo` is re-exported so a page can read one show's identity from the module it fetches
 *  through, rather than importing the type from one place and the hook from another. It is
 *  declared in `shared/types.ts` and not here: the server has a view model for it now
 *  (`server/app.ts`'s `showInfo`), answered by both `GET /api/shows` and `GET /api/shows/:show`,
 *  so a second client-side declaration would be a copy to keep in agreement rather than the
 *  client's own reading of an inline response. */
export type { ShowInfo };

/** The api address of one show, or of something beneath it: `showPath("HarborLight", "/episodes")`
 *  is `/api/shows/HarborLight/episodes`.
 *
 *  One function and not thirteen hand-built template strings, because every one of the client's
 *  calls moved under this prefix at once and the next route to move must have one place to change.
 *  The key is encoded and the suffix is not: the suffix is built by its caller, which has already
 *  encoded the episode and run ids it carries. */
export function showPath(show: string, suffix = ""): string {
  return `/api/shows/${encodeURIComponent(show)}${suffix}`;
}

/** The browser address of one show's page, or of something beneath it:
 *  `showHref("HarborLight", "/episodes/s02e01/runs/r1")` is
 *  `/shows/HarborLight/episodes/s02e01/runs/r1`.
 *
 *  Separate from `showPath` because the two prefixes are different strings that must stay in step
 *  — `/shows/<key>` is a route of `App.tsx` and `/api/shows/<key>` is a route of the server — and
 *  a single builder with a flag would be one place where a link could silently become a fetch. */
export function showHref(show: string, suffix = ""): string {
  return `/shows/${encodeURIComponent(show)}${suffix}`;
}

/** The api address of one show's bible, or of one file of it, or of something beneath that file:
 *  `biblePath("HarborLights")` is `/api/shows/HarborLights/bible`,
 *  `biblePath("HarborLights", "world-overview")` is `/api/shows/HarborLights/bible/world-overview`,
 *  and `biblePath("HarborLights", "world-overview", "/file")` adds the suffix.
 *
 *  Built on `showPath` rather than beside it, so the `/api/shows/<key>` prefix is still spelled in
 *  one place. It exists because the bible key is a **path segment** at six addresses (the view, the
 *  file, the answers, the runs, one run's gate) and encoding it at each of them is five chances to
 *  forget: the keys `BIBLE_FILES` names are all `[a-z0-9-]`, so a missed `encodeURIComponent` would
 *  work for every one of them and fail only if the table ever gained a key with a slash or a space
 *  in it — the kind of defect that is found years later. */
export function biblePath(show: string, key?: string, suffix = ""): string {
  return showPath(show, key === undefined ? "/bible" : `/bible/${encodeURIComponent(key)}${suffix}`);
}

/** The browser address of one show's Bible page, or of one file's panel on it. Separate from
 *  `biblePath` for the reason `showHref` is separate from `showPath`: `/shows/<key>/bible` is a
 *  route of `App.tsx` and `/api/shows/<key>/bible` is a route of the server, and one builder with a
 *  flag would be one place where a link could silently become a fetch. */
export function bibleHref(show: string, key?: string): string {
  return showHref(show, key === undefined ? "/bible" : `/bible/${encodeURIComponent(key)}`);
}

/** The key of the show the current page is looking at, read from the url's `:show` segment.
 *
 *  The key comes from the url and not from the fetched `ShowInfo` because it is needed on the
 *  first render, before any fetch has answered: the Run and Gate pages drop an SSE notice whose
 *  `show` is not theirs, and a filter that waited for a fetch would, for the length of that
 *  fetch, accept another show's notice about an identically-named run. Empty string on a page
 *  with no show segment, which is `/` and `/shows/new`. */
export function useShowKey(): string {
  return useParams()["show"] ?? "";
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
 *  refreshed by hand — and a malformed line must not take the connection down with it.
 *
 *  **`show` is required on `run`, `episodes` and `setup`, and a notice without it is dropped.**
 *  One channel carries every registered show's notices and two shows can each hold an `s02e01`
 *  (ruling H-12), so a notice that cannot say which show it is about is a notice no page can act
 *  on: taking it would have a Board re-read its whole show on another show's heartbeat and a Run
 *  page tail a log it is not drawing.
 *
 *  A `setup` notice is read by one page, the Bible view (`pages/Bible.tsx`): it refetches the rail
 *  for any key of its own show and the open file for its own key, and refuses to refetch a gate it
 *  is showing — a notice there raises a banner instead, because the attempt the author read is the
 *  attempt their answer carries.
 *
 *  A `hello` with one malformed entry in its `shows` list is dropped **whole** rather than filtered
 *  down to the readable entries, because a list with a hole in it would have the Shows page draw a
 *  console that is missing a show, which is worse than a Shows page that fetches the list itself.
 *  Its `failed` list — the registry entries the console holds and could not load — is validated the
 *  same way and by the same rule, and is a list of its own for exactly that reason: an entry whose
 *  `showrunner.json` would not read has no `showName`, so it could not satisfy the three fields
 *  above without the server inventing one.
 *
 *  Exported for `test/client/api-paths.test.ts`: the refusals above are the part of this module
 *  that fails silently, and a notice wrongly dropped looks exactly like a console whose channel is
 *  quiet. */
export function parseMessage(raw: string): SseMessage | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return undefined; }
  if (!isRecord(parsed)) return undefined;
  const type = parsed["type"];
  const show = parsed["show"];
  if (type === "episodes") {
    if (typeof show !== "string") return undefined;
    return { type: "episodes", show };
  }
  if (type === "hello") {
    const operator = parsed["operator"];
    const shows = parsed["shows"];
    const failedRaw = parsed["failed"];
    if (typeof operator !== "string" || !Array.isArray(shows) || !Array.isArray(failedRaw)) return undefined;
    const list: { key: string; showName: string; readOnly: boolean }[] = [];
    for (const entry of shows) {
      if (!isRecord(entry)) return undefined;
      const key = entry["key"];
      const showName = entry["showName"];
      const readOnly = entry["readOnly"];
      if (typeof key !== "string" || typeof showName !== "string" || typeof readOnly !== "boolean") return undefined;
      list.push({ key, showName, readOnly });
    }
    // The registry entries the console holds and could not load, validated by their own three
    // fields. They are a separate list and not rows of the one above precisely so this loop exists:
    // a show whose `showrunner.json` would not read has no `showName`, so folding it into `shows`
    // would mean either a synthesised name or relaxing the whole-drop rule the paragraph above
    // defends.
    const failed: FailedShow[] = [];
    for (const entry of failedRaw) {
      if (!isRecord(entry)) return undefined;
      const key = entry["key"];
      const root = entry["root"];
      const error = entry["error"];
      if (typeof key !== "string" || typeof root !== "string" || typeof error !== "string") return undefined;
      failed.push({ key, root, error });
    }
    return { type: "hello", operator, shows: list, failed };
  }
  if (type === "run") {
    const episodeId = parsed["episodeId"];
    const runId = parsed["runId"];
    const offset = parsed["offset"];
    if (typeof show !== "string" || typeof episodeId !== "string" || typeof runId !== "string" || typeof offset !== "number") return undefined;
    return { type: "run", show, episodeId, runId, offset };
  }
  if (type === "setup") {
    const key = parsed["key"];
    const runId = parsed["runId"];
    const offset = parsed["offset"];
    if (typeof show !== "string" || typeof key !== "string" || typeof runId !== "string" || typeof offset !== "number") return undefined;
    return { type: "setup", show, key, runId, offset };
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

/** Every registered show, as the Shows page lists them, **and every registry entry this console
 *  could not load**: `GET /api/shows`.
 *
 *  This is the Shows page's hook and no other page's. A page that is looking at one show reads
 *  that show's own `ShowInfo` out of `ConsoleContext` — fetched once by the `/shows/:show` layout
 *  from `GET /api/shows/<key>`, which carries the same nine fields — rather than fetching every
 *  show on the machine to answer a question about one of them.
 *
 *  `failed` is beside `shows` and not inside it, because an entry whose `showrunner.json` would not
 *  read has no `showName` to list it under (`shared/types.ts`'s `FailedShow` carries the argument).
 *  Both lists matter to this page: a key in either one is a key the server will refuse to register
 *  again, and a console with three entries and two shows has to say so rather than drawing two. */
export function useShows(): ApiState<ShowsList> {
  return useApi<ShowsList>("/api/shows");
}

/** What every page beneath `/shows/:show` can read without fetching it again: the show it is
 *  looking at, and that show's Board rows. The rows are fetched by the layout rather than by the
 *  Board because the document title is the alerting story and must be right on a Run page too —
 *  an episode that starts waiting has to reach the tab of whatever page the operator is looking
 *  at.
 *
 *  `show` is the whole `ShowInfo` and that is what carries `readOnly`, which is why no page needs
 *  a second request to know whether to draw a button the server would refuse. */
export interface ConsoleData {
  show: ShowInfo | null;
  showError: string | null;
  /** **Whether to offer a move at all: the show has answered and may be written to.** False while
   *  `GET /api/shows/<key>` is still in flight, so a show that turns out to be read-only never had
   *  a Launch button for the length of a fetch.
   *
   *  Derived once, in the layout that fetched the show, because the five places that draw an
   *  action — the Board's launch and continue, the Run page's withdraw, the Gate page's answer,
   *  the action bar, the What-happened question — must agree about it exactly: a page that
   *  computed it differently would offer a POST the server answers 403. */
  canAct: boolean;
  /** **Whether to say why a move is not offered: the show has answered and said it is read-only.**
   *  Not the negation of `canAct`: while the show is in flight, and for a key this console does
   *  not hold, both are false — because a show that has not answered is not a show that has told
   *  anyone it is read-only, and a Board that said "nosuchshow is read-only" would be explaining a
   *  show that does not exist. */
  readOnly: boolean;
  rows: EpisodeRow[] | null;
  rowsError: string | null;
  rowsLoading: boolean;
  refetchRows: () => void;
}

export const ConsoleContext = createContext<ConsoleData>({
  show: null, showError: null, canAct: false, readOnly: false,
  rows: null, rowsError: null, rowsLoading: true, refetchRows: () => {},
});

export function useConsole(): ConsoleData {
  return useContext(ConsoleContext);
}
