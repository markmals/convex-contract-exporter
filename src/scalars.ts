import ts from "typescript";
import type { Shape } from "./contract.js";

export interface Intrinsics {
  bytes: ts.Type;
  commitTimestamp: ts.Type;
  idBrand: ts.Symbol;
}

export function scalar(type: ts.Type, checker: ts.TypeChecker, intrinsics: Intrinsics, fail: (message: string) => never): Shape | undefined {
  if (type.flags & ts.TypeFlags.String) return { kind: "string" };
  if (type.flags & ts.TypeFlags.Number) return { kind: "float64" };
  if (type.flags & ts.TypeFlags.Boolean) return { kind: "boolean" };
  if (type.flags & ts.TypeFlags.BigInt) return { kind: "int64" };
  if (type.flags & ts.TypeFlags.Null) return { kind: "null" };
  if (type.isStringLiteral() || type.isNumberLiteral()) return { kind: "literal", value: type.value };
  if (type.flags & ts.TypeFlags.BooleanLiteral) return { kind: "literal", value: type === checker.getTrueType() };
  if (type.flags & ts.TypeFlags.BigIntLiteral) {
    const literal = type as ts.BigIntLiteralType;
    const integer = BigInt(`${literal.value.negative ? "-" : ""}${literal.value.base10Value}`);
    if (integer < -(1n << 63n) || integer >= (1n << 63n)) return fail("bigint literal is outside signed Int64 range");
    const bytes = Buffer.alloc(8);
    bytes.writeBigInt64LE(integer);
    return { kind: "literal", value: { $integer: bytes.toString("base64") } };
  }
  if (type.getSymbol() === intrinsics.bytes.getSymbol()) return { kind: "bytes" };
  if (type.getSymbol() === intrinsics.commitTimestamp.getSymbol()) return { kind: "int64", semantic: "commitTimestamp" };
  if (type.isIntersection()) {
    const brand = type.getProperty("__tableName");
    if (!brand) return undefined;
    const actualDeclarations = brand.getDeclarations() ?? [];
    const expectedDeclarations = intrinsics.idBrand.getDeclarations() ?? [];
    if (!actualDeclarations.some(declaration => expectedDeclarations.includes(declaration))) return undefined;
    const declaration = brand.valueDeclaration ?? actualDeclarations[0];
    if (!declaration) return fail("unresolved document ID brand");
    const table = checker.getTypeOfSymbolAtLocation(brand, declaration);
    if (!table.isStringLiteral()) return fail("document ID must identify one concrete table");
    if (type.types.length !== 2 || !type.types.some(part => part.flags & ts.TypeFlags.String)) {
      return fail("document IDs cannot carry additional intersections");
    }
    return { kind: "id", table: table.value };
  }
  return undefined;
}

export function undefinedType(type: ts.Type): boolean {
  return Boolean(type.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void));
}

export function hasUndefined(type: ts.Type): boolean {
  return type.isUnion() ? type.types.some(undefinedType) : undefinedType(type);
}

export function recordKey(shape: Shape): boolean {
  return shape.kind === "string" || shape.kind === "id"
    || (shape.kind === "literal" && typeof shape.value === "string")
    || (shape.kind === "union" && shape.variants.every(recordKey));
}
