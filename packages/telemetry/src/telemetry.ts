// packages/telemetry/src/telemetry.ts — createTelemetry 多播（sink 錯誤隔離）
import type { Telemetry, TelemetryEvent, TelemetrySink } from "./types.ts"

export function createTelemetry(sinks: TelemetrySink[]): Telemetry {
  return {
    emit: (ev: TelemetryEvent) => {
      for (const s of sinks) {
        try {
          const r = s.onEvent(ev) as unknown
          // async sink 錯誤也隔離：reject → fail-visible warn，不中斷其他 sinks
          if (r instanceof Promise) r.catch((e) => console.warn("[telemetry] sink error:", e))
        } catch (e) {
          console.warn("[telemetry] sink error:", e)
        }
      }
    },
    close: () => {},
  }
}
