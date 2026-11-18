#!/usr/bin/env node
// Runs a disposable self-hosted Convex backend for fixtures/backend.
//
//   node scripts/local-backend.mjs up [--port <n>]
//       Download and verify the pinned backend binary, start it on
//       127.0.0.1:<n> (HTTP actions on <n>+1), regenerate convex/_generated
//       with the official Convex CLI, typecheck, and push the fixture.
//   node scripts/local-backend.mjs down       Stop the backend; keep its data.
//   node scripts/local-backend.mjs status     Print the URLs if it is running.
//   node scripts/local-backend.mjs token [--subject <s>] [--name <n>]
//       [--email <e>] [--ttl <seconds>]       Print a JWT for the fixture auth.
//   node scripts/local-backend.mjs convex <args...>
//       Run the Convex CLI against the backend, e.g. `convex run health:check`.
//   node scripts/local-backend.mjs reset      Stop and delete data and secrets.
//
// State lives in fixtures/backend/.convex/local-backend/, which git ignores.
// The instance secret, admin key, and JWT signing key are generated on first
// start; secrets.json and live.json (URL plus admin key) are mode 0600.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// Pinned from https://version.convex.dev/v1/local_backend_version, the source
// the Convex CLI uses. Digests come from the GitHub release API.
const BACKEND = {
  version: "precompiled-2026-11-16-80befbc",
  commit: "80befbc1152f13077236bfc09284d887c478dfa5",
  repository: "https://github.com/convex/convex-backend",
  assets: {
    "darwin-arm64": {
      name: "convex-local-backend-aarch64-apple-darwin.zip",
      sha256: "9e551167c421e03e4bb4aac089b353d44adb9eeb80916a6ec1ef82d0f2eb254d",
    },
    "darwin-x64": {
      name: "convex-local-backend-x86_64-apple-darwin.zip",
      sha256: "0be66ee269729afd0c69ea87934b3080b516184ef40caf469fedfb982ff88c4e",
    },
    "linux-arm64": {
      name: "convex-local-backend-aarch64-unknown-linux-gnu.zip",
      sha256: "06c3a8b70d23f8915ce97be646a6de690c6cac8727089387cecb1a1e8bac5262",
    },
    "linux-x64": {
      name: "convex-local-backend-x86_64-unknown-linux-gnu.zip",
      sha256: "65230f5e8583c7c7f13cdf5854b140187c153c71bbc32276d60d75658214ab9e",
    },
  },
};
const INSTANCE_NAME = "convex-contract-fixture";
// Must match fixtures/backend/convex/auth.config.ts.
const AUTH = {
  issuer: "https://fixture.convex-contract-exporter.invalid",
  applicationID: "convex-contract-fixture",
  jwksVariable: "FIXTURE_JWKS",
};
const DEFAULT_PORT = 3290;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = join(repoRoot, "fixtures", "backend");
const stateDir = join(fixtureDir, ".convex", "local-backend");
const paths = {
  binary: join(stateDir, "bin", BACKEND.version, "convex-local-backend"),
  data: join(stateDir, "data"),
  secrets: join(stateDir, "secrets.json"),
  live: join(stateDir, "live.json"),
  log: join(stateDir, "backend.log"),
};
const require = createRequire(import.meta.url);
const convexCli = join(
  dirname(require.resolve("convex/package.json")),
  "bin",
  "main.js",
);
// The Convex CLI only looks for `node_modules/typescript` in the project
// directory, but the fixture resolves its dependencies from the repository.
const tsc = join(
  dirname(require.resolve("typescript/package.json")),
  "bin",
  "tsc",
);

function fail(message) {
  console.error(`local-backend: ${message}`);
  process.exit(1);
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

function writePrivateJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, path);
}

