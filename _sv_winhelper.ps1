# StreamViewer launch helper.
# Finds all visible top-level windows whose title is exactly "StreamViewer"
# using the real Win32 EnumWindows API (not .NET's Process class, which can
# only see ONE window per process and therefore misses duplicates when a
# single Chrome process owns two top-level "StreamViewer" windows).
#
# Usage:
#   powershell -File _sv_winhelper.ps1 count    -> just count/list windows
#   powershell -File _sv_winhelper.ps1 dedupe   -> watch for up to ~15 seconds;
#                                                   whenever 2+ windows exist,
#                                                   close every extra one, keeping
#                                                   only the very first window seen.
#                                                   This handles the case where the
#                                                   second window appears late (a
#                                                   single check right after launch
#                                                   can miss it).
#
# NOTE: This file is intentionally written using only plain ASCII characters
# (no Japanese) to avoid encoding corruption when copy-pasted through Notepad
# on this machine, which appears to save as Shift-JIS/ANSI rather than UTF-8.

param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("count", "dedupe")]
    [string]$Mode
)

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class SvWinEnum {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    public static List<IntPtr> FindByExactTitle(string title) {
        var result = new List<IntPtr>();
        EnumWindows(delegate (IntPtr hWnd, IntPtr lParam) {
            if (!IsWindowVisible(hWnd)) return true;
            int len = GetWindowTextLength(hWnd);
            if (len == 0) return true;
            var sb = new StringBuilder(len + 1);
            GetWindowText(hWnd, sb, sb.Capacity);
            if (sb.ToString() == title) result.Add(hWnd);
            return true;
        }, IntPtr.Zero);
        return result;
    }
}
"@

$WM_CLOSE = 0x0010
$TITLE = "StreamViewer"

if ($Mode -eq "count") {
    $handles = [SvWinEnum]::FindByExactTitle($TITLE)
    Write-Output ("  window count: {0}" -f $handles.Count)
    for ($idx = 0; $idx -lt $handles.Count; $idx++) {
        $h = $handles[$idx]
        $procId = 0
        [void][SvWinEnum]::GetWindowThreadProcessId($h, [ref]$procId)
        Write-Output ("    hwnd={0} pid={1}" -f $h, $procId)
    }
}
else {
    # dedupe: poll repeatedly for ~15 seconds total. A late-appearing second
    # window (one that shows up after the first check) is closed as soon as
    # it is seen, instead of only checking once right after launch.
    $keepHandle = [IntPtr]::Zero
    $anyClosed = $false

    for ($t = 0; $t -lt 15; $t++) {
        Start-Sleep -Seconds 1
        $handles = [SvWinEnum]::FindByExactTitle($TITLE)
        if ($handles.Count -eq 0) { continue }

        if ($keepHandle -eq [IntPtr]::Zero) {
            $keepHandle = $handles[0]
            Write-Output ("  [t={0}s] first window seen, keeping hwnd={1}" -f $t, $keepHandle)
        }

        foreach ($h in $handles) {
            if ($h -ne $keepHandle) {
                [void][SvWinEnum]::PostMessage($h, $WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero)
                Write-Output ("  [t={0}s] closed extra hwnd={1}" -f $t, $h)
                $anyClosed = $true
            }
        }
    }

    if (-not $anyClosed) {
        Write-Output "  no duplicates found during the watch period"
    }
}