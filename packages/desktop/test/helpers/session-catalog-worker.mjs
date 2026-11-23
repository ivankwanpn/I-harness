// Source-mode tests exercise the same worker entry as the Electron bundle.
import { tsImport } from 'tsx/esm/api'
await tsImport('../../src/main/session-catalog-worker.ts', import.meta.url)
