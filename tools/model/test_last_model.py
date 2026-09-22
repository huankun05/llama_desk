# -*- coding: utf-8 -*-
"""离线验证「上一次使用的模型」记录（`app/last-model.json` + `GET /api/last-model`）。

外壳以零模型哨兵启动后，界面上要显示「上次使用的模型（未加载）」，并在首次对话时
按这份记录把模型拉起来 —— 所以这份记录**必须**按下面的优先级取，取错了会在用户
第一次发消息时拉错模型：

  1. 记录文件（跨进程、跨应用重启都在）—— 最新真实使用过的那个
  2. 文件缺失时退回实例表里 **started_at 最大** 的那条
     （覆盖「manager 一直没重启、只是换了新代码」的情形）
  3. 两条都没有 → `None`（前端据此安静放行，不报错）

⚠️ 判据只用文件与实例表，**绝不能靠猜**（例如翻「配过启动方案的模型」按对象键顺序取
最后一个）—— 实测用户 byModel 里的最后一个模型是 9B，而真正最后跑的是 4B。
"""
import importlib.util
import os
import sys

MGR = r"D:\llama\webui\manager.py"
TMP = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_last_model_test.json")


def load_manager():
    spec = importlib.util.spec_from_file_location("mgr_under_test", MGR)
    mod = importlib.util.module_from_spec(spec)
    # manager.py 顶层只定义常量/函数，不会起服务（服务在 __main__ 里），所以可以安全 import
    spec.loader.exec_module(mod)
    return mod


def main():
    m = load_manager()

    # 把记录文件指到临时路径，绝不碰用户真实的 app/last-model.json
    m.LAST_MODEL_FILE = TMP
    for p in (TMP, TMP + ".tmp"):
        if os.path.exists(p):
            os.remove(p)

    fails = []

    def check(label, got, want):
        ok = got == want
        print(f"  {'PASS' if ok else 'FAIL'}  {label}\n        得到 {got}\n        期望 {want}")
        if not ok:
            fails.append(label)

    try:
        m.instances.clear()
        check("无文件 + 实例表为空 → None", m.get_last_model(), None)

        m.instances["a"] = {"model_path": "D:/old.gguf", "model": "OLD", "started_at": 100}
        m.instances["b"] = {"model_path": "D:/new.gguf", "model": "NEW", "started_at": 200}
        check("实例表两条，取最近启动的那条",
              m.get_last_model(), {"path": "D:/new.gguf", "name": "NEW"})

        # 空闲休眠的记录也必须算数 —— 它正是「上次用的模型」
        m.instances["b"]["unloaded_reason"] = "idle"
        m.instances["b"]["status"] = "stopped"
        check("最近那条是 idle 休眠记录也算数",
              m.get_last_model(), {"path": "D:/new.gguf", "name": "NEW"})

        m._remember_last_model("D:/file.gguf", "FILE")
        check("写了文件后文件优先",
              m.get_last_model(), {"path": "D:/file.gguf", "name": "FILE"})
        check("临时文件已清理（原子替换的副产物）", os.path.exists(TMP + ".tmp"), False)

        with open(TMP, "w", encoding="utf-8") as f:
            f.write("{这不是合法 JSON")
        check("文件损坏 → 退回实例表",
              m.get_last_model(), {"path": "D:/new.gguf", "name": "NEW"})

        m._remember_last_model("D:/dir/foo.gguf")
        check("省略 name → 用 basename",
              m.get_last_model(), {"path": "D:/dir/foo.gguf", "name": "foo.gguf"})

        m.instances.clear()
        os.remove(TMP)
        check("全空 → None（首次使用）", m.get_last_model(), None)
    finally:
        for p in (TMP, TMP + ".tmp"):
            if os.path.exists(p):
                os.remove(p)

    print()
    print("结果:", "PASS ✅" if not fails else f"FAIL ❌ ({len(fails)} 项)")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
