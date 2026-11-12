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
    assert normalize_title("Résumé: L'Équipe / FRANCE!!!") == "resume l equipe france"


def test_match_program_title_returns_auditable_metadata_for_contains_and_starts_with():
    contains = match_program_title(
        "🔥 Fútbol Picante EN VIVO",
        ProgramTitleRule(op="contains", value="FUTBOL PICANTE"),
    )
    starts = match_program_title(
        "La Pizarra de Quintana analiza la fecha",
        ProgramTitleRule(op="starts_with", value="LA PIZARRA DE QUINTANA"),
    )

    assert contains is not None
    assert contains.op == "contains"
    assert contains.value == "FUTBOL PICANTE"
    assert contains.normalized_value == "futbol picante"
    assert starts is not None
    assert starts.op == "starts_with"
    assert starts.normalized_value == "la pizarra de quintana"


def test_match_program_title_ignores_accents_symbols_emojis_and_repeated_whitespace():
    result = match_program_title(
        "🔥   TODOS!!! Somos   Técnicos — capítulo especial",
        ProgramTitleRule(op="contains", value="TODOS SOMOS TECNICOS"),
    )

    assert result is not None
    assert result.normalized_title == "todos somos tecnicos capitulo especial"


def test_match_program_title_starts_with_does_not_behave_like_contains():
    result = match_program_title(
        "Debate tras LA PIZARRA DE QUINTANA",
        ProgramTitleRule(op="starts_with", value="LA PIZARRA DE QUINTANA"),
    )

    assert result is None


@pytest.mark.parametrize(
    ("title", "rule"),
    [
        ("LA PIZARRA DE QUINTANA: mercado europeo", ProgramTitleRule("starts_with", "LA PIZARRA DE QUINTANA")),
        ("Debate táctico: LA PIZARRA DE QUINTANA", ProgramTitleRule("contains", "LA PIZARRA DE QUINTANA")),
        ("EXITOSA DEPORTES en vivo", ProgramTitleRule("starts_with", "EXITOSA DEPORTES")),
        ("MADRUGOL CON MR PEET - edición central", ProgramTitleRule("starts_with", "MADRUGOL CON MR PEET")),
        ("Los Tenores comentan la fecha", ProgramTitleRule("contains", "TENORES")),
        ("Todos somos técnicos analiza la roja", ProgramTitleRule("contains", "TODOS SOMOS TECNICOS")),
        ("Círculo Central debate el torneo", ProgramTitleRule("contains", "CIRCULO CENTRAL")),
        ("#CardinalDeportivo por ABC", ProgramTitleRule("starts_with", "#CARDINALDEPORTIVO")),
        ("Última hora Cardinal Deportivo", ProgramTitleRule("contains", "CARDINAL DEPORTIVO")),
        ("#LaGranJugada en vivo", ProgramTitleRule("starts_with", "#LAGRANJUGADA")),
        ("La mesa protagonista del fútbol mexicano", ProgramTitleRule("contains", "LA MESA PROTAGONISTA")),
        ("La Última Palabra debate la liguilla", ProgramTitleRule("contains", "LA ULTIMA PALABRA")),
        ("Fútbol Picante EN VIVO", ProgramTitleRule("contains", "FUTBOL PICANTE")),
        ("Julio Ríos analiza la fecha", ProgramTitleRule("contains", "JULIO RIOS")),
    ],
)
def test_match_program_title_covers_exact_important_program_rule_matrix(title, rule):
    result = match_program_title(title, rule)

    assert result is not None
    assert result.op == rule.op
    assert result.value == rule.value


def test_match_program_title_does_not_overmatch_non_program_titles():
    assert match_program_title("Mr Peet comenta el mercado", ProgramTitleRule("starts_with", "MADRUGOL CON MR PEET")) is None
    assert match_program_title("Análisis de la jornada", ProgramTitleRule("contains", "FUTBOL PICANTE")) is None


