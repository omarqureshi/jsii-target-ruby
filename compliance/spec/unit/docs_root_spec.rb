# frozen_string_literal: true

require 'tmpdir'
require_relative '../../../docs-gen/root_module'

# Where the generated docs tree is rooted. The docs generators read this from
# the assembly rather than naming AWSCDK, and the publish workflow asks
# DocsRoot.detect for the directory to summarise — so a wrong answer here is
# what an empty published module list looks like.
RSpec.describe DocsRoot do
  describe '.from_assembly' do
    it 'prefers the assembly\'s declared Ruby module' do
      assembly = { 'name' => 'aws-cdk-lib', 'targets' => { 'ruby' => { 'module' => 'AWSCDK' } } }
      expect(described_class.from_assembly(assembly)).to eq('AWSCDK')
    end

    it 'ignores an empty declared module' do
      assembly = { 'name' => 'aws-cdk-lib', 'targets' => { 'ruby' => { 'module' => '' } } }
      expect(described_class.from_assembly(assembly)).to eq('AwsCdkLib')
    end

    it 'derives a PascalCase name from a hyphenated package name' do
      expect(described_class.from_assembly({ 'name' => 'aws-cdk-lib' })).to eq('AwsCdkLib')
    end

    it 'derives a name from a scoped package, dropping the @' do
      expect(described_class.from_assembly({ 'name' => '@scope/pkg' })).to eq('ScopePkg')
    end

    it 'treats underscores as word separators' do
      expect(described_class.from_assembly({ 'name' => 'my_lib' })).to eq('MyLib')
    end

    it 'falls back when the assembly has no name at all' do
      expect(described_class.from_assembly({})).to eq('Docs')
    end
  end

  describe '.detect' do
    def with_tree(entries)
      Dir.mktmpdir do |dir|
        entries.each do |entry|
          entry.end_with?('/') ? Dir.mkdir(File.join(dir, entry.chomp('/'))) : File.write(File.join(dir, entry), '')
        end
        yield dir
      end
    end

    it 'returns the single module directory beside YARD\'s assets' do
      with_tree(['AWSCDK/', 'css/', 'js/', 'index.html']) do |dir|
        expect(described_class.detect(dir)).to eq('AWSCDK')
      end
    end

    it 'raises when the tree has no module directory' do
      # What a build that generated nothing looks like. Publishing this would
      # replace the live docs with an empty index.
      with_tree(['css/', 'js/', 'index.html']) do |dir|
        expect { described_class.detect(dir) }.to raise_error(/cannot determine the docs root module/)
      end
    end

    it 'raises rather than guessing between two candidates' do
      with_tree(['AWSCDK/', 'SomethingElse/', 'css/']) do |dir|
        expect { described_class.detect(dir) }.to raise_error(/cannot determine the docs root module/)
      end
    end
  end
end
