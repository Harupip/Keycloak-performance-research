Param(
    [string]$BaseUrl = 'http://localhost',
    [double]$RequestRate = 6,
    [string]$TimeUnit = '1m',
    [string]$Duration = '5m',
    [ValidateSet('steady', 'ramp')]
    [string]$LoadProfile = 'steady',
    [int]$PreAllocatedVUs,
    [int]$MaxVUs,
    [string]$Realm = 'master',
    [string]$Script = 'keycloak-openid',
    [string[]]$K6Args
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Set-EnvIfProvided {
    Param(
        [string]$Name,
        [object]$Value,
        [switch]$Always
    )

    if ($Always -or $PSBoundParameters.ContainsKey($Name) -or $null -ne $Value) {
        if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) {
            Remove-Item "Env:$Name" -ErrorAction SilentlyContinue
        }
        else {
            Set-Item "Env:$Name" -Value ([string]$Value)
        }
    }
}

$scriptMap = @{
    'keycloak-openid'        = Join-Path $PSScriptRoot '..\perf\k6\keycloak-openid.js'
    'keycloak-login-refresh' = Join-Path $PSScriptRoot '..\perf\k6\keycloak-login-refresh.js'
}

if (-not $scriptMap.ContainsKey($Script)) {
    throw "Unknown script '$Script'. Available options: $($scriptMap.Keys -join ', ')."
}

$k6Script = Resolve-Path $scriptMap[$Script]

if (-not (Get-Command 'k6' -ErrorAction SilentlyContinue)) {
    throw "k6 binary not found on PATH. Install it first (e.g. 'choco install k6')."
}

$originalEnv = @{}
foreach ($name in @(
        'BASE_URL',
        'REQUEST_RATE',
        'TIME_UNIT',
        'DURATION',
        'LOAD_PROFILE',
        'PREALLOCATED_VUS',
        'MAX_VUS',
        'REALM'
    )) {
    $originalEnv[$name] = [System.Environment]::GetEnvironmentVariable($name, 'Process')
}

try {
    Set-EnvIfProvided -Name 'BASE_URL' -Value $BaseUrl -Always
    Set-EnvIfProvided -Name 'REQUEST_RATE' -Value $RequestRate -Always
    Set-EnvIfProvided -Name 'TIME_UNIT' -Value $TimeUnit -Always
    Set-EnvIfProvided -Name 'DURATION' -Value $Duration -Always
    Set-EnvIfProvided -Name 'LOAD_PROFILE' -Value $LoadProfile -Always
    Set-EnvIfProvided -Name 'REALM' -Value $Realm -Always

    if ($PSBoundParameters.ContainsKey('PreAllocatedVUs')) {
        Set-EnvIfProvided -Name 'PREALLOCATED_VUS' -Value $PreAllocatedVUs -Always
    }
    else {
        Remove-Item Env:PREALLOCATED_VUS -ErrorAction SilentlyContinue
    }

    if ($PSBoundParameters.ContainsKey('MaxVUs')) {
        Set-EnvIfProvided -Name 'MAX_VUS' -Value $MaxVUs -Always
    }
    else {
        Remove-Item Env:MAX_VUS -ErrorAction SilentlyContinue
    }

    $arguments = @('run', $k6Script.Path)
    if ($K6Args) {
        $arguments += $K6Args
    }

    Write-Host "Running k6 script '$Script' with rate $RequestRate / $TimeUnit for $Duration..."
    & k6 @arguments
}
finally {
    foreach ($entry in $originalEnv.GetEnumerator()) {
        if ($null -eq $entry.Value) {
            Remove-Item "Env:$($entry.Key)" -ErrorAction SilentlyContinue
        }
        else {
            Set-Item "Env:$($entry.Key)" -Value $entry.Value
        }
    }
}
