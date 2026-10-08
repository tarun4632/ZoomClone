from collections.abc import Iterator
from pathlib import Path

from sqlalchemy import Engine, create_engine, event, inspect, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import settings


class Base(DeclarativeBase):
    pass


def _make_engine(url: str) -> Engine:
    parsed = make_url(url)
    connect_args: dict = {}
    if parsed.get_backend_name() == "sqlite":
        connect_args["check_same_thread"] = False
        # Make sure the folder for the SQLite file exists (e.g. a Railway volume path).
        if parsed.database and parsed.database != ":memory:":
            Path(parsed.database).expanduser().resolve().parent.mkdir(parents=True, exist_ok=True)
    eng = create_engine(url, connect_args=connect_args)

    if eng.dialect.name == "sqlite":

        @event.listens_for(eng, "connect")
        def _sqlite_pragmas(dbapi_connection, _record) -> None:  # noqa: ANN001
            cursor = dbapi_connection.cursor()
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.execute("PRAGMA busy_timeout=5000")
            cursor.close()

    return eng


engine = _make_engine(settings.DATABASE_URL)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


# create_all() never adds columns to existing tables. Each entry is added once, if missing,
# so databases created by an older version keep working. (table, column, SQL type)
_ADDED_COLUMNS = [
    ("meeting_participants", "secret_hash", "TEXT"),
]


def migrate(bind: Engine) -> None:
    """Idempotent schema evolution. Run right after Base.metadata.create_all()."""
    insp = inspect(bind)
    with bind.begin() as conn:
        for table, column, sql_type in _ADDED_COLUMNS:
            existing = {c["name"] for c in insp.get_columns(table)}
            if column not in existing:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {sql_type}"))


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