async function ensureBinary() {
  if (existsSync(paths.binary)) {
    return;
  }
  const asset = BACKEND.assets[`${process.platform}-${process.arch}`];
  if (asset === undefined) {
    fail(`no pinned backend for ${process.platform}-${process.arch}`);
  }
  const url = `${BACKEND.repository}/releases/download/${BACKEND.version}/${asset.name}`;
  console.error(`Downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    fail(`downloading ${url} failed with HTTP ${response.status}`);
  }
  const archive = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(archive).digest("hex");
  if (digest !== asset.sha256) {
    fail(`${asset.name} has SHA-256 ${digest}, expected ${asset.sha256}`);
  }
  const directory = dirname(paths.binary);
  const staging = `${directory}.partial`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const archivePath = join(staging, asset.name);
  writeFileSync(archivePath, archive);
  execFileSync("unzip", ["-q", archivePath, "-d", staging]);
  rmSync(archivePath);
  chmodSync(join(staging, "convex-local-backend"), 0o755);
  rmSync(directory, { recursive: true, force: true });
  renameSync(staging, directory);
}

function ensureSecrets() {
  const existing = readJson(paths.secrets);
  if (existing !== null) {
    return existing;
  }
  const instanceSecret = randomBytes(32).toString("hex");
  const adminKey = execFileSync(
    paths.binary,
    [
      "keygen",
      "admin-key",
      "--instance-name",
      INSTANCE_NAME,
      "--instance-secret",
      instanceSecret,
    ],
    { encoding: "utf8" },
  ).trim();
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const kid = randomBytes(8).toString("hex");
  const secrets = {
    instanceName: INSTANCE_NAME,
    instanceSecret,
    adminKey,
    jwt: {
      kid,
      privateKey: privateKey.export({ format: "pem", type: "pkcs8" }),
      jwks: {
        keys: [
          {
            ...publicKey.export({ format: "jwk" }),
            kid,
            alg: "RS256",
            use: "sig",
          },
        ],
      },
    },
  };
  writePrivateJson(paths.secrets, secrets);
  return secrets;
}

function isBackendProcess(pid) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
  });
  return result.status === 0 && result.stdout.includes(paths.binary);
}

async function respondsAsInstance(url) {
  try {
    const response = await fetch(`${url}/instance_name`);
    return response.ok && (await response.text()) === INSTANCE_NAME;
  } catch {
    return false;
  }
}

async function runningBackend() {
  const live = readJson(paths.live);
  if (live === null || !isBackendProcess(live.pid)) {
    return null;
  }
  return (await respondsAsInstance(live.url)) ? live : null;
}

function portIsFree(port, host) {
  return new Promise((done) => {
    const server = createServer();
    server.once("error", () => done(false));
    server.listen(port, host, () => server.close(() => done(true)));
  });
}

async function portPairIsFree(port) {
  for (const candidate of [port, port + 1]) {
    for (const host of ["127.0.0.1", "0.0.0.0"]) {
      if (!(await portIsFree(candidate, host))) {
        return false;
      }
    }
  }
  return true;
}

async function choosePort(requested, previous) {
  if (requested !== undefined) {
    if (!(await portPairIsFree(requested))) {
      fail(`ports ${requested} and ${requested + 1} are not both free`);
    }
    return requested;
  }
  for (let port = previous ?? DEFAULT_PORT; port < 65535; port += 2) {
    if (await portPairIsFree(port)) {
      return port;
    }
  }
  fail("no free port pair found");
}

async function startBackend(port, secrets) {
  mkdirSync(paths.data, { recursive: true, mode: 0o700 });
  const log = openSync(paths.log, "a", 0o600);
  const child = spawn(
    paths.binary,
    [
      "--interface",
      "127.0.0.1",
      "--port",
      String(port),
      "--site-proxy-port",
      String(port + 1),
      "--instance-name",
      secrets.instanceName,
      "--instance-secret",
      secrets.instanceSecret,
      "--local-storage",
      join(paths.data, "storage"),
      "--disable-beacon",
      join(paths.data, "convex_local_backend.sqlite3"),
    ],
    { cwd: paths.data, detached: true, stdio: ["ignore", log, log] },
  );
  closeSync(log);
  let exit = null;
  child.once("exit", (code, signal) => {
    exit = signal ?? code;
  });
  child.unref();
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (exit !== null) {
      fail(`backend exited (${exit}) during startup; see ${paths.log}`);
    }
    if (await respondsAsInstance(url)) {
      return { pid: child.pid, port, url };
    }
    await sleep(500);
  }
  process.kill(-child.pid, "SIGTERM");
  fail(`backend did not become ready; see ${paths.log}`);
}

function runConvex(args, live) {
  const env = { ...process.env };
  for (const name of [
    "CONVEX_AGENT_MODE",
    "CONVEX_DEPLOYMENT",
    "CONVEX_DEPLOY_KEY",
    "CONVEX_SELF_HOSTED_ADMIN_KEY",
    "CONVEX_SELF_HOSTED_URL",
  ]) {
    delete env[name];
  }
  env.CONVEX_SELF_HOSTED_URL = live.url;
  env.CONVEX_SELF_HOSTED_ADMIN_KEY = live.adminKey;
  const result = spawnSync(process.execPath, [convexCli, ...args], {
    cwd: fixtureDir,
    env,
    stdio: "inherit",
  });
  return result.status ?? 1;
}

async function up(port) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  await ensureBinary();
  const secrets = ensureSecrets();
  let live = await runningBackend();
  if (live === null) {
    const previous = readJson(paths.live);
    const started = await startBackend(
      await choosePort(port, previous?.port),
      secrets,
    );
    const asset = BACKEND.assets[`${process.platform}-${process.arch}`];
    live = {
      url: started.url,
      siteUrl: `http://127.0.0.1:${started.port + 1}`,
      adminKey: secrets.adminKey,
      instanceName: secrets.instanceName,
      port: started.port,
      pid: started.pid,
      startedAt: new Date().toISOString(),
      backend: {
        version: BACKEND.version,
        commit: BACKEND.commit,
        release: `${BACKEND.repository}/releases/tag/${BACKEND.version}`,
        asset: asset.name,
        sha256: asset.sha256,
      },
      auth: {
        issuer: AUTH.issuer,
        applicationID: AUTH.applicationID,
        algorithm: "RS256",
        tokenCommand: "node scripts/local-backend.mjs token",
      },
      paths: { state: stateDir, log: paths.log },
    };
    writePrivateJson(paths.live, live);
  }
  const jwks = Buffer.from(JSON.stringify(secrets.jwt.jwks)).toString("base64");
  const jwksUri = `data:text/plain;charset=utf-8;base64,${jwks}`;
  if (runConvex(["env", "set", AUTH.jwksVariable, jwksUri], live) !== 0) {
    fail(`setting ${AUTH.jwksVariable} failed`);
  }
  if (runConvex(["codegen", "--typecheck", "disable"], live) !== 0) {
    fail("generating convex/_generated failed");
  }
  // The same check `convex deploy --typecheck enable` runs.
  const typecheck = spawnSync(
    process.execPath,
    [tsc, "--project", "convex"],
    { cwd: fixtureDir, stdio: "inherit" },
  );
  if (typecheck.status !== 0) {
    fail("typechecking the fixture failed");
  }
  const push = ["deploy", "--typecheck", "disable", "--codegen", "disable"];
  if (runConvex(push, live) !== 0) {
    fail("deploying the fixture failed");
  }
  console.log(`Fixture deployed to ${live.url} (HTTP actions ${live.siteUrl}).`);
  console.log(`Credentials: ${paths.live}`);
}

