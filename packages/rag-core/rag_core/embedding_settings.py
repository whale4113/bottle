"""User-scoped embedding configuration and request/worker context."""
from __future__ import annotations

import hashlib
import json
import math
import os
import sqlite3
import urllib.parse
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import asdict, dataclass, field
from functools import wraps
from pathlib import Path


@dataclass(frozen=True)
class EmbeddingConfig:
    provider: str = "local"
    model: str = "Qwen/Qwen3-Embedding-0.6B"
    base_url: str = "https://api.openai.com/v1"
    api_key: str = field(default="", repr=False)
    dimensions: int | None = None
    timeout: float = 60

    def validate(self) -> None:
        if self.provider not in {"local", "openai", "voyage"}:
            raise ValueError("Embedding provider must be local, openai, or voyage.")
        if not self.model.strip() or len(self.model) > 512:
            raise ValueError("An embedding model name is required (at most 512 characters).")
        if not math.isfinite(self.timeout) or not 0 < self.timeout <= 300:
            raise ValueError("Timeout must be greater than 0 and at most 300 seconds.")
        if self.dimensions is not None and (type(self.dimensions) is not int or not 1 <= self.dimensions <= 65536):
            raise ValueError("Dimensions must be an integer between 1 and 65536.")
        if self.provider == "openai":
            parsed = urllib.parse.urlsplit(self.base_url)
            if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
                raise ValueError("Base URL must be an HTTP(S) URL without credentials, query, or fragment.")
            if parsed.path.endswith("/embeddings"):
                raise ValueError("Use the API base URL, for example https://api.openai.com/v1, without /embeddings.")
            if parsed.hostname == "api.openai.com" and not self.api_key:
                raise ValueError("An API key is required for api.openai.com.")
        if any(character in self.api_key for character in "\r\n"):
            raise ValueError("The API key must not contain line breaks.")

    @property
    def space(self) -> str:
        if self.provider != "openai":
            return ""  # Existing local/Voyage rows already carry provider + model.
        identity = json.dumps([self.base_url.rstrip("/"), self.model, self.dimensions])
        return hashlib.sha256(identity.encode()).hexdigest()

    @property
    def identity(self) -> tuple:
        return (self.provider, self.model, self.space)

    def public(self) -> dict:
        return {"provider": self.provider, "model": self.model, "base_url": self.base_url,
                "dimensions": self.dimensions, "timeout": self.timeout, "has_api_key": bool(self.api_key)}

    @classmethod
    def from_env(cls) -> EmbeddingConfig:
        provider = os.environ.get("EMBEDDING_PROVIDER", "local").strip().lower() or "local"
        model = {"local": os.environ.get("LOCAL_EMBEDDING_MODEL", "Qwen/Qwen3-Embedding-0.6B"),
                 "openai": os.environ.get("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small"),
                 "voyage": os.environ.get("VOYAGE_EMBEDDING_MODEL", "voyage-4-lite")}.get(provider, "")
        raw = os.environ.get("OPENAI_EMBEDDING_DIMENSIONS", "").strip() if provider == "openai" else ""
        try:
            dimensions = int(raw) if raw else None
            timeout = float(os.environ.get("EMBEDDING_TIMEOUT_SECONDS", "60"))
        except ValueError:
            raise ValueError("Embedding dimensions and timeout must be valid numbers.") from None
        return cls(provider, model.strip(), os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").strip().rstrip("/"),
                   (os.environ.get("VOYAGE_API_KEY" if provider == "voyage" else "OPENAI_API_KEY", "").strip() if provider != "local" else ""), dimensions, timeout)


_current: ContextVar[EmbeddingConfig | None] = ContextVar("embedding_config", default=None)


def current_config() -> EmbeddingConfig:
    return _current.get() or EmbeddingConfig.from_env()


@contextmanager
def use_config(config: EmbeddingConfig):
    token = _current.set(config)
    try:
        yield
    finally:
        _current.reset(token)


def user_embedding_config(method):
    @wraps(method)
    def wrapped(self, user_id, *args, **kwargs):
        with use_config(self.embedding_settings.get(user_id)):
            return method(self, user_id, *args, **kwargs)
    return wrapped


class EmbeddingSettingsStore:
    def __init__(self, path: Path):
        self.path = path
        with sqlite3.connect(path) as connection:
            connection.execute("create table if not exists embedding_settings (user_id text primary key, config_json text not null)")
        path.chmod(0o600)

    def get(self, user_id: str) -> EmbeddingConfig:
        with sqlite3.connect(self.path) as connection:
            row = connection.execute("select config_json from embedding_settings where user_id = ?", (user_id,)).fetchone()
        return EmbeddingConfig(**json.loads(row[0])) if row else EmbeddingConfig.from_env()

    def candidate(self, user_id: str, values: dict) -> EmbeddingConfig:
        previous = self.get(user_id)
        provider = values["provider"]
        base_url = values.get("base_url", "https://api.openai.com/v1").strip().rstrip("/")
        key = values.get("api_key")
        if key is None:
            # Never forward a saved credential to a newly configured endpoint.
            key = previous.api_key if previous.provider == provider and previous.base_url == base_url else ""
        config = EmbeddingConfig(provider=provider, model=values["model"].strip(), base_url=base_url,
                                 api_key=key.strip() if provider == "openai" else "",
                                 dimensions=values.get("dimensions") if provider == "openai" else None,
                                 timeout=values.get("timeout", 60))
        config.validate()
        return config

    def save(self, user_id: str, config: EmbeddingConfig) -> None:
        config.validate()
        with sqlite3.connect(self.path) as connection:
            connection.execute("insert into embedding_settings (user_id, config_json) values (?, ?) on conflict(user_id) do update set config_json = excluded.config_json",
                               (user_id, json.dumps(asdict(config))))
