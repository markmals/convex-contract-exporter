import ts from "typescript";
import type { Field, Shape } from "./contract.js";
import { compareText } from "./canonical.js";
import { relative } from "./project.js";
import { hasUndefined, recordKey, scalar, undefinedType, type Intrinsics } from "./scalars.js";
import { union } from "./unions.js";

export class Shapes {
  readonly types: Record<string, Shape> = Object.create(null);
  readonly usedDynamic = new Set<string>();
  private readonly active = new Set<ts.Type>();
  private readonly named = new Map<ts.Type, string>();

  constructor(
    private readonly checker: ts.TypeChecker,
    private readonly intrinsics: Intrinsics,
    private readonly root: string,
    private readonly allowedDynamic: Set<string>,
  ) {}

  fail(position: string, node: ts.Node, message: string): never {
    const source = node.getSourceFile();
    const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    throw new Error(`${relative(this.root, source.fileName)}:${line}: ${position}: ${message}`);
  }

  resolve = (shape: Shape): Shape => {
    if (shape.kind !== "ref") return shape;
    const definition = this.types[shape.name];
    if (!definition) throw new Error(`Unresolved named type ${shape.name}`);
    return this.resolve(definition);
  };

  define(type: ts.Type, name: string, position: string, node: ts.Node): Shape {
    if (this.types[name]) return this.fail(position, node, `duplicate named type ${name}`);
    const shape = this.extract(type, position, node, false);
    this.types[name] = shape;
    this.named.set(type, name);
    return { kind: "ref", name };
  }

