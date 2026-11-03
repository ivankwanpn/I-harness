import type { ItemBuilder } from '../exchange.ts'

export interface HistoryCurrent { readonly index: number }
export interface HistoryRecipe {
  readonly kind: 'input' | 'summary' | 'assistant' | 'result' | 'images' | 'seed-item'
  readonly item?: number
  readonly index?: number
  readonly calls?: readonly number[]
}
/** Derived structure references owned archive coordinates, never event bodies. */
export interface HistoryItem extends Omit<ItemBuilder, 'messages'> {
  readonly extent?: import('../seed-types.ts').TurnExtent
  readonly unit?: import('../legacy.ts').LegacyStep
  readonly establishmentIndex: number
  readonly admissionIndex?: number
  readonly imageAdmissionIndex?: number
  recipes: HistoryRecipe[]
}
