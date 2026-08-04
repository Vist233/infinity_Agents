"""程序入口：初始化 Qt 应用与控制器（文档 §4.1）。"""
from __future__ import annotations

import argparse
import sys


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="ImageJudge")
    parser.add_argument("--verbose", action="store_true", help="输出调试日志")
    args = parser.parse_args(argv)

    # 高 DPI 与平台插件需在创建 QApplication 前设置
    from PySide6.QtWidgets import QApplication

    from .app import AppController

    app = QApplication(sys.argv)
    app.setApplicationName("ImageJudge")
    app.setOrganizationName("ImageJudge")

    controller = AppController(verbose=args.verbose)
    app.aboutToQuit.connect(controller.shutdown)
    controller.start()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
