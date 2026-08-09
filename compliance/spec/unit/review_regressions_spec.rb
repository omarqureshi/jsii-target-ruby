# frozen_string_literal: true

require 'spec_helper'

# Regression specs for the defects found by the max-effort code review
# (2026-08-09). Each example fails against the pre-fix runtime.
RSpec.describe 'code-review regressions' do
  describe 'Jsii::Utils.underscore — generator parity for common abbreviations' do
    # codemaker's toSnakeCase folds KiB/MiB/GiB before decamelizing, so the
    # generator emits `memory_limit_mib`. When this mapper disagreed
    # (`memory_limit_mi_b`), kernel callbacks dispatched to a method that was
    # never generated and the synth aborted with NoMethodError.
    {
      'memoryLimitMiB' => 'memory_limit_mib',
      'sizeInGiB' => 'size_in_gib',
      'volumeSizeKiB' => 'volume_size_kib',
      # Unrelated casing must be unaffected.
      'enforceSSL' => 'enforce_ssl',
      'myVPCId' => 'my_vpc_id',
      'x509Certificate' => 'x509_certificate',
      'parseJSON' => 'parse_json'
    }.each do |input, expected|
      it "maps #{input} to #{expected}" do
        expect(Jsii::Utils.underscore(input)).to eq(expected)
      end
    end
  end

  describe 'Jsii::Utils.jsii_member_name — inverse of ruby_member_name' do
    # camelize consumed the generator's leading-underscore escape and upcased
    # the next letter, so `_next` was dispatched to the kernel as `Next` and
    # reported as a missing member.
    %w[next send class end retry].each do |reserved|
      it "round-trips the escaped reserved word #{reserved}" do
        ruby = Jsii::Utils.ruby_member_name(reserved)
        expect(ruby).to eq("_#{reserved}")
        expect(Jsii::Utils.jsii_member_name(ruby)).to eq(reserved)
      end
    end

    it 'round-trips the reserved jsii_ namespace' do
      ruby = Jsii::Utils.ruby_member_name('jsiiRef')
      expect(ruby).to eq('_jsii_ref')
      expect(Jsii::Utils.jsii_member_name(ruby)).to eq('jsiiRef')
    end

    it 'round-trips digit-leading members' do
      ruby = Jsii::Utils.ruby_member_name('2fa')
      expect(ruby).to eq('_2fa')
      expect(Jsii::Utils.jsii_member_name(ruby)).to eq('2fa')
    end

    it 'round-trips ordinary members' do
      expect(Jsii::Utils.jsii_member_name('bucket_arn')).to eq('bucketArn')
      expect(Jsii::Utils.jsii_member_name(Jsii::Utils.ruby_member_name('memoryLimitMiB'))).to eq('memoryLimitMib')
    end

    it 'leaves a leading underscore alone when it is not an escape' do
      # `_foo` is not a reserved word / jsii_ / digit-leading name, so the
      # underscore is part of the member name, not the generator's marker.
      expect(Jsii::Utils.camelize('_foo_bar')).to eq('_fooBar')
    end
  end

  describe 'Jsii::Serializer.dump_date — does not mutate the caller' do
    it 'leaves a Time argument untouched' do
      t = Time.new(2024, 6, 15, 12, 30, 45, '+02:00')
      before = t.to_s
      Jsii::Serializer.dump(t)
      expect(t.to_s).to eq(before)
      expect(t.utc?).to be(false)
    end

    it 'serializes a frozen Time instead of raising FrozenError' do
      t = Time.new(2024, 1, 1, 0, 0, 0, '+00:00').freeze
      expect { Jsii::Serializer.dump(t) }.not_to raise_error
    end

    it 'still encodes the correct UTC instant' do
      t = Time.new(2024, 6, 15, 12, 30, 45, '+02:00')
      expect(Jsii::Serializer.dump(t)['$jsii.date']).to start_with('2024-06-15T10:30:45')
    end
  end

  describe 'Jsii::Serializer.dump — $jsii.map envelope' do
    it 'wraps maps whose keys collide with wire tags' do
      encoded = Jsii::Serializer.dump({ '$jsii.byref' => 'not-a-handle' })
      expect(encoded).to eq({ '$jsii.map' => { '$jsii.byref' => 'not-a-handle' } })
    end

    it 'round-trips such a map through load' do
      original = { '$jsii.byref' => 'not-a-handle', 'ok' => 1 }
      expect(Jsii::Serializer.load(Jsii::Serializer.dump(original))).to eq(original)
    end

    it 'leaves ordinary maps unwrapped' do
      expect(Jsii::Serializer.dump({ 'a' => 1 })).to eq({ 'a' => 1 })
    end
  end

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

  describe 'Jsii::Error#missing_member? — matches the message, not the remote stack' do
    it 'does not misclassify a remote failure whose stack contains a trigger phrase' do
      err = Jsii::RuntimeError.new('Stack Foo failed to synthesize', "at boom (does not exist)\nat next")
      expect(err.message).to include('does not exist') # stack is appended to #to_s
      expect(err.missing_member?).to be(false)
    end

    it 'still recognises a genuine missing member' do
      expect(Jsii::RuntimeError.new("Property 'x' is not a property of Y").missing_member?).to be(true)
    end
  end
end

# End-to-end: an override that raises a non-StandardError must not deadlock
# the kernel. Pre-fix, `rescue StandardError` in process_callback_request did
# not catch NotImplementedError (a ScriptError), so the `complete` envelope
# was never written and the sidecar waited forever — the timeout below is a
# guard so a regression fails the suite instead of hanging it.
RSpec.describe 'code-review regressions: callback error classes', :kernel do
  require 'timeout'

  before(:all) do
    Object.const_set(:RaisesNotImplemented, Class.new(JsiiCalc::SyncVirtualMethods) do
      def virtual_method(_n)
        raise NotImplementedError, 'subclass must implement'
      end
    end)
  end

  it 'surfaces NotImplementedError from an override as a Jsii error, then keeps the kernel usable' do
    obj = RaisesNotImplemented.new

    Timeout.timeout(20) do
      expect { obj.caller_is_method }.to raise_error(StandardError, /subclass must implement/)
    end

    # The kernel must still be responsive — a missed `complete` would leave
    # the next request reading a stale/absent reply.
    Timeout.timeout(20) do
      expect(JsiiCalc::Statics.static_method('kernel-still-alive')).to be_a(String)
    end
  end
end
