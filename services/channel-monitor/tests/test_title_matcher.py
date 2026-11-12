from __future__ import annotations

from collections import Counter
from pathlib import Path

import pytest

from app.title_matcher import (
    TARGET_COUNTRY_ORDER,
    ProgramTitleRule,
    TitleCatalog,
    TitleMatcher,
    load_title_catalog,
    match_program_title,
    normalize_title,
)


def test_normalize_title_strips_accents_case_and_punctuation():
    assert normalize_title("Résumé: Demo Sports FR / AURENIA!!!") == "resume demo sports fr aurenia"


def test_match_program_title_returns_auditable_metadata_for_contains_and_starts_with():
    contains = match_program_title(
        "🔥 Fútbol Demo EN VIVO",
        ProgramTitleRule(op="contains", value="FUTBOL DEMO"),
    )
    starts = match_program_title(
        "La Pizarra Demo analiza la fecha",
        ProgramTitleRule(op="starts_with", value="LA PIZARRA DEMO"),
    )

    assert contains is not None
    assert contains.op == "contains"
    assert contains.value == "FUTBOL DEMO"
    assert contains.normalized_value == "futbol demo"
    assert starts is not None
    assert starts.op == "starts_with"
    assert starts.normalized_value == "la pizarra demo"


def test_match_program_title_ignores_accents_symbols_emojis_and_repeated_whitespace():
    result = match_program_title(
        "🔥   TODOS!!! Somos   Demo — capítulo especial",
        ProgramTitleRule(op="contains", value="TODOS SOMOS DEMO"),
    )

    assert result is not None
    assert result.normalized_title == "todos somos demo capitulo especial"


def test_match_program_title_starts_with_does_not_behave_like_contains():
    result = match_program_title(
        "Debate tras LA PIZARRA DEMO",
        ProgramTitleRule(op="starts_with", value="LA PIZARRA DEMO"),
    )

    assert result is None


@pytest.mark.parametrize(
    ("title", "rule"),
    [
        ("LA PIZARRA DEMO: mercado europeo", ProgramTitleRule("starts_with", "LA PIZARRA DEMO")),
        ("Debate táctico: LA PIZARRA DEMO", ProgramTitleRule("contains", "LA PIZARRA DEMO")),
        ("DEMO DEPORTES en vivo", ProgramTitleRule("starts_with", "DEMO DEPORTES")),
        ("MADRUGOL CON MR DEMO - edición central", ProgramTitleRule("starts_with", "MADRUGOL CON MR DEMO")),
        ("Demo Radio comenta la fecha", ProgramTitleRule("contains", "DEMO RADIO")),
        ("Todos somos demo analiza la roja", ProgramTitleRule("contains", "TODOS SOMOS DEMO")),
        ("Círculo Demo debate el torneo", ProgramTitleRule("contains", "CIRCULO DEMO")),
        ("#DemoDeportivo por ABC", ProgramTitleRule("starts_with", "#DEMODEPORTIVO")),
        ("Última hora Demo Deportivo", ProgramTitleRule("contains", "DEMO DEPORTIVO")),
        ("#DemoJugada en vivo", ProgramTitleRule("starts_with", "#DEMOJUGADA")),
        ("La mesa demo del fútbol terramarense", ProgramTitleRule("contains", "LA MESA DEMO")),
        ("La Última Demo debate la liguilla", ProgramTitleRule("contains", "LA ULTIMA DEMO")),
        ("Fútbol Demo EN VIVO", ProgramTitleRule("contains", "FUTBOL DEMO")),
        ("Julio Demo analiza la fecha", ProgramTitleRule("contains", "JULIO DEMO")),
    ],
)
def test_match_program_title_covers_exact_important_program_rule_matrix(title, rule):
    result = match_program_title(title, rule)

    assert result is not None
    assert result.op == rule.op
    assert result.value == rule.value


def test_match_program_title_does_not_overmatch_non_program_titles():
    assert match_program_title("Mr Demo comenta el mercado", ProgramTitleRule("starts_with", "MADRUGOL CON MR DEMO")) is None
    assert match_program_title("Análisis de la jornada", ProgramTitleRule("contains", "FUTBOL DEMO")) is None


