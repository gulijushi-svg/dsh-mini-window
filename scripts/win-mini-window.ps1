# dsh-mini-window —— 桌面窗口控制脚本（Win32）
#
# 由插件 Host 半边（index.js）调用，把 DeepSeek Harness 主窗口切换成
# 「音乐播放器式小窗」：置顶 + 固定尺寸 + 贴屏幕右下角；再次调用则恢复原状。
#
# 用法：
#   powershell -NoProfile -File win-mini-window.ps1 -Action enter -Width 600 -Height 900
#   powershell -NoProfile -File win-mini-window.ps1 -Action exit
#   powershell -NoProfile -File win-mini-window.ps1 -Action status
#
# 输出：单行 JSON，便于 Host 解析。
# 注意：本文件必须保存为 UTF-8 with BOM —— Windows PowerShell 5.1 会按 ANSI 读取无 BOM 的 UTF-8。

param(
  [ValidateSet('enter', 'exit', 'status')]
  [string]$Action = 'status',
  [int]$Width = 600,
  [int]$Height = 900,
  [int]$Margin = 24,
  [string]$StatePath = ''
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($StatePath)) {
  $StatePath = Join-Path $env:TEMP 'dsh-mini-window-state.json'
}

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class DshMiniWin {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  public delegate bool EnumProc(IntPtr hwnd, IntPtr param);

  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr param);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int max);

  public const uint SWP_SHOWWINDOW = 0x0040;
  public const uint SWP_NOSIZE = 0x0001;
  public const uint SWP_NOMOVE = 0x0002;
  public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  public static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);

  /// <summary>按标题定位 Electron 主窗口，避开同名的子进程与 DevTools 窗口。</summary>
  public static IntPtr FindMainWindow(string needle) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr hwnd, IntPtr param) {
      if (!IsWindowVisible(hwnd)) return true;
      StringBuilder title = new StringBuilder(512);
      GetWindowText(hwnd, title, 512);
      if (title.ToString().IndexOf(needle, StringComparison.OrdinalIgnoreCase) < 0) return true;
      StringBuilder cls = new StringBuilder(256);
      GetClassName(hwnd, cls, 256);
      if (!cls.ToString().StartsWith("Chrome_WidgetWin", StringComparison.Ordinal)) return true;
      found = hwnd;
      return false;
    }, IntPtr.Zero);
    return found;
  }

  public static bool RectOf(IntPtr hwnd, out RECT rect) { return GetWindowRect(hwnd, out rect); }

  public static bool MakeTopmost(IntPtr hwnd, int x, int y, int w, int h) {
    return SetWindowPos(hwnd, HWND_TOPMOST, x, y, w, h, SWP_SHOWWINDOW);
  }

  public static bool Restore(IntPtr hwnd, int x, int y, int w, int h) {
    return SetWindowPos(hwnd, HWND_NOTOPMOST, x, y, w, h, SWP_SHOWWINDOW);
  }

  public static bool DropTopmost(IntPtr hwnd) {
    return SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE);
  }
}
'@

[void][DshMiniWin]::SetProcessDPIAware()

