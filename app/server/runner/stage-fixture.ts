import { FREE } from '../cost.ts'
import { episodeLabel } from '../domain/spine.ts'
import type { Stage, StageOffer, StageWork, Step } from './step.ts'

/**
 * **A stage assembled for a test or a fixture** — one no button will ever render.
 *
 * `Stage` requires a declaration (`offerOn`, step.ts) and requires it on purpose: the refusal
 * in front of every run consults what the stage says it spends, and a stage that could omit
 * that would be back to being guessed about. But a test that wants "a stage with one step that
 * throws" is not making a claim about money, and writing a button sentence for it would put
 * prose nobody reads into fifteen test files.
 *
 * So the scaffolding says what it is. The declaration below is honest about being scaffolding
 * — its sentence names itself as such — and `callsModel: false` is the true answer for a step
 * that a test scripts by hand. **Nothing in the catalogue may use this.** The five shipped
 * stages each declare their own, in the file where the stage is written, and the test that
 * would notice one slipping through is `stages.test.ts`'s roll-call over the catalogue.
 */
export function scaffoldStage(
  name: string,
  steps: readonly Step[],
  work: StageWork = 'produces',
): Stage {
  return {
    name,
    work,
    steps,
    offerOn: (_store, episode): StageOffer => ({
      sentence: `Run the ${name} scaffolding on ${episodeLabel(episode.number)} — a test stage, not a button`,
      cost: FREE,
      callsModel: false,
      nothingToDoBecause: null,
    }),
  }
}
