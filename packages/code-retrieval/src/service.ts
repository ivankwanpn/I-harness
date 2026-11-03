import { configuration, identity } from './config.ts'
import { Store } from './store.ts'
import type { CodeRetrievalOptions, CodeRetrievalService } from './types.ts'
import { createConfiguration } from './service/configuration.ts'
import { createIndexJobs } from './service/index-job.ts'
import { createSearch } from './service/search.ts'
import { createStatus } from './service/status.ts'

export function createCodeRetrievalService(options:CodeRetrievalOptions):CodeRetrievalService {
  identity(options.workspaceId,'workspace ID')
  const config=configuration(options.config??{})
  const store=new Store(options.root,options.workspaceId)
  // Status and auto-refresh callbacks resolve their owners only when invoked.
  const telemetry=createStatus(store,()=>lifetime,()=>indexJobs)
  const lifetime=createConfiguration(config,store,telemetry)
  const indexJobs=createIndexJobs(options,store,lifetime,telemetry)
  const search=createSearch(options,store,lifetime,indexJobs.startIndex,jobId=>service.wait(jobId),telemetry)
  const service:CodeRetrievalService={status:telemetry.status,startIndex:indexJobs.startIndex,search,wait:indexJobs.wait,
    configure:lifetime.configure,cancel:lifetime.cancel,clear:lifetime.clear,close:lifetime.close}
  return service
}
