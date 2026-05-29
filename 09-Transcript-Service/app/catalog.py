from __future__ import annotations

from dataclasses import dataclass


TARGET_COUNTRY_ORDER = ("ecuador", "colombia", "argentina", "uruguay", "paraguay", "mexico")
SUPPORTED_LANGUAGES = ["es", "fr", "en", "it", "de", "pt", "nl"]
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
class CatalogEntry:
    country: str
    canonical: str
    variants: list[str]


COUNTRY_CATALOG: dict[str, dict[str, object]] = {
    "ecuador": {
        "name": "Ecuador",
        "entities": {
            "Ecuador": {
                "base": ["Ecuador"],
                "es": ["La Tri", "selección ecuatoriana"],
                "fr": ["Équateur", "Equateur"],
                "en": ["Ecuador"],
                "it": ["Ecuador"],
                "de": ["Ecuador"],
                "pt": ["Equador"],
                "nl": ["Ecuador"],
            },
            "Willian Pacho": {
                "base": ["Willian Pacho", "Pacho", "Pachio"],
                "fr": ["Pachio"],
            },
            "Moisés Caicedo": {
                "base": ["Moisés Caicedo", "Caicedo"],
                "fr": ["Moise Caicedo"],
                "it": ["Moises Caicedo"],
                "es": ["Moisés"],
                "en": ["Moises Caicedo"],
                "pt": ["Moisés Caicedo"],
            },
        },
    },
    "colombia": {
        "name": "Colombia",
        "entities": {
            "Colombia": {
                "base": ["Colombia"],
                "fr": ["Colombie"],
                "it": ["Colombia"],
                "es": ["Selección Colombia", "cafeteros"],
                "en": ["Colombia"],
                "de": ["Kolumbien"],
                "pt": ["Colômbia"],
                "nl": ["Colombia"],
            },
            "James Rodríguez": {
                "base": ["James Rodríguez", "Rodríguez"],
                "fr": ["James Rodrigue"],
                "it": ["James Rodriguez"],
                "es": ["James", "James Rodríguez"],
                "en": ["James Rodriguez"],
                "de": ["James Rodriguez"],
                "pt": ["James Rodríguez"],
                "nl": ["James Rodriguez"],
            },
            "Luis Díaz": {
                "base": ["Luis Díaz", "Díaz"],
                "fr": ["Luis Diaz"],
                "it": ["Luis Diaz"],
                "es": ["Lucho Díaz"],
                "en": ["Luis Diaz"],
                "pt": ["Luis Díaz"],
                "nl": ["Luis Diaz"],
            },
        },
    },
    "argentina": {
        "name": "Argentina",
        "entities": {
            "Argentina": {
                "base": ["Argentina"],
                "fr": ["Argentine"],
                "it": ["Argentina"],
                "es": ["albiceleste", "selección argentina"],
                "en": ["Argentina"],
                "de": ["Argentinien"],
                "pt": ["Argentina"],
                "nl": ["Argentinië", "Argentinie"],
            },
            "Lionel Messi": {
                "base": ["Lionel Messi", "Messi"],
                "fr": ["Lionel Messie"],
                "it": ["Lionel Messi"],
                "es": ["Leo Messi"],
                "en": ["Lionel Messi"],
                "pt": ["Lionel Messi"],
                "nl": ["Lionel Messi"],
            },
        },
    },
    "uruguay": {
        "name": "Uruguay",
        "entities": {
            "Uruguay": {
                "base": ["Uruguay", "uruguayo", "charrúa", "charrua", "celeste"],
                "nl": ["Oeroegwaj"],
                "de": ["Uruguay"],
                "fr": ["Uruguay"],
                "pt": ["Uruguai"],
            },
            "Federico Valverde": {"base": ["Federico Valverde", "Fede Valverde", "Valverde"]},
            "Darwin Núñez": {"base": ["Darwin Núñez", "Darwin Nunez", "Núñez", "Nunez", "Darwin"]},
            "Manuel Ugarte": {"base": ["Manuel Ugarte", "Ugarte"]},
        },
    },
    "paraguay": {
        "name": "Paraguay",
        "entities": {
            "Paraguay": {"base": ["Paraguay", "paraguayo", "albirroja", "guaraní", "guarani"]},
            "Miguel Almirón": {"base": ["Miguel Almirón", "Miguel Almiron", "Almirón", "Almiron"]},
            "Julio Enciso": {"base": ["Julio Enciso", "Enciso"]},
            "Antonio Sanabria": {"base": ["Antonio Sanabria", "Sanabria"]},
        },
    },
    "mexico": {
        "name": "México",
        "entities": {
            "México": {
                "base": ["México", "Mexico", "mexicano", "Tri", "Tricolor", "Mejico"],
                "fr": ["Mexique"],
                "en": ["Mexico"],
                "it": ["Messico"],
                "de": ["Mexiko"],
                "pt": ["México"],
                "nl": ["Mexico", "Mejico"],
            },
            "Santiago Giménez": {
                "base": ["Santiago Giménez", "Santiago Gimenez", "Santi Giménez", "Santi Gimenez", "Giménez", "Gimenez"],
            },
            "Guillermo Ochoa": {"base": ["Guillermo Ochoa", "Memo Ochoa", "Ochoa"]},
            "Raúl Jiménez": {"base": ["Raúl Jiménez", "Raul Jimenez", "Jiménez", "Jimenez"]},
        },
    },
}


def _unique(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        clean = value.strip()
        if clean and clean not in seen:
            seen.add(clean)
            result.append(clean)
    return result


def normalize_country(code: str) -> str:
    normalized = code.strip().casefold()
    return COUNTRY_ALIASES.get(normalized, normalized)


def expand_catalog(countries: list[str], detected_language: str | None) -> list[CatalogEntry]:
    language = (detected_language or "").casefold()
    supported = language in SUPPORTED_LANGUAGES
    entries: list[CatalogEntry] = []
    for raw_country in countries:
        country = normalize_country(raw_country)
        config = COUNTRY_CATALOG.get(country)
        if not config:
            continue
        entities = config["entities"]
        assert isinstance(entities, dict)
        for canonical, variants_by_language in entities.items():
            assert isinstance(variants_by_language, dict)
            variants = list(variants_by_language.get("base", []))
            if supported:
                variants.extend(variants_by_language.get(language, []))
            entries.append(CatalogEntry(country=country, canonical=canonical, variants=_unique(variants)))
    return entries


def get_catalog_summary() -> dict[str, list[dict[str, object]]]:
    countries: list[dict[str, object]] = []
    for code in TARGET_COUNTRY_ORDER:
        config = COUNTRY_CATALOG[code]
        entities = config["entities"]
        assert isinstance(entities, dict)
        variant_count = sum(
            len(entity.get("base", [])) + sum(len(entity.get(lang, [])) for lang in SUPPORTED_LANGUAGES)
            for entity in entities.values()
        )
        countries.append(
            {
                "code": code,
                "name": config["name"],
                "languages": SUPPORTED_LANGUAGES,
                "variant_count": variant_count,
            }
        )
    return {"countries": countries}
