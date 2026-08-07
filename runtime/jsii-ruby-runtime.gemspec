# frozen_string_literal: true

Gem::Specification.new do |s|
  s.name        = 'jsii-ruby-runtime'
  # Kept in lockstep with the jsii-target-ruby package version (../package.json)
  # — the generator emits gemspecs that depend on the runtime it was built with.
  s.version     = '0.1.0'
  s.summary     = 'jsii runtime client for Ruby'
  s.authors     = ['Omar Qureshi']
  s.homepage    = 'https://github.com/omarqureshi/jsii-target-ruby'
  s.license     = 'Apache-2.0'
  s.files       = Dir['lib/**/*.rb'] + Dir['sig/**/*.rbs']
  s.required_ruby_version = '>= 3.3.0'
  s.add_dependency 'base64', '~> 0.2'

  s.add_development_dependency 'rake', '~> 13.0'
  s.add_development_dependency 'rubocop', '~> 1.86'
  s.add_development_dependency 'yard', '~> 0.9'
end
