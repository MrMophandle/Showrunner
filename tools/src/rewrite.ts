/** Rewrites Archon's `$` variable forms into the engine's `{{...}}` template syntax.
 *
 *  The eight rules below are applied to a prompt in the order they are written, and the order is
 *  load-bearing at three points. Overrides run first because an override's `pattern` is a literal
 *  fragment of the *original* Archon text: a pattern spanning a form the rules have already
 *  rewritten would no longer match, and an override is also the only way to retire a form the
 *  rules cannot map, so it must delete the `$` before the unmapped scan can see it. An override's
 *  pattern is a literal but is matched only at a boundary, so a mistyped one rewrites nothing
 *  rather than half a variable. The
 *  sentence-period rule runs before the plain `$setup.output` rule so that the rule written for
 *  the sentence period is the rule that claims those sites, rather than their coming out right by
 *  accident of a word boundary. Both of those run before the `$<node>.output.<field>` rule,
 *  because `setup` matches that rule's node-id class too, and `$setup.output.Then` must become
 *  `{{episodeId}}.Then` and never `{{results.setup.Then}}`.
 *
 *  Nothing here throws. A form the rules cannot map is returned in `unmapped` with the text left
 *  exactly as it was, so one pass over a whole workflow reports every unresolved site at once and
 *  an operator sees each one as it is written. */

export interface RewriteContext {
  nodeId: string;
  /** The id of the gate whose `on_reject` block this prompt is, when it is one. `$REJECTION_REASON`
   *  is only meaningful inside such a block, and the gate id is what names the rejection result. */
  gateId?: string;
}

/** A literal find-and-replace applied before the rules. `pattern` is matched literally, never as a
 *  regular expression, and only at a boundary: see `overrideRegExp`. An override with no `nodeId`,
 *  or with `nodeId` `"*"`, applies to every prompt in every workflow; any other `nodeId` applies
 *  only to the node it names. */
export interface Override {
  nodeId?: string;
  pattern: string;
  replacement: string;
}

export interface RewriteResult {
  text: string;
  /** Every distinct `$` form left standing after the rules, in the order it first appears. */
  unmapped: string[];
}

/** Rule 2 (F-06): `$setup.output` followed by a period and then whitespace or the end of the text.
 *  The period is an English sentence period, not a field access — Archon's `$a.b.c` syntax cannot
 *  tell the two apart, which is why this case is decided by a rule of its own. */
const SENTENCE_PERIOD = /\$setup\.output\.(?=\s|$)/g;
/** Rule 3: the episode id in every other position. */
const EPISODE_ID = /\$setup\.output\b/g;
/** Rule 4: the shell-style spellings. `$EP_ID` is matched first; `\$EP\b` could not match it in
 *  any case, because `_` is a word character and no boundary falls after `EP`. */
const EP_ID = /\$EP_ID\b/g;
const EP = /\$EP\b/g;
/** Rule 5: the showrunner's rejection notes, which only exist inside a gate's `on_reject` block. */
const REJECTION_REASON = /\$REJECTION_REASON\b/g;
/** Rule 6: an earlier step's result, one field deep. */
const RESULT_FIELD = /\$([a-z][a-z0-9-]*)\.output\.([a-zA-Z_][\w]*)\b/g;
/** Rule 7: an earlier step's whole result. */
const RESULT = /\$([a-z][a-z0-9-]*)\.output\b/g;
/** Rule 8: what is left. `(?!\{)` excludes POSIX parameter expansions — `${SID#s}`, `${N}` — which
 *  are shell syntax inside a bash node and never prompt variables. A dollar amount such as `$5`
 *  never matches either, because the class after the `$` admits only a letter or an underscore. */
const LEFTOVER = /\$(?!\{)[A-Za-z_][\w.-]*/g;

/** Escapes a literal so it can be embedded in a regular expression. */
function escapeLiteral(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** An override's pattern is a literal, but it matches only at a boundary: the character before it
 *  must be neither a word character nor a `$`, and the character after it must not be a word
 *  character.
 *
 *  This is what stops a mistyped override from corrupting a prompt. A pattern one character short
 *  of the form it means to retire — "The full request is: $ARGUMENT" against the text
 *  "The full request is: $ARGUMENTS" — would otherwise match the first thirty characters and leave
 *  a bare "S" behind, a corruption no later rule can see and no reader would expect. With the
 *  trailing lookahead the pattern matches nothing at all, and the extractor reports it as an
 *  override that was never used. The leading `$` in the lookbehind does the same job from the other
 *  side: a pattern of "ARGUMENTS" must not match inside "$ARGUMENTS" and strand the sigil. */
function overrideRegExp(pattern: string): RegExp {
  return new RegExp(`(?<![\\w$])${escapeLiteral(pattern)}(?!\\w)`, "g");
}

/** @param used - when given, every override that matched at least once is added to it. The caller
 *  uses that to report an override that never fired, which is almost always a typo in a pattern or
 *  a node id rather than a deliberately dormant rule. */
export function rewriteVariables(text: string, ctx: RewriteContext, overrides: Override[], used?: Set<Override>): RewriteResult {
  let out = text;

  // Rule 1. Longest pattern first, so that when two patterns for the same node overlap the longer
  // literal claims its match before a shorter one can split it.
  const applicable = overrides.filter((o) => o.nodeId === undefined || o.nodeId === "*" || o.nodeId === ctx.nodeId);
  const ordered = [...applicable].sort((a, b) => b.pattern.length - a.pattern.length || (a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0));
  for (const override of ordered) {
    if (override.pattern === "") continue; // an empty pattern would match at every position.
    let matched = false;
    // A function replacement, not a string one: `$` in a replacement is a substitution directive
    // to String.replace, and these replacements carry `{{...}}` and sometimes a literal `$`.
    out = out.replace(overrideRegExp(override.pattern), () => { matched = true; return override.replacement; });
    if (matched) used?.add(override);
  }

  // Rules 2 through 4: the episode id.
  out = out.replace(SENTENCE_PERIOD, "{{episodeId}}.");
  out = out.replace(EPISODE_ID, "{{episodeId}}");
  out = out.replace(EP_ID, "{{episodeId}}");
  out = out.replace(EP, "{{episodeId}}");

  // Rule 5. Outside a gate's on_reject block there is no gate id to name, so the form is left
  // standing and rule 8 reports it. That is a statement about the workflow — a prompt naming a
  // rejection reason with no gate around it — and it is the operator's to resolve, not a crash.
  if (ctx.gateId !== undefined) {
    out = out.replace(REJECTION_REASON, `{{results.${ctx.gateId}:rejection}}`);
  }

  // Rules 6 and 7: earlier steps' results. The field form runs first; the whole-result form would
  // otherwise claim `$a.output` out of `$a.output.verdict` and strand the field name as prose.
  out = out.replace(RESULT_FIELD, "{{results.$1.$2}}");
  out = out.replace(RESULT, "{{results.$1}}");

  // Rule 8. Distinct forms, in the order each first appears, so the report is stable and a form
  // used twice in one prompt is named once.
  const unmapped: string[] = [];
  const seen = new Set<string>();
  for (const match of out.matchAll(LEFTOVER)) {
    const form = match[0];
    if (seen.has(form)) continue;
    seen.add(form);
    unmapped.push(form);
  }

  return { text: out, unmapped };
}
