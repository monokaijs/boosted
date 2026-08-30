import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
const packageJson = JSON.parse(await readFile(packagePath, "utf8"));

export const version = packageJson.version;

export function releaseAsset(platform = process.platform, arch = process.arch) {
  const targets = {
    "darwin-arm64": `boosted-${version}-darwin-aarch64`,
    "darwin-x64": `boosted-${version}-darwin-x86_64`,
    "linux-x64": `boosted-${version}-linux-x86_64`,
    "win32-x64": `boosted-${version}-windows-x86_64.exe`,
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

function releaseBaseUrl(env = process.env) {
  return (
    env.BOOSTED_CLI_DOWNLOAD_BASE_URL ||
    `https://github.com/monokaijs/boosted/releases/download/v${version}`
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
} = {}) {
  const asset = releaseAsset(platform, arch);
  const binary = join(
    cacheRoot(platform, env),
    version,
    platform === "win32" ? "boosted-cli.exe" : "boosted-cli",
  );

  try {
    await chmod(binary, 0o755);
    return binary;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const baseUrl = releaseBaseUrl(env);
  console.error(`boosted-cli: downloading Boosted ${version} for ${platform}/${arch}...`);
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

export async function run({ argv = process.argv.slice(2), env = process.env } = {}) {
  const binary = await installBinary({ env });
  const child = spawn(binary, argv, {
    env,
    stdio: "inherit",
    windowsHide: false,
  });

  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      process.exitCode = code ?? 1;
      resolve();
    });
  });
}
