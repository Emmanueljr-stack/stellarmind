/**
 * Exact Asset Amount Representation & Accounting.
 *
 * Implements exact monetary accounting using integer base units (BigInt) with
 * explicit per-asset precision, replacing floating-point parseFloat and number
 * addition throughout budget admission, guardrails, and spend tracking.
 *
 * All calculations are dependency-free (no external packages, network, or SDKs)
 * ensuring deterministic execution and fast in-memory unit testing.
 *
 * Precision & Unit Rules:
 * - Stellar standard: 7 decimal places for XLM and credit assets like USDC
 *   (1 unit = 10,000,000 base units / stroops).
 * - Admission Rounding Rule: Unsupported fractional precision exceeding the
 *   asset's precision is strictly rejected with UnsupportedPrecisionError,
 *   preventing silent truncation or rounding discrepancies.
 * - Arithmetic: Lossless integer base unit arithmetic with zero IEEE-754 drift.
 * - Serialization Contract: Serialized amounts are JSON-safe, avoiding raw
 *   BigInt serialization failures while preserving lossless round-trip fidelity.
 */

export const ASSET_PRECISION = Object.freeze({
  USDC: 7,
  XLM: 7,
})

export const DEFAULT_ASSET = 'USDC'

const customAssetRegistry = new Map()

/**
 * Register or override an asset's precision.
 * @param {string} asset
 * @param {number} precision
 */
export function registerAsset(asset, precision) {
  if (typeof asset !== 'string' || !asset.trim()) {
    throw new Error('Asset code must be a non-empty string')
  }
  if (!Number.isInteger(precision) || precision < 0 || precision > 18) {
    throw new Error(`Precision must be an integer between 0 and 18, got ${precision}`)
  }
  customAssetRegistry.set(asset.toUpperCase(), precision)
}

/**
 * Reset custom asset registrations (mainly for test cleanup).
 */
export function resetCustomAssets() {
  customAssetRegistry.clear()
}

/**
 * Retrieve the configured decimal precision for an asset.
 * Defaults to 7 (Stellar standard) if unconfigured.
 * @param {string} [asset='USDC']
 * @returns {number}
 */
export function getAssetPrecision(asset = DEFAULT_ASSET) {
  if (typeof asset !== 'string') return 7
  const upper = asset.toUpperCase()
  if (customAssetRegistry.has(upper)) {
    return customAssetRegistry.get(upper)
  }
  if (upper in ASSET_PRECISION) {
    return ASSET_PRECISION[upper]
  }
  return 7
}

/**
 * Validation error thrown when an input amount contains fractional decimal
 * places exceeding the asset's configured precision.
 */
export class UnsupportedPrecisionError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'UnsupportedPrecisionError'
    this.code = 'UNSUPPORTED_PRECISION'
    this.status = 400
    this.details = details
  }
}

/**
 * Validation error thrown when an amount input is malformed, non-numeric,
 * or violates basic format constraints.
 */
export class InvalidAmountError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'InvalidAmountError'
    this.code = 'INVALID_AMOUNT'
    this.status = 400
    this.details = details
  }
}

/**
 * Error thrown when attempting arithmetic or comparison between different assets.
 */
export class AssetMismatchError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'AssetMismatchError'
    this.code = 'ASSET_MISMATCH'
    this.status = 400
    this.details = details
  }
}

/**
 * Converts a JS number to decimal string avoiding scientific notation.
 * @param {number} num
 * @returns {string}
 */
function numberToDecimalString(num) {
  if (!Number.isFinite(num)) {
    throw new InvalidAmountError(`Number must be finite: ${num}`)
  }
  const str = num.toString()
  if (!str.includes('e') && !str.includes('E')) {
    return str
  }
  const [coefficient, exponentStr] = str.toLowerCase().split('e')
  const exponent = parseInt(exponentStr, 10)
  if (exponent < 0) {
    const coeffParts = coefficient.split('.')
    const intPart = coeffParts[0].replace('-', '')
    const fracPart = coeffParts[1] || ''
    const sign = num < 0 ? '-' : ''
    const leadingZeros = '0'.repeat(Math.abs(exponent) - 1)
    return `${sign}0.${leadingZeros}${intPart}${fracPart}`
  } else {
    const coeffParts = coefficient.split('.')
    const intPart = coeffParts[0]
    const fracPart = coeffParts[1] || ''
    const shift = exponent - fracPart.length
    if (shift >= 0) {
      return `${intPart}${fracPart}${'0'.repeat(shift)}`
    } else {
      return `${intPart}${fracPart.slice(0, exponent)}.${fracPart.slice(exponent)}`
    }
  }
}

/**
 * Exact monetary amount represented in integer base units.
 */
