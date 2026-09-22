import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { mdsvex } from 'mdsvex';

// CMake sets LLAMA_UI_OUT_DIR to the staging dir under the build tree; manual
// `npm run build` runs without the env var default to ./dist.
const outDir = process.env.LLAMA_UI_OUT_DIR ?? './dist';
/** @type {import('@sveltejs/kit').Config} */
const config = {
	extensions: ['.svelte', '.svx'],

	kit: {
		adapter: adapter({
			assets: outDir,
			fallback: 'index.html',
			pages: outDir,
			precompress: false,
			strict: true
		}),
		output: {
			// 'single' 会把**所有**代码（含所有 await import() 的动态部分）内联进一个
			// bundle.js —— 实测 8.97MB，首屏必须把它整个下载、解析、编译完才能渲染。
			// 改成 'split' 后按路由/动态导入切块，首屏只加载入口那几块，
			// 重量级依赖（nerdamer 符号计算、katex、pdfjs 等）留在各自的 chunk 里按需拉。
			// 注：'split' 才是 SvelteKit 的默认值；本仓库原来为了把前端嵌进 C++ 二进制
			// 才选的 single，我们是 --path 指目录的部署方式，不需要它。
			bundleStrategy: 'split'
		},
		paths: {
			relative: true
		},
		router: { type: 'hash' }
	},

	// Consult https://svelte.dev/docs/kit/integrations
	// for more information about preprocessors
	preprocess: [vitePreprocess(), mdsvex()]
};

export default config;
