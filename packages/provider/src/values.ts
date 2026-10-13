/** Capacity values must be positive integers ("parse positive ints"): plain
 * numbers, or integer strings (e.g. "64000"); "100k"-style suffixes and
 * non-positive values are dropped — including the integer-string "0", which
 * parses to 0 and violates the positive contract. */
export function positiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const n = Number(value)
    return n > 0 ? n : undefined
  }
  return undefined
}