export class AssetAmount {
  /**
   * @param {bigint} baseUnits - Base units integer (e.g. stroops for 7-dec assets)
   * @param {string} [asset='USDC'] - Asset code
   * @param {number} [precision] - Explicit precision (defaults to asset precision)
   */
  constructor(baseUnits, asset = DEFAULT_ASSET, precision) {
    if (typeof baseUnits !== 'bigint') {
      throw new InvalidAmountError(`Base units must be a bigint, got ${typeof baseUnits}`)
    }
    this.baseUnits = baseUnits
    this.asset = typeof asset === 'string' ? asset.toUpperCase() : DEFAULT_ASSET
    this.precision = precision !== undefined ? precision : getAssetPrecision(this.asset)
  }

  /**
   * Create an AssetAmount initialized to zero base units.
   * @param {string} [asset='USDC']
   * @returns {AssetAmount}
   */
  static zero(asset = DEFAULT_ASSET) {
    return new AssetAmount(0n, asset)
  }

  /**
   * Construct an AssetAmount directly from raw base units.
   * @param {bigint|number|string} baseUnits
   * @param {string} [asset='USDC']
   * @param {number} [precision]
   * @returns {AssetAmount}
   */
  static fromBaseUnits(baseUnits, asset = DEFAULT_ASSET, precision) {
    return new AssetAmount(BigInt(baseUnits), asset, precision)
  }

  /**
   * Parse / convert an arbitrary input into an AssetAmount at API boundaries.
   *
   * Accepts:
   * - AssetAmount (returns directly if asset matches, or clones)
   * - BigInt (interpreted as base units)
   * - String (e.g. "0.05", "$0.05", "0.0100", "0.05 USDC")
   * - Number (converted via exact decimal expansion)
   * - Object with { baseUnits, asset, precision } or { amount, asset } (JSON deserialization)
   *
   * Enforces strict fractional precision rules based on the asset configuration.
   *
   * @param {AssetAmount|bigint|number|string|object} value
   * @param {string} [asset='USDC']
   * @returns {AssetAmount}
   */
  static from(value, asset = DEFAULT_ASSET) {
    const targetAsset = (asset || DEFAULT_ASSET).toUpperCase()

    if (value instanceof AssetAmount) {
      if (value.asset !== targetAsset) {
        throw new AssetMismatchError(
          `Asset mismatch: expected '${targetAsset}', got '${value.asset}'`,
          { expected: targetAsset, received: value.asset }
        )
      }
      return value
    }

    if (typeof value === 'bigint') {
      return new AssetAmount(value, targetAsset)
    }

    if (value !== null && typeof value === 'object') {
      if (value.baseUnits !== undefined) {
        return new AssetAmount(BigInt(value.baseUnits), value.asset || targetAsset, value.precision)
      }
      if (value.amount !== undefined) {
        return AssetAmount.from(value.amount, value.asset || targetAsset)
      }
    }

    if (typeof value === 'number') {
      if (Number.isNaN(value) || !Number.isFinite(value)) {
        throw new InvalidAmountError(`Cannot parse non-finite number as AssetAmount: ${value}`)
      }
      return AssetAmount.fromString(numberToDecimalString(value), targetAsset)
    }

    if (typeof value === 'string') {
      return AssetAmount.fromString(value, targetAsset)
    }

    throw new InvalidAmountError(`Cannot convert ${typeof value} to AssetAmount`)
  }

  /**
   * Parse a string representation into an AssetAmount with explicit precision checks.
   * @param {string} str
   * @param {string} targetAsset
   * @returns {AssetAmount}
   */
  static fromString(str, targetAsset) {
    if (typeof str !== 'string') {
      throw new InvalidAmountError(`Amount must be a string, got ${typeof str}`)
    }

    let s = str.trim()
    if (!s) {
      throw new InvalidAmountError('Amount string cannot be empty')
    }

    if (s.startsWith('$')) {
      s = s.slice(1).trim()
    }
    // Remove optional trailing asset suffix like "USDC"
    s = s.replace(/\s+[A-Za-z]+$/, '').trim()

    let sign = 1n
    if (s.startsWith('+')) {
      s = s.slice(1)
    } else if (s.startsWith('-')) {
      sign = -1n
      s = s.slice(1)
    }

    if (!/^\d+(\.\d+)?$/.test(s)) {
      throw new InvalidAmountError(`Invalid amount format: '${str}'`)
    }

    const [intPart, fracPart = ''] = s.split('.')
    const maxPrecision = getAssetPrecision(targetAsset)

    if (fracPart.length > maxPrecision) {
      throw new UnsupportedPrecisionError(
        `Unsupported fractional precision: asset '${targetAsset}' allows at most ${maxPrecision} decimal places, received ${fracPart.length} in '${str}'`,
        {
          field: 'amount',
          asset: targetAsset,
          maxPrecision,
          receivedPrecision: fracPart.length,
          value: str,
        }
      )
    }

    const scale = 10n ** BigInt(maxPrecision)
    const paddedFrac = fracPart.padEnd(maxPrecision, '0')
    const baseUnits = (BigInt(intPart) * scale + BigInt(paddedFrac)) * sign

    return new AssetAmount(baseUnits, targetAsset, maxPrecision)
  }

