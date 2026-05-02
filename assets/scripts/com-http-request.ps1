# com-http-request.ps1
# Makes an HTTP request and returns status + body.
# Args: -url (required), -method (default GET), -headers (JSON string, optional), -body (optional)
# Outputs JSON on the last line.

param(
    [string]$url = "",
    [string]$method = "GET",
    [string]$headers = "",
    [string]$body = ""
)

function Out-Result($obj) {
    Write-Output ($obj | ConvertTo-Json -Compress -Depth 4)
}

function Fail($msg) {
    Out-Result @{ ok = $false; error = $msg }
    exit 1
}

if ([string]::IsNullOrWhiteSpace($url)) { Fail "url is required" }
if ($url -notmatch '^https?://') { Fail "url must start with http:// or https://" }

$method = $method.ToUpper()
$validMethods = @("GET","POST","PUT","DELETE","PATCH","HEAD")
if ($validMethods -notcontains $method) { Fail "invalid method: $method" }

$hdrTable = @{}
if (-not [string]::IsNullOrWhiteSpace($headers)) {
    try {
        $parsed = $headers | ConvertFrom-Json
        $parsed.PSObject.Properties | ForEach-Object { $hdrTable[$_.Name] = $_.Value }
    } catch {
        Fail "invalid headers JSON: $($_.Exception.Message)"
    }
}

try {
    $params = @{
        Uri = $url
        Method = $method
        UseBasicParsing = $true
        TimeoutSec = 15
    }
    if ($hdrTable.Count -gt 0) { $params.Headers = $hdrTable }
    if (-not [string]::IsNullOrWhiteSpace($body) -and $method -in @("POST","PUT","PATCH")) {
        $params.Body = $body
    }
    $response = Invoke-WebRequest @params

    $bodyText = $response.Content
    if ($bodyText -is [byte[]]) { $bodyText = [System.Text.Encoding]::UTF8.GetString($bodyText) }
    $bodyText = [string]$bodyText
    if ($bodyText.Length -gt 4000) { $bodyText = $bodyText.Substring(0, 4000) + "...[truncated]" }

    Out-Result @{
        ok = $true
        url = $url
        status = [int]$response.StatusCode
        contentType = "$($response.Headers['Content-Type'])"
        body = $bodyText
    }
} catch {
    $statusCode = -1
    if ($_.Exception.Response) { $statusCode = [int]$_.Exception.Response.StatusCode }
    Fail "request failed (status=$statusCode): $($_.Exception.Message)"
}
