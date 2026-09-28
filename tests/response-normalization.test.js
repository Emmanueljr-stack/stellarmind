/**
 * Tests for content-block normalization and planning validation (issue #150).
 *
 * Covers (per acceptance criteria):
 *  - All supported text blocks are combined, in documented (array) order.
 *  - Empty and unsupported-only responses produce a structured outcome.
 *  - Token-limit truncation is exposed, never silently treated as complete.
 *  - Planning rejects an incomplete JSON result before execution.
 *
 * Run: node tests/response-normalization.test.js
 */

import assert from 'node:assert'
import { normalizeContent } from '../src/agents/response-normalization.js'
import { parsePlanResponse } from '../src/agents/orchestrator.js'

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

function textBlock(text) {
  return { type: 'text', text }
}

// ─── normalizeContent: text-only fixture ──────────────────────────
console.log('normalizeContent — text-only response')
test('single text block: text passes through, complete, not truncated/empty', () => {
  const msg = { content: [textBlock('hello world')], stop_reason: 'end_turn' }
  const result = normalizeContent(msg)
  assert.strictEqual(result.text, 'hello world')
  assert.deepStrictEqual(result.blockTypes, ['text'])
  assert.strictEqual(result.stopReason, 'end_turn')
  assert.strictEqual(result.truncated, false)
  assert.strictEqual(result.empty, false)
  assert.strictEqual(result.complete, true)
})

// ─── normalizeContent: multiple-text fixture ──────────────────────
console.log('normalizeContent — multiple text blocks')
test('multiple text blocks are combined in array order', () => {
  const msg = {
    content: [textBlock('first'), textBlock('second'), textBlock('third')],
    stop_reason: 'end_turn',
  }
  const result = normalizeContent(msg)
  assert.strictEqual(result.text, 'first\n\nsecond\n\nthird')
  assert.deepStrictEqual(result.blockTypes, ['text', 'text', 'text'])
  assert.strictEqual(result.complete, true)
})

// ─── normalizeContent: mixed-block fixture ────────────────────────
console.log('normalizeContent — mixed block types')
test('non-text blocks are inventoried but excluded from text, order preserved', () => {
  const msg = {
    content: [textBlock('before'), { type: 'tool_use', id: 't1' }, textBlock('after')],
    stop_reason: 'tool_use',
  }
  const result = normalizeContent(msg)
  assert.strictEqual(result.text, 'before\n\nafter')
  assert.deepStrictEqual(result.blockTypes, ['text', 'tool_use', 'text'])
  assert.strictEqual(result.empty, false)
})

test('unsupported-only content (no text blocks) is marked empty, not silently blank', () => {
  const msg = { content: [{ type: 'tool_use', id: 't1' }], stop_reason: 'tool_use' }
  const result = normalizeContent(msg)
  assert.strictEqual(result.text, '')
  assert.strictEqual(result.empty, true)
  assert.strictEqual(result.complete, false)
})

// ─── normalizeContent: empty fixture ──────────────────────────────
console.log('normalizeContent — empty response')
test('empty content array is marked empty', () => {
  const msg = { content: [], stop_reason: 'end_turn' }
  const result = normalizeContent(msg)
  assert.strictEqual(result.text, '')
  assert.deepStrictEqual(result.blockTypes, [])
  assert.strictEqual(result.empty, true)
  assert.strictEqual(result.complete, false)
})

test('missing content field is treated as empty, not a crash', () => {
  const result = normalizeContent({ stop_reason: 'end_turn' })
  assert.strictEqual(result.text, '')
  assert.strictEqual(result.empty, true)
})

// ─── normalizeContent: token-limited fixture ──────────────────────
console.log('normalizeContent — token-limit truncation')
test('stop_reason "max_tokens" is exposed as truncated, even with partial text', () => {
  const msg = { content: [textBlock('partial answer that got cut o')], stop_reason: 'max_tokens' }
  const result = normalizeContent(msg)
  assert.strictEqual(result.text, 'partial answer that got cut o')
  assert.strictEqual(result.truncated, true)
  // Truncation alone is enough to make it incomplete, even though text exists.
  assert.strictEqual(result.complete, false)
})

