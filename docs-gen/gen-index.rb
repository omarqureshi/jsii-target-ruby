#!/usr/bin/env ruby
# frozen_string_literal: true
#
# Assembly-driven root index -> <out>/AWSCDK/index.html
# Walks the jsii assembly's submodules for authoritative Ruby module names; links the
# modules whose docs are built under <out>/AWSCDK/<Module>/. Prepends a hand-written
# "Getting started" section (install, a first stack, deploy, naming rules).
#
# Markup lives in templates/docs-index.html.erb (page + getting-started prose) and
# templates/docs-redirect.html.erb; this script only builds the view model. The
# getting-started code blocks stay here because they're syntax-highlighted with Rouge.
#
#   gen-index.rb <assembly.jsii(.gz)> <out-dir>
require 'json'
require 'zlib'
require 'set'
require_relative 'render'
begin
  require 'rouge' # syntax highlighting for the getting-started code blocks
rescue LoadError
  # fall back to plain (escaped) code if the gem isn't present
end

assembly_path, out_dir = ARGV
awscdk = File.join(out_dir, 'AWSCDK')
raw = File.binread(assembly_path)
assembly = JSON.parse(raw[0, 2].bytes == [0x1f, 0x8b] ? Zlib.gunzip(raw) : raw)

# Top-level submodule fqns (`aws-cdk-lib.<name>`) that actually contain types.
# A type-less submodule is a deprecated tombstone (only AWSCDK::Assets — "All types
# moved to @aws-cdk/core") with no page to link to; skip it rather than list a dead entry.
subs_with_types = assembly.fetch('types', {}).keys.map { |tf| tf.split('.')[0, 2].join('.') }.to_set

modules = assembly.fetch('submodules', {}).filter_map do |fqn, sub|
  name = sub.dig('targets', 'ruby', 'module')
  next unless name
  # Only top-level modules (AWSCDK::X). Nested sub-namespaces like AWSCDK::ECR::Mixins
  # are listed on their parent module's page, not here.
  next unless name.split('::').length == 2
  next unless subs_with_types.include?(fqn)

  { name: name, leaf: name.split('::').last }
end.uniq { |m| m[:name] }.sort_by { |m| m[:name].downcase }

# DOCS_ASSUME_BUILT=1 is the fast "landing only" mode: the class-page tree
# isn't present (no YARD run), so instead of probing the filesystem for which
# modules/types were built, assume every module and root type in the assembly
# has a live page — true for the site, which always full-builds all modules.
# Lets the landing be regenerated from the assembly alone, fully linked.
assume_built = ENV['DOCS_ASSUME_BUILT'] == '1'
built =
  if assume_built
    modules.map { |m| m[:leaf] }
  elsif File.directory?(awscdk)
    Dir.children(awscdk).select { |d| File.directory?(File.join(awscdk, d)) }
  else
    []
  end
built = built.to_set
module_view = modules.map { |m| m.merge(live: built.include?(m[:leaf])) }

# The AWSCDK root module's own core types (Stack, App, IResolvable, Duration, ...) —
# fqn `aws-cdk-lib.<Type>`, built as AWSCDK/<Type>.html (siblings of the submodule
# dirs). List them from the built pages; kind comes from the assembly.
norm = ->(s) { s.downcase.gsub(/[^a-z0-9]/, '') }
root_kind = {}
root_types = []
assembly.fetch('types', {}).each do |fqn, t|
  next unless fqn.count('.') == 1 && fqn.start_with?("#{assembly['name']}.")

  short = fqn.rpartition('.').last
  root_kind[norm.call(short)] = t['kind']
  root_types << { name: short, href: "#{short}.html", kind: t['kind'] }
