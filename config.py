"""Korea Investment Open API configuration and token management."""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv


BASE_URL = "https://openapivts.koreainvestment.com:29443"
TOKEN_PATH = "/oauth2/tokenP"
TOKEN_EXPIRY_BUFFER_SECONDS = 300
REQUEST_TIMEOUT_SECONDS = 10
MODULE_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = MODULE_DIR.parent
ENV_PATHS = (PROJECT_ROOT / ".env", MODULE_DIR / ".env")


class KISAuthError(RuntimeError):
    """Raised when KIS authentication cannot be completed."""


@dataclass(frozen=True)
class KISCredentials:
    app_key: str
    app_secret: str


class KISTokenManager:
    """Issues and caches a KIS OAuth access token for the current process."""

    def __init__(
        self,
        credentials: KISCredentials,
        base_url: str = BASE_URL,
        session: requests.Session | None = None,
    ) -> None:
        self.credentials = credentials
        self.base_url = base_url.rstrip("/")
        self.session = session or requests.Session()
        self._access_token: str | None = None
        self._expires_at_monotonic = 0.0

    def get_access_token(self) -> str:
        if self._access_token and time.monotonic() < self._expires_at_monotonic:
            return self._access_token

        token_data = self._issue_token()
        access_token = token_data.get("access_token")
        if not access_token:
            raise KISAuthError(f"Token response did not include access_token: {token_data}")

        expires_in = _to_int(token_data.get("expires_in"), default=86400)
        self._access_token = access_token
        self._expires_at_monotonic = time.monotonic() + max(
            expires_in - TOKEN_EXPIRY_BUFFER_SECONDS,
            60,
        )
        return self._access_token

    def auth_headers(self, tr_id: str) -> dict[str, str]:
        return {
            "content-type": "application/json; charset=utf-8",
            "authorization": f"Bearer {self.get_access_token()}",
            "appkey": self.credentials.app_key,
            "appsecret": self.credentials.app_secret,
            "tr_id": tr_id,
            "custtype": "P",
        }

    def _issue_token(self) -> dict[str, Any]:
        url = f"{self.base_url}{TOKEN_PATH}"
        payload = {
            "grant_type": "client_credentials",
            "appkey": self.credentials.app_key,
            "appsecret": self.credentials.app_secret,
        }
        headers = {"content-type": "application/json; charset=utf-8"}

        try:
            response = self.session.post(
                url,
                headers=headers,
                json=payload,
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
        except requests.RequestException as exc:
            raise KISAuthError(f"Failed to issue KIS access token: {exc}") from exc

        try:
            data = response.json()
        except ValueError as exc:
            raise KISAuthError(f"Token response was not valid JSON: {response.text}") from exc

        if data.get("rt_cd") not in (None, "0"):
            message = data.get("msg1") or data.get("msg_cd") or data
            raise KISAuthError(f"KIS token issuance failed: {message}")

        return data


def load_credentials() -> KISCredentials:
    loaded_env = False
    for env_path in ENV_PATHS:
        if env_path.exists():
            load_dotenv(env_path, override=True)
            loaded_env = True

    if not loaded_env:
        load_dotenv()

    app_key = os.getenv("APP_KEY")
    app_secret = os.getenv("APP_SECRET")

    missing = [name for name, value in {"APP_KEY": app_key, "APP_SECRET": app_secret}.items() if not value]
    if missing:
        raise KISAuthError(f"Missing required environment variables: {', '.join(missing)}")

    return KISCredentials(app_key=app_key or "", app_secret=app_secret or "")


def create_token_manager() -> KISTokenManager:
    return KISTokenManager(load_credentials())


def _to_int(value: Any, default: int) -> int:
    try:
        return int(float(str(value).replace(",", "").strip()))
    except (TypeError, ValueError):
        return default
