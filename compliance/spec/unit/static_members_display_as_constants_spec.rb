# frozen_string_literal: true

require 'spec_helper'
require 'tmpdir'
require 'fileutils'
require 'open3'

# YARD renders a static readonly member as what it is in the source — a
# singleton method — so the reference lists `.NODEJS_LATEST`. That is a valid
# spelling, but it is not the one the docs tell people to use, and on a
# static-heavy class it is the *only* spelling shown: Runtime's page carried 53
# dot-form entries against a single `::` in its example.
#
# Rewrite the displayed member name, and only that. The highlighted source
# below each member still says `def self.NAME`, because that is what the file
# says; upstream prose that mentions the dot form is AWS's text, not ours.
describe 'static members displayed as constants' do
  script = File.expand_path('../../../docs-gen/constantize-static-reads.rb', __dir__)

  # The three shapes YARD emits, taken verbatim from a published page, plus the
  # ones that must survive untouched.
  PAGE = <<~HTML
    <p>use the latest LTS runtime (<code>Runtime.NODEJS_LATEST</code>) to keep up-to-date.</p>
    <span class="summary_signature">
      <a href="#NODEJS_LATEST-class_method" title="NODEJS_LATEST (class method)">.<strong>NODEJS_LATEST</strong>  &#x21d2; AWSCDK::Lambda::Runtime </a>
    </span>
    <span class="summary_signature">
      <a href="#from_string-class_method" title="from_string (class method)">.<strong>from_string</strong>  &#x21d2; Object </a>
    </span>
    <span class="summary_signature">
      <a href="#bundling_image-instance_method" title="#bundling_image (instance method)">#<strong>bundling_image</strong>  &#x21d2; Object </a>
    </span>
    <div class="method_details ">
      <h3 class="signature " id="NODEJS_LATEST-class_method">
        .<strong>NODEJS_LATEST</strong>  &#x21d2; <tt>AWSCDK::Lambda::Runtime</tt>
      </h3>
      <pre class="code"><span class='kw'>def</span> <span class='kw'>self</span><span class='period'>.</span><span class='const'>NODEJS_LATEST</span></pre>
    </div>
  HTML

  def run_over(html, script)
    Dir.mktmpdir do |dir|
      FileUtils.mkdir_p(File.join(dir, 'AWSCDK', 'Lambda'))
      page = File.join(dir, 'AWSCDK', 'Lambda', 'Runtime.html')
      File.write(page, html)
      File.write(File.join(dir, 'AWSCDK', 'index.html'), '<html></html>')
      out, status = Open3.capture2e('ruby', script, dir)
      raise "script failed: #{out}" unless status.success?

      yield File.read(page), out
    end
  end

  it 'displays a SCREAMING_SNAKE class method as a constant in the summary list' do
    run_over(PAGE, script) do |html, _|
      expect(html).to include('>::<strong>NODEJS_LATEST</strong>')
      expect(html).not_to include('>.<strong>NODEJS_LATEST</strong>')
    end
  end

  it 'does the same for the member detail heading' do
    run_over(PAGE, script) do |html, _|
      expect(html).to match(/id="NODEJS_LATEST-class_method">\s*::<strong>NODEJS_LATEST<\/strong>/)
    end
  end

  it 'leaves an ordinary class method alone' do
    # `from_string` is a real method call; `::` would be wrong.
    run_over(PAGE, script) do |html, _|
      expect(html).to include('>.<strong>from_string</strong>')
    end
  end

  it 'leaves instance members alone' do
    run_over(PAGE, script) do |html, _|
      expect(html).to include('#<strong>bundling_image</strong>')
    end
  end

  it 'leaves the highlighted source definition alone' do
    # The source really does say `def self.NODEJS_LATEST`.
    run_over(PAGE, script) do |html, _|
      expect(html).to include("<span class='period'>.</span><span class='const'>NODEJS_LATEST</span>")
    end
  end

  it 'leaves upstream prose alone' do
    run_over(PAGE, script) do |html, _|
      expect(html).to include('<code>Runtime.NODEJS_LATEST</code>')
    end
  end

  it 'reports how many members it rewrote' do
    # Silence would make a no-op indistinguishable from a success.
    run_over(PAGE, script) { |_, out| expect(out).to match(/\b2\b/) }
  end
end