test('a truncated-but-empty response is both truncated and empty', () => {
  const msg = { content: [], stop_reason: 'max_tokens' }
  const result = normalizeContent(msg)
  assert.strictEqual(result.truncated, true)
  assert.strictEqual(result.empty, true)
  assert.strictEqual(result.complete, false)
})

test('non-"max_tokens" stop reasons are not treated as truncated', () => {
  const msg = { content: [textBlock('done')], stop_reason: 'stop_sequence' }
  const result = normalizeContent(msg)
  assert.strictEqual(result.truncated, false)
  assert.strictEqual(result.complete, true)
})

// ─── parsePlanResponse: valid plan ─────────────────────────────────
console.log('parsePlanResponse — valid plan')
test('a complete, well-formed JSON plan parses through', () => {
  const msg = {
    content: [
      textBlock(
        JSON.stringify({
          plan: 'research then summarize',
          subtasks: [{ agentId: 'research-bot', input: 'topic', cost: '0.01' }],
        })
      ),
    ],
    stop_reason: 'end_turn',
  }
  const plan = parsePlanResponse(msg)
  assert.strictEqual(plan.plan, 'research then summarize')
  assert.strictEqual(plan.subtasks.length, 1)
})

test('markdown code fences around the JSON are stripped', () => {
  const msg = {
    content: [textBlock('```json\n{"plan":"x","subtasks":[]}\n```')],
    stop_reason: 'end_turn',
  }
  const plan = parsePlanResponse(msg)
  assert.strictEqual(plan.plan, 'x')
  assert.deepStrictEqual(plan.subtasks, [])
})

test('multiple text blocks are combined before JSON parsing', () => {
  // A plan split across two text blocks should still parse once combined —
  // this only works because parsePlanResponse uses normalizeContent (which
  // joins every text block) instead of reading content[0] alone. Extra
  // whitespace from the join is valid between JSON tokens.
  const msg = {
    content: [textBlock('{"plan":"combined",'), textBlock('"subtasks":[]}')],
    stop_reason: 'end_turn',
  }
  const plan = parsePlanResponse(msg)
  assert.strictEqual(plan.plan, 'combined')
  assert.deepStrictEqual(plan.subtasks, [])
})

// ─── parsePlanResponse: rejection fixtures ─────────────────────────
console.log('parsePlanResponse — rejects incomplete/invalid results before execution')
test('a token-limit-truncated plan is rejected, never executed', () => {
  const msg = {
    content: [textBlock('{"plan":"cut off","subtasks":[{"agentId":"research-b')],
    stop_reason: 'max_tokens',
  }
  assert.throws(
    () => parsePlanResponse(msg),
    (err) => err.code === 'PLAN_TRUNCATED'
  )
})

test('an empty (no text block) plan response is rejected, never executed', () => {
  const msg = { content: [{ type: 'tool_use', id: 't1' }], stop_reason: 'tool_use' }
  assert.throws(
    () => parsePlanResponse(msg),
    (err) => err.code === 'PLAN_EMPTY'
  )
})

test('malformed JSON is rejected rather than crashing the caller uncaught', () => {
  const msg = { content: [textBlock('not json at all')], stop_reason: 'end_turn' }
  assert.throws(
    () => parsePlanResponse(msg),
    (err) => err.code === 'PLAN_INVALID_JSON'
  )
})

test('valid JSON with no "subtasks" array is rejected, not silently run as zero subtasks', () => {
  // This is the real historical bug: content[0] non-text defaulted the plan
  // text to '{}', which parsed successfully into an empty plan and ran
  // silently with zero agents. It must be rejected explicitly instead.
  const msg = { content: [textBlock('{}')], stop_reason: 'end_turn' }
  assert.throws(
    () => parsePlanResponse(msg),
    (err) => err.code === 'PLAN_MISSING_SUBTASKS'
  )
})

test('"subtasks" present but not an array is rejected', () => {
  const msg = {
    content: [textBlock(JSON.stringify({ plan: 'x', subtasks: 'not-an-array' }))],
    stop_reason: 'end_turn',
  }
  assert.throws(
    () => parsePlanResponse(msg),
    (err) => err.code === 'PLAN_MISSING_SUBTASKS'
  )
})

// ─── Summary ────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  process.exit(1)
}
