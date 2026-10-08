import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .database import Base, SessionLocal, engine, migrate
from .routers import auth, meetings, users
from .schemas import HealthOut
from .seed import run_startup_seed

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    if settings.livekit_is_placeholder:
        log.warning(
            "LIVEKIT_URL / LIVEKIT_API_KEY are placeholders: meetings can be created and "
            "joined, but nobody will connect to audio or video. Set them in .env."
        )
    Base.metadata.create_all(bind=engine)
    migrate(engine)
    with SessionLocal() as db:
        run_startup_seed(db)
    yield


app = FastAPI(title="Zoom Clone API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

api = APIRouter(prefix="/api")


@api.get("/health", response_model=HealthOut, tags=["health"])
def health() -> HealthOut:
    return HealthOut(status="ok")


api.include_router(auth.router)
api.include_router(users.router)
api.include_router(meetings.router)
app.include_router(api)
