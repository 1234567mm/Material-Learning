#!/usr/bin/env node
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLE_DIR = join(__dirname, '..', 'src-tauri', 'target', 'release', 'bundle');

// Get version from CLI or package.json
const version = process.argv[2];
let ver = version;
if (!ver) {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
  ver = pkg.version;
}

function exec(command) {
  return execSync(command, { encoding: 'utf-8' }).trim();
}

function findArtifact(pattern) {
  try {
    const result = exec(`find "${BUNDLE_DIR}" -name "${pattern}" -type f 2>/dev/null | head -1`);
    return result || null;
  } catch {
    return null;
  }
}

function sha256(file) {
  if (!file) return 'N/A';
  try {
    return exec(`sha256sum "${file}" | cut -d' ' -f1`);
  } catch {
    return 'N/A';
  }
}

function getFilename(file) {
  return file ? file.split('/').pop() : 'N/A';
}

// Locate artifacts
const windowsNsis = findArtifact('*x64*setup*.exe');
const windowsMsi = findArtifact('*.msi');
const ubuntuDeb = findArtifact('*amd64.deb');
const ubuntuAppImage = findArtifact('*.AppImage');
const macosDmg = findArtifact('*aarch64.dmg');

const artifacts = [
  { platform: 'Windows', arch: 'x64', format: 'NSIS', file: windowsNsis },
  { platform: 'Windows', arch: 'x64', format: 'MSI', file: windowsMsi },
  { platform: 'Ubuntu', arch: 'amd64', format: 'deb', file: ubuntuDeb },
  { platform: 'Ubuntu', arch: 'amd64', format: 'AppImage', file: ubuntuAppImage },
  { platform: 'macOS', arch: 'aarch64', format: 'dmg', file: macosDmg },
];

// Build info
const buildDate = new Date().toISOString().split('T')[0];
const rustVersion = exec('rustc --version').split(' ')[1];
const nodeVersion = exec('node --version');

function gitChangelog() {
  try {
    const lastTag = exec("git describe --tags --abbrev=0 2>/dev/null || echo ''");
    if (!lastTag) {
      return 'No previous tags found.';
    }
    const logs = exec(`git log ${lastTag}..HEAD --pretty=format:"- %s (%h)" 2>/dev/null`);
    return logs || 'No commits since last tag.';
  } catch {
    return 'Unable to generate changelog.';
  }
}

const changelog = gitChangelog();

// Generate markdown
const md = `# Release v${ver}

## Build Artifacts

| Platform | Architecture | Format | Filename | SHA-256 |
|----------|--------------|--------|----------|---------|
${artifacts.map(a => `| ${a.platform} | ${a.arch} | ${a.format} | ${getFilename(a.file)} | ${sha256(a.file)} |`).join('\n')}

## Build Information

- **Date:** ${buildDate}
- **Platform:** ${process.platform}
- **Rust Version:** ${rustVersion}
- **Node Version:** ${nodeVersion}

## Changelog

${changelog}
`;

// Write file
const { writeFileSync, mkdirSync } = await import('fs');
const outDir = join(__dirname, '..', 'releases');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `v${ver}.md`), md);

console.log(`Generated releases/v${ver}.md`);