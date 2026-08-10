# frozen_string_literal: true

require 'spec_helper'

# A jsii static readonly member is generated as `def self.NAME` — a class
# method — because its value has to be fetched from the kernel and a Ruby
# constant is evaluated when the class body runs. That makes `Type::NAME`,
# which is how Ruby spells a constant read and how every other language spells
# this member, raise NameError; only `Type.NAME` works.
#
# Since the shape of this target is ours to choose, resolve the constant to the
# method instead, so both spellings work and translated examples can use the
# `::` form that reads as Ruby.
class BlockPublicAccessFixture < Jsii::Object
  # A nested type is a real constant, and must keep winning.
  class Nested; end

  # Named for the members aws-cdk-lib's aws_s3.BlockPublicAccess actually
  # declares, since that is the shape this has to work for.
  def self.BLOCK_ALL
    'block-all'
  end

  def self.BLOCK_ACLS
    'block-acls'
  end

  # A *mutable* static is generated snake_case as an ordinary accessor pair;
  # it is not a constant and must not become one.
  def self.non_const_static
    100
  end
end

class DerivedBlockPublicAccessFixture < BlockPublicAccessFixture; end

RSpec.describe 'static readonly members read as constants' do
  it 'resolves the constant form to the static member' do
    expect(BlockPublicAccessFixture::BLOCK_ALL).to eq('block-all')
    expect(BlockPublicAccessFixture::BLOCK_ACLS).to eq('block-acls')
  end

  it 'keeps the method form working' do
    # Anything already written against this target must keep running.
    expect(BlockPublicAccessFixture.BLOCK_ALL).to eq('block-all')
  end

  it 'reads the member on every access rather than freezing the first value' do
    # Memoising with const_set would go stale if the kernel were restarted, so
    # the constant form costs exactly what the method form costs.
    calls = 0
    allow(BlockPublicAccessFixture).to receive(:BLOCK_ALL) { calls += 1; 'block-all' }
    2.times { BlockPublicAccessFixture::BLOCK_ALL }
    expect(calls).to eq(2)
  end

  it 'leaves a nested type alone' do
    expect(BlockPublicAccessFixture::Nested).to be(BlockPublicAccessFixture::Nested)
    expect(BlockPublicAccessFixture::Nested.name).to end_with('Nested')
  end

  it 'still raises NameError for a constant that names nothing' do
    expect { BlockPublicAccessFixture::NOT_A_MEMBER }.to raise_error(NameError)
  end

  it 'does not expose a mutable static as a constant' do
    # Its value can change; a constant read implies it cannot.
    expect { BlockPublicAccessFixture::NON_CONST_STATIC }.to raise_error(NameError)
  end

  it 'resolves an inherited static through the subclass' do
    expect(DerivedBlockPublicAccessFixture::BLOCK_ALL).to eq('block-all')
  end
end

RSpec.describe 'static readonly members read as constants, over the kernel' do
  # The fixtures above stand in for the kernel; these go through it for real,
  # so a constant read is proven to make the same round-trip the method makes.
  it 'reads a primitive const' do
    expect(JsiiCalc::Statics::FOO).to eq('hello')
    expect(JsiiCalc::Statics::BAR).to eq(1234)
  end

  it 'reads an object-typed const' do
    expect(JsiiCalc::Statics::CONST_OBJ.hello).to eq('world')
  end

  it 'agrees with the method form' do
    expect(JsiiCalc::Statics::FOO).to eq(JsiiCalc::Statics.FOO)
  end
end
