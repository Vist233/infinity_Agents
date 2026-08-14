"""Contract cases for the Analysis Agent's research-frontdesk behavior."""

from agent.paperAgent import PAPER_AGENT_INSTRUCTIONS


def test_paper_question_is_answered_before_task_collection():
    prompt = PAPER_AGENT_INSTRUCTIONS
    assert "不要先索要 DOI" in prompt
    assert "直接阅读并解释方法" in prompt
    assert "只有会改变科学结论" in prompt


def test_task_tool_is_a_reviewable_draft_not_a_hidden_submission():
    prompt = PAPER_AGENT_INSTRUCTIONS
    assert "只能操作当前会话的草案" in prompt
    assert "create_execution_document" in prompt
    assert "revise_goal_driven_task" in prompt
    assert "不能创建 queued Task、Outbox 或 Redis 消息" in prompt
    assert "等待用户在 To-Do 卡片中确认" in prompt


def test_execution_document_and_dataset_are_first_class_inputs():
    prompt = PAPER_AGENT_INSTRUCTIONS
    assert "生成清晰的 Markdown 执行文档" in prompt
    assert "关联数据集" in prompt
    assert "上传" in prompt
