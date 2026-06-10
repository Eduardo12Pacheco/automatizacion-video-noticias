from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware


DEFAULT_CORS_ALLOW_ORIGIN_REGEX = r"https://.*\.pages\.dev|http://localhost:\d+"


def add_cors_middleware(
    app: FastAPI,
    allowed_origins: list[str] | None = None,
    allow_origin_regex: str | None = DEFAULT_CORS_ALLOW_ORIGIN_REGEX,
) -> None:
    """Add CORS middleware to FastAPI app."""
    origins = allowed_origins or [
        "https://panel.example.local",
        "http://localhost:5500",
        "http://localhost:3000",
    ]

    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_origin_regex=allow_origin_regex,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=[
            "content-disposition",
            "content-length",
            "content-type",
            "content-range",
            "accept-ranges",
        ],
    )
