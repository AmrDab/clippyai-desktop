<#
.SYNOPSIS
    v0.24 - capture + Windows.Media.Ocr in one call, no temp file (plan sec. 3.4).
.DESCRIPTION
    Replaces the two-spawn "screenshot to %TEMP% png, then ocr-recognize.ps1"
    pipeline. In the persistent host the OCR engine and the WinRT AsTask
    helper are created once and kept in $global:__ClippyOcr.

    -Region foreground : the foreground window's frame (skipping windows of
                         -ExcludeProcessId, i.e. Clippy itself), clipped to
                         the virtual screen. Falls back to the whole virtual
                         screen when there is no usable window.
    -Region screen     : the whole virtual screen (all monitors).
    -Region rect       : -X -Y -Width -Height (physical screen pixels).

    Coordinates are PHYSICAL pixels (the thread is per-monitor-v2 DPI aware).
    Output (one JSON object) keeps word boxes RELATIVE to the captured
    region; the caller adds region.x/region.y (src/main/ocr-match.ts):
      {region:{x,y,width,height,source}, words:[{text,x,y,width,height,line}],
       fullText, ms}
#>
param(
    [string]$Region = "foreground",
    [int]$X = 0,
    [int]$Y = 0,
    [int]$Width = 0,
    [int]$Height = 0,
    [int]$ExcludeProcessId = 0
)

$ErrorActionPreference = 'Stop'
$sw = [System.Diagnostics.Stopwatch]::StartNew()

try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    if (-not ('OcrScreenWin32' -as [type])) {
        Add-Type @"
using System;
using System.Runtime.InteropServices;
public class OcrScreenWin32 {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr v);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
    public static void PerMonitorV2() { try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch { } }
    // Frame of the foreground window, skipping `exclude`'s windows by walking
    // down the Z-order. Returns false when nothing usable is found.
    public static bool ForegroundRect(uint exclude, out RECT r) {
        r = new RECT();
        IntPtr h = GetForegroundWindow();
        int guard = 0;
        while (h != IntPtr.Zero && guard++ < 200) {
            uint pid; GetWindowThreadProcessId(h, out pid);
            if (pid != 0 && pid != exclude && IsWindowVisible(h) && !IsIconic(h) && GetWindowTextLength(h) > 0) {
                if (DwmGetWindowAttribute(h, 9 /*EXTENDED_FRAME_BOUNDS*/, out r, Marshal.SizeOf(typeof(RECT))) != 0) GetWindowRect(h, out r);
                return r.Right > r.Left && r.Bottom > r.Top;
            }
            h = GetWindow(h, 2); // GW_HWNDNEXT
        }
        return false;
    }
}
"@
    }
    [OcrScreenWin32]::PerMonitorV2()

    if (-not $global:__ClippyOcr) {
        $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
        $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType = WindowsRuntime]
        $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
        $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Foundation, ContentType = WindowsRuntime]
        $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
            $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and
            $_.GetParameters()[0].ParameterType.IsGenericType -and
            $_.GetParameters()[0].ParameterType.GetGenericTypeDefinition().Name -eq 'IAsyncOperation`1'
        } | Select-Object -First 1
        if (-not $asTask) { throw "Cannot find AsTask method for WinRT async" }
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
        if (-not $engine) { throw "Windows OCR engine not available - no recognized languages installed" }
        $global:__ClippyOcr = @{ engine = $engine; asTask = $asTask }
    }
    $ocr = $global:__ClippyOcr

    function Await($op, [Type]$type) {
        $t = $ocr.asTask.MakeGenericMethod($type).Invoke($null, @($op))
        $t.Wait() | Out-Null
        return $t.Result
    }

    # ── region ──
    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $source = $Region
    $rx = $vs.X; $ry = $vs.Y; $rw = $vs.Width; $rh = $vs.Height
    if ($Region -eq 'rect' -and $Width -gt 0 -and $Height -gt 0) {
        $rx = $X; $ry = $Y; $rw = $Width; $rh = $Height
    } elseif ($Region -eq 'foreground') {
        $r = New-Object OcrScreenWin32+RECT
        if ([OcrScreenWin32]::ForegroundRect([uint32]$ExcludeProcessId, [ref]$r)) {
            $rx = $r.Left; $ry = $r.Top; $rw = $r.Right - $r.Left; $rh = $r.Bottom - $r.Top
        } else { $source = 'screen' }
    } else { $source = 'screen' }
    # clip to the virtual screen
    $x0 = [Math]::Max($rx, $vs.X); $y0 = [Math]::Max($ry, $vs.Y)
    $x1 = [Math]::Min($rx + $rw, $vs.X + $vs.Width); $y1 = [Math]::Min($ry + $rh, $vs.Y + $vs.Height)
    if ($x1 -le $x0 -or $y1 -le $y0) { $x0 = $vs.X; $y0 = $vs.Y; $x1 = $vs.X + $vs.Width; $y1 = $vs.Y + $vs.Height; $source = 'screen' }
    $rw = $x1 - $x0; $rh = $y1 - $y0

    # Windows OCR refuses images above MaxImageDimension — downscale if needed.
    $maxDim = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
    $scale = 1.0
    if ($rw -gt $maxDim -or $rh -gt $maxDim) { $scale = [Math]::Min($maxDim / $rw, $maxDim / $rh) }

    # ── capture (in memory) ──
    $bmp = New-Object System.Drawing.Bitmap($rw, $rh)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($x0, $y0, 0, 0, (New-Object System.Drawing.Size($rw, $rh)))
    $g.Dispose()
    if ($scale -lt 1.0) {
        $small = New-Object System.Drawing.Bitmap([int]($rw * $scale), [int]($rh * $scale))
        $sg = [System.Drawing.Graphics]::FromImage($small)
        $sg.DrawImage($bmp, 0, 0, $small.Width, $small.Height)
        $sg.Dispose(); $bmp.Dispose(); $bmp = $small
    }
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Bmp)
    $bmp.Dispose()
    $ms.Position = 0
    $ras = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($ms)
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($ras)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $soft = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await ($ocr.engine.RecognizeAsync($soft)) ([Windows.Media.Ocr.OcrResult])
    try { $soft.Dispose() } catch { }
    try { $ras.Dispose() } catch { }
    $ms.Dispose()

    $inv = 1.0 / $scale
    $words = New-Object System.Collections.Generic.List[object]
    $lineIdx = 0
    foreach ($line in $result.Lines) {
        foreach ($w in $line.Words) {
            $b = $w.BoundingRect
            $words.Add([ordered]@{
                text   = ($w.Text -replace '[\x00-\x08\x0B\x0C\x0E-\x1F]', '')
                x      = [int][Math]::Round($b.X * $inv)
                y      = [int][Math]::Round($b.Y * $inv)
                width  = [int][Math]::Round($b.Width * $inv)
                height = [int][Math]::Round($b.Height * $inv)
                line   = $lineIdx
            })
        }
        $lineIdx++
    }
    $out = [ordered]@{
        region   = [ordered]@{ x = $x0; y = $y0; width = $rw; height = $rh; source = $source }
        words    = $words.ToArray()
        fullText = if ($result.Text) { $result.Text } else { "" }
        ms       = $sw.ElapsedMilliseconds
    }
    [Console]::Out.Write(($out | ConvertTo-Json -Depth 4 -Compress))
} catch {
    [Console]::Out.Write((@{ error = $_.Exception.Message } | ConvertTo-Json -Compress))
    exit 0
}
