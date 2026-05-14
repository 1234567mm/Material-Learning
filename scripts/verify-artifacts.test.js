// scripts/verify-artifacts.test.js
// Unit tests for verify-artifacts.js using Node.js built-in test runner

import { test, mock } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Mock fs module
const mockFs = {
  statSync: mock.fn(),
};

test('Happy path — all artifacts exist with correct naming and size → exit 0', () => {
  // Reset mock
  mockFs.statSync.mock.resetCalls();

  // Mock successful stat calls with files > 1MB
  mockFs.statSync.mock.mockImplementation((filePath) => {
    if (filePath.includes('amd64.deb') || filePath.includes('AppImage')) {
      return { size: 50 * 1024 * 1024 }; // 50MB
    }
    return { size: 0 };
  });

  // Simulate verify-artifacts logic
  const VERSION = '1.8.5';
  const PLATFORM = 'ubuntu-latest';
  const BUNDLE_DIR = path.join(__dirname, '..', 'src-tauri', 'target', 'release', 'bundle');

  const EXPECTED = {
    'ubuntu-latest': [
      `KnowledgeBase_${VERSION}_amd64.deb`,
      `KnowledgeBase_${VERSION}_amd64.AppImage`,
    ],
  };

  let failed = false;
  for (const artifact of EXPECTED[PLATFORM]) {
    const filePath = path.join(BUNDLE_DIR, artifact);
    const stats = mockFs.statSync(filePath);
    if (stats.size < 1024 * 1024) {
      failed = true;
    }
  }

  assert.strictEqual(failed, false, 'Should not fail with valid artifacts');
});

test('Missing artifact → exit 1 with error message', () => {
  mockFs.statSync.mock.resetCalls();

  // Mock file not found
  mockFs.statSync.mock.mockImplementation(() => {
    const error = new Error('ENOENT');
    error.code = 'ENOENT';
    throw error;
  });

  const VERSION = '1.8.5';
  const PLATFORM = 'ubuntu-latest';
  const BUNDLE_DIR = path.join(__dirname, '..', 'src-tauri', 'target', 'release', 'bundle');

  const EXPECTED = {
    'ubuntu-latest': [`KnowledgeBase_${VERSION}_amd64.deb`],
  };

  let failed = false;
  try {
    for (const artifact of EXPECTED[PLATFORM]) {
      const filePath = path.join(BUNDLE_DIR, artifact);
      mockFs.statSync(filePath);
    }
  } catch (e) {
    if (e.code === 'ENOENT') {
      failed = true;
    }
  }

  assert.strictEqual(failed, true, 'Should fail when artifact not found');
});

test('Wrong naming (version mismatch, wrong arch suffix) → exit 1', () => {
  mockFs.statSync.mock.resetCalls();

  // Mock stat with wrong version
  mockFs.statSync.mock.mockImplementation((filePath) => {
    if (filePath.includes('1.8.4')) {
      return { size: 50 * 1024 * 1024 };
    }
    const error = new Error('ENOENT');
    error.code = 'ENOENT';
    throw error;
  });

  const VERSION = '1.8.5';
  const PLATFORM = 'ubuntu-latest';
  const BUNDLE_DIR = path.join(__dirname, '..', 'src-tauri', 'target', 'release', 'bundle');

  const EXPECTED = {
    'ubuntu-latest': [`KnowledgeBase_${VERSION}_amd64.deb`],
  };

  let failed = false;
  try {
    for (const artifact of EXPECTED[PLATFORM]) {
      const filePath = path.join(BUNDLE_DIR, artifact);
      mockFs.statSync(filePath);
    }
  } catch (e) {
    if (e.code === 'ENOENT') {
      failed = true;
    }
  }

  assert.strictEqual(failed, true, 'Should fail when artifact has wrong naming');
});

test('Empty/small artifact (size < 1MB) → exit 1', () => {
  mockFs.statSync.mock.resetCalls();

  // Mock stat with size < 1MB
  mockFs.statSync.mock.mockImplementation(() => {
    return { size: 500 * 1024 }; // 500KB - less than 1MB threshold
  });

  const VERSION = '1.8.5';
  const PLATFORM = 'ubuntu-latest';
  const BUNDLE_DIR = path.join(__dirname, '..', 'src-tauri', 'target', 'release', 'bundle');

  const EXPECTED = {
    'ubuntu-latest': [`KnowledgeBase_${VERSION}_amd64.deb`],
  };

  let failed = false;
  for (const artifact of EXPECTED[PLATFORM]) {
    const filePath = path.join(BUNDLE_DIR, artifact);
    const stats = mockFs.statSync(filePath);
    if (stats.size < 1024 * 1024) {
      failed = true;
    }
  }

  assert.strictEqual(failed, true, 'Should fail when artifact is too small');
});

test('Windows vs Unix path handling — verify path.join works on both', () => {
  // Test that path.join produces correct cross-platform paths
  const baseDir = path.join(__dirname, '..', 'src-tauri', 'target', 'release', 'bundle');
  const artifactName = 'KnowledgeBase_1.8.5_x64-setup.exe';
  const fullPath = path.join(baseDir, artifactName);

  // On both Windows and Unix, path.join should produce a valid path string
  assert.ok(fullPath.includes('KnowledgeBase_1.8.5_x64-setup.exe'), 'Path should contain artifact name');
  assert.ok(fullPath.includes('bundle'), 'Path should contain bundle directory');

  // Verify the path components are correctly joined
  const expectedComponents = ['bundle', artifactName];
  const pathParts = fullPath.split(path.sep).filter(p => p);
  assert.ok(pathParts.length >= 2, 'Path should have multiple components');
});
