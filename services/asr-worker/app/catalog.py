from __future__ import annotations

from dataclasses import dataclass


TARGET_COUNTRY_ORDER = ('aurenia', 'montelia', 'valdoria', 'rivamar', 'bosquemar', 'terramar')
SUPPORTED_LANGUAGES = ["es", "fr", "en", "it", "de", "pt", "nl"]
COUNTRY_ALIASES = {
    "aurenia": "aurenia",
    "montelia": "montelia",
    "valdoria": "valdoria",
    "rivamar": "rivamar",
    "bosquemar": "bosquemar",
    "terramar": "terramar",
}


@dataclass(frozen=True)
class CatalogEntry:
    country: str
    canonical: str
    variants: list[str]


COUNTRY_CATALOG: dict[str, dict[str, object]] = {
    "aurenia": {
        "name": "Aurenia",
        "entities": {
            "Aurenia": {
                "base": ["Aurenia", "La Aurenia", "selección aureniana", "seleccion aureniana"],
                "fr": ["Aurénie"],
                "en": ["Aurenia"],
                "it": ["Aurenia"],
                "de": ["Aurenia"],
                "pt": ["Aurenia"],
                "nl": ["Aurenia"],
            },
            "Nicolás Andrade": {
                "base": ["Nicolás Andrade", "Nicolas Andrade", "Andrade"],
            },
            "Mateo Salvatierra": {
                "base": ["Mateo Salvatierra", "Salvatierra"],
            },
            "Iván Cordero": {
                "base": ["Iván Cordero", "Ivan Cordero", "Cordero"],
                "fr": ["Pachio"],
            },
            "Bruno Valdivia": {
                "base": ["Bruno Valdivia", "Valdivia"],
            },
            "Diego Peralta": {
                "base": ["Diego Peralta", "Peralta"],
            },
            "Ángel Mera": {
                "base": ["Ángel Mera", "Angel Mera", "Mera"],
            },
            "Lucas Benítez": {
                "base": ["Lucas Benítez", "Lucas Benitez", "Benítez", "Benitez"],
            },
            "Tomás Aguirre": {
                "base": ["Tomás Aguirre", "Tomas Aguirre", "Aguirre"],
            },
            "Kevin Salas": {
                "base": ["Kevin Salas", "Salas"],
            },
            "Andrés Cedeño": {
                "base": ["Andrés Cedeño", "Andres Cedeno", "Cedeño", "Cedeno"],
            },
            "Jon Olmedo": {
                "base": ["Jon Olmedo", "Olmedo"],
            },
            "Marco Villalba": {
                "base": ["Marco Villalba", "Villalba"],
            },
        },
    },
    "montelia": {
        "name": "Montelia",
        "entities": {
            "Montelia": {
                "base": ["Montelia", "Selección Montelia", "Seleccion Montelia", "montelios"],
                "fr": ["Montélie"],
                "en": ["Montelia"],
                "it": ["Montelia"],
                "de": ["Montelia"],
                "pt": ["Montelia"],
                "nl": ["Montelia"],
            },
            "Luis Cárdenas": {
                "base": ["Luis Cárdenas", "Luis Cardenas", "Cárdenas", "Cardenas"],
            },
            "Jaime Rueda": {
                "base": ["Jaime Rueda", "Rueda"],
                "fr": ["Jamie Rueda"],
            },
            "Daniel Cifuentes": {
                "base": ["Daniel Cifuentes", "Cifuentes"],
            },
            "Damián Serrano": {
                "base": ["Damián Serrano", "Damian Serrano", "Serrano"],
            },
            "Javier Lema": {
                "base": ["Javier Lema", "Lema"],
            },
            "Ricardo Riofrío": {
                "base": ["Ricardo Riofrío", "Ricardo Riofrio", "Riofrío", "Riofrio"],
            },
            "Juan Fernando Quiroga": {
                "base": ["Juan Fernando Quiroga", "Quiroga"],
            },
            "Jonás Arriola": {
                "base": ["Jonás Arriola", "Jonas arriola", "arriola"],
            },
            "Rafael Santos Borja": {
                "base": ["Rafael Santos Borja", "Rafael Santos Borja", "Borja"],
            },
            "Jhon Duarte": {
                "base": ["Jhon Duarte", "Duarte"],
            },
            "Yaser Arrieta": {
                "base": ["Yaser Arrieta", "Arrieta"],
            },
            "Camilo Herrera": {
                "base": ["Camilo Herrera", "Herrera"],
            },
        },
    },
    "valdoria": {
        "name": "Valdoria",
        "entities": {
            "Valdoria": {
                "base": ["Valdoria", "selección valdoriana", "seleccion valdoriana"],
                "fr": ["Valdorie"],
                "en": ["Valdoria"],
                "it": ["Valdoria"],
                "de": ["Valdoria"],
                "pt": ["Valdoria"],
                "nl": ["Valdoria"],
            },
            "Leonel Márquez": {
                "base": ["Leonel Márquez", "Leonel Marquez", "Márquez", "Marquez"],
            },
            "Julián Alvarado": {
                "base": ["Julián Alvarado", "Julian Alvarado", "Alvarado"],
            },
            "Lautaro Molina": {
                "base": ["Lautaro Molina", "Molina"],
            },
            "Emiliano Ferreyra": {
                "base": ["Emiliano Ferreyra", "Ferreyra"],
            },
            "Enzo Ferrer": {
                "base": ["Enzo Ferrer", "Ferrer"],
            },
            "Alexis Montiel": {
                "base": ["Alexis Montiel", "Montiel"],
            },
            "Rodrigo Del Valle": {
                "base": ["Rodrigo Del Valle", "Del Valle"],
            },
            "Cristian Rojas": {
                "base": ["Cristian Rojas", "Rojas"],
            },
            "Nicolás Ocampo": {
                "base": ["Nicolás Ocampo", "Nicolas Ocampo", "Ocampo"],
            },
            "Ángel Miranda": {
                "base": ["Ángel Miranda", "Angel Miranda", "Miranda"],
            },
            "Alejandro Gándara": {
                "base": ["Alejandro Gándara", "Alejandro Gandara", "Gándara", "Gandara"],
            },
            "Facundo Ibáñez": {
                "base": ["Facundo Ibáñez", "Facundo Ibanez", "Ibáñez", "Ibanez"],
            },
        },
    },
    "rivamar": {
        "name": "Rivamar",
        "entities": {
            "Rivamar": {
                "base": ["Rivamar", "selección rivamarense", "seleccion rivamarense"],
                "fr": ["Rivamar"],
                "en": ["Rivamar"],
                "it": ["Rivamar"],
                "de": ["Rivamar"],
                "pt": ["Rivamar"],
                "nl": ["Rivamar"],
            },
            "Federico Valdés": {
                "base": ["Federico Valdés", "Federico Valdes", "Valdés", "Valdes"],
            },
            "Darío Nieves": {
                "base": ["Darío Nieves", "Dario Nieves", "Nieves", "Nieves"],
            },
            "Manuel Ugaz": {
                "base": ["Manuel Ugaz", "Ugaz"],
            },
            "Rodrigo Beltrán": {
                "base": ["Rodrigo Beltrán", "Rodrigo Beltran", "Beltrán", "Beltran"],
            },
            "Ronald Arce": {
                "base": ["Ronald Arce", "Arce"],
            },
            "Giorgian De Luca": {
                "base": ["Giorgian De Luca", "De Luca"],
            },
            "Facundo Peláez": {
                "base": ["Facundo Peláez", "Facundo Pelaez", "Peláez", "Pelaez"],
            },
            "Sergio Roca": {
                "base": ["Sergio Roca", "Roca"],
            },
            "Matías Vela": {
                "base": ["Matías Vela", "Matias Vela", "Vela"],
            },
            "José María Giraldo": {
                "base": ["José María Giraldo", "Jose Maria Giraldo", "Giraldo"],
            },
            "Nicolás De la Fuente": {
                "base": ["Nicolás De la Fuente", "Nicolas De la Fuente", "De la Fuente"],
            },
            "Martín Olivera": {
                "base": ["Martín Olivera", "Martin Olivera", "Olivera"],
            },
        },
    },
    "bosquemar": {
        "name": "Bosquemar",
        "entities": {
            "Bosquemar": {
                "base": ["Bosquemar", "selección bosquemarense", "seleccion bosquemarense"],
                "fr": ["Bosquemar"],
                "en": ["Bosquemar"],
                "it": ["Bosquemar"],
                "de": ["Bosquemar"],
                "pt": ["Bosquemar"],
                "nl": ["Bosquemar"],
            },
            "Miguel Almada": {
                "base": ["Miguel Almada", "Almada"],
            },
            "Julio Enríquez": {
                "base": ["Julio Enríquez", "Julio Enriquez", "Enríquez", "Enriquez"],
            },
            "Antonio Sandoval": {
                "base": ["Antonio Sandoval", "Sandoval"],
            },
            "Gustavo Gaitán": {
                "base": ["Gustavo Gaitán", "Gustavo Gaitan", "Gaitán", "Gaitan"],
            },
            "Ramón Solano": {
                "base": ["Ramón Solano", "Ramon Solano", "Solano"],
            },
            "Diego Garrido": {
                "base": ["Diego Garrido", "Garrido"],
            },
            "Omar Alfaro": {
                "base": ["Omar Alfaro", "Alfaro"],
            },
            "Damián Bustos": {
                "base": ["Damián Bustos", "Damian Bustos", "Bustos"],
            },
            "Junior Alcántara": {
                "base": ["Junior Alcántara", "Junior Alcantara", "Alcántara", "Alcantara"],
            },
            "Matías Rivarola": {
                "base": ["Matías Rivarola", "Matias Rivarola", "Rivarola"],
            },
            "Osvaldo Cáceres": {
                "base": ["Osvaldo Cáceres", "Osvaldo Caceres", "Cáceres", "Caceres"],
            },
            "Hernán Villagra": {
                "base": ["Hernán Villagra", "Hernan Villagra", "Villagra"],
            },
        },
    },
    "terramar": {
        "name": "Terramar",
        "entities": {
            "Terramar": {
                "base": ["Terramar", "selección terramarense", "seleccion terramarense"],
                "fr": ["Terramar"],
                "en": ["Terramar"],
                "it": ["Terramar"],
                "de": ["Terramar"],
                "pt": ["Terramar"],
                "nl": ["Terramar"],
            },
            "Santiago Gil": {
                "base": ["Santiago Gil", "Santi Gil", "Gil"],
            },
            "Guillermo Olvera": {
                "base": ["Guillermo Olvera", "Olvera"],
            },
            "Raúl Jaramillo": {
                "base": ["Raúl Jaramillo", "Raul Jaramillo", "Jaramillo"],
            },
            "Edson Ávila": {
                "base": ["Edson Ávila", "Edson Avila", "Ávila", "Avila"],
            },
            "Orbelín Palacios": {
                "base": ["Orbelín Palacios", "Orbelin Palacios", "Palacios"],
            },
            "Luis Chacón": {
                "base": ["Luis Chacón", "Luis Chacon", "Chacón", "Chacon"],
            },
            "César Montero": {
                "base": ["César Montero", "Cesar Montero", "Montero"],
            },
            "Johan Varela": {
                "base": ["Johan Varela", "Varela"],
            },
            "Julián Quintana": {
                "base": ["Julián Quintana", "Julian Quintana", "Quintana"],
            },
            "Hirving Loza": {
                "base": ["Hirving Loza", "Loza"],
            },
            "Henry Martos": {
                "base": ["Henry Martos", "Martos"],
            },
            "Érick Palomares": {
                "base": ["Érick Palomares", "Erick Palomares", "Palomares"],
            },
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
