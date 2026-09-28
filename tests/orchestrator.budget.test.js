/**
 * Focused unit tests for orchestrator budget guardrails & exact asset accounting.
 *
 * Covers (per acceptance criteria):
 *  - `totalSpent + cost > budget` skip behavior (incl. the strict-inequality boundary)
 *  - mixed payment outcomes and fallback modes
 *  - final summary totals and skipped-step reporting
 *  - edge cases: tiny budgets, zero budget, parse failures (NaN)
 *  - exact asset amounts using integer base units (BigInt) with per-asset precision
 *  - repeated small amounts without IEEE-754 drift
 *  - exact budget equality (accepted) vs one supported unit over budget (rejected)
 *  - unsupported fractional precision validation errors
 *  - JSON round-trip serialization compatibility contract without network calls
 *
 * These import the SAME functions `orchestrator.js` uses, so a regression in the
 * real guardrail fails this suite. Dependency-free → deterministic and fast.
 *
 * Run: node tests/orchestrator.budget.test.js
 */

import assert from 'node:assert'
import {
  AssetAmount,
  agentCost,
  remainingBudget,
  formatAmount,
  exceedsBudget,
  buildSkipResult,
  buildBudgetLimitEvent,
  paymentBucket,
  tallyPaymentOutcomes,
  paymentProtocolSummary,
  isBudgetExhausted,
  countUsed,
  countSkipped,
  UnsupportedPrecisionError,
  InvalidAmountError,
  registerAsset,
  resetCustomAssets,
} from '../src/agents/budget.js'

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

// Registry-accurate fixtures (prices mirror src/agents/registry.js)
const research = { id: 'research-bot', name: '🔬 Research Agent', price: '0.01' }
const summary = { id: 'summary-bot', name: '📝 Summary Agent', price: '0.01' }
const analyst = { id: 'analyst-bot', name: '📊 Analysis Agent', price: '0.05' }
const code = { id: 'code-bot', name: '💻 Code Agent', price: '0.03' }

// ─── agentCost / parse failures ──────────────────────────────────
console.log('agentCost')
test('parses a well-formed price string into an exact AssetAmount', () => {
  const analystCost = agentCost(analyst)
  assert.ok(analystCost instanceof AssetAmount)
  assert.strictEqual(analystCost.baseUnits, 500000n)
  assert.strictEqual(analystCost.toNumber(), 0.05)
  assert.strictEqual(analystCost.toExactString(), '0.05')

  const codeCost = agentCost(code)
  assert.ok(codeCost instanceof AssetAmount)
  assert.strictEqual(codeCost.baseUnits, 300000n)
  assert.strictEqual(codeCost.toNumber(), 0.03)
})
test('returns NaN for a malformed price (parse failure)', () => {
  assert.ok(Number.isNaN(agentCost({ price: 'abc' })))
  assert.ok(Number.isNaN(agentCost({ price: undefined })))
  assert.ok(Number.isNaN(agentCost({})))
  assert.ok(Number.isNaN(agentCost(null)))
})

// ─── exceedsBudget: core skip behavior ───────────────────────────
console.log('exceedsBudget (totalSpent + cost > budget)')
test('allows a step that fits under budget', () => {
  assert.strictEqual(exceedsBudget(0, 0.01, 0.1), false)
})
test('allows a step whose cost exactly consumes remaining budget (strict >)', () => {
  // 0 + 0.05 > 0.05  →  false  → must NOT skip. Guards against `>` becoming `>=`.
  assert.strictEqual(exceedsBudget(0, 0.05, 0.05), false)
  assert.strictEqual(exceedsBudget(0.04, 0.01, 0.05), false)
})
test('skips a step that would overshoot by any amount', () => {
  assert.strictEqual(exceedsBudget(0, 0.05, 0.04), true)
  assert.strictEqual(exceedsBudget(0.05, 0.01, 0.05), true)
})
test('skips on accumulated spend even when each step is individually cheap', () => {
  // research(0.01)+summary(0.01)=0.02 spent; analyst(0.05) would hit 0.07 > 0.06
  assert.strictEqual(exceedsBudget(0.02, 0.05, 0.06), true)
})

