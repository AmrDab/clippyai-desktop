# com-ping-host.ps1
# Pings a host and returns latency stats.
# Args: -host (required), -count (default 4)
# Outputs JSON on the last line.

param(
    [string]$hostName = "",
    [int]$count = 4
)

function Out-Result($obj) {
    Write-Output ($obj | ConvertTo-Json -Compress -Depth 3)
}

function Fail($msg) {
    Out-Result @{ ok = $false; error = $msg }
    exit 1
}

if ([string]::IsNullOrWhiteSpace($hostName)) { Fail "host is required" }
if ($count -lt 1) { $count = 1 }
if ($count -gt 10) { $count = 10 }

try {
    $replies = Test-Connection -ComputerName $hostName -Count $count -ErrorAction SilentlyContinue
    if (-not $replies) {
        Out-Result @{ ok = $true; host = $hostName; reachable = $false; sent = $count; received = 0 }
        exit 0
    }
    $latencies = $replies | ForEach-Object { [int]$_.ResponseTime }
    $avg = if ($latencies.Count -gt 0) { [int](($latencies | Measure-Object -Average).Average) } else { -1 }
    $min = if ($latencies.Count -gt 0) { [int](($latencies | Measure-Object -Minimum).Minimum) } else { -1 }
    $max = if ($latencies.Count -gt 0) { [int](($latencies | Measure-Object -Maximum).Maximum) } else { -1 }
    Out-Result @{
        ok = $true
        host = $hostName
        reachable = $true
        sent = $count
        received = $latencies.Count
        avgMs = $avg
        minMs = $min
        maxMs = $max
    }
} catch {
    Fail "ping failed: $($_.Exception.Message)"
}
