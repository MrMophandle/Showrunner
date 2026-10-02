export class InvalidEpisodeId extends Error {
  constructor(raw: string, reason: string) {
    super(`invalid episode id ${JSON.stringify(raw)}: ${reason}`);
    this.name = "InvalidEpisodeId";
  }
}

export type EpisodeId =
  | { kind: "aired"; season: number; episode: number; raw: string }
  | { kind: "production"; number: number; raw: string };

const AIRED = /^s(\d{2})e(\d{2})$/;
const PRODUCTION = /^ep(\d{2})$/;

export function parseEpisodeId(raw: string): EpisodeId {
  // A runtime guard, not only a compile-time one: this is the boundary an id crosses on its way
  // to a filesystem path, and the caller may be handing over unvalidated JSON or argv.
  if (typeof raw !== "string") throw new InvalidEpisodeId(String(raw), "not a string");
  const a = AIRED.exec(raw);
  if (a) {
    const season = Number(a[1]);
    const episode = Number(a[2]);
    if (season === 0 || episode === 0) throw new InvalidEpisodeId(raw, "season and episode start at 1");
    return { kind: "aired", season, episode, raw };
  }
  const p = PRODUCTION.exec(raw);
  if (p) {
    const number = Number(p[1]);
    if (number === 0) throw new InvalidEpisodeId(raw, "production numbers start at 1");
    return { kind: "production", number, raw };
  }
  throw new InvalidEpisodeId(raw, "expected sXXeYY (aired) or epNN (production)");
}

export function isEpisodeId(raw: string): boolean {
  try {
    parseEpisodeId(raw);
    return true;
  } catch {
    return false;
  }
}

/** The aired id for a season and episode number, zero-padded. A number out of range throws a
 *  plain Error naming the parameter, not InvalidEpisodeId: the caller passed two numbers, not an
 *  id, and `invalid episode id "0": season must be 1..99` would quote a number as though it were
 *  the id it failed to build. InvalidEpisodeId stays for the real ids parseEpisodeId refuses. */
export function formatAired(season: number, episode: number): string {
  if (!Number.isInteger(season) || season < 1 || season > 99) throw new Error(`invalid season ${season}: season must be 1..99`);
  if (!Number.isInteger(episode) || episode < 1 || episode > 99) throw new Error(`invalid episode ${episode}: episode must be 1..99`);
  return `s${String(season).padStart(2, "0")}e${String(episode).padStart(2, "0")}`;
}

export function compareEpisodeIds(a: EpisodeId, b: EpisodeId): number {
  if (a.kind !== b.kind) return a.kind === "aired" ? -1 : 1;
  if (a.kind === "aired" && b.kind === "aired") {
    return a.season - b.season || a.episode - b.episode;
  }
  if (a.kind === "production" && b.kind === "production") return a.number - b.number;
  return 0;
}
