import ts from "typescript";
import type { ContractFunction } from "./contract.js";
import { compareText } from "./canonical.js";
import { relative } from "./project.js";

export const PROBE_IMPORTS = `import type { api } from "./_generated/api.js";
import type { DataModel } from "./_generated/dataModel.js";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import type { GenericId, CommitTsPlaceholder } from "convex/values";
export type { FunctionArgs, FunctionReturnType };
export type __ClientResult<T> = T extends void ? null : T;
export type __API = typeof api;
export type __Model = DataModel;
export type __Bytes = ArrayBuffer;
export type __Commit = CommitTsPlaceholder;
export type __ID = GenericId<"__contract_id_probe__">;
`;

export interface Endpoint {
  segments: string[];
  path: string;
  kind: ContractFunction["kind"];
}

export function aliasTypes(program: ts.Program, probePath: string): Map<string, { type: ts.Type; node: ts.TypeAliasDeclaration }> {
  const checker = program.getTypeChecker();
  const probe = program.getSourceFile(probePath);
  if (!probe) throw new Error("Compiler did not load semantic probe");
  const aliases = new Map<string, { type: ts.Type; node: ts.TypeAliasDeclaration }>();
  for (const node of probe.statements) {
    if (ts.isTypeAliasDeclaration(node)) aliases.set(node.name.text, { type: checker.getTypeAtLocation(node), node });
  }
  return aliases;
}

export function discover(checker: ts.TypeChecker, api: ts.Type, node: ts.Node): Endpoint[] {
  const endpoints: Endpoint[] = [];
  const active = new Set<ts.Type>();
  const visit = (type: ts.Type, segments: string[]) => {
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) || checker.getIndexInfosOfType(type).length) {
      throw new Error(`api.${segments.join(".")}: generated API is not concrete; run source-linked Convex codegen`);
    }
    const kind = propertyType(checker, type, "_type", node);
    if (kind) {
      const visibility = propertyType(checker, type, "_visibility", node);
      if (!visibility?.isStringLiteral()) throw new Error(`api.${segments.join(".")}: unresolved function visibility`);
      if (visibility.value === "internal") return;
      if (visibility.value !== "public") throw new Error(`api.${segments.join(".")}: unsupported function visibility`);
      const component = propertyType(checker, type, "_componentPath", node);
      if (component?.isStringLiteral()) return;
      if (!kind.isStringLiteral() || !["query", "mutation", "action"].includes(kind.value)) {
        throw new Error(`api.${segments.join(".")}: unsupported function kind`);
      }
      if (segments.length < 2) throw new Error(`api.${segments.join(".")}: function must belong to a module`);
      const name = segments.at(-1)!;
      const module = segments.slice(0, -1).join("/");
      const address = name === "default" ? module : `${module}:${name}`;
      endpoints.push({ segments, path: address, kind: kind.value as Endpoint["kind"] });
      return;
    }
    if (active.has(type)) throw new Error(`api.${segments.join(".")}: recursive API namespace`);
    if (!(type.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection))) throw new Error(`api.${segments.join(".")}: unresolved API namespace`);
    active.add(type);
    for (const property of type.getProperties()) {
      visit(checker.getTypeOfSymbolAtLocation(property, node), [...segments, property.name]);
    }
    active.delete(type);
  };
  visit(api, []);
  endpoints.sort((left, right) => compareText(left.path, right.path));
  for (let index = 1; index < endpoints.length; index++) {
    if (endpoints[index - 1]!.path === endpoints[index]!.path) throw new Error(`Duplicate function path ${endpoints[index]!.path}`);
  }
  return endpoints;
}

export function propertyType(checker: ts.TypeChecker, type: ts.Type, name: string, node: ts.Node): ts.Type | undefined {
  const property = type.getProperty(name);
  return property ? checker.getTypeOfSymbolAtLocation(property, node) : undefined;
}

export function endpointSource(checker: ts.TypeChecker, api: ts.Type, endpoint: Endpoint, fallback: ts.Node, root: string) {
  let type = api;
  let declaration = fallback;
  for (const segment of endpoint.segments) {
    const property = type.getProperty(segment);
    if (!property) throw new Error(`API changed while resolving ${endpoint.path}`);
    declaration = property.valueDeclaration ?? property.getDeclarations()?.[0] ?? declaration;
    type = checker.getTypeOfSymbolAtLocation(property, declaration);
  }
  const source = declaration.getSourceFile();
  return {
    node: declaration,
    source: { file: relative(root, source.fileName), line: source.getLineAndCharacterOfPosition(declaration.getStart()).line + 1 },
    typeSource: source.isDeclarationFile || source.fileName.includes("/_generated/") ? "validator" as const : "inferred" as const,
  };
}
