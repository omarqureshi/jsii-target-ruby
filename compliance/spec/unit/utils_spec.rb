# frozen_string_literal: true

require 'spec_helper'

RSpec.describe Jsii::Utils do
  describe '.underscore' do
    it 'converts camelCase to snake_case' do
      expect(described_class.underscore('camelCase')).to eq('camel_case')
      expect(described_class.underscore('readOnlyString')).to eq('read_only_string')
    end

    it 'converts PascalCase to snake_case' do
      expect(described_class.underscore('PascalCase')).to eq('pascal_case')
      expect(described_class.underscore('S3Bucket')).to eq('s3_bucket')
    end

    it 'preserves trailing acronym groups' do
      expect(described_class.underscore('parseHTML')).to eq('parse_html')
      expect(described_class.underscore('HTTPRequest')).to eq('http_request')
    end

    # The implementation is adapted from ActiveSupport's String#underscore
    # and inherits two behaviors no jsii input can ever trigger: member names
    # on the wire are plain camelCase identifiers (alphanumeric, see
    # dynamic_invocation.rb), so they never contain '-' or '::'.  These
    # examples pin the inherited behavior so a future reimplementation that
    # changes it does so knowingly.
    it 'replaces hyphens with underscores (ActiveSupport heritage; unused by jsii)' do
      expect(described_class.underscore('foo-bar')).to eq('foo_bar')
    end

    it 'converts namespace separators to path separators, NOT underscores (ActiveSupport heritage; unused by jsii)' do
      expect(described_class.underscore('Foo::Bar')).to eq('foo/bar')
    end

    it 'is a no-op for already snake_case strings' do
      expect(described_class.underscore('already_snake')).to eq('already_snake')
    end

    it 'accepts symbols' do
      expect(described_class.underscore(:fooBar)).to eq('foo_bar')
    end
  end

  describe '.camelize' do
    it 'converts snake_case to camelCase' do
      expect(described_class.camelize('snake_case')).to eq('snakeCase')
      expect(described_class.camelize('read_only_string')).to eq('readOnlyString')
    end

    it 'accepts symbols' do
      expect(described_class.camelize(:foo_bar)).to eq('fooBar')
    end

    it 'leaves single-word strings unchanged' do
      expect(described_class.camelize('foo')).to eq('foo')
    end
  end

  describe '.ruby_member_name' do
    it 'passes through non-reserved snake_case names' do
      expect(described_class.ruby_member_name('fooBar')).to eq('foo_bar')
      expect(described_class.ruby_member_name('hello')).to eq('hello')
    end

    it 'prefixes Ruby keywords with an underscore' do
      expect(described_class.ruby_member_name('break')).to eq('_break')
      expect(described_class.ruby_member_name('class')).to eq('_class')
      expect(described_class.ruby_member_name('while')).to eq('_while')
      expect(described_class.ruby_member_name('end')).to eq('_end')
    end

    it 'prefixes runtime-critical Object methods (send, __send__) with an underscore' do
      # Without this remap, a callback for a JSII member named `send` would
      # invoke `Object#send` and treat the first arg as a method name.
      expect(described_class.ruby_member_name('send')).to eq('_send')
      expect(described_class.ruby_member_name('__send__')).to eq('___send__')
    end

    it 'prefixes names that start with a digit' do
      expect(described_class.ruby_member_name('2fa')).to eq('_2fa')
    end

    it 'mirrors the generator on names that snake_case into a keyword' do
      # Generator path: toSnakeCase('While') === 'while' → reserved → '_while'.
      expect(described_class.ruby_member_name('While')).to eq('_while')
    end

    it 'prefixes constructor/allocation hooks (initialize, new, allocate)' do
      # A JSII member named `initialize` would otherwise replace the
      # generated constructor; `new`/`allocate` are the class methods used
      # to instantiate proxies (the registry hydrates refs via
      # `klass.allocate`).
      expect(described_class.ruby_member_name('initialize')).to eq('_initialize')
      expect(described_class.ruby_member_name('new')).to eq('_new')
      expect(described_class.ruby_member_name('allocate')).to eq('_allocate')
    end

    it 'prefixes runtime serialization/dispatch hooks (to_jsii, ruby_class)' do
      expect(described_class.ruby_member_name('toJsii')).to eq('_to_jsii')
      expect(described_class.ruby_member_name('rubyClass')).to eq('_ruby_class')
    end

    it 'prefixes any name in the reserved jsii_ namespace' do
      # The whole `jsii_` prefix is reserved for the runtime's API surface,
      # present and future — jsii_ref, jsii_serialize, jsii_call_method, ...
      expect(described_class.ruby_member_name('jsiiRef')).to eq('_jsii_ref')
      expect(described_class.ruby_member_name('jsiiSerialize')).to eq('_jsii_serialize')
      expect(described_class.ruby_member_name('jsiiSomeFutureApi')).to eq('_jsii_some_future_api')
    end
  end

  describe '.blank?' do
    it 'returns true for nil' do
      expect(described_class.blank?(nil)).to be true
    end

    it 'returns true for empty strings and whitespace-only strings' do
      expect(described_class.blank?('')).to be true
      expect(described_class.blank?('   ')).to be true
      expect(described_class.blank?("\t\n")).to be true
    end

    it 'returns false for non-empty strings' do
      expect(described_class.blank?('hello')).to be false
    end

    it 'returns true for empty arrays/hashes' do
      expect(described_class.blank?([])).to be true
      expect(described_class.blank?({})).to be true
    end

    it 'returns false for non-empty arrays/hashes' do
      expect(described_class.blank?([1])).to be false
      expect(described_class.blank?({ a: 1 })).to be false
    end

    it 'returns false for any non-string non-collection non-nil value' do
      expect(described_class.blank?(0)).to be false
      expect(described_class.blank?(false)).to be false
    end
  end

  describe 'does not monkey-patch core classes' do
    # Regression guard: jsii-ruby-runtime must coexist with ActiveSupport.
    it 'does not define underscore on String' do
      expect('Anything').not_to respond_to(:underscore)
    end

    it 'does not define camelize on String or Symbol' do
      expect('anything').not_to respond_to(:camelize)
      expect(:anything).not_to respond_to(:camelize)
    end

    it 'does not define blank? on Object' do
      expect(Object.new).not_to respond_to(:blank?)
    end

    it 'does not define jsii_serialize on Object' do
      expect(Object.new).not_to respond_to(:jsii_serialize)
    end

    it 'does not define jsii_deserialize on Hash' do
      expect({}).not_to respond_to(:jsii_deserialize)
    end
  end

  describe 'RUBY_RESERVED_NAMES' do
    it 'is consistent with jsii-pacmak' do
      pacmak_ruby_ts = File.expand_path('../../../src/helpers.ts', __dir__)
      expect(File.exist?(pacmak_ruby_ts)).to be(true), "Expected #{pacmak_ruby_ts} to exist"

      content = File.read(pacmak_ruby_ts)
      match = content.match(/const RUBY_RESERVED_NAMES = new Set\(\[(.*?)\]\)/m)
      expect(match).not_to be_nil

      pacmak_names = match[1].scan(/'([^']+)'/).flatten.to_set
      expect(Jsii::Utils::RUBY_RESERVED_NAMES).to eq(pacmak_names)
    end
  end
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

end
