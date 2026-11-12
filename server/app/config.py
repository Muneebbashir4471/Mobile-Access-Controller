from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """All settings come from MT5_* environment variables (or server/.env)."""

    model_config = SettingsConfigDict(env_prefix="MT5_", env_file=".env", extra="ignore")

    database_url: str = "postgresql+asyncpg://mt5:mt5@db:5432/mt5"
    redis_url: str = "redis://cache:6379/0"

    # Public origin of the dashboard, used for the WebSocket Origin check and QR payloads.
    public_url: str = "https://phones.example.com"
    extra_allowed_origins: list[str] = []

    # coturn use-auth-secret mode
    turn_secret: str = "change-me"
    turn_urls: list[str] = [
        "turn:turn.example.com:3478?transport=udp",
        "turn:turn.example.com:3478?transport=tcp",
        "turns:turn.example.com:5349?transport=tcp",
    ]
    turn_ttl_seconds: int = 600

    # Auth
    cookie_secure: bool = True
    session_idle_seconds: int = 1800
    session_max_seconds: int = 12 * 3600
    login_max_failures: int = 5
    login_lockout_seconds: int = 900
    login_rate_per_minute: int = 20
    pairing_rate_per_minute: int = 10

    # Devices and sessions
    pairing_code_ttl_seconds: int = 600
    lock_ttl_seconds: int = 300
    heartbeat_seconds: int = 60
    presence_ttl_seconds: int = 90
    offline_alert_seconds: int = 180
    low_battery_percent: int = 20
    # 30 fps keeps input-to-screen delay low; the cap only matters while the screen changes a lot.
    default_video: dict = {"width": 720, "fps": 30, "bitrate": 1_500_000}

    # Agent APK releases (a Docker volume in production)
    apk_dir: str = "/data/apk"
    max_apk_bytes: int = 200 * 1024 * 1024

    # Alerts (optional)
    telegram_bot_token: str | None = None
    telegram_chat_id: str | None = None

    # Background loops
    sweep_interval_seconds: float = 5.0

    @property
    def allowed_origins(self) -> set[str]:
        return {self.public_url.rstrip("/"), *(o.rstrip("/") for o in self.extra_allowed_origins)}


@lru_cache
def get_settings() -> Settings:
    return Settings()
