# Web access

`createWebTools` and `registerWeb` enforce four independent web access modes.
This setting controls IH web tools; it does not enable networking for shell commands.

| Mode | Behavior |
| --- | --- |
| `disabled` | Does not register web tools. A policy getter can also revoke an already registered tool before its next request. |
| `cached` | Reads IH's saved pages and queries. A miss returns `WEB_CACHE_MISS` with no network request or provider call. |
| `indexed` | Calls the configured search provider. Only URLs returned by that assembly's search results may be fetched; every redirect must also be admitted. |
| `live` | Calls the configured provider and fetches HTTP/HTTPS pages with bounded text output. |

IH does not supply OpenAI's hosted search index. `websearch` is absent unless an
actual provider has been registered. Query caching defaults to provider object
identity; persistent search providers can supply `providerCacheScope` derived
from their configuration. Index grants are held by one assembly and are never
restored from the cache. Page records are scoped to a workspace.

`createWebCache({root, scope})` stores at most 128 records, 8 MiB total, 600 KB per
record, with a seven day expiry. Writes use a temporary file and atomic rename.
Absent, corrupt, expired or unreadable records are misses; no miss triggers a
live fallback. Without a root the cache stays in memory. The cache contains
external text, never authentication headers, index grants or tool authority.
Embedded URL credentials are refused. The existing external content notice is
kept in a separate result field.

Omitting `mode` preserves the legacy `live` tool behavior. Product hosts capture
their saved mode when constructing a new assembly. Existing assemblies retain
their captured configuration.
