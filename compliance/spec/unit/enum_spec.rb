# frozen_string_literal: true

require 'spec_helper'

RSpec.describe Jsii::Enum do
  # NB: Jsii::Struct already had `alias eql? ==` alongside its `hash`; only
  # Jsii::Enum was missing both. These examples cover the enum.
  describe 'Jsii::Enum — usable as a Hash key / Set member' do
    let(:a1) { Jsii::Enum.new('my.Enum', 'A') }
    let(:a2) { Jsii::Enum.new('my.Enum', 'A') }
    let(:b) { Jsii::Enum.new('my.Enum', 'B') }

    it 'equal values share a hash and are eql?' do
      expect(a1).to eq(a2)
      expect(a1.hash).to eq(a2.hash)
      expect(a1).to eql(a2)
    end

    it 'looks up by an equal instance (kernel responses are new instances)' do
      counts = { a1 => 0 }
      counts[a2] += 1
      expect(counts[a1]).to eq(1)
    end

    it 'dedupes with uniq and matches in a Set' do
      require 'set'
      expect([a1, a2].uniq.size).to eq(1)
      expect(Set[a1].include?(a2)).to be(true)
    end

    it 'keeps distinct values distinct' do
      expect(a1).not_to eql(b)
      expect([a1, b].uniq.size).to eq(2)
    end
  end
end
