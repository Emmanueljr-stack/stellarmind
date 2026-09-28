/**
 * Provider token usage tracking (issue #152).
 *
 * The service layer previously reduced Claude responses to plain text and
 * discarded `message.usage`, so operators could see marketplace price totals
 * but had no visibility into actual model token consumption.
 *
 * These helpers capture usage per provider call, keep it separate from
 * settled marketplace charges (agent.price / totalSpent / budget), and
 * aggregate it per run.
 *
 * Attribution policy:
 *  - Retries: `createAnthropicMessage` retries transient errors internally
 *    and only ever returns the attempt that succeeded, so only that final
 *    attempt yields a usage entry. Nothing is recorded for the transient
 *    attempts that were retried away.
 *  - Model fallback (`callClaudeWithModelFallback`): usage is attributed to
 *    whichever model actually served the request. If the primary model call
 *    fails outright (before falling back), that failed attempt is recorded
 *    as an explicit "unavailable" entry for the primary model — it is never
 *    merged into or mistaken for the fallback model's usage.
 *  - x402-settled agent calls: the orchestrator pays a remote premium
 *    endpoint over HTTP for these and never calls the Claude API itself, so
 *    provider usage for that step is genuinely unknown. It is recorded as
 *    unavailable, never fabricated as zero.
 *  - Demo/fallback responses (no API key, or credits exhausted): no provider
 *    call was made, so usage is recorded as unavailable.
 *
 * Every entry is either fully known (numeric inputTokens/outputTokens) or
 * explicitly `unavailable: true` — never a fabricated zero.
 */

/**
 * Build a usage record from an Anthropic SDK message response.
 * Returns an unavailable record if the response has no numeric usage.
 */
export function usageFromMessage(msg, model) {
  const usage = msg?.usage
  const hasUsage =
    usage && typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number'

  if (!hasUsage) {
    return unavailableUsage(model || msg?.model || null, 'no_usage_in_response')
  }

  return {
    model: model || msg?.model || null,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    unavailable: false,
    reason: null,
  }
}

/**
 * An explicit "we don't know" usage record. `reason` documents why.
 */
export function unavailableUsage(model, reason) {
  return {
    model: model || null,
    inputTokens: null,
    outputTokens: null,
    unavailable: true,
    reason: reason || 'unknown',
  }
}

/**
 * Wrap a raw usage record (from usageFromMessage / unavailableUsage) into a
 * per-step/per-phase entry suitable for accumulation on a run.
 *
 * phase: 'planning' | 'agent'
 */
export function recordUsageEntry(phase, agentId, usage) {
  const safeUsage = usage || unavailableUsage(null, 'no_usage_captured')
  return {
    phase,
    agentId: agentId || null,
    model: safeUsage.model || null,
    inputTokens: safeUsage.unavailable ? null : safeUsage.inputTokens,
    outputTokens: safeUsage.unavailable ? null : safeUsage.outputTokens,
    unavailable: !!safeUsage.unavailable,
    reason: safeUsage.unavailable ? safeUsage.reason || 'unknown' : null,
  }
}

/**
 * Sum a list of usage entries. Known entries (unavailable === false with
 * numeric tokens) are summed; unavailable entries are counted but never
 * treated as zero. `complete` is true only when every entry in the list had
 * known usage (or the list was empty).
 */
export function aggregateUsage(entries = []) {
  const known = entries.filter(
    (e) =>
      e && !e.unavailable && typeof e.inputTokens === 'number' && typeof e.outputTokens === 'number'
  )
  const unknownCount = entries.length - known.length

  if (known.length === 0) {
    return {
      inputTokens: entries.length === 0 ? 0 : null,
      outputTokens: entries.length === 0 ? 0 : null,
      knownCount: 0,
      unknownCount,
      totalCount: entries.length,
      complete: entries.length === 0,
    }
  }

  return {
    inputTokens: known.reduce((sum, e) => sum + e.inputTokens, 0),
    outputTokens: known.reduce((sum, e) => sum + e.outputTokens, 0),
    knownCount: known.length,
    unknownCount,
    totalCount: entries.length,
    complete: unknownCount === 0,
  }
}

/**
 * Aggregate usage separately for planning vs. agent-step calls, plus an
 * overall total. Planning and agent usage are always reported as distinct
 * buckets (acceptance criterion: "Planning and agent usage are recorded
 * separately").
 */
export function summarizeUsageByPhase(entries = []) {
  const planning = entries.filter((e) => e?.phase === 'planning')
  const agent = entries.filter((e) => e?.phase === 'agent')

  return {
    planning: aggregateUsage(planning),
    agent: aggregateUsage(agent),
    overall: aggregateUsage(entries),
  }
}
