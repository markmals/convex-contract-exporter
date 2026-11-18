import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(repository, "dist", "cli.js");
assert.ok(fs.existsSync(cli), "dist/cli.js is missing; run `npm run build` before `npm test`.");

const { canonicalJSON } = await import(pathToFileURL(path.join(repository, "dist", "canonical.js")).href);

// The installed Convex CLI's own codegen templates produce the generated files.
const templates = path.join(repository, "node_modules", "convex", "dist", "esm", "cli", "codegen_templates");
const importTemplate = (name) => import(pathToFileURL(path.join(templates, name)).href);
const { apiCodegen } = await importTemplate("api.js");
const { header } = await importTemplate("common.js");
const { serverCodegen } = await importTemplate("server.js");
const { tsconfigCodegen } = await importTemplate("tsconfig.js");

// Declarations of convex 1.50.0 `dynamicDataModelDTS()`, the default
// schema-backed `_generated/dataModel.d.ts`. Its template module cannot be
// imported on its own because it loads CLI-only dependencies.
const DATA_MODEL_DTS = `${header("Generated data model types.")}
import type { DataModelFromSchemaDefinition, DocumentByName, TableNamesInDataModel, SystemTableNames } from "convex/server";
import type { GenericId } from "convex/values";
import schema from "../schema.js";

export type TableNames = TableNamesInDataModel<DataModel>;

export type Doc<TableName extends TableNames> = DocumentByName<DataModel, TableName>;

export type Id<TableName extends TableNames | SystemTableNames> = GenericId<TableName>;

export type DataModel = DataModelFromSchemaDefinition<typeof schema>;
`;

const SCHEMA = `import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  messages: defineTable({
    body: v.string(),
    author: v.optional(v.string()),
  }),
});
`;

const MESSAGES = `import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const list = query({
  args: {},
  handler: async (ctx) => await ctx.db.query("messages").collect(),
});

export const send = mutation({
  args: { body: v.string() },
  handler: async (ctx, { body }) => await ctx.db.insert("messages", { body }),
});
`;

const VALUES = `import { v } from "convex/values";
import { mutation } from "./_generated/server";

export const store = mutation({
  args: { payload: v.any() },
  handler: async (_ctx, { payload }) => typeof payload === "string",
});
`;

const LOCK = `${JSON.stringify(
  {
    name: "contract-cli-fixture",
    lockfileVersion: 3,
    requires: true,
    packages: { "": { name: "contract-cli-fixture" } },
  },
  null,
  2,
)}\n`;

const OUTPUT = "contracts/convex-contract.json";
const PROJECT = ["--project", "convex/tsconfig.json"];

const temporaryDirectories = [];
after(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * Creates an isolated repository whose `convex` import resolves to this
 * package's installed dependency through a `node_modules` link.
 */
function createProject(modules = { "messages.ts": MESSAGES }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "convex-contract-cli-")));
  temporaryDirectories.push(root);
  fs.mkdirSync(path.join(root, ".git"));
  fs.symlinkSync(path.join(repository, "node_modules"), path.join(root, "node_modules"), "junction");
  writeFile(root, "package.json", `${JSON.stringify({ name: "contract-cli-fixture", private: true, type: "module" }, null, 2)}\n`);
  writeFile(root, "package-lock.json", LOCK);
  writeFile(root, "convex/tsconfig.json", tsconfigCodegen());
  writeFile(root, "convex/schema.ts", SCHEMA);
  const server = serverCodegen({ useTypeScript: false, envVars: undefined });
  writeFile(root, "convex/_generated/server.d.ts", server.DTS);
  writeFile(root, "convex/_generated/server.js", server.JS);
  writeFile(root, "convex/_generated/dataModel.d.ts", DATA_MODEL_DTS);
  for (const [file, source] of Object.entries(modules)) writeModule(root, file, source);
  return root;
}

/** Writes a function module and regenerates `_generated/api` the way `convex codegen` does. */
function writeModule(root, file, source) {
  writeFile(root, `convex/${file}`, source);
  const modules = fs
    .readdirSync(path.join(root, "convex"))
    .filter((name) => name.endsWith(".ts") && name !== "schema.ts")
    .sort();
  const api = apiCodegen(modules);
  writeFile(root, "convex/_generated/api.d.ts", api.DTS);
  writeFile(root, "convex/_generated/api.js", api.JS);
}

