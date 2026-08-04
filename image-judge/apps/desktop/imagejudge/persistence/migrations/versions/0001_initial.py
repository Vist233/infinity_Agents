"""初始迁移：创建当前 2.0 分类输出的全部核心表。

Revision ID: 0001
Revises:
Create Date: 2026-08-04
"""
from alembic import op

from imagejudge.persistence.models import Base

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    Base.metadata.create_all(bind=bind)


def downgrade() -> None:
    bind = op.get_bind()
    Base.metadata.drop_all(bind=bind)
