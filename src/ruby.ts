import * as spec from '@jsii/spec';
import { toSnakeCase } from 'codemaker';
import * as reflect from 'jsii-reflect';
import { ApiLocation, enforcesStrictMode, TargetLanguage } from 'jsii-rosetta';
import * as path from 'path';

import { Generator, Legalese } from 'jsii-pacmak/lib/generator';
import { Target, TargetOptions } from 'jsii-pacmak/lib/target';
import { assertSpecIsRosettaCompatible } from 'jsii-pacmak/lib/rosetta-assembly';
import { subprocess } from 'jsii-pacmak/lib/util';
import { generateGemspec, rubyGemName } from './gemspec';
import * as helpers from './helpers';
import { rubySq, rubyJsonLiteral } from './helpers';
import { normalizeFences, rubifyInlineRefs } from './markdown';
import { generateRbs } from './rbs';
import { applyRubyTargetOverlay } from './target-config';
import { registerAssemblyTypes } from './type-oracle';

// This plugin's language key in rosetta's registry (see src/rosetta/register).
// TargetLanguage is a closed enum upstream; an external language is a string
// key the registry resolves, so the cast is the plugin-API boundary.
const RUBY_TARGET_LANGUAGE = 'ruby' as TargetLanguage;

export class RubyTarget extends Target {
  protected readonly generator: RubyGenerator;

  public constructor(options: TargetOptions) {
    super(options);
    // Out-of-band naming (JSII_RUBY_TARGET_CONFIG) merges into the assembly
    // spec before anything reads targets.ruby from it.
    applyRubyTargetOverlay(options.assembly.spec);
    this.generator = new RubyGenerator(options.rosetta, options);
  }

  // pacmak builds each toposort batch of modules concurrently, and every
  // Ruby package copies into the SAME shared output tree (dist/ruby's lib/
  // and sig/), so the copy phase must be serialized: concurrent fs copies
  // race on subdirectory creation (nondeterministic EEXIST). The gem build
  // itself stays parallel — it writes only into the per-package source dir.
  private static copyChain: Promise<unknown> = Promise.resolve();

  public async build(sourceDir: string, outDir: string): Promise<void> {
    const gemName = rubyGemName(this.assembly);

    // Package the generated files into a distributable .gem file
    await subprocess('gem', ['build', `${gemName}.gemspec`], {
      cwd: sourceDir,
    });

    // Copy compiled artifacts safely to the distribution directory
    const copied = RubyTarget.copyChain.then(() => this.copyFiles(sourceDir, outDir));
    RubyTarget.copyChain = copied.catch(() => undefined);
    await copied;
  }
}


/**
 * Escape a string for use inside a Ruby double-quoted ("...") literal.
 * Handles backslash, double-quote, and `#` (otherwise `#{...}` would trigger
 * string interpolation).  Apply at every interpolation site that embeds a
 * jsii-supplied name into generated Ruby source.
 */
function rubyDq(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/#/g, '\\#');
}


/**
 * A type reference in either of the two shapes this generator handles:
 * jsii-reflect wrappers (members coming off `allProperties`/`allMethods`)
 * or raw spec objects (initializer parameters).  Normalize with
 * {@link RubyGenerator.typeRefSpec} before introspecting.
 */
type RubyTypeRef = reflect.TypeReference | spec.TypeReference;

/**
 * Minimal structural shape of a documentable, typed parameter — satisfied
 * by `reflect.Parameter`, raw `spec.Parameter`, and `reflect.Property`
 * (struct members doubling as constructor keyword arguments).
 */
interface ParamLike {
  readonly name: string;
  readonly type?: RubyTypeRef;
  readonly optional?: boolean;
  readonly variadic?: boolean;
}




export class RubyGenerator extends Generator {
  /** The tablet reader pacmak hands every target, used to translate examples. */
  private readonly rosetta: TargetOptions['rosetta'];

  public constructor(
    rosetta: TargetOptions['rosetta'],
    options: TargetOptions,
  ) {
    super({ runtimeTypeChecking: options.runtimeTypeChecking });
    this.rosetta = rosetta;
    // Ruby convention is 2-space indentation (CodeMaker defaults to 4).
    this.code.indentation = 2;
  }

  /** Package root of the module being generated (captured in load) */
  private packageRoot?: string;

  public override async load(packageRoot: string, assembly: reflect.Assembly): Promise<void> {
    // Out-of-band naming (JSII_RUBY_TARGET_CONFIG) merges into the assembly
    // spec before generation reads targets.ruby anywhere. Also applied by
    // RubyTarget's constructor; the merge is idempotent and this covers
    // direct Generator use (tests, tooling).
    applyRubyTargetOverlay(assembly.spec);
    // Lets example translation tell an enum from a class: a static readonly
    // member is a class method, so rendering it as a constant raises
    // NameError. Registered after the overlay so the indexed Ruby paths match
    // what is generated.
    registerAssemblyTypes(assembly.spec);
    for (const dep of Object.values(assembly.spec.dependencyClosure ?? {})) {
      registerAssemblyTypes(dep as any);
    }
    this.packageRoot = packageRoot;
    return super.load(packageRoot, assembly);
  }

  /**
   * Translate an `@example` snippet (authored in TypeScript) to Ruby through
   * rosetta. The plugin registers its visitor with rosetta's language
   * registry at load time, so the tablet reader resolves `ruby` like any
   * built-in language: a pre-built tablet is used when present, otherwise
   * live conversion runs (when pacmak is invoked with
   * `--rosetta-unknown-snippets=translate`). With neither, rosetta returns
   * the TypeScript verbatim — still better than a wrong translation.
   */
  private convertExample(example: string, apiLocation: ApiLocation): string {
    assertSpecIsRosettaCompatible(this.assembly);
    return this.rosetta.translateExample(
      apiLocation,
      example,
      RUBY_TARGET_LANGUAGE,
      enforcesStrictMode(this.assembly),
    ).source;
  }

  /**
   * Clean up a Markdown document (a module README) for gem docs: strip HTML
   * comments, normalise fences, and rubify inline code references. Code-block
   * translation is deferred to the rosetta plugin phase (see convertExample).
   */
  private convertMarkdown(markdown: string, apiLocation: ApiLocation): string {
    // Strip HTML comments (e.g. CDK's `<!--BEGIN STABILITY BANNER-->` / CFNONLY
    // markers): YARD's Markdown renderer emits them as visible text instead of hiding
    // them, so they'd otherwise show up verbatim in the rendered README.
    const cleaned = normalizeFences(markdown.replace(/<!--[\s\S]*?-->/g, ''));
    assertSpecIsRosettaCompatible(this.assembly);
    // Fenced code blocks go through rosetta; inline code refs in prose are
    // rubified separately, since that transformation is rosetta-independent.
    const translated = this.rosetta.translateSnippetsInMarkdown(
      apiLocation,
      cleaned,
      RUBY_TARGET_LANGUAGE,
      enforcesStrictMode(this.assembly),
    );
    return rubifyInlineRefs(translated);
  }

