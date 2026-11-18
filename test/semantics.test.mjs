import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { exportContract } from "../dist/exporter.js";

const repository = fileURLToPath(new URL("../", import.meta.url));

async function project(t, declarations, model = "{}", source) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "convex-contract-semantic-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "convex/_generated"), { recursive: true });
  await fs.symlink(path.join(repository, "node_modules"), path.join(root, "node_modules"), "dir");
  await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}\n');
  await fs.writeFile(path.join(root, "package-lock.json"), '{"lockfileVersion":3}\n');
  await fs.writeFile(path.join(root, "convex/tsconfig.json"), JSON.stringify({ compilerOptions: {
    target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, noUnusedLocals: true, types: [], lib: ["ES2022", "DOM"], noEmit: true,
  }, include: ["**/*.ts"] }));
  await fs.writeFile(path.join(root, "convex/_generated/api.d.ts"), source ? `
import type { ApiFromModules, FilterApi, FunctionReference } from "convex/server";
import type * as backend from "../test.js";
declare const fullApi: ApiFromModules<{ test: typeof backend }>;
export declare const api: FilterApi<typeof fullApi, FunctionReference<any, "public">>;
` : `
import type { FunctionReference } from "convex/server";
import type { GenericId, CommitTsPlaceholder } from "convex/values";
${declarations}
`);
  await fs.writeFile(path.join(root, "convex/_generated/dataModel.d.ts"), `import type { GenericId } from "convex/values"; export type DataModel = ${model};\n`);
  if (source) await fs.writeFile(path.join(root, "convex/test.ts"), source);
  return { project: path.join(root, "convex/tsconfig.json"), root };
}

function resolved(contract, shape) {
  return shape.kind === "ref" ? resolved(contract, contract.types[shape.name]) : shape;
}

function fields(contract, shape) {
  const object = resolved(contract, shape);
  assert.equal(object.kind, "object");
  return Object.fromEntries(object.fields.map(field => [field.name, { ...field, type: resolved(contract, field.type) }]));
}

test("public helpers preserve inferred returns, visibility, source, and void normalization", async t => {
  const options = await project(t, "", "{}", `
import { queryGeneric as query, mutationGeneric as mutation, internalQueryGeneric as internalQuery, actionGeneric as action } from "convex/server";
import { v } from "convex/values";
export interface Envelope { label: string; nullable: string | null; optional?: string; optionalNullable?: string | null; requiredNull: null }
export const inferred = query({ args: { title: v.string(), maybe: v.optional(v.string()) }, handler: (_ctx, args): Envelope => ({ label: args.title, nullable: null, requiredNull: null }) });
export const empty = mutation({ args: {}, handler: () => {} });
export const effect = action({ args: {}, handler: async () => 7 as const });
export const hidden = internalQuery({ args: {}, handler: () => "secret" });
export default query({ handler: () => true });
export const narrow = query({ args: {}, returns: v.union(v.literal("a"), v.literal("b")), handler: () => "a" as const });
`);
  const contract = await exportContract(options);
  assert.deepEqual(contract.functions.map(fn => [fn.path, fn.kind]), [["test", "query"], ["test:effect", "action"], ["test:empty", "mutation"], ["test:inferred", "query"], ["test:narrow", "query"]]);
  const inferred = contract.functions.find(fn => fn.name === "inferred");
  assert.equal(inferred.typeSource, "inferred");
  assert.equal(inferred.source.file, "convex/test.ts");
  assert.equal(inferred.source.line, 5);
  assert.equal(inferred.result.kind, "ref");
  const output = fields(contract, inferred.result);
  assert.equal(output.nullable.optional, false);
  assert.equal(output.nullable.type.kind, "union");
  assert.deepEqual(output.optional, { name: "optional", type: { kind: "string" }, optional: true });
  assert.equal(output.optionalNullable.optional, true);
  assert.equal(output.optionalNullable.type.kind, "union");
  assert.deepEqual(output.requiredNull, { name: "requiredNull", optional: false, type: { kind: "null" } });
  assert.deepEqual(contract.functions.find(fn => fn.name === "empty").result, { kind: "null" });
  assert.deepEqual(contract.functions.find(fn => fn.name === "effect").result, { kind: "literal", value: 7 });
  assert.deepEqual(contract.functions.find(fn => fn.name === "narrow").result, { kind: "literal", value: "a" });
});

