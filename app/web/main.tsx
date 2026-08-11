import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './chrome/chrome.css'
import { Shell, type Screens } from './chrome/Shell.tsx'
import { EpisodeRoom } from './screens/EpisodeRoom.tsx'
import { Floor } from './screens/Floor.tsx'
import { GateRoom } from './screens/GateRoom.tsx'

/**
 * The cockpit boots into the shell, and the shell keeps the old page (E5-0, #80).
 *
 * `screens` is where a room stops being a stub. E5-1 (#81) registers the first one — the
 * floor, which is the home screen and answers at `/` — and E5-2..5 add theirs here, one
 * issue at a time. A room's id is `server/cockpit.ts`'s, so registering a screen and
 * marking it `built` are the same fact said in two files and nowhere else.
 *
 * `scaffolding` is the bare-bones operating page E1-8 built and four epics grew, mounted at
 * its own address so that nothing E1–E4 made stops being reachable while the cockpit is
 * built beside it. #86 is where it retires, and `server/cockpit.ts` says so on the door.
 */
const SCREENS: Screens = {
  floor: (props) => <Floor {...props} />,
  'episode-room': (props) => <EpisodeRoom {...props} />,
  // `/gate` is the thin index of what is open and `/gate/<id>` is one gate whole — a room
  // about one thing answering at its bare address too, which is `router.ts`'s own rule.
  'gate-room': (props) => <GateRoom {...props} />,
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Shell screens={SCREENS} scaffolding={<App />} />
  </StrictMode>,
)
