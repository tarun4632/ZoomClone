from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


_PLACEHOLDER_LIVEKIT_URL = "wss://example.livekit.cloud"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    DATABASE_URL: str = "sqlite:///./zoom.db"
    # Safe dummy defaults: tokens can still be minted, and tests/startup work without real keys.
    LIVEKIT_URL: str = _PLACEHOLDER_LIVEKIT_URL
    LIVEKIT_API_KEY: str = "devkey"
    LIVEKIT_API_SECRET: str = "devsecret-devsecret-devsecret-devsecret"
    # Comma-separated list for CORS. The first entry is used to build invite links.
    CLIENT_ORIGIN: str = "http://localhost:3000"

    @property
    def cors_origins(self) -> list[str]:
        return [o.strip().rstrip("/") for o in self.CLIENT_ORIGIN.split(",") if o.strip()]

    @property
    def livekit_is_placeholder(self) -> bool:
        """True when no real LiveKit project is configured: joins succeed, calls can't connect."""
        return self.LIVEKIT_URL == _PLACEHOLDER_LIVEKIT_URL or self.LIVEKIT_API_KEY == "devkey"

    @property
    def public_origin(self) -> str:
        origins = self.cors_origins
        return origins[0] if origins else "http://localhost:3000"


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
