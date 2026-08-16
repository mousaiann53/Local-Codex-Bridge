Set-StrictMode -Version Latest

function New-ProjectionCursor {
    [pscustomobject]@{
        Generation = $null
        Sequence = [long]0
    }
}

function Resolve-TrayIconState {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('stopped', 'starting', 'ready', 'attention', 'error')]
        [string]$BaseState,

        [Parameter(Mandatory = $true)]
        [long]$WaitingCount
    )

    if ($BaseState -eq 'error') { return 'error' }
    if ($WaitingCount -gt 0) { return 'attention' }
    return $BaseState
}

function Resolve-NotReadyBaseIconState {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('stopped', 'starting', 'ready', 'attention', 'error')]
        [string]$CurrentBaseState,

        [Parameter(Mandatory = $true)]
        [bool]$HasOwnership
    )

    if ($HasOwnership) { return 'starting' }
    if ($CurrentBaseState -eq 'starting' -or $CurrentBaseState -eq 'attention') { return $CurrentBaseState }
    return 'stopped'
}

function Select-NewProjectionSignals {
    param(
        [Parameter(Mandatory = $true)]$Cursor,
        [Parameter(Mandatory = $true)]$Projection
    )

    $generation = [string]$Projection.generation.id
    $sequence = [long]$Projection.sequence
    if ([string]::IsNullOrWhiteSpace([string]$Cursor.Generation) -or $Cursor.Generation -cne $generation) {
        $Cursor.Generation = $generation
        $Cursor.Sequence = $sequence
        return @()
    }

    $newSignals = @($Projection.signals) |
        Where-Object { [long]$_.sequence -gt [long]$Cursor.Sequence } |
        Sort-Object { [long]$_.sequence }
    $Cursor.Sequence = [Math]::Max([long]$Cursor.Sequence, $sequence)
    return @($newSignals)
}

function Resolve-TerminalNotice {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Status
    )

    switch ($Status) {
        'completed' {
            return [pscustomobject]@{
                Title = 'Codex turn completed'
            Text = 'A Codex turn completed successfully.'
            }
        }
        'interrupted' {
            return [pscustomobject]@{
                Title = 'Codex turn interrupted'
            Text = 'A Codex turn was interrupted or cancelled.'
            }
        }
        default {
            return [pscustomobject]@{
                Title = 'Codex turn failed'
        Text = "A Codex turn failed or ended abnormally (status: $Status)."
            }
        }
    }
}

function Test-LoopbackReadyUrl {
    param(
        [AllowNull()]
        [string]$ReadyUrl
    )

    if ([string]::IsNullOrWhiteSpace($ReadyUrl)) { return $false }

    $uri = $null
    if (-not [Uri]::TryCreate($ReadyUrl, [UriKind]::Absolute, [ref]$uri)) { return $false }
    if (@('http', 'https') -notcontains $uri.Scheme) { return $false }
    if (-not [string]::IsNullOrEmpty($uri.UserInfo)) { return $false }

    if ([string]::Equals($uri.DnsSafeHost, '127.0.0.1', [StringComparison]::Ordinal)) { return $true }
    if ([string]::Equals($uri.DnsSafeHost, 'localhost', [StringComparison]::OrdinalIgnoreCase)) { return $true }
    if ($uri.HostNameType -ne [UriHostNameType]::IPv6) { return $false }

    $address = $null
    return [Net.IPAddress]::TryParse($uri.DnsSafeHost, [ref]$address) -and
        $address.Equals([Net.IPAddress]::IPv6Loopback)
}

function Test-TunnelOwnershipEvidence {
    param(
        [Parameter(Mandatory = $true)]$Ownership,
        [Parameter(Mandatory = $true)]$Observation,
        [Parameter(Mandatory = $true)][long]$PidFileValue
    )

    try {
        if ($Ownership.Process.HasExited) { return $false }
    } catch {
        return $false
    }

    if ([int]$Ownership.Process.Id -ne [int]$Ownership.ProcessId) { return $false }
    if ([int]$Observation.ProcessId -ne [int]$Ownership.ProcessId) { return $false }
    if ($PidFileValue -ne [long]$Ownership.ProcessId) { return $false }
    if ([long]$Observation.StartTimeUtcTicks -ne [long]$Ownership.StartTimeUtcTicks) { return $false }
    if (-not [string]::Equals(
        [string]$Observation.ExecutablePath,
        [string]$Ownership.ExecutablePath,
        [StringComparison]::OrdinalIgnoreCase)) { return $false }
    if (-not [string]::Equals(
        [string]$Observation.CommandLine,
        [string]$Ownership.LaunchCommandLine,
        [StringComparison]::Ordinal)) { return $false }
    if (-not [string]::Equals(
        [string]$Observation.ProfileName,
        [string]$Ownership.ProfileName,
        [StringComparison]::Ordinal)) { return $false }
    if (-not [string]::Equals(
        [string]$Observation.PidFilePath,
        [string]$Ownership.PidFilePath,
        [StringComparison]::OrdinalIgnoreCase)) { return $false }
    return $true
}

Export-ModuleMember -Function New-ProjectionCursor, Resolve-TrayIconState, Resolve-NotReadyBaseIconState, Select-NewProjectionSignals, Resolve-TerminalNotice, Test-LoopbackReadyUrl, Test-TunnelOwnershipEvidence
