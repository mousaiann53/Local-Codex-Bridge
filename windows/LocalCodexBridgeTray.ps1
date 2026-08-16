param(
    [string]$ReadyUrl = $env:LOCAL_CODEX_BRIDGE_READY_URL,
    [string]$ProfileName = $env:LOCAL_CODEX_BRIDGE_TUNNEL_PROFILE,
    [string]$TunnelExecutable = $env:LOCAL_CODEX_BRIDGE_TUNNEL_EXE,
    [string]$ProjectionPath = $env:LOCAL_CODEX_BRIDGE_PROJECTION_PATH
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'TrayCore.psm1') -Force

if (-not (Test-LoopbackReadyUrl $ReadyUrl)) {
    throw 'ReadyUrl is required and must be an absolute HTTP(S) loopback URL on 127.0.0.1, localhost, or ::1, without userinfo. Use -ReadyUrl or LOCAL_CODEX_BRIDGE_READY_URL.'
}
if ([string]::IsNullOrWhiteSpace($ProfileName) -or $ProfileName -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') {
    throw 'ProfileName is required and may contain only letters, numbers, dot, underscore, and hyphen. Use -ProfileName or LOCAL_CODEX_BRIDGE_TUNNEL_PROFILE.'
}
if ([string]::IsNullOrWhiteSpace($TunnelExecutable) -or -not [IO.Path]::IsPathRooted($TunnelExecutable)) {
    throw 'TunnelExecutable is required and must be an absolute path. Use -TunnelExecutable or LOCAL_CODEX_BRIDGE_TUNNEL_EXE.'
}
if ([string]::IsNullOrWhiteSpace($ProjectionPath)) {
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        throw 'ProjectionPath is required when LOCALAPPDATA is unavailable.'
    }
    $ProjectionPath = Join-Path $env:LOCALAPPDATA 'LocalCodexBridge\ux-projection.json'
}
if (-not [IO.Path]::IsPathRooted($ProjectionPath)) {
    throw 'ProjectionPath must be absolute.'
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:Ownership = $null
$script:Cursor = New-ProjectionCursor
$script:LastReady = $null
$script:WaitingCount = [long]0
$script:BaseIconState = 'stopped'
$script:TrayIcons = @{}
$script:OwnedTrayIcons = New-Object System.Collections.ArrayList

function Test-FormalReady {
    try {
        $request = [Net.HttpWebRequest]::Create($ReadyUrl)
        $request.Method = 'GET'
        $request.Timeout = 3000
        $request.ReadWriteTimeout = 3000
        $response = $request.GetResponse()
        try { return [int]$response.StatusCode -eq 200 } finally { $response.Dispose() }
    } catch {
        return $false
    }
}

function Get-FormalIdentityFromCommandLine([string]$CommandLine) {
    if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $null }
    $profilePattern = '(?i)(?:^|\s)--profile\s+(?:"?' + [regex]::Escape($ProfileName) + '"?)(?:\s|$)'
    $pidPattern = '(?i)(?:^|\s)--pid\.file\s+(?:"([^"]+)"|(\S+))'
    if ($CommandLine -notmatch '(?i)(?:^|\s)run(?:\s|$)' -or $CommandLine -notmatch $profilePattern) { return $null }
    $pidMatch = [regex]::Match($CommandLine, $pidPattern)
    if (-not $pidMatch.Success) { return $null }
    $pidPath = if ($pidMatch.Groups[1].Success) { $pidMatch.Groups[1].Value } else { $pidMatch.Groups[2].Value }
    [pscustomobject]@{ ProfileName = $ProfileName; PidFilePath = [IO.Path]::GetFullPath($pidPath) }
}

function Get-TunnelObservation([int]$ProcessId, $RetainedProcess = $null) {
    $cim = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
    if ($null -eq $cim) { return $null }
    $identity = Get-FormalIdentityFromCommandLine ([string]$cim.CommandLine)
    if ($null -eq $identity) { return $null }
    if (-not [string]::Equals([IO.Path]::GetFullPath([string]$cim.ExecutablePath), [IO.Path]::GetFullPath($TunnelExecutable), [StringComparison]::OrdinalIgnoreCase)) { return $null }
    $process = if ($null -ne $RetainedProcess) { $RetainedProcess } else { [Diagnostics.Process]::GetProcessById($ProcessId) }
    [pscustomobject]@{
        ProcessId = $ProcessId
        ExecutablePath = [IO.Path]::GetFullPath([string]$cim.ExecutablePath)
        StartTimeUtcTicks = $process.StartTime.ToUniversalTime().Ticks
        CommandLine = [string]$cim.CommandLine
        ProfileName = $identity.ProfileName
        PidFilePath = $identity.PidFilePath
    }
}

function Find-FormalTunnelProcess {
    foreach ($candidate in @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'tunnel-client.exe'" -ErrorAction SilentlyContinue)) {
        try {
            $observation = Get-TunnelObservation ([int]$candidate.ProcessId)
            if ($null -ne $observation) { return $observation }
        } catch { }
    }
    return $null
}

