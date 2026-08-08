#!/usr/bin/env ruby
# frozen_string_literal: true
#
# Per-namespace landing pages, driven by the YARD output tree (so it also covers
# namespaces the assembly doesn't tag with a Ruby module — e.g. the ~280 per-service
# sub-namespaces under `interfaces`). Walks AWSCDK/**: a subdir is a namespace unless
# its sibling <X>.html is a "Class:" page (that's a class's nested-types dir, e.g.
# CfnTable). Each landing lists child namespaces + classes/interfaces/enums. Kind and
# summary come from the assembly where available, else the YARD page type.
#
#   gen-module-landing.rb <assembly.jsii(.gz)> <out-dir>
require 'json'
require 'zlib'
require 'set'
require_relative 'render'

assembly_path, out_dir = ARGV
awscdk = File.join(out_dir, 'AWSCDK')
raw = File.binread(assembly_path)
assembly = JSON.parse(raw[0, 2].bytes == [0x1f, 0x8b] ? Zlib.gunzip(raw) : raw)

norm = ->(s) { s.downcase.gsub(/[^a-z0-9]/, '') }
ruby_mod = {}
assembly.fetch('submodules', {}).each { |fqn, s| (rm = s.dig('targets', 'ruby', 'module')) && (ruby_mod[fqn] = rm) }

by_mod = Hash.new { |h, k| h[k] = {} }
assembly.fetch('types', {}).each do |fqn, t|
  rm = ruby_mod[fqn.rpartition('.').first]
  next unless rm

  by_mod[rm][norm.call(fqn.rpartition('.').last)] = { kind: t['kind'], summary: t.dig('docs', 'summary') }
end

esc = ->(s) { s.to_s.gsub('&', '&amp;').gsub('<', '&lt;').gsub('>', '&gt;') }
SECTIONS = [['class', 'Classes'], ['interface', 'Interfaces'], ['enum', 'Enums']].freeze

# YARD page kind from its <h1>: Class -> class; Module -> (jsii) interface; else nil.
page_kind = lambda do |html_path|
  return nil unless File.exist?(html_path)

  head = File.read(html_path, 8192)   # <h1> sits after YARD's head; read enough to reach it
  if head =~ /<h1>\s*Class:/ then 'class'
  elsif head =~ /<h1>\s*Module:/ then 'interface'
  end
end
class_page = ->(p) { page_kind.call(p) == 'class' }

render_rows = lambda do |items|
  items.sort_by { |c| c[:name].downcase }.map do |c|
    summary = c[:summary] ? %(<span class="s">#{esc.call(c[:summary][0, 90])}</span>) : ''
    %(<a class="row" href="#{c[:href]}"><span class="n">#{esc.call(c[:name])}</span>#{summary}</a>)
  end.join("\n      ")
end

count = 0
process = lambda do |dir|
  segs = dir.sub(%r{\A#{Regexp.escape(awscdk)}/?}, '').split('/').reject(&:empty?)
  rm = (['AWSCDK'] + segs).join('::')
  info = by_mod[rm]

  # A subdir is a namespace unless it's a type's nested-types dir: excluded if the
  # assembly knows a type by that name here (e.g. CfnTable), or its sibling <X>.html
  # is a "Class:" page. Interface sub-namespaces (no assembly ruby.module) fall through.
  child_ns = Dir.children(dir).select do |e|
    File.directory?(File.join(dir, e)) &&
      !info.key?(norm.call(e)) &&
      !class_page.call(File.join(dir, "#{e}.html"))
  end.sort
  ns_set = child_ns.to_set

  types = Dir.glob(File.join(dir, '*.html')).filter_map do |f|
    base = File.basename(f)
    next if base == 'index.html'

    name = File.basename(f, '.html')
    next if ns_set.include?(name)   # namespace page, listed under Namespaces instead

    meta = info[norm.call(name)] || {}
    { name: name, href: base, kind: meta[:kind] || page_kind.call(f), summary: meta[:summary] }
  end
  return if types.empty? && child_ns.empty?

  sections = []
  unless child_ns.empty?
    ns_rows = child_ns.map { |n| %(<a class="row ns" href="#{n}/index.html"><span class="n">#{esc.call(n)}</span></a>) }.join("\n      ")
    sections << %(<h2 class="sec">Namespaces <span class="ct">#{child_ns.length}</span></h2>\n      #{ns_rows})
  end
  by_kind = types.group_by { |c| c[:kind] }
  SECTIONS.each do |kind, label|
    items = by_kind[kind]
    next if items.nil? || items.empty?

    sections << %(<h2 class="sec">#{label} <span class="ct">#{items.length}</span></h2>\n      #{render_rows.call(items)})
  end
  other = types.reject { |c| SECTIONS.map(&:first).include?(c[:kind]) }
  sections << %(<h2 class="sec">Other <span class="ct">#{other.length}</span></h2>\n      #{render_rows.call(other)}) if other.any?

  crumb = [%(<a href="#{'../' * segs.length}index.html">AWSCDK</a>)]
  segs.each_with_index do |seg, i|
    crumb << (i == segs.length - 1 ? %(<span class="cur">#{esc.call(seg)}</span>) : %(<a href="#{'../' * (segs.length - 1 - i)}index.html">#{esc.call(seg)}</a>))
  end
  crumb = %(<nav class="cdk-crumb">#{crumb.join('<span class="sep">/</span>')}</nav>)

  sub = [(child_ns.any? ? "#{child_ns.length} namespaces" : nil), "#{types.length} types"].compact.join(' · ')

  # A module README (if pacmak emitted one) lands on YARD's module page —
  # "<dir>.html", the sibling of this landing. Lift its rendered discussion
  # block onto the landing and drop the now-orphan page. Its links are relative
  # to the module page, which sits one level above the landing, so bump each
  # relative href/src by one `../`.
  readme_inner = ''
  module_page = "#{dir}.html"
  if File.exist?(module_page)
    html = File.read(module_page)
    if (m = html.match(%r{<div class="discussion">(.*?)</div>\s*</div>}m)) && !m[1].strip.empty?
      readme_inner = m[1].strip.gsub(/\b(href|src)="(?!https?:|mailto:|#|\/)/, '\1="../')
    end
    File.delete(module_page)
  end
  # Every landing has the same shape — a README section and an API Reference section,
  # with jump links between them — so readers can skip the prose straight to the API.
  # A missing README is shown as an explicit gap (a CDK-content issue to fix), never a
  # different layout.
  readme_body =
    readme_inner.empty? ? '<p class="no-readme">No README for this module yet.</p>' : readme_inner

  File.write(File.join(dir, 'index.html'), Render.page('module-landing',
    rm: rm,
    crumb_html: crumb,
    sub: sub,
    readme_body: readme_body,
    sections_html: sections.join("\n      "),
    generated_on: Time.now.strftime('%a %b %d %H:%M:%S %Y')))
  count += 1

  child_ns.each { |n| process.call(File.join(dir, n)) }
end

Dir.children(awscdk)
   .select { |d| File.directory?(File.join(awscdk, d)) && !class_page.call(File.join(awscdk, "#{d}.html")) }
   .sort.each { |m| process.call(File.join(awscdk, m)) }

puts "wrote #{count} namespace landings"
