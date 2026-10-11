# HTTP transport

`createSystemFetch()` returns a private `fetch` function and an asynchronous `close()`.
`systemFetch` is a lazy shared instance; process owners may call `closeSystemFetch()`
at shutdown. Only explicitly wired consumers use this transport. It does not
change the global dispatcher, operating-system proxy settings, or TLS validation.

Routing order is loopback/`NO_PROXY` bypass, per-protocol environment proxy,
`ALL_PROXY`, a trusted `resolveProxy(url)` callback when supplied, and Windows
current-user Internet Settings. Lowercase environment names take precedence over
uppercase names. HTTPS uses `HTTPS_PROXY`; HTTP uses `HTTP_PROXY`.

Windows manual proxies support a single HTTP(S) proxy or a semicolon-separated
per-protocol mapping. Bypass rules support hostnames, wildcards, ports and
`<local>`. Environment bypass hostnames also match subdomains. Loopback is always
direct. CIDR bypass ranges and SOCKS proxies are not supported.

Registry reads use the absolute `%SystemRoot%\System32\reg.exe` path with fixed,
read-only `query` arguments and a bounded
30-second cache. PAC/WPAD configurations fail explicitly unless the trusted host
supplies an Electron-style resolver returning `DIRECT`, `PROXY host:port`, or
`HTTPS host:port`. This package never downloads or evaluates PAC scripts. Only
the first returned route is used; connection failures never trigger a direct
retry or another proxy route.

Proxy agents are lazy, private and pooled. At most eight proxy configurations
are retained for reuse; evicted agents finish outstanding work and retire.
`close()` aborts pending requests and destroys private agents. Request abort
signals are retained. Proxy credentials and native error bodies are never logged
or attached as error causes.

The implementation uses Undici 7.29.1's documented `ProxyAgent` per-request
`dispatcher`, `close()` and `destroy()` APIs. Tests use only local HTTP servers,
a local CONNECT proxy, and Windows registry text fixtures. Live authentication
and region-restricted endpoints are outside these tests.
