#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
merge_translations.py - 把 71 条新翻译合并进 overlay.js DICT。
输入：new_to_translate.txt 里的人工翻译（key: value），与现有 DICT 合并。
"""
import re
import json
import sys

TRANSLATIONS_FILE = r'D:\llama\ui-src\translations.txt'
OVERLAY = r'D:\llama\ui-src\overlay.js'

# 71 条翻译（key: 英文原文，value: 中文译文）
TRANSLATIONS = {
    # ===== SettingsChatImportExportTab.svelte =====
    'Are you sure you want to delete all conversations? This action cannot be undone and will permanently remove all your conversations and messages.':
        '确定要删除所有对话吗？此操作不可撤销，将永久删除您所有的对话及消息。',
    'Conversations': '对话',
    'Download your conversations as a ZIP of JSONL files. This includes all messages, attachments, and conversation history.':
        '将对话历史下载为 ZIP 压缩包（含 JSONL 文件）。这将包含所有消息、附件和对话记录。',
    'Export': '导出',
    'Export your chat settings and preferences as a JSON file.':
        '将对话设置和偏好导出为 JSON 文件。',
    'Exported': '已导出',
    'Import': '导入',
    'Import chat settings from a previously exported JSON file. This will merge with your existing settings.':
        '从之前导出的 JSON 文件导入对话设置。这将与您现有的设置合并。',
    'Import one or more conversations from a previously exported ZIP or JSONL file. This will merge with your existing conversations.':
        '从之前导出的 ZIP 或 JSONL 文件中导入一个或多个对话。这将与您现有的对话合并。',
    'Imported': '已导入',
    'Permanently delete all conversations and their messages. This action cannot be undone. Consider exporting your conversations first if you want to keep a backup.':
        '永久删除所有对话及其消息。此操作不可撤销。如需保留备份，请先导出对话。',

    # ===== settings.constants.ts help texts =====
    'Addon for the temperature sampler. Smoothes out the probability redistribution based on the most probable token.':
        '温度采样的附加项。根据最可能的 token 平滑概率重分布。',
    'Addon for the temperature sampler. The added value to the range of dynamic temperature, which adjusts probabilities by entropy of tokens.':
        '温度采样的附加项。动态温度范围的附加值，通过 token 的熵调整概率。',
    'After each response, re-submit the conversation to pre-fill the server KV cache. Makes the next turn faster since the prompt is already encoded while you read the response.':
        '每次响应后，重新提交对话以预填充服务器 KV 缓存。由于您在阅读响应时 prompt 已被编码，下一轮会更快。',
    'Always display code blocks at their full natural height, overriding any height limits.':
        '始终以完整自然高度显示代码块，覆盖任何高度限制。',
    'Always keep the sidebar visible on desktop instead of auto-hiding it.':
        '在桌面上始终保持侧栏可见，而不是自动隐藏。',
    'Automatically expand tool call details while executing and keep them expanded after completion.':
        '执行时自动展开工具调用详情，完成后保持展开。',
    'Automatically show microphone button instead of send button when textarea is empty for models with audio modality support.':
        '当输入框为空时，对支持音频模态的模型自动显示麦克风按钮而非发送按钮。',
    'CSS injected into the page at runtime. Set it here, or ship it server side via the --ui-config customCss field.':
        '运行时注入页面的 CSS。可在此设置，或通过 --ui-config customCss 字段从服务端下发。',
    'Choose how conversation titles are generated. The first non-empty line uses a fast deterministic rule; the LLM option uses a model-generated title from the first message exchange.':
        '选择对话标题的生成方式。第一行非空内容使用快速确定性规则；LLM 选项使用模型从首轮对话中生成的标题。',
    'Choose the color theme for the interface. You can choose between System (follows your device settings), Light, or Dark.':
        '选择界面颜色主题。可在系统（跟随设备设置）、浅色、深色之间选择。',
    'Configure MCP servers as a JSON list. Use the form in the MCP Client settings section to edit.':
        '将 MCP 服务器配置为 JSON 列表。请在 MCP 客户端设置部分使用表单进行编辑。',
    'Controls the randomness of the generated text by affecting the probability distribution of the output tokens. Higher = more random, lower = more focused.':
        '通过影响输出 token 的概率分布来控制生成文本的随机性。值越高越随机，越低越聚焦。',
    'Controls the repetition of token sequences in the generated text':
        '控制生成文本中 token 序列的重复程度',
    'Counterpart of the conversation title radio; stored and synced without a dedicated UI field.':
        '对话标题单选框的对应项；存储并同步，不带独立 UI 字段。',
    'Custom JSON parameters to send to the API. Must be valid JSON format.':
        '发送给 API 的自定义 JSON 参数。必须是有效的 JSON 格式。',
    'DRY sampling reduces repetition in generated text even across long contexts. This parameter sets DRY penalty for the last n tokens.':
        'DRY 采样在长上下文中也能减少生成文本的重复。此参数设置最近 n 个 token 的 DRY 惩罚。',
    'DRY sampling reduces repetition in generated text even across long contexts. This parameter sets the DRY sampling base value.':
        'DRY 采样在长上下文中也能减少生成文本的重复。此参数设置 DRY 采样的基础值。',
    'DRY sampling reduces repetition in generated text even across long contexts. This parameter sets the DRY sampling multiplier.':
        'DRY 采样在长上下文中也能减少生成文本的重复。此参数设置 DRY 采样的乘数。',
    'DRY sampling reduces repetition in generated text even across long contexts. This parameter sets the allowed length for DRY sampling.':
        'DRY 采样在长上下文中也能减少生成文本的重复。此参数设置 DRY 采样的允许长度。',
    'Disable automatic scrolling while messages stream so you can control the viewport position manually.':
        '消息流式输出时禁用自动滚动，以便手动控制视口位置。',
    'Display full raw model identifiers (e.g. "ggml-org/GLM-4.7-Flash-GGUF:Q8_0") instead of parsed names with badges.':
        '显示完整的原始模型标识（例如 "ggml-org/GLM-4.7-Flash-GGUF:Q8_0"），而非带徽章的解析名称。',
    'Display generation statistics (tokens/second, token count, duration) below each assistant message.':
        '在每条助手消息下方显示生成统计信息（每秒 token 数、token 计数、时长）。',
    'Display model tags (e.g. "vision", "reasoning") next to model names throughout the interface.':
        '在整个界面的模型名称旁显示模型标签（例如 "vision"、"reasoning"）。',
    'Display per-turn statistics (tokens, duration) under each turn in agentic responses. Shown only when "Show message generation statistics" is enabled.':
        '在 Agentic 响应的每个轮次下显示每轮统计（token 数、时长）。仅在启用"显示消息生成统计"时显示。',
    'Display quantization badges (e.g. Q8_0, Q4_K_M) next to model names throughout the interface.':
        '在整个界面的模型名称旁显示量化徽章（例如 Q8_0、Q4_K_M）。',
    'Display the current build version in the bottom-right corner of the interface.':
        '在界面右下角显示当前构建版本。',
    'Display the full file system path inside file and folder @-mention badges instead of just the file or folder name.':
        '在文件和文件夹 @ 提及徽章中显示完整的文件系统路径，而非仅显示文件或文件夹名。',
    'Display the organization name in the model selector trigger button.':
        '在模型选择器触发按钮中显示组织名称。',
    'Display the system message at the top of each conversation.':
        '在每个对话顶部显示系统消息。',
    'Enable "Continue" button':
        '启用"继续"按钮',
    'Enable "Continue" button for assistant messages, including reasoning models.':
        '为助手消息启用"继续"按钮，包括推理模型。',
    'Enable backend-based samplers. When enabled, supported samplers run on the accelerator backend for faster sampling.':
        '启用基于后端的采样器。启用后，支持的采样器将在加速器后端上运行以加快采样。',
    'Expand thought process by default when generating messages.':
        '生成消息时默认展开思维过程。',
    'Expose a run_javascript tool to the model. Code runs in a Web Worker inside a sandboxed iframe with an opaque origin, isolated from the WebUI and its API, with a hard timeout.':
        '向模型暴露 run_javascript 工具。代码在沙箱化 iframe 内的 Web Worker 中运行，具有不透明来源，与 WebUI 及其 API 隔离，并设有硬性超时。',
    'How many directory levels below the working directory the @-mention file search descends. Larger values surface deeply nested files but take longer on large trees.':
        '@ 提及文件搜索向下遍历工作目录的层级数。较大的值可显示深度嵌套的文件，但在大型目录树中耗时较长。',
    'Images larger than this will be resized before sending to server. Set to 0 to disable.':
        '超过此大小的图片在发送到服务器前将被缩放。设为 0 表示禁用。',
    'Last n tokens to consider for penalizing repetition':
        '用于惩罚重复的最近 n 个 token',
    'Limits tokens based on how often they appear in the output.':
        '根据 token 在输出中出现的频率进行限制。',
    'Limits tokens based on the minimum probability for a token to be considered, relative to the probability of the most likely token.':
        '根据 token 被考虑的最低概率（相对于最可能 token 的概率）进行限制。',
    'Limits tokens based on whether they appear in the output or not.':
        '根据 token 是否在输出中出现进行限制。',
    'Limits tokens to those that together have a cumulative probability of at least p':
        '将 token 限制为累积概率至少为 p 的 token',
    'Maximum number of tool execution cycles before stopping (prevents infinite loops).':
        '停止前的最大工具执行轮次数（防止无限循环）。',
    'On pasting long text, it will be converted to a file. You can control the file length by setting the value of this parameter. Value 0 means disable.':
        '粘贴长文本时将转换为文件。可通过此参数值控制文件长度。值 0 表示禁用。',
    'Optional template for the title generation prompt. Use {{USER}} for the user message and {{ASSISTANT}} for the assistant message.':
        '标题生成提示词的可选模板。使用 {{USER}} 表示用户消息，{{ASSISTANT}} 表示助手消息。',
    'Parse PDF as image instead of text. Automatically falls back to text processing for non-vision models.':
        '将 PDF 解析为图像而非文本。对于非视觉模型，自动回退到文本处理。',
    'Pre-load nerdamer in the sandbox for symbolic computation: simplify, diff, integrate, solve, and more. Requires "JavaScript sandbox tool" to be enabled.':
        '在沙箱中预加载 nerdamer 以进行符号计算：化简、求导、积分、求解等。需要启用"JavaScript 沙箱工具"。',
    'Render the reasoning/thinking block content as formatted Markdown instead of plain text.':
        '将推理/思维块内容渲染为格式化的 Markdown，而非纯文本。',
    'Render user messages using markdown formatting in the chat. Turn this off to keep a message exactly as typed; @-mention badges show either way.':
        '在聊天中使用 Markdown 格式渲染用户消息。关闭此项可保持消息完全按输入显示；@ 提及徽章在两种模式下都会显示。',
    'Send reasoning_format=none so the server returns thinking tokens inline instead of extracting them into a separate field.':
        '发送 reasoning_format=none，使服务器将思维 token 内联返回，而非提取到单独的字段。',
    'Show open chats as browser-style tabs above the conversation, one per open chat. When disabled, only one chat is shown at a time.':
        '将打开的聊天显示为对话上方的浏览器风格标签页，每个打开的聊天一个标签页。禁用时，一次只显示一个聊天。',
    'Show toggle button to display messages as plain text instead of Markdown-formatted content':
        '显示切换按钮，将消息显示为纯文本而非 Markdown 格式内容',
    'Sorts and limits tokens based on the difference between log-probability and entropy.':
        '根据 log 概率与熵的差异对 token 进行排序和限制。',
    'Strip thinking from previous messages before sending. When off, thinking is sent back via the reasoning_content field so the model sees its own chain-of-thought across turns.':
        '发送前从先前消息中去除思维内容。关闭时，思维通过 reasoning_content 字段发回，模型可在多轮中看到自己的思维链。',
    'The maximum number of token per output. Use -1 for infinite (no limit).':
        '每次输出的最大 token 数。-1 表示无限（无限制）。',
    'The order at which samplers are applied, in simplified way. Default is "top_k;typ_p;top_p;min_p;temperature": top_k->typ_p->top_p->min_p->temperature':
        '采样器的应用顺序（简化形式）。默认值为 "top_k;typ_p;top_p;min_p;temperature"：top_k->typ_p->top_p->min_p->temperature',
    'The starting message that defines how model should behave.':
        '定义模型应如何行为的起始消息。',
    'Use Enter to send messages and Shift + Enter for new lines. When disabled, use Ctrl/Cmd + Enter.':
        '使用回车发送消息，Shift + 回车换行。禁用时，使用 Ctrl/Cmd + 回车。',
    'When copying a message with text attachments, combine them into a single plain text string instead of a special format that can be pasted back as attachments.':
        '复制带文本附件的消息时，将其合并为单个纯文本字符串，而非可粘贴回为附件的特殊格式。',
    'XTC sampler cuts out top tokens; this parameter controls the chance of cutting tokens at all. 0 disables XTC.':
        'XTC 采样器切掉顶部 token；此参数控制切掉 token 的概率。0 表示禁用 XTC。',
    'XTC sampler cuts out top tokens; this parameter controls the token probability that is required to cut that token.':
        'XTC 采样器切掉顶部 token；此参数控制切掉该 token 所需的概率阈值。',
}


def js_escape(s: str) -> str:
    """JS 单引号字符串字面量转义"""
    s = s.replace('\\', '\\\\')
    s = s.replace("'", "\\'")
    s = s.replace('\n', '\\n')
    s = s.replace('\r', '\\r')
    s = s.replace('\t', '\\t')
    return s


def main():
    with open(OVERLAY, 'r', encoding='utf-8') as f:
        content = f.read()

    # 找到 DICT 的结束位置（最后一个 }; 之前的最后一行非空 entry）
    # DICT 从 "var DICT = {" 开始，到对应的 "};" 结束
    dict_start = content.index('var DICT = {')
    # 找到对应的结尾；从 dict_start 开始数 { 和 } 的配对
    i = dict_start + len('var DICT = {')
    depth = 1
    while depth > 0 and i < len(content):
        c = content[i]
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
        i += 1
    # 现在 i 指向 }; 的 ; 之后
    # 找 DICT 结束 "};" 前的最后一行 entry 末尾
    # 在 ; 之前插入新 entries

    # 提取每个已有 key 用于去重检查
    existing_keys = set()
    for m in re.finditer(r"'((?:\\.|[^'\\])*)'\s*:\s*'", content):
        existing_keys.add(m.group(1))

    # 过滤掉已存在的 key
    new_entries = []
    skipped = 0
    for k, v in TRANSLATIONS.items():
        k_esc = js_escape(k)
        if k_esc in existing_keys:
            skipped += 1
            continue
        new_entries.append((k, v))

    print(f"Total translations: {len(TRANSLATIONS)}", file=sys.stderr)
    print(f"Skipped (already in DICT): {skipped}", file=sys.stderr)
    print(f"To insert: {len(new_entries)}", file=sys.stderr)

    if not new_entries:
        print("Nothing to insert.", file=sys.stderr)
        return

    # 构造插入文本
    lines = []
    lines.append("    // === 综合补全：设置抽屉 body + 全部 help + 对话框（2026-09-09） ===")
    for k, v in new_entries:
        lines.append(f"    '{js_escape(k)}': '{js_escape(v)}',")
    insert_text = '\n'.join(lines) + '\n  '

    # 在 dict 结束前插入（找到 "};\n" 的位置）
    # 找到 DICT 的 "};"（在 dict_start 之后，depth=0 的位置）
    insert_pos = i - 1  # i 现在指向 ; 之后，i-1 是 }，i-2 之前是最后一行
    # 更准确：找到 "};" 前面的空白
    # 我们要在最后一条 entry 之后、"  };" 之前插入
    # 找 "  };" 或 "\n  };" 模式
    # 简单做法：找到 depth=0 的 } 位置，往前回溯到上一个换行
    close_brace_pos = i - 2  # } 位置（i-1 是 ;）
    # 往回找上一个 \n
    nl_pos = content.rfind('\n', dict_start, close_brace_pos)
    insert_pos = nl_pos + 1  # 在 \n 之后插入

    new_file = content[:insert_pos] + insert_text + content[insert_pos:]

    with open(OVERLAY, 'w', encoding='utf-8') as f:
        f.write(new_file)

    print(f"Inserted at offset {insert_pos}", file=sys.stderr)
    print(f"New DICT entry count: {len(existing_keys) + len(new_entries)}", file=sys.stderr)


if __name__ == '__main__':
    main()