#!/usr/bin/env ruby
# frozen_string_literal: true
#
# Display a static readonly member as the constant it is read as.
#
# A jsii static readonly member is generated as a singleton method (`def
# self.NODEJS_LATEST`), because its value comes from the kernel and a Ruby
# constant is evaluated when the class body runs. YARD documents what the
# source says, so the reference lists `.NODEJS_LATEST` — a spelling that works,
# but not the one the docs teach, and on a static-heavy class the only one
# shown: Runtime's page carried 53 dot-form entries against a single `::` in
# its own example.
#
# So rewrite the *displayed* member name, and nothing else. The highlighted
# source under each member still reads `def self.NAME`, because that is what
# the file says, and upstream prose mentioning the dot form is AWS's text.
#
# Scoped to SCREAMING_SNAKE singleton members, which is exactly the set of
# const statics: the generator names an ordinary class method snake_case (a
# mutable static included, since a constant cannot be reassigned), and instance
# members render with `#` rather than `.`.
#
# Runs on the built tree, so nothing about generation depends on it.
#
#   constantize-static-reads.rb <out-dir>

out_dir = ARGV[0] or abort 'usage: constantize-static-reads.rb <out-dir>'
abort "not a directory: #{out_dir}" unless File.directory?(out_dir)

# `>` (or `>` plus the newline/indent YARD emits before a detail heading), then
# the dot, then the bold member name. Anchored on `<strong>` so it cannot match
# a dotted call inside highlighted source or a prose <code> span, neither of
# which bolds the member.
DOT_MEMBER = %r{(>\s*)\.(<strong>[A-Z][A-Z0-9_]*</strong>)}

rewritten = 0
files = 0

Dir.glob(File.join(out_dir, '**', '*.html')).each do |path|
  html = File.read(path)
  next unless html.include?('<strong>')

  count = 0
  updated = html.gsub(DOT_MEMBER) do
    count += 1
    "#{Regexp.last_match(1)}::#{Regexp.last_match(2)}"
  end
  next if count.zero?

  File.write(path, updated)
  rewritten += count
  files += 1
end

# Say what happened: a silent no-op here looks exactly like a silent success,
# and the whole point is a change nobody would notice missing until they copied
# the wrong spelling out of the docs.
puts "constantized #{rewritten} static member reads across #{files} pages"
