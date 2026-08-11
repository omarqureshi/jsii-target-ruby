import * as path from 'path';
import * as zlib from 'zlib';

import * as fs from 'fs-extra';

import { guessRubyModuleName, RubyVisitor } from './rosetta/ruby-visitor';
import { loadRubyTargetOverlay, TARGET_CONFIG_ENV } from './target-config';
import { registerAssemblyLocations, resetTypeOracle } from './type-oracle';

/**
 * A harness for testing a naming profile.
 *
 * A profile — what a library is called in Ruby — is data this target knows
 * nothing about, and every question about whether it is *right* is a question
 * about that library: does `aws_s3` render as `AWSCDK::S3`, does the alias
 * `firehose` reach `aws_kinesisfirehose`, has a release added a submodule that
 * nobody has named? Those belong wherever the profile is published, not here.
 * What this target owes a profile owner is a way to ask without reimplementing
 * generation.
 *
 * The shape mirrors what jsii-rosetta publishes for us one level up: it ships
 * its translations corpus behind `lib/testing` so an external language can
 * check itself against the same snippets its own languages are checked with.
 *
 * One harness at a time: the type index is process-wide, so constructing a
 * harness clears whatever the last one registered.
 */
export interface ProfileHarness {
  /**
   * The Ruby module path a jsii fqn is generated as under this profile.
   * An assembly the profile does not mention still answers — generically.
   */
  modulePathFor(fqn: string): string;

  /**
   * Translate a TypeScript snippet exactly as the documentation pipeline
   * would, so an expectation here is an expectation about published output.
   */
  render(source: string): string;

  /**
   * Submodules the assemblies declare that the profile does not name.
   *
   * This is the drift question. A library release adds submodules, and each
   * unnamed one silently renders as a derived guess (`aws_xyz` -> `Xyz`) that
   * becomes permanent public API the moment it ships. Non-empty means someone
   * has a naming decision to make.
   */
  unnamedSubmodules(): string[];

  /** Restore the environment and drop the type index. */
  dispose(): void;
}

export interface ProfileHarnessOptions {
  /** Path to the profile JSON (the file `JSII_RUBY_TARGET_CONFIG` names). */
  readonly profile: string;

  /**
   * Package directories whose assemblies the profile describes.
   *
   * Optional: naming questions need no assembly. Rendering questions often
   * do, because an alias that resembles no submodule can only be placed by
   * asking where the type it reaches is declared.
   */
  readonly assemblies?: readonly string[];
}

export function profileHarness(options: ProfileHarnessOptions): ProfileHarness {
  if (!fs.existsSync(options.profile)) {
    throw new Error(`no profile at ${options.profile}`);
  }

  const previous = process.env[TARGET_CONFIG_ENV];
  process.env[TARGET_CONFIG_ENV] = options.profile;
  // Start from nothing rather than inheriting whatever a previous harness
  // registered: two harnesses over assemblies with the same name would
  // otherwise silently keep the first one's types.
  resetTypeOracle();
  registerAssemblyLocations(options.assemblies ?? []);

  return {
    modulePathFor: (fqn) => guessRubyModuleName(fqn),

    render(source) {
      // Required lazily: importing rosetta at module load would make this
      // harness unusable in a process that only wants the naming questions.
      /* eslint-disable-next-line @typescript-eslint/no-require-imports */
      const { translateTypeScript } = require('jsii-rosetta/lib/translate');
      return translateTypeScript({ contents: source, fileName: 'profile.ts' }, new RubyVisitor())
        .translation;
    },

    unnamedSubmodules() {
      const overlay = loadRubyTargetOverlay() ?? {};
      const unnamed: string[] = [];
      for (const dir of options.assemblies ?? []) {
        const assembly = readAssembly(dir);
        const named = overlay[assembly.name]?.submodules ?? {};
        for (const fqn of Object.keys(assembly.submodules ?? {})) {
          // Nested submodules inherit their parent's explicit name, so only
          // the top level is a decision anyone has to make.
          const isNested = fqn.split('.').length > 2;
          if (!isNested && !(fqn in named)) {
            unnamed.push(fqn);
          }
        }
      }
      return unnamed.sort();
    },

    dispose() {
      if (previous === undefined) {
        delete process.env[TARGET_CONFIG_ENV];
      } else {
        process.env[TARGET_CONFIG_ENV] = previous;
      }
      resetTypeOracle();
    },
  };
}

/** As the oracle reads them: no validation, and follow the redirect stub. */
function readAssembly(dir: string): { name: string; submodules?: Record<string, unknown> } {
  const parse = (file: string, compressed: boolean) => {
    const raw = fs.readFileSync(file);
    return JSON.parse((compressed ? zlib.gunzipSync(raw) : raw).toString('utf-8'));
  };
  const parsed = parse(path.join(dir, '.jsii'), false);
  return parsed?.schema === 'jsii/file-redirect'
    ? parse(path.join(dir, parsed.filename), parsed.compression === 'gzip')
    : parsed;
}