// ─── Edge cases: zero & tiny budgets ─────────────────────────────
console.log('exceedsBudget edge cases (zero / tiny budgets)')
test('zero budget skips any non-zero-cost step', () => {
  assert.strictEqual(exceedsBudget(0, 0.01, 0), true)
})
test('zero budget allows a zero-cost step', () => {
  assert.strictEqual(exceedsBudget(0, 0, 0), false)
})
test('tiny budget below the cheapest agent skips it', () => {
  assert.strictEqual(exceedsBudget(0, 0.01, 0.005), true)
})
test('tiny budget exactly equal to cost allows the step', () => {
  assert.strictEqual(exceedsBudget(0, 0.01, 0.01), false)
})
test('NaN cost (parse failure) does not skip — comparison is false', () => {
  // NaN > budget is always false, so a malformed price falls through the guard.
  // Pinned so this real behavior changes deliberately, not by accident.
  assert.strictEqual(exceedsBudget(0, NaN, 0.05), false)
})
test('NaN budget does not skip — comparison is false', () => {
  assert.strictEqual(exceedsBudget(0, 0.01, NaN), false)
})
test('documents exact accounting at the 0.1 boundary without IEEE-754 drift', () => {
  // 0.07 + 0.03 === 0.10 exactly in integer base units (700000n + 300000n === 1000000n).
  assert.strictEqual(exceedsBudget(0.07, 0.03, 0.1), false)
  // ...but it IS > 0.09, so a 0.09 budget correctly skips the step.
  assert.strictEqual(exceedsBudget(0.07, 0.03, 0.09), true)
})

// ─── remainingBudget / formatAmount ──────────────────────────────
console.log('remainingBudget / formatAmount')
test('remainingBudget can go negative when overspent', () => {
  assert.strictEqual(formatAmount(remainingBudget(0.05, 0.03)), '0.0200')
  assert.strictEqual(formatAmount(remainingBudget(0.05, 0.06)), '-0.0100')
  const rem = remainingBudget(0.05, 0.06)
  assert.strictEqual(rem < 0, true)
  assert.ok(rem instanceof AssetAmount)
  assert.strictEqual(rem.isNegative(), true)
})
test('formatAmount always renders 4 decimal places by default', () => {
  assert.strictEqual(formatAmount(0.01), '0.0100')
  assert.strictEqual(formatAmount(0), '0.0000')
  assert.strictEqual(formatAmount(-0.01), '-0.0100')
  assert.strictEqual(formatAmount(AssetAmount.from('0.01')), '0.0100')
})

// ─── buildSkipResult: skipped-step reporting ─────────────────────
console.log('buildSkipResult (skipped-step record)')
test('produces a skipped record with agentId and reason', () => {
  const r = buildSkipResult(analyst, 0.04, 0.0)
  assert.deepStrictEqual(r, {
    agentId: 'analyst-bot',
    skipped: true,
    reason: 'Budget limit (0.0400 USDC remaining, need 0.05)',
  })
})
test('reason reflects remaining headroom after prior spend', () => {
  const r = buildSkipResult(analyst, 0.06, 0.04)
  assert.strictEqual(r.reason, 'Budget limit (0.0200 USDC remaining, need 0.05)')
})

// ─── buildBudgetLimitEvent: broadcast payload ────────────────────
console.log('buildBudgetLimitEvent (broadcast payload, no timestamp)')
test('builds a budget_limit event without a timestamp', () => {
  const ev = buildBudgetLimitEvent(analyst, 0.04, 0.0)
  assert.deepStrictEqual(ev, {
    type: 'budget_limit',
    agent: '📊 Analysis Agent',
    cost: '0.05',
    remaining: '0.0400',
  })
  assert.strictEqual('timestamp' in ev, false)
})

// ─── paymentBucket: payment outcomes & fallback modes ────────────
console.log('paymentBucket (payment outcomes / fallback modes)')
test('classifies a confirmed x402 payment', () => {
  assert.strictEqual(paymentBucket('x402'), 'x402')
})
test('classifies the direct-XLM fallback', () => {
  assert.strictEqual(paymentBucket('stellar-xlm-direct'), 'stellar-xlm')
})
test('classifies unpaid / unknown / missing outcomes as unpaid', () => {
  assert.strictEqual(paymentBucket('none'), 'unpaid')
  assert.strictEqual(paymentBucket(undefined), 'unpaid')
  assert.strictEqual(paymentBucket(null), 'unpaid')
  assert.strictEqual(paymentBucket(''), 'unpaid')
  assert.strictEqual(paymentBucket('something-else'), 'unpaid')
})

