export interface WorkerMessage { type: string; epoch: string; id?: string; registration?: bigint; status?: number; reason?: string }
export function createDrainWorkerProtocol(options: {
  epoch: string; capacity: number; send(message: WorkerMessage): void;
  drain(registration: bigint): number; shutdown(): void;
}): (message: unknown) => void
