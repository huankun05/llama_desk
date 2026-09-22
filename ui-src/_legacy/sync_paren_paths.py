#!/usr/bin/env python3
"""Sync paren-path files from official -> work"""
import os, shutil

PAIRS = [
    (r'D:\llama\ui-src\official\tools\ui\src\routes\(chat)\+layout.svelte',
     r'D:\llama\ui-src\work\src\routes\(chat)\+layout.svelte'),
    (r'D:\llama\ui-src\official\tools\ui\src\routes\(chat)\performance\+page.svelte',
     r'D:\llama\ui-src\work\src\routes\(chat)\performance\+page.svelte'),
    (r'D:\llama\ui-src\official\tools\ui\src\routes\(chat)\parameters\+page.svelte',
     r'D:\llama\ui-src\work\src\routes\(chat)\parameters\+page.svelte'),
]

for src, dst in PAIRS:
    if os.path.exists(src):
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)
        print(f'OK   {dst}')
    else:
        print(f'MISS {src}')
