(function(){
  'use strict';
  // ---------- 自证运行（诊断用，勿删）----------
  // 用户报「打开是英文」时，最需要回答的是**脚本到底有没有被执行**。
  // 光看「界面是英文」分不清三种情况：①脚本没被加载 ②加载了但报错中断
  // ③加载执行了但没翻译到。所以这里在**同步执行的最开头**就往 localStorage
  // 写一条 boot 记录（含脚本自身 URL 里的版本号），只要浏览器打开过一次页面
  // 就能从 profile 里读出来，不必指望用户复现。
  var SELF_SRC = '';
  try { SELF_SRC = (document.currentScript && document.currentScript.src) || ''; } catch(e){}
  try {
    localStorage.setItem('webui.overlay.boot', JSON.stringify({
      src: SELF_SRC, at: Date.now(), ready: document.readyState, href: location.href
    }));
  } catch(e){ /* 隐私模式等场景写不了，忽略 */ }
  var DICT = {
    '&middot;': '·',
    '&nbsp;in&nbsp;': ' 在 ',
    '(Run': '（运行',
    '(failed)': '（失败）',
    '(not available)': '（不可用）',
    '(optional)': '（可选）',
    '(with line numbers)': '（带行号）',
    '? This action cannot be\\n\\t\\t\\t\\tundone.': '？此操作不可撤销。',
    'A new version is available. Reload to update.': '有新版本可用，重新加载以更新。',
    'API Key': 'API 密钥',
    'Access denied': '访问被拒绝',
    'Access denied - check server permissions': '访问被拒绝 - 请检查服务器权限',
    'Across all turns': '所有轮次合计',
    'Add': '添加',
    'Add New MCP Server': '添加新 MCP 服务器',
    'Add New Server': '添加新服务器',
    'Add a remote MCP server': '添加远程 MCP 服务器',
    'Add another MCP server': '添加另一个 MCP 服务器',
    'Add files': '添加文件',
    'Add files, prompts, tools or MCP Servers': '添加文件、提示词、工具或 MCP 服务器',
    'Add files, system prompt or configure MCP servers': '添加文件、系统提示词或配置 MCP 服务器',
    'Add to chat': '加入对话',
    'Add to favorites': '添加到收藏',
    'Add your first MCP server': '添加你的第一个 MCP 服务器',
    'Agentic': '智能体',
    'Agentic summary': '智能体摘要',
    'Agentic turns': '智能体轮次',
    'Agentic turns (LLM calls)': '智能体轮次（LLM 调用）',
    'All MCP server connections failed': '所有 MCP 服务器连接失败',
    'All conversations deleted': '已删除所有对话',
    'Allow once': '仅本次允许',
    'Always allow': '始终允许',
    'Always show sidebar on desktop': '在桌面端始终显示侧栏',
    'Always show tool call content': '始终显示工具调用内容',
    'Applies to new conversations. Tool picks inside a chat only affect that chat.': '适用于新对话。对话内的工具选择只影响该对话。',
    'Are you sure you want to delete': '确定要删除',
    'Ask anything...': '随便问问…',
    'Assistant message with actions': '带操作的助手消息',
    'Attach a file': '附加文件',
    'Audio Files': '音频文件',
    'Audio preview not available': '音频预览不可用',
    'Audio recording not supported': '不支持音频录制',
    'Available context size is only visible once the model is loaded.': '可用上下文长度仅在模型加载后可见。',
    'Available models': '可用模型',
    'Available resources': '可用资源',
    'Avg speed': '平均速度',
    'Backend sampling': '后端采样',
    'Bearer': 'Bearer',
    'Bearer <token>': 'Bearer <令牌>',
    'Binary content': '二进制内容',
    'Branch conversation after edit': '编辑后分支对话',
    'Browse': '浏览',
    'Browse and attach resources from connected MCP servers to your chat context.': '浏览并附加来自已连接 MCP 服务器的资源到对话上下文。',
    'Browse up-to-date documentation and code examples for libraries and frameworks.': '浏览库与框架的最新文档与代码示例。',
    'Browser Tools': '浏览器工具',
    'Build Info': '构建信息',
    'Bulk actions for selected conversations': '对已选对话的批量操作',
    'Cancel': '取消',
    'Capabilities exchanged successfully': '能力交换成功',
    'Chat': '对话',
    'Chat Template': '对话模板',
    'Chat completion request was aborted': '聊天补全请求已中止',
    'Check server logs for any error messages': '查看服务器日志中的错误信息',
    'Check that the server is accessible at the correct URL': '确认服务器可从正确 URL 访问',
    'Choose a color theme for the application.': '为应用选择配色主题。',
    'Choose a model to use for the conversation': '选择一个用于本次对话的模型',
    'Choose working directory': '选择工作目录',
    'Clear search': '清除搜索',
    'Cleared all user overrides': '已清除所有用户覆盖',
    'Click for model details': '点击查看模型详情',
    'Close': '关闭',
    'Close Sidebar': '关闭侧边栏',
    'Close preview': '关闭预览',
    'Close tab': '关闭标签页',
    'Code copied to clipboard': '代码已复制到剪贴板',
    'Code incomplete': '代码不完整',
    'Coerce legacy string-encoded booleans in persisted config to real booleans': '将持久化配置中的旧字符串布尔值强制转为真实布尔值',
    'Collapse': '收起',
    'Collapse System Message': '收起系统消息',
    'Collapse navigation': '收起导航',
    'Completions': '补全',
    'Configure Server': '配置服务器',
    'Connect a remote MCP server by URL.': '通过 URL 连接远程 MCP 服务器。',
    'Connecting to server...': '正在连接服务器…',
    'Connection Error': '连接错误',
    'Connection error - please try again': '连接错误 - 请重试',
    'Console': '控制台',
    'Context': '上下文',
    'Context Size': '上下文长度',
    'Context usage': '上下文占用',
    'Continue': '继续',
    'Continue generation error:': '继续生成错误：',
    'Conversation Name': '对话名称',
    'Conversation deleted': '对话已删除',
    'Conversation exported': '对话已导出',
    'Conversation forked': '对话已分叉',
    'Conversation pin toggled': '对话置顶状态已切换',
    'Conversation tabs': '对话标签页',
    'Conversation title': '对话标题',
    'Converting PDF to images...': '正在将 PDF 转为图片…',
    'Copied to clipboard': '已复制到剪贴板',
    'Copy': '复制',
    'Copy IndexedDB from LlamacppWebui to LlamaUi database (non-destructive)': '将 IndexedDB 从 LlamacppWebui 复制到 LlamaUi 数据库（非破坏性）',
    'Copy code': '复制代码',
    'Copy content': '复制内容',
    'Copy legacy custom config key to customJson (non-destructive)': '复制旧自定义配置键到 customJson（非破坏性）',
    'Copy localStorage keys from LlamaCppWebui to LlamaUi prefix (non-destructive)': '将 LlamaCppWebui 的 localStorage 键复制到 LlamaUi 前缀（非破坏性）',
    'Copy mcpDefaultEnabled localStorage key into settings config (preserves legacy keys)': '将 mcpDefaultEnabled 的 localStorage 键写入设置配置（保留旧键）',
    'Copy mermaid syntax': '复制 mermaid 语法',
    'Copy model name': '复制模型名称',
    'Copy model name to clipboard': '复制模型名称到剪贴板',
    'Copy model path to clipboard': '复制模型路径到剪贴板',
    'Copy standalone theme key to config object (non-destructive)': '复制独立主题键到配置对象（非破坏性）',
    'Copy svg source': '复制 svg 源码',
    'Copy text attachments as plain text': '以纯文本复制文本附件',
    'Copy to clipboard': '复制到剪贴板',
    'Current model details and capabilities': '当前模型的详细信息与能力',
    'Current model does not support audio': '当前模型不支持音频',
    'Current time': '当前时间',
    'Current time is&nbsp;': '当前时间是',
    'Custom': '自定义',
    'Custom CSS': '自定义 CSS',
    'Custom Headers': '自定义请求头',
    'Custom JSON': '自定义 JSON',
    'Custom Tools': '自定义工具',
    'DRY allowed length': 'DRY 允许长度',
    'DRY base': 'DRY 基数',
    'DRY multiplier': 'DRY 乘数',
    'DRY penalty last N': 'DRY 惩罚最近 N',
    'Dark': '深色',
    'Default': '默认',
    'Delete': '删除',
    'Delete All': '全部删除',
    'Delete Conversation': '删除对话',
    'Delete Message': '删除消息',
    'Delete Server': '删除服务器',
    'Delete all conversations': '删除所有对话',
    'Delete conversation?': '删除对话？',
    'Delete selected': '删除所选',
    'Deny': '拒绝',
    'Deselect all': '取消全选',
    'Details': '详情',
    'Developer': '开发者',
    'Diagram incomplete': '图表不完整',
    'Disable automatic scroll': '关闭自动滚动',
    'Disable reasoning content parsing': '关闭推理内容解析',
    'Discard changes?': '放弃更改？',
    'Dismiss': '忽略',
    'Dismiss environment check': '关闭环境检查',
    'llama-server not found:': '未找到 llama-server：',
    'No models in:': '模型目录中没有模型：',
    'NVIDIA driver tools not detected.': '未检测到 NVIDIA 驱动工具。',
    'VRAM estimates, GPU panel and VRAM cleanup are unavailable.': '显存预演、GPU 面板与显存清理将不可用。',
    'See the project README for setup instructions.': '安装步骤见项目 README。',
    'Display': '显示',
    'Display name': '显示名称',
    'Download SVG': '下载 SVG',
    'Download content': '下载内容',
    'Drop your files here to upload': '将文件拖到此处上传',
    'Dynamic temperature exponent': '动态温度指数',
    'Dynamic temperature range': '动态温度范围',
    'Edit': '编辑',
    'Edit file': '编辑文件',
    'Edit system message...': '编辑系统消息…',
    'Edit your message...': '编辑你的消息…',
    'Embedding Size': '嵌入维度',
    'Empty Files Detected': '检测到空文件',
    'Empty Files:': '空文件：',
    'Empty files cannot be processed or sent to the AI model': '空文件无法处理或发送给模型',
    'Enable PDF as Images': '将 PDF 作为图片',
    'Enable \\"Continue\\" button': '启用“继续”按钮',
    'Enable raw output toggle': '启用原始输出开关',
    'Enabled': '已启用',
    'Enter API Key': '输入 API 密钥',
    'Enter fork name': '输入分叉名称',
    'Enter your API key...': '输入你的 API 密钥…',
    'Enter {name}': '输入{name}',
    'Error checking API key:': '检查 API 密钥时出错：',
    'Error converting PDF to images:': '将 PDF 转为图片时出错：',
    'Error converting PDF to text:': '将 PDF 转为文本时出错：',
    'Error fetching server properties:': '获取服务器属性时出错：',
    'Error in sendMessage:': 'sendMessage 出错：',
    'Error parsing JSON chunk:': '解析 JSON 片段时出错：',
    'Error processing file': '处理文件时出错',
    'Exclude reasoning from context': '将推理内容排除在上下文外',
    'Exit bulk selection mode': '退出批量选择模式',
    'Expand navigation': '展开导航',
    'Export conversations': '导出对话',
    'Export failed:': '导出失败：',
    'Export selected': '导出所选',
    'Export settings': '导出设置',
    'Failed to add system prompt:': '添加系统提示词失败：',
    'Failed to attach resources:': '附加资源失败：',
    'Failed to attach template resource:': '附加模板资源失败：',
    'Failed to bulk delete conversations:': '批量删除对话失败：',
    'Failed to bulk export conversations:': '批量导出对话失败：',
    'Failed to bulk toggle pin:': '批量切换置顶失败：',
    'Failed to connect to server': '连接服务器失败',
    'Failed to continue agentic turn:': '继续智能体轮次失败：',
    'Failed to continue message:': '继续消息失败：',
    'Failed to convert HEIC to PNG:': '将 HEIC 转为 PNG 失败：',
    'Failed to convert SVG to PNG:': '将 SVG 转为 PNG 失败：',
    'Failed to convert WebP to PNG:': '将 WebP 转为 PNG 失败：',
    'Failed to convert audio to WAV:': '将音频转为 WAV 失败：',
    'Failed to copy code': '复制代码失败',
    'Failed to copy code:': '复制代码失败：',
    'Failed to copy mermaid syntax:': '复制 mermaid 语法失败：',
    'Failed to copy svg source:': '复制 svg 源码失败：',
    'Failed to copy to clipboard': '复制到剪贴板失败',
    'Failed to copy to clipboard:': '复制到剪贴板失败：',
    'Failed to delete all conversations:': '删除所有对话失败：',
    'Failed to delete conversation:': '删除对话失败：',
    'Failed to delete conversations': '删除对话失败',
    'Failed to delete conversations:': '删除对话失败：',
    'Failed to delete message:': '删除消息失败：',
    'Failed to edit assistant message:': '编辑助手消息失败：',
    'Failed to edit message with branching:': '分支编辑消息失败：',
    'Failed to edit user message:': '编辑用户消息失败：',
    'Failed to export conversations': '导出对话失败',
    'Failed to export settings': '导出设置失败',
    'Failed to export settings:': '导出设置失败：',
    'Failed to fetch': '获取失败',
    'Failed to fetch router models:': '获取路由模型失败：',
    'Failed to fork conversation': '分叉对话失败',
    'Failed to fork conversation:': '分叉对话失败：',
    'Failed to generate response:': '生成回复失败：',
    'Failed to get 2D canvas context.': '获取 2D 画布上下文失败。',
    'Failed to get 2D context from canvas': '从画布获取 2D 上下文失败',
    'Failed to import conversations': '导入对话失败',
    'Failed to import settings': '导入设置失败',
    'Failed to import settings:': '导入设置失败：',
    'Failed to initialize conversations:': '初始化对话失败：',
    'Failed to initialize settings store:': '初始化设置存储失败：',
    'Failed to load PDF images': '加载 PDF 图片失败',
    'Failed to load conversation:': '加载对话失败：',
    'Failed to load conversations': '加载对话失败',
    'Failed to load conversations:': '加载对话失败：',
    'Failed to load image.': '加载图片失败。',
    'Failed to load model': '加载模型失败',
    'Failed to load model:': '加载模型失败：',
    'Failed to load models': '加载模型失败',
    'Failed to load resource content': '加载资源内容失败',
    'Failed to load tools': '加载工具失败',
    'Failed to open file picker': '打开文件选择器失败',
    'Failed to open file picker:': '打开文件选择器失败：',
    'Failed to parse custom parameters:': '解析自定义参数失败：',
    'Failed to parse file:': '解析文件失败：',
    'Failed to process markdown:': '处理 markdown 失败：',
    'Failed to read file': '读取文件失败',
    'Failed to read file.': '读取文件失败。',
    'Failed to read resource': '读取资源失败',
    'Failed to regenerate message:': '重新生成消息失败：',
    'Failed to render mermaid diagram:': '渲染 mermaid 图表失败：',
    'Failed to save config to localStorage:': '保存配置到 localStorage 失败：',
    'Failed to save partial response:': '保存部分回复失败：',
    'Failed to select model:': '选择模型失败：',
    'Failed to send message:': '发送消息失败：',
    'Failed to start recording:': '开始录制失败：',
    'Failed to stop recording:': '停止录制失败：',
    'Failed to toggle conversation pin:': '切换对话置顶失败：',
    'Failed to unload model': '卸载模型失败',
    'Failed to update conversation name:': '更新对话名称失败：',
    'Failed to update conversation timestamp:': '更新对话时间戳失败：',
    'Failed to update message:': '更新消息失败：',
    'Failed to update pin state': '更新置顶状态失败',
    'Favorite models': '收藏的模型',
    'File Path': '文件路径',
    'File Upload Error': '文件上传错误',
    'File reading error': '文件读取错误',
    'File type not supported': '不支持的文件类型',
    'Fork Conversation': '分叉对话',
    'Fork conversation': '分叉对话',
    'Found: thinking conditional': '已找到：思维链条件',
    'Frequency penalty': '频率惩罚',
    'General': '通用',
    'Generate title with LLM': '用 LLM 生成标题',
    'Generated tokens': '已生成令牌',
    'Generating diagram...': '正在生成图表…',
    'Generation speed': '生成速度',
    'Generation time': '生成时间',
    'Get runtime info (OS name), may call when user asks about local files or shell commands': '获取运行时信息（操作系统名），当用户询问本地文件或 shell 命令时可调用',
    'Go Home': '返回首页',
    'Go to start': '回到开头',
    'Got it': '知道了',
    'Header name': '请求头名称',
    'Hello there': '你好',
    'High': '高',
    'Hugging Face': 'Hugging Face',
    'Image processing requires a vision model': '图像处理需要视觉模型',
    'Images': '图片',
    'Images require a vision-capable model': '图片需要支持视觉的模型',
    'Import conversations': '导入对话',
    'Import failed:': '导入失败：',
    'Import settings': '导入设置',
    'Import/Export': '导入/导出',
    'Include all attachments': '包含全部附件',
    'Include sensitive data': '包含敏感数据',
    'Include sensitive data (not recommended)': '包含敏感数据（不推荐）',
    'Initializing connection to server...': '正在初始化与服务器的连接…',
    'Input': '输入',
    'Insert an MCP prompt': '插入 MCP 提示词',
    'Invalid URL format': 'URL 格式无效',
    'Invalid JSON in custom parameters. Please check the format and try again.': '自定义参数里的 JSON 格式有误，请检查后重试。',
    'Invalid data URL format.': '数据 URL 格式无效。',
    'Invalid data: missing conversation': '数据无效：缺少对话',
    'Invalid data: no conversations to export': '数据无效：没有可导出的对话',
    'Invalid settings data: missing config': '设置数据无效：缺少配置',
    'Invalid settings file: missing config': '设置文件无效：缺少配置',
    'JSON Schema': 'JSON 模式',
    'JavaScript sandbox tool': 'JavaScript 沙箱工具',
    'JavaScript source to execute': '要执行的 JavaScript 源码',
    'KV cache total': 'KV 缓存总计',
    'Keep editing': '继续编辑',
    'Keeps only k top tokens.': '仅保留概率最高的 k 个令牌。',
    'LLM stream error': 'LLM 流错误',
    'LLM title generation prompt': 'LLM 标题生成提示词',
    'Language': '语言',
    'Light': '浅色',
    'List files': '列出文件',
    'Listing available tools...': '正在列出可用工具…',
    'Load': '加载',
    'Load model': '加载模型',
    'Loaded models': '已加载模型',
    'Loading': '加载中',
    'Loading draft': '正在加载草稿',
    'Loading model': '正在加载模型',
    'Loading model information...': '正在加载模型信息…',
    'Loading model...': '正在加载模型…',
    'Loading models…': '正在加载模型…',
    'Loading projector': '正在加载投影层',
    'Loading tools...': '正在加载工具…',
    'Loading weights': '正在加载权重',
    'Local AI chat interface powered by llama.cpp': '由 llama.cpp 驱动的本地 AI 对话界面',
    'Logging': '日志',
    'Low': '低',
    'MCP Prompt': 'MCP 提示词',
    'MCP Prompt message with actions': '带操作的 MCP 提示词消息',
    'MCP Resource': 'MCP 资源',
    'MCP Resources': 'MCP 资源',
    'MCP Servers': 'MCP 服务器',
    'MCP Tools': 'MCP 工具',
    'MCP request timeout (seconds)': 'MCP 请求超时（秒）',
    'MCP server configuration is missing url': 'MCP 服务器配置缺少 url',
    'MCP servers': 'MCP 服务器',
    'Max': '最大',
    'Max tokens': '最大生成长度',
    'Maximum image resolution (megapixels)': '最大图片分辨率（百万像素）',
    'Maximum reasoning effort with extended context usage': '扩展上下文下的最大推理强度',
    'Media attachment not found in message extras': '消息附件中未找到媒体文件',
    'MediaRecorder error:': 'MediaRecorder 错误：',
    'Medium': '中',
    'Mention search depth': '引用搜索深度',
    'Merge mcpDefaultServerOverrides entries onto mcpServers[i].enabled (preserves legacy key)': '将 mcpDefaultServerOverrides 合并到 mcpServers[i].enabled（保留旧键）',
    'Message copied to clipboard': '消息已复制到剪贴板',
    'Messages': '消息',
    'Migrate legacy marker-based messages to structured format': '将旧的标记式消息迁移为结构化格式',
    'Min P': 'Min P',
    'Missing required parameter: code': '缺少必需参数：code',
    'Modalities': '模态',
    'Model': '模型',
    'Model Information': '模型信息',
    'Model Not Available': '模型不可用',
    'Model Size': '模型大小',
    'Model default': '模型默认',
    'Model information': '模型信息',
    'Models': '模型',
    'More actions': '更多操作',
    'More allow options': '更多允许选项',
    'Name reported by the server': '服务器报告的名称',
    'New': '新建',
    'New Chat': '新建对话',
    'New chat': '新建对话',
    'Next version': '下一版本',
    'No MCP prompts available': '无可用 MCP 提示词',
    'No PDF file available for conversion': '无可用 PDF 文件进行转换',
    'No PDF pages available': '没有可用的 PDF 页面',
    'No active conversation': '没有活动对话',
    'No active recording to stop': '没有正在进行的录制可停止',
    'No chat template available': '无可用聊天模板',
    'No code element found in wrapper': '包装器中未找到代码元素',
    'No content available': '没有可用内容',
    'No context info available': '没有可用的上下文信息',
    'No conversations found in file': '文件中未找到对话',
    'No conversations to delete': '没有可删除的对话',
    'No conversations to export': '没有可导出的对话',
    'No conversations yet': '还没有对话',
    'No custom headers configured.': '未配置自定义请求头。',
    'No edits': '没有编辑',
    'No items configured.': '未配置项目。',
    'No items found': '未找到项目',
    'No matches': '没有匹配',
    'No matching command': '无匹配命令',
    'No matching files or folders': '无匹配的文件或文件夹',
    'No matching folders': '没有匹配的文件夹',
    'No model': '未选择模型',
    'No model information available': '没有可用的模型信息',
    'No models available.': '没有可用模型。',
    'No models found.': '未找到模型。',
    'No output': '无输出',
    'No resources': '没有资源',
    'No response body': '无响应内容',
    'No results': '没有结果',
    'No results found': '未找到结果',
    'No thinking patterns found': '未找到思维链模式',
    'No tools available': '没有可用工具',
    'No wrapper found': '未找到包装器',
    'Not available': '不可用',
    'Not found': '未找到',
    'Not supported by current model': '当前模型不支持',
    'Off': '关闭',
    'Open': '打开',
    'Open Sidebar': '打开侧边栏',
    'Open command picker': '打开命令选择器',
    'Open conversations': '打开对话',
    'Open file mention picker': '打开文件引用选择器',
    'Open picker': '打开选择器',
    'Open prompt picker': '打开提示词选择器',
    'Open website': '打开网站',
    'Open working directory picker': '打开工作目录选择器',
    'Operation was aborted': '操作已中止',
    'Output': '输出',
    'PDF File': 'PDF 文件',
    'PDF Files': 'PDF 文件',
    'PDF Page {index + 1}': 'PDF 第 {index + 1} 页',
    'PDF parsing as images enabled!': 'PDF 已启用图片解析！',
    'Parallel Slots': '并行槽位',
    'Parameters': '参数',
    'Parse PDF as image': '以图片方式解析 PDF',
    'Parse error': '解析错误',
    'Paste long text to file length': '长文本转文件阈值',
    'Paste token here': '在此粘贴令牌',
    'Path to the media file': '媒体文件路径',
    'Pending user message': '待发送的用户消息',
    'Pin all': '全部置顶',
    'Pinned': '已置顶',
    'Please enter a server URL first.': '请先输入服务器 URL。',
    'Please select a model first': '请先选择模型',
    'Pre-fill KV cache after response': '响应后预填充 KV 缓存',
    'Preparing response...': '正在准备回复…',
    'Presence penalty': '存在惩罚',
    'Preview code': '预览代码',
    'Preview diagram': '预览图表',
    'Preview not available for this file type': '该文件类型不支持预览',
    'Preview only': '仅预览',
    'Preview svg': '预览 svg',
    'Preview {language}': '预览 {language}',
    'Preview {name}': '预览 {name}',
    'Prompt processing speed': '提示词处理速度',
    'Prompt processing time': '提示词处理时间',
    'Prompt tokens evaluated': '已评估的提示词令牌',
    'Prompt tokens:': '提示 token：',
    'Prompts': '提示词',
    'Read Resource': '读取资源',
    'Read file': '读取文件',
    'Read media': '读取媒体',
    'Reasoning': '推理',
    'Receiving arguments...': '正在接收参数…',
    'Recent conversations': '最近对话',
    'Recommended Servers': '推荐服务器',
    'Reconnecting to the stream...': '正在重新连接数据流…',
    'Recording error:': '录制错误：',
    'Recording failed': '录制失败',
    'Refresh resources': '刷新资源',
    'Reload': '重新加载',
    'Reload app': '重新加载应用',
    'Remove from favorites': '从收藏中移除',
    'Remove item': '移除项目',
    'Rename': '重命名',
    'Rename conversation': '重命名对话',
    'Render thinking as Markdown': '以 Markdown 渲染思考过程',
    'Render user content as Markdown': '以 Markdown 渲染用户输入',
    'Rendering svg...': '正在渲染 svg…',
    'Repeat last N': '重复最近 N',
    'Repeat penalty': '重复惩罚',
    'Request failed': '请求失败',
    'Request timed out': '请求超时',
    'Request timed out - the server took too long to respond': '请求超时 —— 服务端响应太慢',
    'Requested:': '请求：',
    'Reset': '重置',
    'Reset Settings to Default': '将设置重置为默认',
    'Reset to Default': '重置为默认',
    'Reset to default': '重置为默认',
    'Reset to defaults': '重置为默认',
    'Reset view': '重置视图',
    'Reset working directory': '重置工作目录',
    'Resolved URI:': '解析后的 URI：',
    'Resource already attached': '资源已附加',
    'Resource content': '资源内容',
    'Resources': '资源',
    'Response was truncated': '响应已被截断',
    'Retry loading model': '重试加载模型',
    'Returns the current local date and time in ISO 8601 format, with the IANA time zone name': '以 ISO 8601 格式返回本地日期与时间，含 IANA 时区名',
    'Run JavaScript': '运行 JavaScript',
    'Run command': '运行命令',
    'Run llama-server with': '以如下参数运行 llama-server：',
    'Runtime info': '运行时信息',
    'Runtime info&nbsp;': '运行时信息',
    'Samplers': '采样器',
    'Sampling & Penalties': '采样与惩罚',
    'Sandbox execution aborted': '沙箱执行已中止',
    'Save': '保存',
    'Save only': '仅保存',
    'Save settings': '保存设置',
    'Scroll left': '向左滚动',
    'Scroll right': '向右滚动',
    'Scroll to bottom': '滚动到底部',
    'Search': '搜索',
    'Search and browse AI models, datasets, spaces, and docs on the Hugging Face Hub.': '搜索并浏览 Hugging Face Hub 上的 AI 模型、数据集、空间与文档。',
    'Search conversations...': '搜索对话…',
    'Search files': '搜索文件',
    'Search for&nbsp;': '搜索',
    'Search in files': '在文件中搜索',
    'Search models...': '搜索模型…',
    'Search prompts...': '搜索提示词…',
    'Search repositories, issues, pull requests and interact with code on GitHub.': '搜索仓库、议题、拉取请求并与 GitHub 上的代码交互。',
    'Search resources...': '搜索资源…',
    'Search results': '搜索结果',
    'Search the web and fetch full page content as clean markdown.': '搜索网络并以干净 Markdown 获取完整页面内容。',
    'Search · llama.cpp': '搜索 · llama.cpp',
    'Searching': '搜索中',
    'Searching in:': '搜索范围：',
    'Searching...': '搜索中…',
    'See parent conversation': '查看父级对话',
    'Select': '选择',
    'Select Model': '选择模型',
    'Select a resource to preview': '选择要预览的资源',
    'Select all': '全选',
    'Select an available model:': '选择一个可用模型：',
    'Select model': '选择模型',
    'Model selector': '模型选择器',
    'Selected model is not available': '所选模型不可用',
    'Send': '发送',
    'Send immediately': '立即发送',
    'Send message on Enter': '回车发送消息',
    'Sending initialize request...': '正在发送初始化请求…',
    'Sent as Image': '以图片发送',
    'Sent as Text': '以文本发送',
    'Server Connection Error': '服务器连接错误',
    'Server Error': '服务器错误',
    'Server Tools': '服务器工具',
    'Server URL': '服务器地址',
    'Server error - check server logs': '服务器错误 - 请检查服务器日志',
    'Server instructions': '服务器指令',
    'Server is not running or unreachable': '服务器未运行或无法连接',
    'Server not found - check server address': '未找到服务器 - 请检查服务器地址',
    'Server temporarily unavailable': '服务器暂时不可用',
    'Server unavailable': '服务器不可用',
    'Set working directory': '设置工作目录',
    'Set working directory to': '将工作目录设置为',
    'Set working directory to ...': '将工作目录设置为…',
    'Set working directory to&nbsp;': '设置工作目录为',
    // ===== 性能页 GPU 健康分节（F 归因面板 + E 轻量基准）=====
    'GPU Health': 'GPU 健康',
    'Healthy': '正常',
    'Attention': '注意',
    'Throttled': '已降频',
    'Power draw': '功耗',
    'Temp': '温度',
    's window': '秒窗口',
    'last 3s': '近 3 秒',
    'min ago': '分钟前',
    'Last generation': '上次生成',
    'Collecting samples - wait a few seconds.': '正在积累采样，稍等几秒。',
    'Manager offline or sampling not available.': '管理器不在线或无法采样。',
    // manager._gpu_verdict 的固定归因句（整文本节点精确等值匹配）
    'No samples yet - waiting for the sampler.': '还没有采样数据，等待采样线程。',
    'GPU is idle - load a model and generate something to get a verdict.': 'GPU 空载 —— 加载模型并生成一段话，才能给出归因结论。',
    'Hardware slowdown is active (thermal/power) - the GPU is being throttled.': '硬件级降速已触发（温度/功耗）—— 显卡正在被强制降频。',
    'Power/thermal cap is active while the GPU is busy - speed is being throttled.': 'GPU 忙碌时撞上了功耗/温度墙 —— 速度正在被压制。',
    'GPU is at full load - compute-bound, as expected.': 'GPU 满负荷在算 —— 计算瓶颈在显卡本身，属正常现象。',
    'GPU is mostly waiting (low power draw, no throttle flags) - the bottleneck is CPU / RAM / I/O, not the graphics card.': 'GPU 大部分时间在等待（功耗低、无降频标志）—— 瓶颈在 CPU / 内存 / IO，不在显卡。',
    'Load is moderate, no throttling flags.': '负载中等，无降频标志。',
    'Filter': '筛选',
    'size unknown': '大小未知',
    'Manage': '管理',
    'Favorite': '收藏',
    'Favorited': '已收藏',
    'Tags': '标签',
    'Note': '备注',
    'Add a tag…': '添加标签…',
    'Add a note…': '添加备注…',
    'Move to Recycle Bin': '移入回收站',
    'This moves the file to the Recycle Bin. It can be restored from there.': '这会把文件移入回收站，可从回收站恢复。',
    'Confirm delete': '确认删除',
    'Deleting…': '删除中…',
    'Cannot delete:': '无法删除：',
    'Ollama mirror': 'Ollama 硬链接镜像',
    'Currently loaded': '正在加载中',
    'Hard link': '硬链接',
    'Outside models folder': '不在模型目录内',
    'Referenced by launch presets': '被启动方案引用',
    'Favorites only': '仅看收藏',
    'item(s)': '个文件',
    'Trash folder': '.trash 文件夹',
    'Empty trash folder': '清空该文件夹',
    'Remove tag': '移除标签',
    'Settings': '设置',
    'Settings saved': '设置已保存',
    'Settings exported': '设置已导出',
    'Settings imported successfully': '设置导入成功',
    'Show build version information': '显示构建版本信息',
    'Show full path in mentions': '在 @ 提及中显示完整路径',
    'Show full system message': '显示完整系统消息',
    'Show message generation statistics': '显示消息生成统计',
    'Show microphone on empty input': '输入为空时显示麦克风',
    'Show model quantization information': '显示模型量化信息',
    'Show model tags': '显示模型标签',
    'Show organization name in model selector trigger': '在模型选择器里显示组织名',
    'Show raw model names': '显示原始模型名称',
    'Show raw output': '显示原始输出',
    'Show statistics for individual agentic turns': '显示各智能体轮次统计',
    'Show system message': '显示系统提示词',
    'Show system message in conversations': '在对话中显示系统提示词',
    'Show thought in progress': '显示进行中的思考',
    'Skip': '跳过',
    'Skip reasoning': '跳过推理',
    'Some files cannot be uploaded with the current model.': '部分文件无法用当前模型上传。',
    'Something went wrong': '出了点问题',
    'Speculative decoding enabled': '已启用推测解码',
    'Start recording': '开始录制',
    'Start the llama-server:': '启动 llama-server：',
    'Start typing to see results': '开始输入以查看结果',
    'Stop': '停止',
    'Stop generation': '停止生成',
    'Stop recording': '停止录制',
    'Stored in this browser; server defaults come from /props.': '保存在此浏览器；服务端默认值来自 /props。',
    'Stream error': '流错误',
    'Streaming error:': '流式错误：',
    'Symbolic math (nerdamer)': '符号计算（nerdamer）',
    'System': '系统',
    'System Message': '系统提示词',
    'System message': '系统消息',
    'System message with actions': '带操作的系统消息',
    'TCP Timeout': 'TCP 超时',
    'Tasks': '任务',
    'Temperature': '温度',
    'Template': '模板',
    'Templates': '模板',
    'Text Files': '文本文件',
    'Text message content': '文本消息内容',
    'The following files are empty and have been removed from your attachments:': '以下空文件已从附件中移除：',
    'The request did not receive a response from the server before timing out.': '请求在超时前没有收到服务端的响应。',
    'The requested model could not be found. Select an available model to continue.': '找不到所请求的模型，请选择一个可用模型以继续。',
    'The selected model does not support vision. Only the extracted': '所选模型不支持视觉，仅提取的',
    'The server responded with an error message. Review the details below.': '服务端返回了一条错误信息，详见下方。',
    'Theme': '主题',
    'These files have been automatically removed from your attachments': '这些文件已自动从附件中移除',
    'This action cannot be undone.': '此操作不可撤销。',
    'This model supports:': '该模型支持：',
    'This turn · KV cache': '本轮 · KV 缓存',
    'Timeout for individual MCP tool calls.': '单个 MCP 工具调用的超时时间。',
    'Toggle content': '展开/收起内容',
    'Toggle mermaid source': '切换 mermaid 源码',
    'Toggle source': '切换源码',
    'Toggle svg source': '切换 svg 源码',
    'Token usage details': 'Token 使用详情',
    'Tokens generated': '已生成令牌',
    'Tool': '工具',
    'Tool calls': '工具调用',
    'Tool calls executed': '已执行的工具调用',
    'Tool execution rate': '工具执行速率',
    'Tool execution time': '工具执行时间',
    'Tool execution was denied by the user.': '工具执行被用户拒绝。',
    'Tools': '工具',
    'Top K': 'Top K',
    'Top P': 'Top P',
    'Total matches:': '匹配总数：',
    'Total matches: N': '匹配总数：N',
    'Total time (LLM + tools)': '总时间（LLM + 工具）',
    'Total tokens generated': '已生成令牌总数',
    'Training Context': '训练上下文',
    'Troubleshooting': '故障排查',
    'Try again': '重试',
    'Type a message...': '输入消息…',
    'Typical P': '典型 P',
    'URL is required': 'URL 为必填项',
    'Unable to connect to server - please check if the server is running': '连不上模型服务 —— 请检查模型是否在运行（可看「性能」页）',
    'Unable to load models:': '无法加载模型：',
    'Unavailable for mixed state selection': '混合状态选择时不可用',
    'Unfold the single raw text render toggle onto the per-surface render keys': '将单一原始文本渲染开关展开到各表面的渲染键',
    'Unknown File': '未知文件',
    'Unknown Model': '未知模型',
    'Unknown error': '未知错误',
    'Unknown error executing prompt': '执行提示词时发生未知错误',
    'Unknown error occurred': '发生未知错误',
    'Unknown server error': '未知服务器错误',
    'Unload model': '卸载模型',
    'Unpin all': '全部取消置顶',
    'Unsupported File Types': '不支持的文件类型',
    'Untitled conversation': '未命名对话',
    'Update available': '有可用更新',
    'Update without re-sending': '更新且不重新发送',
    'Use': '使用',
    'Use Prompt': '使用提示词',
    'Use first non-empty line for the conversation title': '用首行非空内容作为对话标题',
    'Use full height code blocks': '代码块使用全高',
    'Use llama-server proxy': '使用 llama-server 代理',
    'User message with actions': '带操作用户消息',
    'User overrides after sync:': '同步后的用户覆盖：',
    'Verify your network connection': '检查你的网络连接',
    'Video Files': '视频文件',
    'Video files require a video-capable model': '视频文件需要支持视频的模型',
    'Video preview not available': '视频预览不可用',
    'View All': '查看全部',
    'Vocabulary Size': '词表大小',
    'Vocabulary Type': '词表类型',
    'Waiting for file content...': '正在等待文件内容…',
    'Waiting for media data...': '正在等待媒体数据…',
    'Waiting for result...': '正在等待结果…',
    'Waiting for tokens...': '正在等待令牌…',
    'Wants Authorization': '需要授权',
    'Web UI': '网页界面',
    'WebSocket connection closed': 'WebSocket 连接已关闭',
    'What happened:': '发生了什么：',
    'Worker creation failed:': 'Worker 创建失败：',
    'Working directory cleared': '工作目录已清除',
    'Write': '写入',
    'Write file': '写入文件',
    'XTC probability': 'XTC 概率',
    'XTC threshold': 'XTC 阈值',
    'You can try uploading files with content instead': '你可以改传有内容的文件',
    'Your browser does not support the audio element.': '你的浏览器不支持音频播放。',
    'Your browser does not support the video element.': '你的浏览器不支持视频播放。',
    'Zoom in': '放大',
    'Zoom out': '缩小',
    'details': '详情',
    'exit 0': '退出码 0',
    'flag to enable': '启用标志',
    'flag)': '标志）',
    'llama-server': 'llama-server',
    'llama-server -hf ggml-org/gemma-3-4b-it-GGUF': 'llama-server -hf ggml-org/gemma-3-4b-it-GGUF',
    'llama-server -m locally-stored-model.gguf': 'llama-server -m locally-stored-model.gguf',
    'mermaid': 'mermaid',
    'or': '或',
    'svg': 'svg',
    'timed out': '超时',
    'tool': '工具',
    'used': '已用',
    'will be sent to the model.': '将发送给模型。',
    'with': '，',
    '✓ API key validated successfully! Connecting...': '✓ API 密钥验证成功！正在连接…',
    '简体中文': '简体中文',
    'Type a message or upload files to get started': '输入消息或上传文件以开始使用',
    'Record audio, type a message or upload files to get started': '录制音频、输入消息或上传文件以开始使用',
    'Type a message or upload': '输入消息或上传文件',
    'Type a message or upload  files to get started': '输入消息或上传文件以开始使用',
    'files to get started': '即可开始使用',
    'or upload files to get started': '或上传文件以开始使用',
    'Type a message': '输入消息',
    'Record audio, type a message': '录制音频、输入消息',
    // === 综合补全：设置抽屉 body + 全部 help + 对话框（2026-09-09） ===
    'Are you sure you want to delete all conversations? This action cannot be undone and will permanently remove all your conversations and messages.': '确定要删除所有对话吗？此操作不可撤销，将永久删除您所有的对话及消息。',
    'Conversations': '对话',
    'Download your conversations as a ZIP of JSONL files. This includes all messages, attachments, and conversation history.': '将对话历史下载为 ZIP 压缩包（含 JSONL 文件）。这将包含所有消息、附件和对话记录。',
    'Export': '导出',
    'Export your chat settings and preferences as a JSON file.': '将对话设置和偏好导出为 JSON 文件。',
    'Exported': '已导出',
    'Import': '导入',
    'Import chat settings from a previously exported JSON file. This will merge with your existing settings.': '从之前导出的 JSON 文件导入对话设置。这将与您现有的设置合并。',
    'Import one or more conversations from a previously exported ZIP or JSONL file. This will merge with your existing conversations.': '从之前导出的 ZIP 或 JSONL 文件中导入一个或多个对话。这将与您现有的对话合并。',
    'Imported': '已导入',
    'Permanently delete all conversations and their messages. This action cannot be undone. Consider exporting your conversations first if you want to keep a backup.': '永久删除所有对话及其消息。此操作不可撤销。如需保留备份，请先导出对话。',
    'Addon for the temperature sampler. Smoothes out the probability redistribution based on the most probable token.': '温度采样的附加项。根据最可能的 token 平滑概率重分布。',
    'Addon for the temperature sampler. The added value to the range of dynamic temperature, which adjusts probabilities by entropy of tokens.': '温度采样的附加项。动态温度范围的附加值，通过 token 的熵调整概率。',
    'After each response, re-submit the conversation to pre-fill the server KV cache. Makes the next turn faster since the prompt is already encoded while you read the response.': '每次响应后，重新提交对话以预填充服务器 KV 缓存。由于您在阅读响应时 prompt 已被编码，下一轮会更快。',
    'Always display code blocks at their full natural height, overriding any height limits.': '始终以完整自然高度显示代码块，覆盖任何高度限制。',
    'Always keep the sidebar visible on desktop instead of auto-hiding it.': '在桌面上始终保持侧栏可见，而不是自动隐藏。',
    'Automatically expand tool call details while executing and keep them expanded after completion.': '执行时自动展开工具调用详情，完成后保持展开。',
    'Automatically show microphone button instead of send button when textarea is empty for models with audio modality support.': '当输入框为空时，对支持音频模态的模型自动显示麦克风按钮而非发送按钮。',
    'CSS injected into the page at runtime. Set it here, or ship it server side via the --ui-config customCss field.': '运行时注入页面的 CSS。可在此设置，或通过 --ui-config customCss 字段从服务端下发。',
    'Choose how conversation titles are generated. The first non-empty line uses a fast deterministic rule; the LLM option uses a model-generated title from the first message exchange.': '选择对话标题的生成方式。第一行非空内容使用快速确定性规则；LLM 选项使用模型从首轮对话中生成的标题。',
    'Choose the color theme for the interface. You can choose between System (follows your device settings), Light, or Dark.': '选择界面颜色主题。可在系统（跟随设备设置）、浅色、深色之间选择。',
    'Configure MCP servers as a JSON list. Use the form in the MCP Client settings section to edit.': '将 MCP 服务器配置为 JSON 列表。请在 MCP 客户端设置部分使用表单进行编辑。',
    'Controls the randomness of the generated text by affecting the probability distribution of the output tokens. Higher = more random, lower = more focused.': '通过影响输出 token 的概率分布来控制生成文本的随机性。值越高越随机，越低越聚焦。',
    'Controls the repetition of token sequences in the generated text': '控制生成文本中 token 序列的重复程度',
    'Counterpart of the conversation title radio; stored and synced without a dedicated UI field.': '对话标题单选框的对应项；存储并同步，不带独立 UI 字段。',
    'Custom JSON parameters to send to the API. Must be valid JSON format.': '发送给 API 的自定义 JSON 参数。必须是有效的 JSON 格式。',
    'DRY sampling reduces repetition in generated text even across long contexts. This parameter sets DRY penalty for the last n tokens.': 'DRY 采样在长上下文中也能减少生成文本的重复。此参数设置最近 n 个 token 的 DRY 惩罚。',
    'DRY sampling reduces repetition in generated text even across long contexts. This parameter sets the DRY sampling base value.': 'DRY 采样在长上下文中也能减少生成文本的重复。此参数设置 DRY 采样的基础值。',
    'DRY sampling reduces repetition in generated text even across long contexts. This parameter sets the DRY sampling multiplier.': 'DRY 采样在长上下文中也能减少生成文本的重复。此参数设置 DRY 采样的乘数。',
    'DRY sampling reduces repetition in generated text even across long contexts. This parameter sets the allowed length for DRY sampling.': 'DRY 采样在长上下文中也能减少生成文本的重复。此参数设置 DRY 采样的允许长度。',
    'Disable automatic scrolling while messages stream so you can control the viewport position manually.': '消息流式输出时禁用自动滚动，以便手动控制视口位置。',
    'Display full raw model identifiers (e.g. "ggml-org/GLM-4.7-Flash-GGUF:Q8_0") instead of parsed names with badges.': '显示完整的原始模型标识（例如 "ggml-org/GLM-4.7-Flash-GGUF:Q8_0"），而非带徽章的解析名称。',
    'Display generation statistics (tokens/second, token count, duration) below each assistant message.': '在每条助手消息下方显示生成统计信息（每秒 token 数、token 计数、时长）。',
    'Display model tags (e.g. "vision", "reasoning") next to model names throughout the interface.': '在整个界面的模型名称旁显示模型标签（例如 "vision"、"reasoning"）。',
    'Display per-turn statistics (tokens, duration) under each turn in agentic responses. Shown only when "Show message generation statistics" is enabled.': '在 Agentic 响应的每个轮次下显示每轮统计（token 数、时长）。仅在启用"显示消息生成统计"时显示。',
    'Display quantization badges (e.g. Q8_0, Q4_K_M) next to model names throughout the interface.': '在整个界面的模型名称旁显示量化徽章（例如 Q8_0、Q4_K_M）。',
    'Display the current build version in the bottom-right corner of the interface.': '在界面右下角显示当前构建版本。',
    'Display the full file system path inside file and folder @-mention badges instead of just the file or folder name.': '在文件和文件夹 @ 提及徽章中显示完整的文件系统路径，而非仅显示文件或文件夹名。',
    'Display the organization name in the model selector trigger button.': '在模型选择器触发按钮中显示组织名称。',
    'Display the system message at the top of each conversation.': '在每个对话顶部显示系统消息。',
    'Enable "Continue" button': '启用"继续"按钮',
    'Enable "Continue" button for assistant messages, including reasoning models.': '为助手消息启用"继续"按钮，包括推理模型。',
    'Enable backend-based samplers. When enabled, supported samplers run on the accelerator backend for faster sampling.': '启用基于后端的采样器。启用后，支持的采样器将在加速器后端上运行以加快采样。',
    'Expand thought process by default when generating messages.': '生成消息时默认展开思维过程。',
    'Expose a run_javascript tool to the model. Code runs in a Web Worker inside a sandboxed iframe with an opaque origin, isolated from the WebUI and its API, with a hard timeout.': '向模型暴露 run_javascript 工具。代码在沙箱化 iframe 内的 Web Worker 中运行，具有不透明来源，与 WebUI 及其 API 隔离，并设有硬性超时。',
    'How many directory levels below the working directory the @-mention file search descends. Larger values surface deeply nested files but take longer on large trees.': '@ 提及文件搜索向下遍历工作目录的层级数。较大的值可显示深度嵌套的文件，但在大型目录树中耗时较长。',
    'Images larger than this will be resized before sending to server. Set to 0 to disable.': '超过此大小的图片在发送到服务器前将被缩放。设为 0 表示禁用。',
    'Last n tokens to consider for penalizing repetition': '用于惩罚重复的最近 n 个 token',
    'Limits tokens based on how often they appear in the output.': '根据 token 在输出中出现的频率进行限制。',
    'Limits tokens based on the minimum probability for a token to be considered, relative to the probability of the most likely token.': '根据 token 被考虑的最低概率（相对于最可能 token 的概率）进行限制。',
    'Limits tokens based on whether they appear in the output or not.': '根据 token 是否在输出中出现进行限制。',
    'Limits tokens to those that together have a cumulative probability of at least p': '将 token 限制为累积概率至少为 p 的 token',
    'Maximum number of tool execution cycles before stopping (prevents infinite loops).': '停止前的最大工具执行轮次数（防止无限循环）。',
    'On pasting long text, it will be converted to a file. You can control the file length by setting the value of this parameter. Value 0 means disable.': '粘贴长文本时将转换为文件。可通过此参数值控制文件长度。值 0 表示禁用。',
    'Optional template for the title generation prompt. Use {{USER}} for the user message and {{ASSISTANT}} for the assistant message.': '标题生成提示词的可选模板。使用 {{USER}} 表示用户消息，{{ASSISTANT}} 表示助手消息。',
    'Parse PDF as image instead of text. Automatically falls back to text processing for non-vision models.': '将 PDF 解析为图像而非文本。对于非视觉模型，自动回退到文本处理。',
    'Pre-load nerdamer in the sandbox for symbolic computation: simplify, diff, integrate, solve, and more. Requires "JavaScript sandbox tool" to be enabled.': '在沙箱中预加载 nerdamer 以进行符号计算：化简、求导、积分、求解等。需要启用"JavaScript 沙箱工具"。',
    'Render the reasoning/thinking block content as formatted Markdown instead of plain text.': '将推理/思维块内容渲染为格式化的 Markdown，而非纯文本。',
    'Render user messages using markdown formatting in the chat. Turn this off to keep a message exactly as typed; @-mention badges show either way.': '在聊天中使用 Markdown 格式渲染用户消息。关闭此项可保持消息完全按输入显示；@ 提及徽章在两种模式下都会显示。',
    'Send reasoning_format=none so the server returns thinking tokens inline instead of extracting them into a separate field.': '发送 reasoning_format=none，使服务器将思维 token 内联返回，而非提取到单独的字段。',
    'Show open chats as browser-style tabs above the conversation, one per open chat. When disabled, only one chat is shown at a time.': '将打开的聊天显示为对话上方的浏览器风格标签页，每个打开的聊天一个标签页。禁用时，一次只显示一个聊天。',
    'Show toggle button to display messages as plain text instead of Markdown-formatted content': '显示切换按钮，将消息显示为纯文本而非 Markdown 格式内容',
    'Sorts and limits tokens based on the difference between log-probability and entropy.': '根据 log 概率与熵的差异对 token 进行排序和限制。',
    'Strip thinking from previous messages before sending. When off, thinking is sent back via the reasoning_content field so the model sees its own chain-of-thought across turns.': '发送前从先前消息中去除思维内容。关闭时，思维通过 reasoning_content 字段发回，模型可在多轮中看到自己的思维链。',
    'The maximum number of token per output. Use -1 for infinite (no limit).': '每次输出的最大 token 数。-1 表示无限（无限制）。',
    'The order at which samplers are applied, in simplified way. Default is "top_k;typ_p;top_p;min_p;temperature": top_k->typ_p->top_p->min_p->temperature': '采样器的应用顺序（简化形式）。默认值为 "top_k;typ_p;top_p;min_p;temperature"：top_k->typ_p->top_p->min_p->temperature',
    'The starting message that defines how model should behave.': '定义模型应如何行为的起始消息。',
    'Use Enter to send messages and Shift + Enter for new lines. When disabled, use Ctrl/Cmd + Enter.': '使用回车发送消息，Shift + 回车换行。禁用时，使用 Ctrl/Cmd + 回车。',
    'When copying a message with text attachments, combine them into a single plain text string instead of a special format that can be pasted back as attachments.': '复制带文本附件的消息时，将其合并为单个纯文本字符串，而非可粘贴回为附件的特殊格式。',
    'XTC sampler cuts out top tokens; this parameter controls the chance of cutting tokens at all. 0 disables XTC.': 'XTC 采样器切掉顶部 token；此参数控制切掉 token 的概率。0 表示禁用 XTC。',
    'XTC sampler cuts out top tokens; this parameter controls the token probability that is required to cut that token.': 'XTC 采样器切掉顶部 token；此参数控制切掉该 token 所需的概率阈值。',
    // ====== 新增：Performance / Parameters 页面文本（2026-09-09 补） ======
    'No model loaded.': '未加载模型。',
    'Real-time generation metrics. Per-message statistics (tokens/s, duration, token counts) are displayed below each assistant message in the chat. Toggle visibility in': '实时生成指标。每条消息的统计信息（tokens/s、耗时、token 数）显示在聊天窗口的每条助手消息下方。可在',
    'Settings → Display → Show message generation statistics': '设置 → 显示 → 显示消息生成统计',
    'Sampling parameters that control generation behavior. Changes apply on the next message and are synced with the server\'s': '控制生成行为的采样参数。下一次发送消息时生效，并与服务器的',
    'defaults. A "Custom" badge indicates a value that diverges from the server default.': '默认值同步。出现"自定义"标记表示当前值与服务器默认值不一致。',
    'No sampling parameters found.': '未找到采样参数。',
    'Loading…': '加载中…',
    'Local Resources': '本地资源',
    'CPU': 'CPU',
    'RAM': '内存',
    'GPU': '显卡',
    'VRAM': '显存',
    'Used': '已用',
    'Total': '总量',
    'Predicted After Model Load': '加载模型后预测占用',
    'Usage': '使用率',
    'Device': '设备',
    'VRAM Used': '已用显存',
    'VRAM Total': '总显存',
    'Predicted vs Current VRAM Capacity': '预测占用 vs 当前总显存',
    'Server Info': '服务器信息',
    'live': '在线',
    'offline': '离线',
    'init': '初始化',
    'Failed to load metrics. Make sure manager.py is running on port 8090.': '无法加载监控数据，请确认 manager.py 正在 8090 端口运行。',
    'Loading metrics…': '正在加载监控数据…',
    // ============ Performance page (model switcher + predicted VRAM) ============
    'Switch to this': '切换到此模型',
    '● loaded': '● 已加载',
    'Refresh': '刷新',
    'Refresh now': '立即刷新',
    'Cores / Threads': '核心数 / 线程数',
    'Utilization': '利用率',
    'manager.py unreachable: ': 'manager.py 无法访问：',
    'Starting %NAME% on port 8080…': '正在 8080 端口启动 %NAME%…',
    'Stopping old instance(s)…': '正在停止旧实例…',
    'Started %MODEL% (pid %PID%). WebUI will reconnect in ~10s.': '已启动 %MODEL%（pid %PID%），WebUI 将在约 10s 后自动重连。',
    'Error: ': '错误：',
    // Performance settings
    'Show floating performance bar': '显示性能浮窗',
    'Show GPU panel': '显示 GPU 卡片',
    'Show predicted VRAM block': '显示预测 VRAM 块',
    'Refresh interval (ms)': '刷新间隔（毫秒）',
    'Show the floating generation-speed bar in the corner while the model is responding.': '模型回复时在角落显示实时生成速度浮窗。',
    'Show live GPU utilization, VRAM used / total, temperature, and device name on the Performance page.': '在 Performance 页显示实时 GPU 利用率 / 显存占用总量 / 温度 / 设备名。',
    'Estimate predicted VRAM after the current model is loaded (weights + KV cache + overhead), with a usage bar vs current VRAM capacity.': '估算当前模型加载后的 VRAM 占用（权重 + KV cache + 开销），并与当前显存容量做进度条对比。',
    'How often the Performance page refreshes live metrics, in milliseconds. Lower values use more CPU.': 'Performance 页实时指标的刷新间隔（毫秒），越小越占 CPU。',
    // ====== 补全：页面标题/侧栏/状态点/Server Info 细节（2026-09-09 续） ======
    'Performance': '性能',
    '● live': '● 在线',
    '● offline': '● 离线',
    '○ init': '○ 初始化',
    'KV Cache (': 'KV 缓存 (',
    'Name': '名称',
    'Size': '大小',
    'Build': '构建',
    'Slots': '槽位',
    'Server': '服务器',
    'Switch the interface language.': '切换界面语言。',
    'English': '英文',
    // ============ Performance page (v14: 折叠模型 + 时间戳) ============
    'Just now': '刚刚',
    's ago': '秒前',
    'm ': '分',
    'Stopping existing instance…': '正在停止旧实例…',
    'Starting {name}…': '正在启动 {name}…',
    'Started {detail}. WebUI will reconnect in ~10s.': '已启动 {detail}，WebUI 将在约 10 秒后自动重连。',
    'Error: {detail}': '错误：{detail}',
    'Start': '启动',
    'Launch parameters (restart required)': '启动参数（重启生效）',
    'Context (-c)': '上下文 (-c)',
    'KV precision (-ctk/-ctv)': 'KV 精度 (-ctk/-ctv)',
    'GPU layers (-ngl)': 'GPU 层卸载 (-ngl)',
    'Logical batch (-b)': '逻辑 batch (-b)',
    'Physical batch (-ub)': '物理 batch (-ub)',
    'Parallel slots (-np)': '并行槽位 (-np)',
    'Tip: long contexts (≥65K) benefit from q8_0 KV to save VRAM; an 8GB GPU running 128K requires q8_0.': '提示：长上下文（≥65K）建议 KV 用 q8_0 节省显存；8GB 显卡跑 128K 必须用 q8_0。',
    'Already loaded. Restart to apply new parameters.': '已加载，需重启以应用新参数。',
    'Estimated: weights (GGUF size) + KV cache (0.04 GB/tok × n_ctx) + framework overhead (0.3 GB). Actual usage varies with quant, KV precision (-ctk/-ctv), and GPU layers (-ngl).': '估算公式：模型权重（GGUF 文件大小）+ KV Cache（0.04 GB/tok × n_ctx）+ 框架常量（0.3 GB）。实际占用受量化格式、KV 精度（-ctk/-ctv）、层卸载（-ngl）等因素影响。',
    // ============ Parameters page (v14: 常规/高级分组) ============
    'Basic Parameters': '常规参数',
    'Advanced Parameters': '高级参数',
    'Basic Sampling': '常规采样',
    'Advanced Sampling': '高级采样',
    '· Daily sampling: Temperature / Top-K / Top-P / Length / Repeat penalty': '· 日常对话最常用的采样设置（温度 / Top-K / Top-P / 长度 / 重复惩罚）',
    '· Advanced sampling: dynamic temperature, XTC, Typ-P, DRY, presence/frequency penalty': '· 进阶采样：动态温度、XTC、Typ-P、DRY、存在/频率惩罚',
    'No basic parameters configured.': '未配置常规参数。',
    'No advanced parameters configured.': '未配置高级参数。',
    // ============ Merged Model & Performance page (v15) ============
    'Model & Performance': '模型与性能',
    'Live': '实时',
    'Offline': '离线',
    'Connecting…': '连接中…',
    'Local metrics service unreachable: make sure manager.py is running on port 8090.': '本地指标服务不可达：请确认 manager.py 已在 8090 端口运行。',
    'Real-time Local Resources': '实时本地资源',
    'Predicted VRAM After Load': '加载后预测显存占用',
    'Predicted VRAM for': '预测显存（模型）',
    '— change Context / KV precision above to update live.': '— 调整上方 Context / KV 精度即可实时更新。',
    'Predicted vs Current VRAM': '预测占用 vs 当前显存',
    'Estimated: weights (GGUF size) + KV cache (real per-layer structure, corrected for hybrid-attention models) + compute buffer (logits + graph scratch, scales with ubatch) + framework overhead (0.3 GB).': '估算：模型权重（GGUF 大小）+ KV 缓存（按真实逐层结构计算，混合注意力架构已做层数修正）+ 计算缓冲（logits + 图执行临时张量，随 ubatch 变化）+ 框架开销（0.3 GB）。',
    'Model Switcher': '模型切换',
    'models · click to expand': '个模型 · 点击展开',
    'Start model': '启动模型',
    'Start this model': '启动此模型',
    // ---- 模型的启动配置 / 按需加载（2026-09-22）----
    'Last used': '上次使用',
    'Not loaded': '未加载',
    'Launch config & info': '启动配置与信息',
    'Launch parameters are read once when the model process starts — this instance keeps its old values until it is restarted.':
      '启动参数只在模型进程启动时读取一次 —— 这个实例会一直沿用旧值，直到重启。',
    'Restart with current preset': '按当前方案重启',
    'Restart to apply the new parameters?': '重启以应用新参数？',
    'Restart now': '立即重启',
    'Restarting…': '正在重启…',
    'Not now': '稍后',
    'Predict VRAM': '预测显存',
    'Predicting…': '预测中…',
    'VRAM prediction': '显存预测',
    'Status': '状态',
    'Path': '路径',
    'KV cache': 'KV 缓存',
    'GPU layers': 'GPU 层数',
    'Batch / ubatch': '批大小 / 微批',
    'Parallel slots': '并行槽位',
    'Threads': '线程数',
    'Trained ctx': '训练上下文',
    'These are read once at process start — changing them has no effect until the model is restarted.':
      '这些参数只在进程启动时读取一次 —— 不改不重启就不会生效。',
    'Reads the GGUF header and measures free VRAM — it does not touch anything that is currently running.':
      '读取 GGUF 头并测一次空闲显存 —— 不会碰任何正在运行的东西。',
    'not loaded — it will come up on your next message': '未加载 —— 下次发消息时会自动拉起',
    'Loaded': '已加载',
    'Vision': '视觉',
    // ---- 模型行内的「跑不跑得动」徽章（2026-09-22，见 docs/roadmap-v2.md §B-L1）----
    // 语义：Full GPU 绿 = 全层上卡；Tight fit 黄 = 能上但吃紧；Offloads 红 = 会掉层（约 2 tok/s）；
    // Predict? 灰 = 该架构的结构式 KV 偏差过大（滑窗/共享 KV），必须点一次精确预演才能判
    'Full GPU': '全层上卡',
    'Tight fit': '显存偏紧',
    'Offloads': '会掉层',
    'Predict?': '待预演',
    'Stopping…': '正在停止…',
    'Starting…': '正在启动…',
    'Started.': '已启动。',
    'WebUI will reconnect in ~10s.': 'WebUI 将在约 10 秒后重连。',
    'Error:': '错误：',
    'No model selected.': '未选择模型。',
    'No GGUF models found in D:\\llama\\models and D:\\llama\\models\\from-ollama. Drop a `.gguf` file there, then refresh.': '在 D:\\llama\\models 与 D:\\llama\\models\\from-ollama 中未找到 GGUF 模型。放入 .gguf 文件后刷新。',
    'Threads (-t)': '线程数 (-t)',
    'Flash Attention': 'Flash Attention',
    'Advanced launch parameters': '高级启动参数',
    'Advanced Sampling Parameters': '高级采样参数',
    'Sampling Parameters': '采样参数',
    'applied on next message, synced with server /props': '下一条消息生效，与服务器 /props 同步',
    'Model Weights': '模型权重',
    'KV Cache': 'KV 缓存',
    'Overhead': '框架开销',
    'Total VRAM': '总显存',
    'Current Model': '当前模型',
    'Generation Stats': '生成统计',
    'Cores/Threads:': '核心/线程：',
    'Basic': '常规',
    'Advanced': '高级',
    'Start a chat to see live generation speed, token counts, and duration per assistant message.': '发起对话即可看到每条助手消息的实时生成速度、token 数与耗时。',
    // ===== 2026-09-19：侧栏内联搜索 / 启动方案 / 模型窗口 / 参数页 =====
    'Launch Preset': '启动方案',
    'Edit presets & parameters →': '编辑方案与参数 →',
    'Preset used when starting a model': '启动模型时使用的方案',
    'with preset': '使用方案',
    '— pick another preset or model to update live.': '—— 换个方案或模型即可实时更新。',
    'Predicted VRAM': '预计显存',
    'No presets yet.': '还没有任何方案。',
    'models': '个模型',
    'Click a row to preview its VRAM below the preset summary; scroll the list for more.': '点一行即可在上方方案摘要里预览它的显存占用；列表可滚动查看更多。',
    'Search models…': '搜索模型…',
    'No models match your search.': '没有匹配的模型。',
    'loaded': '已加载',
    'Launch presets live here; the Model & Performance page picks which one to load.': '启动方案在这里维护；在「模型与性能」页选择要加载哪一个。',
    'Active preset': '当前方案',
    'Save as': '另存为',
    'Restore built-ins': '恢复内置方案',
    'Tip: “New” and “Save as” create an editable copy — built-ins are just seeds.': '提示：「新建」「另存为」会生成可自由编辑的副本，内置方案只是起点。',
    'Launch parameters': '启动参数',
    'saved in this browser, applied when starting a model': '保存在本浏览器，启动模型时应用',
    'for the loaded model': '针对当前已加载的模型',
    'Load a model (or open the Model & Performance page) to see a VRAM estimate for this preset.': '先加载一个模型（或打开「模型与性能」页），即可看到该方案的预计显存。',
    'Context clamped to model max:': '上下文已按模型上限收敛：',
    'remaining': '剩余',
    'Stopping current server…': '正在停止当前服务…',
    'Switching restarts the server': '切换会重启服务',
    'Switch failed:': '切换失败：',
    'Retry': '重试',
    'Preset:': '方案：',
    'manager.py unreachable — is it running on :8090?': 'manager.py 无法访问 —— 它是否运行在 :8090？',
    'manager.py is outdated - restart it: webui\\restart-manager.bat': 'manager.py 版本过旧 —— 请重启它：webui\\restart-manager.bat',
    'Quantization': '量化',
    'Trained context': '训练上下文',
    'Model-specific settings': '模型专属参数',
    'These apply to this model only; other models keep following the preset.': '只对本模型生效；其它模型继续跟随所选方案。',
    'Context size': '上下文大小',
    'KV precision': 'KV 精度',
    'GPU layers (ngl)': 'GPU 层数 (ngl)',
    'Parallel slots (np)': '并发槽位 (np)',
    'Quick context:': '快捷上下文：',
    'Reset to preset': '恢复为方案默认',
    'KV auto-downgraded for long context:': '长上下文下 KV 已自动降级：',
    'custom': '自定义',
    // ===== v16：性能页重做（目标模型 / 方案 / 预测同屏）=====
    'Model & Performance ·': '模型与性能 ·',
    'Launch setup for': '启动设置：',
    'Click a row to edit that model\'s launch settings below.': '点击任意一行，即可在下方编辑该模型的启动设置。',
    'This model has its own overrides; the fields below are what will actually run.': '该模型有自己的独立覆盖值；下方字段就是实际启动时会用的参数。',
    'This model follows the selected preset.': '该模型跟随所选方案。',
    'Server not reachable.': '无法连接服务器。',
    'Slot activity': '槽位活动',
    // /props 的 modalities 命中项会渲染成单个文本节点，这里按小写原名匹配
    'text': '文本',
    'vision': '视觉',
    'audio': '音频',
    'video': '视频',
    'Slots not available.': '拿不到槽位信息（服务端未暴露 /slots）。',
    'No slots.': '没有可用槽位。',
    'Processing': '处理中',
    'Idle': '空闲',
    'tokens/s': 'token/秒',
    'Architecture': '架构',
    'Compute buffer': '计算缓冲',
    'Framework': '框架开销',
    'Free VRAM after load': '加载后剩余显存',
    // B-L3 显存预算条（第 2 批）
    'VRAM budget': '显存预算',
    'Buffers & overhead': '缓冲与开销',
    'Desktop & other apps': '桌面与其他程序',
    'All layers on GPU': '全层上卡线',
    'Over capacity': '超出容量',
    'Max context on this GPU': '本卡最大上下文',
    'Enough for this model\'s full context:': '足够装下该模型的完整上下文：',
    'KV is computed from this model\'s layer and head counts.': 'KV 按该模型的层数与注意力头数精确计算。',
    'No GGUF structure info for this model - KV is only roughly estimated. Restart manager.py to compute it precisely from the GGUF header.': '该模型缺少 GGUF 结构信息 —— KV 目前只是粗估。重启 manager.py 后即可按 GGUF 头部精确计算。',
    'KV measured by llama.cpp itself.': 'KV 占用取自 llama.cpp 自己的实测账本。',
    // 「这个数字是量出来的」标记（B-L2）：manager 空闲时补测过 KV 才出现
    'measured': '实测',
    'KV size measured by llama.cpp, not a structural estimate': 'KV 体积取自 llama.cpp 实测，不是结构公式估算',
    // 模型下载页（第 2 批 A，#/download）
    'Model Download': '模型下载',
    'Model Download ·': '模型下载 ·',
    'Search HuggingFace for GGUF models and download with resume support.': '在 HuggingFace 搜索 GGUF 模型，支持断点续传下载。',
    'Search HuggingFace GGUF models…': '搜索 HuggingFace 上的 GGUF 模型…',
    'Searching…': '搜索中…',
    'Search above to find GGUF models on HuggingFace.': '先在上方搜索，即可找到 HuggingFace 上的 GGUF 模型。',
    'Downloads': '下载任务',
    'downloads': '下载',
    'likes': '收藏',
    'Loading files…': '正在加载文件…',
    'Download': '下载',
    'Completed': '已完成',
    'Canceled': '已取消',
    'Failed': '失败',
    'Fits': '可上卡',
    "Won't fit": '装不下',
    // 排序下拉 + 多连接加速标记（第 2 批 A 增强）
    'Most downloads': '最多下载',
    'Most likes': '最多收藏',
    'Recently updated': '最近更新',
    'connections': '线程加速',
    // 大小筛选 / 文件排序 / 任务操作（下载页第 2 轮增强）
    'All sizes': '全部大小',
    '< 3 GB': '< 3 GB',
    '3-6 GB': '3-6 GB',
    '> 6 GB': '> 6 GB',
    'Open folder': '打开文件夹',
    'toggle size sort': '切换大小排序',
    'Delete record': '删除记录',
    'No files match this size filter.': '没有符合该大小筛选的文件。',
    'Load more': '加载更多',
    // 搜索前筛选（大小 chips + 量化档下拉，第 2 轮增强后移到搜索前）
    'All quants': '全部量化',
    'quants': '个量化',
    'This repository has no downloadable GGUF files.': '该仓库没有可下载的 GGUF 文件。',
    'KV estimated from layer counts - hybrid-attention models can be overstated several times.': 'KV 按层数结构估算 —— 混合注意力模型（如 Qwen3.5）可能被高估好几倍。',
    'Measuring this model on your GPU…': '正在本卡上实测这个模型…',
    'Models on disk': '磁盘上的模型',
    'Flash Attention off': 'Flash Attention 已关闭',
    'manager.py is outdated - restart it:': 'manager.py 版本过旧 —— 请重启它：',
    'manager.py unreachable:': 'manager.py 无法访问：',
    // 带前缀 · 的分片：overlay 按整段文本节点匹配，前缀会破坏匹配
    'Parameters ·': '参数 ·',
    '· saved in this browser, applied when starting a model': '· 保存在本浏览器，启动模型时应用',
    '· applied on next message, synced with server /props': '· 下一条消息生效，与服务器 /props 同步',

    // ---- 启动方案：按模型命名保存 ----
    'Global presets': '通用方案',
    'Saved for this model': '本模型已保存',
    'Save as preset': '存为方案',
    'Preset name': '方案名称',
    'Overwrite': '覆盖保存',
    'Copied': '已复制',
    'Copy base URL': '复制地址',
    'Preset in effect for this model': '该模型当前生效的方案',
    'Preset saved for this model': '该模型已保存的方案',
    'Overwrite this preset with the current values': '用当前参数覆盖这份方案',
    'same file': '同一文件',
    'Saved for this model only. Next time you pick this model, the preset shows up right here.': '仅保存在这个模型下。下次选中该模型，这份方案就会出现在这里。',
    "Following this model's own preset. Other models are unaffected.": '正在使用该模型自己的方案，不影响其它模型。',

    // ---- 启动参数合并到性能页：编辑对象开关 + 通用方案库（2026-09-23）----
    // ⚠️ overlay 只按「整文本节点精确等值」匹配，所以下面这些标签在模板里都写成
    // 独立的静态 <span>，不能和动态的方案名拼在同一个节点里。
    'Edit target': '编辑对象',
    'This model only': '仅本模型',
    'Preset default': '方案默认值',
    'Changes here apply to every model that uses this preset.': '这里的改动会作用于所有使用该方案的模型。',
    'this model has its own overrides, which win': '本模型的独立覆盖值优先生效',
    'Manage presets': '管理方案',
    'New preset': '新建方案',
    'Rename preset': '重命名方案',
    'Delete preset': '删除方案',
    'At least one preset must remain.': '至少要保留一个方案。',
    'Display settings': '显示设置',
    'These settings only affect this page.': '这些设置只影响本页显示。',
    // 参数页只剩采样参数，启动设置改在性能页维护
    'Sampling parameters only.': '仅采样参数。',
    'Launch setup moved to Model & Performance →': '启动设置已移至「模型与性能」→',

    // ---- 服务器信息 = 可以给别的程序用的接口 ----
    'API Access': '接口接入',
    "This address is llama.cpp's own HTTP server (llama-server), not this panel. Any OpenAI-compatible client can connect to it directly - Open WebUI, Cherry Studio, NextChat, or your own script. No UI needed. Starting a model here restarts that server, so connected clients will briefly disconnect.": '这个地址是 llama.cpp 自带的 HTTP 服务（llama-server），不是本面板。任何支持 OpenAI 接口的客户端都能直接连上来 —— Open WebUI、Cherry Studio、NextChat，或你自己的脚本，无需经过本页面。在这里换模型会重启该服务，已连接的客户端会短暂断开。',
    'Hard-linked duplicates (one file under two names) and mmproj projection layers are filtered out of this list - they are not separately loadable models.': '硬链接重复项（同一个文件起两个名字）与 mmproj 视觉投影层已从列表中过滤 —— 它们都不能单独作为模型加载。',

    // ---- 磁盘上的模型：点目录名打开资源管理器 ----
    'Click a folder path to open it in Explorer.': '点目录路径即可在资源管理器里打开。',
    'Open this folder in Explorer': '在资源管理器中打开该目录',

    // ---- CPU 卡 / 槽位卡：解释性文案（'Cores / Threads' 已有词条，见上方） ----
    'One slot = one request the server can handle at a time. This server uses a unified KV pool (-kvu), so every slot draws from the same context shown below instead of getting a slice of it.': '一个槽位 = 服务器同时能处理的一个请求。本服务启用了统一 KV 池（-kvu），所以各槽位共用下面这一整块上下文，而不是各自分到 1/N。',

    // ---- 换模型：等待就绪 / 空闲卸载 / 显存预演（2026-09-21 新增）----
    // 说明：overlay 只按"整个文本节点精确等值"匹配，所以这些标签都写成了独立的
    // <span>静态文本</span>，与动态数字（秒数、层数）分开，否则永远匹配不上。
    '· waiting for the server ·': '· 等待服务就绪 ·',
    'Timed out waiting for the server ·': '等就绪超时 ·',
    'Sleeping after idle:': '空闲后已休眠：',
    '· click Start to load it again': '· 点 Start 重新加载',
    'In use': '使用中',
    '· unload in': '· 距卸载',
    'Preflight': '显存预演',
    'Preflight VRAM': '预演显存占用',
    'Running…': '计算中…',
    '· GPU layers': '· 可上卡层数',
    '· suggest ctx': '· 建议 ctx',
    'Unload when idle for': '空闲多久自动卸载',
    'frees VRAM while the model sits unused': '模型闲置时把显存让给别的程序',
    'The GPU ran out of memory. Lower the context size, switch the KV cache to q8_0, or close other GPU-heavy apps, then try again.': '显存不够用。把上下文调小、把 KV 精度换成 q8_0，或者先关掉其它吃显存的程序，然后再试一次。',
    'Runs llama-fit-params to see how this model fits your card': '跑一遍 llama-fit-params，看这个模型在本卡上到底能装成什么样',
    '5 min': '5 分钟',
    '15 min': '15 分钟',
    '30 min': '30 分钟',
    'never': '永不',
    // ngl=99 起的语义：不指定层数，交给 llama.cpp 按空闲显存自己拟合
    'auto': '自动',
    '99 or more means': '填 99 及以上表示',
    'auto - let llama.cpp fit the layers to free VRAM': '自动 —— 由 llama.cpp 按当前空闲显存决定放几层',
    // 「接口接入」卡片：desc 是渲染成 title 属性的，必须走 ATTRS 那条路才翻得到。
    // 这批词 2026-09-21 用真实浏览器抓 DOM 时发现漏了（页面上留英文 title）。
    'OpenAI compatible chat': 'OpenAI 兼容的对话接口',
    'List served models': '列出已加载的模型',
    'Embeddings': '向量嵌入',
    'Server & model info': '服务与模型信息',
    'Per-slot activity': '各槽位实时状态',
    'Health check': '健康检查',
    // 通知中心的无障碍标签（第三方 toast 组件生成的，源码里搜不到）
    'Notifications alt+T': '通知（Alt+T）',
    // 设置抽屉顶部那句提示：它在每个分区都会渲染，之前 DICT 里对应的是一条被切坏的
    // key（`'s localStorage"'`），所以整句一直留着英文。这是页面上最显眼的一处漏翻。
    'Settings are saved in browser\'s localStorage': '设置保存在本浏览器的 localStorage 中',
    // 网络错误消息（error.constants.ts），之前漏了这一条
    'Connection refused - server may be offline': '连接被拒绝 —— 服务端可能没在运行',
    'Not Found': '未找到',
    // 内置启动方案名（launch-presets.svelte.ts）。
    // 注意：方案 id 才是持久化的键，翻译只影响显示，不影响选中/导出。
    'Balanced 32K': '均衡 32K',
    'Long context 128K': '长上下文 128K',
    'Multi-slot 4 x 32K': '多槽 4 × 32K',
    'CPU only': '仅 CPU',
    // API Key 那句话被 <code>--api-key</code> 切成了两个文本节点，
    // DICT 只能按片段配，拼起来读得通即可（overlay 是按整节点等值匹配的，见文件头说明）
    'Set the API Key if you are using': '如果你在用',
    'option for the server.': '这个服务端选项，就得设置 API Key。',
    // ===== 2026-09-21 第七轮 =====
    // (1) 性能页「按模型存参数」补到 9 个字段：线程数 / batch / ubatch 原先在 UI 上根本没有入口，
    //     用户看到的现象就是"方案好像只保存了上下文长度"。
    'Batch size (-b)': '批处理 (-b)',
    'Micro-batch (-ub)': '微批 (-ub)',
    'CPU threads used for generation (the model is on the GPU; this only adds CPU load)': '生成时使用的 CPU 线程数（模型跑在 GPU 上，这一项只会增加 CPU 负载）',
    'Smaller values shrink the compute buffer - often the cheapest way to fit more layers on the GPU': '调小会缩小计算缓冲 —— 通常是把更多层塞进 GPU 最划算的一招',
    // (2) 显存清理卡：管理器管不到的 llama-server 也在那里收掉。
    'VRAM cleanup': '显存清理',
    'The manager only knows about the instances it started itself.': '管理器只知道它自己启动的实例。',
    'A llama-server launched by the desktop shell, a .bat file or a script never shows up in the instance list - and it keeps holding VRAM until you stop it here.': '由桌面外壳、.bat 或脚本直接拉起的 llama-server 不会出现在实例列表里 —— 它会一直占着显存，直到你在这里把它停掉。',
    'Processes started by another app (Ollama, Docker, ...) are listed too, but this panel never stops them.': '其他程序启动的进程（Ollama、Docker 等）也会列出来，但本面板永远不会去结束它们。',
    'No llama-server is running right now, so nothing is holding VRAM.': '当前没有 llama-server 在运行，没有进程占着显存。',
    'managed': '管理器托管',
    'in use': '正在使用',
    'unmanaged': '无人管理',
    'other app': '其他程序',
    'started by another app - unload it there': '由其他程序启动 —— 请到那个程序里卸载',
    // 别的程序启动的进程来源名（由 manager 返回，动态文本节点）
    'external script': '外部脚本',
    'unknown': '来源不明',
    'Unload': '卸载',
    'Rescan': '重新扫描',
    'Clean up unmanaged': '清理无人管理的进程',
    'The cleanup button stops only leftovers of this app: the same llama-server.exe, not in the instance list and not listening on the active port. Processes started by other apps are never touched.': '「清理」按钮只结束本应用自己的残留：同一份 llama-server.exe、不在实例列表里、也不监听活跃端口。其他程序的进程绝不会被碰。',
    'Restart the app to enable cleanup: the running manager cannot tell other programs apart.': '重启应用后才能启用清理：当前的管理器分不清哪些进程属于其他程序。',
    'Parked duplicate files waiting for the process to release them:': '暂存的重复文件（等进程放手后自动删除）：',
    'Records the manager still marks as running, but whose process is gone:': '管理器仍标记为运行中、进程却已消失的记录：',
    'Nothing was stopped.': '没有结束任何进程。',
    'Stopped processes:': '已结束进程：',
    '· VRAM released:': '· 已释放显存：',
    '· Windows may take a moment to return the VRAM.': '· Windows 可能还需要一点时间才归还显存。',
    'Scanning for llama-server processes...': '正在扫描 llama-server 进程…',
    'Stop this process and release its VRAM': '结束这个进程并释放它占的显存',

    // ---------- 模型加载阶段（C）----------
    // 下面这些 label 由 manager 的 /api/instances/<id>/progress 返回
    // （见 manager.py 的 LOAD_STAGE_MARKERS）。界面把它们**单独渲染成一个文本节点**，
    // 所以整节点等值匹配能命中 —— 上游原先把阶段名和百分比拼成一个串（
    // "Loading weights 45%"），那种形态这里永远匹配不到，等于一直显示英文。
    'Starting process': '拉起进程',
    'Reading weights': '读取权重',
    'Initializing threads': '初始化线程池',
    'Reading hyperparameters': '读取超参数',
    'Initializing KV cache': '初始化 KV 缓存',
    'Almost ready': '即将就绪',
    'Ready': '就绪',
    // ⚠️ 别再往这里加 'Loading model' / 'Loading weights' / 'Loading draft'
    //    / 'Loading projector' —— 上面 300 行左右（上游文本）已经有同名的词条，
    //    同一个对象字面量里重复的键**后者覆盖前者**，会静默改掉上游那几处的译文。
    //    实测踩过：新加的 'Pinned': '常驻中' 把侧边栏「置顶对话」的
    //    'Pinned': '已置顶' 顶掉了。新增词条前先 grep 一遍键名。
    // 官方 router 模式那套阶段名（MODEL_LOAD_STAGE_LABELS）复用上游既有译文即可。
    'Model failed to start ·': '模型启动失败 ·',
    'Model did not become ready in time': '模型未在预期时间内就绪',

    // ---------- 空闲卸载的可见性与控制（D）----------
    // 用 'Kept loaded' 而不是 'Pinned'：后者是上游侧边栏「置顶对话」的键，撞了。
    'Kept loaded': '常驻中',
    // 等待加载时那句「实际下发的 ctx 被自动改小了」。
    // ⚠️ 截图验收时抓到的漏网之鱼：中文界面里孤零零留着一行英文
    //    （阶段名、百分比、降档数字都对了，只有这句没进词表）。
    //    新增任何英文文案后，**必须**回这张表里补一条，或去 header 里 grep 确认已存在。
    'Context was lowered to fit your VRAM:': '已按显存自动下调上下文长度：',
    'Keep this model loaded (never unload when idle)': '保持常驻（空闲时不自动卸载）',
    'Stop keeping this model loaded': '取消常驻',
    'Could not change the keep-loaded setting': '无法修改常驻设置',
    'Model unloaded to save VRAM - send a message to load it again': '已为节省显存卸载模型 —— 发一条消息即可重新加载',
    'Launch parameters were lowered to fit your VRAM': '启动参数已按显存自动下调',
    // ---------- 设置页「备份管理」 ----------
    // 2026-09-23：该组件原本**整页写死中文**，是 static 审计
    // （tools/diag/audit_hardcoded_cjk.mjs，308 个 .svelte 里唯一一个）报出来的漏翻文件 ——
    // 中文用户看不出问题，英文模式下整页都是中文。现改为「英文源码 + 本表提供中文」。
    'Backup': '备份管理',
    'Local backup': '本地备份',
    'Create backup': '创建备份',
    'Choose backup folder': '选择备份文件夹',
    'Import file': '导入文件',
    'Confirm': '确认',
    'Backup name (optional)': '备份名称（可选）',
    'Include settings (chat / sampling parameters)': '包含设置（聊天 / 采样参数）',
    'Include conversations (can be large)': '包含对话历史（可能较大）',
    'Launch presets (including your own) are always included.': '启动方案（含你自建的方案）始终包含在备份中。',
    'Save to local disk': '保存到本地磁盘',
    'No backups yet. Click Create backup to make the first one.': '还没有备份。点击「创建备份」生成第一个。',
    'presets': '方案',
    'conversations': '对话',
    'Restore': '恢复',
    'Restore this backup': '恢复此备份',
    'Export to file': '导出为文件',
    'Delete this backup': '删除此备份',
    // 两段说明在 DOM 里被 <code> 切成两个文本节点，所以前后两半都得有词条。
    'Local disk hosting is unavailable in this browser (requires Chromium / WebView2 over a secure https or localhost context). Use Import file below to restore from a backup bundle; the desktop llama-desk build writes backups straight to disk (e.g.': '当前浏览器不支持本地磁盘托管（需 Chromium / WebView2，且为 https 或 localhost 安全上下文）。可用下方「导入文件」从备份文件恢复；桌面版 llama-desk 支持把备份直接写入本地磁盘（如',
    ') and manages them automatically.': '）并自动管理。',
    'No backup folder selected yet. Click Choose backup folder and pick': '尚未选择备份文件夹。点击「选择备份文件夹」并选中',
    '(or any folder you like) — every backup is written straight there and manageable in this list. The choice is remembered, so you only authorize once.': '（或任意你喜欢的目录），之后所有备份将直接写入该目录、可在此列表里管理。选择一次后会被记住，无需重复授权。',
    // 确认对话框：描述里带插值（备份名 / 文件名），拆成静态分片走 DialogConfirmation 的 descriptionSnippet。
    'Restore this backup?': '恢复此备份？',
    // ---------- 设置页「自动备份」（2026-09-25 新增） ----------
    'Auto backup': '自动备份',
    'Enable auto backup': '启用自动备份',
    'Automatically save a full backup (presets, settings and conversations) to the backup folder above. Checked at startup and every 30 minutes; a new file is written only when the interval has elapsed. Oldest automatic backups are pruned; manual backups are never touched.': '自动把完整备份（启动方案、设置与对话历史）保存到上方选定的备份文件夹。应用启动时和每 30 分钟检查一次，到达间隔才写入新文件；超出保留数量的旧自动备份会被清理，手动创建的备份永不触碰。',
    'Interval (hours)': '间隔（小时）',
    'Keep count': '保留份数',
    'Last automatic backup:': '上次自动备份：',
    'No automatic backup yet — the first one runs shortly.': '还没有自动备份——第一份很快生成。',
    'Auto backup is off.': '自动备份未启用。',
    'Automatic backups need a Chromium-based desktop build.': '自动备份需要基于 Chromium 的桌面版。',
    'Choose a backup folder first — auto backup stays off until then.': '请先选择备份文件夹——在此之前自动备份不会运行。',
    'Restore from “': '将用「',
    '”: launch presets are merged by name (same name overwritten, ones created after the backup kept), settings imported as a whole': '」恢复：启动方案按名称合并去重（同名的覆盖、备份后新建的保留）、设置整体导入',
    ', conversations merged by id (existing ones overwritten, new ones appended)': '、对话历史按 id 合并（已存在的覆盖、新的追加）',
    '. Data you have not backed up is left untouched.': '。当前未备份的数据不会被覆盖。',
    'Delete this backup?': '删除此备份？',
    'This permanently deletes the local file “': '将永久删除本地文件「',
    '”. This action cannot be undone.': '」。此操作不可撤销。',
    // toast 与兜底异常文案（渲染成 toast 里的文本节点，走同一条匹配路径）
    'Backup folder selected — future backups go straight to that directory': '已选择备份文件夹，后续备份将直接写入该目录',
    'No folder selected, or permission was denied': '未选择文件夹或权限被拒绝',
    'Backup folder needs re-authorization after the app restarted. Click Re-grant access and choose “Allow on every visit” to never see this prompt again.': '应用重启后备份文件夹需要重新授权。点击「重新授权」并在提示中选择「每次访问时都允许」，之后就不会再询问',
    'Re-grant access': '重新授权',
    'Backup folder re-granted — automatic backups are active again': '备份文件夹已重新授权，自动备份恢复工作',
    'Backup created and saved to local disk': '备份已创建并保存到本地磁盘',
    'Failed to create the backup': '创建备份失败',
    'Restore complete (presets merged and de-duplicated). Reload the page to apply the settings.': '恢复完成（方案已合并去重），建议刷新页面以应用设置',
    'Restored from file (presets merged and de-duplicated). Reload the page to apply the settings.': '已从文件恢复（方案已合并去重），建议刷新页面以应用设置',
    'Restore failed': '恢复失败',
    'Deleted': '已删除',
    // ---------- 设置页「关于应用」（原托盘更新三件套/重启服务/日志搬到这里） ----------
    'About app': '关于应用',
    'App info': '应用信息',
    'Updates': '更新',
    'Service & logs': '服务与日志',
    'llama-desk (this app)': 'llama-desk（本应用）',
    'build unknown': '版本未知',
    'About and update controls are provided by the desktop shell (llama-desk.exe) and are unavailable when the interface runs in a plain browser. Open the app via': '「关于应用」与更新控制由桌面外壳（llama-desk.exe）提供，纯浏览器模式下不可用。请通过',
    'to check for llama.cpp updates, toggle auto-update, restart the local service or open the log folder.': '启动应用，才能检查 llama.cpp 更新、开关自动更新、重启本地服务或打开日志目录',
    'Updates are downloaded from the official llama.cpp GitHub releases into the system temp folder, unpacked straight into the bin directory, and verified by a smoke test. The previous version is backed up next to the bin directory (last 3 kept) and restored automatically if the new binary fails to start.': '更新包从 llama.cpp 官方 GitHub 发布页下载到系统临时目录，直接解压进 bin 目录，并通过冒烟测试验证。旧版本会备份在 bin 同级目录（最多保留 3 份），新版本启动失败时自动回滚',
    'Check for llama.cpp updates on startup': '启动时检查 llama.cpp 更新',
    'When enabled, the app checks GitHub at startup and silently installs a new build before launching the service.': '开启后应用启动时会检查 GitHub，并在拉起服务前静默安装新版本',
    'Check for updates': '检查更新',
    'Download & install update': '下载并安装更新',
    'Checking…': '检查中…',
    'Updating llama.cpp — the local service restarts when it finishes. You can keep using the app; a system notification will tell you when it is done.': '正在更新 llama.cpp —— 完成后会自动重启本地服务。期间可以继续使用应用，更新结束会有系统通知',
    'Restart local service': '重启本地服务',
    'Open log folder': '打开日志目录',
    'Restarting stops and relaunches the llama-server managed by the app (models stay unloaded until the next message). Logs live in': '重启会停止并重新拉起应用托管的 llama-server（模型在下一条消息时才重新加载）。日志位于',
    'the log directory': '日志目录',
    'Restarting the local service…': '正在重启本地服务…',
    'Could not start the updater': '无法启动更新程序',
    'Delete failed': '删除失败',
    'Export failed': '导出失败',
    'No file selected, or the file is not a valid backup': '未选择文件或文件无效',
    };
  // ---------- 带动态内容的文本：正则规则表 ----------
  // 上面 DICT 是「整个文本节点等值」匹配，只覆盖得了完全静态的文案。模板里一旦有
  // 插值（`${n} models`）或 inline 元素（`<code>--api-key</code>`），DOM 里的文本
  // 就会比 key 多出数字/单词，于是永远查不到、页面上继续显示英文。
  // 这张表专门兜这一类。顺序有意义：更具体的规则必须排在更泛的前面。
  var RULES = [
    // 错误提示：`Request failed: 404 Not Found`（error.constants.ts 的 GENERIC 拼上状态码）。
    // 单条 `Request failed` 在 DICT 里，这里只管带状态码的拼接形态。
    [/^Request failed:\s*(\S.*)$/, '请求失败：$1'],
    // 顶层错误页的标题：由 `<span>Error</span> <span>404</span>` 两个节点渲染，
    // 但某些路径下会合并成一个节点 `Error 404`，所以两种形态都要兜。
    [/^Error (\d{3})$/, '错误 $1'],
    // 计数类文本：`2 tools`、`12 models` 这种插值。DICT 是按整节点等值匹配的，
    // 数字一变就查不到，只能用规则。正则写严一点，避免误伤别的文本。
    [/^(\d+)\s+tools?$/, '$1 个工具'],
    [/^(\d+)\s+models?$/, '$1 个模型'],
    [/^(\d+)\s+conversations?$/, '$1 个对话'],
    [/^(\d+)\s+files?$/, '$1 个文件'],
    [/^(\d+)\s+servers?$/, '$1 个服务器'],
    // 参数页每个输入框的 placeholder：`Default: 0.7` / `Default: -1`（模板拼的）。
    // 之前全是英文，是参数页最扎眼的一处混杂。
    [/^Default:\s*(.+)$/, '默认值：$1'],
  ];

  function applyRules(s){
    for (var i = 0; i < RULES.length; i++){
      if (RULES[i][0].test(s)) return s.replace(RULES[i][0], RULES[i][1]);
    }
    return undefined;
  }

  var LS_KEY = 'webui.lang';
  var lang = (localStorage.getItem(LS_KEY) || 'zh');

  // 暴露全局语言切换函数，供官方设置里的 Language 下拉调用（实时切换，无需 reload）
  window.__overlaySetLocale = function(val){
    if (val !== 'zh' && val !== 'en') return;
    lang = val;
    localStorage.setItem(LS_KEY, val);
    applyAll();
  };

  function translateTextNode(n){
    if (n.nodeType !== 3) return;
    var raw = n.nodeValue;
    // 归一化：把所有空白序列折叠为单空格，便于匹配 Svelte 模板拼接出的含换行节点
    var norm = raw.replace(/\s+/g,' ').trim();
    if (!norm) return;
    // 已译过、且内容**没有被外部改过** -> 跳过。
    // __out 记的是「自己写进去的内容」，不是「处理过的标记」。区别很重要：
    // Svelte 更新同一个文本节点时（`5s ago` -> `6s ago`、消息流式追加），
    // 值会变而节点不变；不看 __out 的话会被当成「处理过了」直接放过，
    // 动态数字一变就退回英文。
    if (n.__orig !== undefined && n.__out === raw) return;
    var zh = DICT[norm];
    if (zh === undefined) zh = applyRules(norm);
    if (zh === undefined) return;
    n.__orig = raw;
    var lm = raw.match(/^\s*/)[0];
    var rm = raw.match(/\s*$/)[0];
    var out = lm + zh + rm;
    n.__out = out;
    n.nodeValue = out;
  }
  function restoreTextNode(n){
    if (n.nodeType !== 3) return;
    if (n.__orig !== undefined){ n.nodeValue = n.__orig; n.__orig = undefined; }
    n.__out = undefined;
  }
  // `label` 是 <optgroup> / <option> 的显示文本，不加进来分组标题在中文模式下会留英文。
  //
  // ⚠️ 这里**刻意不含 `value`**。原先把 value 也算进来了，但 value 从不是给人看的
  // 文本：`<option value="top_k">`、`<input value="0.8">` 里的 value 是**要提交给
  // 服务端的数据**。一旦它恰好命中 DICT 就被改写，提交上去的参数就变了 ——
  // 界面看着正常、功能却悄悄坏掉，属于最难查的一类问题。显示文本走文本节点那条路。
  var ATTRS = ['placeholder','title','aria-label','alt','label'];
  function translateEl(el){
    for (var k=0;k<ATTRS.length;k++){
      var a = ATTRS[k];
      var v = el.getAttribute ? el.getAttribute(a) : null;
      if (!v) continue;
      if (el['__o_'+a] !== undefined && el['__ow_'+a] === v) continue;
      var zh = DICT[v];
      if (zh === undefined) zh = applyRules(v);
      if (zh === undefined) continue;
      if (el['__o_'+a] === undefined) el['__o_'+a] = v;
      el['__ow_'+a] = zh;
      el.setAttribute(a, zh);
    }
  }
  function restoreEl(el){
    for (var k=0;k<ATTRS.length;k++){
      var a = ATTRS[k];
      if (el['__o_'+a] !== undefined){ el.setAttribute(a, el['__o_'+a]); el['__o_'+a] = undefined; }
      el['__ow_'+a] = undefined;
    }
  }

  // getElementsByTagName 返回的是 **live collection**：边索引边改会让它每步重算，
  // 旧实现直接在上面循环，是性能上的一个暗坑。统一先快照成数组。
  function snapshot(htmlCollection){
    var n = htmlCollection.length, out = new Array(n);
    for (var i=0;i<n;i++) out[i] = htmlCollection[i];
    return out;
  }

  function translateTree(root){
    if (root.nodeType === 3){ translateTextNode(root); return; }
    if (root.nodeType !== 1) return;
    translateEl(root);
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (var i=0;i<nodes.length;i++) translateTextNode(nodes[i]);
    var els = snapshot(root.getElementsByTagName('*'));
    for (var j=0;j<els.length;j++) translateEl(els[j]);
  }

  function restoreTree(root){
    if (root.nodeType === 3){ restoreTextNode(root); return; }
    if (root.nodeType !== 1) return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (var i=0;i<nodes.length;i++) restoreTextNode(nodes[i]);
    var els = snapshot(root.getElementsByTagName('*'));
    for (var j=0;j<els.length;j++) restoreEl(els[j]);
    restoreEl(root);   // root 自身不在 getElementsByTagName('*') 的结果里，得单独还原
  }

  /** 全量：只在语言切换、路由跳转、load 兜底时用。 */
  // 与上面的 boot 记录配对：boot 证明「脚本跑起来了」，这里记录「跑完后的实况」
  // —— 当前语言、翻译执行次数、页面上中/英文本节点各多少。有了这两条，英文界面的
  // 归因就变成读数而不是猜测。
  var applyCount = 0, _diagAt = 0;
  function reportDiag(){
    var now = Date.now();
    if (now - _diagAt < 1000) return;   // 路由快速切换时别反复全树统计
    _diagAt = now;
    try {
      var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      var zh = 0, en = 0, n;
      while ((n = w.nextNode())){
        var t = n.nodeValue;
        if (!t || t.length < 2) continue;
        var p = n.parentElement; if (!p) continue;
        var tag = p.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'CODE' || tag === 'PRE') continue;
        if (/[\u4e00-\u9fff]/.test(t)) zh++;
        else if (/[A-Za-z]{3,}/.test(t)) en++;
      }
      localStorage.setItem('webui.overlay.diag', JSON.stringify({
        src: SELF_SRC, lang: lang, at: now, applyCount: applyCount,
        zh: zh, en: en, hash: location.hash, dict: Object.keys(DICT).length
      }));
    } catch(e){ /* 不阻断 UI */ }
  }
  function applyAll(){
    applyCount++;
    try {
      if (lang === 'zh') translateTree(document.body);
      else restoreTree(document.body);
    } catch(e){ /* 不阻断 UI */ }
    reportDiag();
  }

  // 语言切换浮窗
  function buildToggle(){
    var bar = document.createElement('div');
    bar.id = 'wb-lang';
    bar.style.cssText = 'position:fixed;bottom:10px;right:10px;z-index:99999;display:flex;gap:4px;'
      + 'background:rgba(20,20,28,.86);border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:4px;';
    function mk(label, val){
      var b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'cursor:pointer;border:0;background:transparent;color:#9aa;font:13px system-ui;'
        + 'padding:3px 8px;border-radius:6px;';
      b.onclick = function(){
        lang = val;
        localStorage.setItem(LS_KEY, val);
        applyAll();
        mark();
      };
      b.__val = val;
      return b;
    }
    var z = mk('中文', 'zh'), e = mk('EN', 'en');
    bar.appendChild(z); bar.appendChild(e);
    document.body.appendChild(bar);
    function mark(){
      [z,e].forEach(function(b){
        b.style.background = (b.__val === lang) ? 'rgba(120,120,255,.35)' : 'transparent';
        b.style.color = (b.__val === lang) ? '#fff' : '#9aa';
      });
    }
    mark();
  }

  // ---------- 增量翻译（性能关键）----------
  // 旧实现：只要 body 里有任何变动，就在下一帧**全量重扫整棵树**。
  // 聊天页流式输出时每一帧都在改 DOM，于是每帧都要新建 TreeWalker（上千个文本节点）
  // 再遍历一遍所有元素 —— 打字、滚动、切页都会发涩。
  // 现在只处理「本次变动真正涉及的子树」，成本与那次变动的大小成正比，而不是与页面大小成正比。
  var _pend = [];
  var _pendSet = null;
  var _scheduled = false;

  function scheduleSubtree(root){
    if (!root) return;
    if (root.nodeType !== 1 && root.nodeType !== 3) return;
    if (!_pendSet) _pendSet = new Set();
    if (_pendSet.has(root)) return;
    if (_pendSet.size > 4000) return;   // 极端情况兜底：本轮交给后面的全量兜底
    _pendSet.add(root);
    _pend.push(root);
    if (_scheduled) return;
    _scheduled = true;
    var raf = window.requestAnimationFrame || function(cb){ return setTimeout(cb, 16); };
    raf(flushSubtrees);
  }

  function flushSubtrees(){
    _scheduled = false;
    var roots = _pend;
    _pend = [];
    _pendSet = null;
    try {
      for (var i = 0; i < roots.length; i++){
        var r = roots[i];
        if (!r.isConnected) continue;          // 处理前就被移除了
        if (lang === 'zh') translateTree(r);
        else restoreTree(r);
      }
    } catch(e){ /* 不阻断 UI */ }
  }

  function onMutations(records){
    for (var i = 0; i < records.length; i++){
      var rec = records[i];
      if (rec.type === 'characterData'){
        // 只有这一个文本节点的值变了（Svelte 更新插值）—— 精确到节点，不必扫子树
        scheduleSubtree(rec.target);
        continue;
      }
      var added = rec.addedNodes;
      for (var j = 0; j < added.length; j++){
        var n = added[j];
        if (n.nodeType === 1 || n.nodeType === 3) scheduleSubtree(n);
      }
    }
  }

  var _mo = null, _obsRoot = null, _lastBody = null, _pulseTimer = null, _startedAt = 0;
  function attachObserver(){
    // ⚠️ 必须盯 documentElement，而不是 body：SvelteKit 客户端水合有可能把整个
    // <body> 换掉，旧 body 就成了游离节点。此时 observer 若还挂在旧 body 上，
    // 之后新增/更新的文本**永远不会**再被翻译 —— 表现就是「界面一直停在英文」。
    // 挂在 documentElement 上则不受 body 替换影响。
    var root = document.documentElement;
    if (_mo && _obsRoot === root) return;
    if (_mo) _mo.disconnect();
    _mo = new MutationObserver(onMutations);
    _mo.observe(root, { childList:true, subtree:true, characterData:true });
    _obsRoot = root;
  }
  function start(){
    if (!document.body){ setTimeout(start, 50); return; }   // DOM 还没建好就等下一轮，别一走了之
    _startedAt = Date.now();
    // 首次翻译：DOM 一构建好就做，越早越不容易看到英文闪一下
    applyAll();
    // 兜底全量：水合会替换掉一部分节点，这些时间点上补几遍（单次成本亚毫秒）
    [400, 1200, 2500, 4000, 7000, 12000].forEach(function(d){ setTimeout(applyAll, d); });
    attachObserver();
    // hash 路由切换（SvelteKit 配置 router:'hash'）：整页内容会换，直接全量
    window.addEventListener('hashchange', function(){ applyAll(); attachObserver(); });
    window.addEventListener('popstate', applyAll);
    window.addEventListener('load', function(){ setTimeout(applyAll, 300); });
    // 心跳兜底（30 秒，每 2 秒一次）：既检查 body 是否被换掉（换掉就重挂 observer），
    // 也无条件补一遍全量。这一条能兜住「observer 失效 / 水合晚于所有定时器」这类
    // 会导致界面永久停英文的情况 —— 代价是 15 次全树遍历（每个亚毫秒级）。
    _pulseTimer = setInterval(function(){
      if (Date.now() - _startedAt > 30000){
        clearInterval(_pulseTimer); _pulseTimer = null; return;
      }
      if (document.body !== _lastBody){ _lastBody = document.body; attachObserver(); }
      applyAll();
    }, 2000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
