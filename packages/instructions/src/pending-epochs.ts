/** Service-owned causal state; snapshots never expose it through source DTOs. */
export function createPendingEpochs() {
  const epochs = new Map<string, number>(), owners = new Map<string, Map<string, number>>()
  return {
    epochs,
    owners,
    record(id: string, slots: Iterable<string>, active: boolean) {
      let own = owners.get(id)
      if (active && !own) { own = new Map(); owners.set(id, own) }
      for (const slot of slots) {
        const next = (epochs.get(slot) ?? 0) + 1
        if (!Number.isSafeInteger(next)) throw new Error('Pending epoch exhausted')
        epochs.set(slot, next)
        if (active) own!.set(slot, (own!.get(slot) ?? 0) + 1)
      }
      if (!active) owners.delete(id)
    },
    snapshot() { return new Map(epochs) },
    matches(slot: string, baseline: Map<string, number>, own?: string) {
      const allowance = own ? owners.get(own)?.get(slot) ?? 0 : 0
      return (epochs.get(slot) ?? 0) - (baseline.get(slot) ?? 0) === allowance
    },
  }
}
