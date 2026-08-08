#!/usr/bin/env ruby
# frozen_string_literal: true

# Generates the human-facing landing page (index.html) for the gem feed at
# https://rubygems.omarqureshi.net. The feed otherwise answers only the machine
# RubyGems endpoints (/versions, /info/<gem>, /gems/<gem>.gem, specs.4.8.gz);
# this gives a person browsing the host a real page: install snippet, links to
# the docs + RFC, and every published gem with all its versions (newest first).
#
# Markup lives in templates/feed-index.html.erb; this script only builds the
# view model. Data source: the compact-index Marshal files the publish pipeline
# regenerates right before upload — specs.4.8.gz (release-style builds) and
# prerelease_specs.4.8.gz (historical 0.0.0.pre.* builds). Each is an array of
# [name, Gem::Version, platform]. No network, no gem metadata beyond the index.
#
# Usage: ruby gen-feed-index.rb <repo-dir>
#   <repo-dir> holds specs.4.8.gz / prerelease_specs.4.8.gz and gems/; index.html
#   is written into it so the pipeline's `aws s3 sync` uploads it to the root.

require 'zlib'
require 'stringio'
require 'rubygems'
require_relative 'render'

repo_dir = ARGV[0] or abort('usage: gen-feed-index.rb <repo-dir>')

def load_specs(path)
  return [] unless File.exist?(path)
  Marshal.load(Zlib::GzipReader.new(StringIO.new(File.binread(path))).read)
end

entries = %w[specs.4.8.gz prerelease_specs.4.8.gz]
          .flat_map { |f| load_specs(File.join(repo_dir, f)) }

# name => sorted-desc list of Gem::Version
by_gem = entries.each_with_object(Hash.new { |h, k| h[k] = [] }) do |(name, ver, _plat), acc|
  acc[name] << ver
end
by_gem.each_value { |vs| vs.replace(vs.uniq.sort.reverse) }

# The build timestamp is embedded in the version: 0.0.0.<YYYYMMDDHHMMSS> (or the
# historical 0.0.0.pre.<ts>). Pull the first 14-digit run and render it as a UTC
# date; versions without one (e.g. a bare 0.0.0) just show no date.
def build_date(version)
  m = version.to_s.match(/(\d{14})/) or return nil
  t = m[1]
  "#{t[0, 4]}-#{t[4, 2]}-#{t[6, 2]} #{t[8, 2]}:#{t[10, 2]}:#{t[12, 2]} UTC"
end

# Order the gems so aws-cdk-lib leads, then the rest of the CDK closure, then
# anything else alphabetically.
LEAD = %w[
  aws-cdk-lib constructs jsii-ruby-runtime
  aws-cdk-asset-awscli-v1 aws-cdk-asset-node-proxy-agent-v6 aws-cdk-cloud-assembly-schema
].freeze
ordered = by_gem.keys.sort_by { |n| [LEAD.index(n) || LEAD.size, n] }

gems = ordered.map do |name|
  versions = by_gem[name]
  {
    name: name,
    latest: versions.first,
    latest_date: build_date(versions.first),
    count: versions.size,
    versions: versions.map { |v| { ver: v.to_s, date: build_date(v) } },
  }
end

total_gems = gems.size
total_versions = by_gem.values.sum(&:size)

html = Render.page('feed-index',
                   gems: gems,
                   total_gems: total_gems,
                   total_versions: total_versions)

out = File.join(repo_dir, 'index.html')
File.write(out, html)
# Stylesheets are served from the canonical /styles/ path (deployed separately),
# linked protocol-relative — not copied next to the page.
warn "wrote #{out}: #{total_gems} gems, #{total_versions} versions"