function Initialize-TrayIcons {
    $iconDirectory = Join-Path $PSScriptRoot 'icons'
    $definitions = @{
        stopped = [pscustomobject]@{ FileName = 'stopped.ico'; Fallback = [Drawing.SystemIcons]::Application }
        starting = [pscustomobject]@{ FileName = 'starting.ico'; Fallback = [Drawing.SystemIcons]::Information }
        ready = [pscustomobject]@{ FileName = 'ready.ico'; Fallback = [Drawing.SystemIcons]::Asterisk }
        attention = [pscustomobject]@{ FileName = 'attention.ico'; Fallback = [Drawing.SystemIcons]::Warning }
        error = [pscustomobject]@{ FileName = 'error.ico'; Fallback = [Drawing.SystemIcons]::Error }
    }

    foreach ($state in $definitions.Keys) {
        $definition = $definitions[$state]
        $path = Join-Path $iconDirectory $definition.FileName
        try {
            $icon = New-Object Drawing.Icon -ArgumentList ([IO.Path]::GetFullPath($path))
            $script:TrayIcons[$state] = $icon
            $null = $script:OwnedTrayIcons.Add($icon)
        } catch {
            $script:TrayIcons[$state] = $definition.Fallback
        }
    }
}

function Set-TrayIconState {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('stopped', 'starting', 'ready', 'attention', 'error')]
        [string]$State
    )

    $notifyIcon.Icon = $script:TrayIcons[$State]
}

function Refresh-TrayIcon {
    Set-TrayIconState (Resolve-TrayIconState $script:BaseIconState $script:WaitingCount)
}

function Show-Notice([string]$Title, [string]$Text) {
    $notifyIcon.BalloonTipTitle = $Title
    $notifyIcon.BalloonTipText = $Text
    $notifyIcon.ShowBalloonTip(4000)
}

function Set-TrayStatus {
    param(
        [Parameter(Mandatory = $true)][string]$Text,
        [Parameter(Mandatory = $true)]
        [ValidateSet('stopped', 'starting', 'ready', 'attention', 'error')]
        [string]$IconState
    )

    $statusItem.Text = "Status: $Text"
    $notifyIcon.Text = if ($Text.Length -le 63) { $Text } else { $Text.Substring(0, 63) }
    $script:BaseIconState = $IconState
    Refresh-TrayIcon
}

function Read-ProjectionSignals {
    if (-not (Test-Path -LiteralPath $ProjectionPath -PathType Leaf)) { return }
    try {
        $projection = Get-Content -LiteralPath $ProjectionPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $script:WaitingCount = [Math]::Max([long]0, [long]$projection.counts.waiting)
        Refresh-TrayIcon
        foreach ($signal in @(Select-NewProjectionSignals $script:Cursor $projection)) {
            switch ([string]$signal.kind) {
                'waiting_approval' { Show-Notice 'Codex needs approval' 'A Codex turn is waiting for approval.' }
                'waiting_user_input' { Show-Notice 'Codex needs input' 'A Codex turn is waiting for user input.' }
                'terminal' {
                    $notice = Resolve-TerminalNotice ([string]$signal.status)
                    Show-Notice $notice.Title $notice.Text
                }
            }
        }
    } catch {
        Set-TrayStatus 'Projection unavailable' 'error'
    }
}

function Update-ReadyStatus {
    $ready = Test-FormalReady
    if ($ready) {
        Set-TrayStatus $(if ($null -ne $script:Ownership) { 'Ready (owned)' } else { 'Ready (external)' }) 'ready'
    } else {
        $notReadyState = Resolve-NotReadyBaseIconState $script:BaseIconState ($null -ne $script:Ownership)
        Set-TrayStatus 'Tunnel not ready' $notReadyState
        if ($script:LastReady -eq $true) { Show-Notice 'Tunnel not ready' 'The configured readiness check changed to unavailable. No restart was attempted.' }
    }
    $script:LastReady = $ready
}