end
core =
  if assume_built
    # Assembly-driven: every root type has a live AWSCDK/<Type>.html page.
    root_types
  else
    Dir.glob(File.join(awscdk, '*.html')).filter_map do |f|
      base = File.basename(f)
      next if base == 'index.html'

      name = File.basename(f, '.html')
      # Only real root types, not orphan module pages. A type-less submodule with a README
      # (e.g. the deprecated AWSCDK::Assets tombstone) still gets a YARD module page at
      # AWSCDK/<Name>.html; the assembly has no root type by that name, so skip it.
      next unless root_kind.key?(norm.call(name))

      { name: name, href: base, kind: root_kind[norm.call(name)] }
    end
  end.sort_by { |c| c[:name].downcase }

# Group the core types (Classes / Interfaces / Enums / Other) for the template.
core_groups = []
unless core.empty?
  by_kind = core.group_by { |c| c[:kind] }
  [%w[class Classes], %w[interface Interfaces], %w[enum Enums]].each do |kind, label|
    items = by_kind[kind]
    next if items.nil? || items.empty?

    core_groups << { label: label, count: items.length, items: items }
  end
  other = core.reject { |c| %w[class interface enum].include?(c[:kind]) }
  core_groups << { label: 'Other', count: other.length, items: other } if other.any?
end

esc = ->(s) { s.to_s.gsub('&', '&amp;').gsub('<', '&lt;').gsub('>', '&gt;') }
code = lambda do |text, lang = 'ruby'|
  inner =
    if defined?(Rouge)
      lexer = Rouge::Lexer.find(lang) || Rouge::Lexers::PlainText.new
      Rouge::Formatters::HTML.new.format(lexer.lex(text))
    else
      esc.call(text)
    end
  %(<pre class="cb"><code>#{inner}</code></pre>)
end

# Preview builds are release-style versions (0.0.0.<timestamp>) since
# 2026-07-24, so a bare requirement resolves the newest build directly —
# no version incantation, and the lockfile pins reproducibility. Everything
# else (constructs, the asset packages, the jsii runtime) arrives as an
# exact-pinned transitive dependency of the one gem.
gemfile = <<~RUBY
  source 'https://rubygems.org'

  # The Ruby CDK preview — everything it needs comes with it.
  gem 'aws-cdk-lib', source: 'https://rubygems.omarqureshi.net'
RUBY

stack = <<~RUBY
  # stacks/my_stack.rb
  require 'aws-cdk-lib'

  class MyStack < AWSCDK::Stack
    def initialize(scope, id, props = nil)
      super(scope, id, props)

      AWSCDK::S3::Bucket.new(
        self,
        'MyBucket',
        {
          versioned: true,
          removal_policy: AWSCDK::RemovalPolicy::DESTROY,
          auto_delete_objects: true
        }
      )
    end
  end
RUBY

app = <<~RUBY
  # app.rb
  require 'aws-cdk-lib'
  require_relative 'stacks/my_stack'

  app = AWSCDK::App.new

  MyStack.new(app, 'MyStack', {
    env: AWSCDK::Environment.new(
      account: ENV['CDK_DEFAULT_ACCOUNT'],
      region: ENV.fetch('CDK_DEFAULT_REGION', 'us-east-1')
    )
  })

  app.synth
RUBY

deploy = <<~SH
  $ bundle install
  $ npm install -g aws-cdk @jsii/runtime
  $ cdk deploy
SH

Dir.mkdir(awscdk) unless File.directory?(awscdk)
File.write(File.join(awscdk, 'index.html'), Render.page('docs-index',
  modules: module_view,
  core_groups: core_groups,
  core_count: core.length,
  gemfile_html: code.call(gemfile),
  cdkjson_html: code.call(%({\n  "app": "bundle exec ruby app.rb"\n}), 'json'),
  stack_html: code.call(stack),
  app_html: code.call(app),
  deploy_html: code.call(deploy, 'console'),
  generated_on: Time.now.strftime('%a %b %d %H:%M:%S %Y')))

# Stylesheets are served from the canonical /styles/ path (deployed separately),
# linked protocol-relative — not copied next to the page.

# Redirect the site root to the API index (overwrites YARD's leftover root index.html).
File.write(File.join(out_dir, 'index.html'), Render.page('docs-redirect'))

puts "AWSCDK/index.html: #{modules.length} modules (#{built.size} linked) + getting-started; root -> redirect"
