import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { after, before, describe, test } from 'node:test';

import {
  normalizeExpectedSource,
  normalizeRenderedSource,
  TranslationsCorpus,
} from 'jsii-rosetta/lib/testing/translations-corpus';

import { RubyVisitor } from '../src/rosetta/ruby-visitor';

// Runs jsii-rosetta's shipped translations corpus (the same snippets its
// in-repo Python/Java/C#/Go tests use) against this plugin's visitor. The
// snippets stay upstream — this repo contributes only the .rb expectations,
// mirroring the corpus' relative layout under test/translations/.
const EXPECTATIONS = path.resolve(__dirname, '..', '..', 'test', 'translations');

// The visitor resolves unresolvable type references against the target-config
// overlay (as the docs pipeline does in production) — run the corpus the same
// way so namespaces in expectations match deployed behavior.
process.env.JSII_RUBY_TARGET_CONFIG = path.resolve(__dirname, '..', '..', 'config', 'cdk-targets.json');

// Snippets not (yet) in the upstream corpus: full .ts + .rb pairs, candidates
// for upstreaming. Expectations sit next to the snippets.
const LOCAL_CORPUS = path.resolve(__dirname, '..', '..', 'test', 'translations-local');

// Snippets whose expectation documents the *intended* rendering, which stock
// upstream jsii-rosetta cannot produce yet. Two queued upstream fixes cover
// all of them; when they land, these assertions flip and the list empties.
//
// 1. DefaultVisitor does not dispatch conditional (ternary) or postfix-unary
//    expressions (or arrow functions) to their typed handlers, so those
//    constructs render as raw TypeScript.
// 2. `isLikelyNamespace` (submodule-reference.ts) calls `symbol.declarations!`
//    on error symbols that have no declarations — property accesses through an
//    unresolvable module either crash outright (class_with_namespace) or
//    derail submodule detection (submodule-import's `require_relative` line).
const KNOWN_RENDER_GAPS = new Set<string>([
  'imports/submodule-import', // (2)
  'classes/class_with_namespace', // (2) — crashes stock rosetta
  'expressions/increment_decrement', // (1)
  'expressions/ternary', // (1)
]);

function runCorpus(title: string, corpusRoot: string | undefined, expectationsRoot: string | undefined) {
  describe(title, () => {
    let corpus: TranslationsCorpus;

    before(async () => {
      corpus = await TranslationsCorpus.create(corpusRoot ? { corpusRoot } : {});
    });

    after(async () => {
      await corpus.dispose();
    });

    for (const name of TranslationsCorpus.snippetNames(corpusRoot)) {
      const expectationFile = path.join(expectationsRoot ?? corpusRoot ?? TranslationsCorpus.DEFAULT_CORPUS_ROOT, `${name}.rb`);
      // Skip (visibly) when no expectation exists yet — e.g. a snippet newly
      // added upstream. Write the .rb file to cover it.
      const options = fs.existsSync(expectationFile) ? {} : { skip: 'no .rb expectation yet' as const };

      test(`translates ${name}.ts`, options, () => {
        const snippet = corpus.snippet(name)!;
        const expected = normalizeExpectedSource(corpus.expectation(snippet, '.rb', expectationsRoot)!);

        if (KNOWN_RENDER_GAPS.has(name)) {
          // A known gap passes while rendering crashes or mismatches, and
          // fails loudly the moment the upstream fix lands.
          let actual: string | undefined;
          try {
            actual = normalizeRenderedSource(corpus.render(snippet, new RubyVisitor()));
          } catch {
            return; // still crashing upstream — gap confirmed
          }
          assert.notEqual(
            actual,
            expected,
            `renderer gap for ${name} appears fixed upstream — remove it from KNOWN_RENDER_GAPS`,
          );
          return;
        }

        assert.equal(normalizeRenderedSource(corpus.render(snippet, new RubyVisitor())), expected);
      });
    }
  });
}

runCorpus('upstream translations corpus', undefined, EXPECTATIONS);
runCorpus('local corpus extension (not yet upstream)', LOCAL_CORPUS, undefined);
