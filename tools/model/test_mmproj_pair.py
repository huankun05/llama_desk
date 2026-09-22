# -*- coding: utf-8 -*-
"""离线验证 mmproj 配对逻辑（不占显存、不起服务）。

覆盖三种真实情况 + 三种必须"不挂"的情况：
  ① 强匹配：文件名去掉量化标记后相等（4B + 它的 BF16 投影层）
  ② 弱匹配：同目录只有这一个模型 + 这一个投影层，名字毫无关系
  ③ 目录里一堆模型 + 一个投影层 → 必须不挂（宁可纯文本也不要挂错）
  ④ 模型不在投影层所在目录 → 不挂
  ⑤ 根本没有投影层 → 不挂
"""
import importlib.util, os, sys, tempfile

MGR = r"D:\llama\webui\manager.py"
MODELS_HF = r"D:\llama\models\hf"


def load_manager():
    spec = importlib.util.spec_from_file_location("mgr_mmproj_test", MGR)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    m = load_manager()
    fails = []

    def check(label, got, want_truthy):
        ok = bool(got) == want_truthy
        print(("  PASS  " if ok else "  FAIL  ") + label + " -> " + repr(got))
        if not ok:
            fails.append(label)

    M4 = os.path.join(MODELS_HF, "Qwen3.5-4B-Uncensored-HauhauCS-Aggressive-Q6_K.gguf")
    MJ = os.path.join(MODELS_HF, "mmproj-Qwen3.5-4B-Uncensored-HauhauCS-Aggressive-BF16.gguf")

    print("[1] 真实文件：键应相等")
    print("    model key =", m._mmproj_key(M4))
    print("    mmproj key =", m._mmproj_key(MJ))
    check("强匹配（真实 4B + 它的 mmproj）", m._pair_mmproj(M4, [MJ]), True)

    with tempfile.TemporaryDirectory() as d:
        # ② 弱匹配：名字完全无关，但同目录一对一
        a = os.path.join(d, "some-model-q4_k_m.gguf")
        b = os.path.join(d, "mmproj-model-f16.gguf")
        open(a, "w").close(); open(b, "w").close()
        check("弱匹配（同目录一对一，名字无关）", m._pair_mmproj(a, [b]), True)

        # ③ 目录里一堆模型 + 一个投影层 -> 不挂
        c = os.path.join(d, "another-model.gguf")
        open(c, "w").close()
        check("歧义（多模型 + 单投影层）应不挂", m._pair_mmproj(a, [b]), False)

        # ④ 投影层在别的目录 -> 不挂
        with tempfile.TemporaryDirectory() as other:
            e = os.path.join(other, "mmproj-x-f16.gguf")
            open(e, "w").close()
            check("投影层不在同目录应不挂", m._pair_mmproj(a, [e]), False)

    # ⑤ 没有投影层
    check("无投影层应不挂", m._pair_mmproj(M4, []), False)

    print("\n结果:", "全部通过 ✅" if not fails else "有失败 ❌ " + repr(fails))
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
