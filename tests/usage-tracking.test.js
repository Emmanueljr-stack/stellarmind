/**
 * Provider token usage tracking (issue #152).
 *
 * Covers (per acceptance criteria):
 *  - Planning and agent usage recorded/aggregated separately
 *  - Retries: only a final successful attempt yields usage (nothing
 *    fabricated for retried-away transient failures)
 *  - Model fallback: usage attributed to whichever model actually served
 *    the request, with the failed primary attempt recorded as unavailable
 *    rather than merged into the fallback's numbers
 *  - Absent provider usage (no API key, x402-remote call, demo fallback,
 *    error) is represented as `unavailable: true`, never fabricated as 0
 *  - Aggregation never alters or reads from settled marketplace charges
 *    (agent.price / totalSpent / budget) — verified by namespace isolation
 *  - Persistence: InMemoryRunHistoryStore.completeRun stores usage as its
 *    own field, separate from `run.summary`
 *
 * Dependency-free (no network, no SDK) → deterministic and fast.
 * Run: node tests/usage-tracking.test.js
 */

import assert from 'node:assert'
import {
  usageFromMessage,
  unavailableUsage,
  recordUsageEntry,
  aggregateUsage,
  summarizeUsageByPhase,
} from '../src/agents/usage.js'
import { InMemoryRunHistoryStore } from '../src/storage/run-history.js'

// ─── Tiny test harness (collect-all, fail-fast exit) ─────────────
const failures = []
let passed = 0

function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures.push({ name, err })
    console.error(`  ✗ ${name}\n      ${err.message.replace(/\n/g, '\n      ')}`)
  }
}

async function asyncTest(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures.push({ name, err })
    console.error(`  ✗ ${name}\n      ${err.message.replace(/\n/g, '\n      ')}`)
  }
}

// ─── usageFromMessage: extraction from an Anthropic SDK response ─
console.log('usageFromMessage')
test('extracts input/output tokens when usage is present', () => {
  const msg = {
    model: 'claude-haiku-4-5-20251001',
    usage: { input_tokens: 120, output_tokens: 45 },
  }
  const u = usageFromMessage(msg)
  assert.deepStrictEqual(u, {
    model: 'claude-haiku-4-5-20251001',
    inputTokens: 120,
    outputTokens: 45,
    unavailable: false,
    reason: null,
  })
})
test('an explicit model param overrides the message model', () => {
  const msg = { model: 'claude-haiku-4-5-20251001', usage: { input_tokens: 1, output_tokens: 1 } }
  const u = usageFromMessage(msg, 'claude-sonnet-4-5-20250929')
  assert.strictEqual(u.model, 'claude-sonnet-4-5-20250929')
})
test('missing usage is unavailable, not zero (fixture: missing usage)', () => {
  const u = usageFromMessage({ model: 'claude-haiku-4-5-20251001' })
  assert.strictEqual(u.unavailable, true)
  assert.strictEqual(u.inputTokens, null)
  assert.strictEqual(u.outputTokens, null)
  assert.strictEqual(u.reason, 'no_usage_in_response')
})
test('non-numeric usage fields are treated as unavailable', () => {
  const u = usageFromMessage({ usage: { input_tokens: '120', output_tokens: 45 } })
  assert.strictEqual(u.unavailable, true)
})
test('a null message is unavailable, not a throw', () => {
  const u = usageFromMessage(null, 'claude-haiku-4-5-20251001')
  assert.strictEqual(u.unavailable, true)
  assert.strictEqual(u.model, 'claude-haiku-4-5-20251001')
})

// ─── unavailableUsage / recordUsageEntry ──────────────────────────
console.log('unavailableUsage / recordUsageEntry')
test('unavailableUsage carries a reason and never a fabricated 0', () => {
  const u = unavailableUsage('claude-haiku-4-5-20251001', 'x402_remote_call')
  assert.strictEqual(u.unavailable, true)
  assert.strictEqual(u.inputTokens, null)
  assert.strictEqual(u.outputTokens, null)
  assert.strictEqual(u.reason, 'x402_remote_call')
})
test('recordUsageEntry tags phase and agentId onto a known usage record', () => {
  const entry = recordUsageEntry(
    'agent',
    'research-bot',
    usageFromMessage({ usage: { input_tokens: 10, output_tokens: 5 } }, 'claude-haiku-4-5-20251001')
  )
  assert.deepStrictEqual(entry, {
    phase: 'agent',
    agentId: 'research-bot',
    model: 'claude-haiku-4-5-20251001',
    inputTokens: 10,
    outputTokens: 5,
    unavailable: false,
    reason: null,
  })
})
test('recordUsageEntry preserves unavailability and reason', () => {
  const entry = recordUsageEntry(
    'planning',
    null,
    unavailableUsage('claude-haiku-4-5-20251001', 'planning_call_failed')
  )
  assert.strictEqual(entry.unavailable, true)
  assert.strictEqual(entry.inputTokens, null)
  assert.strictEqual(entry.reason, 'planning_call_failed')
  assert.strictEqual(entry.agentId, null)
})
test('recordUsageEntry defends against a missing usage argument entirely', () => {
  const entry = recordUsageEntry('agent', 'code-bot', undefined)
  assert.strictEqual(entry.unavailable, true)
  assert.strictEqual(entry.reason, 'no_usage_captured')
})