// ─── tallyPaymentOutcomes ────────────────────────────────────────
console.log('tallyPaymentOutcomes')
test('tallies a mixed run correctly', () => {
  const counts = tallyPaymentOutcomes(['x402', 'stellar-xlm-direct', 'none', 'x402', undefined])
  assert.deepStrictEqual(counts, { x402PaymentCount: 2, xlmFallbackCount: 1, unpaidCount: 2 })
})
test('empty / missing input yields all zeros', () => {
  assert.deepStrictEqual(tallyPaymentOutcomes([]), {
    x402PaymentCount: 0,
    xlmFallbackCount: 0,
    unpaidCount: 0,
  })
  assert.deepStrictEqual(tallyPaymentOutcomes(undefined), {
    x402PaymentCount: 0,
    xlmFallbackCount: 0,
    unpaidCount: 0,
  })
})

// ─── paymentProtocolSummary ──────────────────────────────────────
console.log('paymentProtocolSummary')
test('reports x402-only, xlm-only, mixed, and none', () => {
  assert.strictEqual(paymentProtocolSummary(2, 0), 'x402')
  assert.strictEqual(paymentProtocolSummary(0, 3), 'stellar-xlm')
  assert.strictEqual(paymentProtocolSummary(1, 1), 'mixed')
  assert.strictEqual(paymentProtocolSummary(0, 0), 'none')
})

// ─── isBudgetExhausted: summary flag ─────────────────────────────
console.log('isBudgetExhausted')
test('true only when spend meets or exceeds budget', () => {
  assert.strictEqual(isBudgetExhausted(0.04, 0.05), false)
  assert.strictEqual(isBudgetExhausted(0.05, 0.05), true)
  assert.strictEqual(isBudgetExhausted(0.06, 0.05), true)
})
test('zero budget is considered exhausted from the start', () => {
  assert.strictEqual(isBudgetExhausted(0, 0), true)
})

// ─── countUsed / countSkipped: summary totals ────────────────────
console.log('countUsed / countSkipped (summary totals)')
test('counts used vs skipped across a mixed results array', () => {
  const results = [
    { agentId: 'research-bot', skipped: undefined }, // ran
    { agentId: 'analyst-bot', skipped: true }, // skipped
    { agentId: 'code-bot' }, // ran
  ]
  assert.strictEqual(countUsed(results), 2)
  assert.strictEqual(countSkipped(results), 1)
})
test('an "agent not found" error entry counts as used (pins current behavior)', () => {
  const results = [{ agentId: 'ghost-bot', error: 'Agent not found' }]
  assert.strictEqual(countUsed(results), 1)
  assert.strictEqual(countSkipped(results), 0)
})
test('empty results yield zero used and zero skipped', () => {
  assert.strictEqual(countUsed([]), 0)
  assert.strictEqual(countSkipped([]), 0)
})

// ─── Integration: deterministic end-to-end budget run ────────────
console.log('integration: simulated budget run')
function simulateRun(agents, budget, paidViaFor = () => 'x402') {
  const results = []
  let totalSpent = AssetAmount.zero('USDC')
  const exactBudget = AssetAmount.from(budget, 'USDC')
  const paidViaList = []
  for (const agent of agents) {
    const cost = agentCost(agent)
    if (exceedsBudget(totalSpent, cost, exactBudget)) {
      results.push(buildSkipResult(agent, exactBudget, totalSpent))
      continue
    }
    totalSpent = totalSpent.plus(cost)
    const paidVia = paidViaFor(agent)
    paidViaList.push(paidVia)
    results.push({ agentId: agent.id, skipped: false, paidVia })
  }
  const { x402PaymentCount, xlmFallbackCount, unpaidCount } = tallyPaymentOutcomes(paidViaList)
  return {
    totalSpent: formatAmount(totalSpent),
    totalSpentExact: totalSpent.toJSON(),
    budgetExhausted: isBudgetExhausted(totalSpent, exactBudget),
    agentsUsed: countUsed(results),
    agentsSkipped: countSkipped(results),
    paymentProtocol: paymentProtocolSummary(x402PaymentCount, xlmFallbackCount),
    x402PaymentCount,
    xlmFallbackCount,
    unpaidCount,
    results,
  }
}

