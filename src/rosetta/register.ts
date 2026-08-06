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
    return; // this jsii-rosetta predates the language registry
  }
  try {
    registry.registerTargetLanguage('ruby', {
      version: '1',
      createVisitor: () => new RubyVisitor(),
    });
  } catch (e: any) {
    // Already registered (e.g. the module was loaded twice): fine.
    if (!/already registered/.test(String(e?.message))) {
      throw e;
    }
  }
}
