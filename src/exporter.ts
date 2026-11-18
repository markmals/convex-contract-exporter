import ts from "typescript";
import { aliasTypes, discover, endpointSource, PROBE_IMPORTS, propertyType } from "./api.js";
import { compareText } from "./canonical.js";
import type { Contract, ExportOptions, Shape } from "./contract.js";
import { CONVEX_VERSION, loadProject, TYPESCRIPT_VERSION } from "./project.js";
import { sourceHash } from "./provenance.js";
import { Shapes } from "./shapes.js";

export type { Contract, ContractFunction, ExportOptions, Field, Shape } from "./contract.js";

export async function exportContract(options: ExportOptions): Promise<Contract> {
  const project = loadProject(options);
  const discoveryProgram = project.build(PROBE_IMPORTS);
  const discoveryAliases = aliasTypes(discoveryProgram, project.probePath);
  const publicAPI = discoveryAliases.get("__API")!;
  const endpoints = discover(discoveryProgram.getTypeChecker(), publicAPI.type, publicAPI.node);
  const probes = endpoints.map((endpoint, index) => {
    const access = `typeof api${endpoint.segments.map(segment => `[${JSON.stringify(segment)}]`).join("")}`;
    return `export type __Args${index} = FunctionArgs<${access}>;\nexport type __Result${index} = __ClientResult<Awaited<FunctionReturnType<${access}>>>;`;
  }).join("\n");
  const program = project.build(`${PROBE_IMPORTS}${probes}`);
  const checker = program.getTypeChecker();
  const aliases = aliasTypes(program, project.probePath);
  const api = aliases.get("__API")!;
  const allowedDynamic = new Set(options.allowDynamic ?? []);
  if (allowedDynamic.size !== (options.allowDynamic ?? []).length) throw new Error("Duplicate --allow-dynamic position");
  const shapes = new Shapes(checker, {
    bytes: aliases.get("__Bytes")!.type,
    commitTimestamp: aliases.get("__Commit")!.type,
    idBrand: aliases.get("__ID")!.type.getProperty("__tableName")!,
  }, project.root, allowedDynamic);
  const model = aliases.get("__Model")!;
  const tables = extractTables(checker, model.type, model.node, shapes, allowedDynamic);
  const functions = endpoints.map((endpoint, index) => {
    const origin = endpointSource(checker, api.type, endpoint, api.node, project.root);
    const argumentsShape = shapes.extract(aliases.get(`__Args${index}`)!.type, `functions/${endpoint.path}/arguments`, origin.node, false);
    if (argumentsShape.kind !== "object") return shapes.fail(`functions/${endpoint.path}/arguments`, origin.node, "function arguments must be a concrete object");
    const result = shapes.extract(aliases.get(`__Result${index}`)!.type, `functions/${endpoint.path}/result`, origin.node);
    return {
      path: endpoint.path,
      module: endpoint.segments.slice(0, -1),
      name: endpoint.segments.at(-1)!,
      kind: endpoint.kind,
      arguments: argumentsShape,
      result,
      typeSource: containsDynamic(argumentsShape, shapes) || containsDynamic(result, shapes) ? "dynamic" as const : origin.typeSource,
      source: origin.source,
    };
  });
  for (const position of allowedDynamic) {
    if (!shapes.usedDynamic.has(position)) throw new Error(`Unused --allow-dynamic position ${position}; opt-ins must match an any/unknown node exactly`);
  }
  return {
    formatVersion: 1,
    provenance: {
      exporterVersion: "0.1.0",
      convexVersion: CONVEX_VERSION,
      typescriptVersion: TYPESCRIPT_VERSION,
      sourceHash: sourceHash(program, project.root, { ...options, project: project.project, root: project.root }, project.configFiles),
    },
    functions,
    tables,
    types: shapes.types,
  };
}

function extractTables(checker: ts.TypeChecker, model: ts.Type, node: ts.Node, shapes: Shapes, allowedDynamic: Set<string>): Contract["tables"] {
  if (model.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) || checker.getIndexInfosOfType(model).length) {
    if (!allowedDynamic.has("tables")) shapes.fail("tables", node, "schema-less or dynamic data model requires --allow-dynamic tables; no table identities can be enumerated");
    shapes.types.dataModel = { kind: "dynamic" };
    shapes.usedDynamic.add("tables");
    return [];
  }
  return model.getProperties().sort((left, right) => compareText(left.name, right.name)).map(table => {
    const tableType = checker.getTypeOfSymbolAtLocation(table, node);
    const document = propertyType(checker, tableType, "document", node);
    const origin = table.getDeclarations()?.[0] ?? node;
    const position = `tables/${table.name}/document`;
    if (!document) return shapes.fail(position, origin, "data model table has no document type");
    const id = propertyType(checker, document, "_id", origin);
    const creationTime = propertyType(checker, document, "_creationTime", origin);
    if (!(document.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))) {
      if (!id || !creationTime) return shapes.fail(position, origin, "document must include _id and _creationTime");
      const idShape = shapes.extract(id, `${position}/_id`, origin);
      if (idShape.kind !== "id" || idShape.table !== table.name || !(creationTime.flags & ts.TypeFlags.Number)) {
        return shapes.fail(position, origin, "document system fields do not match the table");
      }
    }
    return { name: table.name, document: shapes.define(document, `tables/${table.name}`, position, origin) };
  });
}

function children(shape: Shape): Shape[] {
  switch (shape.kind) {
    case "object": return shape.fields.map(field => field.type);
    case "array": return [shape.element];
    case "tuple": return shape.elements;
    case "record": return [shape.key, shape.value];
    case "union": return shape.variants;
    default: return [];
  }
}

function containsDynamic(shape: Shape, shapes: Shapes): boolean {
  const resolved = shapes.resolve(shape);
  return resolved.kind === "dynamic" || children(resolved).some(child => containsDynamic(child, shapes));
}

