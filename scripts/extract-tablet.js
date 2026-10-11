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
// The plugin is passed as a module for rosetta to load, rather than loaded
// here: translation runs in worker threads, which are fresh module contexts,
// and rosetta loads it in each of them as well as in this process.
'use strict';

const path = require('path');

async function main(argv) {
  const [assemblyDir, tabletFile, cacheFile] = argv;
  if (!assemblyDir || !tabletFile) {
    console.error('usage: extract-tablet.js <assembly-dir> <tablet.json> [cache.json]');
    process.exit(2);
  }

  // Workers never run the generator, so the assembly being documented reaches
  // them through rosetta itself: `extractSnippets` hands the locations it was
  // given to every registered language before translating. Nothing to arrange
  // here beyond passing the directory, which it already receives.
  const { extractSnippets } = require('jsii-rosetta/lib/plugin-api');

  const result = await extractSnippets([assemblyDir], {
    // Loaded both here and in every translation worker, which is where the
    // Ruby language has to be registered.
    pluginModules: [path.resolve(__dirname, '..', 'lib', 'index.js')],
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
