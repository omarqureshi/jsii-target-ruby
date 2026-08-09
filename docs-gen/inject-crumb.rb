#!/usr/bin/env ruby
# frozen_string_literal: true
#
# Inject a full-path breadcrumb into every YARD class page, replacing YARD's broken
# frame nav (hidden by the theme). Each intermediate segment links to the right place:
# a namespace (has its own index.html landing) links to that landing; a class segment
# (e.g. CfnTable, which has nested property types under it) links to the class page.
#
# Must run AFTER gen-module-landing.rb, so namespace landings exist for the check.
#
#   inject-crumb.rb <out-dir>
require_relative 'root_module'

out_dir = ARGV[0]
# The root module name is library data; detect it from the built tree rather
# than hardcoding the CDK's.
root_module = DocsRoot.detect(out_dir)
awscdk = File.join(out_dir, root_module)
esc = ->(s) { s.to_s.gsub('&', '&amp;').gsub('<', '&lt;') }
count = 0

Dir.glob(File.join(awscdk, '**', '*.html')).each do |f|
  next if File.basename(f) == 'index.html'

  comps = f.sub("#{awscdk}/", '').split('/')   # [seg1, ..., segK, "Class.html"]
  next if comps.empty?                           # (root types are <Root>/<Type>.html: segs == [])

  segs = comps[0..-2]                            # dir segments (empty for a root type page)
  k = segs.length
  cls = File.basename(f, '.html')

  parts = [%(<a href="#{'../' * k}index.html">#{root_module}</a>)]
  segs.each_with_index do |seg, i|
    seg_dir = File.join(awscdk, *segs[0..i])
    link =
      if File.exist?(File.join(seg_dir, 'index.html'))
        ('../' * (k - 1 - i)) + 'index.html'      # namespace -> its landing
      else
        ('../' * (k - i)) + "#{seg}.html"          # class -> the class page (parent dir)
      end
    parts << %(<a href="#{link}">#{esc.call(seg)}</a>)
  end
  parts << %(<span class="cur">#{esc.call(cls)}</span>)
  crumb = %(<nav class="cdk-crumb">#{parts.join('<span class="sep">/</span>')}</nav>)

  html = File.read(f)
  html = html.sub(%r{[ \t]*<nav class="cdk-crumb">.*?</nav>\n?}m, '')  # re-runnable
  main_re = /(<[^>]*\bid="main"[^>]*>)/i
  next unless html =~ main_re

  html = html.sub(main_re) { "#{Regexp.last_match(1)}\n#{crumb}" }
  File.write(f, html)
  count += 1
end

puts "injected breadcrumb into #{count} class pages"
