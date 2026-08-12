# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller desktop packaging specification (T026).

构建：在 apps/desktop 目录执行
    pyinstaller imagejudge.spec --noconfirm
产物：Windows/Linux 为 onedir，macOS 为 ImageJudge.app。
"""
from PyInstaller.building.osx import BUNDLE
from PyInstaller.utils.hooks import collect_submodules

block_cipher = None

# Qt WebEngine 资源由 PySide6 钩子自动收集；这里显式兜底
datas = []
hiddenimports = [
    "imagejudge",
    "imagejudge.auth",
    "imagejudge.core",
    "imagejudge.export",
    "imagejudge.model",
    "imagejudge.persistence",
    "imagejudge.ui",
    "sqlalchemy.dialects.sqlite",
]
hiddenimports += collect_submodules("PySide6.QtCore")

a = Analysis(
    ["main.py"],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "numpy.tests", "pytest"],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="ImageJudge",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,  # GUI 程序不带控制台窗口
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="ImageJudge",
)

# PyInstaller's normal onedir output is correct for Windows and Linux. On
# macOS, wrap the same collected files in a native application bundle so the
# distribution script can sign and archive a real .app rather than a bare
# executable directory.
if __import__("sys").platform == "darwin":
    app = BUNDLE(
        coll,
        name="ImageJudge.app",
        bundle_identifier="com.zhangyvjing.imagejudge",
        version="0.2.0",
        info_plist={
            "CFBundleDisplayName": "ImageJudge",
            "LSMinimumSystemVersion": "13.0",
            "NSHighResolutionCapable": True,
        },
    )
