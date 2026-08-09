import * as path from 'path';
import * as zlib from 'zlib';

import * as fs from 'fs-extra';

import * as spec from '@jsii/spec';

import { resolveRubyModulePath } from './helpers';
import { loadRubyTargetOverlay } from './target-config';

/**
 * What kind of Ruby constant a type's members are reached through.
 *
 * An enum member is a real constant (`BucketEncryption::S3_MANAGED`); a static
 * readonly property is generated as a class method (`def self.NODEJS_LATEST`),
 * so `Runtime::NODEJS_LATEST` raises NameError and only `Runtime.NODEJS_LATEST`
 * works. In a snippet that does not typecheck the two are indistinguishable —
 * both are SCREAMING_SNAKE after a PascalCase name — so the assembly is the
 * only thing that can tell them apart.
 */
export type RubyTypeKind = 'enum' | 'other';

const KINDS = new Map<string, RubyTypeKind>();
const LOADED_ASSEMBLIES = new Set<string>();

/** The Ruby path a jsii fqn is generated as, overlay-aware. */
function rubyPathFor(fqn: string): string {
  const packageName = fqn.split('.')[0];
  const entry = loadRubyTargetOverlay()?.[packageName];
  return resolveRubyModulePath(fqn, {
    assemblyName: packageName,
    acronyms: (entry?.acronyms as string[] | undefined) ?? [],
    rootModule: () => entry?.module,
    submoduleModule: (submoduleFqn) => entry?.submodules?.[submoduleFqn]?.module,
  });
}

/**
 * Index an assembly's types so the visitor can tell an enum from a class.
 * Idempotent — the same assembly may be offered by both the generator and the
 * environment.
 */
export function registerAssemblyTypes(assembly: spec.Assembly): void {
  if (LOADED_ASSEMBLIES.has(assembly.name)) {
    return;
  }
  LOADED_ASSEMBLIES.add(assembly.name);

  for (const [fqn, type] of Object.entries(assembly.types ?? {})) {
    KINDS.set(rubyPathFor(fqn), type.kind === spec.TypeKind.Enum ? 'enum' : 'other');
  }
}

/**
 * Assemblies named by `JSII_RUBY_ORACLE_ASSEMBLIES` (a PATH-style list of
 * package directories).
 *
 * Rosetta translates in worker threads, which never run the generator, so
 * there is nothing there to register an assembly — the environment is how a
 * worker is told which assemblies it is translating examples for.
 */
function loadFromEnvironment(): void {
  const configured = process.env.JSII_RUBY_ORACLE_ASSEMBLIES;
  if (!configured) {
    return;
  }
  for (const dir of configured.split(path.delimiter).filter(Boolean)) {
    try {
      registerAssemblyTypes(readAssembly(dir));
    } catch (e: any) {
      // Not worth failing translation over: an unknown type only costs the
      // rendering we would have produced anyway. Say so, though — a silent
      // miss here is invisible in the output.
      console.error(`[jsii-target-ruby] could not load assembly at ${dir}: ${e?.message ?? e}`);
    }
  }
}

/**
 * Read an assembly for its type kinds alone.
 *
 * Deliberately not `spec.loadAssemblyFromPath`: that validates, and rejects
 * aws-cdk-lib outright for using schema features this toolchain does not
 * declare support for ("unsupported feature(s): intersection-types"). Nothing
 * here depends on the assembly being fully understood — only on
 * `types[fqn].kind` — so validation would trade the whole feature for nothing.
 *
 * A package may ship a redirect stub at `.jsii` pointing at a compressed
 * `.jsii.gz`; reading the stub yields a parseable assembly with no types at
 * all, which looks like success and answers "unknown" forever.
 */
function readAssembly(dir: string): spec.Assembly {
  const parse = (file: string, compressed: boolean): any => {
    const raw = fs.readFileSync(file);
    return JSON.parse((compressed ? zlib.gunzipSync(raw) : raw).toString('utf-8'));
  };

  const parsed = parse(path.join(dir, '.jsii'), false);
  if (parsed?.schema === 'jsii/file-redirect') {
    return parse(path.join(dir, parsed.filename), parsed.compression === 'gzip');
  }
  return parsed as spec.Assembly;
}

let environmentLoaded = false;

/**
 * The kind of the type at a Ruby path, or undefined when nothing is known
 * about it — in which case callers keep whatever they did before.
 */
export function rubyTypeKind(rubyPath: string): RubyTypeKind | undefined {
  if (!environmentLoaded) {
    environmentLoaded = true;
    loadFromEnvironment();
  }
  return KINDS.get(rubyPath);
}

/** Test hook: drop everything indexed so far. */
export function resetTypeOracle(): void {
  KINDS.clear();
  LOADED_ASSEMBLIES.clear();
  environmentLoaded = false;
}