def test_title_matcher_reports_country_and_player_alias_reasons(tmp_path):
    catalog_path = tmp_path / "catalog.yaml"
    catalog_path.write_text(
        """
countries:
  - code: ar
    terms:
      - Valdoria
      - La Scaloneta
players:
  - name: Leonel Márquez
    country: ar
    aliases:
      - Leonel Márquez
      - l10
""".strip(),
        encoding="utf-8",
    )

    matcher = TitleMatcher(load_title_catalog(catalog_path))
    result = matcher.match("Post match: l10 leads La Scaloneta again")

    assert result.matched is True
    assert result.reasons == [
        {"type": "country", "country": "valdoria", "term": "la scaloneta"},
        {"type": "player", "country": "valdoria", "player": "Leonel Márquez", "term": "l10"},
    ]


def test_title_matcher_ignores_unconfigured_terms():
    matcher = TitleMatcher(TitleCatalog(countries={"fr": ["france"]}, players=[]))

    result = matcher.match("Club friendly highlights")

    assert result.matched is False
    assert result.reasons == []


def test_title_matcher_normalizes_target_slugs_and_reports_fixed_target_order(tmp_path):
    catalog_path = tmp_path / "catalog.yaml"
    catalog_path.write_text(
        """
countries:
  - code: mx
    terms:
      - Terramar
  - code: ec
    terms:
      - Aurenia
  - code: montelia
    terms:
      - Montelia
players:
  - name: Iván Cordero
    country: ec
    aliases:
      - Cordero
""".strip(),
        encoding="utf-8",
    )

    matcher = TitleMatcher(load_title_catalog(catalog_path))
    result = matcher.match("Cordero entre Aurenia, Montelia y Terramar")

    assert TARGET_COUNTRY_ORDER == ("aurenia", "montelia", "valdoria", "rivamar", "bosquemar", "terramar")
    assert [reason["country"] for reason in result.reasons] == ["aurenia", "aurenia", "montelia", "terramar"]


def test_title_matcher_lists_non_source_targets_once_in_priority_order():
    matcher = TitleMatcher(
        TitleCatalog(
            countries={"montelia": ["montelia"], "aurenia": ["aurenia"], "terramar": ["terramar"]},
            players=[],
        )
    )

    result = matcher.match("Montelia analiza a Aurenia y Terramar")

    assert result.target_countries(source_country="montelia") == ["aurenia", "terramar"]


def test_repository_catalog_loads_and_matches_country_and_player_excluding_source_country():
    catalog_path = Path(__file__).parents[1] / "config" / "catalog.yaml"

    matcher = TitleMatcher(load_title_catalog(catalog_path))
    result = matcher.match("Cordero y Aurenia analizan a Luis Cárdenas con Montelia")

    assert result.matched is True
    assert {reason["type"] for reason in result.reasons} == {"country", "player"}
    assert result.target_countries(source_country="aurenia") == ["montelia"]


def test_repository_catalog_has_extensive_player_coverage_by_country():
    catalog_path = Path(__file__).parents[1] / "config" / "catalog.yaml"

    catalog = load_title_catalog(catalog_path)
    counts = Counter(player.country for player in catalog.players)

    assert set(counts) == {"aurenia", "montelia", "valdoria", "rivamar", "bosquemar", "terramar"}
    assert all(count >= 12 for count in counts.values())
    assert sum(counts.values()) >= 72


