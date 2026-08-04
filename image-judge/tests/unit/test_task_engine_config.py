from imagejudge import config
from imagejudge.core.task_engine import TaskEngine


def test_task_engine_accepts_mode_specific_concurrency():
    platform_engine = TaskEngine(
        None,
        None,
        run_id=1,
        reference_path="",
        criteria_text="",
        concurrency=config.PLATFORM_CONCURRENCY,
    )
    byok_engine = TaskEngine(
        None,
        None,
        run_id=1,
        reference_path="",
        criteria_text="",
        concurrency=config.DEFAULT_BYOK_CONCURRENCY,
    )

    assert platform_engine._concurrency == 1
    assert byok_engine._concurrency == 5
