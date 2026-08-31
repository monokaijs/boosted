import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
const packageJson = JSON.parse(await readFile(packagePath, "utf8"));

export const version = packageJson.version;
export const updateRestartExitCode = 75;

export function releaseAsset(platform = process.platform, arch = process.arch, releaseVersion = version) {
  const targets = {
    "darwin-arm64": `boosted-${releaseVersion}-darwin-aarch64`,
    "darwin-x64": `boosted-${releaseVersion}-darwin-x86_64`,
    "linux-x64": `boosted-${releaseVersion}-linux-x86_64`,
    "win32-x64": `boosted-${releaseVersion}-windows-x86_64.exe`,
  };
  const key = `${platform}-${arch}`;
  const asset = targets[key];

  if (!asset) {
    throw new Error(
      `unsupported platform ${platform}/${arch}; supported platforms are macOS arm64/x64, Linux x64, and Windows x64`,
    );
  }

  return asset;
}

export function cacheRoot(platform = process.platform, env = process.env) {
  if (env.BOOSTED_CLI_CACHE_DIR) return env.BOOSTED_CLI_CACHE_DIR;
  if (platform === "darwin") return join(homedir(), "Library", "Caches", "boosted-cli");
  if (platform === "win32") {
    return join(env.LOCALAPPDATA || tmpdir(), "boosted-cli", "Cache");
  }
  return join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "boosted-cli");
}

function releaseBaseUrl(releaseVersion = version, env = process.env) {
  return (
    env.BOOSTED_CLI_DOWNLOAD_BASE_URL ||
    `https://github.com/monokaijs/boosted/releases/download/v${releaseVersion}`
  ).replace(/\/$/, "");
}

async function download(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/octet-stream",
      "User-Agent": `boosted-cli/${version}`,
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`download failed (${response.status} ${response.statusText}): ${url}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

function expectedChecksum(checksums, asset) {
  for (const line of checksums.split(/\r?\n/)) {
    const match = line.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (match?.[2] === asset) return match[1].toLowerCase();
  }
  throw new Error(`SHA256SUMS.txt does not contain ${asset}`);
}

export async function installBinary({
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  releaseVersion = version,
} = {}) {
  const asset = releaseAsset(platform, arch, releaseVersion);
  const binary = join(
    cacheRoot(platform, env),
    releaseVersion,
    platform === "win32" ? "boosted-cli.exe" : "boosted-cli",
  );

  try {
    await chmod(binary, 0o755);
    return binary;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const baseUrl = releaseBaseUrl(releaseVersion, env);
  console.error(`boosted-cli: downloading Boosted ${releaseVersion} for ${platform}/${arch}...`);
  const [contents, checksumContents] = await Promise.all([
    download(`${baseUrl}/${asset}`),
    download(`${baseUrl}/SHA256SUMS.txt`).then((value) => value.toString("utf8")),
  ]);
  const actual = createHash("sha256").update(contents).digest("hex");
  const expected = expectedChecksum(checksumContents, asset);

  if (actual !== expected) {
    throw new Error(`checksum verification failed for ${asset}`);
  }

  await mkdir(dirname(binary), { recursive: true });
  const temporary = `${binary}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, contents, { mode: 0o755 });
    await chmod(temporary, 0o755);
    await rename(temporary, binary);
  } finally {
    await rm(temporary, { force: true });
  }

  return binary;
}

export function spawnOptions(env = process.env) {
  return {
    env,
    stdio: "inherit",
    windowsHide: true,
  };
}

function parsedVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
  if (!match) return undefined;
  return {
    numbers: match.slice(1, 4).map(Number),
    prerelease: match[4],
  };
}

export function compareVersions(left, right) {
  const a = parsedVersion(left);
  const b = parsedVersion(right);
  if (!a || !b) throw new Error(`invalid Boosted version comparison: ${left} / ${right}`);
  for (let index = 0; index < a.numbers.length; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] - b.numbers[index];
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease, "en", { numeric: true });
}

function binaryPath(root, releaseVersion, platform) {
  return join(root, releaseVersion, platform === "win32" ? "boosted-cli.exe" : "boosted-cli");
}

export async function activeReleaseVersion(root, packageVersion = version) {
  try {
    const active = JSON.parse(await readFile(join(root, "active.json"), "utf8"));
    if (typeof active.version !== "string" || compareVersions(active.version, packageVersion) <= 0) {
      return packageVersion;
    }
    return active.version;
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return packageVersion;
    if (error.message?.startsWith("invalid Boosted version comparison")) return packageVersion;
    throw error;
  }
}

export async function resolveBinary({
  platform = process.platform,
  arch = process.arch,
  env = process.env,
} = {}) {
  const root = cacheRoot(platform, env);
  const activeVersion = await activeReleaseVersion(root);
  if (activeVersion !== version) {
    const activeBinary = binaryPath(root, activeVersion, platform);
    try {
      await chmod(activeBinary, 0o755);
      return activeBinary;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return installBinary({ platform, arch, env });
}

export function managedEnvironment(platform = process.platform, env = process.env) {
  return {
    ...env,
    BOOSTED_MANAGED_INSTALL: "1",
    BOOSTED_CLI_CACHE_DIR_RESOLVED: resolve(cacheRoot(platform, env)),
    BOOSTED_UPDATE_EXIT_CODE: String(updateRestartExitCode),
  };
}

async function waitForChild(child) {
  return new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

export async function run({ argv = process.argv.slice(2), env = process.env } = {}) {
  const platform = process.platform;
  const childEnv = managedEnvironment(platform, env);
  let binary = await resolveBinary({ platform, env });

  while (true) {
    const child = spawn(binary, argv, spawnOptions(childEnv));
    const { code, signal } = await waitForChild(child);
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    if (code !== updateRestartExitCode) {
      process.exitCode = code ?? 1;
      return;
    }

    const nextBinary = await resolveBinary({ platform, env });
    if (nextBinary === binary) {
      throw new Error("Boosted requested an update restart, but no newer managed binary is active");
    }
    binary = nextBinary;
    console.error("boosted-cli: verified update installed; restarting Boosted...");
  }
}
