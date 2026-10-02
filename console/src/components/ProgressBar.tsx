import type { StepRow } from "../../shared/types.js";
import { progressLabel } from "../projections.js";

/** A step's progress: the bar, the count, the rate and the ETA.
 *
 *  The rate and the ETA are the server's (`server/runs.ts`'s `progressOf` measures them over the
 *  last two *distinct* counts, so a loop reporting the same count three times does not read as
 *  having slowed down). Nothing is computed here: a second implementation of the arithmetic on
 *  this side would be a second thing to be wrong about a four-hour render's finishing time.
 *
 *  A progress with no total — which the server reports as `total: 0` when the log's total was not
 *  a number — draws no bar, only the count: a bar with a made-up denominator would be the one
 *  thing on this page that lies. */
export function ProgressBar({ progress }: { progress: NonNullable<StepRow["progress"]> }) {
  const { done, total } = progress;
  const fraction = total > 0 ? Math.max(0, Math.min(1, done / total)) : undefined;
  return (
    <div className="progress">
      {fraction !== undefined && (
        <div
          className="progress-track"
          role="progressbar"
          aria-valuenow={done}
          aria-valuemin={0}
          aria-valuemax={total}
        >
          <div className="progress-fill" style={{ width: `${(fraction * 100).toFixed(1)}%` }} />
        </div>
      )}
      <div className="progress-label mono">{progressLabel(progress)}</div>
      {progress.message !== undefined && progress.message !== "" && (
        <div className="progress-message">{progress.message}</div>
      )}
    </div>
  );
}
