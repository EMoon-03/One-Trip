"""Register / login / me.

Login accepts standard OAuth2 form fields (username = email) so the
"Authorize" button on /docs works out of the box. Both register and login
return the same TokenResponse, so the frontend has one code path.
"""

from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import OAuth2PasswordRequestForm
from sqlmodel import Session, select

from ..auth import create_access_token, get_current_user, hash_password, verify_password
from ..database import get_session
from ..models import TokenResponse, User, UserCreate, UserRead

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _token_response(user: User) -> TokenResponse:
    return TokenResponse(
        access_token=create_access_token(user.id),  # type: ignore[arg-type]
        user=UserRead.model_validate(user),
    )


@router.post("/register", response_model=TokenResponse, status_code=201)
def register(payload: UserCreate, session: Session = Depends(get_session)):
    exists = session.exec(select(User).where(User.email == payload.email)).first()
    if exists:
        raise HTTPException(status_code=400, detail="Email already registered")

    user = User(
        email=payload.email,
        display_name=payload.display_name,
        hashed_password=hash_password(payload.password),
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return _token_response(user)


@router.post("/login", response_model=TokenResponse)
def login(
    form: OAuth2PasswordRequestForm = Depends(),
    session: Session = Depends(get_session),
):
    user = session.exec(select(User).where(User.email == form.username)).first()
    # One error for both cases — don't reveal whether the email exists.
    if not user or not verify_password(form.password, user.hashed_password):
        raise HTTPException(
            status_code=401,
            detail="Incorrect email or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return _token_response(user)


@router.get("/me", response_model=UserRead)
def me(user: User = Depends(get_current_user)):
    return user
