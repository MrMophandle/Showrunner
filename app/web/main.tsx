import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './chrome/chrome.css'
import { Shell, type Screens } from './chrome/Shell.tsx'
import { ArcPage } from './screens/ArcPage.tsx'
import { CanonLibrary } from './screens/CanonLibrary.tsx'
import { EpisodeRoom } from './screens/EpisodeRoom.tsx'
import { Floor } from './screens/Floor.tsx'
import { GateRoom } from './screens/GateRoom.tsx'
import { SeasonMap } from './screens/SeasonMap.tsx'

/**
 * The cockpit boots into the shell, and the shell is now the whole app (E5-0, #80).
 *
 * `screens` is where a room stops being a stub. E5-1 (#81) registered the first one — the
 * floor, which is the home screen and answers at `/` — and E5-2..5 added theirs here, one
 * issue at a time. A room's id is `server/cockpit.ts`'s, so registering a screen and
 * marking it `built` are the same fact said in two files and nowhere else.
 *
 * **E5-5 (#85) is the last of them**: six of the eight are registered above, and the two that
 * are not are E6's — the review desk and the screening room, which have nothing to render
 * because nothing generates an image or assembles a cut yet. They say so at their addresses
 * rather than 404ing, which is what `Shell.tsx`'s `Room` is for.
 *
 * **The `scaffolding` prop is gone with E5-6 (#86).** The bare-bones operating page E1-8
 * built and four epics grew was mounted here, at `/operating`, so that nothing E1–E4 made
 * stopped being reachable while the cockpit was built beside it. Every door it held now
 * stands on one of the six screens above, asserted there before the page came down. The
 * reads it composed are untouched and so is `GET /api/operating` — what retired is the
 * render, not the record.
 */
const SCREENS: Screens = {
  floor: (props) => <Floor {...props} />,
  'episode-room': (props) => <EpisodeRoom {...props} />,
  // `/gate` is the thin index of what is open and `/gate/<id>` is one gate whole — a room
  // about one thing answering at its bare address too, which is `router.ts`'s own rule.
  'gate-room': (props) => <GateRoom {...props} />,
  // `/canon` is the whole bible and `/canon/<entity>` is one sheet open in it, so every name
  // on every other screen has an address to link to.
  'canon-library': (props) => <CanonLibrary {...props} />,
  // `/season` is whichever season the bar's link lands on and `/season/<id>` is a named one.
  // Neither picks silently: the map carries every season in the library with one marked.
  'season-map': (props) => <SeasonMap {...props} />,
  // `/arc/<id>` is one arc. An arc page with no arc has genuinely nothing on it, so the bare
  // address is the LIST of every arc in the library — a door in this cockpit is never a dead
  // end, and the bar carries `/arc`.
  'arc-page': (props) => <ArcPage {...props} />,
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Shell screens={SCREENS} />
  </StrictMode>,
)