  extract(type: ts.Type, position: string, node: ts.Node, nameAliases = true): Shape {
    const fail = (message: string): never => this.fail(position, node, message);
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
      if (!this.allowedDynamic.has(position)) return fail("any/unknown requires --allow-dynamic at this exact path; regenerate source-linked API or add explicit validators if inference was erased");
      this.usedDynamic.add(position);
      return { kind: "dynamic" };
    }
    if (this.active.has(type)) return fail("recursive shapes are unsupported");
    const existingName = this.named.get(type);
    if (existingName) return { kind: "ref", name: existingName };
    const primitive = scalar(type, this.checker, this.intrinsics, fail);
    if (primitive) return primitive;
    if (undefinedType(type)) return fail("undefined is not a wire value here; only result roots and omitted object properties support it");
    if (type.flags & (ts.TypeFlags.Never | ts.TypeFlags.TypeParameter | ts.TypeFlags.Conditional | ts.TypeFlags.IndexedAccess | ts.TypeFlags.ESSymbolLike | ts.TypeFlags.TemplateLiteral | ts.TypeFlags.StringMapping)) {
      return fail(`unsupported TypeScript type ${this.checker.typeToString(type)}`);
    }
    this.active.add(type);
    try {
      const dynamicBefore = this.usedDynamic.size;
      const shape = this.composite(type, position, node);
      // Caching a dynamic alias would authorize other positions without their own opt-in.
      const alias = nameAliases && dynamicBefore === this.usedDynamic.size ? this.aliasName(type, position) : undefined;
      if (alias) {
        if (this.types[alias]) return fail(`named type collision ${alias}`);
        this.types[alias] = shape;
        this.named.set(type, alias);
        return { kind: "ref", name: alias };
      }
      return shape;
    } finally {
      this.active.delete(type);
    }
  }

  private composite(type: ts.Type, position: string, node: ts.Node): Shape {
    const fail = (message: string): never => this.fail(position, node, message);
    if (type.isUnion()) return union(type.types.map((variant, index) => this.extract(variant, `${position}/variants/${index}`, node)), this.resolve, fail);
    if (type.isIntersection() && type.types.some(part => !(part.flags & ts.TypeFlags.Object))) {
      return fail("intersection is not a concrete wire object or Convex ID");
    }
    if (this.checker.isTupleType(type)) {
      const reference = type as ts.TypeReference;
      const target = reference.target as ts.TupleType;
      if (target.elementFlags.some(flags => flags & (ts.ElementFlags.Optional | ts.ElementFlags.Rest | ts.ElementFlags.Variadic))) {
        return fail("only fixed-length tuples with required elements are supported");
      }
      return { kind: "tuple", elements: this.checker.getTypeArguments(reference).map((element, index) => this.extract(element, `${position}/elements/${index}`, node)) };
    }
    if (this.checker.isArrayType(type)) {
      const element = this.checker.getTypeArguments(type as ts.TypeReference)[0];
      if (!element) return fail("unresolved array element");
      return { kind: "array", element: this.extract(element, `${position}/element`, node) };
    }
    if (!(type.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection))) return fail(`unsupported TypeScript type ${this.checker.typeToString(type)}`);
    if (type.getCallSignatures().length || type.getConstructSignatures().length) return fail("functions and constructors are not Convex values");
    const declarations = type.getSymbol()?.getDeclarations() ?? [];
    const indices = this.checker.getIndexInfosOfType(type);
    if (!type.getProperties().length && indices.length === 1 && indices[0]!.keyType.flags & ts.TypeFlags.String && indices[0]!.type.flags & ts.TypeFlags.Never) {
      return { kind: "object", fields: [] };
    }
    const recordArguments = type.aliasSymbol?.name === "Record" && type.aliasSymbol.getDeclarations()?.every(declaration => declaration.getSourceFile().hasNoDefaultLib)
      ? type.aliasTypeArguments : undefined;
    if (recordArguments?.length === 2) return this.record(recordArguments[0]!, recordArguments[1]!, position, node);
    if (declarations.some(declaration => ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration) || (ts.isInterfaceDeclaration(declaration) && declaration.getSourceFile().hasNoDefaultLib))) return fail("class instances and non-wire built-ins are not Convex wire objects");
    if (indices.length) {
      if (type.getProperties().length || indices.some(index => index.type !== indices[0]!.type)) return fail("mixed index signatures and named fields are unsupported");
      return this.record(indices.map(index => index.keyType), indices[0]!.type, position, node);
    }
    return { kind: "object", fields: this.fields(type, position, node) };
  }

  private record(keyType: ts.Type | ts.Type[], valueType: ts.Type, position: string, node: ts.Node): Shape {
    const keyTypes = Array.isArray(keyType) ? keyType : keyType.isUnion() ? keyType.types : [keyType];
    const keyVariants = keyTypes.map((variant, index) =>
      this.extract(variant, `${position}/key${keyTypes.length > 1 ? `/variants/${index}` : ""}`, node, false));
    const uniqueKeys = [...new Map(keyVariants.map(key => [JSON.stringify(key), key])).entries()]
      .sort(([left], [right]) => compareText(left, right)).map(([, key]) => key);
    const key: Shape = uniqueKeys.length === 1 ? uniqueKeys[0]! : { kind: "union", variants: uniqueKeys };
    if (!recordKey(this.resolve(key))) return this.fail(position, node, "record keys must be strings, concrete IDs, or string literals");
    return { kind: "record", key, value: this.extract(valueType, `${position}/value`, node) };
  }

  private fields(type: ts.Type, position: string, node: ts.Node): Field[] {
    return type.getProperties().sort((left, right) => compareText(left.name, right.name)).map(property => {
      const declaration = property.valueDeclaration ?? property.getDeclarations()?.[0] ?? node;
      const memberPosition = `${position}/${escapeSegment(property.name)}`;
      if (property.escapedName.toString().startsWith("__@")) return this.fail(memberPosition, declaration, "symbol keys are not Convex object fields");
      const member = this.checker.getTypeOfSymbolAtLocation(property, declaration);
      const optional = Boolean(property.flags & ts.SymbolFlags.Optional) || hasUndefined(member);
      const variants = member.isUnion() ? member.types.filter(variant => !undefinedType(variant)) : undefined;
      const shape = variants
        ? union(variants.map((variant, index) => this.extract(variant, variants.length === 1 ? memberPosition : `${memberPosition}/variants/${index}`, declaration)), this.resolve, message => this.fail(memberPosition, declaration, message))
        : this.extract(member, memberPosition, declaration);
      return { name: property.name, type: shape, optional };
    });
  }

  private aliasName(type: ts.Type, position: string): string | undefined {
    const symbol = type.aliasSymbol ?? type.getSymbol();
    const declaration = symbol?.getDeclarations()?.find(candidate => ts.isTypeAliasDeclaration(candidate) || ts.isInterfaceDeclaration(candidate));
    if (!symbol || !declaration) return undefined;
    const file = relative(this.root, declaration.getSourceFile().fileName);
    if (file.startsWith("../") || file.includes("node_modules/") || file.includes("_generated/") || file === ".convex-contract-probe.ts" || file.endsWith("/.convex-contract-probe.ts")) return undefined;
    const generic = (ts.isTypeAliasDeclaration(declaration) || ts.isInterfaceDeclaration(declaration)) && declaration.typeParameters?.length;
    return `${file.replace(/\.(?:d\.)?[cm]?tsx?$/, "")}#${symbol.name}${generic ? `@${position}` : ""}`;
  }
}

export function escapeSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}
