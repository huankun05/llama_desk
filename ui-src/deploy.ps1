# 部署脚本：把改中文后的构建产物发布到 D:\llama\webui
# 用法：在 work 目录 npm run build 之后执行
#
# ⚠️ 本文件含中文，必须保存为「UTF-8 带 BOM」！
#    否则 Windows PowerShell 5.1 会按系统 ANSI(GBK) 解码，中文注释被误读后产生杂散字节，
#    报出一堆「字符串缺少终止符」「不允许使用空管道元素」之类的假语法错误。
$ErrorActionPreference = 'Stop'
$src = 'D:\llama\ui-src\work\dist'
$dst = 'D:\llama\webui'

if (-not (Test-Path $src)) { Write-Error "未找到构建产物 $src，请先 npm run build" }

# 备份当前 webui → D:\llama\rollback\（webui 内的 backup/ 不动）
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$rollbackDir = 'D:\llama\rollback'
if (-not (Test-Path $rollbackDir)) { New-Item -ItemType Directory -Path $rollbackDir -Force | Out-Null }
$backup = Join-Path $rollbackDir "webui-built-$stamp"
if (Test-Path $dst) { Copy-Item $dst $backup -Recurse -Force; Write-Host "已备份旧 webui -> $backup" }

# ---------------------------------------------------------------------------
# 清理 dst 下的旧构建产物，再拷入新构建。
# 下面这些是「非构建产物」，构建产物里没有、部署时必须原样保留：
#   overlay.js               运行时中文注入层（不参与打包）
#   manager.py               自研监控后端（:8090）
#   _dumpsettings.js         自定义调试脚本
#   start-manager.bat        管理器启动脚本
#   start-minicpm5-webui.bat WebUI 启动脚本
#   backup/                  历史备份
# 另外 *.log 与 __pycache__ 也一并保留：删了没用还容易误伤，留着更安全。
# ---------------------------------------------------------------------------
$KEEP = @(
	'backup', 'overlay.js', 'manager.py', '_dumpsettings.js',
	'start-manager.bat', 'restart-manager.bat', 'start-minicpm5-webui.bat'
)

$removed = @()
Get-ChildItem $dst | Where-Object {
	$n = $_.Name
	($KEEP -notcontains $n) -and ($n -notlike '*.log') -and ($n -ne '__pycache__')
} | ForEach-Object {
	$removed += $_.Name
	Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
}
if ($removed.Count -gt 0) {
	Write-Host ("已清理旧构建产物: " + ($removed -join ', '))
} else {
	Write-Host "无需清理（目录本身就是干净的）"
}

Copy-Item "$src\*" $dst -Recurse -Force
Write-Host "已部署构建产物到 $dst"

# ---------------------------------------------------------------------------
# overlay.js 是「运行时中文注入层」，它在构建产物里**不存在**（不参与打包），
# 每次部署覆盖 index.html 之后都必须重新挂上去，否则界面会退回英文。
# 之前这步靠手工编辑 index.html，容易漏，这里自动化：
#   1) 把最新的 overlay.js 拷进 webui（上面的保留名单会保留旧文件，需要主动更新内容）
#   2) 在 </body> 前注入 <script src="./overlay.js?v=N">，版本号自增以破缓存
# ---------------------------------------------------------------------------
$overlaySrc = 'D:\llama\ui-src\overlay.js'
if (Test-Path $overlaySrc) {
	Copy-Item $overlaySrc (Join-Path $dst 'overlay.js') -Force
	Write-Host "已更新 overlay.js"
} else {
	Write-Warning "未找到 $overlaySrc，overlay.js 未更新"
}

$index = Join-Path $dst 'index.html'
if (Test-Path $index) {
	$html = Get-Content $index -Raw
	# 版本号必须【单调递增】，否则浏览器会一直命中旧缓存。
	#
	# 踩过的坑：原来这里从 $dst\index.html 读上一次的版本号再 +1，注释还写着
	# 「任何情况下版本号都是新的」。但上面的清理步骤已经把 index.html 换成了全新
	# 构建产物（里面根本没有 overlay 标签）→ 每次都会退回 15 + 1 = 16 → 版本号
	# 恒定不变，于是 overlay.js 的更新永远不生效（界面一直是旧词条）。
	# 改用部署目录【之外】的计数器文件：它不会被清理，天然单调递增。
	$verFile = 'D:\llama\ui-src\.overlay-version'
	$ver = 0
	if (Test-Path $verFile) {
		try { $ver = [int]((Get-Content $verFile -Raw).Trim()) } catch { $ver = 0 }
	}
	if ($ver -lt 15) { $ver = 15 }
	$ver = $ver + 1
	Set-Content -Path $verFile -Value $ver -Encoding ASCII
	# 去掉旧标签（含可选的反引号/单引号写法），再注入新的
	$html = [regex]::Replace($html, '<script[^>]*src=["'']\./overlay\.js[^"'']*["''][^>]*>\s*</script>\s*', '')
	$tag = '<script src="./overlay.js?v=' + $ver + '"></script>'
	$html = $html -replace '</body>', ($tag + "`r`n`t</body>")
	# 不写 BOM，保持 index.html 原样
	[System.IO.File]::WriteAllText($index, $html, (New-Object System.Text.UTF8Encoding($false)))
	Write-Host "已重新挂载 overlay.js?v=$ver"
}

# ---------------------------------------------------------------------------
# 备份轮转：只保留最近 3 份 webui-built-*（都在 D:\llama\rollback\）。
#
# 这条是补上的——原来只备份不轮转，一天下来攒了 33 份 × 20MB ≈ 650MB。
# 每一份只是「上一次部署的回滚点」，留 3 份足够；更早的除了占盘没有任何作用。
# 刻意放在整个部署流程【最后】：中途失败就不会顺手删掉还能用的回滚点。
# 另外这里不删 .overlay-version —— 那个计数器在 webui 之外，必须保留。
# ---------------------------------------------------------------------------
$keepBackups = 3
$staleBackups = Get-ChildItem 'D:\llama\rollback' -Directory -Filter 'webui-built-*' |
	Sort-Object LastWriteTime -Descending |
	Select-Object -Skip $keepBackups
if ($staleBackups) {
	foreach ($b in $staleBackups) {
		Remove-Item $b.FullName -Recurse -Force -ErrorAction SilentlyContinue
	}
	Write-Host ("已轮转删除 " + $staleBackups.Count + " 份过期备份，保留最近 $keepBackups 份")
} else {
	Write-Host "备份数未超过 $keepBackups 份，无需轮转"
}
