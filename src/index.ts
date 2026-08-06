import { RubyTarget } from './ruby';

export { RubyTarget, RubyGenerator } from './ruby';
export { toRubyReleaseVersion, toRubyVersionRange } from './version-utils';

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
