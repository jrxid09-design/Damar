$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$jsonFiles = Get-ChildItem $root -Filter '*.json'
foreach ($file in $jsonFiles) { $null = Get-Content $file.FullName -Raw | ConvertFrom-Json }
$matrix = Get-Content (Join-Path $root 'SURFACE_RESPONSIBILITY_MATRIX.json') -Raw | ConvertFrom-Json
$owners = Get-Content (Join-Path $root 'CANONICAL_STATE_OWNERSHIP.json') -Raw | ConvertFrom-Json
$required = 'idle_presence','web_dashboard','cli','voice','telegram','whatsapp','companion_api','http_api','mcp','remote_mesh','terminal_websocket'
$actual = @($matrix.surfaces.surface_id)
if (@($actual | Where-Object { $_ -notin $required }).Count -gt 0) { throw 'unknown surface' }
foreach ($id in $required) { if ($id -notin $actual) { throw "missing surface: $id" } }
if (@($owners.domains.state_domain | Group-Object | Where-Object Count -gt 1).Count -gt 0) { throw 'duplicate canonical state domain' }
if (@($matrix.surfaces | Where-Object { $_.canonical_state_owners -contains 'authority' }).Count -gt 0) { throw 'surface owns authority' }
if ((Get-Content (Join-Path $root 'PRODUCT_SURFACE_ARCHITECTURE.md') -Raw) -notmatch 'PRODUCT_SOURCE_CHANGED=NO') { throw 'source delta declaration missing' }
Write-Output 'PASS: JSON parse, surface coverage, unique ownership, authority boundary, and source-change declaration'
