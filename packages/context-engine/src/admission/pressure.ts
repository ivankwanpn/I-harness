/** Ratios are configuration decimals. Integer thresholds must not lose one
 * token to binary multiplication (for example .7 * 89000). */
function fraction(ratio: number): [bigint, bigint] {
  const [mantissa, exponent = '0'] = ratio.toString().split('e'), [whole, decimals = ''] = mantissa!.split('.')
  const scale = decimals.length - Number(exponent)
  const numerator = BigInt(whole! + decimals)
  return scale >= 0 ? [numerator, 10n ** BigInt(scale)] : [numerator * 10n ** BigInt(-scale), 1n]
}
function scaled(value: number, ratio: number, ceil: boolean): number {
  const [numerator, denominator] = fraction(ratio), product = BigInt(value) * numerator
  const quotient = product / denominator, remainder = product % denominator
  return Number(quotient + (remainder === 0n ? 0n : ceil ? product > 0n ? 1n : 0n : product < 0n ? -1n : 0n))
}
export const floorPressureRatio = (value: number, ratio: number) => scaled(value, ratio, false)
export const safetyMarginFor = (window: number, ratio: number) => scaled(window, ratio, true)
export function safetyFromReserve(reserve: number): number {
  const [numerator, denominator] = fraction(reserve)
  // Both operands are finite for ordinary configuration ratios; ratios so tiny
  // that their complement rounds to one are rejected by the capacity contract.
  return Number(denominator - numerator) / Number(denominator)
}