  _checkSameAsset(other) {
    if (this.asset !== other.asset) {
      throw new AssetMismatchError(
        `Cannot perform operations on different assets: '${this.asset}' and '${other.asset}'`,
        { assetA: this.asset, assetB: other.asset }
      )
    }
  }

  /**
   * Exact addition.
   * @param {AssetAmount|number|string|bigint} other
   * @returns {AssetAmount}
   */
  plus(other) {
    const o = AssetAmount.from(other, this.asset)
    this._checkSameAsset(o)
    return new AssetAmount(this.baseUnits + o.baseUnits, this.asset, this.precision)
  }

  /**
   * Exact subtraction.
   * @param {AssetAmount|number|string|bigint} other
   * @returns {AssetAmount}
   */
  minus(other) {
    const o = AssetAmount.from(other, this.asset)
    this._checkSameAsset(o)
    return new AssetAmount(this.baseUnits - o.baseUnits, this.asset, this.precision)
  }

  /**
   * Multiply by an integer factor.
   * @param {bigint|number} factor
   * @returns {AssetAmount}
   */
  times(factor) {
    const f = typeof factor === 'bigint' ? factor : BigInt(Math.trunc(factor))
    return new AssetAmount(this.baseUnits * f, this.asset, this.precision)
  }

  /**
   * Exact comparison: -1 if this < other, 0 if equal, 1 if this > other.
   * @param {AssetAmount|number|string|bigint} other
   * @returns {-1|0|1}
   */
  compareTo(other) {
    const o = AssetAmount.from(other, this.asset)
    this._checkSameAsset(o)
    if (this.baseUnits < o.baseUnits) return -1
    if (this.baseUnits > o.baseUnits) return 1
    return 0
  }

  isGreaterThan(other) {
    return this.compareTo(other) > 0
  }

  isGreaterThanOrEqualTo(other) {
    return this.compareTo(other) >= 0
  }

  isLessThan(other) {
    return this.compareTo(other) < 0
  }

  isLessThanOrEqualTo(other) {
    return this.compareTo(other) <= 0
  }

  equals(other) {
    try {
      const o = AssetAmount.from(other, this.asset)
      return this.asset === o.asset && this.baseUnits === o.baseUnits
    } catch {
      return false
    }
  }

  isZero() {
    return this.baseUnits === 0n
  }

  isPositive() {
    return this.baseUnits > 0n
  }

  isNegative() {
    return this.baseUnits < 0n
  }

  /**
   * Render as a fixed-decimal string (defaulting to the asset's precision).
   * @param {number} [decimals]
   * @returns {string}
   */
  toDecimalString(decimals) {
    const isNeg = this.baseUnits < 0n
    const absUnits = isNeg ? -this.baseUnits : this.baseUnits
    const scale = 10n ** BigInt(this.precision)
    const intVal = absUnits / scale
    const fracVal = absUnits % scale
    const fullFrac = fracVal.toString().padStart(this.precision, '0')
    const sign = isNeg ? '-' : ''

    if (decimals === undefined) {
      return `${sign}${intVal}.${fullFrac}`
    }

    if (decimals === 0) {
      return `${sign}${intVal}`
    }

    if (decimals <= this.precision) {
      return `${sign}${intVal}.${fullFrac.slice(0, decimals)}`
    }

    return `${sign}${intVal}.${fullFrac.padEnd(decimals, '0')}`
  }

  /**
   * Render as an exact decimal string trimming trailing fractional zeros.
   * Keeps at least one decimal digit if fractional part is present.
   * @returns {string}
   */
  toExactString() {
    const isNeg = this.baseUnits < 0n
    const absUnits = isNeg ? -this.baseUnits : this.baseUnits
    const scale = 10n ** BigInt(this.precision)
    const intVal = absUnits / scale
    const fracVal = absUnits % scale
    const sign = isNeg ? '-' : ''

    if (fracVal === 0n) {
      return `${sign}${intVal}`
    }

    const fullFrac = fracVal.toString().padStart(this.precision, '0')
    const trimmedFrac = fullFrac.replace(/0+$/, '')
    return `${sign}${intVal}.${trimmedFrac}`
  }

  /**
   * Convert to JS Number (useful for backwards-compatible numeric consumers).
   * @returns {number}
   */
  toNumber() {
    return Number(this.toDecimalString(this.precision))
  }

  /**
   * JSON serialization compatibility contract.
   * Returns a JSON-safe structured object that can be safely passed to JSON.stringify
   * and round-tripped back to an AssetAmount via AssetAmount.from().
   *
   * @returns {{ amount: string, baseUnits: string, asset: string, precision: number }}
   */
  toJSON() {
    return {
      amount: this.toDecimalString(this.precision),
      baseUnits: this.baseUnits.toString(),
      asset: this.asset,
      precision: this.precision,
    }
  }

  toString() {
    return this.toDecimalString()
  }

  valueOf() {
    return this.toNumber()
  }

  [Symbol.toPrimitive](hint) {
    if (hint === 'string') {
      return this.toDecimalString()
    }
    return this.toNumber()
  }
}
