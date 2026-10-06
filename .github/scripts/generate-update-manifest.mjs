#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const [artifactsArg, version, tag, repository, outputArg, mode] = process.argv.slice(2);

if (!artifactsArg || !version || !tag || !repository || !outputArg || (mode && mode !== "--partial")) {
  console.error("Usage: node generate-update-manifest.mjs <artifacts-dir> <version> <tag> <owner/repo> <output> [--partial]");
  process.exit(1);
}

const artifactsDirectory = resolve(artifactsArg);

function filesWithin(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? filesWithin(path) : [path];
  });
}

const files = filesWithin(artifactsDirectory);

function updaterArtifact(label, patterns) {
  const matches = patterns.flatMap((pattern) => files.filter((file) => pattern.test(basename(file))));
  const uniqueMatches = [...new Set(matches)];

  if (uniqueMatches.length !== 1) {
    throw new Error(`Expected exactly one ${label} updater signature, found ${uniqueMatches.length}: ${uniqueMatches.join(", ")}`);
  }

  const signaturePath = uniqueMatches[0];
  const artifactPath = signaturePath.slice(0, -4);
  if (!existsSync(artifactPath)) throw new Error(`Updater artifact is missing for ${signaturePath}`);

  const signature = readFileSync(signaturePath, "utf8").trim();
  if (!signature) throw new Error(`Updater signature is empty: ${signaturePath}`);

  const filename = basename(artifactPath);
  return {
    signature,
    url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(filename)}`,
  };
}

// A platform is included only once its installer group is present. Once any
// installer appears, still require every updater signature for that platform.
const includeLinux = !mode || files.some((file) => /\.(AppImage|deb)(\.sig)?$/i.test(file));
const includeWindows = !mode || files.some((file) => /(-setup\.exe|\.msi)(\.sig)?$/i.test(file));
const includeMacos = !mode || files.some((file) => /\.app\.tar\.gz(\.sig)?$/i.test(file));
const linuxAppImage = includeLinux ? updaterArtifact("Linux AppImage", [/\.AppImage\.sig$/i]) : undefined;
const linuxDeb = includeLinux ? updaterArtifact("Linux deb", [/\.deb\.sig$/i]) : undefined;
const windowsNsis = includeWindows ? updaterArtifact("Windows NSIS", [/-setup\.exe\.sig$/i]) : undefined;
const windowsMsi = includeWindows ? updaterArtifact("Windows MSI", [/\.msi\.sig$/i]) : undefined;
const macos = includeMacos ? updaterArtifact("universal macOS", [/\.app\.tar\.gz\.sig$/i]) : undefined;

const manifest = {
  version,
  notes: `Boosted ${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    "linux-x86_64": linuxAppImage,
    "linux-x86_64-appimage": linuxAppImage,
    "linux-x86_64-deb": linuxDeb,
    "windows-x86_64": windowsNsis,
    "windows-x86_64-nsis": windowsNsis,
    "windows-x86_64-msi": windowsMsi,
    "darwin-aarch64": macos,
    "darwin-aarch64-app": macos,
    "darwin-x86_64": macos,
    "darwin-x86_64-app": macos,
    "darwin-universal": macos,
  },
};

writeFileSync(resolve(outputArg), `${JSON.stringify(manifest, null, 2)}\n`);