test("concrete static contracts retain every wire category and table identity", async t => {
  const options = await project(t, `
export declare const api: { nested: { module: {
  run: FunctionReference<"query", "public", { optional?: string; nullable: string | null }, {
    bytes: ArrayBuffer; int: bigint; float: number; truth: boolean; id: GenericId<"users">; storage: GenericId<"_storage">;
    literal: -9223372036854775808n; tuple: readonly [string, number, null]; array: readonly bigint[];
    record: Record<string, boolean>; finiteRecord: Record<"a" | "b", number>; idRecord: Record<GenericId<"users">, string>;
    mixedIdRecord: Record<GenericId<"users"> | GenericId<"_storage">, string>;
    union: { tag: "a"; payload: string } | { tag: "b"; payload: number }; disjoint: string | bigint | null;
    intersection: { a: string } & { b: number }; timestamp: CommitTsPlaceholder | bigint;
  }>;
  hidden: FunctionReference<"mutation", "internal", {}, string>;
  component: FunctionReference<"query", "public", {}, string, "component/path">;
} } };
`, `{users: { document: { _id: GenericId<"users">; _creationTime: number; name: string }; fieldPaths: string; indexes: {}; searchIndexes: {}; vectorIndexes: {} }}`);
  const contract = await exportContract(options);
  assert.equal(contract.functions.length, 1);
  assert.equal(contract.functions[0].path, "nested/module:run");
  assert.equal(contract.functions[0].typeSource, "validator");
  const output = fields(contract, contract.functions[0].result);
  for (const [field, kind] of Object.entries({ bytes: "bytes", int: "int64", float: "float64", truth: "boolean", id: "id", storage: "id", literal: "literal", tuple: "tuple", array: "array", record: "record", finiteRecord: "record", idRecord: "record", union: "union", disjoint: "union", intersection: "object", timestamp: "int64" })) assert.equal(output[field].type.kind, kind, field);
  assert.equal(output.timestamp.type.semantic, "commitTimestamp");
  assert.deepEqual(output.literal.type.value, { $integer: "AAAAAAAAAIA=" });
  assert.equal(output.tuple.type.elements.length, 3);
  assert.equal(output.storage.type.table, "_storage");
  assert.equal(output.mixedIdRecord.type.kind, "record");
  assert.equal(output.mixedIdRecord.type.key.kind, "union");
  assert.equal(fields(contract, contract.tables[0].document)._id.type.table, "users");
});

test("exact dynamic opt-ins do not silently widen neighboring fields", async t => {
  const options = await project(t, 'export declare const api: { test: { run: FunctionReference<"query", "public", {}, { payload: unknown; stable: string }> } };');
  await assert.rejects(exportContract(options), /functions\/test:run\/result\/payload.*any\/unknown/);
  const contract = await exportContract({ ...options, allowDynamic: ["functions/test:run/result/payload"] });
  assert.equal(contract.functions[0].typeSource, "dynamic");
  assert.equal(fields(contract, contract.functions[0].result).payload.type.kind, "dynamic");
  assert.equal(fields(contract, contract.functions[0].result).stable.type.kind, "string");
  await assert.rejects(exportContract({ ...options, allowDynamic: ["functions/test:run/result"] }), /any\/unknown/);
});

test("a shared alias cannot spread a path-scoped dynamic opt-in", async t => {
  const options = await project(t, "", "{}", `
import { queryGeneric } from "convex/server";
export interface Box { payload: unknown }
export const run = queryGeneric({ args: {}, handler: (): { left: Box; right: Box } => ({ left: { payload: null }, right: { payload: null } }) });
`);
  await assert.rejects(exportContract({ ...options, allowDynamic: ["functions/test:run/result/left/payload"] }), /functions\/test:run\/result\/right\/payload.*any\/unknown/);
  const contract = await exportContract({ ...options, allowDynamic: ["functions/test:run/result/left/payload", "functions/test:run/result/right/payload"] });
  assert.equal(fields(contract, fields(contract, contract.functions[0].result).right.type).payload.type.kind, "dynamic");
});

