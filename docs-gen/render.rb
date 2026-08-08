# frozen_string_literal: true

# Shared ERB rendering for the docs/feed generators. Keeps page markup in
# docs-gen/templates/*.html.erb (editable as HTML) and leaves the generator
# scripts to compute a view-model hash.
#
#   html = Render.page("feed-index", gems: gems, total_gems: n)
#
# Every template is handed an `h` helper for HTML-escaping interpolated text
# (stdlib ERB does NOT auto-escape — assembly-sourced strings must go through
# `<%= h.(x) %>`). `trim_mode: "-"` lets `<% … -%>` swallow the trailing
# newline so control-flow lines don't leave blank lines in the output.

require 'erb'

module Render
  module_function

  TEMPLATE_DIR = File.join(__dir__, 'templates')

  def page(name, **locals)
    path = File.join(TEMPLATE_DIR, "#{name}.html.erb")
    tmpl = ERB.new(File.read(path), trim_mode: '-')
    tmpl.result_with_hash({ h: ERB::Util.method(:html_escape) }.merge(locals))
  end
end
