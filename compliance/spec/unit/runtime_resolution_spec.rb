# frozen_string_literal: true

require 'spec_helper'
require 'tmpdir'

# How the kernel locates the `jsii-runtime` executable before it can start the
# sidecar. Resolution is env var, then PATH, then Node, then npm.
RSpec.describe 'jsii-runtime resolution' do
  # `resolve_jsii_runtime` is private and lives on the Kernel singleton; drive
  # it on a bare allocation so no sidecar is started.
  subject(:kernel) { Jsii::Kernel.send(:allocate) }

  def resolve = kernel.send(:resolve_jsii_runtime)

  around do |example|
    saved = ENV.to_h.slice('JSII_RUNTIME', 'PATH', 'PATHEXT')
    example.run
  ensure
    %w[JSII_RUNTIME PATH PATHEXT].each { |k| ENV.delete(k) }
    saved.each { |k, v| ENV[k] = v }
  end

  describe 'JSII_RUNTIME override' do
    it 'returns an existing path as a single-element command' do
      Dir.mktmpdir do |dir|
        exe = File.join(dir, 'jsii-runtime')
        File.write(exe, '')
        ENV['JSII_RUNTIME'] = exe
        expect(resolve).to eq([exe])
      end
    end

    it 'splits a non-path value into command and arguments' do
      ENV['JSII_RUNTIME'] = 'node /somewhere/jsii-runtime.js'
      expect(resolve).to eq(['node', '/somewhere/jsii-runtime.js'])
    end
  end

  describe 'PATH lookup' do
    it 'finds an executable entry on PATH' do
      Dir.mktmpdir do |dir|
        exe = File.join(dir, 'jsii-runtime')
        File.write(exe, '')
        File.chmod(0o755, exe)
        ENV.delete('JSII_RUNTIME')
        ENV['PATH'] = dir
        expect(resolve).to eq(['jsii-runtime'])
      end
    end

    it 'ignores a non-executable file of the same name' do
      Dir.mktmpdir do |dir|
        File.write(File.join(dir, 'jsii-runtime'), '')
        File.chmod(0o644, File.join(dir, 'jsii-runtime'))
        ENV.delete('JSII_RUNTIME')
        ENV['PATH'] = dir
        # Falls through to the Node/npm strategies rather than claiming a hit.
        expect(kernel.send(:jsii_runtime_on_path?)).to be(false)
      end
    end

    it 'ignores a directory of the same name' do
      Dir.mktmpdir do |dir|
        Dir.mkdir(File.join(dir, 'jsii-runtime'))
        ENV.delete('JSII_RUNTIME')
        ENV['PATH'] = dir
        expect(kernel.send(:jsii_runtime_on_path?)).to be(false)
      end
    end

    it 'does not shell out' do
      Dir.mktmpdir do |dir|
        exe = File.join(dir, 'jsii-runtime')
        File.write(exe, '')
        File.chmod(0o755, exe)
        ENV.delete('JSII_RUNTIME')
        ENV['PATH'] = dir
        # A shell-out needs `which`/`where` to exist, which minimal containers
        # do not guarantee; the lookup must be pure Ruby.
        expect(kernel).not_to receive(:system)
        expect(kernel).not_to receive(:`)
        expect(resolve).to eq(['jsii-runtime'])
      end
    end

    it 'tolerates an unset or empty PATH' do
      ENV.delete('JSII_RUNTIME')
      ENV.delete('PATH')
      expect { kernel.send(:jsii_runtime_on_path?) }.not_to raise_error
      expect(kernel.send(:jsii_runtime_on_path?)).to be(false)
    end
  end
end
