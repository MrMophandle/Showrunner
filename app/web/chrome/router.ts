import { useEffect, useState, type MouseEvent } from 'react'

/**
 * The cockpit's routing, in forty lines and no dependency (E5-0, #80).
 *
 * ── Why not a router library ────────────────────────────────────────────────────
 * Because this app has nine addresses, no nesting, no loaders, no lazy chunks and one
 * user. A routing library would be a runtime dependency carrying features for a problem
 * we do not have, and #80 says a new one needs an argued case. This is the argument
 * against: `history.pushState`, one `popstate` listener, and a path split on `/`.
 *
 * ── What the server already does for this ───────────────────────────────────────
 * `app.ts` serves `index.html` for every non-API path and 404s anything under `/api/*`
 * rather than falling through to the shell. So a hard refresh on `/canon` and a typed
 * `/gate/gate-abc` both arrive here, and an API typo is still an honest 404 rather than a
 * 200 with a page in it. Nothing changed on the server for routing.
 *
 * ── Addresses, not patterns ─────────────────────────────────────────────────────
 * A room about one thing answers at its bare address too — `/episode` and
 * `/episode/<id>` are the same room, one of them holding an id. That is what lets every
 * destination in the shell's bar be a real link with nothing to fill in first, and it is
 * why matching is "does the first segment agree" rather than a pattern language.
 */

/** Where we are: the first path segment, and whatever it was holding. */
export interface Located {
  /** "" for the floor, otherwise "episode", "gate", "canon", … or "operating". */
  head: string
  /** The id after it, or null. The shell hands it to the screen; nothing here reads it. */
  rest: string | null
  path: string
}

export function locate(path: string): Located {
  const [head = '', rest] = path.replace(/^\/+/, '').split('/')
  return { head, rest: rest === undefined || rest === '' ? null : decodeURIComponent(rest), path }
}

/**
 * Where the browser is now, and re-rendered when it moves — including on Back, which is
 * what `popstate` is for. A cockpit whose back button did nothing would be its own kind
 * of "go and find it again".
 */
export function useLocation(): Located {
  const [path, setPath] = useState(() => window.location.pathname)

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname)
    window.addEventListener('popstate', onPop)
    // Somebody else's `navigate` in this same document, in a component that is not an
    // ancestor of this one. One event, so the shell and a screen cannot disagree.
    window.addEventListener(MOVED, onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      window.removeEventListener(MOVED, onPop)
    }
  }, [])

  return locate(path)
}

const MOVED = 'showrunner:moved'

/**
 * Go somewhere, without a page load. A click, never a redirect: nothing in this app
 * navigates on its own (invariant 5's sibling — a screen that moved by itself would be
 * the page moving under him, one level up).
 */
export function navigate(path: string): void {
  if (path === window.location.pathname) return
  window.history.pushState(null, '', path)
  window.dispatchEvent(new Event(MOVED))
}

/**
 * What an `<a>` in the cockpit does. A real anchor with a real `href` — so it is a real
 * link to a keyboard, a screen reader, and a middle click — that skips the page load when
 * the browser would have done one anyway.
 */
export function onLinkClick(path: string): (event: MouseEvent<HTMLAnchorElement>) => void {
  return (event) => {
    if (event.defaultPrevented || event.button !== 0) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    navigate(path)
  }
}