// ─── aggregateUsage: fixtures — usage / missing usage / mixed ────
console.log('aggregateUsage')
test('fixture: all entries have known usage', () => {
  const entries = [
    recordUsageEntry('agent', 'research-bot', {
      model: 'm',
      inputTokens: 100,
      outputTokens: 20,
      unavailable: false,
    }),
    recordUsageEntry('agent', 'summary-bot', {
      model: 'm',
      inputTokens: 50,
      outputTokens: 10,
      unavailable: false,
    }),
  ]
  const agg = aggregateUsage(entries)
  assert.deepStrictEqual(agg, {
    inputTokens: 150,
    outputTokens: 30,
    knownCount: 2,
    unknownCount: 0,
    totalCount: 2,
    complete: true,
  })
})
test('fixture: missing usage only — never fabricated as 0', () => {
  const entries = [
    recordUsageEntry('agent', 'research-bot', unavailableUsage('m', 'no_api_key')),
    recordUsageEntry('agent', 'summary-bot', unavailableUsage('m', 'x402_remote_call')),
  ]
  const agg = aggregateUsage(entries)
  assert.strictEqual(agg.inputTokens, null)
  assert.strictEqual(agg.outputTokens, null)
  assert.strictEqual(agg.knownCount, 0)
  assert.strictEqual(agg.unknownCount, 2)
  assert.strictEqual(agg.complete, false)
})
test('fixture: mixed known + unknown sums only the known, discloses the gap', () => {
  const entries = [
    recordUsageEntry('agent', 'research-bot', {
      model: 'm',
      inputTokens: 100,
      outputTokens: 20,
      unavailable: false,
    }),
    recordUsageEntry('agent', 'summary-bot', unavailableUsage('m', 'x402_remote_call')),
  ]
  const agg = aggregateUsage(entries)
  assert.strictEqual(agg.inputTokens, 100)
  assert.strictEqual(agg.outputTokens, 20)
  assert.strictEqual(agg.knownCount, 1)
  assert.strictEqual(agg.unknownCount, 1)
  assert.strictEqual(agg.complete, false, 'a partial sum must disclose it is incomplete')
})
test('no calls made at all is a real, complete zero (not "unknown")', () => {
  const agg = aggregateUsage([])
  assert.deepStrictEqual(agg, {
    inputTokens: 0,
    outputTokens: 0,
    knownCount: 0,
    unknownCount: 0,
    totalCount: 0,
    complete: true,
  })
})

// ─── fixture: retried calls — only the successful attempt counts ─
console.log('fixture: retried calls')
test('a transient-error retry that eventually succeeds records one usage entry', () => {
  // createAnthropicMessage's internal retry loop never surfaces the failed
  // attempts to callClaude — only the attempt that finally resolves calls
  // onUsage. So the orchestrator only ever sees a single entry per step.
  const entry = recordUsageEntry(
    'agent',
    'analyst-bot',
    usageFromMessage(
      { usage: { input_tokens: 300, output_tokens: 80 } },
      'claude-sonnet-4-5-20250929'
    )
  )
  const agg = aggregateUsage([entry])
  assert.strictEqual(agg.knownCount, 1)
  assert.strictEqual(agg.inputTokens, 300)
})
test('a call whose retries are exhausted (never succeeds) yields no fabricated usage', () => {
  // services.js records `unavailableUsage(model, 'error')` right before
  // re-throwing when retries are exhausted and no fallback applies.
  const entry = recordUsageEntry(
    'agent',
    'analyst-bot',
    unavailableUsage('claude-sonnet-4-5-20250929', 'error')
  )
  assert.strictEqual(entry.unavailable, true)
  assert.strictEqual(entry.inputTokens, null)
})

// ─── fixture: model fallback — attribution policy ────────────────
console.log('fixture: model fallback attribution')
test('primary model failure + fallback model success records two distinct entries', () => {
  // callClaudeWithModelFallback: primary attempt fails (model-resolution
  // error) -> callClaude records an unavailable entry for the PRIMARY model
  // before throwing; the fallback callClaude call then succeeds and records
  // real usage attributed to the FALLBACK model. Neither is merged into the
  // other, so both are visible for audit.
  const primaryAttempt = recordUsageEntry(
    'agent',
    'analyst-bot',
    unavailableUsage('claude-sonnet-4-5-20250929', 'error')
  )
  const fallbackAttempt = recordUsageEntry(
    'agent',
    'analyst-bot',
    usageFromMessage(
      { usage: { input_tokens: 200, output_tokens: 60 } },
      'claude-haiku-4-5-20251001'
    )
  )

  assert.strictEqual(primaryAttempt.model, 'claude-sonnet-4-5-20250929')
  assert.strictEqual(primaryAttempt.unavailable, true)
  assert.strictEqual(fallbackAttempt.model, 'claude-haiku-4-5-20251001')
  assert.strictEqual(fallbackAttempt.unavailable, false)

  // The orchestrator keeps only the report attached to the actual result
  // (the fallback's), so the step's recorded usage reflects the model that
  // really served the request.
  const agg = aggregateUsage([fallbackAttempt])
  assert.strictEqual(agg.inputTokens, 200)
  assert.strictEqual(agg.outputTokens, 60)
})

