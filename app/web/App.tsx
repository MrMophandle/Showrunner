import { useEffect, useState } from 'react'

interface Health {
  status: string
  library: { root: string; databaseFile: string; artifactDir: string }
}

/**
 * The hello page. Deliberately plain — the eight screens are E5's, and this one
 * exists only to prove the container serves the SPA, the API answers, and the
 * event stream reaches the browser.
 */
export function App() {
  const [health, setHealth] = useState<Health | null>(null)
  const [ticks, setTicks] = useState<string[]>([])

  useEffect(() => {
    fetch('/api/health')
      .then((res) => res.json())
      .then(setHealth)
      .catch(() => setHealth(null))
  }, [])

  useEffect(() => {
    const events = new EventSource('/api/events')
    events.addEventListener('hello', (event) => setTicks([`hello — ${event.data}`]))
    events.addEventListener('tick', (event) => setTicks((prior) => [...prior, `tick ${event.data}`]))
    return () => events.close()
  }, [])

  return (
    <main style={{ fontFamily: 'ui-monospace, monospace', lineHeight: 1.6, padding: '2rem', maxWidth: '48rem' }}>
      <h1>Showrunner</h1>
      <p>The container is up and serving on :4400. Nothing here is a feature yet — this is E1-1, the scaffold.</p>

      <h2>Library volume</h2>
      {health ? (
        <ul>
          <li>root: {health.library.root}</li>
          <li>database: {health.library.databaseFile}</li>
          <li>artifacts: {health.library.artifactDir}</li>
        </ul>
      ) : (
        <p>The API has not answered yet.</p>
      )}

      <h2>Event stream (stub)</h2>
      <ol>
        {ticks.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ol>
    </main>
  )
}
