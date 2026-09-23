// 定点诊断「空闲卸载」自绘下拉：触发器属性 / 箭头旋转 / 弹出面板真实样式。
// 之所以要单独一个探针：cleanup_probe.mjs 里抓弹出面板用的是「body 下文本最短的 div」，
// 命中的往往是 bits-ui 的定位包裹层（无背景、无圆角），会误判成「没有圆角」。
//
// 用法: node tools/ui/idle_dropdown_probe.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire('D:/llama/ui-src/work/package.json');
const { chromium } = require('playwright');

const URL_ = process.env.PROBE_URL || 'http://127.0.0.1:8080/#/performance';
const CHROME = process.env.PROBE_CHROME
	|| 'C:/Users/shangmeng/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';

const lines = [];
const say = (...a) => { const s = a.join(' '); lines.push(s); console.log(s); };

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
await page.goto(URL_, { waitUntil: 'load', timeout: 90000 });
await page.waitForTimeout(3500);

const findTrigger = () => page.evaluate(() => {
	const b = [...document.querySelectorAll('button')].find(
		(x) => /^\s*(5|15|30)\s*(分钟|min)|^\s*(永不|never)\s*$/i.test(x.textContent || '')
	);
	if (!b) return null;
	b.setAttribute('data-idle-probe', '1');
	return true;
});

if (!findTrigger()) { say('❌ 没找到空闲下拉触发器'); await browser.close(); process.exit(1); }
await findTrigger();

// ⚠️ Tailwind v4 里 `rotate-180` 写的是 CSS 独立属性 `rotate`，**不是** `transform`
//    → 只读 `transform` 会永远得到 none，误判「箭头没转」。两个都要读。
const CHEV = `(() => {
	const svg = document.querySelector('[data-idle-probe="1"] svg');
	if (!svg) return null;
	const cs = getComputedStyle(svg);
	return { transform: cs.transform, rotate: cs.rotate, scale: cs.scale };
})()`;
const readChev = () => page.evaluate(CHEV);

const closed = await page.evaluate(`(() => {
	const b = document.querySelector('[data-idle-probe="1"]');
	return {
		triggerClass: b.className,
		attrs: [...b.attributes].map((a) => a.name + '="' + a.value + '"').filter((s) => !/^class=/.test(s)),
		box: b.getBoundingClientRect().toJSON()
	};
})()`);
const chevClosed = await readChev();
const svgClass = await page.evaluate(
	`document.querySelector('[data-idle-probe="1"] svg')?.getAttribute('class')`
);
say('=== 收起态 ===');
say('trigger class:', closed.triggerClass);
say('trigger 其它属性:', closed.attrs.join(' '));
say('chevron class:', svgClass);
say('chevron 计算值:', JSON.stringify(chevClosed));
say('trigger 尺寸:', Math.round(closed.box.width) + 'x' + Math.round(closed.box.height));

await page.click('[data-idle-probe="1"]');
await page.waitForTimeout(800);
const chevOpen = await readChev();

const open = await page.evaluate(`(() => {
	const b = document.querySelector('[data-idle-probe="1"]');
	// 面板定位：优先按 bits-ui/shadcn 的语义属性找，别靠「文本最长的 div」瞎猜
	const panel = document.querySelector(
		'[data-slot="dropdown-menu-content"], [role="menu"], [data-dropdown-menu-content], [data-bits-dropdown-menu-content]'
	);
	const pc = panel ? getComputedStyle(panel) : null;
	const chain = [];
	let el = panel;
	while (el && el !== document.body && chain.length < 6) {
		const cs = getComputedStyle(el);
		chain.push({
			tag: el.tagName.toLowerCase(),
			cls: String(el.className).slice(0, 100),
			r: cs.borderRadius, bg: cs.backgroundColor, bw: cs.borderWidth, z: cs.zIndex
		});
		el = el.parentElement;
	}
	return {
		triggerAttrs: [...b.attributes].map((a) => a.name + '="' + a.value + '"').filter((s) => !/^class=/.test(s)),
		found: !!panel,
		panelClass: panel ? String(panel.className) : null,
		radius: pc ? pc.borderRadius : null,
		bg: pc ? pc.backgroundColor : null,
		border: pc ? pc.borderWidth + ' ' + pc.borderStyle + ' ' + pc.borderColor : null,
		shadow: pc ? pc.boxShadow.slice(0, 70) : null,
		z: pc ? pc.zIndex : null,
		items: panel ? (panel.textContent || '').replace(/\\s+/g, ' ').trim() : null,
		chain
	};
})()`);

say('');
say('=== 展开态 ===');
say('trigger 其它属性:', open.triggerAttrs.join(' '));
say('chevron 计算值:', JSON.stringify(chevOpen));
say('面板（按 [role=menu]/[data-slot] 定位）:', open.found ? '找到' : '❌ 没找到');
if (open.found) {
	open.chain.forEach((c) => say(`   <${c.tag}> r=${c.r} bg=${c.bg} bw=${c.bw} z=${c.z}  ${c.cls}`));
	say('   圆角 =', open.radius, ' 背景 =', open.bg, ' 边框 =', open.border);
	say('   阴影 =', open.shadow);
	say('   内容 =', open.items);
}
const rotated = (v) => v && v.rotate && v.rotate !== 'none' && v.rotate !== '0deg';
const rotOk = rotated(chevOpen) && chevOpen.rotate !== (chevClosed && chevClosed.rotate);
say('判定箭头旋转:', rotOk
	? `✅ 展开后 rotate=${chevOpen.rotate}（收起时 ${chevClosed && chevClosed.rotate}）`
	: `❌ 展开/收起无变化（rotate=${chevOpen && chevOpen.rotate}）`);
const rOk = parseFloat(open.radius || '0') >= 4;
say('判定圆角:', rOk ? `✅ ${open.radius}（不是系统直角面板）` : `❌ 直角/未抓到（${open.radius}）`);

fs.mkdirSync('diag', { recursive: true });
fs.writeFileSync('diag/idle-dropdown-probe.txt', lines.join('\n') + '\n', 'utf8');
say('');
say('已写入 diag/idle-dropdown-probe.txt');

await browser.close();
