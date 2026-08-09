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