test("schema-less models require explicit dynamic provenance", async t => {
  const options = await project(t, 'export declare const api: { test: { run: FunctionReference<"query", "public", {}, null> } };', '{ [name: string]: { document: any } }');
  await assert.rejects(exportContract(options), /schema-less or dynamic/);
  const contract = await exportContract({ ...options, allowDynamic: ["tables"] });
  assert.deepEqual(contract.tables, []);
  assert.deepEqual(contract.types.dataModel, { kind: "dynamic" });
});

for (const [label, result, expected, declarations = ""] of [
  ["undefined array elements", "(string | undefined)[]", /undefined is not a wire value/],
  ["overlapping object union", "{ a: string } | { b: string }", /overlapping union/],
  ["recursive types", "Recursive", /recursive shapes/, "type Recursive = { child?: Recursive }"],
  ["unsupported class", "Date", /class instances|functions and constructors/],
  ["function values", "() => string", /functions and constructors/],
  ["variadic tuple", "[string, ...number[]]", /fixed-length tuples/],
  ["bigint overflow", "9223372036854775808n", /outside signed Int64/],
  ["arbitrary string brand", 'string & { __tableName: "users" }', /intersection/],
  ["dynamic static return", "any", /source-linked API/],
]) {
  test(`rejects ${label} with endpoint position`, async t => {
    const options = await project(t, `${declarations}\nexport declare const api: { test: { run: FunctionReference<"query", "public", {}, ${result}> } };`);
    await assert.rejects(exportContract(options), error => {
      assert.match(error.message, expected);
      assert.match(error.message, /functions\/test:run\/result/);
      assert.match(error.message, /api\.d\.ts:\d+/);
      return true;
    });
  });
}

test("compiler failures report original source and never execute modules", async t => {
  const options = await project(t, "", "{}", `
import { queryGeneric } from "convex/server";
throw new Error("backend module executed");
const wrong: string = 123;
export const run = queryGeneric({ args: {}, handler: () => wrong });
`);
  await assert.rejects(exportContract(options), /convex\/test.ts:4: TS2322/);
  await fs.writeFile(path.join(options.root, "convex/test.ts"), `import { queryGeneric } from "convex/server"; throw new Error("backend module executed"); export const run = queryGeneric({ args: {}, handler: () => "safe" });`);
  const contract = await exportContract(options);
  assert.equal(contract.functions[0].path, "test:run");
});

test("source fingerprint is relocation-stable and detects source and lock drift", async t => {
  const declaration = 'export declare const api: { test: { run: FunctionReference<"query", "public", {}, string> } };';
  const first = await project(t, declaration);
  const second = await project(t, declaration);
  const baseline = await exportContract(first);
  assert.deepEqual(await exportContract(second), baseline);
  await fs.writeFile(path.join(second.root, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}\n');
  assert.notEqual((await exportContract(second)).provenance.sourceHash, baseline.provenance.sourceHash);
  await fs.appendFile(path.join(first.root, "convex/_generated/api.d.ts"), "\n// Relevant source content changed.\n");
  assert.notEqual((await exportContract(first)).provenance.sourceHash, baseline.provenance.sourceHash);
});

test("adding an endpoint preserves existing result type identities", async t => {
  const existing = 'z: FunctionReference<"query", "public", {}, string | null>';
  const first = await project(t, `export declare const api: { test: { ${existing} } };`);
  const second = await project(t, `export declare const api: { test: { a: FunctionReference<"query", "public", {}, boolean>; ${existing} } };`);
  const baseline = await exportContract(first);
  const added = await exportContract(second);
  assert.deepEqual(added.functions.find(fn => fn.name === "z").result, baseline.functions[0].result);
  assert.deepEqual(added.types, baseline.types);
});
