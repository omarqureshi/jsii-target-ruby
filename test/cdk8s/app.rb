# A cdk8s app in Ruby, paired with app.ts. Both build the same chart; their
# synthesized manifests are compared byte-for-byte by cdk8s-conformance.sh.
#
# This is the cheapest end-to-end check this target has: a cdk8s app writes
# YAML and touches no cloud account, so "does the binding produce the same
# semantics as the TypeScript original" is answered by a diff rather than by
# reading generated code.
lib = File.expand_path(ENV.fetch('CDK8S_RUBY_LIB'), Dir.pwd)
$LOAD_PATH.unshift(lib)
require 'jsii'

kernel = Jsii::Kernel.instance
# The kernel needs each assembly loaded before its proxies can be constructed;
# pacmak emits the tarballs next to the sources it generates.
[['constructs', '10.5.1'], ['cdk8s', '2.70.48'], ['cdk8s-plus-27', '2.9.5']].each do |name, version|
  kernel.load_assembly(name, version, File.join(lib, "#{name}@#{version}.jsii.tgz"))
end

require 'cdk8s'
require 'cdk8s-plus-27'

app = CDK8s::App.new
chart = CDK8s::Chart.new(app, 'hello')
CDK8sPlus27::Deployment.new(chart, 'web', {
  replicas: 2,
  containers: [{ image: 'nginx:1.27', port: 80 }],
})
app.synth
kernel.shutdown
