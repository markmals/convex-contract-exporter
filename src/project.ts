import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { ExportOptions } from "./contract.js";

export const TYPESCRIPT_VERSION = "5.9.3";
export const CONVEX_VERSION = "1.50.0";

export function repositoryRoot(project: string): string {
  let directory = path.dirname(project);
  let packageRoot: string | undefined;
  for (;;) {
    if (fs.existsSync(path.join(directory, ".git"))) return directory;
    if (!packageRoot && fs.existsSync(path.join(directory, "package.json"))) packageRoot = directory;
    const parent = path.dirname(directory);
    if (directory === parent) {
      if (packageRoot) return packageRoot;
      throw new Error("No repository or package.json above project; pass --root");
    }
    directory = parent;
  }
}

export function loadProject(options: ExportOptions) {
  if (ts.version !== TYPESCRIPT_VERSION) {
    throw new Error(`Unsupported TypeScript ${ts.version}; exporter requires ${TYPESCRIPT_VERSION}`);
  }
  const project = path.resolve(options.project);
  const root = path.resolve(options.root ?? repositoryRoot(project));
  const directory = path.dirname(project);
  const configFiles = new Set<string>();
  const readFile = (file: string) => {
    if (file.endsWith(".json")) configFiles.add(path.resolve(file));
    return ts.sys.readFile(file);
  };
  const config = ts.readConfigFile(project, readFile);
  if (config.error) throwDiagnostics([config.error], root);
  const parsed = ts.parseJsonConfigFileContent(config.config, { ...ts.sys, readFile }, directory, undefined, project);
  throwDiagnostics(parsed.errors, root);
  if (!(parsed.options.strictNullChecks ?? parsed.options.strict)) {
    throw new Error(`${relative(root, project)}: strictNullChecks must be enabled to preserve null and omission`);
  }
  const compilerOptions = { ...parsed.options, noEmit: true, skipLibCheck: false };
  const probePath = path.join(directory, ".convex-contract-probe.ts");
  if (fs.existsSync(probePath)) throw new Error(`${relative(root, probePath)}: reserved semantic probe path already exists`);
  const resolvedConvex = ts.resolveModuleName("convex/server", probePath, compilerOptions, ts.sys).resolvedModule;
  if (!resolvedConvex) throw new Error(`${relative(root, project)}: cannot resolve convex/server`);
  const convexPackage = findPackage(resolvedConvex.resolvedFileName, "convex");
  if (convexPackage.version !== CONVEX_VERSION) {
    throw new Error(`Unsupported Convex ${convexPackage.version}; exporter requires ${CONVEX_VERSION}`);
  }
  let previous: ts.Program | undefined;
  const build = (probe: string) => {
    const host = ts.createCompilerHost(compilerOptions);
    const originalGetSource = host.getSourceFile.bind(host);
    const originalRead = host.readFile.bind(host);
    const originalExists = host.fileExists.bind(host);
    host.getSourceFile = (file, languageVersion, onError, shouldCreate) => path.resolve(file) === probePath
      ? ts.createSourceFile(file, probe, languageVersion, true)
      : previous?.getSourceFile(file) ?? originalGetSource(file, languageVersion, onError, shouldCreate);
    host.readFile = file => path.resolve(file) === probePath ? probe : originalRead(file);
    host.fileExists = file => path.resolve(file) === probePath || originalExists(file);
    const program = ts.createProgram({ rootNames: [...parsed.fileNames, probePath], options: compilerOptions, host, projectReferences: parsed.projectReferences, oldProgram: previous });
    throwDiagnostics(ts.getPreEmitDiagnostics(program), root);
    previous = program;
    return program;
  };
  return { project, root, directory, probePath, configFiles: [...configFiles], build };
}

function findPackage(file: string, expected: string): { version: string } {
  let directory = path.dirname(file);
  for (;;) {
    const manifest = path.join(directory, "package.json");
    if (fs.existsSync(manifest)) {
      const contents = JSON.parse(fs.readFileSync(manifest, "utf8"));
      if (contents.name === expected) return contents;
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`Cannot locate ${expected} package for ${file}`);
    directory = parent;
  }
}

export function relative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

export function throwDiagnostics(diagnostics: readonly ts.Diagnostic[], root: string): void {
  const errors = diagnostics.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
  if (!errors.length) return;
  throw new Error(errors.map(diagnostic => {
    const location = diagnostic.file && diagnostic.start !== undefined
      ? `${relative(root, diagnostic.file.fileName)}:${diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1}`
      : "TypeScript";
    return `${location}: TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`;
  }).join("\n"));
}
