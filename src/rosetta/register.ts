import { RubyVisitor } from './ruby-visitor';

/**
 * Registers the Ruby visitor with jsii-rosetta's external-language registry.
 *
 * Guarded: against a jsii-rosetta without the registry (pre-plugin-API
 * releases), registration is skipped and example translation is simply
 * unavailable — the pacmak target then emits examples as TypeScript verbatim.
 */
export function registerRosettaLanguage(): void {
  let registry: any;
  try {
    /* eslint-disable-next-line @typescript-eslint/no-require-imports */
    registry = require('jsii-rosetta/lib/languages/index');
  } catch {
    return; // this jsii-rosetta does not expose its internals
  }
  if (typeof registry.registerTargetLanguage !== 'function') {
    // Loud, because the failure is otherwise invisible: generation succeeds
    // and every example silently comes back as its original TypeScript. The
    // usual cause is jsii-pacmak resolving a DIFFERENT jsii-rosetta copy
    // (the published one, which has no registry) than the plugin registers
    // into — see scripts/link-toolchain.sh.
    console.error(
      '[jsii-target-ruby] the resolved jsii-rosetta has no language registry; ' +
        'example translation is DISABLED (examples will stay TypeScript). ' +
        'Ensure jsii-pacmak resolves a jsii-rosetta with external-language support.',
    );
    return;
  }
  try {
    registry.registerTargetLanguage('ruby', {
      // Bump whenever the visitor's output changes: rosetta keeps a cached
      // translation for as long as its recorded translator version matches, so
      // leaving this alone makes a rendering fix invisible in any rebuild that
      // reuses a tablet. Same convention as the built-in visitors
      // (`PythonVisitor.VERSION`).
      //   2: references resolved through the assembly's own type names
      version: '2',
      createVisitor: () => new RubyVisitor(),
    });
  } catch (e: any) {
    // Already registered (e.g. the module was loaded twice): fine.
    if (!/already registered/.test(String(e?.message))) {
      throw e;
    }
  }
}
