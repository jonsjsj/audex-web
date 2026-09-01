"""Credential encryption + session-cookie signing. The ABS token audex-web holds
server-side on your behalf (see the plan §6: "no tokens in the browser") is
Fernet-encrypted at rest with a key derived from SECRET_KEY via HKDF — a stolen
database backup doesn't hand over a live ABS session on its own.
"""
import base64
import secrets

from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from app.core.config import settings


def _fernet_key() -> bytes:
    hkdf = HKDF(algorithm=hashes.SHA256(), length=32, salt=None,
                info=b"audexweb-credential-encryption-v1")
    return base64.urlsafe_b64encode(hkdf.derive(settings.SECRET_KEY.encode()))


def encrypt_value(value: str) -> str:
    return Fernet(_fernet_key()).encrypt(value.encode()).decode()


def decrypt_value(token: str) -> str:
    try:
        return Fernet(_fernet_key()).decrypt(token.encode()).decode()
    except Exception:
        return ""


def new_session_id() -> str:
    """An opaque, unguessable session identifier — the ONLY thing that reaches the
    browser (as an httpOnly cookie value). It points at a server-side row; no user
    data or token is ever encoded in the cookie itself."""
    return secrets.token_urlsafe(32)