test('a generous budget runs every step and never overspends', () => {
  const out = simulateRun([research, summary, analyst, code], 1.0)
  assert.strictEqual(out.agentsUsed, 4)
  assert.strictEqual(out.agentsSkipped, 0)
  assert.strictEqual(out.totalSpent, '0.1000')
  assert.strictEqual(out.budgetExhausted, false)
})

test('a low budget runs the affordable steps and skips the rest (overrun prevention)', () => {
  // budget 0.02: research(0.01) ✓, summary(0.01) ✓ → 0.02 spent;
  // analyst(0.05) skip, code(0.03) skip. totalSpent never exceeds budget.
  const out = simulateRun([research, summary, analyst, code], 0.02)
  assert.strictEqual(out.agentsUsed, 2)
  assert.strictEqual(out.agentsSkipped, 2)
  assert.strictEqual(out.totalSpent, '0.0200')
  assert.strictEqual(out.budgetExhausted, true)
  assert.strictEqual(parseFloat(out.totalSpent) <= 0.02, true)
  const skipped = out.results.filter((r) => r.skipped).map((r) => r.agentId)
  assert.deepStrictEqual(skipped, ['analyst-bot', 'code-bot'])
})

test('zero budget skips everything and spends nothing', () => {
  const out = simulateRun([research, summary, analyst, code], 0)
  assert.strictEqual(out.agentsUsed, 0)
  assert.strictEqual(out.agentsSkipped, 4)
  assert.strictEqual(out.totalSpent, '0.0000')
  assert.strictEqual(out.paymentProtocol, 'none')
})

test('mixed payment outcomes produce a mixed protocol summary', () => {
  const paidViaFor = (a) => (a.id === 'analyst-bot' ? 'stellar-xlm-direct' : 'x402')
  const out = simulateRun([research, summary, analyst, code], 1.0, paidViaFor)
  assert.strictEqual(out.x402PaymentCount, 3)
  assert.strictEqual(out.xlmFallbackCount, 1)
  assert.strictEqual(out.unpaidCount, 0)
  assert.strictEqual(out.paymentProtocol, 'mixed')
})

// ─── Scope & Validation per Issue #129 ────────────────────────────

// 1. Repeated small amounts
console.log('exact accounting: repeated small amounts')
test('repeated additions of 0.01 USDC avoid IEEE-754 drift', () => {
  // In IEEE-754 floats: 0.01 * 10 is 0.09999999999999999
  let floatSum = 0
  for (let i = 0; i < 10; i++) floatSum += 0.01
  assert.notStrictEqual(floatSum, 0.1) // proves float imperfection

  // With exact base units (100,000 stroops * 10 = 1,000,000 stroops = 0.1000000)
  let exactSum = AssetAmount.zero('USDC')
  const step = AssetAmount.from('0.01', 'USDC')
  for (let i = 0; i < 10; i++) {
    exactSum = exactSum.plus(step)
  }
  assert.strictEqual(exactSum.baseUnits, 1000000n)
  assert.strictEqual(exactSum.toExactString(), '0.1')
  assert.strictEqual(exactSum.toDecimalString(7), '0.1000000')
  assert.strictEqual(exactSum.equals(AssetAmount.from('0.1', 'USDC')), true)
})

test('repeated additions of 100 steps of 0.001 USDC produce exact 0.1000000', () => {
  let sum = AssetAmount.zero('USDC')
  const microStep = AssetAmount.from('0.001', 'USDC')
  for (let i = 0; i < 100; i++) {
    sum = sum.plus(microStep)
  }
  assert.strictEqual(sum.baseUnits, 1000000n)
  assert.strictEqual(sum.toDecimalString(4), '0.1000')
})

