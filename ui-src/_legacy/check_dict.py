#!/usr/bin/env python3
"""检查 overlay.js 的 DICT 是否已包含候选英文串（避免重复添加）。"""
import io, json, re

P = r'D:\llama\ui-src\overlay.js'
src = io.open(P, encoding='utf-8').read()

# DICT 形如  'English': '中文',
pairs = re.findall(r"^\s*(?:'((?:[^'\\]|\\.)*)'|\"((?:[^\"\\]|\\.)*)\")\s*:\s*(?:'((?:[^'\\]|\\.)*)'|\"((?:[^\"\\]|\\.)*)\")\s*,?\s*$",
                   src, re.M)
keys = {}
for a, b, c, d in pairs:
    k = a if a else b
    v = c if c else d
    if k:
        keys[k] = v

print('DICT entries:', len(keys))

candidates = [
    "Launch Preset",
    "Edit presets & parameters →",
    "Preset used when starting a model",
    "Model",
    "with preset",
    "— pick another preset or model to update live.",
    "Predicted VRAM for",
    "Predicted VRAM",
    "No presets yet.",
    "models",
    "Click a row to preview its VRAM below the preset summary; scroll the list for more.",
    "Search models…",
    "No models match your search.",
    "Loaded",
    "loaded",
    "Start",
    "Model & Performance",
    "Parameters",
    "Launch presets live here; the Model & Performance page picks which one to load.",
    "Active preset",
    "New",
    "Save as",
    "Rename",
    "Delete",
    "Restore built-ins",
    "Tip: “New” and “Save as” create an editable copy — built-ins are just seeds.",
    "Launch parameters",
    "saved in this browser, applied when starting a model",
    "for the loaded model",
    "Load a model (or open the Model & Performance page) to see a VRAM estimate for this preset.",
    "Predicted vs Current VRAM",
    "Context clamped to model max:",
    "Search conversations...",
    "Real-time Local Resources",
    "Model Switcher",
    "Server Info",
    "Stopping…",
    "Starting…",
    "Started.",
    "Error:",
    "Refresh",
    "No model selected.",
    "Loading metrics…",
    "Cores/Threads:",
    "Current Model",
    "Generation Stats",
    "No GGUF models found in D:\\llama\\models and D:\\llama\\models\\from-ollama. Drop a `.gguf` file there, then refresh.",
]

missing = [c for c in candidates if c not in keys]
present = [c for c in candidates if c in keys]

print('\n--- ALREADY PRESENT (%d) ---' % len(present))
for c in present:
    print('  %-50s => %s' % (c, keys[c]))

print('\n--- MISSING (%d) ---' % len(missing))
for c in missing:
    print('  ' + c)
