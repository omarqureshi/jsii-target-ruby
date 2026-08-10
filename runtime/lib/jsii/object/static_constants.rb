# frozen_string_literal: true

module Jsii
  # Lets a static readonly member be read the way Ruby spells a constant.
  #
  # A jsii static readonly member is generated as a class method (`def
  # self.BLOCK_ALL`) rather than a constant, because its value has to be
  # fetched from the kernel and a Ruby constant is evaluated when the class
  # body runs — assigning them eagerly would mean a kernel round-trip per
  # member at `require` time, for every class in the library.
  #
  # That leaves `Type::BLOCK_ALL` raising NameError, when `::` is both how Ruby
  # spells a constant read and how this member is spelled in every other jsii
  # language. Resolve it to the method instead: the constant form costs exactly
  # what the method form costs, and both work.
  module StaticConstants
    # @param name [Symbol] the constant Ruby could not find on this class.
    # @return [Object] the static member's value, read through the kernel.
    # @raise [NameError] if it does not name a static readonly member.
    def const_missing(name)
      # SCREAMING_SNAKE only. Static readonly members are the only class
      # methods generated with that spelling (a mutable static is generated
      # snake_case, and is deliberately not reachable as a constant since its
      # value can change), so this can never shadow a nested type or answer for
      # an ordinary method.
      return super unless name.to_s.match?(/\A[A-Z][A-Z0-9_]*\z/) && respond_to?(name)

      # Deliberately not memoised with const_set: the value is only as current
      # as the kernel that produced it, and freezing the first read would go
      # stale if the kernel were ever restarted. Reading every time matches
      # what the method form already does.
      public_send(name)
    end
  end
end
