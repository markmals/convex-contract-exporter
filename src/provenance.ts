import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type ts from "typescript";
import { canonicalJSON, compareText } from "./canonical.js";
import type { ExportOptions } from "./contract.js";

export const EXPORTER_VERSION = "0.1.0";

/** Synthetic module the exporter compiles beside the project configuration. */
export const PROBE_FILE_NAME = ".convex-contract-probe.ts";

const LOCK_FILE_NAMES = [
  "bun.lock",
  "bun.lockb",
  "deno.lock",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
];
const BINARY_LOCK_FILE_NAMES = new Set(["bun.lockb"]);

// Versioned so a change to what the digest covers can never collide with an older scheme.
const HASH_SCHEME = "convex-contract-source-hash/1";

/**
 * SHA-256 digest over the program's source and declaration text, the project
 * configuration files, normalized compiler and exporter options, and dependency
 * lock files from the project directory up to `root`.
 *
 * Every input is keyed by a machine-independent identity: a `/`-separated path
 * relative to `root`, or `node_modules/<package>/<file>` for installed
 * packages. Inputs without such an identity, or two inputs sharing one, fail.
 */
export function sourceHash(
  program: ts.Program,
  root: string,
  options: ExportOptions,
  extraFiles: string[],
): string {
  const rootPath = realPath(root);
  const project = realPath(options.project);
  const projectDirectory = path.dirname(project);
  if (!isWithin(rootPath, projectDirectory)) {
    throw new Error(`Project ${options.project} is outside the root ${root}.`);
  }
  const probe = path.join(projectDirectory, PROBE_FILE_NAME);

  const sources = new StableDigests(rootPath, "Source file");
  for (const sourceFile of program.getSourceFiles()) {
    const file = realPath(sourceFile.fileName);
    if (file === probe) continue;
    sources.add(file, normalizeText(sourceFile.text));
  }

  const configurations = new StableDigests(rootPath, "Configuration file");
  for (const extraFile of extraFiles) {
    const file = realPath(extraFile);
    // Configuration discovery may record probed candidates that do not exist.
    const contents = readFileIfPresent(file);
    if (contents !== undefined) configurations.add(file, normalizeText(contents.toString("utf8")));
  }

  const locks = new StableDigests(rootPath, "Lock file");
  for (let directory = projectDirectory; ; directory = path.dirname(directory)) {
    for (const name of LOCK_FILE_NAMES) {
      const file = path.join(directory, name);
      const contents = readFileIfPresent(file);
      if (contents === undefined) continue;
      locks.add(
        file,
        BINARY_LOCK_FILE_NAMES.has(name) ? contents : normalizeText(contents.toString("utf8")),
      );
    }
    if (directory === rootPath) break;
  }

  const payload = {
    scheme: HASH_SCHEME,
    compilerOptions: normalizeCompilerOptions(program.getCompilerOptions(), rootPath),
    exporterOptions: {
      project: stableIdentity(project, rootPath, "Project"),
      allowDynamic: [...(options.allowDynamic ?? [])].sort(compareText),
    },
    sources: sources.entries(),
    configurations: configurations.entries(),
    locks: locks.entries(),
  };
  return createHash("sha256").update(canonicalJSON(payload)).digest("hex");
}

class StableDigests {
  private readonly digests = new Map<string, { file: string; digest: string }>();

  constructor(
    private readonly rootPath: string,
    private readonly description: string,
  ) {}

  add(file: string, contents: string | Buffer): void {
    const identity = stableIdentity(file, this.rootPath, this.description);
    const existing = this.digests.get(identity);
    if (existing !== undefined) {
      if (existing.file === file) return;
      throw new Error(
        `${this.description}s ${existing.file} and ${file} share the stable identity ${identity}; ` +
          "deduplicate the installed packages so the source hash is unambiguous.",
      );
    }
    this.digests.set(identity, { file, digest: createHash("sha256").update(contents).digest("hex") });
  }

  entries(): [string, string][] {
    return [...this.digests]
      .map(([identity, { digest }]): [string, string] => [identity, digest])
      .sort(([a], [b]) => compareText(a, b));
  }
}

/**
 * Installed package files are keyed below their innermost `node_modules`
 * directory so hoisted, nested, and store layouts agree. Other files must be
 * inside the root.
 */
function stableIdentity(file: string, rootPath: string, description: string): string {
  const segments = file.split(/[\\/]+/);
  const packages = segments.lastIndexOf("node_modules");
  if (packages !== -1) {
    return ["node_modules", ...segments.slice(packages + 1)].filter((s) => s !== "").join("/");
  }
  if (!isWithin(rootPath, file)) {
    throw new Error(
      `${description} ${file} is outside the root ${rootPath}; pass --root to include it.`,
    );
  }
  return path.relative(rootPath, file).split(path.sep).join("/") || ".";
}

function normalizeCompilerOptions(
  options: ts.CompilerOptions,
  rootPath: string,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(options)) {
    // The parsed configuration syntax tree; its file text is hashed with the configurations.
    if (name === "configFile") continue;
    normalized[name] = normalizeOptionValue(value, name, rootPath);
  }
  return normalized;
}

function normalizeOptionValue(value: unknown, name: string, rootPath: string): unknown {
  if (typeof value === "string") {
    return path.isAbsolute(value)
      ? stableIdentity(realPath(value), rootPath, `Compiler option ${name} path`)
      : value;
  }
  if (Array.isArray(value)) {
    return value.map((element) => normalizeOptionValue(element, name, rootPath));
  }
  if (value !== null && typeof value === "object") {
    const normalized: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      normalized[key] = normalizeOptionValue(entry, name, rootPath);
    }
    return normalized;
  }
  return value;
}

// Checkouts may differ only in byte-order marks and line endings, which leave TypeScript semantics unchanged.
function normalizeText(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

/** Resolves symlinks; a missing file, such as the in-memory probe, resolves through its directory. */
function realPath(file: string): string {
  const absolute = path.resolve(file);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    const parent = path.dirname(absolute);
    return parent === absolute ? absolute : path.join(realPath(parent), path.basename(absolute));
  }
}

function isWithin(directory: string, file: string): boolean {
  const relative = path.relative(directory, file);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function readFileIfPresent(file: string): Buffer | undefined {
  try {
    return fs.readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
