import os
from dataclasses import dataclass

from dotenv import load_dotenv


load_dotenv()


@dataclass(frozen=True)
class Settings:
    database_url: str
    db_pool_min_size: int
    db_pool_max_size: int
    db_pool_timeout: float
    oidc_issuer: str
    oidc_audience: str
    oidc_jwks_url: str
    oidc_jwks_ttl_seconds: int


def _require_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"{name} is not set")
    return value


_oidc_issuer = os.getenv("OIDC_ISSUER", "https://auth.zhangyvjing.com").rstrip("/")

settings = Settings(
    database_url=_require_env("DATABASE_URL"),
    db_pool_min_size=int(os.getenv("DB_POOL_MIN_SIZE", "1")),
    db_pool_max_size=int(os.getenv("DB_POOL_MAX_SIZE", "10")),
    db_pool_timeout=float(os.getenv("DB_POOL_TIMEOUT", "10")),
    oidc_issuer=_oidc_issuer,
    oidc_audience=os.getenv("OIDC_AUDIENCE", "infinity-agents"),
    oidc_jwks_url=os.getenv("OIDC_JWKS_URL", f"{_oidc_issuer}/.well-known/jwks.json"),
    oidc_jwks_ttl_seconds=max(60, int(os.getenv("OIDC_JWKS_TTL_SECONDS", "3600"))),
)
