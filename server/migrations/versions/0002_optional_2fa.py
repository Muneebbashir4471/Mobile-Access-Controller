"""two-factor login becomes opt-in per user

Revision ID: 0002
Revises: 0001
"""
import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("users") as b:
        b.add_column(sa.Column("totp_enabled", sa.Boolean(), server_default=sa.false(), nullable=False))
        b.alter_column("totp_secret", existing_type=sa.String(64), nullable=True)


def downgrade() -> None:
    with op.batch_alter_table("users") as b:
        b.alter_column("totp_secret", existing_type=sa.String(64), nullable=False)
        b.drop_column("totp_enabled")
