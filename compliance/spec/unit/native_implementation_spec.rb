# frozen_string_literal: true

require 'spec_helper'

# Pure-native implementations: a plain Ruby class that `include`s a generated
# interface module and is passed to the kernel. Registration materializes it
# as a remote object; these specs pin the two invariants that registration
# has to preserve.
RSpec.describe 'native interface implementations' do
  describe 'object identity across the boundary' do
    # docs/decisions.md promises "object identity round-trips through the
    # object registry". Registration caches @jsii_ref on the value, but
    # serialization never consulted it — so every pass created a NEW remote
    # object, breaking identity comparisons and leaking a kernel object each
    # time.
    it 'serializes to the same ref every time' do
      pure = PureNativeFriendlyRandom.new

      first = Jsii::Serializer.dump(pure)
      second = Jsii::Serializer.dump(pure)

      expect(first).to eq(second)
      expect(pure.jsii_ref).to eq(first['$jsii.byref'])
    end

    it 'is recognised as the same object by the host' do
      pure = PureNativeFriendlyRandom.new
      gen = JsiiCalc::NumberGenerator.new(pure)

      expect(gen.is_same_generator(pure)).to be(true)
    end
  end

  describe 'missing required members' do
    # The guard keyed on `value.class.method_defined?`, but the generated
    # interface module defines a stub for every member, so including it made
    # the check vacuously true: a class that implemented nothing was accepted,
    # and the failure surfaced much later as a JavaScript TypeError from the
    # host ("this.generator.next is not a function").
    before(:all) do
      Object.const_set(:IncompleteFriendlyRandom, Class.new do
        include JsiiCalc::IFriendlyRandomGenerator

        def hello
          'hello'
        end
        # _next is deliberately NOT implemented.
      end)
    end

    it 'raises at the call that passes the object, naming the member and interface' do
      expect { JsiiCalc::NumberGenerator.new(IncompleteFriendlyRandom.new) }
        .to raise_error(/missing required method\/property: _next.*IFriendlyRandomGenerator/m)
    end

    it 'still accepts a complete implementation' do
      expect { JsiiCalc::NumberGenerator.new(PureNativeFriendlyRandom.new) }.not_to raise_error
    end
  end
end

RSpec.describe 'interfaces attached with extend' do
  # jsii_interfaces (used when serializing a Jsii::Object) inspects
  # singleton_class.ancestors, so `obj.extend(SomeInterface)` counts. The
  # native-implementation path inspected value.class.ancestors instead, so the
  # same object serialized as a plain Ruby value saw no interfaces at all and
  # was rejected as unserializable.
  it 'recognises an interface attached to a single instance' do
    obj = Object.new
    obj.define_singleton_method(:hello) { 'hi' }
    obj.define_singleton_method(:_next) { 42 }
    obj.extend(JsiiCalc::IFriendlyRandomGenerator)

    expect { Jsii::Serializer.dump(obj) }.not_to raise_error
    expect(Jsii::Serializer.dump(obj)).to have_key('$jsii.byref')
  end
end
