# com-list-processes.ps1
# Lists top processes by CPU or RAM.
# Args: -sortBy [cpu|ram], -top [int, default 10]
# Outputs JSON on the last line.

param(
    [string]$sortBy = "ram",
    [int]$top = 10
)

function Out-Result($obj) {
    Write-Output ($obj | ConvertTo-Json -Compress -Depth 4)
}

function Fail($msg) {
    Out-Result @{ ok = $false; error = $msg }
    exit 1
}

if ($top -lt 1) { $top = 1 }
if ($top -gt 50) { $top = 50 }

try {
    $procs = Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.Id -ne 0 -and $_.MainWindowTitle -or $_.WorkingSet -gt 50MB }

    $sorted = if ($sortBy -eq "cpu") {
        $procs | Sort-Object -Property CPU -Descending
    } else {
        $procs | Sort-Object -Property WorkingSet -Descending
    }

    $list = @()
    $sorted | Select-Object -First $top | ForEach-Object {
        $list += @{
            pid = $_.Id
            name = $_.ProcessName
            ramMB = [int]($_.WorkingSet / 1MB)
            cpuSec = if ($_.CPU) { [math]::Round($_.CPU, 1) } else { 0 }
            window = if ($_.MainWindowTitle) { $_.MainWindowTitle } else { "" }
        }
    }

    Out-Result @{ ok = $true; sortBy = $sortBy; processes = $list }
} catch {
    Fail "list_processes failed: $($_.Exception.Message)"
}
