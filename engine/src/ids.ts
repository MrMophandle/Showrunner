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
  const a = AIRED.exec(raw);
  if (a) {
    const season = Number(a[1]);
    const episode = Number(a[2]);
    if (season === 0 || episode === 0) throw new InvalidEpisodeId(raw, "season and episode start at 1");
    return { kind: "aired", season, episode, raw };
  }
  const p = PRODUCTION.exec(raw);
  if (p) return { kind: "production", number: Number(p[1]), raw };
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

export function formatAired(season: number, episode: number): string {
  if (!Number.isInteger(season) || season < 1 || season > 99) throw new InvalidEpisodeId(String(season), "season must be 1..99");
  if (!Number.isInteger(episode) || episode < 1 || episode > 99) throw new InvalidEpisodeId(String(episode), "episode must be 1..99");
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
