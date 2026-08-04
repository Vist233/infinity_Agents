import httpx
import pytest

from imagejudge import config
from imagejudge.model.worker_gateway import WorkerGateway
from imagejudge.model.schemas import GatewayError


def test_worker_gateway_preserves_non_retryable_platform_configuration_error():
    gateway = WorkerGateway(object(), client=httpx.AsyncClient())
    response = httpx.Response(
        503,
        json={
            "error": {
                "code": config.ERR_PLATFORM_MODEL_NOT_CONFIGURED,
                "message": "The platform model is not configured",
                "retryable": False,
                "request_id": "srv_test",
            }
        },
        request=httpx.Request("POST", "https://example.test/image-judge/api/v1/evaluate"),
    )
    try:
        with pytest.raises(GatewayError) as exc_info:
            gateway._interpret(response, 12)
    finally:
        import asyncio

        asyncio.run(gateway.aclose())

    error = exc_info.value
    assert error.code == config.ERR_PLATFORM_MODEL_NOT_CONFIGURED
    assert error.message == "The platform model is not configured"
    assert error.retryable is False
    assert error.request_id == "srv_test"
