import { registerAssemblyLocations } from '../type-oracle';
import { RubyVisitor } from './ruby-visitor';

/**
 * Registers the Ruby visitor with jsii-rosetta's external-language registry.
 *
 * Guarded: against a jsii-rosetta without the registry (pre-plugin-API
 * releases), registration is skipped and example translation is simply
 * unavailable — the pacmak target then emits examples as TypeScript verbatim.
 */
/**
 * The jsii-rosetta plugin API version this plugin is written against
 * (`PLUGIN_API_VERSION` in jsii-rosetta/lib/plugin-api).
 */
export const ROSETTA_PLUGIN_API_VERSION = '0.1.0';

export function registerRosettaLanguage(): void {
  let rosetta: any;
  try {
    /* eslint-disable-next-line @typescript-eslint/no-require-imports */
    rosetta = require('jsii-rosetta/lib/plugin-api');
  } catch {
    // Loud, because the failure is otherwise invisible: generation succeeds
    // and every example silently comes back as its original TypeScript. The
    // usual cause is jsii-pacmak resolving a DIFFERENT jsii-rosetta copy
    // (a published one, which has no plugin API) than the plugin registers
    // into — see scripts/link-toolchain.sh.
    console.error(
      '[jsii-target-ruby] the resolved jsii-rosetta has no language-plugin API; ' +
        'example translation is DISABLED (examples will stay TypeScript). ' +
        'Ensure jsii-pacmak resolves a jsii-rosetta with external-language support.',
    );
    return;
  }
  // Registering again with the same visitor version is a no-op in rosetta,
  // so loading this module twice is harmless.
  rosetta.registerTargetLanguage(
    'ruby',
    {
      // Bump whenever the visitor's output changes: rosetta keeps a cached
      // translation for as long as its recorded translator version matches, so
      // leaving this alone makes a rendering fix invisible in any rebuild that
      // reuses a tablet. Same convention as the built-in visitors
      // (`PythonVisitor.VERSION`).
      //   2: references resolved through the assembly's own type names
      //   3: ambiguous names narrowed by the snippet's imports
      //   4: static readonly members read as constants (`Type::NAME`)
      version: '4',
      createVisitor: () => new RubyVisitor(),
      // Rosetta translates in worker threads, which never run the generator,
      // so this is how a worker learns which assembly a snippet documents —
      // needed to resolve a reference the snippet does not typecheck well
      // enough to resolve itself.
      prepare: (context: { assemblyLocations?: readonly string[] }) =>
        registerAssemblyLocations(context?.assemblyLocations ?? []),
    },
    { pluginApiVersion: ROSETTA_PLUGIN_API_VERSION },
  );
}
