// 安全追加工具（WorkBuddy 沙箱专用）
//
// ⚠️ 为什么需要它：沙箱里给**已存在**的文件做 shell 重定向（`cat >> f << EOF`、`>>`、`tee -a`、`sed -i`）
//    会**静默覆盖文件头部**而不是追加 —— 字节数甚至可能不变（实测 2026-09-22：
//    `cat >> docs/notes/webui-cache-debug.md` 把前 13 行替换成了新内容，`wc -c` 前后都是 6319）。
//    往记忆文件 / 日志 / 配置 / HISTORY 追加内容时一律走本脚本。
//
// 用法:
//   node tools/ops/append_file.mjs <目标文件> <片段文件>   # 片段用 Write 工具写成 UTF-8，避免命令行编码问题
//   node tools/ops/append_file.mjs <目标文件> --check      # 只打印行数/字节数，不改
import fs from 'node:fs';

const [target, frag] = process.argv.slice(2);
if (!target) {
	console.error('用法: node tools/ops/append_file.mjs <目标文件> <片段文件|--check>');
	process.exit(2);
}

const stat = (p) => {
	try {
		const b = fs.readFileSync(p);
		return { lines: b.toString('utf8').split('\n').length, bytes: b.length };
	} catch { return { lines: 0, bytes: 0 }; }
};

const before = stat(target);

if (!frag || frag === '--check') {
	console.log(`${target}: ${before.lines} 行 / ${before.bytes} 字节`);
	process.exit(0);
}

const body = fs.readFileSync(frag, 'utf8');
fs.appendFileSync(target, body, 'utf8');
const after = stat(target);

console.log(`${target}: ${before.lines} 行 / ${before.bytes} 字节 → ${after.lines} 行 / ${after.bytes} 字节`);
if (after.bytes <= before.bytes && body.trim()) {
	console.error('!! 字节数没有增长 —— 追加可能失败，请人工核对');
	process.exit(1);
}
console.log('追加成功');
