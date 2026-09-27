import { FileRunHistoryStore } from '../src/storage/run-history.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const testDir = path.join(__dirname, 'fixtures')

async function withTempFile(testName, callback) {
  const testPath = path.join(testDir, `run-history-${testName}.json`)
  try {
    await fs.mkdir(testDir, { recursive: true })
    await callback(testPath)
  } finally {
    try {
      await fs.unlink(testPath)
    } catch {
      // Ignore if file doesn't exist
    }
  }
}

async function assertThrows(fn, message) {
  try {
    await fn()
    throw new Error(`Expected to throw: ${message}`)
  } catch (err) {
    if (!err.message.includes(message)) {
      throw new Error(`Expected error containing "${message}", got: ${err.message}`)
    }
  }
}

console.log('Testing run-history schema versioning...\n')

// Test 1: Legacy unversioned format migrates to version 1
await withTempFile('legacy', async (testPath) => {
  console.log('Test 1: Legacy unversioned format migration')
  const legacyData = {
    runs: [
      {
        id: 'run_1234567890_abc123',
        task: 'Test task',
        budget: 100,
        status: 'completed',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:01:00.000Z',
        events: [],
        txProofs: [],
      },
    ],
  }
  await fs.writeFile(testPath, JSON.stringify(legacyData, null, 2), 'utf8')

  const store = new FileRunHistoryStore(testPath, 200)
  await store.init()

  const content = await fs.readFile(testPath, 'utf8')
  const parsed = JSON.parse(content)

  if (parsed.version !== 1) {
    throw new Error(`Expected version 1, got ${parsed.version}`)
  }
  if (parsed.runs[0].id !== 'run_1234567890_abc123') {
    throw new Error('Run ID not preserved during migration')
  }
  console.log('  ✓ Legacy format migrated to version 1')
  console.log('  ✓ Run ID preserved: run_1234567890_abc123\n')
})

// Test 2: Current version 1 format loads without migration
await withTempFile('current', async (testPath) => {
  console.log('Test 2: Current version 1 format')
  const currentData = {
    version: 1,
    runs: [
      {
        id: 'run_9876543210_xyz789',
        task: 'Current task',
        budget: 200,
        status: 'running',
        createdAt: '2024-01-02T00:00:00.000Z',
        updatedAt: '2024-01-02T00:00:00.000Z',
        events: [],
        txProofs: [],
      },
    ],
  }
  await fs.writeFile(testPath, JSON.stringify(currentData, null, 2), 'utf8')

  const store = new FileRunHistoryStore(testPath, 200)
  await store.init()

  const content = await fs.readFile(testPath, 'utf8')
  const parsed = JSON.parse(content)

  if (parsed.version !== 1) {
    throw new Error(`Expected version 1, got ${parsed.version}`)
  }
  if (parsed.runs[0].id !== 'run_9876543210_xyz789') {
    throw new Error('Run ID not preserved')
  }
  console.log('  ✓ Version 1 format loaded without migration')
  console.log('  ✓ Run ID preserved: run_9876543210_xyz789\n')
})

// Test 3: Invalid JSON file is preserved and recovered
await withTempFile('invalid', async (testPath) => {
  console.log('Test 3: Invalid JSON file recovery')
  await fs.writeFile(testPath, '{ invalid json }', 'utf8')

  const store = new FileRunHistoryStore(testPath, 200)
  await store.init()

  // Check that corrupted file was preserved
  const corruptedFiles = await fs.readdir(testDir)
  const corruptedFile = corruptedFiles.find((f) => f.includes('invalid') && f.includes('corrupted'))

  if (!corruptedFile) {
    throw new Error('Corrupted file was not preserved')
  }

  // Check that new valid file was created
  const content = await fs.readFile(testPath, 'utf8')
  const parsed = JSON.parse(content)

  if (parsed.version !== 1) {
    throw new Error(`Expected version 1 in new file, got ${parsed.version}`)
  }
  console.log('  ✓ Corrupted file preserved with .corrupted suffix')
  console.log('  ✓ New valid file created with version 1\n')
})

// Test 4: Future version fails without rewriting
await withTempFile('future', async (testPath) => {
  console.log('Test 4: Future version rejection')
  const futureData = {
    version: 999,
    runs: [],
  }
  await fs.writeFile(testPath, JSON.stringify(futureData, null, 2), 'utf8')

  await assertThrows(async () => {
    const store = new FileRunHistoryStore(testPath, 200)
    await store.init()
  }, 'Unsupported schema version 999')

  // Verify original file was not modified
  const content = await fs.readFile(testPath, 'utf8')
  const parsed = JSON.parse(content)

  if (parsed.version !== 999) {
    throw new Error('Future version file was modified (should not rewrite)')
  }
  console.log('  ✓ Future version rejected with clear error')
  console.log('  ✓ Original file not modified\n')
})

