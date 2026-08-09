/**
 * Markdown/docstring utilities for the generated Ruby sources: fence
 * normalization and inline code-reference rubification. Pure functions.
 */
import { toSnakeCase } from './helpers';

// A `require` / `require_relative` line in a rendered example. After import translation,
// several imports from one package collapse to duplicate `require 'aws-cdk-lib'` lines;
// these are de-duplicated before display so each require appears once.
const REQUIRE_LINE = /^\s*require(?:_relative)?\s+['"][^'"]+['"];?\s*$/;

/**
 * Some source READMEs put the first line of a fenced block onto the fence-open line —
 * e.g. an ASCII diagram: "```text                 +---". CommonMark (what GitHub uses)
 * treats everything after the ``` as the info string and opens the fence anyway, but
 * redcarpet — which YARD uses so it can highlight the fenced blocks — treats the whole
 * thing as a paragraph and prints the ``` literally. Split that trailing content onto
 * its own line so the fence opens (and, unlike GitHub, the first line is preserved).
 */
export function normalizeFences(markdown: string): string {
  return markdown.replace(
    /^([ \t]*`{3,}[ \t]*[\w.+#-]*)([ \t]{2,}\S.*)$/gm,
    '$1\n$2',
  );
}

export function rubifyInlineRefs(markdown: string): string {
  let inFence = false;
  let seenRequires = new Set<string>();
  const out: string[] = [];
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      seenRequires = new Set(); // de-dup requires within each code block
      out.push(line);
      continue;
    }
    if (inFence) {
      // Collapse duplicate `require` lines (e.g. several imports that all map to
      // `require 'aws-cdk-lib'`) to a single one.
      if (REQUIRE_LINE.test(line)) {
        const key = line.trim();
        if (seenRequires.has(key)) {
          continue;
        }
        seenRequires.add(key);
      }
      out.push(line);
      continue;
    }
    out.push(
      line.replace(/`([^`\n]+)`/g, (whole, inner: string) => {
        const m = /^([a-z][A-Za-z0-9]*)(\([A-Za-z0-9_,\s]*\))?$/.exec(inner);
        if (!m || !/[A-Z]/.test(m[1])) {
          return whole;
        }
        const call = m[2]
          ? m[2].replace(/[A-Za-z][A-Za-z0-9]*/g, (arg) => toSnakeCase(arg))
          : '';
        return `\`${toSnakeCase(m[1])}${call}\``;
      }),
    );
  }
  return out.join('\n');
}