  /**
   * Normalize a type reference to its raw `spec.TypeReference` shape.
   * Call sites hold two shapes: jsii-reflect `TypeReference` instances
   * (which wrap the raw spec under `.spec`) for members coming off
   * `allProperties` / `allMethods`, and raw spec objects for
   * `typeSpec.spec.initializer.parameters`.  Collection/union introspection
   * only works on the raw shape.
   */
  public typeRefSpec(
    type: RubyTypeRef | undefined,
  ): spec.TypeReference | undefined {
    if (type instanceof reflect.TypeReference) {
      return type.spec;
    }
    return type;
  }

  public isStructFqn(fqn: string): boolean {
    const type = this.reflectAssembly.system.tryFindFqn(fqn);
    return !!(type?.isInterfaceType() && type?.isDataType());
  }

  /**
   * A behavioral (non-datatype) interface whose flattened member surface is
   * exactly one method and no properties — eligible for Proc coercion at
   * call sites (see coercionExpr). Flattened deliberately, to match the
   * runtime's own SAM check against the generated module's
   * `jsii_overridable_methods` table, which is also flattened.
   */
  private isSamInterfaceFqn(fqn: string): boolean {
    const type = this.reflectAssembly.system.tryFindFqn(fqn);
    if (type == null || !type.isInterfaceType()) {
      return false;
    }
    // `.datatype` (not the isDataType() guard): negating a `this is
    // InterfaceType` guard on an already-narrowed InterfaceType collapses the
    // fall-through to `never`.
    if (type.datatype) {
      return false;
    }
    return type.allMethods.length === 1 && type.allProperties.length === 0;
  }

  /**
   * Extract the raw `spec.Docs` from either shape we hold: jsii-reflect
   * objects wrap it under `.spec.docs`; plain spec objects (enum members,
   * initializer parameters) carry `.docs` directly.  Genuinely dual-shape,
   * hence the `any` — reflect `Docs` instances also satisfy the returned
   * type structurally (their getters mirror spec.Docs, except `deprecated`
   * which is a boolean; emitDocs handles both).
   */
  private rawDocs(obj: any): spec.Docs | undefined {
    return obj?.spec?.docs ?? obj?.docs;
  }

  /**
   * Render a jsii type reference as a YARD type string for `@param` /
   * `@return` tags.
   */
  private rubyDocType(ref: spec.TypeReference | undefined): string {
    if (!ref) {
      return 'Object';
    }
    if (spec.isPrimitiveTypeReference(ref)) {
      switch (ref.primitive) {
        case spec.PrimitiveType.String:
          return 'String';
        case spec.PrimitiveType.Number:
          return 'Numeric';
        case spec.PrimitiveType.Boolean:
          return 'Boolean';
        case spec.PrimitiveType.Date:
          return 'DateTime';
        case spec.PrimitiveType.Json:
          return 'Hash';
        case spec.PrimitiveType.Any:
          return 'Object';
      }
    }
    if (spec.isNamedTypeReference(ref)) {
      return this.rubyFullTypeName(ref.fqn);
    }
    if (spec.isCollectionTypeReference(ref)) {
      const elem = this.rubyDocType(ref.collection.elementtype);
      return ref.collection.kind === spec.CollectionKind.Array
        ? `Array<${elem}>`
        : `Hash{String => ${elem}}`;
    }
    if (spec.isUnionTypeReference(ref)) {
      return ref.union.types.map((t) => this.rubyDocType(t)).join(', ');
    }
    return 'Object';
  }

  /**
   * Emit a block of text as `#`-prefixed comment lines.
   */
  private emitDocLines(text: string): void {
    for (const line of text.split('\n')) {
      const trimmed = line.trimEnd();
      this.code.line(trimmed === '' ? '#' : `# ${trimmed}`);
    }
  }

