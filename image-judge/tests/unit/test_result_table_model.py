from imagejudge.core.state_machine import ItemStatus
from imagejudge.ui.result_table_model import RowData, _status_display


def test_successful_classification_is_hidden_from_status_column():
    row = RowData(1, "target.png")
    row.item_status = ItemStatus.SUCCEEDED.value
    row.classification_status = "CLASSIFIED"

    assert _status_display(row) == ""


def test_review_is_separate_and_failed_status_stays_visible():
    row = RowData(1, "target.png")
    row.item_status = ItemStatus.SUCCEEDED.value
    row.classification_status = "CLASSIFIED"
    row.review = True
    assert _status_display(row) == ""

    row.review = False
    row.item_status = ItemStatus.FAILED.value
    assert _status_display(row) == "失败"