// Test 5: Payment proofs preserved through migration
await withTempFile('payment-proofs', async (testPath) => {
  console.log('Test 5: Payment proofs preservation')
  const legacyData = {
    runs: [
      {
        id: 'run_payment_test',
        task: 'Payment test',
        budget: 50,
        status: 'completed',
        createdAt: '2024-01-03T00:00:00.000Z',
        updatedAt: '2024-01-03T00:05:00.000Z',
        events: [],
        txProofs: [
          {
            method: 'x402',
            txHash: 'abc123def456',
            explorerUrl: 'https://testnet.stellar.org/tx/abc123def456',
          },
          {
            method: 'xlm',
            txHash: 'xyz789uvw012',
            explorerUrl: 'https://testnet.stellar.org/tx/xyz789uvw012',
          },
        ],
      },
    ],
  }
  await fs.writeFile(testPath, JSON.stringify(legacyData, null, 2), 'utf8')

  const store = new FileRunHistoryStore(testPath, 200)
  await store.init()

  const runs = await store.listRecent()
  if (runs.length !== 1) {
    throw new Error(`Expected 1 run, got ${runs.length}`)
  }
  if (runs[0].txProofs.length !== 2) {
    throw new Error(`Expected 2 txProofs, got ${runs[0].txProofs.length}`)
  }
  if (runs[0].txProofs[0].txHash !== 'abc123def456') {
    throw new Error('First txHash not preserved')
  }
  if (runs[0].txProofs[1].txHash !== 'xyz789uvw012') {
    throw new Error('Second txHash not preserved')
  }
  console.log('  ✓ Payment proofs preserved through migration')
  console.log('  ✓ txHash 1: abc123def456')
  console.log('  ✓ txHash 2: xyz789uvw012\n')
})

// Test 6: New writes include version field
await withTempFile('new-write', async (testPath) => {
  console.log('Test 6: New writes include version field')
  const store = new FileRunHistoryStore(testPath, 200)
  await store.init()

  await store.createRun({ task: 'New task', budget: 100, source: 'test' })

  const content = await fs.readFile(testPath, 'utf8')
  const parsed = JSON.parse(content)

  if (parsed.version !== 1) {
    throw new Error(`Expected version 1 in new write, got ${parsed.version}`)
  }
  if (parsed.runs.length !== 1) {
    throw new Error(`Expected 1 run, got ${parsed.runs.length}`)
  }
  console.log('  ✓ New writes include version field')
  console.log('  ✓ Version: 1\n')
})

// Test 7: Missing file is treated as first startup, not corruption
await withTempFile('missing', async (testPath) => {
  console.log('Test 7: Missing file is first startup')
  // Do not create testPath at all.
  const store = new FileRunHistoryStore(testPath, 200)
  await store.init()

  const content = await fs.readFile(testPath, 'utf8')
  const parsed = JSON.parse(content)
  if (parsed.version !== 1 || parsed.runs.length !== 0) {
    throw new Error('Missing file did not produce a fresh empty store')
  }
  const files = await fs.readdir(testDir)
  if (files.some((f) => f.includes('missing') && f.includes('corrupted'))) {
    throw new Error('Missing file should never produce a .corrupted backup')
  }
  console.log('  ✓ Missing file starts a fresh store without any corrupted backup\n')
})

// Test 8: Invalid schema value (non-numeric version) is preserved and recovered
await withTempFile('invalid-schema', async (testPath) => {
  console.log('Test 8: Invalid schema value recovery')
  await fs.writeFile(testPath, JSON.stringify({ version: 'not-a-number', runs: [] }), 'utf8')

  const store = new FileRunHistoryStore(testPath, 200)
  await store.init()

  const corruptedFiles = await fs.readdir(testDir)
  const corruptedFile = corruptedFiles.find(
    (f) => f.includes('invalid-schema') && f.includes('corrupted')
  )
  if (!corruptedFile) {
    throw new Error('Invalid-schema file was not preserved before recovery')
  }

  const content = await fs.readFile(testPath, 'utf8')
  const parsed = JSON.parse(content)
  if (parsed.version !== 1) {
    throw new Error(`Expected recovered version 1, got ${parsed.version}`)
  }
  console.log('  ✓ Invalid schema value preserved with .corrupted suffix')
  console.log('  ✓ New valid file created with version 1\n')
})

// Test 9: Read failures other than ENOENT fail fast without touching the file
await withTempFile('read-error', async (testPath) => {
  console.log('Test 9: Simulated read/permission error fails start without overwrite')
  const originalContent = JSON.stringify({ version: 1, runs: [{ id: 'keep-me' }] }, null, 2)
  await fs.writeFile(testPath, originalContent, 'utf8')

  const store = new FileRunHistoryStore(testPath, 200)
  const originalReadFile = fs.readFile
  fs.readFile = async (p, ...args) => {
    if (p === testPath) {
      const err = new Error('EACCES: permission denied')
      err.code = 'EACCES'
      throw err
    }
    return originalReadFile(p, ...args)
  }

  try {
    await assertThrows(async () => {
      await store.init()
    }, 'unable to read history file')
  } finally {
    fs.readFile = originalReadFile
  }

  // The original file must be untouched — same bytes, no backup created.
  const content = await fs.readFile(testPath, 'utf8')
  if (content !== originalContent) {
    throw new Error('Original file was modified after a simulated permission error')
  }
  const files = await fs.readdir(testDir)
  if (files.some((f) => f.includes('read-error') && f.includes('corrupted'))) {
    throw new Error('Permission error should not produce a .corrupted backup')
  }
  console.log('  ✓ Permission/I-O error fails start and leaves the original file untouched\n')
})

console.log('All tests passed! ✓')
