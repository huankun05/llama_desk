#  llama-desk 启动诊断（白屏 / 语言 / 加载速度）
#
#  用法（在你自己的 PowerShell 里跑，别在沙箱里跑 —— 沙箱里 GUI 起不来）：
#      powershell -NoProfile -ExecutionPolicy Bypass -File D:\llama\tools\diag\diag.ps1
#  或直接双击 D:\llama\tools\diag\diag.bat
#
#  它会做：
#    ① 环境与服务现状快照（WebView2 版本、8080/8090 是否在服务、静态产物是否带 overlay）
#    ② 关掉旧实例 -> 带 CDP 调试端口重新启动 -> 每 0.5s 记录一次时间线 + 定时窗口截图
#    ③ 连上真实 WebView2，抓 DOM 实况 / 中英文节点数 / 控制台报错 / 每个资源的 HTTP 状态与字节
#    ④ 关掉应用后扫 profile 的 localStorage，核对 overlay 自证标记与语言键
#    ⑤ 全部写进 D:\llama\diag\<时间戳>\ ，并生成一份 report.txt
#
#  跑完只要把「报告目录」那一行告诉我即可。
[CmdletBinding()]
param(
    [switch]$Attach,                                   # 不重启，直接连已运行的实例（需它本来就是带调试端口起的）
    [int]$CdpPort = 9555,
    [int]$ObserveSecs = 34,
    [string]$Exe = 'D:\llama\app\src-tauri\target\debug\llama-desk.exe',
    [int]$PostWaitSecs = 20,                           # 关掉应用后等多久再读 localStorage（等落盘）
    [switch]$NoExplorer                                # 不自动打开产物目录（自动跑/调试用）
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
# 关掉 Invoke-WebRequest 的进度条：不然每个请求都往控制台刷「正在读取 Web 响应…」
$ProgressPreference = 'SilentlyContinue'

$Root  = 'D:\llama'
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$Out   = Join-Path $Root ('diag\' + $Stamp)
New-Item -ItemType Directory -Force -Path $Out | Out-Null

$script:R = New-Object System.Collections.Generic.List[string]
function W([string]$s) { $script:R.Add($s) | Out-Null; Write-Host $s }
function Sec([string]$t) { W ''; W ('=' * 74); W ('  ' + $t); W ('=' * 74) }
function KV([string]$k, $v) { W ("  {0,-22} {1}" -f $k, $(if ($null -eq $v -or "$v" -eq '') { '(空)' } else { $v })) }

Write-Host ''
Write-Host '  llama-desk 启动诊断 —— 全程约 60~90 秒，期间请不要操作那个窗口' -ForegroundColor Cyan
Write-Host ''

# ============================================================ ① 环境
Sec '① 环境快照'
KV '时间' (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
KV '用户' "$env:USERDOMAIN\$env:USERNAME"
try { $adm = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } catch { $adm = '?' }
KV '管理员' $adm
KV 'PowerShell' $PSVersionTable.PSVersion.ToString()
try { KV 'OS' (Get-CimInstance Win32_OperatingSystem).Caption } catch {}

$wv2 = @()
foreach ($k in @(
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
        'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
        'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    )) {
    try { $pv = (Get-ItemProperty -Path $k -ErrorAction Stop).pv; if ($pv) { $wv2 += "$k => $pv" } } catch {}
}
KV 'WebView2 Runtime' ($(if ($wv2.Count) { $wv2 -join "`n                      " } else { '★ 没查到（WebView2 可能未安装）' }))
foreach ($e in @('C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe', 'C:\Program Files\Google\Chrome\Application\chrome.exe')) {
    if (Test-Path $e) { try { KV (Split-Path $e -Leaf) (Get-Item $e).VersionInfo.FileVersion } catch {} }
}
try {
    foreach ($s in 'http', 'https') {
        $p = Get-ItemProperty "HKCU:\SOFTWARE\Microsoft\Windows\Shell\Associations\UrlAssociations\$s\UserChoice" -ErrorAction SilentlyContinue
        KV "默认 $s 处理程序" $p.ProgId
    }
} catch {}

# 找 node（CDP 采集要用；找不到就跳过采集，其余照常）
$Node = $null
foreach ($c in @('node', 'E:\software\Nodejs\node.exe', 'C:\Users\shangmeng\.workbuddy\binaries\node\versions\22.22.2-3\node.exe')) {
    try {
        $v = (& $c -v 2>$null | Select-Object -First 1)
        if ($LASTEXITCODE -eq 0 -and $v -match '^v\d+') { $Node = $c; KV 'node' "$c  ($v)"; break }
    } catch {}
}
if (-not $Node) { KV 'node' '★ 未找到 → 跳过 CDP 采集（其余诊断不受影响）' }

$lsDirs = @()
$cfgPath = Join-Path $Root 'app\config.json'
if (Test-Path $cfgPath) {
    try {
        # 必须显式指定 UTF8：PS 5.1 的无 BOM 文本按 ANSI(GBK) 读，config.json 里有中文注释，
        # 不指定就会解成乱码 → ConvertFrom-Json 直接报「传入的对象无效」→ 后面所有配置项全空。
        $cfgRaw = Get-Content $cfgPath -Raw -Encoding UTF8
        $cfg = $cfgRaw | ConvertFrom-Json
        if ($cfg.webview_data_dir) { $lsDirs += ($cfg.webview_data_dir -replace '/', '\') }
        KV 'config: webview_data_dir' $cfg.webview_data_dir
        KV 'config: llama_port/manager_port' "$($cfg.llama_port) / $($cfg.manager_port)"
        KV 'config: window_timeout_secs' $cfg.window_timeout_secs
        KV 'config: browser_fallback' $cfg.browser_fallback
        KV 'config: open_path' $cfg.open_path
    } catch { KV 'config.json' "解析失败: $($_.Exception.Message)" }
}
$lsDirs += @(
    (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User Data\Default'),
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data\Default')
)

# ============================================================ ② 服务与产物
Sec '② 服务与静态产物现状（启动前）'
$ports = @(($cfg.llama_port, $cfg.manager_port, $CdpPort) | Where-Object { $_ } | ForEach-Object { [int]$_ })
$net = netstat -ano 2>$null | Select-String 'LISTENING'
foreach ($p in $ports) {
    $hit = $net | Select-String (":$p\s")
    if ($hit) {
        # 注意：变量名不能叫 $pid —— 那是 PowerShell 的只读自动变量，赋值会直接报错
        $procId = ($hit[0].ToString() -split '\s+')[-1]
        $nm = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName
        KV "端口 $p" "占用中 pid=$procId ($nm)"
    } else { KV "端口 $p" '空闲' }
}
$mgrPort = if ($cfg) { $cfg.manager_port } else { 8090 }
$llmPort = if ($cfg) { $cfg.llama_port } else { 8080 }
try { $ping = Invoke-RestMethod -Uri "http://127.0.0.1:$mgrPort/api/ping" -TimeoutSec 5; KV 'manager /api/ping' ($ping | ConvertTo-Json -Compress) } catch { KV 'manager /api/ping' "失败: $($_.Exception.Message)" }
try { $inst = Invoke-RestMethod -Uri "http://127.0.0.1:$mgrPort/api/instances" -TimeoutSec 5; KV 'manager 实例数' (@($inst).Count) } catch { KV 'manager /api/instances' "失败: $($_.Exception.Message)" }
try { $h = Invoke-WebRequest -Uri "http://127.0.0.1:$llmPort/health" -UseBasicParsing -TimeoutSec 5; KV 'llama-server /health' "HTTP $($h.StatusCode)" } catch { KV 'llama-server /health' "失败: $($_.Exception.Message)" }

$overlayTag = ''
try {
    $idx = Invoke-WebRequest -Uri "http://127.0.0.1:$llmPort/" -UseBasicParsing -TimeoutSec 10
    $m = [regex]::Match($idx.Content, 'overlay\.js\?v=(\d+)')
    $overlayTag = if ($m.Success) { "v=$($m.Groups[1].Value)" } else { '★ index.html 里没有 overlay 标签 ★' }
    KV 'served index.html' "$($idx.Content.Length) 字符, overlay $overlayTag"
} catch { KV 'served index.html' "失败: $($_.Exception.Message)" }

if ($overlayTag -match 'v=(\d+)') {
    $ovUrl = "http://127.0.0.1:$llmPort/overlay.js?v=$($overlayTag -replace 'v=','')"
    try {
        $ov = Invoke-WebRequest -Uri $ovUrl -UseBasicParsing -TimeoutSec 10
        $c = $ov.Content
        KV 'served overlay.js' "$($c.Length) 字符, Content-Type=$($ov.Headers['Content-Type'])"
        KV '  · 含 var LS_KEY' ($c -match 'var LS_KEY')
        KV '  · 含 var RULES' ($c -match 'var RULES')
        KV '  · 含 webui.overlay.diag（自证）' ($c -match 'webui\.overlay\.diag')
    } catch { KV 'served overlay.js' "失败: $($_.Exception.Message)" }
}

# ============================================================ ③ 启动
Sec '③ 关闭旧实例并用调试端口重新启动'
if (-not (Test-Path $Exe)) { W "  ★ exe 不存在：$Exe"; W '  请先构建：cd D:\llama\app && build.bat'; }
$running = @(Get-Process -Name 'llama-desk' -ErrorAction SilentlyContinue)
if ($running.Count -and $Attach) {
    W "  已有实例 pid=$($running[0].Id)，按 -Attach 不重启（若它不是带调试端口起的，CDP 会连不上）"
} elseif ($running.Count) {
    W "  先关闭已运行的 llama-desk (pid=$($running[0].Id))"
    taskkill /F /IM llama-desk.exe 2>&1 | ForEach-Object { W "    $_" }
    Start-Sleep -Seconds 2
} else { W '  当前没有运行中的 llama-desk' }

$bootPath = Join-Path $Root 'app\logs\boot.log'
$bootBefore = if (Test-Path $bootPath) { (Get-Content $bootPath).Count } else { 0 }
$bootMtime  = if (Test-Path $bootPath) { (Get-Item $bootPath).LastWriteTime } else { $null }
KV 'boot.log 启动前行数' $bootBefore

if (-not $Attach) {
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$CdpPort --remote-allow-origins=*"
    KV '注入环境变量' "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"
    Start-Process -FilePath $Exe -WorkingDirectory $Root
    W '  已启动。开始观察…'
} else { W '  跳过启动，直接观察已运行实例' }

# ---- 窗口截图（GDI 抓窗口区域；失败不致命）
function Save-Shot([string]$file) {
    try {
        Add-Type -AssemblyName System.Drawing -ErrorAction Stop
        if (-not ('WinRect' -as [type])) {
            Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class WinRect {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
}
'@ -ErrorAction Stop
        }
        $p = Get-Process -Name 'llama-desk' -ErrorAction SilentlyContinue |
             Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
        if (-not $p) { return '无窗口句柄' }
        [void][WinRect]::SetForegroundWindow($p.MainWindowHandle)
        Start-Sleep -Milliseconds 150
        $r = New-Object 'WinRect+RECT'
        if (-not [WinRect]::GetWindowRect($p.MainWindowHandle, [ref]$r)) { return '取窗口矩形失败' }
        $w = $r.R - $r.L; $h = $r.B - $r.T
        if ($w -le 0 -or $h -le 0) { return "窗口矩形无效 ${w}x${h}" }
        $bmp = New-Object System.Drawing.Bitmap $w, $h
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
        $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
        $g.Dispose(); $bmp.Dispose()
        return "ok ${w}x${h}"
    } catch { return "截图失败: $($_.Exception.Message)" }
}

Sec '④ 启动时间线（每 0.5s 一行；截图在关键节点）'
$shotAt = @(1, 3, 6, 12, 20, 28)
$done = New-Object System.Collections.Generic.HashSet[double]
$t = 0.0; $cdpAt = $null; $seenTitle = ''; $exitAt = $null
while ($t -lt $ObserveSecs) {
    Start-Sleep -Milliseconds 500
    $t = [math]::Round($t + 0.5, 1)
    $proc = Get-Process -Name 'llama-desk' -ErrorAction SilentlyContinue | Select-Object -First 1
    $alive = [bool]$proc
    if (-not $alive -and -not $exitAt) { $exitAt = $t }
    $wv = @(Get-Process -Name 'msedgewebview2' -ErrorAction SilentlyContinue).Count
    $title = if ($proc) { $proc.MainWindowTitle } else { '' }
    if ($title) { $seenTitle = $title }
    $cdpOk = $false
    try { Invoke-RestMethod -Uri "http://127.0.0.1:$CdpPort/json/version" -TimeoutSec 1 | Out-Null; $cdpOk = $true } catch {}
    if ($cdpOk -and -not $cdpAt) { $cdpAt = $t }
    W ("  t={0,5:N1}s  应用={1,-5}  WebView2进程={2,-3}  CDP={3,-5}  窗口标题='{4}'" -f $t, $alive, $wv, $cdpOk, $title)
    foreach ($m in $shotAt) {
        if ($t -ge $m -and -not $done.Contains([double]$m)) {
            [void]$done.Add([double]$m)
            $res = Save-Shot (Join-Path $Out ("shot-t{0}s.png" -f $m))
            W ("            └ 截图 t={0}s: {1}" -f $m, $res)
        }
    }
}
KV '首次出现窗口标题的时刻' $(if ($seenTitle) { "已有内容（$seenTitle）" } else { '★ 全程没有窗口标题 → 从没渲染出界面 ★' })
KV 'CDP 就绪时刻' $(if ($cdpAt) { "$cdpAt s" } else { '★ 从未就绪 → WebView2 浏览器进程没起来 ★' })
KV '应用退出时刻' $(if ($exitAt) { "$exitAt s" } else { '观察期内一直存活' })

# ============================================================ ⑤ CDP 采集
Sec '⑤ 真实 WebView2 界面采集（CDP）'
if ($Node -and $cdpAt) {
    # 兄弟脚本用 $PSScriptRoot 定位（本文件在 tools\diag\ 下，和采集器放一起）
    $cdpJs = Join-Path $PSScriptRoot 'diag_cdp.mjs'
    if (Test-Path $cdpJs) {
        W "  执行: $Node _diag_cdp.mjs --port $CdpPort --out $Out"
        $cdpLog = Join-Path $Out 'cdp-stdout.txt'
        # 先收到变量再显式按 UTF-8 落盘：Tee-Object 在 PS5.1 没有 -Encoding，中文会花
        $cdpOut = & $Node $cdpJs --port $CdpPort --out $Out 2>&1
        $cdpOut | Out-File -Encoding utf8 $cdpLog
        $cdpOut | ForEach-Object { W "    $_" }
        KV 'CDP 采集退出码' $LASTEXITCODE
    } else { W "  ★ 找不到 $cdpJs" }
} else {
    if (-not $Node) { W '  跳过：没有 node' }
    if (-not $cdpAt) { W '  ★ 跳过：CDP 端口没起来（这本身就说明 WebView2 没正常运行）' }
    # 退一步：如果系统浏览器被拉起来了，那些浏览器的调试端口不在，无法采集；
    # 但 profile 取证（第⑥步）仍能给出语言与 overlay 的答案。
}

# ============================================================ ⑥ 落盘取证
Sec '⑥ profile 取证与日志'
if (Test-Path $bootPath) {
    $all = @(Get-Content $bootPath -Encoding UTF8)   # 同 config.json：必须显式 UTF8，否则中文全乱
    $new = if ($all.Count -gt $bootBefore) { @($all[$bootBefore..($all.Count - 1)]) } else { @() }
    W "  boot.log 本次新增 $($new.Count) 行（总 $($all.Count) 行）："
    $new | ForEach-Object { W "    $_" }
    Copy-Item $bootPath (Join-Path $Out 'boot.log') -Force
}
$procs = @()
$procs += '--- llama-desk / msedgewebview2 / llama-server / python ---'
Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'llama-desk|msedgewebview2|llama-server|python' } | ForEach-Object {
    $cl = if ($_.CommandLine) { $_.CommandLine } else { '' }
    $procs += ("pid={0,-7} ppid={1,-7} {2,-22} {3}" -f $_.ProcessId, $_.ParentProcessId, $_.Name, $cl.Substring(0, [Math]::Min(220, $cl.Length)))
}
$procs += ''
$procs += '--- 监听端口 ---'
$procs += (netstat -ano 2>$null | Select-String 'LISTENING' | ForEach-Object { $_.ToString() })
$procs | Out-File -Encoding utf8 (Join-Path $Out 'procs.txt')
W '  已写 procs.txt'

if (-not $Attach) {
    W "  等 $PostWaitSecs 秒让 localStorage 落盘，然后读取 profile…"
    Start-Sleep -Seconds $PostWaitSecs
}
if ($Node) {
    $lsJs = Join-Path $PSScriptRoot 'diag_ls.mjs'
    if (Test-Path $lsJs) {
        $args2 = @($lsJs, '--out', $Out)
        foreach ($d in $lsDirs) { $args2 += @('--dir', $d) }
        $lsLog = Join-Path $Out 'localstorage.txt'
        & $Node @args2 2>&1 | Set-Content -Encoding utf8 $lsLog
        W "  localStorage 取证已写入 localstorage.txt（扫描了 $($lsDirs.Count) 个 profile）"
        Get-Content $lsLog | Where-Object { $_ -match 'webui\.|◆|未找到|origin' } | Select-Object -First 40 | ForEach-Object { W "    $_" }
    }
}

# ============================================================ ⑦ 汇总
Sec '⑦ 汇总报告'
$report = Join-Path $Out 'report.txt'
$R | Set-Content -Encoding utf8 $report
W ''
Write-Host ''
Write-Host '  ============================================================' -ForegroundColor Green
Write-Host "   报告目录:  $Out" -ForegroundColor Green
Write-Host "   汇总文件:  $report" -ForegroundColor Green
Write-Host '   把这行「报告目录」发给我就行。' -ForegroundColor Green
Write-Host '  ============================================================' -ForegroundColor Green
Write-Host ''
if (-not $NoExplorer) { try { Start-Process explorer.exe $Out } catch {} }
