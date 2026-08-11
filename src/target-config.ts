import * as fs from 'fs';

import * as spec from '@jsii/spec';

/**
 * Out-of-band Ruby naming configuration ("target-config overlay").
 *
 * Construct libraries will generally not carry `jsii.targets.ruby` in their
 * repositories (external-language config never lands in an AWS repo), so the
 * assemblies published to npm have no Ruby naming data. This module lets the
 * naming arrive at generation time instead: point the environment variable
 * at a JSON file keyed by assembly name, and its entries are merged over
 * whatever each assembly declares — into the root assembly, its submodules,
 * and its dependency closure (which is where dependency gem/module names are
 * resolved from during generation).
 *
 * Overlay entries win over in-assembly config: the overlay is an explicit
 * per-generation instruction. Keys starting with `_` are comments.
 *
 * This is the plugin-side rendering of the `--target-config` flag proposed
 * in the jsii language-plugin RFC (D1); when pacmak grows that flag, it can
 * feed the same file through this merge.
 */
export const TARGET_CONFIG_ENV = 'JSII_RUBY_TARGET_CONFIG';

export interface RubyTargetEntry {
  readonly gem?: string;
  readonly module?: string;
  readonly acronyms?: readonly string[];
  /**
   * A prefix this library puts on its submodule names, which its conventional
   * import aliases leave off — `aws_` for aws-cdk-lib, whose `aws_iam` is
   * aliased `iam`. Declared by the profile because it is a fact about the
   * library, not about Ruby: a target that hardcodes one vendor's prefix
   * resolves that vendor's aliases and silently fails everyone else's.
   */
  readonly submodulePrefix?: string;
  readonly submodules?: Record<string, { readonly module?: string }>;
}

export type RubyTargetOverlay = Record<string, RubyTargetEntry>;

// Cached per file path: the rosetta visitor consults the overlay on every
// unresolved type reference, which would otherwise re-read the file per call.
// Keying by path keeps tests (which point the env var at fresh temp files)
// correct without an explicit reset hook.
const overlayCache = new Map<string, RubyTargetOverlay>();

export function loadRubyTargetOverlay(): RubyTargetOverlay | undefined {
  const file = process.env[TARGET_CONFIG_ENV];
  if (!file) {
    return undefined;
  }
  const cached = overlayCache.get(file);
  if (cached) {
    return cached;
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const overlay: RubyTargetOverlay = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!key.startsWith('_')) {
      overlay[key] = value as RubyTargetEntry;
    }
  }
  overlayCache.set(file, overlay);
  return overlay;
}

/**
 * Merges the overlay (if configured) into an assembly spec, in place.
 * Idempotent — the generator and the target both apply it, whichever runs
 * first wins and the second application is a no-op re-merge of equal data.
 */
export function applyRubyTargetOverlay(assembly: spec.Assembly): void {
  const overlay = loadRubyTargetOverlay();
  if (overlay === undefined) {
    return;
  }

  applyEntry(assembly, overlay[assembly.name]);

  for (const [depName, depInfo] of Object.entries(assembly.dependencyClosure ?? {})) {
    applyEntry(depInfo, overlay[depName]);
  }
}

interface TargetsCarrier {
  targets?: spec.AssemblyTargets;
  submodules?: Record<string, { targets?: spec.AssemblyTargets }>;
}

function applyEntry(carrier: TargetsCarrier, entry: RubyTargetEntry | undefined): void {
  if (entry === undefined) {
    return;
  }
  const { submodules, ...rootConfig } = entry;

  const mutable = carrier as { targets?: Record<string, unknown>; submodules?: TargetsCarrier['submodules'] };
  mutable.targets = {
    ...mutable.targets,
    ruby: { ...(mutable.targets?.ruby as object | undefined), ...stripComments(rootConfig) },
  };

  for (const [fqn, subConfig] of Object.entries(submodules ?? {})) {
    const sub = mutable.submodules?.[fqn] as { targets?: Record<string, unknown> } | undefined;
    if (sub === undefined) {
      continue; // overlay names a submodule this assembly version doesn't have
    }
    sub.targets = {
      ...sub.targets,
      ruby: { ...(sub.targets?.ruby as object | undefined), ...stripComments(subConfig) },
    };
  }
}

function stripComments<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !k.startsWith('_'))) as Partial<T>;
}

/**
 * Reverse index from a plausible import alias to the Ruby module it names,
 * built from the overlay's submodules. Cached per overlay object.
 */
const ALIAS_INDEX = new WeakMap<object, Map<string, string | null>>();

/**
 * The Ruby module path an import alias names, inferred from the overlay's
 * submodules — `iam` -> `AWSCDK::IAM`.
 *
 * Published examples are usually fragments: the rosetta fixture that would
 * `import * as iam from 'aws-cdk-lib/aws-iam'` lives in the library's source
 * repo, not in the package, so there is no import statement to learn the alias
 * from and the reference would otherwise render as a bare `Iam::Role` — no
 * root module, and the acronym lost with it.
 *
 * Only aliases naming a submodule the overlay actually declares are resolved,
 * and an alias claimed by more than one assembly resolves to nothing rather
 * than to a guess.
 */
export function rubyModuleForImportAlias(alias: string): string | undefined {
  const overlay = loadRubyTargetOverlay();
  if (overlay === undefined) {
    return undefined;
  }

  let index = ALIAS_INDEX.get(overlay);
  if (index === undefined) {
    index = new Map<string, string | null>();
    for (const entry of Object.values(overlay)) {
      const prefix = entry?.submodulePrefix ?? '';
      for (const [fqn, submodule] of Object.entries(entry?.submodules ?? {})) {
        const module = submodule?.module;
        if (!module) continue;

        const leaf = fqn.split('.').pop() ?? '';
        // `aws-cdk-lib.aws_iam` is imported as `aws-cdk-lib/aws-iam` and
        // conventionally aliased `iam`; the prefix that makes those two the
        // same word is the library's, so the profile states it.
        const stripped = prefix && leaf.startsWith(prefix) ? leaf.slice(prefix.length) : leaf;
        // A multi-word submodule is also reached by its last word alone
        // (`aws_stepfunctions_tasks` as `tasks`), which is how the shorter
        // conventional aliases are written.
        const trailing = stripped.includes('_') ? stripped.slice(stripped.lastIndexOf('_') + 1) : '';
        for (const candidate of new Set([leaf, stripped, trailing])) {
          if (!candidate) continue;
          // `null` marks an alias claimed by more than one module.
          index.set(candidate, index.has(candidate) && index.get(candidate) !== module ? null : module);
        }
      }
    }
    ALIAS_INDEX.set(overlay, index);
  }

  return index.get(alias) ?? undefined;
}
