import { describe, expect, it } from 'vitest'
import { backendFrom, chooseLLMAdapter, LLM_BACKEND_ENV } from './choose.ts'

/** Which of D6's two backends a process talks to, and what decides it. */

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
