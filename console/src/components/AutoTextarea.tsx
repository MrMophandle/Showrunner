import { useEffect, useRef } from "react";

/** A textarea that grows with what is typed into it, up to a cap. Ported from console v1's
 *  `AutoTextarea`.
 *
 *  It exists for one field: the gate's notes. A rejection note is the instruction a fix agent
 *  will act on, and a three-line box that scrolls its own first line out of sight is a box that
 *  invites one-line notes. Past the cap it scrolls, because a notes field tall enough to push the
 *  Approve and Reject buttons off an iPad's screen is worse than one that scrolls. */

/** How tall the field may grow, in pixels. */
const MAX_HEIGHT = 420;

export interface AutoTextareaProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  id?: string;
}

export function AutoTextarea({ value, onChange, placeholder, rows = 3, id }: AutoTextareaProps) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  // Re-measured on every value change, including the ones that come from outside — the contact
  // sheet composes a rejection note into this field, and a field that only grew on keystrokes
  // would show six flagged shots as a three-line box.
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    el.style.height = "auto";
    const wanted = Math.min(el.scrollHeight, MAX_HEIGHT);
    el.style.height = `${wanted}px`;
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
  }, [value]);

  return (
    <textarea
      ref={ref}
      className="auto-textarea"
      rows={rows}
      value={value}
      {...(id !== undefined ? { id } : {})}
      {...(placeholder !== undefined ? { placeholder } : {})}
      onChange={(e) => { onChange(e.target.value); }}
    />
  );
}
