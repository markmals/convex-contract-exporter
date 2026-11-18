#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { canonicalJSON } from "./canonical.js";
import type { ExportOptions } from "./contract.js";
import { exportContract } from "./exporter.js";
import { CONVEX_VERSION, TYPESCRIPT_VERSION } from "./project.js";
import { EXPORTER_VERSION } from "./provenance.js";

const COMMAND = "convex-contract-export";

const USAGE = `Usage: ${COMMAND} --project <tsconfig> --output <file> [options]

Derives a Convex contract (format version 1) from a backend's TypeScript
declarations without executing backend code or contacting a deployment.

Options:
  --project <path>        TypeScript configuration of the Convex functions
                          directory, such as convex/tsconfig.json.
  --output <path>         Contract file to write, or to compare with --check.
  --check                 Compare with the existing file instead of writing it;
                          exit 1 if it is missing or differs.
  --root <dir>            Repository root for relative paths and the source
                          hash. Defaults to the nearest ancestor of the project
                          containing .git, else the nearest containing
                          package.json.
  --allow-dynamic <path>  Accept an any/unknown value at this exact contract
                          path, such as functions/messages:send/arguments/body,
                          and export it as dynamic. Repeatable.
  -h, --help              Show this help.

Exporter ${EXPORTER_VERSION} requires TypeScript ${TYPESCRIPT_VERSION} (bundled) and convex ${CONVEX_VERSION}.
`;

class UsageError extends Error {}

type Command =
  | { help: true }
  | { help: false; project: string; output: string; check: boolean; root?: string; allowDynamic: string[] };

function parseCommand(argv: string[]): Command {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        project: { type: "string" },
        output: { type: "string" },
        check: { type: "boolean" },
        root: { type: "string" },
        "allow-dynamic": { type: "string", multiple: true },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
      tokens: true,
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { values, tokens } = parsed;
  if (values.help) return { help: true };

  const seen = new Set<string>();
  for (const token of tokens ?? []) {
    if (token.kind !== "option" || token.name === "allow-dynamic") continue;
    if (seen.has(token.name)) throw new UsageError(`--${token.name} may be given only once.`);
    seen.add(token.name);
  }
  const allowDynamic = values["allow-dynamic"] ?? [];
  for (const name of ["project", "output", "root"] as const) {
    if (values[name] === "") throw new UsageError(`--${name} requires a non-empty value.`);
  }
  if (allowDynamic.includes("")) throw new UsageError("--allow-dynamic requires a non-empty value.");
  if (values.project === undefined) throw new UsageError("Missing required option --project.");
  if (values.output === undefined) throw new UsageError("Missing required option --output.");

  return {
    help: false,
    project: values.project,
    output: values.output,
    check: values.check ?? false,
    ...(values.root === undefined ? {} : { root: values.root }),
    allowDynamic,
  };
}

async function main(argv: string[]): Promise<number> {
  const command = parseCommand(argv);
  if (command.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const options: ExportOptions = {
    project: path.resolve(command.project),
    allowDynamic: command.allowDynamic,
  };
  if (command.root !== undefined) options.root = path.resolve(command.root);
  const contents = Buffer.from(canonicalJSON(await exportContract(options)), "utf8");

  const output = path.resolve(command.output);
  const displayed = path.relative(process.cwd(), output) || output;
  const existing = readExisting(output);
  if (command.check) {
    if (existing?.contents.equals(contents)) {
      process.stdout.write(`${displayed} is up to date.\n`);
      return 0;
    }
    process.stderr.write(
      `${COMMAND}: ${displayed} ${existing === undefined ? "does not exist" : "is out of date"}; ` +
        "run without --check to update it.\n",
    );
    return 1;
  }
  if (existing?.contents.equals(contents)) {
    process.stdout.write(`${displayed} is unchanged.\n`);
    return 0;
  }
  writeAtomically(output, contents, existing?.mode);
  process.stdout.write(`Wrote ${displayed}.\n`);
  return 0;
}

function readExisting(file: string): { contents: Buffer; mode: number } | undefined {
  let contents: Buffer;
  try {
    contents = fs.readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return { contents, mode: fs.statSync(file).mode & 0o7777 };
}

/**
 * Writes a sibling temporary file and renames it over `file`, so readers see
 * either the previous complete artifact or the new one, never a partial write.
 */
function writeAtomically(file: string, contents: Buffer, mode: number | undefined): void {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, "wx");
    if (mode !== undefined) fs.fchmodSync(descriptor, mode);
    fs.writeFileSync(descriptor, contents);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
  } catch (error) {
    try {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    throw error;
  }
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause === undefined ? error.message : `${error.message}\n  caused by: ${describe(error.cause)}`;
}

main(process.argv.slice(2)).then(
  (status) => {
    process.exitCode = status;
  },
  (error: unknown) => {
    process.stderr.write(`${COMMAND}: ${describe(error)}\n`);
    if (error instanceof UsageError) process.stderr.write(`Run ${COMMAND} --help for usage.\n`);
    process.exitCode = 1;
  },
);
