import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { App } from './App.tsx'

describe('the hello page', () => {
  it('renders before the API has answered, without pretending it has', () => {
    const html = renderToString(<App />)

    expect(html).toContain('Showrunner')
    expect(html).toContain('The API has not answered yet.')
  })
})