def test_title_matcher_reports_country_and_player_alias_reasons(tmp_path):
    catalog_path = tmp_path / "catalog.yaml"
    catalog_path.write_text(
        """
countries:
  - code: ar
    terms:
      - Argentina
      - La Scaloneta
players:
  - name: Lionel Messi
    country: ar
    aliases:
      - Leo Messi
      - LM10
""".strip(),
        encoding="utf-8",
    )

    matcher = TitleMatcher(load_title_catalog(catalog_path))
    result = matcher.match("Post match: LM10 leads La Scaloneta again")

    assert result.matched is True
    assert result.reasons == [
        {"type": "country", "country": "argentina", "term": "la scaloneta"},
        {"type": "player", "country": "argentina", "player": "Lionel Messi", "term": "lm10"},
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
      - México
  - code: ec
    terms:
      - Ecuador
  - code: colombia
    terms:
      - Colombia
players:
  - name: Willian Pacho
    country: ec
    aliases:
      - Pacho
""".strip(),
        encoding="utf-8",
    )

    matcher = TitleMatcher(load_title_catalog(catalog_path))
    result = matcher.match("Pacho entre Ecuador, Colombia y Mexico")

    assert TARGET_COUNTRY_ORDER == ("ecuador", "colombia", "argentina", "uruguay", "paraguay", "mexico")
    assert [reason["country"] for reason in result.reasons] == ["ecuador", "ecuador", "colombia", "mexico"]


def test_title_matcher_lists_non_source_targets_once_in_priority_order():
    matcher = TitleMatcher(
        TitleCatalog(
            countries={"colombia": ["colombia"], "ecuador": ["ecuador"], "mexico": ["mexico"]},
            players=[],
        )
    )

    result = matcher.match("Colombia analiza a Ecuador y México")

    assert result.target_countries(source_country="colombia") == ["ecuador", "mexico"]


def test_repository_catalog_loads_and_matches_country_and_player_excluding_source_country():
    catalog_path = Path(__file__).parents[1] / "config" / "catalog.yaml"

    matcher = TitleMatcher(load_title_catalog(catalog_path))
    result = matcher.match("Pacho y Ecuador analizan a Luis Diaz con Colombia")

    assert result.matched is True
    assert {reason["type"] for reason in result.reasons} == {"country", "player"}
    assert result.target_countries(source_country="ecuador") == ["colombia"]


def test_repository_catalog_has_extensive_player_coverage_by_country():
    catalog_path = Path(__file__).parents[1] / "config" / "catalog.yaml"

    catalog = load_title_catalog(catalog_path)
    counts = Counter(player.country for player in catalog.players)

    assert set(counts) == {"ecuador", "colombia", "argentina", "uruguay", "paraguay", "mexico"}
    assert all(count >= 12 for count in counts.values())
    assert sum(counts.values()) >= 72


@pytest.mark.parametrize(
    ("title", "expected_country", "expected_player"),
    [
        ("Hincapie vuelve a ser clave en defensa", "ecuador", "Piero Hincapié"),
        ("Pacho gana protagonismo en PSG", "ecuador", "Willian Pacho"),
        ("Caicedo domina el medio ante Arsenal", "ecuador", "Moisés Caicedo"),
        ("Enner Valencia sigue vigente en la Tri", "ecuador", "Enner Valencia"),
        ("Kendry Paez vuelve a ser noticia en Chelsea", "ecuador", "Kendry Páez"),
        ("Pervis Estupinan apunta a la Premier", "ecuador", "Pervis Estupiñán"),
        ("Jeremy Sarmiento cambia el partido", "ecuador", "Jeremy Sarmiento"),
        ("Kevin Rodriguez entra en la convocatoria", "ecuador", "Kevin Rodríguez"),
        ("Luis Diaz marca doblete en Champions", "colombia", "Luis Díaz"),
        ("James lidera la remontada", "colombia", "James Rodríguez"),
        ("Jhon Duran interesa a media Europa", "colombia", "Jhon Durán"),
        ("Yaser Asprilla acelera su crecimiento", "colombia", "Yaser Asprilla"),
        ("Daniel Munoz suma otra asistencia", "colombia", "Daniel Muñoz"),
        ("Richard Rios gana protagonismo", "colombia", "Richard Ríos"),
        ("Borre vuelve al gol en Brasil", "colombia", "Rafael Santos Borré"),
        ("Messi decide otro partido para Inter Miami", "argentina", "Lionel Messi"),
        ("Julian Alvarez festeja en Champions", "argentina", "Julián Álvarez"),
        ("Lautaro Martinez llega encendido", "argentina", "Lautaro Martínez"),
        ("Di Maria anuncia una nueva función", "argentina", "Ángel Di María"),
        ("Dibu Martinez vuelve a ser decisivo", "argentina", "Emiliano Martínez"),
        ("Mac Allister ordena el mediocampo", "argentina", "Alexis Mac Allister"),
        ("Garnacho suma minutos en Manchester", "argentina", "Alejandro Garnacho"),
        ("Valverde anota para Real Madrid", "uruguay", "Federico Valverde"),
        ("Darwin Nunez rescata a Uruguay", "uruguay", "Darwin Núñez"),
        ("Ugarte firma una gran actuación", "uruguay", "Manuel Ugarte"),
        ("Bentancur recupera ritmo competitivo", "uruguay", "Rodrigo Bentancur"),
        ("Ronald Araujo se prepara para volver", "uruguay", "Ronald Araujo"),
        ("De Arrascaeta lidera a Flamengo", "uruguay", "Giorgian De Arrascaeta"),
        ("Pellistri busca continuidad", "uruguay", "Facundo Pellistri"),
        ("Almiron vuelve al gol", "paraguay", "Miguel Almirón"),
        ("Enciso brilla en Brighton", "paraguay", "Julio Enciso"),
        ("Sanabria aparece en el área", "paraguay", "Antonio Sanabria"),
        ("Gustavo Gomez comanda la defensa", "paraguay", "Gustavo Gómez"),
        ("Ramon Sosa genera expectativa", "paraguay", "Ramón Sosa"),
        ("Diego Gomez progresa en Inter Miami", "paraguay", "Diego Gómez"),
        ("Matias Rojas vuelve a la selección", "paraguay", "Matías Rojas"),
        ("Gimenez marca para Feyenoord", "mexico", "Santiago Giménez"),
        ("Ochoa salva a México", "mexico", "Guillermo Ochoa"),
        ("Jimenez convierte de penal", "mexico", "Raúl Jiménez"),
        ("Edson Alvarez manda en el mediocampo", "mexico", "Edson Álvarez"),
        ("Chucky Lozano define el clásico", "mexico", "Hirving Lozano"),
        ("Orbelin Pineda vuelve a ser titular", "mexico", "Orbelín Pineda"),
        ("Cesar Montes sostiene la zaga", "mexico", "César Montes"),
        ("Henry Martin responde con goles", "mexico", "Henry Martín"),
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
    result = matcher.match("Hincapie y Pacho ante Colombia con Luis Diaz")

    assert result.target_countries(source_country="ecuador") == ["colombia"]


def test_repository_catalog_keeps_source_country_excluded_with_broad_catalog_hits():
    catalog_path = Path(__file__).parents[1] / "config" / "catalog.yaml"

    matcher = TitleMatcher(load_title_catalog(catalog_path))
    result = matcher.match(
        "Messi, Lautaro y Dibu Martinez reaccionan a Valverde, Darwin Nunez y Uruguay"
    )

    assert result.target_countries(source_country="argentina") == ["uruguay"]
