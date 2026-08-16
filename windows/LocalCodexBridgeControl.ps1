[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('build', 'start', 'stop', 'status', 'rebuild', 'health')]
    [string]$Action,
    [string]$CodexExe = $env:CODEX_EXE
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$entryPoint = Join-Path $repositoryRoot 'dist\src\index.js'
$healthProgram = Join-Path $PSScriptRoot 'LocalCodexBridgeHealth.mjs'

function Get-NodeExecutable {
    $node = Get-Command node.exe -ErrorAction Stop
    $version = (& $node.Source --version).Trim()
    if ($version -notmatch '^v(?<major>\d+)\.') {
        throw "Unable to parse Node.js version: $version"
    }
    if ([int]$Matches.major -lt 24) {
        throw "Node.js 24 or newer is required; found $version"
    }
    return [IO.Path]::GetFullPath($node.Source)
}

function Get-CodexExecutable {
    if ([string]::IsNullOrWhiteSpace($CodexExe)) {
        throw 'CodexExe is required. Pass -CodexExe with the ordinary filesystem official Codex CLI path, or set CODEX_EXE.'
    }
    if (-not [IO.Path]::IsPathRooted($CodexExe) -or -not (Test-Path -LiteralPath $CodexExe -PathType Leaf)) {
        throw 'CodexExe must be an existing absolute executable path.'
    }

    $canonical = (Resolve-Path -LiteralPath $CodexExe -ErrorAction Stop).Path
    if ($canonical -match '(?i)\\WindowsApps\\') {
        throw 'CodexExe must not point into WindowsApps. Use the ordinary filesystem official Codex CLI installation.'
    }
    $version = (& $canonical --version).Trim()
    if ($version -notmatch '^codex-cli\s+0\.147\.0(?:\s|$)') {
        throw "The approved Bridge runtime is official Codex CLI 0.147.0; found: $version"
    }
    return $canonical
}

function Invoke-NpmScript([string[]]$Arguments) {
    $npm = Get-Command npm.cmd -ErrorAction Stop
    & $npm.Source @Arguments
    if ($LASTEXITCODE -ne 0) { throw "npm $($Arguments -join ' ') failed with exit code $LASTEXITCODE" }
}

function Test-BuiltEntryPoint {
    if (-not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) {
        throw "Build output is missing: $entryPoint. Run the build action first."
    }
}

function Invoke-BridgeHealth([string]$NodeExecutable, [string]$CanonicalCodexExe) {
    Test-BuiltEntryPoint
    if (-not (Test-Path -LiteralPath $healthProgram -PathType Leaf)) {
        throw "Health program is missing: $healthProgram"
    }

    $oldCodexExe = $env:CODEX_EXE
    try {
        $env:CODEX_EXE = $CanonicalCodexExe
        & $NodeExecutable $healthProgram $entryPoint
        if ($LASTEXITCODE -ne 0) { throw "Bridge health check failed with exit code $LASTEXITCODE" }
    } finally {
        $env:CODEX_EXE = $oldCodexExe
    }
}

switch ($Action) {
    'build' {
        Get-NodeExecutable | Out-Null
        Invoke-NpmScript @('run', 'build')
    }
    'rebuild' {
        Get-NodeExecutable | Out-Null
        Invoke-NpmScript @('ci')
        Invoke-NpmScript @('run', 'build')
    }
    'start' {
        $node = Get-NodeExecutable
        $codex = Get-CodexExecutable
        Test-BuiltEntryPoint
        Write-Host 'Starting Local Codex Bridge in foreground stdio mode. It creates no listener or service; stop with Ctrl+C or by closing the owning MCP client.'
        $oldCodexExe = $env:CODEX_EXE
        try {
            $env:CODEX_EXE = $codex
            & $node $entryPoint
            if ($LASTEXITCODE -ne 0) { throw "Local Codex Bridge exited with code $LASTEXITCODE" }
        } finally {
            $env:CODEX_EXE = $oldCodexExe
        }
    }
    'stop' {
        Write-Output 'STOP_NOT_APPLICABLE: Local Codex Bridge is a client-owned stdio process, not a daemon. Stop the owning MCP client session or foreground start process.'
    }
    'status' {
        $node = Get-NodeExecutable
        $codex = Get-CodexExecutable
        [pscustomobject]@{
            mode = 'stdio'
            listener = 'none'
            service = 'none (client-owned process)'
            repository = $repositoryRoot
            entry_point = $entryPoint
            entry_point_built = [bool](Test-Path -LiteralPath $entryPoint -PathType Leaf)
            node_executable = $node
            node_version = (& $node --version).Trim()
            codex_executable = $codex
            codex_version = (& $codex --version).Trim()
            allowed_roots_configured = -not [string]::IsNullOrWhiteSpace($env:LOCAL_CODEX_BRIDGE_ALLOWED_ROOTS)
        } | Format-List
    }
    'health' {
        $node = Get-NodeExecutable
        $codex = Get-CodexExecutable
        Invoke-BridgeHealth $node $codex
    }
}
