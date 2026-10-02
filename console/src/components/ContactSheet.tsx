import { useApi, type DirEntry } from "../api.js";

/** A directory of images as a contact sheet, with a flag per shot. Ported from console v1's
 *  `ContactSheet`, with v1's scene grouping dropped — v1 had a shot list to group by, and a gate
 *  has a directory listing. The sheet is in filename order, which for shots named by scene and
 *  beat is the order the episode plays in.
 *
 *  The flags are the re-roll path. `image-gate` and `nano-banana-gate` both ask "are these the
 *  shots?", and the answer that is not "yes" is "these ones again, for this reason" — so flagging
 *  a shot here composes a line of the rejection note (`projections.ts`'s
 *  `composeShotRejection`), and the Gate page owns the note. This component owns no text: it
 *  reports the flag set upward and is handed the current one back, so the notes field has exactly
 *  one owner.
 *
 *  Images are not lazily loaded and not thumbnailed: a shot list is forty PNGs from one directory
 *  on the same machine, and a judgment about whether a face reads at distance cannot be made from
 *  a thumbnail. */

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"];

function isImage(name: string): boolean {
  const lower = name.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** The shot id a filename carries: the name without its extension, which is what the pipeline's
 *  shot ids are and what a rejection note has to name for the fix agent to find the shot. */
export function shotIdOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? name : name.slice(0, dot);
}

export interface ContactSheetProps {
  /** The directory's url; each entry is this plus "/" plus its encoded name. */
  url: string;
  listUrl: string;
  /** Shot id → the operator's reason, empty string for a shot flagged without one. */
  flags: Record<string, string>;
  onFlagsChange: (next: Record<string, string>) => void;
  /** Absent on a page with no rejection to compose — a Run page showing a finished gate. */
  readOnly?: boolean;
}

export function ContactSheet({ url, listUrl, flags, onFlagsChange, readOnly = false }: ContactSheetProps) {
  const listing = useApi<{ entries: DirEntry[] }>(listUrl);

  if (listing.error !== null && listing.data === null) {
    return <p className="error-line">could not list this directory: {listing.error}</p>;
  }
  if (listing.data === null) return <p className="quiet">reading the directory…</p>;

  const entries = [...listing.data.entries].sort((a, b) => a.name.localeCompare(b.name));
  const images = entries.filter((e) => !e.isDir && isImage(e.name));
  const others = entries.filter((e) => !e.isDir && !isImage(e.name));
  const dirs = entries.filter((e) => e.isDir);

  function toggle(id: string): void {
    const next = { ...flags };
    if (id in next) delete next[id];
    else next[id] = "";
    onFlagsChange(next);
  }

  function setNote(id: string, note: string): void {
    onFlagsChange({ ...flags, [id]: note });
  }

  if (images.length === 0) {
    return (
      <div className="contact-sheet-empty">
        <p className="quiet">no images in this directory yet</p>
        {others.length > 0 && <p className="quiet mono">{others.map((e) => e.name).join("  ")}</p>}
      </div>
    );
  }

  return (
    <div className="contact-sheet">
      <div className="image-grid">
        {images.map((entry) => {
          const id = shotIdOf(entry.name);
          const flagged = id in flags;
          const src = `${url}/${encodeURIComponent(entry.name)}`;
          return (
            <div className={`shot${flagged ? " shot-flagged" : ""}`} key={entry.name}>
              <a className="shot-frame" href={src} target="_blank" rel="noreferrer noopener">
                <img src={src} alt={id} loading="eager" />
              </a>
              <div className="shot-foot">
                <span className="shot-id mono">{id}</span>
                {!readOnly && (
                  <button
                    type="button"
                    className={`btn shot-flag${flagged ? " shot-flag-on" : ""}`}
                    aria-pressed={flagged}
                    onClick={() => { toggle(id); }}
                  >
                    {flagged ? "flagged" : "flag"}
                  </button>
                )}
              </div>
              {flagged && !readOnly && (
                <input
                  className="shot-note"
                  type="text"
                  placeholder="what is wrong with it (optional — blank means redo)"
                  value={flags[id] ?? ""}
                  onChange={(e) => { setNote(id, e.target.value); }}
                />
              )}
            </div>
          );
        })}
      </div>
      {(others.length > 0 || dirs.length > 0) && (
        <p className="quiet mono contact-sheet-others">
          also in this directory: {[...dirs.map((d) => `${d.name}/`), ...others.map((o) => o.name)].join("  ")}
        </p>
      )}
    </div>
  );
}