async function down() {
  const live = readJson(paths.live);
  if (live === null || !isBackendProcess(live.pid)) {
    console.log("Backend is not running.");
    return;
  }
  process.kill(-live.pid, "SIGTERM");
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (!isBackendProcess(live.pid)) {
      console.log("Backend stopped.");
      return;
    }
    await sleep(250);
  }
  process.kill(-live.pid, "SIGKILL");
  console.log("Backend killed.");
}

async function status() {
  const live = await runningBackend();
  if (live === null) {
    console.log("Backend is not running.");
    process.exitCode = 1;
    return;
  }
  const { url, siteUrl, pid, backend } = live;
  console.log(
    JSON.stringify({ url, siteUrl, pid, version: backend.version }, null, 2),
  );
}

function token({ subject, name, email, ttl }) {
  const secrets = readJson(paths.secrets);
  if (secrets === null) {
    fail("no signing key yet; run `up` first");
  }
  const lifetime = Number(ttl ?? 3600);
  if (!Number.isInteger(lifetime) || lifetime <= 0) {
    fail(`invalid --ttl ${ttl}`);
  }
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = [
    encode({ alg: "RS256", kid: secrets.jwt.kid, typ: "JWT" }),
    encode({
      iss: AUTH.issuer,
      sub: subject ?? "fixture-user",
      aud: AUTH.applicationID,
      iat: now,
      exp: now + lifetime,
      name: name ?? "Fixture User",
      email: email ?? "fixture-user@example.invalid",
    }),
  ].join(".");
  const signature = sign(
    "sha256",
    Buffer.from(signingInput),
    secrets.jwt.privateKey,
  ).toString("base64url");
  console.log(`${signingInput}.${signature}`);
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65534) {
    fail(`invalid --port ${value}`);
  }
  return port;
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case "up": {
    const { values } = parseArgs({
      args: rest,
      options: { port: { type: "string" } },
    });
    await up(values.port === undefined ? undefined : parsePort(values.port));
    break;
  }
  case "down":
    await down();
    break;
  case "status":
    await status();
    break;
  case "token": {
    const { values } = parseArgs({
      args: rest,
      options: {
        subject: { type: "string" },
        name: { type: "string" },
        email: { type: "string" },
        ttl: { type: "string" },
      },
    });
    token(values);
    break;
  }
  case "convex": {
    const live = await runningBackend();
    if (live === null) {
      fail("backend is not running; run `up` first");
    }
    process.exitCode = runConvex(rest, live);
    break;
  }
  case "reset":
    await down();
    for (const path of [paths.data, paths.secrets, paths.live, paths.log]) {
      rmSync(path, { recursive: true, force: true });
    }
    console.log("Backend data and secrets deleted.");
    break;
  default:
    fail(
      "usage: local-backend.mjs <up [--port <n>] | down | status | token | convex <args...> | reset>",
    );
}
