# convex-contract-exporter

`convex-contract-export` derives a Convex contract from a Convex backend's TypeScript sources. The contract uses format version 1, which is specified in `guides/contract-format.md` of [swift-convex](https://github.com/markmals/swift-convex). A contract lists the backend's public functions, table documents, and value shapes, so generators for other languages (such as the Swift generator in `swift-convex`) can consume them without TypeScript.

The exporter reads the backend with the TypeScript compiler's semantic API. It does not import or run backend modules, start Convex, contact a deployment, or need a deploy key.

## Compatibility

Each release supports exact versions; it does not claim that later releases work.

| Component | Version |
| --- | --- |
| Exporter (`provenance.exporterVersion`) | `0.1.0` |
| TypeScript compiler | `5.9.3` |
| `convex` package | `1.50.0` |
| Node.js | `>=22` |

TypeScript is a regular dependency of the exporter, which compiles your backend with that copy. The `typescript` package your backend uses for its own builds and editors is irrelevant. The exporter fails when its compiler is not 5.9.3, or when the `convex` package that `convex/server` resolves to from your project directory is not 1.50.0.

## Installation

Add the exporter to the backend repository as a development dependency, pinned to a commit:

```sh
npm install --save-dev "git+https://github.com/markmals/convex-contract-exporter.git#<commit>"
```

Replace `<commit>` with a full commit SHA from this repository. The package is distributed from public GitHub over HTTPS without authentication; it is not published to the npm registry. For Git dependencies with a `prepare` script, npm installs the package's own dependencies and runs `prepare`, which builds `dist/`. The backend itself must depend on `convex` 1.50.0, which is a peer dependency of the exporter.

## Usage

```sh
npx convex-contract-export --project convex/tsconfig.json --output contracts/convex-contract.json
npx convex-contract-export --project convex/tsconfig.json --output contracts/convex-contract.json --check
```

