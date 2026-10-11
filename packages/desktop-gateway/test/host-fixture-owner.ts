import type { DesktopHost } from '../src/host.ts'

/** Resource ownership for in-process host fixtures, including startup. */
export function createHostFixtureOwner() {
  const hosts: Array<Promise<DesktopHost>> = []
  let closed = false, closing: Promise<void> | undefined
  return {
    own(create: () => Promise<DesktopHost>): Promise<DesktopHost> {
      if (closed) return Promise.reject(new Error('Host fixture is closing'))
      const creation = Promise.resolve().then(create)
      hosts.push(creation)
      return creation
    },
    close(): Promise<void> {
      closed = true
      if (closing) return closing
      const attempt = Promise.allSettled(hosts.map(async creation => { const host = await creation; await host.close() })).then(results => {
        const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Host fixture cleanup incomplete')
      })
      closing = attempt
      void attempt.finally(() => { if (closing === attempt) closing = undefined }).catch(() => {})
      return attempt
    },
  }
}
