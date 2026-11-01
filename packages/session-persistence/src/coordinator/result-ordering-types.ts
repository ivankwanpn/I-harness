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
