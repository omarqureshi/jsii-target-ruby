# frozen_string_literal: true

# Synth smoke test for freshly generated CDK gems: builds a small app and
# verifies the synthesized CloudFormation template. Run with GEM_HOME pointing
# at an install of the generated gems + jsii-ruby-runtime, and JSII_RUNTIME at
# an @jsii/runtime entry point (RubyGems honors the exported GEM_HOME on its
# own — no Gem.paths gymnastics, which behave differently across RubyGems
# versions).
#
#   GEM_HOME=... JSII_RUNTIME=... ruby scripts/synth-smoke.rb
require 'aws-cdk-lib'
require 'json'
require 'tmpdir'

outdir = Dir.mktmpdir('synth-smoke')

app = AWSCDK::App.new(outdir: outdir)
stack = AWSCDK::Stack.new(app, 'SmokeStack')
AWSCDK::S3::Bucket.new(stack, 'SmokeBucket', versioned: true,
                                             encryption: AWSCDK::S3::BucketEncryption::S3_MANAGED)
AWSCDK::SNS::Topic.new(stack, 'SmokeTopic', display_name: 'plugin-built CDK')
app.synth

template = JSON.parse(File.read(File.join(outdir, 'SmokeStack.template.json')))
types = template['Resources'].values.map { |r| r['Type'] }.sort
puts "resources: #{types.join(', ')}"

bucket = template['Resources'].values.find { |r| r['Type'] == 'AWS::S3::Bucket' }
raise 'bucket missing' if bucket.nil?
raise 'versioning missing' unless bucket.dig('Properties', 'VersioningConfiguration', 'Status') == 'Enabled'
raise 'encryption missing' unless bucket['Properties'].key?('BucketEncryption')

topic = template['Resources'].values.find { |r| r['Type'] == 'AWS::SNS::Topic' }
raise 'topic missing' if topic.nil?

puts 'SYNTH SMOKE TEST: PASS'
