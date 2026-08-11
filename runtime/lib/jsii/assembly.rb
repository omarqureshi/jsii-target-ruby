# frozen_string_literal: true

module Jsii
  # Represents a JSII assembly loaded into the runtime.
  class Assembly
    # @return [String] the npm-style package name of the assembly (e.g. `"jsii-calc"`).
    attr_reader :name

    # @return [String] the assembly's semantic version (e.g. `"3.20.120"`).
    attr_reader :version

    # @return [String] absolute filesystem path to the `.jsii.tgz` tarball backing this assembly.
    attr_reader :tarball

    # @param name    [String] the npm-style package name of the assembly.
    # @param version [String] the assembly's semantic version.
    # @param tarball [String] absolute filesystem path to the `.jsii.tgz` tarball.
    # @return [Assembly] a new wrapper around the supplied metadata.
    def initialize(name, version, tarball)
      @name = name
      @version = version
      @tarball = tarball
    end

    # Loads the given assembly into the JSII kernel and returns a wrapper.
    #
    # Loading one twice is a no-op rather than a second load. The kernel would
    # otherwise hold two module instances of the same library, and the second
    # is invisible: `instanceof` checks *inside* that library then fail against
    # objects made by the other copy, and the error surfaces far from here,
    # naming a type nobody touched. (Seen for real: a cdk8s app that loaded its
    # assemblies by hand — each generated entry point already loads its own on
    # require — synthesized on Node 24 and failed on Node 22 with "can't render
    # non-simple object of type 'Lazy'".)
    #
    # @param name    [String] the npm-style package name of the assembly.
    # @param version [String] the assembly's semantic version.
    # @param tarball [String] absolute filesystem path to the `.jsii.tgz` tarball.
    # @return [Assembly] a wrapper representing the loaded assembly.
    # @raise [Jsii::RuntimeError] if the kernel rejects the load request.
    def self.load(name, version, tarball)
      @loaded ||= {}
      unless @loaded.key?(name)
        Jsii::Kernel.instance.load_assembly(name, version, tarball)
        @loaded[name] = version
      end
      new(name, version, tarball)
    end

    # Test hook: forget what has been loaded.
    def self.reset_loaded!
      @loaded = {}
    end
  end
end
