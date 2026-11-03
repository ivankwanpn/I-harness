$ErrorActionPreference = 'Stop'
$evidence = Join-Path (Get-Location) '.tmp/context-r4a-publication-pins-20261021-implementation'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$results = @()
foreach ($stem in @('source-before', 'source-qualified', 'source-before-wide', 'source-qualified-wide')) {
    # The direct initial manifest is the physical checkout. Its ZIP is a Git
    # archive with Git's checkout conversions, explicitly distinct in delivery.
    $manifestName = if ($stem -eq 'source-before') { 'source-before-wide' } else { $stem }
    $manifest = Get-Content -LiteralPath (Join-Path $evidence "$manifestName.json") -Raw | ConvertFrom-Json
    if ($stem -eq 'source-before') {
        $directNames = @{}
        foreach ($row in (Get-Content -LiteralPath (Join-Path $evidence 'source-before.json') -Raw | ConvertFrom-Json)) { $directNames[$row.path] = $true }
        $manifest = @($manifest | Where-Object { $directNames.ContainsKey($_.path) })
    }
    $expected = @{}
    foreach ($row in $manifest) { $expected[$row.path] = $row }
    $archive = [System.IO.Compression.ZipFile]::OpenRead((Join-Path $evidence "$stem.zip"))
    $seen = @{}
    $bytes = [long]0
    try {
        foreach ($entry in $archive.Entries) {
            if ($entry.FullName.EndsWith('/')) { continue }
            $name = $entry.FullName.Replace('\', '/')
            if (-not $expected.ContainsKey($name) -or $seen.ContainsKey($name)) { throw "Unexpected/duplicate ZIP entry: $stem/$name" }
            $stream = $entry.Open()
            $digest = [System.Security.Cryptography.SHA256]::Create()
            try { $actual = [Convert]::ToHexString($digest.ComputeHash($stream)).ToLowerInvariant() }
            finally { $digest.Dispose(); $stream.Dispose() }
            $row = $expected[$name]
            if ($actual -ne $row.sha256 -or $entry.Length -ne $row.bytes) { throw "ZIP content mismatch: $stem/$name" }
            $seen[$name] = $true
            $bytes += $entry.Length
        }
        if ($seen.Count -ne $expected.Count) { throw "Missing ZIP entries: $stem" }
    } finally { $archive.Dispose() }
    $results += [pscustomobject]@{ archive = "$stem.zip"; entries = $seen.Count; bytes = $bytes; mismatch = 0 }
}
$results | ConvertTo-Json -Depth 5