function Start-FormalTunnel {
    if (Test-FormalReady) {
        Set-TrayStatus 'Ready (external)' 'ready'
        Show-Notice 'Tunnel already ready' 'No duplicate Tunnel was launched.'
        return
    }
    if ($null -ne (Find-FormalTunnelProcess)) {
        Set-TrayStatus 'Formal Tunnel running but not ready (external)' 'starting'
        Show-Notice 'Tunnel already running' 'No duplicate Tunnel was launched and no restart was attempted.'
        return
    }
    if (-not (Test-Path -LiteralPath $TunnelExecutable -PathType Leaf)) {
        Set-TrayStatus 'Tunnel executable missing' 'error'
        return
    }

    Set-TrayStatus 'Starting formal Tunnel' 'starting'
    $runDirectory = Join-Path $env:LOCALAPPDATA 'LocalCodexBridge\run'
    [IO.Directory]::CreateDirectory($runDirectory) | Out-Null
    $pidFile = Join-Path $runDirectory ("tunnel-{0}.pid" -f [guid]::NewGuid().ToString('N'))
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = [IO.Path]::GetFullPath($TunnelExecutable)
    $startInfo.Arguments = "run --profile $ProfileName --pid.file `"$pidFile`""
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $startInfo.EnvironmentVariables['LOCAL_CODEX_BRIDGE_UX_PROJECTION'] = [IO.Path]::GetFullPath($ProjectionPath)
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $startInfo
    if (-not $process.Start()) { Set-TrayStatus 'Tunnel launch failed' 'error'; return }

    $observation = $null
    for ($attempt = 0; $attempt -lt 20 -and $null -eq $observation; $attempt += 1) {
        Start-Sleep -Milliseconds 100
        try { $observation = Get-TunnelObservation $process.Id $process } catch { }
    }
    if ($null -eq $observation -or -not [string]::Equals($observation.PidFilePath, [IO.Path]::GetFullPath($pidFile), [StringComparison]::OrdinalIgnoreCase)) {
        Set-TrayStatus 'Launched; ownership proof unavailable' 'attention'
        Show-Notice 'Tunnel launched' 'Strong ownership proof was unavailable, so this Tray will refuse to stop it.'
        return
    }
    $script:Ownership = [pscustomobject]@{
        Process = $process
        ProcessId = $process.Id
        ExecutablePath = $observation.ExecutablePath
        StartTimeUtcTicks = $observation.StartTimeUtcTicks
        LaunchCommandLine = $observation.CommandLine
        ProfileName = $ProfileName
        PidFilePath = [IO.Path]::GetFullPath($pidFile)
    }
    Set-TrayStatus 'Started (owned; readiness pending)' 'starting'
}

function Stop-OwnedTunnel {
    if ($null -eq $script:Ownership) {
        Set-TrayStatus 'Stop refused: Tunnel not owned' 'attention'
        Show-Notice 'Stop refused' 'This live Tray instance does not own the configured Tunnel.'
        return
    }
    try {
        $pidText = (Get-Content -LiteralPath $script:Ownership.PidFilePath -Raw -Encoding ASCII).Trim()
        $pidValue = [long]$pidText
        $observation = Get-TunnelObservation $script:Ownership.ProcessId $script:Ownership.Process
        if ($null -eq $observation -or -not (Test-TunnelOwnershipEvidence $script:Ownership $observation $pidValue)) {
            Set-TrayStatus 'Stop refused: ownership mismatch' 'attention'
            Show-Notice 'Stop refused' 'Tunnel identity could not be revalidated. No process was terminated.'
            return
        }
        $script:Ownership.Process.Kill()
        $script:Ownership.Process.WaitForExit(3000) | Out-Null
        if (-not $script:Ownership.Process.HasExited) {
            Set-TrayStatus 'Owned Tunnel did not exit' 'error'
            return
        }
        Remove-Item -LiteralPath $script:Ownership.PidFilePath -Force -ErrorAction SilentlyContinue
        $script:Ownership = $null
        Set-TrayStatus 'Stopped owned Tunnel' 'stopped'
    } catch {
        Set-TrayStatus 'Stop refused: ownership unavailable' 'attention'
        Show-Notice 'Stop refused' 'Strong ownership evidence was unavailable. No process was terminated.'
    }
}

Initialize-TrayIcons
$notifyIcon = New-Object Windows.Forms.NotifyIcon
$notifyIcon.Icon = $script:TrayIcons.stopped
$notifyIcon.Visible = $true
$notifyIcon.Text = 'Local Codex Bridge'
$menu = New-Object Windows.Forms.ContextMenuStrip
$statusItem = $menu.Items.Add('Status: starting')
$statusItem.Enabled = $false
$menu.Items.Add('Start configured Tunnel', $null, { Start-FormalTunnel }) | Out-Null
$menu.Items.Add('Stop owned Tunnel', $null, { Stop-OwnedTunnel }) | Out-Null
$menu.Items.Add('-') | Out-Null
$menu.Items.Add('Exit Tray', $null, {
    $timer.Stop()
    $notifyIcon.Visible = $false
    [Windows.Forms.Application]::Exit()
}) | Out-Null
$notifyIcon.ContextMenuStrip = $menu

Read-ProjectionSignals
Update-ReadyStatus
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 10000
$timer.Add_Tick({ Update-ReadyStatus; Read-ProjectionSignals })
$timer.Start()
try {
    [Windows.Forms.Application]::Run()
} finally {
    $timer.Stop()
    $timer.Dispose()
    $notifyIcon.Visible = $false
    $notifyIcon.Dispose()
    $menu.Dispose()
    foreach ($icon in @($script:OwnedTrayIcons)) { $icon.Dispose() }
}
