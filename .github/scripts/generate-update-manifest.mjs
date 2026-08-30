#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const [artifactsArg, version, tag, repository, outputArg] = process.argv.slice(2);

if (!artifactsArg || !version || !tag || !repository || !outputArg) {
  console.error("Usage: node generate-update-manifest.mjs <artifacts-dir> <version> <tag> <owner/repo> <output>");
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

const linuxAppImage = updaterArtifact("Linux AppImage", [/\.AppImage\.sig$/i]);
const linuxDeb = updaterArtifact("Linux deb", [/\.deb\.sig$/i]);
const windowsNsis = updaterArtifact("Windows NSIS", [/-setup\.exe\.sig$/i]);
const windowsMsi = updaterArtifact("Windows MSI", [/\.msi\.sig$/i]);
const macos = updaterArtifact("universal macOS", [/\.app\.tar\.gz\.sig$/i]);

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
