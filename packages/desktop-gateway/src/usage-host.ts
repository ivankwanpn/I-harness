import type {UsageStore,UsageQuery,UsagePrice} from '@i-harness/usage-stats'
import {queryUsageObservations,validateObservationQuery} from '../../usage-stats/src/observation-query.ts'
/** The actual host's query closure holds only its original store and passive state. */
export function createUsageHandlers(store:Pick<UsageStore,'query'|'setPricing'|'observationNamespace'|'loadPopulation'>,options:{recordingMode:'legacy'|'observations';warnings():readonly string[]}){
 return {
  async query(query:UsageQuery){
   if(options.recordingMode!=='legacy'||await store.observationNamespace()!=='absent')throw Object.assign(Error('Update the desktop client to view action and send usage.'),{code:'USAGE_UPGRADE_REQUIRED'})
   const snapshot=await store.query(query);return {...snapshot,warnings:[...new Set([...snapshot.warnings,...options.warnings()])]}
  },
  async queryV2(input:unknown){const query=validateObservationQuery(input),population=await store.loadPopulation();return queryUsageObservations({...population,warnings:[...population.warnings,...options.warnings()]},query,options.recordingMode)},
  setPricing(price:UsagePrice){return store.setPricing(price)},
 }
}
