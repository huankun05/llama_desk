Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Rt, B; }
}
"@

$p = Get-Process -Id 34992 -ErrorAction SilentlyContinue
if (-not $p) { "pid 34992 not found"; exit 1 }
$h = $p.MainWindowHandle
if ($h -eq 0) { "no main window handle"; exit 2 }

[void][W]::ShowWindow($h, 9)
[void][W]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 1200

$r = New-Object W+R
[void][W]::GetWindowRect($h, [ref]$r)
$w = $r.Rt - $r.L
$ht = $r.B - $r.T
"rect=($($r.L),$($r.T),$($r.Rt),$($r.B)) size=${w}x${ht}"

if ($w -le 0 -or $ht -le 0) { "bad rect"; exit 3 }

$bmp = New-Object System.Drawing.Bitmap($w, $ht)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
$bmp.Save("D:\llama\shots\app-window.png", [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
"saved D:\llama\shots\app-window.png"