test('repeated additions of 1 stroop (0.0000001) scale losslessly', () => {
  let sum = AssetAmount.zero('USDC')
  const oneStroop = AssetAmount.fromBaseUnits(1n, 'USDC')
  for (let i = 0; i < 10000; i++) {
    sum = sum.plus(oneStroop)
  }
  assert.strictEqual(sum.baseUnits, 10000n)
  assert.strictEqual(sum.toDecimalString(7), '0.0010000')
  assert.strictEqual(sum.toExactString(), '0.001')
})

// 2. Exact equality
console.log('exact accounting: exact equality')
test('exact-budget plan is accepted and consumes budget completely', () => {
  const budget = AssetAmount.from('0.05', 'USDC')
  const cost = AssetAmount.from('0.05', 'USDC')

  // Step must be accepted when cost === remaining budget (strict >)
  assert.strictEqual(exceedsBudget(0, cost, budget), false)

  const remaining = remainingBudget(budget, cost)
  assert.ok(remaining instanceof AssetAmount)
  assert.strictEqual(remaining.baseUnits, 0n)
  assert.strictEqual(remaining.isZero(), true)
  assert.strictEqual(isBudgetExhausted(cost, budget), true)
})

test('multi-step plan consuming exact budget succeeds without premature cutoff', () => {
  // 0.01 + 0.01 + 0.05 + 0.03 === 0.10 exact
  const out = simulateRun([research, summary, analyst, code], 0.1)
  assert.strictEqual(out.agentsUsed, 4)
  assert.strictEqual(out.agentsSkipped, 0)
  assert.strictEqual(out.totalSpent, '0.1000')
  assert.strictEqual(out.budgetExhausted, true)
})

// 3. One-unit differences
console.log('exact accounting: one-unit differences')
test('plan one supported unit over budget is rejected', () => {
  // For USDC (precision 7), 1 supported unit is 1 stroop = 0.0000001
  const budget = AssetAmount.from('0.0500000', 'USDC') // 500,000 stroops
  const exactCost = AssetAmount.from('0.0500000', 'USDC') // 500,000 stroops
  const oneUnitOver = AssetAmount.from('0.0500001', 'USDC') // 500,001 stroops
  const oneUnitUnder = AssetAmount.from('0.0499999', 'USDC') // 499,999 stroops

  // Exact cost is accepted
  assert.strictEqual(exceedsBudget(0, exactCost, budget), false)

  // One unit under is accepted
  assert.strictEqual(exceedsBudget(0, oneUnitUnder, budget), false)

  // One unit over is rejected
  assert.strictEqual(exceedsBudget(0, oneUnitOver, budget), true)
})

test('cumulative spend respects one-unit boundary across multiple steps', () => {
  const budget = AssetAmount.from('0.0500000', 'USDC')
  const spentPrior = AssetAmount.from('0.0499999', 'USDC')
  const stepOneStroop = AssetAmount.from('0.0000001', 'USDC')
  const stepTwoStroops = AssetAmount.from('0.0000002', 'USDC')

  // Prior spend + 1 stroop = exact budget -> accepted
  assert.strictEqual(exceedsBudget(spentPrior, stepOneStroop, budget), false)

  // Prior spend + 2 stroops = 1 stroop over budget -> rejected
  assert.strictEqual(exceedsBudget(spentPrior, stepTwoStroops, budget), true)
})

// 4. Unsupported fractional precision
console.log('exact accounting: unsupported fractional precision')
test('unsupported fractional precision returns a defined validation error', () => {
  // USDC allows at most 7 decimals (1 stroop)
  assert.throws(
    () => AssetAmount.from('0.01000001', 'USDC'), // 8 decimals
    (err) => {
      assert.ok(err instanceof UnsupportedPrecisionError)
      assert.strictEqual(err.code, 'UNSUPPORTED_PRECISION')
      assert.strictEqual(err.details.maxPrecision, 7)
      assert.strictEqual(err.details.receivedPrecision, 8)
      assert.strictEqual(err.status, 400)
      return true
    }
  )

  assert.throws(
    () => AssetAmount.from('0.00000001', 'USDC'), // 8 decimals
    (err) => {
      assert.strictEqual(err.code, 'UNSUPPORTED_PRECISION')
      return true
    }
  )
})

