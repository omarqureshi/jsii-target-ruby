import { RubyTarget } from './ruby';
import { registerRosettaLanguage } from './rosetta/register';

export { RubyTarget, RubyGenerator } from './ruby';
export { RubyVisitor } from './rosetta/ruby-visitor';
export { toRubyReleaseVersion, toRubyVersionRange } from './version-utils';

// Loading the plugin registers 'ruby' with jsii-rosetta's language registry
// (when the installed jsii-rosetta has one), so example translation works
// through the same rosetta instance the toolchain uses.
registerRosettaLanguage();

/**
 * jsii-pacmak target-plugin declaration: `jsii-pacmak --plugin jsii-target-ruby -t ruby`.
 *
 * The common-path contract: pacmak runs this target through the same generic
 * IndependentPackageBuilder as the built-in go/js/python targets.
 */
export default {
  targetName: 'ruby',
  pluginApiVersion: '0.1.0',
  targetConstructor: RubyTarget,
};
