#!/usr/bin/env python3
"""Comprehensive sync official -> work, skipping unchanged files."""
import os, shutil, hashlib

PAIRS = [
    (r'D:\llama\ui-src\official\tools\ui\src\lib\constants\settings-keys.constants.ts',
     r'D:\llama\ui-src\work\src\lib\constants\settings-keys.constants.ts'),
    (r'D:\llama\ui-src\official\tools\ui\src\lib\constants\settings.constants.ts',
     r'D:\llama\ui-src\work\src\lib\constants\settings.constants.ts'),
    (r'D:\llama\ui-src\official\tools\ui\src\app.css',
     r'D:\llama\ui-src\work\src\app.css'),
    # chat routes (paren-path files)
    (r'D:\llama\ui-src\official\tools\ui\src\routes\(chat)\+layout.svelte',
     r'D:\llama\ui-src\work\src\routes\(chat)\+layout.svelte'),
    (r'D:\llama\ui-src\official\tools\ui\src\routes\(chat)\+page.svelte',
     r'D:\llama\ui-src\work\src\routes\(chat)\+page.svelte'),
    (r'D:\llama\ui-src\official\tools\ui\src\routes\(chat)\performance\+page.svelte',
     r'D:\llama\ui-src\work\src\routes\(chat)\performance\+page.svelte'),
    (r'D:\llama\ui-src\official\tools\ui\src\routes\(chat)\parameters\+page.svelte',
     r'D:\llama\ui-src\work\src\routes\(chat)\parameters\+page.svelte'),
    (r'D:\llama\ui-src\official\tools\ui\src\lib\components\app\settings\SettingsChat\SettingsChat.svelte',
     r'D:\llama\ui-src\work\src\lib\components\app\settings\SettingsChat\SettingsChat.svelte'),
    (r'D:\llama\ui-src\official\tools\ui\src\lib\components\app\settings\SettingsChat\SettingsChatFields.svelte',
     r'D:\llama\ui-src\work\src\lib\components\app\settings\SettingsChat\SettingsChatFields.svelte'),
    # routes / stores（2026-09-19 新增：侧栏搜索改造 + 启动方案 store + 路由常量）
    (r'D:\llama\ui-src\official\tools\ui\src\lib\constants\routes.constants.ts',
     r'D:\llama\ui-src\work\src\lib\constants\routes.constants.ts'),
    (r'D:\llama\ui-src\official\tools\ui\src\lib\stores\index.ts',
     r'D:\llama\ui-src\work\src\lib\stores\index.ts'),
    (r'D:\llama\ui-src\official\tools\ui\src\lib\stores\launch-presets.svelte.ts',
     r'D:\llama\ui-src\work\src\lib\stores\launch-presets.svelte.ts'),
    # sidebar navigation（侧栏顶部内联搜索）
    (r'D:\llama\ui-src\official\tools\ui\src\lib\components\app\navigation\SidebarNavigation\SidebarNavigation.svelte',
     r'D:\llama\ui-src\work\src\lib\components\app\navigation\SidebarNavigation\SidebarNavigation.svelte'),
    (r'D:\llama\ui-src\official\tools\ui\src\lib\components\app\navigation\SidebarNavigation\SidebarNavigationActions.svelte',
     r'D:\llama\ui-src\work\src\lib\components\app\navigation\SidebarNavigation\SidebarNavigationActions.svelte'),
    (r'D:\llama\ui-src\official\tools\ui\src\lib\components\app\navigation\SidebarNavigation\SidebarNavigationConversationList.svelte',
     r'D:\llama\ui-src\work\src\lib\components\app\navigation\SidebarNavigation\SidebarNavigationConversationList.svelte'),
]

def sha(p):
    if not os.path.exists(p): return None
    with open(p, 'rb') as f: return hashlib.sha256(f.read()).hexdigest()[:12]

synced = skipped = 0
for src, dst in PAIRS:
    if not os.path.exists(src):
        print(f'SRC MISS {src}')
        continue
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if sha(src) == sha(dst):
        skipped += 1
        continue
    shutil.copy2(src, dst)
    synced += 1
    print(f'OK   {dst}')

print(f'\nSynced: {synced}, Skipped: {skipped}')
