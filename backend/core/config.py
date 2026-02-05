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


def _require_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"{name} is not set")
    return value


settings = Settings(
    database_url=_require_env("DATABASE_URL"),
    db_pool_min_size=int(os.getenv("DB_POOL_MIN_SIZE", "1")),
    db_pool_max_size=int(os.getenv("DB_POOL_MAX_SIZE", "10")),
    db_pool_timeout=float(os.getenv("DB_POOL_TIMEOUT", "10")),
)