function Read-State {
  if (Test-Path $StatePath) {
    try { return (Get-Content $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
  }
  return $null
}

function Write-State($obj) {
  ($obj | ConvertTo-Json -Compress) | Set-Content -Path $StatePath -Encoding UTF8
}

function Emit($payload) {
  Write-Output ($payload | ConvertTo-Json -Compress)
}

# 优先用上次记录的主窗口句柄；它失效时再按标题重新定位。
$state = Read-State
$hwnd = [IntPtr]::Zero
if ($null -ne $state -and $null -ne $state.hwnd) {
  $candidate = [IntPtr][int64]$state.hwnd
  if ([DshMiniWin]::IsWindow($candidate)) { $hwnd = $candidate }
}
if ($hwnd -eq [IntPtr]::Zero) {
  $hwnd = [DshMiniWin]::FindMainWindow('DeepSeek Harness')
}
if ($hwnd -eq [IntPtr]::Zero) {
  Emit @{ ok = $false; reason = 'window-not-found' }
  exit 0
}

$rect = New-Object DshMiniWin+RECT
[void][DshMiniWin]::RectOf($hwnd, [ref]$rect)
$screenW = [DshMiniWin]::GetSystemMetrics(0)   # SM_CXSCREEN
$screenH = [DshMiniWin]::GetSystemMetrics(1)   # SM_CYSCREEN

switch ($Action) {
  'status' {
    Emit @{
      ok       = $true
      action   = 'status'
      hwnd     = $hwnd.ToInt64()
      rect     = @{ x = $rect.Left; y = $rect.Top; w = $rect.Right - $rect.Left; h = $rect.Bottom - $rect.Top }
      minified = ($null -ne $state)
      screen   = @{ w = $screenW; h = $screenH }
    }
  }

  'enter' {
    if ($null -eq $state) {
      Write-State @{
        hwnd      = $hwnd.ToInt64()
        x         = $rect.Left
        y         = $rect.Top
        w         = $rect.Right - $rect.Left
        h         = $rect.Bottom - $rect.Top
        maximized = [DshMiniWin]::IsZoomed($hwnd)
      }
    } else {
      Write-State @{
        hwnd      = $hwnd.ToInt64()
        x         = $state.x
        y         = $state.y
        w         = $state.w
        h         = $state.h
        maximized = $state.maximized
      }
    }

    [void][DshMiniWin]::ShowWindow($hwnd, 9)   # SW_RESTORE

    $x = [Math]::Max(0, $screenW - $Width - $Margin)
    $y = [Math]::Max(0, $screenH - $Height - [Math]::Max($Margin, 56))

    $okPos = [DshMiniWin]::MakeTopmost($hwnd, $x, $y, $Width, $Height)

    # Electron 主窗口带最小尺寸约束，请求值可能被放大；按**实际**尺寸重新贴右下角，
    # 否则窗口会越过屏幕右边缘，挂在窗口右缘的入口按钮就跑到屏幕外了。
    $after = New-Object DshMiniWin+RECT
    [void][DshMiniWin]::RectOf($hwnd, [ref]$after)
    $actualW = $after.Right - $after.Left
    $actualH = $after.Bottom - $after.Top
    $x2 = [Math]::Max(0, $screenW - $actualW - $Margin)
    $y2 = [Math]::Max(0, $screenH - $actualH - [Math]::Max($Margin, 56))
    if ($x2 -ne $after.Left -or $y2 -ne $after.Top) {
      $okPos = [DshMiniWin]::MakeTopmost($hwnd, $x2, $y2, $actualW, $actualH)
      [void][DshMiniWin]::RectOf($hwnd, [ref]$after)
      $actualW = $after.Right - $after.Left
      $actualH = $after.Bottom - $after.Top
    }

    Emit @{
      ok      = $okPos
      action  = 'enter'
      hwnd    = $hwnd.ToInt64()
      rect    = @{ x = $after.Left; y = $after.Top; w = $actualW; h = $actualH }
      topmost = $true
    }
  }

  'exit' {
    if ($null -ne $state) {
      [void][DshMiniWin]::Restore($hwnd, [int]$state.x, [int]$state.y, [int]$state.w, [int]$state.h)
      if ($state.maximized) { [void][DshMiniWin]::ShowWindow($hwnd, 3) }   # SW_MAXIMIZE
      Remove-Item $StatePath -Force -ErrorAction SilentlyContinue
      Emit @{ ok = $true; action = 'exit'; hwnd = $hwnd.ToInt64(); restored = $true }
    } else {
      [void][DshMiniWin]::DropTopmost($hwnd)
      Emit @{ ok = $true; action = 'exit'; hwnd = $hwnd.ToInt64(); restored = $false }
    }
  }
}