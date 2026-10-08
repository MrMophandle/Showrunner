/** `@showrunner/tools` as a library: the phases of `init` and the pieces of the bible interview,
 *  for a caller that drives the setup from somewhere other than a terminal.
 *
 *  The four CLIs this workspace ships (`showrunner-init`, `bible-check`, `check-prompts`,
 *  `extract-prompts`) stay what they were — `package.json`'s `bin` entries point at their own
 *  modules and nothing here changes them. This module exists because the console's New-show surface
 *  cannot call `runInit`: a browser form submission cannot hold a thirteen-file interview open for
 *  the hour it takes, and spec §4.2's rule is that the server owns no run. So the console calls the
 *  phases one request at a time — `initScaffold` to make the show, `questionsFor`/`readAnswers`/
 *  `writeAnswers` for each file's questions, `buildVars` and `interviewPromptsDir` inside the
 *  detached setup worker that runs the writer, `afterFileApproved` once a gate is answered, and
 *  `initFinish` at the end — while `runInit` composes exactly the same phases for the terminal.
 *
 *  Every symbol is re-exported from the module that declares it, and carries its reasoning there. */

export { initScaffold, afterFileApproved, initFinish, runInit, slugFrom } from "./init/init.js";
export type { InitOptions, InitDeps, InitReport, ScaffoldResult, FinishResult } from "./init/init.js";
export { interviewFile, isApproved, questionsFor, readAnswers, writeAnswers, buildVars, latestSetupLog, interviewPromptsDir, GATE_CHOICES } from "./init/interview.js";
export type { InitIO, InterviewResult, GateChoice, Question } from "./init/interview.js";
// The import fence, the cast parser and the three strings a gate answer is recorded with. The
// console's gate route calls exactly these, so the browser's four answers and the terminal's are
// one implementation: `resolveImport` is the symlink-and-path fence (a second copy of it in the
// console would be the copy that diverges), `ImportRefused` is how a refused path becomes a 400
// rather than a 500, `parseCast`/`castSectionOf`/`CAST_HEADING` build the cast that
// `afterFileApproved` turns into character sheets, and `AUTHOR_NOTES`/`IMPORT_NOTES_PREFIX` are
// both written on the approval and read back as the row's state.
export { resolveImport, ImportRefused, parseCast, castSectionOf, CAST_KEY, CAST_HEADING, AUTHOR_NOTES, IMPORT_NOTES_PREFIX } from "./init/interview.js";
export { templatesDir } from "./init/paths.js";
export { parseCanonTemplate, templateWithoutQuestions, writeCastSheets } from "./init/scaffold.js";