  /**
   * Collapse text for interpolation into a single-line YARD tag.  Doc text
   * (e.g. `docs.returns`) may contain newlines, which would leak subsequent
   * lines out of the comment and into generated code.
   */
  private inlineDoc(text: string): string {
    return text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '')
      .join(' ');
  }

  /**
   * Emit a YARD documentation comment from jsii docs: summary and remarks
   * as free text, followed by `@param` / `@return` / `@deprecated` /
   * `@see` / `@example` tags as applicable.  Silently emits nothing when
   * there are no docs and no tags to write.
   */
  /**
   * Docs for a property getter: its summary plus an `@return` of the
   * property's own type.
   */
  private emitPropertyDocs(
    prop: { name: string; type: RubyTypeRef; optional?: boolean },
    fqn: string,
  ): void {
    this.emitDocs(prop, {
      propertyType: prop.type,
      propertyOptional: prop.optional,
      apiLocation: { api: 'member', fqn, memberName: prop.name },
    });
  }

  /**
   * Docs for a method: its summary, an `@param` per parameter and an
   * `@return` (`[void]` when the method declares no return type).
   */
  private emitMethodDocs(
    method: { name: string; parameters: readonly ParamLike[]; spec?: { returns?: spec.OptionalValue } },
    fqn: string,
  ): void {
    this.emitDocs(method, {
      params: method.parameters,
      returns: method.spec?.returns,
      isMethod: true,
      apiLocation: { api: 'member', fqn, memberName: method.name },
    });
  }

  private emitDocs(
    docsSource: unknown,
    opts: {
      /** Parameters (raw spec or reflect) to render as @param tags. */
      params?: readonly ParamLike[];
      /** The method's raw `returns` OptionalValue; pass with isMethod. */
      returns?: spec.OptionalValue;
      /** Emit `@return [void]` when a method declares no return type. */
      isMethod?: boolean;
      /** Property getter: emit an @return of the property's type. */
      propertyType?: RubyTypeRef;
      propertyOptional?: boolean;
      /**
       * The API location the docs belong to. When present, `@example`
       * snippets are translated to Ruby via Rosetta; without it they are
       * emitted verbatim (i.e. as the original TypeScript).
       */
      apiLocation?: ApiLocation;
    } = {},
  ): void {
    const docs: spec.Docs = this.rawDocs(docsSource) ?? {};
    const tags: string[] = [];

    for (const p of opts.params ?? []) {
      const pDocs: spec.Docs = this.rawDocs(p) ?? {};
      const baseType = this.rubyDocType(this.typeRefSpec(p.type));
      const rendered = p.variadic
        ? `Array<${baseType}>`
        : `${baseType}${p.optional ? ', nil' : ''}`;
      const summary = pDocs.summary ? ` ${this.inlineDoc(pDocs.summary)}` : '';
      tags.push(`# @param ${helpers.rubyName(p.name)} [${rendered}]${summary}`);
    }

    if (opts.returns?.type) {
      const t = this.rubyDocType(this.typeRefSpec(opts.returns.type));
      const optional = opts.returns.optional ? ', nil' : '';
      const text = docs.returns ? ` ${this.inlineDoc(docs.returns)}` : '';
      tags.push(`# @return [${t}${optional}]${text}`);
    } else if (opts.isMethod) {
      tags.push('# @return [void]');
    } else if (opts.propertyType) {
      const t = this.rubyDocType(this.typeRefSpec(opts.propertyType));
      tags.push(`# @return [${t}${opts.propertyOptional ? ', nil' : ''}]`);
    }

    // Truthiness, not `!== undefined`: rawDocs falls back to a jsii-reflect
    // `Docs` instance whose getters return `''`/`false` rather than
    // `undefined`, so an undefined-check marked every undocumented member
    // (and every enum member) as deprecated with an empty Default note.
    if (docs.default) {
      tags.push(`# @note Default: ${this.inlineDoc(docs.default)}`);
    }
    if (docs.deprecated) {
      // Raw spec docs carry the reason in `deprecated` itself; a jsii-reflect
      // `Docs` instance (enum members have no `.spec`) exposes a boolean plus
      // a separate `deprecationReason` — take whichever is present so the
      // reason survives in both shapes.
      const reasonText =
        typeof docs.deprecated === 'string'
          ? docs.deprecated
          : ((docs as { deprecationReason?: string }).deprecationReason ?? '');
      const reason = reasonText ? ` ${this.inlineDoc(reasonText)}` : '';
      tags.push(`# @deprecated${reason}`);
    }
    if (docs.see) {
      tags.push(`# @see ${this.inlineDoc(docs.see)}`);
    }

    const exampleText =
      docs.example && opts.apiLocation
        ? this.convertExample(docs.example, opts.apiLocation)
        : docs.example;
    const exampleLines = exampleText
      ? [
          '# @example',
          ...exampleText.split('\n').map((l) => `#   ${l.trimEnd()}`.trimEnd()),
        ]
      : [];

    const hasText = !!docs.summary || !!docs.remarks;
    if (!hasText && tags.length === 0 && exampleLines.length === 0) {
      return;
    }

    if (docs.summary) {
      this.emitDocLines(docs.summary);
    }
    if (docs.remarks) {
      this.code.line('#');
      // `remarks` is Markdown prose that often embeds fenced ```ts code samples
      // (e.g. CfnResource#addOverride). Translate those to Ruby too, not just the
      // `@example` tag — mirroring the Python target's convertMarkdown(remarks).
      const remarks = opts.apiLocation
        ? this.convertMarkdown(docs.remarks, opts.apiLocation)
        : docs.remarks;
      this.emitDocLines(remarks);
    }
    if (tags.length > 0 || exampleLines.length > 0) {
      if (hasText) {
        this.code.line('#');
      }
      for (const tag of tags) {
        this.code.line(tag);
      }
      for (const line of exampleLines) {
        this.code.line(line);
      }
    }
  }

  public async save(outdir: string, tarball: string, legalese: Legalese) {
    const assembly = this.reflectAssembly;

    // Define the output path for the main Ruby library file
    const srcFile = path.join('lib', `${assembly.name}.rb`);
    this.code.openFile(srcFile);

    // Emit the core runtime dependency requirement
    this.emitHeader();

    // Pre-declare external dependencies to avoid NameErrors before opening our main module
    const dependencies = Object.keys(assembly.spec.dependencies ?? {});
    this.emitDependencies(dependencies);

    const assemblyModule = this.rubyModuleForAssembly(assembly.name);
    for (const mod of helpers.modulePrefixes(assemblyModule)) {
      this.code.line(`module ${mod}; end`);
    }

    this.code.open(`module ${assemblyModule}`);

    // Load assembly dynamically
    const tarballName = this.getAssemblyFileName();
    this.code.line(
      `Jsii::Assembly.load('${rubySq(assembly.name)}', '${rubySq(assembly.version)}', File.expand_path('${rubySq(tarballName)}', __dir__))`,
    );
    this.code.line('');

    // Pre-declare local JSII namespaces
    const classRubyPaths = this.collectClassRubyPaths();
    this.emitLocalNamespacePredeclarations(classRubyPaths);

    // Topologically sort the assembly's types so that everything a type's
    // *declaration line* references (superclass, included interface
    // modules, lexically enclosing type) is emitted before the type itself.
    const typesByFqn = new Map(assembly.allTypes.map((t) => [t.fqn, t]));
    const sortedTypes: reflect.Type[] = [];
    const visited = new Set<string>();

    const visit = (type: reflect.Type) => {
      if (visited.has(type.fqn)) return;
      visited.add(type.fqn);

      // Visit base class
      if (type.isClassType() && type.spec.base) {
        const base = typesByFqn.get(type.spec.base);
        if (base) visit(base);
      }

      // Visit implemented interfaces
      const interfaces =
        type.isClassType() || type.isInterfaceType()
          ? (type.spec.interfaces ?? [])
          : [];
      for (const ifaceFqn of interfaces) {
        const iface = typesByFqn.get(ifaceFqn);
        if (iface) visit(iface);
      }

      // Visit declaring parent for nested types
      const fqnParts = type.fqn.split('.');
      if (fqnParts.length > 2) {
        const parentType = typesByFqn.get(fqnParts.slice(0, -1).join('.'));
        if (parentType) visit(parentType);
      }

      sortedTypes.push(type);
    };

    for (const type of assembly.allTypes) {
      visit(type);
    }

    // Group types for lazy (autoload) emission: each *namespace-direct* type
    // gets its own file; types nested under a class are bundled into that
    // class's file (they can't be independently autoloaded — declaring the
    // autoload would reference, and thus force-load, the enclosing class).
    const ownerOf = (t: reflect.Type): reflect.Type => {
      let cur = t;
      for (;;) {
        const parentFqn = cur.fqn.split('.').slice(0, -1).join('.');
        const parent = typesByFqn.get(parentFqn);
        if (parent && parent.isClassType()) {
          cur = parent; // nested under a class → bundle into it
          continue;
        }
        return cur;
      }
    };
    const groups = new Map<string, reflect.Type[]>(); // owner fqn → members
    for (const type of sortedTypes) {
      const owner = ownerOf(type);
      const bucket = groups.get(owner.fqn) ?? [];
      bucket.push(type);
      groups.set(owner.fqn, bucket);
    }

    // The loader (lib/<assembly>.rb) is required eagerly; it declares the
    // module skeleton, loads the assembly into the kernel, and registers an
    // `autoload` + runtime path for each owner type — but defines no bodies.
    for (const [ownerFqn, members] of groups) {
      const owner = typesByFqn.get(ownerFqn)!;
      const requirePath = this.rubyRequirePath(owner.fqn);
      const enclosing = this.rubyEnclosingModule(owner.fqn);
      const constName = this.rubyModuleName(owner.name);
      // A `Module#autoload` covers constant references in user code — but only
      // for the namespace-direct owner: you can't autoload a constant nested
      // under a class without referencing (and thus force-loading) that class.
      this.code.line(
        `${enclosing}.autoload(:${constName}, '${rubySq(requirePath)}')`,
      );
      // `register_autoload` covers the kernel handing back an fqn the user
      // never named. Register *every* member against the owner's file —
      // including the nested-under-class types bundled into it — so a
      // kernel-returned nested type still hydrates to its real proxy even when
      // its owner was never referenced.
      for (const member of members) {
        this.code.line(
          `Jsii::Object.register_autoload("${rubyDq(member.fqn)}", '${rubySq(requirePath)}')`,
        );
      }
    }

    this.code.close('end');
    this.code.closeFile(srcFile);

    // One file per owner, defining the owner type and any types nested under
    // it, using fully-qualified (compact) headers — the loader has already
    // declared the namespace modules, and is always required first.
    for (const [ownerFqn, members] of groups) {
      const owner = typesByFqn.get(ownerFqn)!;
      const typeFile = path.join(
        'lib',
        `${this.rubyRequirePath(owner.fqn)}.rb`,
      );
      this.code.openFile(typeFile);
      this.code.line("require 'jsii'");
      this.code.line('');
      for (const type of members) {
        const prefix = `${this.rubyEnclosingModule(type.fqn)}::`;
        if (type.isEnumType()) {
          this.emitEnumType(type, prefix);
        } else if (type.isInterfaceType()) {
          this.emitInterfaceType(type, prefix);
        } else if (type.isClassType()) {
          this.emitClassType(type, prefix);
        }
      }
      this.code.closeFile(typeFile);
    }

    // Emit each submodule's README as its module docstring (samples translated
    // to Ruby), so YARD renders it on the module page.
    this.emitModuleReadmes();

    // Generate the gemspec manifest file for package management
    await generateGemspec(this.reflectAssembly, this.packageRoot, outdir);

    // Emit RBS type signatures alongside the generated code (sig/), giving
    // Steep/TypeProf users static type checking and editor completion.
    await generateRbs(this, this.reflectAssembly.name, outdir, sortedTypes);

    return super.save(outdir, tarball, legalese);
  }

  /**
   * Emit each submodule's (and the assembly's own) README as a Ruby module
   * docstring, its TypeScript samples translated to Ruby — mirroring the Python
   * target's `emitModuleDocumentation`.  Each README goes in a doc-only
   * `_readme.rb` inside the module's directory (alongside its type files) so a
   * per-directory YARD run picks it up and renders it on the module page.  The
   * file is never `require`d at runtime.
   */
  private emitModuleReadmes(): void {
    const emit = (moduleFqn: string, markdown: string | undefined): void => {
      if (!markdown) {
        return;
      }
      const rubyModule = this.rubyFullTypeName(moduleFqn);
      const translated = this.convertMarkdown(markdown, {
        api: 'moduleReadme',
        moduleFqn,
      });
      const docFile = path.join(
        'lib',
        this.rubyRequirePath(moduleFqn),
        '_readme.rb',
      );
      this.code.openFile(docFile);
      for (const line of translated.split('\n')) {
        this.code.line(line.length > 0 ? `# ${line}` : '#');
      }
      this.code.line(`module ${rubyModule}; end`);
      this.code.closeFile(docFile);
    };

    emit(this.assembly.name, this.assembly.readme?.markdown);
    for (const [fqn, submodule] of Object.entries(
      this.assembly.submodules ?? {},
    )) {
      emit(fqn, submodule.readme?.markdown);
    }
  }

  private emitHeader(): void {
    this.code.line("require 'jsii'");
    this.code.line("require 'json'");
    this.code.line("require 'base64'");
    this.code.line('');
  }

  private emitDependencies(dependencies: string[]): void {
    for (const dep of dependencies) {
      this.code.line(`require '${rubySq(dep)}'`);
    }
    if (dependencies.length > 0) {
      this.code.line('');
    }

    const depModules = dependencies.map((dep) => this.rubyModuleForAssembly(dep));
    for (const mod of helpers.namespacePrefixes(depModules)) {
      this.code.line(`module ${mod}; end`);
    }
  }

  private emitLocalNamespacePredeclarations(classRubyPaths: Set<string>): void {
    const relNamespaces = this.reflectAssembly.allTypes
      .filter((type) => type.namespace)
      .map((type) => this.relativeRubyNamespace(type.fqn))
      .filter((ns): ns is string => Boolean(ns));

    for (const ns of helpers.namespacePrefixes(relNamespaces, classRubyPaths)) {
      this.code.line(`module ${ns}; end`);
    }
    this.code.line('');
  }

  private emitEnumType(typeSpec: reflect.EnumType, prefix: string): void {
    const resolvedMembers = helpers.dedupByRubyName(
      typeSpec.members,
      (m) => helpers.rubyConstName(m.name),
      typeSpec.fqn,
    );
    this.emitDocs(typeSpec, {
      apiLocation: { api: 'type', fqn: typeSpec.fqn },
    });
    this.code.open(`module ${prefix}${this.rubyModuleName(typeSpec.name)}`);
    // Without this the fqn resolves to nil in Jsii::Type.check_fqn, which
    // then returns without validating — runtime type checking would be a
    // silent no-op for every enum-typed parameter, property and struct member.
    this.code.line(
      `Jsii::Object.register_jsii_fqn("${rubyDq(typeSpec.fqn)}", self)`,
    );
    for (const member of resolvedMembers) {
      this.emitDocs(member, {
        apiLocation: {
          api: 'member',
          fqn: typeSpec.fqn,
          memberName: member.name,
        },
      });
      this.code.line(
        `${helpers.rubyConstName(member.name)} = Jsii::Enum.new("${rubyDq(typeSpec.fqn)}", "${rubyDq(member.name)}")`,
      );
    }
    this.code.close('end');
    this.code.line('');
  }

  private emitInterfaceType(
    typeSpec: reflect.InterfaceType,
    prefix: string,
  ): void {
    // For datatype interfaces (structs) the methods list is empty by
    // construction — the jsii compiler forbids methods on them — so the
    // method side of the dedup below is a no-op in that branch.
    const { props: resolvedAllProperties, methods: resolvedAllMethods } =
      helpers.dedupCrossCategory(
        helpers.dedupByRubyName(
          typeSpec.allProperties,
          (p) => helpers.rubyName(p.name),
          typeSpec.fqn,
        ),
        helpers.dedupByRubyName(
          typeSpec.allMethods,
          (m) => helpers.rubyName(m.name),
          typeSpec.fqn,
        ),
        (p) => helpers.rubyName(p.name),
        (m) => helpers.rubyName(m.name),
        typeSpec.fqn,
      );
    const kind = typeSpec.datatype ? 'class' : 'module';
    const rubyName = this.rubyModuleName(typeSpec.name);

    const bases = typeSpec.spec.interfaces ?? [];
    const baseMixins = bases.map((b) => `::${this.rubyFullTypeName(b)}`);
    // JSII structs may extend several parents (diamond hierarchies), but a
    // Ruby class has a single superclass: subclass the first parent and
    // record the rest via `jsii_extra_struct_bases` so is_a?/kind_of?/case
    // dispatch honor every declared parent (see Jsii::Struct).  Members are
    // unaffected either way — allProperties flattens the full hierarchy.
    const baseString =
      typeSpec.datatype && bases.length > 0
        ? ` < ${baseMixins[0]}`
        : typeSpec.datatype
          ? ' < Jsii::Struct'
          : '';

    this.emitDocs(typeSpec, {
      apiLocation: { api: 'type', fqn: typeSpec.fqn },
    });
    this.code.open(`${kind} ${prefix}${rubyName}${baseString}`);

    if (!typeSpec.datatype) {
      for (const mixin of baseMixins) {
        this.code.line(`include ${mixin}`);
      }
    }

    this.code.line(
      `Jsii::Object.register_jsii_fqn("${rubyDq(typeSpec.fqn)}", self)`,
    );
    if (typeSpec.datatype && baseMixins.length > 1) {
      this.code.line(
        `jsii_extra_struct_bases.push(${baseMixins.slice(1).join(', ')})`,
      );
    }
    this.code.line('');

    if (typeSpec.datatype) {
      const props = resolvedAllProperties;

      const initArgs = props
        .map((p) => {
          const name = helpers.rubyName(p.name);
          return p.optional ? `${name}: nil` : `${name}:`;
        })
        .join(', ');

      // Struct members double as constructor keyword arguments — document
      // them as @params (each carries its own summary/type/optionality).
      this.emitDocs(undefined, { params: props });
      this.code.open(`def initialize(${initArgs})`);
      for (const prop of props) {
        const rubyName = helpers.rubyName(prop.name);
        this.emitStructCoercion(rubyName, prop.type, {
          assignment: `@${rubyName}`,
        });
        // Validate the (coerced) member value — structs are the main
        // vehicle for user-supplied data, so they get the same runtime
        // type checking as method/constructor parameters.
        this.emitTypeChecking(`@${rubyName}`, prop.type, prop.name, {
          isOptional: prop.optional,
        });
      }
      this.code.close('end');
      this.code.line('');

      for (const prop of props) {
        this.emitPropertyDocs(prop, typeSpec.fqn);
        this.code.line(`attr_reader :${helpers.rubyName(prop.name)}`);
      }
      this.code.line('');

      this.code.open('def self.jsii_properties');
      this.code.open('{');
      for (const prop of props) {
        this.code.line(
          `:${helpers.rubyName(prop.name)} => "${rubyDq(prop.name)}",`,
        );
      }
      this.code.close('}');
      this.code.close('end');
      this.code.line('');

      this.code.open('def to_jsii');
      this.code.line('result = {}');
      if (bases.length > 0) {
        this.code.line('result.merge!(super)');
      }
      this.code.open('result.merge!({');
      for (const prop of props) {
        this.code.line(
          `"${rubyDq(prop.name)}" => @${helpers.rubyName(prop.name)},`,
        );
      }
      this.code.close('})');
      this.code.line('result.compact');
      this.code.close('end');
    } else {
      for (const prop of resolvedAllProperties) {
        const propRubyName = helpers.rubyName(prop.name);
        this.emitPropertyDocs(prop, typeSpec.fqn);
        this.code.open(`def ${propRubyName}()`);
        this.code.line(`jsii_get_property("${rubyDq(prop.name)}")`);
        this.code.close(`end`);
        this.code.line('');
        if (!prop.immutable) {
          this.code.open(`def ${propRubyName}=(value)`);
          this.emitStructCoercion('value', prop.type);
          this.emitTypeChecking('value', prop.type, prop.name, {
            isOptional: prop.optional,
          });
          this.code.line(`jsii_set_property("${rubyDq(prop.name)}", value)`);
          this.code.close('end');
          this.code.line('');
        }
      }

      for (const method of resolvedAllMethods) {
        const sigParams = helpers.rubySignatureParams(method.parameters);
        const callParams = helpers.rubyCallParams(method.parameters);
        this.emitMethodDocs(method, typeSpec.fqn);
        this.code.open(`def ${helpers.rubyName(method.name)}(${sigParams})`);
        this.emitParameterGuards(method.parameters);
        this.emitInstanceDispatch(method, callParams);
        this.code.close('end');
        this.code.line('');
      }

      this.code.open('def self.jsii_overridable_methods');
      this.code.open('{');
      for (const prop of resolvedAllProperties) {
        const isOptional = prop.optional ? 'true' : 'false';
        this.code.line(
          `:${helpers.rubyName(prop.name)} => { kind: :property, name: "${rubyDq(prop.name)}", is_optional: ${isOptional} },`,
        );
      }
      for (const method of resolvedAllMethods) {
        this.code.line(
          `:${helpers.rubyName(method.name)} => { kind: :method, name: "${rubyDq(method.name)}", is_optional: false },`,
        );
      }
      this.code.close('}');
      this.code.close('end');
    }

    this.code.close('end');
    this.code.line('');
  }

  private emitClassType(typeSpec: reflect.ClassType, prefix: string): void {
    // Deliberately iterate the *flattened* member lists (allProperties /
    // allMethods): every class re-emits inherited instance members, so each
    // generated class carries its own forwarding stub for every member it
    // exposes — which is what makes `super` work in guest overrides of
    // inherited members.  The output bloat (O(depth × members)) is the
    // accepted cost; statics are the exception (emitted on their defining
    // class only, see isOwnStatic below).
    const { props: resolvedAllProperties, methods: resolvedAllMethods } =
      helpers.dedupCrossCategory(
        helpers.dedupByRubyName(
          typeSpec.allProperties,
          (p) => this.rubyPropertyName(p),
          typeSpec.fqn,
        ),
        helpers.dedupByRubyName(
          typeSpec.allMethods,
          (m) => this.rubyMethodName(m),
          typeSpec.fqn,
        ),
        (p) => this.rubyPropertyName(p),
        (m) => this.rubyMethodName(m),
        typeSpec.fqn,
      );
    const rubyName = this.rubyModuleName(typeSpec.name);

    const baseFqn = typeSpec.spec.base;
    let baseClass = 'Jsii::Object';
    if (baseFqn) {
      baseClass = `::${this.rubyFullTypeName(baseFqn)}`;
    }

    const interfaces = typeSpec.spec.interfaces ?? [];
    const interfaceMixins = interfaces.map(
      (i) => `::${this.rubyFullTypeName(i)}`,
    );

    this.emitDocs(typeSpec, {
      apiLocation: { api: 'type', fqn: typeSpec.fqn },
    });
    this.code.open(`class ${prefix}${rubyName} < ${baseClass}`);

    for (const mixin of interfaceMixins) {
      this.code.line(`include ${mixin}`);
    }
    this.code.line(`self.jsii_fqn = "${rubyDq(typeSpec.fqn)}"`);
    this.code.line(
      `Jsii::Object.register_jsii_fqn("${rubyDq(typeSpec.fqn)}", self)`,
    );
    this.code.line('');

    const initializer = typeSpec.spec.initializer;
    if (
      initializer &&
      initializer.parameters &&
      initializer.parameters.length > 0
    ) {
      const initParams = initializer.parameters
        .map((p) => {
          const rubyParam = helpers.rubyName(p.name);
          if (p.variadic) return `*${rubyParam}`;
          return p.optional ? `${rubyParam} = nil` : rubyParam;
        })
        .join(', ');

      this.emitDocs(initializer, {
        params: initializer.parameters,
        apiLocation: { api: 'initializer', fqn: typeSpec.fqn },
      });
      this.code.open(`def initialize(${initParams}, &jsii_block)`);
      for (const p of initializer.parameters) {
        const rubyParam = helpers.rubyName(p.name);
        // `variadic` matters: for a variadic parameter the coercion has to
        // map the splat array's ELEMENTS, not test the array itself against
        // Hash (which is never true, so the coercion silently never fires and
        // raw snake_case hashes go over the wire). Mirrors the method and
        // static emission sites.
        this.emitStructCoercion(rubyParam, p.type, { variadic: p.variadic });
      }
      const superArgs = helpers.rubyCallParams(initializer.parameters);

      for (const p of initializer.parameters) {
        const rubyParam = helpers.rubyName(p.name);
        this.emitTypeChecking(rubyParam, p.type, p.name, {
          isOptional: p.optional,
          isVariadic: p.variadic,
        });
      }

      // Blocks do not propagate through UnboundMethod#call, so the base
      // class's documented `yield self` never fires unless it is forwarded
      // explicitly.
      this.code.line(
        `Jsii::Object.instance_method(:initialize).bind(self).call(${superArgs}, &jsii_block)`,
      );
      this.code.close('end');
    } else if (initializer) {
      // Parameterless constructor (the jsii compiler propagates initializer
      // entries onto instantiable subclasses, so a missing parameter list
      // here really means "takes no arguments" — enforce that arity rather
      // than silently forwarding stray args to the kernel).
      this.code.open('def initialize(&jsii_block)');
      this.code.line(
        'Jsii::Object.instance_method(:initialize).bind(self).call(&jsii_block)',
      );
      this.code.close('end');
    } else {
      // No initializer entry at all: jsii emits this for classes whose
      // constructor is not visible (private).  Instances only ever come
      // from factory methods and are hydrated via `allocate`, which never
      // calls #initialize — so constructing one from Ruby is always a bug.
      // Raise eagerly with a pointer to the factories instead of letting
      // the kernel reject the create call with a less helpful error.
      this.code.open('def initialize(*args)');
      this.code.line(
        `raise NoMethodError, "${rubyDq(typeSpec.fqn)} does not have a visible constructor; use the provided factory methods"`,
      );
      this.code.close('end');
    }
    this.code.line('');

    // Static members are emitted only on their *defining* class.  Ruby
    // inherits singleton methods, which matches the ES6 static-inheritance
    // semantics the kernel implements (its method/property lookups walk the
    // base chain, and the base's stub carries the base fqn).  Re-emitting an
    // inherited static here would bake the *derived* fqn into the kernel
    // call instead.  A child that overrides a static still gets its own
    // stub, because allMethods/allProperties yield the most-derived
    // declaration (see the StaticHelloParent/Child fixture in jsii-calc).
    const isOwnStatic = (m: reflect.Property | reflect.Method) =>
      m.definingType.fqn === typeSpec.fqn;

    const overridableMethods = resolvedAllMethods.filter((m) => !m.static);
    const overridableProps = resolvedAllProperties.filter((p) => !p.static);

    this.code.open('def self.jsii_overridable_methods');
    this.code.open('{');
    for (const prop of overridableProps) {
      const rubyName = helpers.rubyName(prop.name);
      const isOptional = prop.optional ? 'true' : 'false';
      this.code.line(
        `:${rubyName} => { kind: :property, name: "${rubyDq(prop.name)}", is_optional: ${isOptional} },`,
      );
    }
    for (const method of overridableMethods) {
      const rubyName = helpers.rubyName(method.name);
      this.code.line(
        `:${rubyName} => { kind: :method, name: "${rubyDq(method.name)}", is_optional: false },`,
      );
    }
    this.code.close('}');
    this.code.close('end');
    this.code.line('');

    for (const method of resolvedAllMethods) {
      if (!method.static || !isOwnStatic(method)) continue;

      const sigParams = helpers.rubySignatureParams(method.parameters);

      const callParams = helpers.rubyCallParams(method.parameters);

      this.emitMethodDocs(method, typeSpec.fqn);
      this.code.open(`def self.${this.rubyMethodName(method)}(${sigParams})`);
      this.emitParameterGuards(method.parameters);
      this.code.line(
        `Jsii::Kernel.instance.call_static("${rubyDq(typeSpec.fqn)}", "${rubyDq(method.name)}", [${callParams}])`,
      );
      this.code.close('end');
      this.code.line('');
    }

    for (const prop of resolvedAllProperties) {
      if (prop.static && !isOwnStatic(prop)) continue;

      const rubyName = this.rubyPropertyName(prop);

      if (prop.static) {
        this.emitPropertyDocs(prop, typeSpec.fqn);
        this.code.open(`def self.${rubyName}()`);
        this.code.line(
          `Jsii::Kernel.instance.get_static("${rubyDq(typeSpec.fqn)}", "${rubyDq(prop.name)}")`,
        );
        this.code.close(`end`);
        this.code.line('');

        if (!prop.immutable) {
          this.code.open(`def self.${rubyName}=(value)`);
          this.emitStructCoercion('value', prop.type);
          this.emitTypeChecking('value', prop.type, prop.name, {
            isOptional: prop.optional,
          });
          this.code.line(
            `Jsii::Kernel.instance.set_static("${rubyDq(typeSpec.fqn)}", "${rubyDq(prop.name)}", value)`,
          );
          this.code.close('end');
          this.code.line('');
        }
      } else {
        this.emitPropertyDocs(prop, typeSpec.fqn);
        this.code.open(`def ${rubyName}()`);
        this.code.line(`jsii_get_property("${rubyDq(prop.name)}")`);
        this.code.close(`end`);
        this.code.line('');

        if (!prop.immutable) {
          this.code.open(`def ${rubyName}=(value)`);
          this.emitStructCoercion('value', prop.type);
          this.emitTypeChecking('value', prop.type, prop.name, {
            isOptional: prop.optional,
          });
          this.code.line(`jsii_set_property("${rubyDq(prop.name)}", value)`);
          this.code.close('end');
          this.code.line('');
        }
      }
    }

    for (const method of resolvedAllMethods) {
      if (method.static) continue;

      const sigParams = helpers.rubySignatureParams(method.parameters);

      const callParams = helpers.rubyCallParams(method.parameters);

      this.emitMethodDocs(method, typeSpec.fqn);
      this.code.open(`def ${this.rubyMethodName(method)}(${sigParams})`);
      this.emitParameterGuards(method.parameters);
      this.emitInstanceDispatch(method, callParams);
      this.code.close('end');
      this.code.line('');
    }

    this.code.close('end');
    this.code.line('');
  }

  public rubyFullTypeName(fqn: string): string {
    if (fqn === 'any') return 'Object';

    const assemblyName = fqn.split('.')[0];
    const config =
      assemblyName === this.assembly.name
        ? this.assembly
        : this.assembly.dependencyClosure?.[assemblyName];

    // Names in this fqn belong to `config`'s assembly — apply *its*
    // acronym configuration, not the pooled closure's. An unknown assembly
    // has no configuration at all: every segment derives plainly.
    return helpers.resolveRubyModulePath(fqn, {
      assemblyName,
      acronyms: config ? helpers.assemblyAcronyms(config) : [],
      rootModule: () => config?.targets?.ruby?.module,
      submoduleModule: (submoduleFqn) =>
        config?.submodules?.[submoduleFqn]?.targets?.ruby?.module,
    });
  }

  /**
   * The fully-qualified Ruby module that encloses a type — its full Ruby
   * name minus the final segment (e.g. `JsiiCalc::Composition` for
   * `CompositeOperation`).  Used to declare an `autoload` on the right
   * module and to emit compact `class A::B::C` headers in per-type files.
   */
  private rubyEnclosingModule(fqn: string): string {
    return this.rubyFullTypeName(fqn).split('::').slice(0, -1).join('::');
  }

  /**
   * The `require` path of a type's generated file, relative to `lib/`:
   * `<assembly-name>/<snake namespace.../snake type>` — e.g.
   * `jsii-calc/composition/composite_operation`.  Used both as the file
   * location and the argument to `autoload`/`register_autoload`, so the two
   * always agree.
   */
  private rubyRequirePath(fqn: string): string {
    const full = this.rubyFullTypeName(fqn).split('::');
    const asm = this.rubyModuleForAssembly(this.assembly.name).split('::');
    const rel = full.slice(asm.length).map((s) => toSnakeCase(s));
    return [this.assembly.name, ...rel].join('/');
  }

  private relativeRubyNamespace(fqn: string): string {
    const full = this.rubyFullTypeName(fqn).split('::');
    const asm = this.rubyModuleForAssembly(fqn.split('.')[0]).split('::');
    // Slicing the assembly-module prefix off the full path is only sound if
    // the full path actually starts with it.  An explicitly-configured
    // submodule module that *replaces* the root (e.g. `module: 'Flat'`)
    // would silently mis-slice — types would be emitted into the wrong
    // namespace.  Fail generation with a pointer at the config instead.
    if (!asm.every((part, i) => full[i] === part)) {
      throw new Error(
        `Ruby module for '${fqn}' resolves to '${full.join('::')}', which ` +
          `does not live under its assembly's module '${asm.join('::')}'. ` +
          `Explicit submodule targets.ruby.module values must extend the ` +
          `assembly module (e.g. '${asm.join('::')}::MySubmodule').`,
      );
    }
    return full.slice(asm.length, -1).join('::');
  }

  /**
   * Compute the set of Ruby paths (relative to the assembly module) that
   * will be declared as Ruby classes — jsii classes plus jsii interfaces
   * marked `datatype: true` (which generate as Ruby classes inheriting from
   * `Jsii::Struct`).  Used to suppress conflicting `module X; end`
   * pre-declarations of namespace fragments that share a Ruby name with a
   * class.
   */
  private collectClassRubyPaths(): Set<string> {
    const paths = new Set<string>();
    for (const type of this.reflectAssembly.allTypes) {
      const isClassEmit =
        type.isClassType() || (type.isInterfaceType() && type.spec.datatype);
      if (!isClassEmit) continue;

      const namespacePart = this.relativeRubyNamespace(type.fqn);
      const namePart = this.rubyModuleName(type.name);
      paths.add(namespacePart ? `${namespacePart}::${namePart}` : namePart);
    }
    return paths;
  }

  /**
   * Build a Ruby expression that coerces plain Hashes into struct instances
   * anywhere a struct can appear inside `ref` — directly, as the element
   * type of an array/map (recursively), or as the single unambiguous struct
   * arm of a union.  Returns `undefined` when `ref` cannot contain a
   * coercible struct, so call sites can skip emission entirely.
   *
   * Coercion matters beyond ergonomics: an uncoerced Hash serializes with
   * its literal (snake_case) keys, while the kernel expects the struct's
   * camelCase wire form — so a Hash that misses coercion is silent wire
   * corruption, not a graceful fallback.
   *
   * Union rule: coerce only when exactly one arm is a struct AND no other
   * arm could legitimately be satisfied by a Hash (a map arm, or an
   * any/json arm) — otherwise the Hash is ambiguous and is passed through
   * unchanged for the runtime/kernel to interpret.
   *
   * Block parameters are named `jsii_v<depth>` — the `jsii_` prefix is
   * reserved (see RUBY_RESERVED_NAMES), so they can never collide with or
   * shadow a generated parameter name.
   */
  private coercionExpr(
    valueExpr: string,
    ref: spec.TypeReference | undefined,
    depth = 0,
  ): string | undefined {
    if (!ref) {
      return undefined;
    }

    if (spec.isNamedTypeReference(ref)) {
      if (this.isStructFqn(ref.fqn)) {
        return this.structFromHashExpr(valueExpr, ref.fqn);
      }
      // Single-abstract-method (SAM) interfaces accept a Proc — or the
      // TypeScript-object-literal mirror `{ member: proc }` — which the
      // runtime wraps into an implementing object (the Ruby analogue of
      // javac's SAM conversion; jsii callbacks are always interfaces on the
      // wire). coerce_callable re-derives SAM-ness from the module's own
      // override table and passes every non-coercible value through
      // untouched, so the runtime stays the authority and ordinary type
      // checking still reports bad values.
      if (this.isSamInterfaceFqn(ref.fqn)) {
        return `Jsii::Utils.coerce_callable(${valueExpr}, ::${this.rubyFullTypeName(ref.fqn)})`;
      }
      return undefined;
    }

    if (spec.isCollectionTypeReference(ref)) {
      const blockVar = `jsii_v${depth}`;
      const inner = this.coercionExpr(
        blockVar,
        ref.collection.elementtype,
        depth + 1,
      );
      if (!inner) {
        return undefined;
      }
      if (ref.collection.kind === spec.CollectionKind.Array) {
        return `${valueExpr}.is_a?(Array) ? ${valueExpr}.map { |${blockVar}| ${inner} } : ${valueExpr}`;
      }
      return `${valueExpr}.is_a?(Hash) ? ${valueExpr}.transform_values { |${blockVar}| ${inner} } : ${valueExpr}`;
    }

    if (spec.isUnionTypeReference(ref)) {
      const structArms = ref.union.types.filter(
        (t) => spec.isNamedTypeReference(t) && this.isStructFqn(t.fqn),
      ) as spec.NamedTypeReference[];
      const hashAmbiguous = ref.union.types.some(
        (t) =>
          (spec.isCollectionTypeReference(t) &&
            t.collection.kind === spec.CollectionKind.Map) ||
          (spec.isPrimitiveTypeReference(t) &&
            (t.primitive === spec.PrimitiveType.Any ||
              t.primitive === spec.PrimitiveType.Json)),
      );
      if (structArms.length === 1 && !hashAmbiguous) {
        return this.structFromHashExpr(valueExpr, structArms[0].fqn);
      }
      return undefined;
    }

    return undefined;
  }

  /**
   * Ruby expression coercing `valueExpr` into the struct `fqn` when it is a
   * Hash, passing anything else through.  Keys are symbolized before the
   * keyword splat: `**` requires Symbol keys, and JSON-shaped hashes carry
   * String keys — without `transform_keys` those raise a bare
   * `ArgumentError: wrong number of arguments` instead of constructing the
   * struct.  (Symbol keys pass through `to_sym` unchanged; unknown keys
   * still surface as Ruby's clear "unknown keyword" ArgumentError.)
   */
  private structFromHashExpr(valueExpr: string, fqn: string): string {
    const structType = this.rubyFullTypeName(fqn);
    return `${valueExpr}.is_a?(Hash) ? ::${structType}.new(**${valueExpr}.transform_keys(&:to_sym)) : ${valueExpr}`;
  }

  /**
   * Per-parameter struct coercion followed by its runtime type check.
   *
   * Methods emit these interleaved per parameter; the constructor does not
   * (it coerces every parameter, then checks every parameter), so it does not
   * share this.
   */
  private emitParameterGuards(params: readonly ParamLike[]): void {
    for (const p of params) {
      const rubyParam = helpers.rubyName(p.name);
      this.emitStructCoercion(rubyParam, p.type, { variadic: p.variadic });
      this.emitTypeChecking(rubyParam, p.type, p.name, {
        isOptional: p.optional,
        isVariadic: p.variadic,
      });
    }
  }

  /** The kernel call in an instance method body. */
  private emitInstanceDispatch(
    method: { name: string; async?: boolean },
    callParams: string,
  ): void {
    const call = method.async ? 'jsii_async_call_method' : 'jsii_call_method';
    this.code.line(`${call}("${rubyDq(method.name)}", [${callParams}])`);
  }

  private emitStructCoercion(
    variableName: string,
    type: RubyTypeRef | undefined,
    options: { variadic?: boolean; assignment?: string } = {},
  ): void {
    const ref = this.typeRefSpec(type);

    if (options.variadic) {
      // For variadic parameters, `ref` is the element type already.
      const inner = this.coercionExpr('jsii_v0', ref, 1);
      if (inner) {
        this.code.line(`${variableName}.map! { |jsii_v0| ${inner} }`);
      }
      return;
    }

    const expr = this.coercionExpr(variableName, ref);
    if (!expr) {
      if (options.assignment) {
        this.code.line(`${options.assignment} = ${variableName}`);
      }
      return;
    }
    this.code.line(`${options.assignment ?? variableName} = ${expr}`);
  }

  private emitTypeChecking(
    variableName: string,
    type: RubyTypeRef | undefined,
    jsiiName: string,
    options: { isOptional?: boolean; isVariadic?: boolean } = {},
  ): void {
    if (!this.runtimeTypeChecking) {
      return;
    }

    // Normalize: initializer parameters carry raw spec type refs (no
    // `.spec`); reflect members wrap theirs.  Reading `.spec`
    // unconditionally made every constructor check validate against
    // `{primitive: 'any'}` — i.e. check nothing.
    const refSpec = this.typeRefSpec(type);

    if (options.isVariadic) {
      this.code.open(`${variableName}.each_with_index do |item, index|`);
      this.code.line(
        `Jsii::Type.check_type(item, ${rubyJsonLiteral(
          refSpec,
        )}, "${rubyDq(jsiiName)}[#{index}]")`,
      );
      this.code.close(`end`);
    } else {
      this.code.line(
        `Jsii::Type.check_type(${variableName}, ${rubyJsonLiteral(
          refSpec,
        )}, "${rubyDq(jsiiName)}")${options.isOptional ? ` unless ${variableName}.nil?` : ''}`,
      );
    }
  }

  /**
   * Emit-name for a property, accounting for the JSII `const: true` flag.
   * Const properties take an UPPER_SNAKE_CASE form (`maybeList` → `MAYBE_LIST`,
   * `PROPERTY` stays `PROPERTY`) — both idiomatic for Ruby constants and
   * distinct from any sibling snake_case property's lowercased name.
   * This matches Python's `toPythonPropertyName(name, constant=true)` which
   * uppercases the snake_case form for the same reason.
   *
   * Ruby parses `Foo.PROPERTY` and `Foo.property` as distinct method calls,
   * so both can coexist on the same class without ambiguity.
   */
  public rubyPropertyName(prop: { name: string; const?: boolean }): string {
    if (prop.const) return helpers.rubyConstName(prop.name);
    return helpers.rubyName(prop.name);
  }

  public rubyMethodName(method: { name: string }): string {
    return helpers.rubyName(method.name);
  }

  private rubyModuleForAssembly(name: string): string {
    if (name === this.assembly.name) {
      return this.assembly.targets?.ruby?.module ?? this.rubyModuleName(name);
    }
    const depInfo = this.assembly.dependencyClosure?.[name];
    if (depInfo) {
      return (
        depInfo.targets?.ruby?.module ??
        this.rubyModuleName(name, helpers.assemblyAcronyms(depInfo))
      );
    }
    return this.rubyModuleName(name, []);
  }

  /**
   * The acronym list configured by a specific assembly
   * (`targets.ruby.acronyms`).  Acronyms are deliberately scoped to the
   * assembly that declared them: a dependency capitalizing `RAM` must not
   * rewrite an unrelated `RamUsage` type in the consuming assembly (or in
   * a sibling dependency).
   */
  // The one wrapper around a helper that earns its keep: it binds the
  // default acronym list to the assembly being generated. Callers converting
  // names that belong to a *dependency* pass that assembly's own list
  // explicitly (see rubyFullTypeName / rubyModuleForAssembly).
  private rubyModuleName(name: string, acronyms?: string[]): string {
    return helpers.rubyModuleName(name, acronyms ?? helpers.assemblyAcronyms(this.assembly));
  }

  protected getAssemblyOutputDir(_mod: spec.Assembly) {
    return path.join('lib', path.dirname(_mod.name)).replace(/\\/g, '/');
  }

  protected onBeginInterface(_ifc: spec.InterfaceType) {} // eslint-disable-line @typescript-eslint/no-empty-function
  protected onEndInterface(_ifc: spec.InterfaceType) {} // eslint-disable-line @typescript-eslint/no-empty-function
  protected onInterfaceMethod(_ifc: spec.InterfaceType, _method: spec.Method) {} // eslint-disable-line @typescript-eslint/no-empty-function
  protected onInterfaceMethodOverload(
    _ifc: spec.InterfaceType,
    _overload: spec.Method,
    _originalMethod: spec.Method,
  ) {} // eslint-disable-line @typescript-eslint/no-empty-function
  protected onInterfaceProperty(
    _ifc: spec.InterfaceType,
    _prop: spec.Property,
  ) {} // eslint-disable-line @typescript-eslint/no-empty-function
  protected onProperty(_cls: spec.ClassType, _prop: spec.Property) {} // eslint-disable-line @typescript-eslint/no-empty-function
  protected onStaticProperty(_cls: spec.ClassType, _prop: spec.Property) {} // eslint-disable-line @typescript-eslint/no-empty-function
  protected onUnionProperty(
    _cls: spec.ClassType,
    _prop: spec.Property,
    _union: spec.UnionTypeReference,
  ) {} // eslint-disable-line @typescript-eslint/no-empty-function
  protected onMethod(_cls: spec.ClassType, _method: spec.Method) {} // eslint-disable-line @typescript-eslint/no-empty-function
  protected onMethodOverload(
    _cls: spec.ClassType,
    _overload: spec.Method,
    _originalMethod: spec.Method,
  ) {} // eslint-disable-line @typescript-eslint/no-empty-function
  protected onStaticMethod(_cls: spec.ClassType, _method: spec.Method) {} // eslint-disable-line @typescript-eslint/no-empty-function
  protected onStaticMethodOverload(
    _cls: spec.ClassType,
    _overload: spec.Method,
    _originalMethod: spec.Method,
  ) {} // eslint-disable-line @typescript-eslint/no-empty-function
}

export default RubyTarget;
