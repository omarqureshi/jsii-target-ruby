#!/usr/bin/env node
// Pre-translates a library's examples into a rosetta tablet, so that jsii-pacmak
// can read them instead of translating on every build.
//
//   node scripts/extract-tablet.js <assembly-dir> <tablet.json> [cache.json]
//
// Why this exists: pacmak's inline translation is single-threaded and runs from
// scratch every time — for aws-cdk-lib that is over an hour of work repeated on
// every docs build. `extract` instead translates across a worker pool and can
// reuse a cache, so unchanged snippets are never retranslated.
//
// The workers are fresh module contexts, so they are told to load this plugin:
// otherwise Ruby is registered only in this process and the tablet comes back
// with no Ruby translations in it at all.
'use strict';

const path = require('path');

async function main(argv) {
  const [assemblyDir, tabletFile, cacheFile] = argv;
  if (!assemblyDir || !tabletFile) {
    console.error('usage: extract-tablet.js <assembly-dir> <tablet.json> [cache.json]');
    process.exit(2);
  }

  // Registers the Ruby visitor in THIS process (for snippet discovery); the
  // workers get it via pluginModules below.
  require('../lib/index.js');

  // Workers never run the generator, so the assembly they are translating
  // examples for has to reach them another way: without it a static readonly
  // member renders as a constant and raises NameError when pasted.
  process.env.JSII_RUBY_ORACLE_ASSEMBLIES = [assemblyDir, process.env.JSII_RUBY_ORACLE_ASSEMBLIES]
    .filter(Boolean)
    .join(require('path').delimiter);

  const { extractSnippets } = require('jsii-rosetta/lib/commands/extract');
  const pluginModule = require.resolve('../lib/index.js');

  const result = await extractSnippets([assemblyDir], {
    pluginModules: [pluginModule],
    // Reuse anything already translated; rosetta drops entries whose source or
    // translator version changed, so a visitor bump invalidates exactly the
    // translations it affects rather than the whole tablet.
    cacheFromFile: cacheFile,
    cacheToFile: tabletFile,
    // Don't write .jsii.tabl.json back into node_modules: the tablet is a build
    // artifact of ours, not a modification of the installed package.
    writeToImplicitTablets: false,
    includeCompilerDiagnostics: false,
    // Published packages do not ship the literate sources (`.lit.ts`) or
    // fixtures their examples reference — those live in the library's source
    // repo. Without loose mode, extracting from an installed package fails
    // outright on the first such reference.
    loose: true,
  });

  const errors = result.diagnostics.filter((d) => d.isError);
  console.log(
    `extracted to ${path.resolve(tabletFile)}` +
      `${errors.length > 0 ? ` (${errors.length} snippets failed to translate)` : ''}`,
  );

  // Snippet-level failures are normal — many published examples do not compile
  // on their own — so they are reported, not fatal. Anything that fails here
  // falls back to pacmak's unknown-snippet handling.
}

main(process.argv.slice(2)).catch((e) => {
  console.error(e.stack ?? String(e));
  process.exit(1);
});
