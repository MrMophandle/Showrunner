import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { backendFrom, chooseLLMAdapter, describeLLMBackend, LLM_BACKEND_ENV } from './choose.ts'

/** Which of D6's two backends a process talks to, what decides it, and whether it works. */

describe('choosing a backend', () => {
  it('does what the environment says, when the environment says', () => {
    expect(backendFrom({ [LLM_BACKEND_ENV]: 'claude-cli', ANTHROPIC_API_KEY: 'sk-ant-x' })).toBe(
      'claude-cli',
    )
    expect(backendFrom({ [LLM_BACKEND_ENV]: 'anthropic-api' })).toBe('anthropic-api')
  })

  it('follows the credentials when it is not told', () => {
    // A key in the environment is a key that is meant to be used; without one, the CLI is
    // what Ryan is signed into.
    expect(backendFrom({ ANTHROPIC_API_KEY: 'sk-ant-x' })).toBe('anthropic-api')
    expect(backendFrom({})).toBe('claude-cli')
    expect(backendFrom({ [LLM_BACKEND_ENV]: '  ' })).toBe('claude-cli')
  })

  it('refuses a backend that does not exist, and names the ones that do', () => {
    expect(() => backendFrom({ [LLM_BACKEND_ENV]: 'ollama' })).toThrow(
      /not a backend — it is one of anthropic-api, claude-cli/,
    )
  })

  it('names its backend without building it', () => {
    // Every runner constructs one of these, in every test. None may reach for a
    // credential or open a socket on the way.
    expect(chooseLLMAdapter({ ANTHROPIC_API_KEY: 'sk-ant-x' }).backend).toBe('anthropic-api')
    expect(chooseLLMAdapter({}).backend).toBe('claude-cli')
  })
})

/**
 * The half found by booting the container (issue #9, amended Aug 5 2026): it reported
 * `claude-cli` and could not make a single call, because the image has no `claude` binary
 * and compose passed no key through. Naming a backend is not the same as being able to
 * reach one, and the difference used to surface mid-run, inside a step.
 *
 * PATH is a real temp directory with a real executable bit in it rather than a mock —
 * what is being tested is a filesystem question, and a stubbed `existsSync` would prove
 * the stub.
 */
describe('verifying the backend it picked', () => {
  let binDir: string

  beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), 'showrunner-path-'))
  })

  afterEach(() => {
    rmSync(binDir, { recursive: true, force: true })
  })

  /** A `claude` on PATH, executable, exactly as an installed Claude Code looks. */
  function installClaude(): string {
    const at = join(binDir, 'claude')
    writeFileSync(at, '#!/bin/sh\nexit 0\n', 'utf8')
    chmodSync(at, 0o755)
    return at
  }

  it('says the API is ready when a key is there, without claiming the key works', () => {
    const standing = describeLLMBackend({ ANTHROPIC_API_KEY: 'sk-ant-x', PATH: binDir })

    expect(standing.backend).toBe('anthropic-api')
    expect(standing.ready).toBe(true)
    expect(standing.chosenBy).toBe('ANTHROPIC_API_KEY is set, so the API')
    // Invariant 4: a present key is not a green checkmark, and the sentence says so.
    expect(standing.sentence).toContain('only knowable by spending money')
  })

  it('finds the CLI on PATH and names where it found it', () => {
    const at = installClaude()
    const standing = describeLLMBackend({ PATH: binDir })

    expect(standing.backend).toBe('claude-cli')
    expect(standing.ready).toBe(true)
    expect(standing.sentence).toContain(at)
  })

  it('a file on PATH that is not executable is not a CLI', () => {
    const at = join(binDir, 'claude')
    writeFileSync(at, 'not a program', 'utf8')
    chmodSync(at, 0o644)

    expect(describeLLMBackend({ PATH: binDir }).ready).toBe(false)
  })

  it('reports the container: claude-cli chosen, no binary, no key, and what to do', () => {
    // The exact state `docker compose up` was in on Aug 5, and the reason this exists.
    const standing = describeLLMBackend({ PATH: binDir })

    expect(standing).toMatchObject({ backend: 'claude-cli', ready: false })
    expect(standing.chosenBy).toBe('no ANTHROPIC_API_KEY in the environment, so the CLI')
    expect(standing.sentence).toContain('no `claude` executable on PATH')
    expect(standing.sentence).toContain('Nothing in this process can reach a model')
    expect(standing.sentence).toContain('Export ANTHROPIC_API_KEY')
  })

  it('never re-picks — an explicit choice that cannot work is reported, not overridden', () => {
    // A key is right there. `SHOWRUNNER_LLM_BACKEND` still means what it says, and the
    // sentence points at the one line that would use the key instead of quietly using it.
    const standing = describeLLMBackend({
      [LLM_BACKEND_ENV]: 'claude-cli',
      ANTHROPIC_API_KEY: 'sk-ant-x',
      PATH: binDir,
    })

    expect(standing.backend).toBe('claude-cli')
    expect(standing.ready).toBe(false)
    expect(standing.chosenBy).toBe('SHOWRUNNER_LLM_BACKEND=claude-cli')
    expect(standing.sentence).toContain('set SHOWRUNNER_LLM_BACKEND=anthropic-api to use it')
  })

  it('points at the CLI when the API was asked for and no key is set', () => {
    const at = installClaude()
    const standing = describeLLMBackend({ [LLM_BACKEND_ENV]: 'anthropic-api', PATH: binDir })

    expect(standing.ready).toBe(false)
    expect(standing.sentence).toContain(`CLI is on PATH at ${at}`)
  })
})
