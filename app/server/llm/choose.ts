import { createAnthropicAdapter } from './anthropic.ts'
import { createClaudeCliAdapter } from './cli.ts'
import { lazyLLM, LLM_BACKEND, type LLMAdapter, type LLMBackend } from './adapter.ts'

/**
 * Which of D6's two backends this process talks to. A two-branch `if`, not a plugin
 * registry — there are two backends, both are TypeScript in this directory, and adding a
 * third would be a code change with a test.
 */

/** Set it to `anthropic-api` or `claude-cli`. Unset, the rule below decides. */
export const LLM_BACKEND_ENV = 'SHOWRUNNER_LLM_BACKEND'

/**
 * The chosen backend, built lazily: naming one is free, constructing an API client is
 * not, and a process with no credentials still has plenty of non-LLM work to do. The
 * complaint arrives at the first call, where it belongs, instead of at boot.
 *
 * Unset, the default follows the credentials: an API key in the environment means the
 * key is meant to be used; without one, the `claude` CLI is what Ryan is signed into.
 */
export function chooseLLMAdapter(env: NodeJS.ProcessEnv = process.env): LLMAdapter {
  const backend = backendFrom(env)
  return lazyLLM(backend, () =>
    backend === 'anthropic-api' ? createAnthropicAdapter() : createClaudeCliAdapter(),
  )
}

export function backendFrom(env: NodeJS.ProcessEnv = process.env): LLMBackend {
  const named = env[LLM_BACKEND_ENV]?.trim()
  if (named === undefined || named === '') {
    return env['ANTHROPIC_API_KEY'] ? 'anthropic-api' : 'claude-cli'
  }
  if (!(LLM_BACKEND as readonly string[]).includes(named)) {
    throw new Error(
      `${LLM_BACKEND_ENV} is "${named}", which is not a backend — it is one of ${LLM_BACKEND.join(', ')}`,
    )
  }
  return named as LLMBackend
}
