# frozen_string_literal: true

# Where the generated docs tree is rooted.
#
# The root module name is LIBRARY DATA, not something these scripts should
# know: it comes from the assembly's `targets.ruby.module` (supplied by the
# target-config overlay for libraries that do not carry Ruby config in their
# own repository). Hardcoding `AWSCDK` here would put CDK-specific knowledge
# in the plugin, which is exactly what the overlay exists to avoid.
module DocsRoot
  module_function

  # @param assembly [Hash] the (overlay-merged) assembly.
  # @return [String] e.g. "AWSCDK", or a name derived from the assembly.
  def from_assembly(assembly)
    explicit = assembly.dig('targets', 'ruby', 'module')
    return explicit if explicit && !explicit.empty?

    # Same derivation the generator falls back to: PascalCase the package
    # name, concatenating hyphen segments.
    assembly.fetch('name', 'Docs').split(%r{[-/]}).reject(&:empty?).map do |part|
      part.sub(/\A@/, '').split('_').map { |w| w.sub(/\A./, &:upcase) }.join
    end.join
  end

  # For scripts that only receive the output directory: the root is the single
  # top-level entry that is a directory of module directories (YARD's own
  # assets — css/js/frames — sit beside it as files or asset dirs).
  #
  # @param out_dir [String] the docs output directory.
  # @return [String] the root module directory name.
  def detect(out_dir)
    assets = %w[css js fonts images].freeze
    candidates = Dir.children(out_dir).select do |entry|
      File.directory?(File.join(out_dir, entry)) && !assets.include?(entry)
    end
    raise "cannot determine the docs root module under #{out_dir} (found: #{candidates.inspect})" unless candidates.size == 1

    candidates.first
  end
end