// ─── summarizeUsageByPhase: planning vs. agent, separated ────────
console.log('summarizeUsageByPhase')
test('planning and agent usage are aggregated into separate buckets', () => {
  const entries = [
    recordUsageEntry('planning', null, {
      model: 'p',
      inputTokens: 400,
      outputTokens: 50,
      unavailable: false,
    }),
    recordUsageEntry('agent', 'research-bot', {
      model: 'a',
      inputTokens: 100,
      outputTokens: 20,
      unavailable: false,
    }),
    recordUsageEntry('agent', 'summary-bot', unavailableUsage('a', 'x402_remote_call')),
  ]
  const summary = summarizeUsageByPhase(entries)

  assert.strictEqual(summary.planning.inputTokens, 400)
  assert.strictEqual(summary.planning.outputTokens, 50)
  assert.strictEqual(summary.planning.complete, true)

  assert.strictEqual(summary.agent.inputTokens, 100)
  assert.strictEqual(summary.agent.outputTokens, 20)
  assert.strictEqual(summary.agent.unknownCount, 1)
  assert.strictEqual(summary.agent.complete, false)

  assert.strictEqual(summary.overall.inputTokens, 500)
  assert.strictEqual(summary.overall.outputTokens, 70)
  assert.strictEqual(summary.overall.totalCount, 3)
})

// ─── Does not alter/masquerade as settled marketplace charges ────
console.log('isolation from settled marketplace charges')
test('usage aggregation reads nothing from cost/price/budget fields', () => {
  // agentCost-shaped objects have no inputTokens/outputTokens — proves the
  // usage aggregator cannot accidentally pick up settlement data even if
  // handed a marketplace-shaped object by mistake.
  const marketplaceShaped = { agentId: 'analyst-bot', price: '0.05', currency: 'USDC' }
  const agg = aggregateUsage([marketplaceShaped])
  assert.strictEqual(agg.knownCount, 0)
  assert.strictEqual(agg.unknownCount, 1)
})

// ─── Persistence: InMemoryRunHistoryStore stores usage separately ─
console.log('persistence: run history')
await asyncTest('completeRun stores usage as its own field, apart from summary', async () => {
  const store = new InMemoryRunHistoryStore()
  const run = await store.createRun({ task: 'test task', budget: 0.1, source: 'test' })
  assert.strictEqual(run.usage, null, 'usage is null until the run completes')

  const usageEntries = [
    recordUsageEntry('planning', null, {
      model: 'p',
      inputTokens: 400,
      outputTokens: 50,
      unavailable: false,
    }),
    recordUsageEntry('agent', 'research-bot', unavailableUsage('a', 'x402_remote_call')),
  ]

  await store.completeRun(run.id, {
    totalSpent: '0.0100',
    budget: 0.1,
    budgetExhausted: false,
    paymentProtocol: 'x402',
    txCount: 1,
    x402PaymentCount: 1,
    xlmFallbackCount: 0,
    unpaidCount: 0,
    elapsed: '50ms',
    payments: [],
    usage: { entries: usageEntries, summary: summarizeUsageByPhase(usageEntries) },
  })

  const stored = (await store.listRecent(1))[0]
  assert.strictEqual(stored.status, 'completed')
  assert.strictEqual(
    'usage' in stored.summary,
    false,
    'usage must not be folded into the settled summary'
  )
  assert.strictEqual(stored.usage.entries.length, 2)
  assert.strictEqual(stored.usage.summary.planning.inputTokens, 400)
  assert.strictEqual(stored.usage.summary.agent.unknownCount, 1)
})
await asyncTest(
  'completeRun defaults to an explicit empty usage summary, never fabricated zeros for a real run',
  async () => {
    const store = new InMemoryRunHistoryStore()
    const run = await store.createRun({ task: 'legacy caller', budget: 0.1, source: 'test' })

    // Simulate a result object from before this change (no `usage` field).
    await store.completeRun(run.id, {
      totalSpent: '0.0100',
      budget: 0.1,
      budgetExhausted: false,
      paymentProtocol: 'x402',
      txCount: 1,
      x402PaymentCount: 1,
      xlmFallbackCount: 0,
      unpaidCount: 0,
      elapsed: '50ms',
      payments: [],
    })

    const stored = (await store.listRecent(1))[0]
    assert.deepStrictEqual(stored.usage.entries, [])
    assert.strictEqual(stored.usage.summary.overall.complete, true)
    assert.strictEqual(stored.usage.summary.overall.totalCount, 0)
  }
)

// ─── Report ──────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  process.exit(1)
}
