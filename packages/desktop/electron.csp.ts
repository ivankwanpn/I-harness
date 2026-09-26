const PRODUCTION_CONNECT = "connect-src 'self'"
const DEV_CONNECT = "connect-src 'self' ws://localhost:* ws://127.0.0.1:*"

/** The shipped document keeps the strict policy; only the dev server's HTML
 * gets the HMR websocket origins, and the transform is idempotent. */
export function withDevConnectSources(html: string): string {
  if (!html.includes(PRODUCTION_CONNECT) || html.includes("ws://localhost:*")) return html
  return html.replace(PRODUCTION_CONNECT, DEV_CONNECT)
}

export const devCspPlugin = {
  name: "ih-dev-csp",
  apply: "serve" as const,
  transformIndexHtml(html: string): string {
    return withDevConnectSources(html)
  },
}
