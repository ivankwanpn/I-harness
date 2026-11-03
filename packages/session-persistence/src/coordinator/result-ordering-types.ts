export interface OriginalOrderingReservation {
  join(): Promise<void>
  assertSettled(): void
  close(): Promise<void>
}
export interface OriginalLegacyOrderingParticipant {
  assertOutside(): void
  reserve(retain: (cleanup: OriginalOrderingReservation) => void): OriginalOrderingReservation
}
export interface OriginalOrderingRegistration {
  commit(participant: OriginalLegacyOrderingParticipant): void
  cancel(): void
}
declare const originBrand: unique symbol
export interface OriginalOrderingOrigin { readonly [originBrand]: true }
/** Ordering only. Native authority still requires the original batch and claims. */
export interface OriginalOrderingLedger {
  begin(): OriginalOrderingOrigin
  run<T>(origin: OriginalOrderingOrigin, work: () => Promise<T>): Promise<T>
  predecessors(origin: OriginalOrderingOrigin): Readonly<{ join(): Promise<void> }> | undefined
  beforeAcquisition(origin?: OriginalOrderingOrigin): Readonly<{ join(): Promise<void> }> | undefined
  complete(origin: OriginalOrderingOrigin): void
  hasPending(): boolean
  assertOutside(): void
}
