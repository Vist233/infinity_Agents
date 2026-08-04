"""用户结果表：只显示分类结果、Review、Reasoning 和错误信息。"""
from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import QAbstractTableModel, QModelIndex, Qt

from ..core.state_machine import ItemStatus

COLUMNS = [
    ("图片ID", "image_id"),
    ("预测类别", "category"),
    ("状态", "classification_status"),
    ("需Review", "review"),
    ("Reasoning摘要", "reasoning"),
    ("错误类型", "error_code"),
    ("错误说明", "error_message"),
]

_ITEM_STATUS_TEXT = {
    ItemStatus.PENDING.value: "等待",
    ItemStatus.PROCESSING.value: "处理中",
    ItemStatus.RETRY_WAIT.value: "重试等待",
    ItemStatus.FAILED.value: "失败",
    ItemStatus.SKIPPED.value: "跳过",
    ItemStatus.CANCELLED.value: "已取消",
}

_STATUS_COLOR = {
    "需 Review": "#9a6700",
    "失败": "#cf222e",
    ItemStatus.PENDING.value: "#666666",
    ItemStatus.PROCESSING.value: "#0969da",
    ItemStatus.RETRY_WAIT.value: "#9a6700",
    ItemStatus.SKIPPED.value: "#666666",
    ItemStatus.CANCELLED.value: "#666666",
}


def _status_display(row: "RowData") -> str:
    """Return the compact status shown to the user.

    A successful classification is represented by the completed item state and
    intentionally leaves this column blank.  Review is shown in the dedicated
    ``需Review`` column; failed rows remain visible here so the table acts as an
    exception list instead of a second progress indicator.
    """

    if row.item_status == ItemStatus.FAILED.value:
        return "失败"
    if row.review or row.classification_status in {"REVIEW", "UNKNOWN"}:
        return ""
    if row.classification_status == "CLASSIFIED" or row.item_status == ItemStatus.SUCCEEDED.value:
        return ""
    return _ITEM_STATUS_TEXT.get(row.item_status, row.item_status)


class RowData:
    __slots__ = (
        "item_id",
        "relative_path",
        "item_status",
        "category",
        "classification_status",
        "review",
        "reasoning",
        "error_code",
        "error_message",
    )

    def __init__(self, item_id: int, relative_path: str):
        self.item_id = item_id
        self.relative_path = relative_path
        self.item_status = ""
        self.category = ""
        self.classification_status = ""
        self.review = False
        self.reasoning = ""
        self.error_code = ""
        self.error_message = ""


class ResultTableModel(QAbstractTableModel):
    def __init__(self, parent=None):
        super().__init__(parent)
        self._rows: list[RowData] = []
        self._index_by_item: dict[int, int] = {}

    def load_from_repo(self, repo, run_id: int) -> None:
        self.beginResetModel()
        self._rows = []
        self._index_by_item = {}
        for entry in repo.list_items_with_results(run_id):
            item = entry["item"]
            result = entry["result"]
            row = RowData(item.id, item.relative_path or Path(item.path).name)
            row.item_status = item.status
            row.error_code = item.error_code
            row.error_message = item.error_message
            if result is not None:
                row.category = result.predicted_category
                row.classification_status = result.result_status
                row.review = bool(
                    result.needs_human_review
                    or result.result_status in {"REVIEW", "UNKNOWN"}
                )
                row.reasoning = result.reasoning_summary
            if not row.classification_status and row.item_status == ItemStatus.FAILED.value:
                row.classification_status = row.item_status
            self._index_by_item[item.id] = len(self._rows)
            self._rows.append(row)
        self.endResetModel()

    def update_item(self, item_id: int, payload: dict) -> None:
        idx = self._index_by_item.get(item_id)
        if idx is None:
            return
        row = self._rows[idx]
        if "status" in payload:
            row.item_status = payload["status"]
        if "predicted_category" in payload:
            row.category = payload["predicted_category"]
        if "result_status" in payload:
            row.classification_status = payload["result_status"]
            if row.classification_status in {"REVIEW", "UNKNOWN"}:
                row.review = True
        if "reasoning_summary" in payload:
            row.reasoning = payload["reasoning_summary"]
        if "needs_human_review" in payload:
            row.review = bool(payload["needs_human_review"]) or row.classification_status in {
                "REVIEW",
                "UNKNOWN",
            }
        if "error_code" in payload:
            row.error_code = payload["error_code"]
        if "error_message" in payload:
            row.error_message = payload["error_message"]
        self.dataChanged.emit(self.index(idx, 0), self.index(idx, len(COLUMNS) - 1))

    def item_id_at(self, row: int) -> int | None:
        if 0 <= row < len(self._rows):
            return self._rows[row].item_id
        return None

    def rowCount(self, parent=QModelIndex()):  # noqa: N802
        return 0 if parent.isValid() else len(self._rows)

    def columnCount(self, parent=QModelIndex()):  # noqa: N802
        return 0 if parent.isValid() else len(COLUMNS)

    def headerData(self, section, orientation, role=Qt.DisplayRole):  # noqa: N802
        if role == Qt.DisplayRole and orientation == Qt.Horizontal:
            if 0 <= section < len(COLUMNS):
                return COLUMNS[section][0]
        return None

    def data(self, index: QModelIndex, role=Qt.DisplayRole):
        if not index.isValid():
            return None
        row = self._rows[index.row()]
        key = COLUMNS[index.column()][1]
        if role == Qt.DisplayRole:
            if key == "image_id":
                return str(row.item_id)
            if key == "category":
                return row.category
            if key == "classification_status":
                return _status_display(row)
            if key == "review":
                return "需 Review" if row.review else ""
            if key == "reasoning":
                return row.reasoning
            if key == "error_code":
                return row.error_code
            if key == "error_message":
                return row.error_message
        elif role == Qt.ForegroundRole:
            from PySide6.QtGui import QColor

            color = _STATUS_COLOR.get(_status_display(row))
            if color and key == "classification_status":
                return QColor(color)
            if row.error_code and key in {"error_code", "error_message"}:
                return QColor("#cf222e")
        elif role == Qt.ToolTipRole:
            return row.relative_path
        return None