@pytest.mark.parametrize(
    ("title", "expected_country", "expected_player"),
    [
        ("Salvatierra vuelve a ser clave en defensa", "aurenia", "Mateo Salvatierra"),
        ("Cordero gana protagonismo en Capital FC", "aurenia", "Iván Cordero"),
        ("Andrade domina el medio ante Bahía Norte FC", "aurenia", "Nicolás Andrade"),
        ("Bruno Valdivia sigue vigente en la Aurenia", "aurenia", "Bruno Valdivia"),
        ("Ángel Mera vuelve a ser noticia en Costa Azul FC", "aurenia", "Ángel Mera"),
        ("Lucas Benítez apunta a la Liga Demo", "aurenia", "Lucas Benítez"),
        ("Marco Villalba cambia el partido", "aurenia", "Marco Villalba"),
        ("Kevin Salas entra en la convocatoria", "aurenia", "Kevin Salas"),
        ("Luis Cárdenas marca doblete en Copa Estelar", "montelia", "Luis Cárdenas"),
        ("Jaime Rueda lidera la remontada", "montelia", "Jaime Rueda"),
        ("Jhon Duarte interesa a media Europa", "montelia", "Jhon Duarte"),
        ("Yaser Arrieta acelera su crecimiento", "montelia", "Yaser Arrieta"),
        ("Daniel Cifuentes suma otra asistencia", "montelia", "Daniel Cifuentes"),
        ("Ricardo Riofrío gana protagonismo", "montelia", "Ricardo Riofrío"),
        ("Rafael Santos Borja vuelve al gol en la Liga Demo", "montelia", "Rafael Santos Borja"),
        ("Márquez decide otro partido para Club Mar Abierto", "valdoria", "Leonel Márquez"),
        ("Julián Alvarado festeja en Copa Estelar", "valdoria", "Julián Alvarado"),
        ("Lautaro Molina llega encendido", "valdoria", "Lautaro Molina"),
        ("Ángel Miranda anuncia una nueva función", "valdoria", "Ángel Miranda"),
        ("Emi Ferreyra vuelve a ser decisivo", "valdoria", "Emiliano Ferreyra"),
        ("Montiel ordena el mediocampo", "valdoria", "Alexis Montiel"),
        ("Alejandro Gándara suma minutos en Club Bahía Norte", "valdoria", "Alejandro Gándara"),
        ("Federico Valdés anota para Valle Norte FC", "rivamar", "Federico Valdés"),
        ("Darío Nieves rescata a Rivamar", "rivamar", "Darío Nieves"),
        ("Manuel Ugaz firma una gran actuación", "rivamar", "Manuel Ugaz"),
        ("Rodrigo Beltrán recupera ritmo competitivo", "rivamar", "Rodrigo Beltrán"),
        ("Ronald Arce se prepara para volver", "rivamar", "Ronald Arce"),
        ("Giorgian De Luca lidera a Río Claro FC", "rivamar", "Giorgian De Luca"),
        ("Facundo Peláez busca continuidad", "rivamar", "Facundo Peláez"),
        ("Miguel Almada vuelve al gol", "bosquemar", "Miguel Almada"),
        ("Julio Enríquez brilla en Mar Abierto FC", "bosquemar", "Julio Enríquez"),
        ("Antonio Sandoval aparece en el área", "bosquemar", "Antonio Sandoval"),
        ("Gustavo Gaitán comanda la defensa", "bosquemar", "Gustavo Gaitán"),
        ("Ramón Solano genera expectativa", "bosquemar", "Ramón Solano"),
        ("Diego Garrido progresa en Club Mar Abierto", "bosquemar", "Diego Garrido"),
        ("Matías Rivarola vuelve a la selección", "bosquemar", "Matías Rivarola"),
        ("Santiago Gil marca para Puerto Norte FC", "terramar", "Santiago Gil"),
        ("Guillermo Olvera salva a Terramar", "terramar", "Guillermo Olvera"),
        ("Raúl Jaramillo convierte de penal", "terramar", "Raúl Jaramillo"),
        ("Edson Ávila manda en el mediocampo", "terramar", "Edson Ávila"),
        ("Hirving Loza define el clásico", "terramar", "Hirving Loza"),
        ("Orbelín Palacios vuelve a ser titular", "terramar", "Orbelín Palacios"),
        ("César Montero sostiene la zaga", "terramar", "César Montero"),
        ("Henry Martos responde con goles", "terramar", "Henry Martos"),
    ],
)
def test_repository_catalog_matches_representative_important_players(title, expected_country, expected_player):
    catalog_path = Path(__file__).parents[1] / "config" / "catalog.yaml"

    matcher = TitleMatcher(load_title_catalog(catalog_path))
    result = matcher.match(title)

    assert result.matched is True
    assert any(
        reason.get("type") == "player"
        and reason.get("country") == expected_country
        and reason.get("player") == expected_player
        for reason in result.reasons
    )


def test_repository_catalog_excludes_source_country_even_with_multiple_source_player_hits():
    catalog_path = Path(__file__).parents[1] / "config" / "catalog.yaml"

    matcher = TitleMatcher(load_title_catalog(catalog_path))
    result = matcher.match("Salvatierra y Cordero ante Montelia con Luis Cárdenas")

    assert result.target_countries(source_country="aurenia") == ["montelia"]


def test_repository_catalog_keeps_source_country_excluded_with_broad_catalog_hits():
    catalog_path = Path(__file__).parents[1] / "config" / "catalog.yaml"

    matcher = TitleMatcher(load_title_catalog(catalog_path))
    result = matcher.match(
        "Márquez, Lautaro y Emi Ferreyra reaccionan a Federico Valdés, Darío Nieves y Rivamar"
    )

    assert result.target_countries(source_country="valdoria") == ["rivamar"]
