Param(
    [string]$BaseUrl = 'http://localhost',
    [string]$Realm = 'master',
    [string]$DirectNodeUrl = 'http://localhost:8081',
    [string]$ClientId = 'admin-cli',
    [string]$ClientSecret,
    [string]$Username = 'admin',
    [string]$Password = 'admin',
    [string]$TargetNode = 'keycloak-2',
    [int]$PreKillDelaySeconds = 10,
    [int]$PostKillWaitSeconds = 10,
    [switch]$AutoRestart,
    [int]$PostRestartWaitSeconds = 20,
    [switch]$Verbose
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step {
    Param([string]$Message)
    Write-Host "[Failover] $Message"
}

function Invoke-FormPost {
    Param(
        [string]$Uri,
        [hashtable]$Body
    )
    $encoded = $Body.GetEnumerator() | ForEach-Object {
        '{0}={1}' -f [System.Uri]::EscapeDataString($_.Key), [System.Uri]::EscapeDataString([string]$_.Value)
    }
    $payload = $encoded -join '&'
    if ($Verbose) {
        Write-Verbose "POST $Uri`n$payload"
    }
    return Invoke-RestMethod -Uri $Uri -Method Post -Body $payload -ContentType 'application/x-www-form-urlencoded'
}

function Invoke-Userinfo {
    Param(
        [string]$Token
    )
    $headers = @{ Authorization = "Bearer $Token" }
    $response = Invoke-WebRequest -Uri "$BaseUrl/realms/$Realm/protocol/openid-connect/userinfo" -Headers $headers -Method Get
    $upstream = $response.Headers['X-Upstream-Server']
    $content = $null
    try {
        $content = ($response.Content | ConvertFrom-Json)
    }
    catch {
        $content = $response.Content
    }
    return [pscustomobject]@{
        Upstream = $upstream
        Status   = $response.StatusCode
        Payload  = $content
    }
}

Write-Step "Authenticating against $DirectNodeUrl (target node: $TargetNode)..."

$loginBody = @{
    grant_type = 'password'
    client_id  = $ClientId
    username   = $Username
    password   = $Password
}
if ($ClientSecret) {
    $loginBody.client_secret = $ClientSecret
}

$tokenEndpoint = "$DirectNodeUrl/realms/$Realm/protocol/openid-connect/token"
$loginResponse = Invoke-FormPost -Uri $tokenEndpoint -Body $loginBody

Write-Step "Initial login succeeded. Waiting $PreKillDelaySeconds seconds before killing $TargetNode..."
Start-Sleep -Seconds $PreKillDelaySeconds

Write-Step "Killing container $TargetNode..."
& docker compose kill $TargetNode | Out-Null

Write-Step "Waiting $PostKillWaitSeconds seconds for cluster to detect failure..."
Start-Sleep -Seconds $PostKillWaitSeconds

$refreshBody = @{
    grant_type    = 'refresh_token'
    client_id     = $ClientId
    refresh_token = $loginResponse.refresh_token
}
if ($ClientSecret) {
    $refreshBody.client_secret = $ClientSecret
}

Write-Step "Refreshing token via load balancer $BaseUrl..."
$refreshEndpoint = "$BaseUrl/realms/$Realm/protocol/openid-connect/token"
$refreshResponse = Invoke-FormPost -Uri $refreshEndpoint -Body $refreshBody

if (-not $refreshResponse.refresh_token) {
    throw "Refresh failed or did not return a refresh_token. Response: $($refreshResponse | ConvertTo-Json -Compress)"
}

Write-Step "Refresh succeeded. Validating access token across remaining nodes..."
$userinfoResult = Invoke-Userinfo -Token $refreshResponse.access_token

if ($userinfoResult.Status -ne 200) {
    throw "Userinfo failed with status $($userinfoResult.Status). Payload: $($userinfoResult.Payload | ConvertTo-Json -Compress)"
}

Write-Step "Userinfo succeeded on upstream $($userinfoResult.Upstream). User remains logged in."

if ($AutoRestart) {
    Write-Step "Restarting $TargetNode..."
    & docker compose up -d $TargetNode | Out-Null
    if ($PostRestartWaitSeconds -gt 0) {
        Write-Step "Waiting $PostRestartWaitSeconds seconds for $TargetNode to rejoin..."
        Start-Sleep -Seconds $PostRestartWaitSeconds
    }
    Write-Step "$TargetNode restarted."
}

Write-Step "Failover scenario complete."
