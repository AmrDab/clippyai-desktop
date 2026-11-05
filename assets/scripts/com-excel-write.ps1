# com-excel-write.ps1
# Write a 2D array of values to a range in an Excel workbook via COM.
# Args: -path (required), -sheet (default first), -range (default A1), -data (JSON 2D array, required)
# Outputs JSON on the last line.

param(
    [string]$path = "",
    [string]$sheet = "",
    [string]$range = "A1",
    [string]$data = ""
)

function Out-Result($obj) {
    Write-Output ($obj | ConvertTo-Json -Compress -Depth 5)
}

function Fail($msg) {
    Out-Result @{ ok = $false; error = $msg }
    exit 1
}

if ([string]::IsNullOrWhiteSpace($path)) { Fail "path is required" }
if ([string]::IsNullOrWhiteSpace($data)) { Fail "data is required (JSON 2D array)" }
if ($path.StartsWith('~')) { $path = $path -replace '^~', $env:USERPROFILE }
$path = [System.Environment]::ExpandEnvironmentVariables($path)
$path = $path.Replace('/', '\')

# Parse data — expect [[a,b,c],[d,e,f]] OR a single row [a,b,c]
try {
    $arr = $data | ConvertFrom-Json
} catch {
    Fail "data must be valid JSON: $($_.Exception.Message)"
}

# Normalize to 2D
$rows = @()
if ($arr -is [Array] -and $arr.Count -gt 0) {
    if ($arr[0] -is [Array]) {
        $rows = $arr
    } else {
        $rows = @(,$arr)
    }
} else {
    Fail "data must be a non-empty array"
}

$rowCount = $rows.Count
$colCount = ($rows | ForEach-Object { $_.Count } | Measure-Object -Maximum).Maximum

$ext = [System.IO.Path]::GetExtension($path).ToLower()
if ($ext -notin @('.xlsx','.xls','.xlsm','.csv')) { Fail "not an Excel file: $ext" }

# v0.24 (plan sec. 3.6) - a workbook the user has open in Excel used to fail
# silently (DisplayAlerts off: a second Excel opens it read-only and Save
# goes nowhere). Detect it up front and say so.
if (Test-Path -LiteralPath $path) {
    $locked = $false
    try { $fs = [System.IO.File]::Open($path, 'Open', 'ReadWrite', 'None'); $fs.Close() }
    catch [System.IO.IOException] { $locked = $true }
    catch { }
    if ($locked) {
        $inExcel = $false
        try {
            $running = [System.Runtime.InteropServices.Marshal]::GetActiveObject('Excel.Application')
            foreach ($b in $running.Workbooks) { if ($b.FullName -eq $path) { $inExcel = $true; break } }
        } catch { }
        $leaf = Split-Path -Leaf $path
        if ($inExcel) {
            Out-Result @{ ok = $false; error = 'workbook_open'; message = "'$leaf' is open in Excel. Save and close it there first." }
        } else {
            Out-Result @{ ok = $false; error = 'file_locked'; message = "'$leaf' is locked by another program (it may be open in Excel or synced)." }
        }
        exit 1
    }
}

$excel = $null
$wb = $null
try {
    $excel = New-Object -ComObject Excel.Application -ErrorAction Stop
    $excel.Visible = $false
    $excel.DisplayAlerts = $false

    if (Test-Path $path) {
        $wb = $excel.Workbooks.Open($path)
    } else {
        $wb = $excel.Workbooks.Add()
        $wb.SaveAs($path)
    }

    $ws = if ([string]::IsNullOrWhiteSpace($sheet)) { $wb.Sheets.Item(1) } else {
        try { $wb.Sheets.Item($sheet) } catch {
            # Add the sheet if it doesn't exist
            $newSheet = $wb.Sheets.Add()
            $newSheet.Name = $sheet
            $newSheet
        }
    }

    # Resolve range to a rectangular block matching data dimensions
    $startCell = $ws.Range($range).Cells(1, 1)
    $endCell = $startCell.Offset($rowCount - 1, $colCount - 1)
    $writeRange = $ws.Range($startCell, $endCell)

    # Build a .NET 2D array (Excel COM expects this shape)
    $arr2d = New-Object 'object[,]' $rowCount, $colCount
    for ($r = 0; $r -lt $rowCount; $r++) {
        for ($c = 0; $c -lt $colCount; $c++) {
            $arr2d[$r, $c] = if ($c -lt $rows[$r].Count) { $rows[$r][$c] } else { $null }
        }
    }
    $writeRange.Value2 = $arr2d

    $wb.Save()

    Out-Result @{
        ok = $true
        path = $path
        sheet = $ws.Name
        rangeWritten = $writeRange.Address($false, $false)
        rows = $rowCount
        cols = $colCount
    }
} catch {
    Fail "excel_write failed: $($_.Exception.Message). Excel may not be installed."
} finally {
    if ($wb) { $wb.Close($true) | Out-Null; [System.Runtime.Interopservices.Marshal]::ReleaseComObject($wb) | Out-Null }
    if ($excel) { $excel.Quit(); [System.Runtime.Interopservices.Marshal]::ReleaseComObject($excel) | Out-Null }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}
