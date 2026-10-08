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
export { templatesDir } from "./init/paths.js";
export { parseCanonTemplate, templateWithoutQuestions, writeCastSheets } from "./init/scaffold.js";
