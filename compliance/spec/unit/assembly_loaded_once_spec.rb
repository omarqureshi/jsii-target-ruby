# frozen_string_literal: true

require 'spec_helper'

# Loading the same assembly twice leaves the kernel holding two module
# instances of it, and the second one is invisible: every `instanceof` check
# inside that library then fails against objects made by the other copy.
#
# This is not hypothetical. A cdk8s app that loaded its assemblies explicitly —
# not knowing each generated entry point already loads its own on require —
# synthesized correctly on Node 24 and died on Node 22 with
# "can't render non-simple object of type 'Lazy'", because cdk8s's
# `value instanceof Lazy` was comparing against the other copy's class. The
# error named a type in a library nobody had touched, several layers from the
# cause.
#
# So the second load is refused here, where the name is still in hand.
describe 'loading an assembly twice' do
  let(:tarball) { Dir.glob(File.expand_path('../../lib/ruby/lib/**/jsii-calc@*.jsii.tgz', __dir__)).first }

  it 'has a tarball to load' do
    expect(tarball).not_to be_nil, 'no jsii-calc tarball; run the compliance generation first'
  end

  it 'is a no-op rather than a second load' do
    # jsii-calc is already loaded by the suite, so this is the second load.
    expect { Jsii::Assembly.load('jsii-calc', jsii_calc_version, tarball) }.not_to raise_error
  end

  it 'does not ask the kernel to load it again' do
    expect(Jsii::Kernel.instance).not_to receive(:load_assembly)
    Jsii::Assembly.load('jsii-calc', jsii_calc_version, tarball)
  end

  it 'still returns a usable wrapper for the assembly' do
    assembly = Jsii::Assembly.load('jsii-calc', jsii_calc_version, tarball)
    expect(assembly.name).to eq('jsii-calc')
  end

  it 'loads an assembly the kernel has not seen' do
    # The guard must not swallow a genuine first load.
    expect(Jsii::Kernel.instance).to receive(:load_assembly).once
    Jsii::Assembly.load('not-loaded-yet', '1.0.0', tarball)
  end

  def jsii_calc_version
    File.basename(tarball, '.jsii.tgz').split('@').last
  end
end
