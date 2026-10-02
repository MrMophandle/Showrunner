import { Fragment, type ReactNode } from "react";
import { marked } from "marked";
import { safeHref } from "../projections.js";

/** Markdown as React elements, never as HTML.
 *
 *  Everything this renders was written by an agent, by a prompt file or by the showrunner's own
 *  editor — a gate's message, an outline, an image sheet — which makes it input, however much it
 *  looks like markup. So the page is built from `marked`'s **lexer** and not from its parser: the
 *  tokens become React elements, and no HTML string is ever handed to the DOM. There is no
 *  `dangerouslySetInnerHTML` in this client, which is a property that can be grepped for rather
 *  than a sanitiser that has to be right.
 *
 *  Two consequences are deliberate. A raw HTML token is shown as the text it is, in mono, so a
 *  prompt that emitted a `<script>` is visible rather than either executed or silently dropped.
 *  And an image is shown as its alt text and its path rather than fetched: the alt text is what a
 *  gate's prose is about, and a markdown file naming forty images would otherwise fire forty
 *  requests at paths that may not be under the artifact route at all. */

/** The subset of `marked`'s token shape this renderer reads. Declared rather than imported
 *  because `marked`'s `Token` is a twenty-arm discriminated union whose arms differ in which of
 *  these fields exist, and narrowing all twenty to reach the eight that matter would be a switch
 *  over the library's internals rather than over this console's needs. The cast below is the one
 *  place that trusts the library, and every field is read defensively after it. */
interface MdToken {
  type: string;
  raw: string;
  text?: string;
  tokens?: MdToken[];
  items?: MdToken[];
  depth?: number;
  href?: string;
  lang?: string;
  ordered?: boolean;
  start?: number | "";
  header?: MdToken[];
  rows?: MdToken[][];
}

/** The five entities `marked`'s lexer escapes in a text token, undone — in this order, so that a
 *  document that literally wrote `&amp;lt;` reads back as `&lt;` rather than as `<`. React escapes
 *  whatever this returns on its way into the DOM, so undoing them here is presentation and not a
 *  hole: the string never re-enters an HTML parser. */
function unescapeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function textOf(token: MdToken): string {
  return unescapeEntities(token.text ?? token.raw);
}

/** The inline tokens of one block, as React children. */
function inline(tokens: MdToken[] | undefined, fallback: string): ReactNode {
  if (tokens === undefined || tokens.length === 0) return unescapeEntities(fallback);
  return tokens.map((token, i) => {
    switch (token.type) {
      case "escape":
      case "text":
        return <Fragment key={i}>{token.tokens !== undefined && token.tokens.length > 0 ? inline(token.tokens, token.text ?? "") : textOf(token)}</Fragment>;
      case "strong":
        return <strong key={i}>{inline(token.tokens, token.text ?? "")}</strong>;
      case "em":
        return <em key={i}>{inline(token.tokens, token.text ?? "")}</em>;
      case "del":
        return <del key={i}>{inline(token.tokens, token.text ?? "")}</del>;
      case "codespan":
        return <code key={i} className="mono">{textOf(token)}</code>;
      case "br":
        return <br key={i} />;
      case "link": {
        const href = safeHref(token.href);
        const children = inline(token.tokens, token.text ?? token.raw);
        if (href === undefined) return <Fragment key={i}>{children}</Fragment>;
        return <a key={i} href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
      }
      case "image":
        return <span key={i} className="md-image">{`[image: ${unescapeEntities(token.text ?? "")}${token.href !== undefined ? ` — ${token.href}` : ""}]`}</span>;
      case "html":
        return <span key={i} className="md-raw mono">{token.raw}</span>;
      default:
        return <Fragment key={i}>{textOf(token)}</Fragment>;
    }
  });
}

/** One block token as an element. */
function block(token: MdToken, key: number): ReactNode {
  switch (token.type) {
    case "space":
    case "def":
      return null;
    case "hr":
      return <hr key={key} />;
    case "heading": {
      // A gate's message and an outline both start at `# `, and this pane is inside a page that
      // already has a heading, so every level is pushed down one and clamped at h6.
      const level = Math.min(6, Math.max(2, (token.depth ?? 1) + 1));
      const Tag = `h${level}` as "h2" | "h3" | "h4" | "h5" | "h6";
      return <Tag key={key}>{inline(token.tokens, token.text ?? "")}</Tag>;
    }
    case "code":
      // Block code is the one text the lexer leaves unescaped, so it is used as it came.
      return <pre key={key} className="md-code mono"><code>{token.text ?? token.raw}</code></pre>;
    case "blockquote":
      return <blockquote key={key}>{blocks(token.tokens)}</blockquote>;
    case "list": {
      const items = (token.items ?? []).map((item, i) => <li key={i}>{blocks(item.tokens)}</li>);
      if (token.ordered === true) {
        const start = typeof token.start === "number" ? token.start : 1;
        return <ol key={key} start={start}>{items}</ol>;
      }
      return <ul key={key}>{items}</ul>;
    }
    case "table":
      return (
        <div key={key} className="md-table-scroll">
          <table className="md-table">
            <thead>
              <tr>{(token.header ?? []).map((cell, i) => <th key={i}>{inline(cell.tokens, cell.text ?? "")}</th>)}</tr>
            </thead>
            <tbody>
              {(token.rows ?? []).map((row, r) => (
                <tr key={r}>{row.map((cell, c) => <td key={c}>{inline(cell.tokens, cell.text ?? "")}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "html":
      return <pre key={key} className="md-raw mono">{token.raw}</pre>;
    case "paragraph":
    case "text":
      return <p key={key}>{inline(token.tokens, token.text ?? "")}</p>;
    default:
      return <p key={key}>{textOf(token)}</p>;
  }
}

function blocks(tokens: MdToken[] | undefined): ReactNode {
  return (tokens ?? []).map((token, i) => block(token, i));
}

/** Renders `text` as markdown. `className` is the pane's own — the Gate page scrolls its message
 *  and its markdown artifacts in a fixed-height box, and the Board does not. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  // The one cast that trusts the library, confined to this line; `MdToken` says why.
  const tokens = marked.lexer(text) as unknown as MdToken[];
  return <div className={className === undefined ? "md" : `md ${className}`}>{blocks(tokens)}</div>;
}
