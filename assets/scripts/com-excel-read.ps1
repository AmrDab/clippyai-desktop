# com-excel-read.ps1
# Reads a range from an Excel workbook via COM.
# Args: -path (required), -sheet (default first sheet), -range (default "A1:Z100")
# Outputs JSON on the last line. Returns 2D array of values.

param(
    [string]$path = "",
    [string]$sheet = "",
    [string]$range = "A1:Z100"
)

function Out-Result($obj) {
    Write-Output ($obj | ConvertTo-Json -Compress -Depth 5)
}

function Fail($msg) {
    Out-Result @{ ok = $false; error = $msg }
    exit 1
}

if ([string]::IsNullOrWhiteSpace($path)) { Fail "path is required" }
if ($path.StartsWith('~')) { $path = $path -replace '^~', $env:USERPROFILE }
$path = [System.Environment]::ExpandEnvironmentVariables($path)
$path = $path.Replace('/', '\')

if (-not (Test-Path $path)) { Fail "file not found: $path" }
$ext = [System.IO.Path]::GetExtension($path).ToLower()
if ($ext -notin @('.xlsx','.xls','.xlsm','.csv')) { Fail "not an Excel file: $ext" }

$excel = $null
$wb = $null
try {
    $excel = New-Object -ComObject Excel.Application -ErrorAction Stop
    $excel.Visible = $false
    $excel.DisplayAlerts = $false
    $wb = $excel.Workbooks.Open($path, 0, $true)  # ReadOnly=true

    $ws = if ([string]::IsNullOrWhiteSpace($sheet)) { $wb.Sheets.Item(1) } else { $wb.Sheets.Item($sheet) }
    $sheetName = $ws.Name

    # Trim range to actual used cells if user passed a wide default
    $usedRange = $ws.UsedRange
    $maxRow = $usedRange.Rows.Count
    $maxCol = $usedRange.Columns.Count

    $data = $ws.Range($range).Value2

    # Normalize to 2D array — COM returns scalar / 1D / 2D depending on shape
    $rows = @()
    if ($null -eq $data) {
        $rows = @()
    } elseif ($data -isnot [Array]) {
        $rows = @(,@($data))
    } else {
        # For a Range with multiple rows/cols, $data is 2D Object[,]. Convert.
        try {
            $rowCount = $data.GetLength(0)
            $colCount = $data.GetLength(1)
            for ($r = 1; $r -le $rowCount; $r++) {
                $row = @()
                for ($c = 1; $c -le $colCount; $c++) {
                    $row += $data[$r,$c]
                }
                $rows += ,$row
            }
        } catch {
            # Single row/col Range comes back as 1D
            $rows = @(,@($data))
        }
    }

    # Cap output size
    if ($rows.Count -gt 500) { $rows = $rows[0..499] }

    Out-Result @{
        ok = $true
        path = $path
        sheet = $sheetName
        range = $range
        usedRows = $maxRow
        usedCols = $maxCol
        rows = $rows
    }
} catch {
    Fail "excel_read failed: $($_.Exception.Message). Excel may not be installed."
} finally {
    if ($wb) { $wb.Close($false) | Out-Null; [System.Runtime.Interopservices.Marshal]::ReleaseComObject($wb) | Out-Null }
    if ($excel) { $excel.Quit(); [System.Runtime.Interopservices.Marshal]::ReleaseComObject($excel) | Out-Null }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}
