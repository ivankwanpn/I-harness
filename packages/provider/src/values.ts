/** Capacity values must be positive integers ("parse positive ints"): plain
 * numbers, or integer strings (e.g. "64000"); "100k"-style suffixes and
 * non-positive values are dropped — including the integer-string "0", which
 * parses to 0 and violates the positive contract. */
export function positiveInteger(value: unknown): number | undefined {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value
  return typeof number === "number" && Number.isSafeInteger(number) && number > 0 ? number : undefined
}