test('per-asset custom precision enforces configured limits', () => {
  try {
    registerAsset('FIAT_USD', 2)
    registerAsset('MICRO', 4)

    // FIAT_USD allows 2 decimals
    const validFiat = AssetAmount.from('12.50', 'FIAT_USD')
    assert.strictEqual(validFiat.baseUnits, 1250n)
    assert.strictEqual(validFiat.precision, 2)

    // 3 decimals on 2-decimal asset throws
    assert.throws(
      () => AssetAmount.from('12.505', 'FIAT_USD'),
      (err) => {
        assert.ok(err instanceof UnsupportedPrecisionError)
        assert.strictEqual(err.details.maxPrecision, 2)
        assert.strictEqual(err.details.receivedPrecision, 3)
        return true
      }
    )

    // MICRO allows 4 decimals
    const validMicro = AssetAmount.from('0.0001', 'MICRO')
    assert.strictEqual(validMicro.baseUnits, 1n)

    // 5 decimals throws
    assert.throws(
      () => AssetAmount.from('0.00001', 'MICRO'),
      (err) => err instanceof UnsupportedPrecisionError
    )
  } finally {
    resetCustomAssets()
  }
})

test('malformed amount strings throw InvalidAmountError', () => {
  assert.throws(
    () => AssetAmount.from('not-a-number'),
    (err) => err instanceof InvalidAmountError
  )
  assert.throws(
    () => AssetAmount.from(''),
    (err) => err instanceof InvalidAmountError
  )
  assert.throws(
    () => AssetAmount.from('   '),
    (err) => err instanceof InvalidAmountError
  )
  assert.throws(
    () => AssetAmount.from('0.1.2'),
    (err) => err instanceof InvalidAmountError
  )
})

// 5. JSON-safe serialization and round trips
console.log('exact accounting: JSON round trips & compatibility contract')
test('AssetAmount produces JSON-safe structured representation without BigInt errors', () => {
  const amt = AssetAmount.from('0.0500001', 'USDC')
  const json = JSON.stringify(amt)

  // Standard JSON.stringify works (no TypeError: Do not know how to serialize a BigInt)
  assert.strictEqual(typeof json, 'string')
  const parsed = JSON.parse(json)

  assert.deepStrictEqual(parsed, {
    amount: '0.0500001',
    baseUnits: '500001',
    asset: 'USDC',
    precision: 7,
  })

  // Full round trip reconstitution
  const reconstituted = AssetAmount.from(parsed)
  assert.strictEqual(reconstituted.baseUnits, amt.baseUnits)
  assert.strictEqual(reconstituted.asset, amt.asset)
  assert.strictEqual(reconstituted.precision, amt.precision)
  assert.strictEqual(reconstituted.equals(amt), true)
})

test('round trips preserve zero, 1 stroop, large, and negative values', () => {
  const fixtures = [
    '0.0000000',
    '0.0000001', // 1 stroop
    '0.0100000',
    '0.0500000',
    '1000000.1234567',
    '-0.0100000',
  ]
  for (const f of fixtures) {
    const original = AssetAmount.from(f, 'USDC')
    const jsonStr = JSON.stringify(original)
    const reconstituted = AssetAmount.from(JSON.parse(jsonStr))
    assert.strictEqual(
      reconstituted.baseUnits,
      original.baseUnits,
      `Base units mismatch for fixture: ${f}`
    )
    assert.strictEqual(reconstituted.toDecimalString(7), original.toDecimalString(7))
  }
})

test('orchestrator result object round-trips through JSON without network calls', () => {
  const out = simulateRun([research, summary], 0.05)
  const json = JSON.stringify(out)
  const parsed = JSON.parse(json)

  assert.strictEqual(parsed.totalSpent, '0.0200')
  assert.deepStrictEqual(parsed.totalSpentExact, {
    amount: '0.0200000',
    baseUnits: '200000',
    asset: 'USDC',
    precision: 7,
  })

  const fromParsed = AssetAmount.from(parsed.totalSpentExact)
  assert.strictEqual(fromParsed.baseUnits, 200000n)
})

// ─── Report ──────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  process.exit(1)
}
