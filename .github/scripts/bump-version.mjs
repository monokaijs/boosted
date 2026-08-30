#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const bumpType = process.argv[2];
const allowedBumps = new Set(["patch", "minor", "major"]);

if (!allowedBumps.has(bumpType)) {
  console.error("Usage: node .github/scripts/bump-version.mjs <patch|minor|major>");
  process.exit(1);
}

const root = process.cwd();
const paths = {
  cargoManifest: resolve(root, "Cargo.toml"),
  cargoLock: resolve(root, "Cargo.lock"),
  desktopPackage: resolve(root, "desktop/package.json"),
  webPackage: resolve(root, "web/package.json"),
  tauriConfig: resolve(root, "desktop/src-tauri/tauri.conf.json"),
};

const cargoManifest = readFileSync(paths.cargoManifest, "utf8");
const workspaceVersionMatch = cargoManifest.match(
  /(\[workspace\.package\][\s\S]*?\nversion\s*=\s*")(\d+\.\d+\.\d+)(")/,
);

if (!workspaceVersionMatch) {
  throw new Error("Could not find workspace.package.version in Cargo.toml");
}

const currentVersion = workspaceVersionMatch[2];
const jsonFiles = [
  paths.desktopPackage,
  paths.webPackage,
  paths.tauriConfig,
];

for (const file of jsonFiles) {
  const version = JSON.parse(readFileSync(file, "utf8")).version;
  if (version !== currentVersion) {
    throw new Error(
      `${file} has version ${version}; expected every app version to be ${currentVersion}`,
    );
  }
}

const versionParts = currentVersion.split(".").map(Number);

if (bumpType === "major") {
  versionParts[0] += 1;
  versionParts[1] = 0;
  versionParts[2] = 0;
} else if (bumpType === "minor") {
  versionParts[1] += 1;
  versionParts[2] = 0;
} else {
  versionParts[2] += 1;
}

const nextVersion = versionParts.join(".");

writeFileSync(
  paths.cargoManifest,
  cargoManifest.replace(
    workspaceVersionMatch[0],
    `${workspaceVersionMatch[1]}${nextVersion}${workspaceVersionMatch[3]}`,
  ),
);

for (const file of jsonFiles) {
  const contents = JSON.parse(readFileSync(file, "utf8"));
  contents.version = nextVersion;
  writeFileSync(file, `${JSON.stringify(contents, null, 2)}\n`);
}

const workspacePackages = new Set(["boosted-desktop", "boosted-server"]);
let updatedLockPackages = 0;
const cargoLock = readFileSync(paths.cargoLock, "utf8").replace(
  /\[\[package\]\]\r?\n[\s\S]*?(?=\r?\n\[\[package\]\]|$)/g,
  (packageBlock) => {
    const name = packageBlock.match(/^name = "([^"]+)"\r?$/m)?.[1];
    if (!workspacePackages.has(name)) {
      return packageBlock;
    }

    const versionPattern = new RegExp(
      `^version = "${currentVersion.replaceAll(".", "\\.")}"(\\r?)$`,
      "m",
    );
    if (!versionPattern.test(packageBlock)) {
      throw new Error(`Cargo.lock has an unexpected version for ${name}`);
    }

    updatedLockPackages += 1;
    return packageBlock.replace(
      versionPattern,
      (_match, carriageReturn) => `version = "${nextVersion}"${carriageReturn}`,
    );
  },
);

if (updatedLockPackages !== workspacePackages.size) {
  throw new Error(
    `Updated ${updatedLockPackages} workspace packages in Cargo.lock; expected ${workspacePackages.size}`,
  );
}

writeFileSync(paths.cargoLock, cargoLock);
process.stdout.write(`${nextVersion}\n`);
