"""桌面端启动脚本（PyInstaller 打包入口同样指向这里）。

用法：
    python apps/desktop/main.py [--verbose]
"""
from __future__ import annotations

import sys
from pathlib import Path

# 使包在当前目录可直接运行（未安装时）
sys.path.insert(0, str(Path(__file__).resolve().parent))

from imagejudge.main import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
