# frozen_string_literal: true

require 'spec_helper'

RSpec.describe 'Jsii.downcast' do
  # A downcast is a VIEW of an existing object under another type. The
  # registry entry for a ref is what the kernel's callback dispatcher uses to
  # find the guest object holding the overrides, so a view must never replace
  # it — otherwise overrides silently stop being invoked and the host's base
  # implementation answers instead, with no error.
  it 'keeps the original object registered, so its overrides keep firing' do
    obj = SyncOverrides.new
    obj.multiplier = 1
    before = obj.caller_is_method

    Jsii.downcast(obj, Scope::JsiiCalcLib::IFriendly)

    expect(Jsii::Object.find_by_ref(obj.jsii_ref)).to equal(obj)
    expect(obj.caller_is_method).to eq(before)
  end

  it 'returns a usable view of the same underlying object' do
    # Add is a BinaryOperation, which really does implement IFriendly.
    obj = JsiiCalc::Add.new(Scope::JsiiCalcLib::Number.new(40), Scope::JsiiCalcLib::Number.new(2))
    view = Jsii.downcast(obj, Scope::JsiiCalcLib::IFriendly)

    expect(view).not_to equal(obj)
    expect(view.jsii_ref).to eq(obj.jsii_ref)
    expect(view.hello).to be_a(String)
  end

  it 'registers the view when the ref has no live instance yet' do
    obj = SyncOverrides.new
    ref = obj.jsii_ref
    Jsii::Object.objects.delete(ref)

    view = Jsii.downcast(obj, Scope::JsiiCalcLib::IFriendly)
    expect(Jsii::Object.find_by_ref(ref)).to equal(view)
  end
end
