/** Shared evidence closure. Only keys and positions enter this operation. */
export function closeSourceIntervals(sourceKeys: readonly (readonly string[])[]): readonly { first: number; last: number }[] {
  const parent = sourceKeys.map((_, index) => index), owners = new Map<string, number>()
  const root = (index: number): number => parent[index] === index ? index : parent[index] = root(parent[index]!)
  for (const [index, keys] of sourceKeys.entries()) for (const key of keys) {
    const prior = owners.get(key)
    if (prior !== undefined) parent[root(index)] = root(prior)
    owners.set(key, index)
  }
  const ends = new Map<number, number>()
  for (let index = 0; index < sourceKeys.length; index++) ends.set(root(index), index)
  const intervals: { first: number; last: number }[] = []
  for (let first = 0; first < sourceKeys.length;) {
    let last = ends.get(root(first))!
    for (let index = first; index <= last; index++) last = Math.max(last, ends.get(root(index))!)
    intervals.push({ first, last }); first = last + 1
  }
  return intervals
}
