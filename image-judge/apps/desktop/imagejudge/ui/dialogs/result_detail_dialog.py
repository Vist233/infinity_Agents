"""用户结果详情：类别、Review、spotting features 和系统错误。"""
from __future__ import annotations

import json
from pathlib import Path

from PySide6.QtCore import Qt
from PySide6.QtGui import QPixmap
from PySide6.QtWidgets import (
    QDialog,
    QHBoxLayout,
    QLabel,
    QPlainTextEdit,
    QScrollArea,
    QVBoxLayout,
    QWidget,
)


def _image_label(path: str, title: str) -> QWidget:
    box = QWidget()
    layout = QVBoxLayout(box)
    label_title = QLabel(title)
    label_title.setAlignment(Qt.AlignCenter)
    label_title.setStyleSheet("font-weight: bold;")
    image = QLabel()
    image.setAlignment(Qt.AlignCenter)
    image.setMinimumSize(240, 240)
    try:
        pixmap = QPixmap(path)
        if not pixmap.isNull():
            image.setPixmap(
                pixmap.scaled(320, 320, Qt.KeepAspectRatio, Qt.SmoothTransformation)
            )
        else:
            image.setText("无法加载图片")
    except Exception:
        image.setText("无法加载图片")
    layout.addWidget(label_title)
    layout.addWidget(image)
    return box


class ResultDetailDialog(QDialog):
    def __init__(self, repo, item_id: int, reference_path: str, parent=None):
        super().__init__(parent)
        self.setWindowTitle("判断结果详情")
        self.resize(900, 680)

        item = repo.get_item(item_id)
        result = repo.get_result_for_item(item_id)
        root = QVBoxLayout(self)

        images = QHBoxLayout()
        images.addWidget(_image_label(reference_path, "参考图 REFERENCE"))
        images.addWidget(_image_label(item.path if item else "", "目标图 TARGET"))
        root.addLayout(images)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        body = QWidget()
        body_layout = QVBoxLayout(body)

        if item is not None:
            body_layout.addWidget(QLabel(f"图片 ID：{item.id}"))
            if item.error_code:
                err = QLabel(f"错误：{item.error_code}\n{item.error_message}")
                err.setWordWrap(True)
                err.setStyleSheet("color: #cf222e;")
                body_layout.addWidget(err)

        if result is not None:
            detail = _detail(result.detail_json)
            category = result.predicted_category
            summary = result.reasoning_summary
            needs_review = bool(
                result.needs_human_review
                or result.result_status in {"REVIEW", "UNKNOWN"}
            )
            classification_text = f"预测类别：{category}"
            if needs_review:
                classification_text += "\n状态：需 Review"
            classification_label = QLabel(classification_text)
            classification_label.setStyleSheet("font-size: 15px; font-weight: bold;")
            body_layout.addWidget(classification_label)

            if needs_review:
                body_layout.addWidget(QLabel("需要人工复核：是"))

            reasoning = QLabel(f"Reasoning 摘要：{summary}")
            reasoning.setWordWrap(True)
            body_layout.addWidget(reasoning)

            review_reasons = _review_reasons(result, detail)
            if review_reasons:
                review_label = QLabel("复核原因：" + "；".join(review_reasons))
                review_label.setWordWrap(True)
                review_label.setStyleSheet("color: #9a6700;")
                body_layout.addWidget(review_label)

            body_layout.addWidget(QLabel("Spotting features："))
            features_view = QPlainTextEdit()
            features_view.setReadOnly(True)
            features_view.setFixedHeight(190)
            features_view.setPlainText(_format_spotting_features(detail))
            body_layout.addWidget(features_view)
        else:
            body_layout.addWidget(QLabel("该项尚无成功结果。"))

        scroll.setWidget(body)
        root.addWidget(scroll)


def _detail(raw: str) -> dict:
    try:
        value = json.loads(raw or "{}")
        return value if isinstance(value, dict) else {}
    except (TypeError, ValueError):
        return {}


def _review_reasons(result, detail: dict) -> list[str]:
    try:
        reasons = json.loads(result.review_reasons_json or "[]")
        if isinstance(reasons, list):
            return [str(reason) for reason in reasons]
    except (TypeError, ValueError):
        pass
    review = detail.get("review") or {}
    reasons = review.get("reasons", []) if isinstance(review, dict) else []
    return [str(reason) for reason in reasons] if isinstance(reasons, list) else []


def _format_spotting_features(detail: dict) -> str:
    features = detail.get("spotting_features", [])
    if not isinstance(features, list):
        features = []
    lines = []
    for feature in features:
        state = feature.get("state") or feature.get("result", "")
        name = feature.get("feature_id") or feature.get("name", "")
        evidence = feature.get("evidence", "")
        supports = feature.get("supports") or []
        contradicts = feature.get("contradicts") or []
        support_text = "、".join(str(value) for value in supports) if supports else "无"
        contradict_text = "、".join(str(value) for value in contradicts) if contradicts else "无"
        lines.append(
            f"[{state}] {name}\n"
            f"    证据：{evidence}\n"
            f"    支持类别：{support_text}\n"
            f"    矛盾类别：{contradict_text}"
        )
    return "\n".join(lines) or "没有记录可见特征。"
