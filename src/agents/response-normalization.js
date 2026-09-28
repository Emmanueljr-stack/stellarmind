/**
 * Provider content-block normalization (issue #150).
 *
 * The service layer and the planner each read only `content[0]` and assumed
 * it was a single text block. That silently dropped any additional text
 * blocks, mishandled responses with no text block at all (empty array, or
 * only non-text blocks such as `tool_use`), and never looked at
 * `stop_reason` — so a response cut off by the token limit was treated the
 * same as a complete one.
 *
 * `normalizeContent` produces one structured outcome for any Anthropic
 * message response so callers decide what to do with a truncated or empty
 * result intentionally, instead of silently continuing with a partial or
 * blank string.
 */

/**
 * @param {{content?: Array<{type?: string, text?: string}>, stop_reason?: string}} msg
 * @returns {{
 *   text: string,
 *   blockTypes: string[],
 *   stopReason: string|null,
 *   truncated: boolean,
 *   empty: boolean,
 *   complete: boolean,
 * }}
 */
export function normalizeContent(msg) {
  const blocks = Array.isArray(msg?.content) ? msg.content : []
  const blockTypes = blocks.map((block) => block?.type || 'unknown')

  // Documented order: every text block is combined in the order it appears
  // in `content`, joined by a blank line. Non-text blocks (e.g. `tool_use`,
  // `thinking`) are recorded in `blockTypes` but excluded from `text`.
  const textBlocks = blocks.filter(
    (block) => block?.type === 'text' && typeof block.text === 'string'
  )
  const text = textBlocks.map((block) => block.text).join('\n\n')

  const stopReason = msg?.stop_reason || null
  const truncated = stopReason === 'max_tokens'
  // Empty and unsupported-only responses both produce zero text blocks.
  const empty = textBlocks.length === 0

  return {
    text,
    blockTypes,
    stopReason,
    truncated,
    empty,
    // A response only counts as a complete answer when it produced text
    // AND wasn't cut off by the token limit.
    complete: !empty && !truncated,
  }
}
