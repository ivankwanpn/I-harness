/** Holds the unpublished workspace's remaining owners when rollback fails. */
export class DesktopHostStartupError extends AggregateError {
  constructor(cause: unknown, cleanup: unknown, readonly retryCleanup: () => Promise<void>) {
    super([cause, cleanup], "Desktop host startup cleanup incomplete", { cause })
  }
}
