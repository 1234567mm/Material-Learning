// scripts/pre-ship-check.js
// Local pre-ship validation chain
// Mirrors CI: lint → typecheck → build → rename → validate

import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Get VERSION from argv[2] or package.json
const VERSION = process.argv[2] || JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8')).version;

function renameArtifacts() {
  const bundleDir = path.join(__dirname, '..', 'src-tauri', 'target', 'release', 'bundle');
  if (!existsSync(bundleDir)) {
    console.error('[PRE-SHIP] Bundle dir not found:', bundleDir);
    return;
  }

  function walkDir(dir) {
    const results = [];
    for (const entry of readdirSync(dir)) {
      const fullPath = path.join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        results.push(...walkDir(fullPath));
      } else {
        results.push(fullPath);
      }
    }
    return results;
  }

  const allFiles = walkDir(bundleDir);

  const rename = (fromFullPath, toName) => {
    const toPath = path.join(bundleDir, toName);
    if (existsSync(fromFullPath)) {
      statSync(fromFullPath); // verify it's accessible
      const tmpPath = path.join(bundleDir, toName + '.tmp');
      renameSync(fromFullPath, tmpPath);
      renameSync(tmpPath, toPath);
      console.log('[PRE-SHIP] Rename: ' + path.basename(path.dirname(fromFullPath)) + '/' + path.basename(fromFullPath) + ' -> ' + toName);
    }
  };

  // Ubuntu
  for (const f of allFiles.filter(p => p.endsWith('.deb'))) {
    rename(f, 'KnowledgeBase_' + VERSION + '_amd64.deb');
  }
  for (const f of allFiles.filter(p => p.endsWith('.AppImage'))) {
    rename(f, 'KnowledgeBase_' + VERSION + '_amd64.AppImage');
  }
  // Windows
  for (const f of allFiles.filter(p => p.endsWith('.exe'))) {
    rename(f, 'KnowledgeBase_' + VERSION + '_x64-setup.exe');
  }
  // macOS
  for (const f of allFiles.filter(p => p.endsWith('.dmg'))) {
    rename(f, 'KnowledgeBase_' + VERSION + '_aarch64.dmg');
  }
}

function verifyArtifacts() {
  const env = { ...process.env, PLATFORM: 'ubuntu-latest' };
  execSync('node scripts/verify-artifacts.js ' + VERSION, { stdio: 'inherit', cwd: path.join(__dirname, '..'), env });
}

const steps = [
  { cmd: 'pnpm lint', desc: 'Lint' },
  { cmd: 'pnpm typecheck', desc: 'Typecheck' },
  { cmd: 'pnpm tauri build', desc: 'Build' },
  { cmd: null, desc: 'Rename artifacts', fn: renameArtifacts },
  { cmd: null, desc: 'Verify artifacts', fn: verifyArtifacts },
];

for (const step of steps) {
  console.log(`\n[PRE-SHIP] Running: ${step.desc}`);
  try {
    if (step.fn) {
      step.fn();
    } else {
      execSync(step.cmd, { stdio: 'inherit', cwd: path.join(__dirname, '..') });
    }
    console.log(`[PRE-SHIP] OK: ${step.desc}`);
  } catch (e) {
    console.error(`[PRE-SHIP] FAIL: ${step.desc}`);
    process.exit(1);
  }
}

console.log('\n[PRE-SHIP] All checks passed — ready to ship');
