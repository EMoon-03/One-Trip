"""Authentication plumbing: password hashing, JWTs, current-user dependency.

Design notes worth knowing at interview time:
  * Passwords are stored only as bcrypt hashes (salted, slow by design).
  * The JWT carries just the user id ("sub") and an expiry. It's SIGNED, not
    encrypted — anyone can read it, nobody can forge it without SECRET_KEY.
  * get_current_user is the whole authentication story: every protected
    endpoint simply declares it as a dependency.

Authorization (who owns what) lives next to the data: see get_owned_trip
in routers/trips.py.
"""

import os
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from fastapi import Depends, HTTPException
from fastapi.security import OAuth2PasswordBearer
from sqlmodel import Session

from .database import get_session
from .models import User

# Dev fallback so the app boots with zero config. In production set SECRET_KEY
# to a long random value (e.g. `openssl rand -hex 32`) — anyone who knows it
# can mint valid tokens.
SECRET_KEY = os.getenv("SECRET_KEY", "dev-secret-change-me")
ALGORITHM = "HS256"
ACCESS_TOKEN_DAYS = 7

# tokenUrl only tells the /docs "Authorize" button where to log in.
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, hashed: str) -> bool:
    return bcrypt.checkpw(password.encode(), hashed.encode())


def create_access_token(user_id: int) -> str:
    payload = {
        "sub": str(user_id),  # JWT spec: sub must be a string
        "exp": datetime.now(timezone.utc) + timedelta(days=ACCESS_TOKEN_DAYS),
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def get_current_user(
    token: str = Depends(oauth2_scheme),
    session: Session = Depends(get_session),
) -> User:
    credentials_error = HTTPException(
        status_code=401,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id = int(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError):
        raise credentials_error

    user = session.get(User, user_id)
    if user is None:
        raise credentials_error
    return user
