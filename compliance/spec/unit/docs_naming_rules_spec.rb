# frozen_string_literal: true

require 'spec_helper'

# The docs landing page teaches the naming conventions, and a reader trusts it
# over anything they infer. That makes a stale rule worse than no rule: it
# tells them to write something that raises.
#
# The rule that went stale: static readonly members used to be reachable only
# as `Type.NAME`, and the page said so. They read as constants now
# (Jsii::StaticConstants), the same as enum members, so the page must not still
# send people to the dot form.
describe 'the docs landing page naming rules' do
  template = File.expand_path('../../../docs-gen/templates/docs-index.html.erb', __dir__)
  let(:rules) { File.read(template)[/<h3>Naming rules<\/h3>.*?<\/ul>/m] }

  it 'has a naming rules section to check' do
    expect(rules).not_to be_nil, "no naming rules section in #{template}"
  end

  it 'does not tell readers a static property is a method call' do
    expect(rules).not_to match(/[Ss]tatic.{0,80}method call/m)
  end

  it 'shows no qualified example reading a member through a dot' do
    # e.g. `AWSCDK::Lambda::Runtime.RUBY_4_0` — a complete expression a reader
    # would copy. A bare `.RUBY_4_0` is allowed: the page uses one to say how
    # the reference *displays* the member, which is not an instruction to
    # write it that way.
    expect(rules).not_to match(/<code>[^<]*::[^<]*\.[A-Z][A-Z0-9_]+<\/code>/)
  end

  it 'says constants are reached with ::, and covers statics as well as enums' do
    expect(rules).to match(/[Ss]tatic/)
    expect(rules).to match(/[Ee]num/)
    expect(rules).to match(/<code>::<\/code>/)
  end
end