| Option | Meaning |
| --- | --- |
| `--project <path>` | Required. The TypeScript configuration of the Convex functions directory, usually `convex/tsconfig.json`. |
| `--output <path>` | Required. The contract file to write, or to compare with `--check`. |
| `--check` | Compare instead of writing. Exits 1 if the file is missing or differs. Never modifies files. |
| `--root <dir>` | The repository root that relative paths and the source hash use. By default, this is the closest ancestor of the project configuration that contains `.git`, or, if there is none, the closest one that contains `package.json`. |
| `--allow-dynamic <path>` | Accept an `any` or `unknown` type at this exact contract path. Repeatable. See [Dynamic positions](#dynamic-positions). |
| `-h`, `--help` | Print usage. |

The command exits 0 after writing the contract, after finding it unchanged, or after a passing check. It exits 1 on invalid arguments, export errors, and drift. Errors are printed to standard error as messages, without stack traces.

Contracts are written as JSON with two-space indentation, keys sorted by UTF-16 code unit, and a trailing newline. The exporter sorts functions, tables, named types, fields, and union variants; other arrays keep their order. Writing goes to a temporary file in the output directory, which is then renamed over the output. If an export fails, the previous contract remains as it was and the temporary file is removed. An unchanged contract is not rewritten, so its modification time stays the same. `--check` passes only when the existing file matches the new contract byte for byte.

Contracts contain schema and API metadata. Review a contract before publishing it.

## What the exporter reads

Run Convex code generation (`npx convex dev` or `npx convex codegen`) before exporting. The exporter reads `convex/_generated` but does not regenerate it.

1. It parses the project configuration, including `extends` chains, and requires `strictNullChecks` (directly or through `strict`).
2. It compiles the project with `noEmit` and `skipLibCheck: false`. Any TypeScript error, including errors in dependency declarations, fails the export before extraction begins.
3. It resolves the generated `api` object and `DataModel` type. For each public function, it instantiates Convex's `FunctionArgs` and `FunctionReturnType` helpers, and translates the resulting types into contract shapes.

Internal functions and functions exposed by components are omitted. HTTP actions are not part of `api` and are not exported. Function `source` locations are repository-relative.

### Source-linked and static APIs

By default, Convex generates an `api.d.ts` that imports each function module (`import type * as messages from "../messages.js"`). That API is *source-linked*: TypeScript infers each function's result from its handler, even when the function has no `returns` validator. Those functions have `typeSource: "inferred"`.

With `"codegen": { "staticApi": true }` in `convex.json`, Convex generates self-contained declarations from argument and return validators. Those functions have `typeSource: "validator"`. A static API declares results without a `returns` validator as `any`, and arguments without an `args` validator as `any`. The exporter rejects them because the type was erased. To fix this, add validators, return to source-linked code generation, or (for a result) explicitly accept the dynamic position.

In both forms, `any`, `unknown`, and `v.any()` fail unless their exact path is passed to `--allow-dynamic`. A function's `typeSource` is `dynamic` when its arguments or result contain an accepted dynamic position, including through named types.

### Dynamic positions

An export error names the source location and the exact contract path of the failing type. Pass that path to `--allow-dynamic` to export the position as `{"kind":"dynamic"}`. Generated clients then represent it as a general Convex value instead of a static type.

```sh
npx convex-contract-export --project convex/tsconfig.json --output contracts/convex-contract.json \
  --allow-dynamic functions/messages:send/arguments/body \
  --allow-dynamic functions/messages:list/result \
  --allow-dynamic tables/messages/document/metadata
```

Paths start with one of these prefixes:

- `functions/<function>/arguments/<field>`, where `<function>` is the Convex function path as written, such as `messages:send` or `admin/users:list`. The arguments object as a whole cannot be dynamic.
- `functions/<function>/result`
- `tables/<table>/document`
- `tables`, for a schema-less data model. This exports `"tables": []` and a dynamic `dataModel` type instead of inventing table names. Without it, a schema-less data model fails.

Nested segments follow: `/<field>` for object fields (escaped as in JSON Pointer, with `~0` for `~` and `~1` for `/`), `/element` for arrays, `/elements/<index>` for tuples, `/key` and `/value` for records, and `/variants/<index>` for union members. Copy the path from the export error instead of deriving union indices yourself. The export fails if an `--allow-dynamic` path does not match a dynamic type exactly, or if the same path is given twice.

### Commit timestamps

The exporter recognizes Convex's `CommitTsPlaceholder` class from `convex/values` by its declaration, not by its name. `v.commitTs()` validates `bigint | CommitTsPlaceholder`, and `db.vars.commitTs` is the placeholder. Both arguments and results export it as `{"kind":"int64","semantic":"commitTimestamp"}`. The placeholder exists only inside a mutation and resolves to an int64 when the transaction commits. The contract format has no placeholder value, so clients send and receive only resolved integers.

### Unsupported types

These types fail with their contract path and source location:

- Recursive shapes.
- Functions, constructors, class instances, and non-wire built-in objects such as `Date` and `Map`.
- `undefined`, except at a result's root or as an omitted optional property.
- Symbol keys, template literal key types, and objects that mix index signatures with named fields.
- Record keys other than strings, document IDs, and string literals.
- Tuples with optional or rest elements.
- Intersections that are not a concrete object or document ID.
- Unions with overlapping variants. Add a required literal discriminant to separate them.
- Unresolved generics, conditional types, and indexed access types.
- `bigint` literals outside the signed 64-bit range.

## Source hash

`provenance.sourceHash` is a SHA-256 digest that changes whenever an input that can affect the contract changes. It covers these inputs:

- The text of every source and declaration file in the compiled program, including generated files, the declarations of `convex` and other packages, and the compiler's default library files. The exporter's internal probe module (`.convex-contract-probe.ts`) is excluded.
- The configuration files that were read while parsing the project, such as `tsconfig.json` files and their `extends` chain.
- The compiler options used for the export, including the overrides listed above.
- The exporter's options: the project path and the sorted `--allow-dynamic` list. The output path and `--check` are not included.
- Every lock file (`package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock`, `bun.lockb`, `deno.lock`) in the project directory and its ancestors, up to and including the root.

Each input is identified by a path that does not depend on the machine:

- Files inside the root use `/`-separated paths relative to the root.
- Installed package files use `node_modules/<package>/<file>`, relative to the innermost `node_modules` directory. Hoisted, nested, and pnpm layouts of the same package therefore produce the same identity.
- Absolute paths in compiler options use the same identities.
- Files outside the root that are not in a `node_modules` directory fail the export. Pass `--root` to include them.
- Two different files with the same identity, such as two installed copies of one package, fail the export.

The hash ignores byte-order marks and line-ending differences. It does not cover timestamps, environment variables, credentials, deployment URLs or keys, absolute paths, or the Node.js version. The exporter, TypeScript, and Convex versions are recorded in their own provenance fields.

## Development

```sh
npm install                # also builds dist/ through the prepare script
npm run build              # compile src/ to dist/
npm test                   # run test/*.test.mjs against the built dist/
npm run fixture:export     # export fixtures/backend to fixtures/backend/contract.json
npm run fixture:check      # check fixtures/backend/contract.json for drift
```

`npm test` does not build first, so run `npm run build` after changing `src/`. The CLI tests create isolated temporary repositories, link this package's `node_modules` so that `convex` resolves to the installed 1.50.0, generate their `_generated` files with the installed Convex code generation templates, and run the built `dist/cli.js`.

`fixtures/backend` is a representative Convex backend with committed generated files. Its contract is checked in, and `npm run fixture:check` reports when the backend or the exporter changes it.

## Disposable integration backend

The fixture runs against the official self-hosted `convex-local-backend` binary pinned to `precompiled-2026-11-16-80befbc` (commit `80befbc1152f13077236bfc09284d887c478dfa5`). `scripts/local-backend.mjs` verifies the release asset's SHA-256 before starting it on loopback with telemetry disabled. The initial download requires network access, Node 22+, `unzip`, and `ps`; macOS and Linux arm64/x64 assets are supported.

```sh
npm ci
npm run fixture:backend:up
node scripts/local-backend.mjs status
node scripts/local-backend.mjs convex run health:check
npm run fixture:export
npm run fixture:backend:down
```

`up` starts the backend on port 3290 by default, runs official Convex codegen, typechecks the fixture with the pinned TypeScript compiler, and deploys it. Pass `-- --port 4290` to select a port; HTTP actions use the next port. Re-running `up` redeploys. `down` retains data. `node scripts/local-backend.mjs reset` deletes the local database and generated secrets.

The fixture includes live message subscriptions, channel and message mutations, actions, document and storage IDs, discriminated unions, required-nullable and optional fields, pagination, fixed tuples, bytes, signed Int64 limits, nonfinite Float64 values, and commit timestamps. `values:echo` and `actions:echo` round-trip caller-supplied values; `values:special` supplies edge values without arguments. `errors:check` exercises application and server failures. Internal functions and HTTP actions are excluded from the exported client contract.

The launcher generates the instance secret, admin key, and RSA signing key under ignored `fixtures/backend/.convex/local-backend/` (directory mode 0700, secret files mode 0600). `live.json` contains connection details for trusted local integration runners. Never commit or print that file. `auth:whoami` accepts test JWTs from `node scripts/local-backend.mjs token`; redirect that command's output into your test process or an ignored private file instead of logging it. These tokens and keys are disposable local credentials, not production authentication.

## License

Project-owned code is available under the [MIT License](LICENSE), copyright 2026 Mark Malstrom. Dependencies retain their own licenses.