function writeFile(root, file, contents) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function run(cwd, ...args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });
}

function exportContract(root, ...args) {
  const result = run(root, ...PROJECT, "--output", OUTPUT, ...args);
  assert.equal(result.status, 0, result.stderr);
  return fs.readFileSync(path.join(root, OUTPUT), "utf8");
}

function assertFailure(result, pattern) {
  assert.equal(result.status, 1, `expected failure, got stdout:\n${result.stdout}`);
  assert.match(result.stderr, pattern);
  assert.doesNotMatch(result.stderr, /^\s+at /m, "errors must not print stack traces");
}

describe("command line", () => {
  const cwd = os.tmpdir();

  test("--help prints usage and succeeds", () => {
    for (const flag of ["--help", "-h"]) {
      const result = run(cwd, flag);
      assert.equal(result.status, 0);
      assert.match(result.stdout, /^Usage: convex-contract-export --project <tsconfig> --output <file>/);
      assert.match(result.stdout, /--allow-dynamic <path>/);
      assert.equal(result.stderr, "");
    }
  });

  test("rejects invalid arguments without exporting", () => {
    const cases = [
      [[], /Missing required option --project/],
      [["--project", "convex/tsconfig.json"], /Missing required option --output/],
      [["--output", OUTPUT], /Missing required option --project/],
      [[...PROJECT, "--output", OUTPUT, "--bogus"], /--bogus/],
      [[...PROJECT, "--output", OUTPUT, "extra"], /extra/],
      [[...PROJECT, "--output"], /--output/],
      [[...PROJECT, "--output=", "--check"], /--output requires a non-empty value/],
      [[...PROJECT, ...PROJECT, "--output", OUTPUT], /--project may be given only once/],
      [[...PROJECT, "--output", OUTPUT, "--check=yes"], /--check/],
    ];
    for (const [args, pattern] of cases) {
      const result = run(cwd, ...args);
      assertFailure(result, pattern);
      assert.match(result.stderr, /--help for usage/);
      assert.equal(result.stdout, "");
    }
  });

  test("reports a missing project as a one-line error", () => {
    const root = createProject();
    const result = run(root, "--project", "missing/tsconfig.json", "--output", OUTPUT);
    assertFailure(result, /^convex-contract-export: /);
    assert.equal(fs.existsSync(path.join(root, OUTPUT)), false);
  });
});

describe("export", () => {
  test("writes a canonical, machine-independent contract", () => {
    const first = createProject();
    const text = exportContract(first);
    assert.equal(text, canonicalJSON(JSON.parse(text)));
    assert.deepEqual(fs.readdirSync(path.join(first, "contracts")), ["convex-contract.json"]);

    const contract = JSON.parse(text);
    assert.equal(contract.formatVersion, 1);
    assert.equal(contract.provenance.exporterVersion, "0.1.0");
    assert.equal(contract.provenance.convexVersion, "1.50.0");
    assert.equal(contract.provenance.typescriptVersion, "5.9.3");
    assert.match(contract.provenance.sourceHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(
      contract.functions.map((f) => [f.path, f.kind, f.source?.file]),
      [
        ["messages:list", "query", "convex/messages.ts"],
        ["messages:send", "mutation", "convex/messages.ts"],
      ],
    );
    assert.deepEqual(contract.tables.map((t) => t.name), ["messages"]);
    for (const location of [first, repository, os.tmpdir(), os.homedir()]) {
      assert.equal(text.includes(location), false, `contract contains ${location}`);
    }

    const second = createProject();
    assert.equal(exportContract(second), text, "identical sources in another directory must match");
    assert.equal(exportContract(second, "--root", "."), text, "explicit --root must match the default root");
  });

  test("does not rewrite an unchanged contract", () => {
    const root = createProject();
    exportContract(root);
    const output = path.join(root, OUTPUT);
    const past = new Date("2020-01-01T00:00:00Z");
    fs.utimesSync(output, past, past);
    const initial = fs.statSync(output);

    const result = run(root, ...PROJECT, "--output", OUTPUT);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /is unchanged/);
    const current = fs.statSync(output);
    assert.equal(current.ino, initial.ino);
    assert.equal(current.mtimeMs, initial.mtimeMs);
  });
});

