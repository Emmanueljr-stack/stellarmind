/**
 * Container persistence guards for issue #179.
 *
 * The failure this pins down is invisible until runtime: `/app` belongs to root
 * and the process drops to the `stellarmind` user, so the store's `mkdir -p` on
 * the default history path fails with EACCES on the very first run. Nothing in
 * the test suite could see that, because no test builds the image.
 *
 * Two layers of checks:
 *  1. container wiring — the Dockerfile prepares a writable directory owned by
 *     the runtime user *before* dropping privileges, and docker-compose mounts a
 *     named volume at exactly the directory RUN_HISTORY_FILE points to;
 *  2. storage behaviour — a fresh store instance reads back a run written by a
 *     previous one, which is what "readable after container recreation" means
 *     once the volume is in place.
 *
 * Run: node tests/docker-run-history.test.js
 */

import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRunHistoryStore } from '../src/storage/run-history.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dockerfile = fs.readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8')
const compose = fs.readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8')

// ── 1. the image prepares the history directory for the non-root user ────────

assert.match(
  dockerfile,
  /mkdir -p \/app\/data/,
  'Dockerfile must create /app/data, otherwise the non-root user cannot initialise file history'
)

const chownIndex = dockerfile.search(/chown[^\n]*stellarmind[^\n]*\/app\/data/)
assert.ok(chownIndex > -1, 'Dockerfile must chown /app/data to the stellarmind user')

const userIndex = dockerfile.search(/^USER stellarmind$/m)
assert.ok(userIndex > -1, 'Dockerfile must drop privileges with USER stellarmind')
assert.ok(
  chownIndex < userIndex,
  'the chown must run before USER stellarmind, or it cannot be applied as root'
)

const envPathMatch = /ENV RUN_HISTORY_FILE=(\S+)/.exec(dockerfile)
assert.ok(
  envPathMatch,
  'Dockerfile must pin RUN_HISTORY_FILE so the path cannot drift from the volume'
)
const containerHistoryDir = path.posix.dirname(envPathMatch[1])
assert.strictEqual(
  containerHistoryDir,
  '/app/data',
  `RUN_HISTORY_FILE must live in the prepared directory, got ${containerHistoryDir}`
)

// ── 2. compose mounts a named volume at that directory ──────────────────────

const mountMatch = new RegExp(`^\\s*-\\s*([A-Za-z0-9_.-]+):${containerHistoryDir}\\s*$`, 'm').exec(
  compose
)
assert.ok(mountMatch, `docker-compose must mount a volume at ${containerHistoryDir}`)
const volumeName = mountMatch[1]
assert.ok(
  !volumeName.startsWith('./') && !volumeName.startsWith('/'),
  `the mount at ${containerHistoryDir} must be a named volume, not a host bind mount — a bind mount is created root-owned and reintroduces EACCES`
)
assert.match(
  compose,
  new RegExp(`^\\s{2}${volumeName}:\\s*$`, 'm'),
  `the named volume ${volumeName} must be declared so compose does not create it anonymously`
)

// ── 3. storage behaviour: a run survives a new store instance ───────────────

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellarmind-history-'))
const historyFile = path.join(tempDir, 'nested', 'run-history.json')
const config = {
  runHistoryStorage: 'file',
  runHistoryFile: historyFile,
  runHistoryMaxRuns: 10,
}

const firstStore = await createRunHistoryStore(config)
const run = await firstStore.createRun({ task: 'persistence check', budget: 5, source: 'test' })

const reopenedStore = await createRunHistoryStore(config)
assert.ok(
  reopenedStore.runs.some((existing) => existing.id === run.id),
  'a run written by one store instance must be readable by the next one'
)

fs.rmSync(tempDir, { recursive: true, force: true })

console.log('✅ docker run-history persistence checks passed')
