import type { Shape } from "./contract.js";
import { canonicalJSON, compareText } from "./canonical.js";

export function union(variants: Shape[], resolve: (shape: Shape) => Shape, fail: (message: string) => never): Shape {
  let flattened = variants.flatMap(shape => shape.kind === "union" ? shape.variants : [shape]);
  const unique = new Map(flattened.map(shape => [canonicalJSON(shape), shape]));
  flattened = [...unique.entries()].sort(([left], [right]) => compareText(left, right)).map(([, shape]) => shape);
  const kinds = new Set(flattened.map(shape => resolve(shape).kind));
  if (flattened.some(shape => shape.kind === "literal" && shape.value === true)
      && flattened.some(shape => shape.kind === "literal" && shape.value === false)) {
    flattened = flattened.filter(shape => !(shape.kind === "literal" && typeof shape.value === "boolean"));
    if (!kinds.has("boolean")) flattened.push({ kind: "boolean" });
    kinds.add("boolean");
  }
  flattened = flattened.filter(shape => {
    if (shape.kind === "literal") return !kinds.has(literalKind(shape.value));
    return !(shape.kind === "id" && kinds.has("string"));
  });
  const integers = flattened.filter(shape => resolve(shape).kind === "int64");
  if (integers.length > 1) {
    flattened = flattened.filter(shape => resolve(shape).kind !== "int64");
    flattened.push(integers.some(shape => {
      const resolved = resolve(shape);
      return resolved.kind === "int64" && resolved.semantic === "commitTimestamp";
    }) ? { kind: "int64", semantic: "commitTimestamp" } : { kind: "int64" });
  }
  if (!flattened.length) return fail("type has no representable wire values");
  if (flattened.length === 1) return flattened[0]!;
  for (let left = 0; left < flattened.length; left++) {
    for (let right = left + 1; right < flattened.length; right++) {
      if (!disjoint(flattened[left]!, flattened[right]!, resolve)) {
        return fail("overlapping union variants; add a required literal discriminant");
      }
    }
  }
  return { kind: "union", variants: flattened.sort((left, right) => compareText(canonicalJSON(left), canonicalJSON(right))) };
}

function literalKind(value: Extract<Shape, { kind: "literal" }>["value"]): "string" | "boolean" | "float64" | "int64" {
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  return typeof value === "number" ? "float64" : "int64";
}

function wireKind(shape: Shape): string {
  switch (shape.kind) {
    case "literal": return literalKind(shape.value);
    case "id": return "string";
    case "tuple": return "array";
    case "record": return "object";
    default: return shape.kind;
  }
}

export function disjoint(first: Shape, second: Shape, resolve: (shape: Shape) => Shape): boolean {
  const left = resolve(first);
  const right = resolve(second);
  if (left.kind === "dynamic" || right.kind === "dynamic") return false;
  if (left.kind === "union") return left.variants.every(variant => disjoint(variant, right, resolve));
  if (right.kind === "union") return right.variants.every(variant => disjoint(left, variant, resolve));
  if (wireKind(left) !== wireKind(right)) return true;
  if (left.kind === "literal" && right.kind === "literal") return canonicalJSON(left) !== canonicalJSON(right);
  if (left.kind === "object" && right.kind === "object") {
    return left.fields.some(field => {
      const other = right.fields.find(candidate => candidate.name === field.name);
      return !field.optional && other && !other.optional && disjoint(field.type, other.type, resolve);
    });
  }
  if (left.kind === "tuple" && right.kind === "tuple") {
    return left.elements.length !== right.elements.length
      || left.elements.some((element, index) => disjoint(element, right.elements[index]!, resolve));
  }
  if (left.kind === "tuple" && right.kind === "array") return left.elements.some(element => disjoint(element, right.element, resolve));
  if (left.kind === "array" && right.kind === "tuple") return right.elements.some(element => disjoint(left.element, element, resolve));
  return false;
}
