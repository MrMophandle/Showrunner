import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './chrome/chrome.css'
import { Shell } from './chrome/Shell.tsx'

/**
 * The cockpit boots into the shell, and the shell keeps the old page (E5-0, #80).
 *
 * `screens` is empty because E5-0 builds no screen — every room is an honest stub until
 * E5-1..5 register theirs here, one issue at a time. `scaffolding` is the bare-bones
 * operating page E1-8 built and four epics grew, mounted at its own address so that
 * nothing E1–E4 made stops being reachable while the cockpit is built beside it. #86 is
 * where it retires, and `server/cockpit.ts` says so on the door.
 */
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Shell screens={{}} scaffolding={<App />} />
  </StrictMode>,
)
