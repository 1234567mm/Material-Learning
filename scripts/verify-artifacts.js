// scripts/verify-artifacts.js
// Validates CI artifacts exist, are named correctly, and have non-zero size

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VERSION = process.argv[2];
const PLATFORM = process.env['PLATFORM'] || 'unknown';

if (!VERSION) {
  console.error('Usage: node verify-artifacts.js <version>');
  process.exit(1);
}

const BUNDLE_DIR = path.join(__dirname, '..', 'src-tauri', 'target', 'release', 'bundle');

// Expected artifacts per platform
const EXPECTED = {
  'ubuntu-latest': [
    `KnowledgeBase_${VERSION}_amd64.deb`,
    `KnowledgeBase_${VERSION}_amd64.AppImage`,
  ],
  'windows-latest': [
    `KnowledgeBase_${VERSION}_x64-setup.exe`,
  ],
  'macos-latest': [
    `KnowledgeBase_${VERSION}_aarch64.dmg`,
  ],
};

if (!EXPECTED[PLATFORM]) {
  console.error(`Unknown platform: ${PLATFORM}`);
  process.exit(1);
}

// Find artifact: first check root of bundle dir, then recursively in subdirs
function findArtifact(name) {
  const rootPath = path.join(BUNDLE_DIR, name);
  if (fs.existsSync(rootPath)) return rootPath;

  function walk(dir) {
    if (!fs.existsSync(dir)) return null;
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        const found = walk(full);
        if (found) return found;
      } else if (entry === name) {
        return full;
      }
    }
    return null;
  }
  return walk(BUNDLE_DIR);
}

const artifacts = EXPECTED[PLATFORM];
let failed = false;

for (const artifact of artifacts) {
  const filePath = findArtifact(artifact);
  if (!filePath) {
    console.error(`FAIL: ${artifact} not found`);
    failed = true;
    continue;
  }
  try {
    const stats = fs.statSync(filePath);
    if (stats.size < 1024 * 1024) {
      console.error(`FAIL: ${artifact} size ${stats.size} < 1MB threshold`);
      failed = true;
    } else {
      console.log(`OK: ${artifact} (${stats.size} bytes)`);
    }
  } catch (e) {
    console.error(`FAIL: ${artifact} - ${e.code}`);
    failed = true;
  }
}

if (failed) {
  process.exit(1);
} else {
  console.log('All artifacts validated successfully');
  process.exit(0);
}
