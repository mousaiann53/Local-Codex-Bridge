$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

$controlPath = Join-Path $PSScriptRoot 'LocalCodexBridgeControl.ps1'
$tokens = $null
$parseErrors = $null
$null = [Management.Automation.Language.Parser]::ParseFile($controlPath, [ref]$tokens, [ref]$parseErrors)
Assert-True ($parseErrors.Count -eq 0) "PowerShell control script must parse: $controlPath"

$source = Get-Content -LiteralPath $controlPath -Raw -Encoding UTF8
foreach ($action in @('build', 'start', 'stop', 'status', 'rebuild', 'health', 'projects', 'project-add', 'project-remove', 'project-enable', 'project-disable', 'project-scan')) {
    Assert-True ($source.Contains("'$action'")) "Control script must expose action: $action"
}
Assert-True ($source -match "CodexExe is required") 'Control script must require an explicit ordinary filesystem Codex executable.'
Assert-True ($source -match "WindowsApps") 'Control script must reject WindowsApps Codex executables.'
Assert-True ($source -match "codex-cli\\s\+0\\.147\\.0") 'Control script must pin the approved Codex CLI version.'
Assert-True ($source -notmatch '(?i)TcpListener|HttpListener|New-WebBinding|netsh\s+http|--listen') 'Control script must not create a network listener.'
Assert-True ($source -match 'client-owned stdio process') 'Stop behavior must state that stdio ownership remains with the MCP client.'
Assert-True ($source -match 'project-registry-cli\.js') 'Project actions must use the bounded local Project Registry CLI.'
Assert-True ($source -notmatch 'LOCAL_CODEX_BRIDGE_ALLOWED_ROOTS\s*=') 'Control script must not pin a per-project static filesystem ceiling.'
$healthPath = Join-Path $PSScriptRoot 'LocalCodexBridgeHealth.mjs'
Assert-True (Test-Path -LiteralPath $healthPath -PathType Leaf) 'MCP health program must exist.'
$healthSource = Get-Content -LiteralPath $healthPath -Raw -Encoding UTF8
Assert-True ($healthSource -match "shell:\s*false") 'Health child process must disable shell execution.'
Assert-True ($healthSource -match 'BRIDGE_HEALTH_OK') 'Health action must perform an MCP protocol check.'
Assert-True ($healthSource -notmatch '(?i)TcpListener|HttpListener|--listen') 'Health action must not create a network listener.'

Write-Output 'CONTROL_SCRIPT_TESTS_OK'
