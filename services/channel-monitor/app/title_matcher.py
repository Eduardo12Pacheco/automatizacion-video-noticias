from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml


TARGET_COUNTRY_ORDER = ("ecuador", "colombia", "argentina", "uruguay", "paraguay", "mexico")
COUNTRY_ALIASES = {
    "ec": "ecuador",
    "ecuador": "ecuador",
    "co": "colombia",
    "colombia": "colombia",
    "ar": "argentina",
    "argentina": "argentina",
    "uy": "uruguay",
    "uruguay": "uruguay",
    "py": "paraguay",
    "paraguay": "paraguay",
    "mx": "mexico",
    "mexico": "mexico",
    "méxico": "mexico",
}


@dataclass(frozen=True)
class ProgramTitleRule:
    op: str
    value: str


@dataclass(frozen=True)
class ProgramTitleMatch:
    op: str
    value: str
    normalized_value: str
    normalized_title: str


@dataclass(frozen=True)
class PlayerTerms:
    name: str
    country: str
    aliases: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class TitleCatalog:
    countries: dict[str, list[str]] = field(default_factory=dict)
    players: list[PlayerTerms] = field(default_factory=list)


@dataclass(frozen=True)
class TitleMatchResult:
    matched: bool
    reasons: list[dict[str, str]]

    def target_countries(self, *, source_country: str | None = None) -> list[str]:
        normalized_source = normalize_country(source_country)
        targets: list[str] = []
        for target_country in TARGET_COUNTRY_ORDER:
            if target_country == normalized_source:
                continue
            if any(reason.get("country") == target_country for reason in self.reasons):
                targets.append(target_country)
        return targets


class TitleMatcher:
    def __init__(self, catalog: TitleCatalog):
        self.catalog = TitleCatalog(
            countries={normalize_country(country): terms for country, terms in catalog.countries.items()},
            players=[
                PlayerTerms(name=player.name, country=normalize_country(player.country), aliases=player.aliases)
                for player in catalog.players
            ],
        )

    def match(self, title: str) -> TitleMatchResult:
        normalized_title = f" {normalize_title(title)} "
        reasons: list[dict[str, str]] = []

        for country in _ordered_catalog_countries(self.catalog):
            terms = self.catalog.countries.get(country, [])
            for term in terms:
                normalized_term = normalize_title(term)
                if _contains_term(normalized_title, normalized_term):
                    reasons.append({"type": "country", "country": country, "term": normalized_term})

            for player in self.catalog.players:
                player_country = normalize_country(player.country)
                if player_country != country:
                    continue
                for alias in player.aliases:
                    normalized_alias = normalize_title(alias)
                    if _contains_term(normalized_title, normalized_alias):
                        reasons.append(
                            {
                                "type": "player",
                                "country": player_country,
                                "player": player.name,
                                "term": normalized_alias,
                            }
                        )

        return TitleMatchResult(matched=bool(reasons), reasons=reasons)


def load_title_catalog(path: Path | str) -> TitleCatalog:
    raw = yaml.safe_load(Path(path).read_text(encoding="utf-8")) or {}
    countries = {
        normalize_country(country.get("code")): [str(term) for term in country.get("terms", [])]
        for country in raw.get("countries", [])
        if normalize_country(country.get("code"))
    }
    players = [
        PlayerTerms(
            name=str(player.get("name", "")).strip(),
            country=normalize_country(player.get("country")),
            aliases=[str(alias) for alias in player.get("aliases", [])],
        )
        for player in raw.get("players", [])
        if str(player.get("name", "")).strip()
    ]
    return TitleCatalog(countries=countries, players=players)


def normalize_title(value: Any) -> str:
    decomposed = unicodedata.normalize("NFKD", str(value))
    ascii_text = "".join(character for character in decomposed if not unicodedata.combining(character))
    lowered = ascii_text.casefold()
    words_only = re.sub(r"[^a-z0-9]+", " ", lowered)
    return re.sub(r"\s+", " ", words_only).strip()


def normalize_country(value: Any) -> str:
    normalized = normalize_title(value)
    return COUNTRY_ALIASES.get(normalized, normalized)


def match_program_title(title: str, rule: Any) -> ProgramTitleMatch | None:
    op = str(getattr(rule, "op", "")).strip()
    value = str(getattr(rule, "value", "")).strip()
    normalized_title = normalize_title(title)
    normalized_value = normalize_title(value)
    if not normalized_value:
        return None
    if op == "starts_with" and normalized_title.startswith(normalized_value):
        return ProgramTitleMatch(op=op, value=value, normalized_value=normalized_value, normalized_title=normalized_title)
    if op == "contains" and _contains_term(f" {normalized_title} ", normalized_value):
        return ProgramTitleMatch(op=op, value=value, normalized_value=normalized_value, normalized_title=normalized_title)
    return None


def _ordered_catalog_countries(catalog: TitleCatalog) -> list[str]:
    ordered = [country for country in TARGET_COUNTRY_ORDER if country in catalog.countries]
    extra = [country for country in catalog.countries if country not in ordered]
    return ordered + extra


def _contains_term(normalized_title: str, normalized_term: str) -> bool:
    return bool(normalized_term) and f" {normalized_term} " in normalized_title
