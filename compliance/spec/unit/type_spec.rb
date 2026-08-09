require 'spec_helper'


module Mock
  class BaseStruct < Jsii::Struct
    def self.jsii_fqn
      'mock.BaseStruct'
    end
  end

  class DerivedStruct < BaseStruct
    def self.jsii_fqn
      'mock.DerivedStruct'
    end
  end

  class UnrelatedStruct < Jsii::Struct
    def self.jsii_fqn
      'mock.UnrelatedStruct'
    end
  end
end

RSpec.describe Jsii::Type do
  describe '.check_fqn' do
    before do
      # Mock the registry to return our mock structs
      allow(Jsii::Type).to receive(:resolve_fqn_to_ruby_class) do |fqn|
        case fqn
        when 'mock.BaseStruct' then Mock::BaseStruct
        when 'mock.DerivedStruct' then Mock::DerivedStruct
        when 'mock.UnrelatedStruct' then Mock::UnrelatedStruct
        else nil
        end
      end
    end

    it 'allows Hash for any struct' do
      expect {
        Jsii::Type.send(:check_fqn, {}, 'mock.BaseStruct', 'arg')
      }.not_to raise_error
    end

    it 'allows direct instances of the struct' do
      expect {
        Jsii::Type.send(:check_fqn, Mock::BaseStruct.new, 'mock.BaseStruct', 'arg')
      }.not_to raise_error
    end

    it 'allows subclass instances (normal inheritance)' do
      expect {
        Jsii::Type.send(:check_fqn, Mock::DerivedStruct.new, 'mock.BaseStruct', 'arg')
      }.not_to raise_error
    end

    it 'allows unrelated structs (duck typing for multiple inheritance)' do
      expect {
        Jsii::Type.send(:check_fqn, Mock::UnrelatedStruct.new, 'mock.BaseStruct', 'arg')
      }.not_to raise_error
    end
  end
end

RSpec.describe 'Jsii::Struct hash-style reads' do
  # Rosetta renders struct-typed property reads as `s[:member]`, which is also
  # how a Ruby user writes them when the value is still a hash literal. A
  # struct that crossed the kernel boundary is a hydrated Jsii::Struct, so it
  # has to answer the same form — otherwise translated examples raise
  # NoMethodError on values returned by the library.
  let(:struct) { JsiiCalc::StructA.new(required_string: 'hello', optional_number: 42) }

  it 'reads a member by symbol' do
    expect(struct[:required_string]).to eq('hello')
    expect(struct[:optional_number]).to eq(42)
  end

  it 'reads a member by string' do
    expect(struct['required_string']).to eq('hello')
  end

  it 'returns nil for an unset optional member' do
    expect(struct[:optional_string]).to be_nil
  end

  it 'raises for a member the struct does not have' do
    expect { struct[:nope] }.to raise_error(NameError, /nope/)
  end
end

RSpec.describe 'Jsii::Object.registered_class? performance' do
  # Called once per overridable member per object construction. A linear
  # Hash#value? scan over the fqn->class registry (thousands of entries for
  # aws-cdk-lib) made construction cost grow with library size.
  after do
    # The registry is process-global; don't leave synthetic entries behind for
    # the rest of the suite.
    Jsii::Object.registry.delete_if { |fqn, _| fqn.start_with?('perf.') }
  end

  it 'is constant-time with respect to registry size' do
    fake = Array.new(3000) { |i| [Class.new, "perf.Type#{i}"] }
    fake.each { |klass, fqn| Jsii::Object.register_jsii_fqn(fqn, klass) }

    needle = Class.new # never registered: the worst case for a linear scan
    started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    20_000.times { Jsii::Object.registered_class?(needle) }
    elapsed = Process.clock_gettime(Process::CLOCK_MONOTONIC) - started

    expect(elapsed).to be < 0.2, "20k lookups over a 3k registry took #{elapsed.round(3)}s"
  end

  it 'answers the same regardless of receiver' do
    # registered_class? is called as `ruby_class.registered_class?(owner)`, so
    # the receiver is whatever generated class is being inspected. A reverse
    # index memoized per receiver reports every generated class as
    # unregistered, which makes every generated method look like a user
    # override and floods the kernel with callbacks.
    klass = Class.new
    Jsii::Object.register_jsii_fqn('perf.ReceiverCheck', klass)

    expect(Jsii::Object.registered_class?(klass)).to be(true)
    expect(JsiiCalc::Calculator.registered_class?(klass)).to be(true)
    expect(Class.new(Jsii::Object).registered_class?(klass)).to be(true)
  end

  it 'still answers correctly' do
    klass = Class.new
    expect(Jsii::Object.registered_class?(klass)).to be(false)
    Jsii::Object.register_jsii_fqn('perf.Registered', klass)
    expect(Jsii::Object.registered_class?(klass)).to be(true)
  end

  it 'stops reporting a class that was replaced for its fqn' do
    old_klass = Class.new
    new_klass = Class.new
    Jsii::Object.register_jsii_fqn('perf.Replaced', old_klass)
    Jsii::Object.register_jsii_fqn('perf.Replaced', new_klass)

    expect(Jsii::Object.registered_class?(new_klass)).to be(true)
    expect(Jsii::Object.registered_class?(old_klass)).to be(false)
  end
end