describe("--check", () => {
  test("reports drift without writing", () => {
    const root = createProject();
    const output = path.join(root, OUTPUT);
    const original = exportContract(root);
    const check = () => run(root, ...PROJECT, "--output", OUTPUT, "--check");

    const upToDate = check();
    assert.equal(upToDate.status, 0, upToDate.stderr);
    assert.match(upToDate.stdout, /is up to date/);

    const missing = run(root, ...PROJECT, "--output", "contracts/absent.json", "--check");
    assertFailure(missing, /contracts\/absent\.json does not exist/);
    assert.equal(fs.existsSync(path.join(root, "contracts", "absent.json")), false);

    // A trailing comment changes the source hash without moving any function's source line.
    writeModule(root, "messages.ts", `${MESSAGES}// Comment.\n`);
    assertFailure(check(), /is out of date; run without --check/);
    assert.equal(fs.readFileSync(output, "utf8"), original);
    const commented = JSON.parse(exportContract(root));
    assert.notEqual(commented.provenance.sourceHash, JSON.parse(original).provenance.sourceHash);
    assert.deepEqual(commented.functions, JSON.parse(original).functions);

    writeModule(
      root,
      "messages.ts",
      `${MESSAGES}\nexport const count = query({\n  args: {},\n  handler: async (ctx) => (await ctx.db.query("messages").collect()).length,\n});\n`,
    );
    const beforeFunction = fs.readFileSync(output, "utf8");
    assertFailure(check(), /is out of date/);
    assert.equal(fs.readFileSync(output, "utf8"), beforeFunction);
    assert.ok(JSON.parse(exportContract(root)).functions.some((f) => f.path === "messages:count"));

    const beforeLock = fs.readFileSync(output, "utf8");
    writeFile(root, "package-lock.json", LOCK.replace('"lockfileVersion": 3', '"lockfileVersion": 2'));
    assertFailure(check(), /is out of date/);
    assert.equal(fs.readFileSync(output, "utf8"), beforeLock);
  });
});

describe("failures", () => {
  test("keep the previous contract when the backend does not type-check", () => {
    const root = createProject();
    const original = exportContract(root);
    writeModule(root, "messages.ts", `${MESSAGES}\nexport const broken: number = "not a number";\n`);

    assertFailure(run(root, ...PROJECT, "--output", OUTPUT), /convex\/messages\.ts:\d+: TS2322/);
    assert.equal(fs.readFileSync(path.join(root, OUTPUT), "utf8"), original);
    assert.deepEqual(fs.readdirSync(path.join(root, "contracts")), ["convex-contract.json"]);
  });

  test(
    "keep the previous contract when the replacement cannot be written",
    { skip: process.platform === "win32" || process.getuid?.() === 0 },
    (t) => {
      const root = createProject();
      const original = exportContract(root);
      writeModule(root, "messages.ts", `${MESSAGES}// Comment.\n`);
      const contracts = path.join(root, "contracts");
      fs.chmodSync(contracts, 0o555);
      t.after(() => fs.chmodSync(contracts, 0o755));

      assertFailure(run(root, ...PROJECT, "--output", OUTPUT), /EACCES/);
      assert.equal(fs.readFileSync(path.join(root, OUTPUT), "utf8"), original);
      assert.deepEqual(fs.readdirSync(contracts), ["convex-contract.json"]);
    },
  );
});

describe("--allow-dynamic", () => {
  const position = "functions/values:store/arguments/payload";

  test("rejects an unopted any and accepts its exact path", () => {
    const root = createProject({ "messages.ts": MESSAGES, "values.ts": VALUES });

    assertFailure(run(root, ...PROJECT, "--output", OUTPUT), /values:store/);
    assert.equal(fs.existsSync(path.join(root, OUTPUT)), false);

    const contract = JSON.parse(exportContract(root, "--allow-dynamic", position));
    const store = contract.functions.find((f) => f.path === "values:store");
    assert.equal(store.typeSource, "dynamic");
    assert.deepEqual(store.arguments.fields, [{ name: "payload", optional: false, type: { kind: "dynamic" } }]);
  });

  test("rejects an opt-in that matches no dynamic position", () => {
    const root = createProject();
    const result = run(root, ...PROJECT, "--output", OUTPUT, "--allow-dynamic", "functions/messages:list/result");
    assertFailure(result, /functions\/messages:list\/result/);
    assert.equal(fs.existsSync(path.join(root, OUTPUT)), false);
  });
});
