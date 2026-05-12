#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

const packageJsonPath = resolve(rootDir, 'package.json');
const tauriConfPath = resolve(rootDir, 'src-tauri/tauri.conf.json');

// Read versions
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
const tauriConf = JSON.parse(readFileSync(tauriConfPath, 'utf-8'));

const pkgVersion = packageJson.version;
const tauriVersion = tauriConf.version;

console.log(`package.json version: ${pkgVersion}`);
console.log(`tauri.conf.json version: ${tauriVersion}`);

if (pkgVersion === tauriVersion) {
  console.log('Versions match, no changes needed.');
} else {
  console.log(`Updating tauri.conf.json version from ${tauriVersion} to ${pkgVersion}...`);
  tauriConf.version = pkgVersion;
  writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + '\n');
  console.log('tauri.conf.json updated successfully.');
}
