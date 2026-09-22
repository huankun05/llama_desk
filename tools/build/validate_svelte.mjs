// 快速校验改动的 Svelte / runes 模块能否被官方编译器编译通过。
// 用法：node D:\llama\tools\build\validate_svelte.mjs [相对 work/src 的路径 ...]
//   - 不给参数时校验一组默认的「本项目改动文件」
//   - .svelte -> svelte/compiler 的 compile()；.ts -> 先用 esbuild 剥类型再 compileModule()
//
// ⚠️ 本脚本住在 tools/build/，而 svelte / esbuild 装在 ui-src/work/node_modules。
//    ESM 的裸模块解析是从【脚本自身位置】逐级往上找 node_modules，不会去找兄弟目录，
//    所以直接 `import 'svelte/compiler'` 会报 ERR_MODULE_NOT_FOUND。
//    （2026-09-21 把脚本从 work/ 搬进 tools/ 时踩到；设 NODE_PATH 也没用 —— 那只对 CJS 生效。）
//    解法：用 createRequire 以 work 的 package.json 为基准解析，然后 require 进来。
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const WORK = 'D:/llama/ui-src/work';
const ROOT = path.join(WORK, 'src');

// svelte 的 require 入口是个 CJS shim（导出 = { VERSION, compile, compileModule, ... }），
// 所以直接解构返回值即可；换成 ESM 入口时 require(ESM) 也返回同样的命名空间。
const _req = createRequire(path.join(WORK, 'package.json'));
const { compile, compileModule } = _req('svelte/compiler');
const { transform } = _req('esbuild');

const DEFAULT_FILES = [
	// 侧栏搜索改造
	'lib/components/app/navigation/SidebarNavigation/SidebarNavigation.svelte',
	'lib/components/app/navigation/SidebarNavigation/SidebarNavigationActions.svelte',
	// 自研页面
	'routes/(chat)/performance/+page.svelte',
	'routes/(chat)/parameters/+page.svelte',
	// 模型装载下拉 + 聊天动作栏（圆环常驻）
	'lib/components/app/models/ModelLoaderDropdown.svelte',
	'lib/components/app/chat/ChatForm/ChatFormActions/ChatFormActionModels.svelte',
	'lib/components/app/chat/ChatForm/ChatFormActions/ChatFormActions.svelte',
	'lib/components/app/settings/SettingsChat/SettingsChatBackupTab.svelte',
	// stores / services
	'lib/stores/launch-presets.svelte.ts',
	'lib/services/manager.service.ts',
	'lib/services/backupService.ts',
	// barrel 文件（只做 re-export，最容易漏改）
	'lib/stores/index.ts',
	'lib/services/index.ts'
];

const files = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_FILES;

let failed = 0;

for (const rel of files) {
	const file = path.join(ROOT, rel);
	try {
		const raw = fs.readFileSync(file, 'utf8');

		if (rel.endsWith('.svelte')) {
			const res = compile(raw, { filename: rel, generate: 'client', dev: true });
			const warns = res.warnings ?? [];
			console.log(`OK   ${rel}${warns.length ? '  (warnings: ' + warns.length + ')' : ''}`);
			for (const w of warns) console.log(`      warn: ${w.code} ${w.message}`);
		} else {
			// compileModule 不认 TypeScript：先用 esbuild 剥类型（与 vite 的实际管线一致）
			const stripped = await transform(raw, { loader: 'ts', format: 'esm' }).then((r) => r.code);
			const res = compileModule(stripped, { filename: rel, generate: 'client', dev: true });
			const warns = res.warnings ?? [];
			console.log(`OK   ${rel}${warns.length ? '  (warnings: ' + warns.length + ')' : ''}`);
			for (const w of warns) console.log(`      warn: ${w.code} ${w.message}`);
		}
	} catch (e) {
		failed++;
		console.log(`FAIL ${rel}`);
		console.log('     ' + String(e.message).split('\n').slice(0, 14).join('\n     '));
	}
}

console.log(failed === 0 ? '\nALL_SVELTE_OK' : `\nFAILED=${failed}`);
process.exit(failed === 0 ? 0 : 1);
