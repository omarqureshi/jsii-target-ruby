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

/** Where a type declared by an assembly lives. */
interface TypeLocation {
  /** The full Ruby constant path the generator emits for it. */
  readonly rubyPath: string;
  /** Its jsii submodule, assembly name stripped (`aws_kinesisfirehose`). */
  readonly submodule: string;
  /** The assembly declaring it — what a root-level type is aliased by. */
  readonly assembly: string;
}

/**
 * TypeScript type name -> everywhere the assembly declares that name.
 *
 * The alias index in target-config resolves an import alias by making it look
 * like a submodule name, which only reaches aliases that do (`iam` ->
 * `aws_iam`). Many CDK aliases are unrelated to their submodule —
 * `firehose` is `aws_kinesisfirehose`, `sfn` is `aws_stepfunctions` — and
 * published examples carry no import statement to learn from. The type name,
 * though, is in the assembly: whatever `firehose` means, `DeliveryStream` is
 * declared in exactly one place.
 */
const BY_TYPE_NAME = new Map<string, TypeLocation[]>();

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

  const submoduleFqns = new Set(Object.keys(assembly.submodules ?? {}));

  for (const [fqn, type] of Object.entries(assembly.types ?? {})) {
    const rubyPath = rubyPathFor(fqn);
    KINDS.set(rubyPath, type.kind === spec.TypeKind.Enum ? 'enum' : 'other');

    const parts = fqn.split('.');
    const name = parts[parts.length - 1];
    const locations = BY_TYPE_NAME.get(name) ?? [];
    locations.push({
      rubyPath,
      submodule: submoduleOf(parts, submoduleFqns),
      assembly: assembly.name,
    });
    BY_TYPE_NAME.set(name, locations);
  }
}

/**
 * The submodule part of a split fqn.
 *
 * A nested type's fqn (`asm.aws_s3.Bucket.Inner`) is indistinguishable from a
 * deeper submodule by shape alone, so ask the assembly which prefixes are
 * really submodules. When none of them matches, "everything between the
 * assembly and the type name" is the best available guess — it is only ever
 * compared against an import alias, so an over-long answer costs a match it
 * would not otherwise have made, while calling it root-level would claim the
 * type is reached through the assembly alias when it is not.
 */
function submoduleOf(parts: readonly string[], submoduleFqns: ReadonlySet<string>): string {
  for (let end = parts.length - 1; end > 1; end--) {
    if (submoduleFqns.has(parts.slice(0, end).join('.'))) {
      return parts.slice(1, end).join('.');
    }
  }
  return parts.slice(1, -1).join('.');
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

/**
 * The Ruby constant path for a TypeScript type name, when the assemblies
 * indexed here name exactly one type by it.
 *
 * `aliasHint` is the import alias the reference came through
 * (`opensearch.EngineVersion`). It is only ever used to narrow: a name declared
 * by several submodules resolves if the alias resembles exactly one of them,
 * and otherwise resolves to nothing. Guessing between `aws_events.Schedule` and
 * `aws_applicationautoscaling.Schedule` would put a plausible but wrong
 * constant in the docs, which is worse than leaving the alias alone.
 */
export function rubyPathForTypeName(typeName: string, aliasHint?: string): string | undefined {
  if (!environmentLoaded) {
    environmentLoaded = true;
    loadFromEnvironment();
  }

  const found = BY_TYPE_NAME.get(typeName);
  if (found === undefined) {
    return undefined;
  }

  return (
    onlyPath(found) ??
    (aliasHint ? onlyPath(found.filter((l) => resembles(l, aliasHint))) : undefined)
  );
}

/** The one Ruby path these locations agree on, or undefined if they do not. */
function onlyPath(locations: readonly TypeLocation[]): string | undefined {
  const paths = new Set(locations.map((l) => l.rubyPath));
  return paths.size === 1 ? locations[0].rubyPath : undefined;
}

/**
 * Whether an import alias plausibly names where this type lives — its
 * submodule, or for a root-level type the assembly itself (`cdk.Tags` is
 * aws-cdk-lib's own `Tags`, not `assertions.Tags`).
 *
 * Substring rather than equality, because the conventional aliases are
 * abbreviations of the name and not the other way round: `opensearch` of
 * `aws_opensearchservice`, `s3deploy` of `aws_s3_deployment`, `agentcore` of
 * `aws_bedrockagentcore`, `cdk` of `aws-cdk-lib`. Aliases that abbreviate by
 * dropping letters (`sfn`, `apigwv2`) match nothing here — they are resolved by
 * being the only declaration of their type name, or not at all.
 */
function resembles(location: TypeLocation, alias: string): boolean {
  if (alias.length < 2) {
    return false;
  }
  const owner = location.submodule === '' ? location.assembly : location.submodule;
  return owner.replace(/^aws_/, '').replace(/[-._]/g, '').toLowerCase().includes(alias.toLowerCase());
}

/** Test hook: drop everything indexed so far. */
export function resetTypeOracle(): void {
  KINDS.clear();
  BY_TYPE_NAME.clear();
  LOADED_ASSEMBLIES.clear();
  environmentLoaded = false;
}
