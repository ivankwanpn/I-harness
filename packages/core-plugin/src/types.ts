export type NextFn = (payload: unknown) => unknown | Promise<unknown>
export type Listener = (payload: unknown) => unknown
export type WaterfallHandler = (payload: unknown, next: NextFn) => unknown | Promise<unknown>
export type CascadeHandler<TInput = unknown, TOutput = unknown> = (
  input: TInput,
  next: () => Promise<TOutput>,
) => Promise<TOutput>
export type GuardFn = (exec: unknown) => string | undefined

export interface Plugin {
  name: string
  mount(ctx: PluginContext): void
  unmount?(ctx: PluginContext): void | Promise<void>
}

export interface PluginContext {
  services: {
    register(name: string, impl: unknown): void
    get<T>(name: string): T
  }
  scope: {
    mount(): PluginContext
    unmount(): void
  }
  on(event: string, handler: Listener): void
  emit(event: string, payload: unknown): Promise<unknown>
  waterfall(event: string, handler: WaterfallHandler): void
  cascade<TInput, TOutput>(
    event: string,
    input: TInput,
    final: () => Promise<TOutput>,
  ): Promise<TOutput>
  onCascade(event: string, handler: CascadeHandler<unknown, unknown>): void
  guard(event: string, fn: GuardFn): void
  checkGuards(event: string, exec: unknown): string | undefined
  resolveDecision(event: string, payload: unknown): unknown
  resolveAncestorDecision(event: string, payload: unknown): unknown
  mount(plugin: Plugin): void
  unmount(name: string): Promise<void>
}
