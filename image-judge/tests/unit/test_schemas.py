"""结构化分类输出 Schema 校验测试。"""
from __future__ import annotations

import copy
import json

import pytest

from imagejudge.model.schemas import (
    EvaluationOutput,
    GatewayError,
    json_schema_dict,
    parse_evaluation_output,
)


def test_valid_output_parses(sample_output_text):
    out = parse_evaluation_output(sample_output_text)
    assert out.task_type == "CLASSIFICATION"
    assert out.predicted_category == "class_02"
    assert out.status == "CLASSIFIED"
    assert out.schema_version == "2.0"
    assert len(out.spotting_features) == 2


def test_code_fence_tolerated(sample_output_text):
    wrapped = "```json\n" + sample_output_text + "\n```"
    out = parse_evaluation_output(wrapped)
    assert out.status == "CLASSIFIED"


def test_invalid_status_rejected(sample_output):
    bad = copy.deepcopy(sample_output)
    bad["status"] = "MAYBE"
    with pytest.raises(Exception):
        parse_evaluation_output(json.dumps(bad))


def test_invalid_feature_state_rejected(sample_output):
    bad = copy.deepcopy(sample_output)
    bad["spotting_features"][0]["state"] = "MAYBE"
    with pytest.raises(Exception):
        parse_evaluation_output(json.dumps(bad))


def test_extra_field_rejected(sample_output):
    bad = copy.deepcopy(sample_output)
    bad["unexpected"] = True
    with pytest.raises(Exception):
        parse_evaluation_output(json.dumps(bad))


def test_missing_required_field_rejected(sample_output):
    bad = copy.deepcopy(sample_output)
    del bad["review"]
    with pytest.raises(Exception):
        parse_evaluation_output(json.dumps(bad))


def test_old_numeric_fields_are_not_accepted(sample_output):
    bad = copy.deepcopy(sample_output)
    bad["confidence"] = 0.9
    with pytest.raises(Exception):
        parse_evaluation_output(json.dumps(bad))


def test_invalid_json_rejected():
    with pytest.raises(Exception):
        parse_evaluation_output("{not json")


def test_json_schema_dict_structure():
    schema = json_schema_dict()
    assert "properties" in schema or "$defs" in schema
    text = json.dumps(schema)
    assert "predicted_category" in text
    assert "spotting_features" in text
    assert "review" in text
    assert "confidence" not in text


def test_gateway_error_fields():
    err = GatewayError("QUOTA_EXCEEDED", "额度已用完", retryable=False, retry_after=3600)
    assert err.code == "QUOTA_EXCEEDED"
    assert err.retryable is False
    assert err.retry_after == 3600


def test_all_classification_statuses_accepted(sample_output):
    for status in ("CLASSIFIED", "UNKNOWN", "REVIEW"):
        data = copy.deepcopy(sample_output)
        data["status"] = status
        out = EvaluationOutput.model_validate(data)
        assert out.status == status
