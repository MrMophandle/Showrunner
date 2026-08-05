import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'
import { createAnthropicAdapter } from './anthropic.ts'
import { CLAUDE_CLI_COMMAND, createClaudeCliAdapter } from './cli.ts'
import { lazyLLM, LLM_BACKEND, type LLMAdapter, type LLMBackend } from './adapter.ts'

/**
 * Which of D6's two backends this process talks to, and whether it can reach a model at
 * all. Two questions, and the second one is the one that bit.
 *
 * A two-branch `if`, not a plugin registry — there are two backends, both are TypeScript
 * in this directory, and adding a third would be a code change with a test.
 *
 * ── Why selection verifies what it picked ───────────────────────────────────────
 * Found by booting the container against `main` on Aug 5 2026: it printed
 * `LLM backend: claude-cli` and could not make a single call. The rule below is right on
 * Ryan's Mac — no key, a CLI he is signed into — and wrong inside the image, which has
 * neither. Nothing noticed. The failure landed on the first LLM call, inside a step,
 * mid-run: the most expensive place in the app to find out.
 *
 * So `describeLLMBackend` names the backend AND says whether there is anything there to
 * call, in words, at boot and on `/api/health`. It never re-picks: a process quietly
 * using a backend other than the one it was told to use would be a second kind of lie,
 * and `SHOWRUNNER_LLM_BACKEND` means what it says. Neither backend available is a
 * legitimate state — it is reported, not crashed on, because everything in this app that
 * is not a model call still works.
 *
 * ── What `ready` does not mean ──────────────────────────────────────────────────
 * It costs nothing and it proves presence, not reach: a key that is set may be revoked,
 * and a CLI on PATH may be logged out. `ready` means "there is something here to call
 * with", and the sentence says exactly that rather than "connected" (invariant 4 —
 * never render a weak check as a green checkmark).
 */

/** Set it to `anthropic-api` or `claude-cli`. Unset, the rule below decides. */
export const LLM_BACKEND_ENV = 'SHOWRUNNER_LLM_BACKEND'

/**
 * The one credential this app looks for. It is deliberately the same variable the default
 * rule keys off and the same one `docker-compose.yml` passes through, so "the key that
 * chooses the backend" and "the key that makes it work" can never be two different keys.
 */
export const API_KEY_ENV = 'ANTHROPIC_API_KEY'

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
    return env[API_KEY_ENV] ? 'anthropic-api' : 'claude-cli'
  }
  if (!(LLM_BACKEND as readonly string[]).includes(named)) {
    throw new Error(
      `${LLM_BACKEND_ENV} is "${named}", which is not a backend — it is one of ${LLM_BACKEND.join(', ')}`,
    )
  }
  return named as LLMBackend
}

// ── Can it reach a model? ───────────────────────────────────────────────────────

/** What the health strip renders, and what a blocked launch button says instead of a cost. */
export interface LLMReadiness {
  backend: LLMBackend
  /** Something is here to call with. Not proof that a call would succeed — see the header. */
  ready: boolean
  /** "Anthropic API", "claude CLI" — the backend in the words the mockup's tile uses. */
  label: string
  /** What picked it: the env var, or the default rule, in words. */
  chosenBy: string
  /** What it can reach, or what is missing and what to do about it. One sentence. */
  sentence: string
}

const BACKEND_LABEL: Readonly<Record<LLMBackend, string>> = {
  'anthropic-api': 'Anthropic API',
  'claude-cli': 'claude CLI',
}

/**
 * The backend this process would use, and whether anything is behind it. Cheap enough to
 * answer on every `/api/health` — one environment read and, for the CLI, a walk of PATH —
 * and deliberately not cached: a boot-time snapshot would still be saying "ready" after
 * somebody deleted the binary out from under it.
 */
export function describeLLMBackend(env: NodeJS.ProcessEnv = process.env): LLMReadiness {
  const backend = backendFrom(env)
  const key = env[API_KEY_ENV]?.trim()
  const cli = findOnPath(CLAUDE_CLI_COMMAND, env)

  const named = env[LLM_BACKEND_ENV]?.trim()
  const chosenBy =
    named === undefined || named === ''
      ? key
        ? `${API_KEY_ENV} is set, so the API`
        : `no ${API_KEY_ENV} in the environment, so the CLI`
      : `${LLM_BACKEND_ENV}=${named}`

  const readiness = (ready: boolean, sentence: string): LLMReadiness => ({
    backend,
    ready,
    label: BACKEND_LABEL[backend],
    chosenBy,
    sentence,
  })

  if (backend === 'anthropic-api') {
    if (key) {
      return readiness(
        true,
        `A key is in ${API_KEY_ENV}, so there is something to call. Whether it still works ` +
          'is only knowable by spending money, and nothing here has.',
      )
    }
    return readiness(
      false,
      `${API_KEY_ENV} is empty or unset in this process, so there is no key to call the ` +
        `Anthropic API with. ${remedy(false, cli)}`,
    )
  }

  if (cli) {
    return readiness(
      true,
      `The \`${CLAUDE_CLI_COMMAND}\` binary is at ${cli}, so there is something to run. ` +
        'Whether that session is still signed in is only knowable by spending money, and ' +
        'nothing here has.',
    )
  }
  return readiness(
    false,
    `There is no \`${CLAUDE_CLI_COMMAND}\` executable on PATH, so the CLI backend has ` +
      'nothing to run — which is what a container built from this repo\'s Dockerfile ' +
      `looks like. ${remedy(Boolean(key), cli)}`,
  )
}

/** What to do about it. Naming the backend that WOULD work is the useful half of the news. */
function remedy(hasKey: boolean, cli: string | undefined): string {
  if (hasKey) {
    return `A key is in ${API_KEY_ENV}: set ${LLM_BACKEND_ENV}=anthropic-api to use it.`
  }
  if (cli) {
    return `The \`${CLAUDE_CLI_COMMAND}\` CLI is on PATH at ${cli}: set ${LLM_BACKEND_ENV}=claude-cli to use it.`
  }
  return (
    'Nothing in this process can reach a model, and every step that calls one will fail. ' +
    `Export ${API_KEY_ENV} before \`docker compose up\` — compose passes it through — or ` +
    'run the app outside the container, where the CLI is signed in.'
  )
}

/**
 * Where an executable named `command` is, or undefined. A hand-rolled `which`, because
 * shelling out to one would spawn a process on every health check and would itself depend
 * on a binary being present.
 */
function findOnPath(command: string, env: NodeJS.ProcessEnv): string | undefined {
  if (command.includes('/')) return executable(command) ? command : undefined
  for (const dir of (env['PATH'] ?? '').split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, command)
    if (executable(candidate)) return candidate
  }
  return undefined
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}
