# com-list-processes.ps1
# Lists top processes by CPU or RAM, or every process that matches a query.
# Args: -sortBy [cpu|ram], -top [int, default 10], -queryB64 [base64 UTF-8]
#   With a query: matched (case-insensitive, spaces ignored) against the process
#   name, main window title and the exe's FileDescription / ProductName. No
#   top-N cut and no RAM floor, so an app whose process name differs from its
#   display name (Siemens "Designcenter" = ugraf.exe) is still found.
# Outputs JSON on the last line.

param(
    [string]$sortBy = "ram",
    [int]$top = 10,
    [string]$queryB64 = ""
)

function Out-Result($obj) {
    Write-Output ($obj | ConvertTo-Json -Compress -Depth 4)
}

function Fail($msg) {
    Out-Result @{ ok = $false; error = $msg }
    exit 1
}

function Norm($s) { return (([string]$s) -replace '\s', '').ToLower() }

# FileDescription / ProductName. Reading them opens the process, which fails
# for protected ones: that is an empty description, not an error.
function Describe($p) {
    $d = ""; $prod = ""
    try { $d = [string]$p.Description } catch {}
    try { $prod = [string]$p.Product } catch {}
    if ($d -and $prod -and $d -ne $prod) { return "$d ($prod)" }
    if ($d) { return $d }
    return $prod
}

function Row($p, $desc) {
    return @{
        pid = $p.Id
        name = $p.ProcessName
        ramMB = [int]($p.WorkingSet64 / 1MB)
        cpuSec = if ($p.CPU) { [math]::Round($p.CPU, 1) } else { 0 }
        window = if ($p.MainWindowTitle) { $p.MainWindowTitle } else { "" }
        description = $desc
    }
}

if ($top -lt 1) { $top = 1 }
if ($top -gt 50) { $top = 50 }

$query = ""
if ($queryB64) {
    try { $query = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($queryB64)) }
    catch { Fail "invalid query" }
}
$q = Norm $query

try {
    $all = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne 0 }
    $list = @()

    if ($q) {
        foreach ($p in $all) {
            $desc = $null
            $hit = (Norm $p.ProcessName).Contains($q) -or (Norm $p.MainWindowTitle).Contains($q)
            if (-not $hit) {
                $desc = Describe $p
                $hit = (Norm $desc).Contains($q)
            }
            if ($hit) {
                if ($null -eq $desc) { $desc = Describe $p }
                $list += (Row $p $desc)
            }
        }
        Out-Result @{ ok = $true; query = $query; count = $list.Count; processes = @($list) }
        exit 0
    }

    $procs = $all | Where-Object { $_.MainWindowTitle -or $_.WorkingSet64 -gt 50MB }
    $sorted = if ($sortBy -eq "cpu") {
        $procs | Sort-Object -Property CPU -Descending
    } else {
        $procs | Sort-Object -Property WorkingSet64 -Descending
    }
    $sorted | Select-Object -First $top | ForEach-Object { $list += (Row $_ (Describe $_)) }

    Out-Result @{ ok = $true; sortBy = $sortBy; processes = @($list) }
} catch {
    Fail "list_processes failed: $($_.Exception.Message)"
}
