# com-system-info.ps1
# Returns system info: battery, RAM, disk, CPU, OS.
# Args: -fields (comma-separated subset, optional). Default: all.
# Outputs JSON on the last line.

param(
    [string]$fields = ""
)

function Out-Result($obj) {
    Write-Output ($obj | ConvertTo-Json -Compress -Depth 4)
}

function Fail($msg) {
    Out-Result @{ ok = $false; error = $msg }
    exit 1
}

$wanted = @()
if (-not [string]::IsNullOrWhiteSpace($fields)) {
    $wanted = $fields.Split(',') | ForEach-Object { $_.Trim().ToLower() }
}
$want = { param($name) ($wanted.Count -eq 0 -or $wanted -contains $name) }

$result = @{ ok = $true }

try {
    if (& $want 'battery') {
        $bat = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($bat) {
            $result.battery = @{
                percent = [int]$bat.EstimatedChargeRemaining
                charging = ($bat.BatteryStatus -eq 2 -or $bat.BatteryStatus -eq 6 -or $bat.BatteryStatus -eq 7 -or $bat.BatteryStatus -eq 8 -or $bat.BatteryStatus -eq 9)
            }
        } else {
            $result.battery = $null  # desktop, no battery
        }
    }

    if (& $want 'memory') {
        $os = Get-CimInstance Win32_OperatingSystem
        $totalMB = [int]($os.TotalVisibleMemorySize / 1024)
        $freeMB  = [int]($os.FreePhysicalMemory / 1024)
        $result.memory = @{
            totalMB = $totalMB
            freeMB  = $freeMB
            usedMB  = $totalMB - $freeMB
            percentUsed = [int](100 * (($totalMB - $freeMB) / $totalMB))
        }
    }

    if (& $want 'disk') {
        $disks = @()
        Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object {
            $disks += @{
                drive = $_.DeviceID
                totalGB = [math]::Round($_.Size / 1GB, 1)
                freeGB  = [math]::Round($_.FreeSpace / 1GB, 1)
                percentUsed = if ($_.Size -gt 0) { [int](100 * (($_.Size - $_.FreeSpace) / $_.Size)) } else { 0 }
            }
        }
        $result.disk = $disks
    }

    if (& $want 'cpu') {
        $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
        $load = (Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'" -ErrorAction SilentlyContinue).PercentProcessorTime
        $result.cpu = @{
            name = $cpu.Name.Trim()
            cores = [int]$cpu.NumberOfCores
            logicalProcessors = [int]$cpu.NumberOfLogicalProcessors
            loadPercent = if ($null -ne $load) { [int]$load } else { 0 }
        }
    }

    if (& $want 'os') {
        $os = Get-CimInstance Win32_OperatingSystem
        $cs = Get-CimInstance Win32_ComputerSystem
        $uptimeMin = [int]((Get-Date) - $os.LastBootUpTime).TotalMinutes
        $result.os = @{
            name = $os.Caption
            version = $os.Version
            build = $os.BuildNumber
            hostname = $cs.Name
            user = $env:USERNAME
            uptimeMinutes = $uptimeMin
        }
    }

    Out-Result $result
} catch {
    Fail "system_info failed: $($_.Exception.Message)"
}
