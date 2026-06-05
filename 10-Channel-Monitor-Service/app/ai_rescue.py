from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Protocol

from .title_matcher import TARGET_COUNTRY_ORDER, TitleCatalog, normalize_country
from .youtube_client import SubtitleSegment


MIN_EVIDENCE_MS = 20_000
DEFAULT_SUBTITLE_MAX_CHARACTERS = 300_000
DEFAULT_SUBTITLE_HARD_MAX_CHARACTERS = 1_000_000
DEFAULT_SUBTITLE_MAX_SEGMENTS = 10_000
VALID_RISKS = {"low", "medium", "high"}


@dataclass(frozen=True)
class AiRescueVideoInput:
    video_id: str
    title: str | None
    source_country: str | None
    source_language: str | None
    segments: list[SubtitleSegment]


@dataclass(frozen=True)
class AiRescueEvidence:
    start_ms: int
    end_ms: int
    text: str
    translation_es: str
    explanation_es: str

    @property
    def duration_ms(self) -> int:
        return max(0, self.end_ms - self.start_ms)


@dataclass(frozen=True)
class AiRescueCandidate:
    target_country: str
    score: int
    summary_es: str
    angle_es: str
    risk: str
    risks: list[str] = field(default_factory=list)
    evidence: list[AiRescueEvidence] = field(default_factory=list)

    @property
    def evidence_duration_ms(self) -> int:
        return sum(item.duration_ms for item in self.evidence)


@dataclass(frozen=True)
class AiRescueRejection:
    target_country: str | None
    reason: str
    explanation_es: str


@dataclass(frozen=True)
class AiRescueAnalysisResult:
    candidates: list[AiRescueCandidate]
    rejections: list[AiRescueRejection]
    raw_response_json: str = "{}"


@dataclass(frozen=True)
class SubtitlePayloadPolicy:
    max_characters: int = DEFAULT_SUBTITLE_MAX_CHARACTERS
    hard_max_characters: int = DEFAULT_SUBTITLE_HARD_MAX_CHARACTERS
    max_segments: int = DEFAULT_SUBTITLE_MAX_SEGMENTS


@dataclass(frozen=True)
class SubtitlePromptWindow:
    segments: list[SubtitleSegment]
    included_characters: int
    total_characters: int
    total_segments: int
    configured_max_characters: int
    hard_max_characters: int
    effective_max_characters: int
    max_segments: int

    @property
    def truncated(self) -> bool:
        return len(self.segments) < self.total_segments or self.included_characters < self.total_characters


class AiCompletionClient(Protocol):
    def complete_json(self, prompt: str) -> str: ...


class AiRescueAnalyzer:
    def __init__(
        self,
        *,
        client: AiCompletionClient,
        catalog: TitleCatalog,
        subtitle_policy: SubtitlePayloadPolicy | None = None,
    ):
        self.client = client
        self.catalog = catalog
        self.subtitle_policy = subtitle_policy or SubtitlePayloadPolicy()

    def analyze(self, video: AiRescueVideoInput) -> AiRescueAnalysisResult:
        prompt = build_ai_rescue_prompt(video=video, catalog=self.catalog, subtitle_policy=self.subtitle_policy)
        response = self.client.complete_json(prompt)
        return parse_ai_rescue_response(
            response,
            source_country=video.source_country,
            allowed_target_countries=_allowed_targets(self.catalog, source_country=video.source_country),
        )


def build_ai_rescue_prompt(
    *,
    video: AiRescueVideoInput,
    catalog: TitleCatalog,
    subtitle_policy: SubtitlePayloadPolicy | None = None,
    subtitle_max_characters: int | None = None,
    subtitle_hard_max_characters: int | None = None,
    subtitle_max_segments: int | None = None,
) -> str:
    allowed = _allowed_targets(catalog, source_country=video.source_country)
    policy = subtitle_policy or SubtitlePayloadPolicy(
        max_characters=subtitle_max_characters
        if subtitle_max_characters is not None
        else DEFAULT_SUBTITLE_MAX_CHARACTERS,
        hard_max_characters=subtitle_hard_max_characters
        if subtitle_hard_max_characters is not None
        else DEFAULT_SUBTITLE_HARD_MAX_CHARACTERS,
        max_segments=subtitle_max_segments if subtitle_max_segments is not None else DEFAULT_SUBTITLE_MAX_SEGMENTS,
    )
    prompt_window = select_subtitle_prompt_window(video.segments, policy=policy)
    payload = {
        "task": "Return strict JSON only. Find positive football-only evidence for configured target countries.",
        "schema": {
            "candidates": [
                {
                    "target_country": "string",
                    "score": "0-100 integer",
                    "summary_es": "string",
                    "angle_es": "string",
                    "risk": "low|medium|high",
                    "risks": ["string"],
                    "evidence": [
                        {
                            "start_ms": "integer",
                            "end_ms": "integer",
                            "text": "source subtitle text",
                            "translation_es": "Spanish translation",
                            "explanation_es": "Spanish editorial reason",
                        }
                    ],
                }
            ],
            "rejections": [{"target_country": "string", "reason": "string", "explanation_es": "string"}],
        },
        "constraints": [
            "Use only provided YouTube subtitles as evidence.",
            "Provided subtitles may be in the video's original language; translate and analyze them as needed.",
            "Do not use audio, Whisper, professional transcription, or metadata-only claims.",
            "Exclude the source country and any unconfigured target.",
            "Require at least 20 seconds of accumulated relevant positive football evidence per candidate.",
        ],
        "video": {
            "video_id": video.video_id,
            "title": video.title or "",
            "source_country": normalize_country(video.source_country),
            "source_language": video.source_language or "",
            "allowed_target_countries": allowed,
            "subtitle_window": {
                "included_segments": len(prompt_window.segments),
                "total_segments": len(video.segments),
                "included_characters": prompt_window.included_characters,
                "total_characters": prompt_window.total_characters,
                "configured_max_characters": prompt_window.configured_max_characters,
                "hard_max_characters": prompt_window.hard_max_characters,
                "max_characters": prompt_window.effective_max_characters,
                "max_segments": prompt_window.max_segments,
                "truncated": prompt_window.truncated,
            },
            "subtitles": [segment.__dict__ for segment in prompt_window.segments],
        },
    }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def select_subtitle_prompt_window(segments: list[SubtitleSegment], *, policy: SubtitlePayloadPolicy) -> SubtitlePromptWindow:
    configured_max = max(0, int(policy.max_characters))
    hard_max = max(0, int(policy.hard_max_characters))
    effective_max = min(configured_max, hard_max) if hard_max else configured_max
    segment_limit = max(0, int(policy.max_segments))
    total_characters = sum(_segment_prompt_character_count(segment) for segment in segments)
    selected: list[SubtitleSegment] = []
    included_characters = 0
    for segment in segments:
        if len(selected) >= segment_limit:
            break
        segment_characters = _segment_prompt_character_count(segment)
        if selected and included_characters + segment_characters > effective_max:
            break
        if not selected and segment_characters > effective_max:
            break
        selected.append(segment)
        included_characters += segment_characters
    window = SubtitlePromptWindow(
        segments=selected,
        included_characters=included_characters,
        total_characters=total_characters,
        total_segments=len(segments),
        configured_max_characters=configured_max,
        hard_max_characters=hard_max,
        effective_max_characters=effective_max,
        max_segments=segment_limit,
    )
    return window


def _segment_prompt_character_count(segment: SubtitleSegment) -> int:
    return len(segment.text or "")


def parse_ai_rescue_response(
    text: str, *, source_country: str | None, allowed_target_countries: list[str]
) -> AiRescueAnalysisResult:
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError("AI Rescue response must be strict JSON") from exc
    if not isinstance(payload, dict):
        raise ValueError("AI Rescue response must be a JSON object")
    allowed = {normalize_country(country) for country in allowed_target_countries}
    source = normalize_country(source_country)
    candidates: list[AiRescueCandidate] = []
    rejections: list[AiRescueRejection] = []
    for raw in payload.get("candidates") or []:
        candidate, rejection = _parse_candidate(raw, source_country=source, allowed=allowed)
        if candidate is not None:
            candidates.append(candidate)
        elif rejection is not None:
            rejections.append(rejection)
    for raw in payload.get("rejections") or []:
        if not isinstance(raw, dict):
            continue
        rejections.append(
            AiRescueRejection(
                target_country=_optional_country(raw.get("target_country")),
                reason=str(raw.get("reason") or "ai-rejected"),
                explanation_es=str(raw.get("explanation_es") or "Sin explicación."),
            )
        )
    return AiRescueAnalysisResult(
        candidates=sorted(candidates, key=lambda candidate: candidate.score, reverse=True),
        rejections=rejections,
        raw_response_json=json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
    )


def _parse_candidate(
    raw: object, *, source_country: str, allowed: set[str]
) -> tuple[AiRescueCandidate | None, AiRescueRejection | None]:
    if not isinstance(raw, dict):
        return None, AiRescueRejection(target_country=None, reason="malformed-candidate", explanation_es="Candidate is not an object.")
    target = normalize_country(raw.get("target_country"))
    if not target:
        return None, AiRescueRejection(target_country=None, reason="missing-target", explanation_es="Falta país objetivo.")
    if target == source_country:
        return None, AiRescueRejection(target_country=target, reason="source-country", explanation_es="El objetivo coincide con el país fuente.")
    if target not in allowed:
        return None, AiRescueRejection(target_country=target, reason="unconfigured-target", explanation_es="El objetivo no está configurado en Radar Monitor.")
    try:
        score = int(raw.get("score"))
    except (TypeError, ValueError):
        return None, AiRescueRejection(target_country=target, reason="invalid-score", explanation_es="Score inválido.")
    if not 0 <= score <= 100:
        return None, AiRescueRejection(target_country=target, reason="invalid-score", explanation_es="Score fuera de rango.")
    risk = str(raw.get("risk") or "").casefold()
    if risk not in VALID_RISKS:
        return None, AiRescueRejection(target_country=target, reason="invalid-risk", explanation_es="Riesgo inválido.")
    evidence = [_parse_evidence(item) for item in raw.get("evidence") or []]
    evidence = [item for item in evidence if item is not None]
    candidate = AiRescueCandidate(
        target_country=target,
        score=score,
        summary_es=str(raw.get("summary_es") or "").strip(),
        angle_es=str(raw.get("angle_es") or "").strip(),
        risk=risk,
        risks=[str(item) for item in raw.get("risks") or [] if str(item).strip()],
        evidence=evidence,
    )
    if not candidate.summary_es or not candidate.angle_es or not candidate.risks:
        return None, AiRescueRejection(target_country=target, reason="missing-details", explanation_es="Faltan detalles editoriales.")
    if candidate.evidence_duration_ms < MIN_EVIDENCE_MS:
        return None, AiRescueRejection(target_country=target, reason="insufficient-evidence", explanation_es="La evidencia subtitulada no llega a 20 segundos.")
    if not all(_looks_football_positive(item) for item in candidate.evidence):
        return None, AiRescueRejection(target_country=target, reason="non-football-evidence", explanation_es="La evidencia no prueba elogio futbolístico positivo.")
    return candidate, None


def _parse_evidence(raw: object) -> AiRescueEvidence | None:
    if not isinstance(raw, dict):
        return None
    try:
        start_ms = int(raw.get("start_ms"))
        end_ms = int(raw.get("end_ms"))
    except (TypeError, ValueError):
        return None
    if end_ms <= start_ms:
        return None
    return AiRescueEvidence(
        start_ms=start_ms,
        end_ms=end_ms,
        text=str(raw.get("text") or "").strip(),
        translation_es=str(raw.get("translation_es") or "").strip(),
        explanation_es=str(raw.get("explanation_es") or "").strip(),
    )


def _looks_football_positive(evidence: AiRescueEvidence) -> bool:
    text = f"{evidence.text} {evidence.translation_es} {evidence.explanation_es}".casefold()
    football_words = ("football", "fútbol", "futbol", "match", "partido")
    positive_words = ("great", "excellent", "praise", "beautiful", "brillante", "elogio", "excelente", "hermoso", "bien")
    return any(word in text for word in football_words) and any(word in text for word in positive_words)


def _allowed_targets(catalog: TitleCatalog, *, source_country: str | None) -> list[str]:
    source = normalize_country(source_country)
    configured = {normalize_country(country) for country in catalog.countries if normalize_country(country)}
    ordered = [country for country in TARGET_COUNTRY_ORDER if country in configured]
    ordered.extend(country for country in configured if country not in ordered)
    return [country for country in ordered if country != source]


def _optional_country(value: object) -> str | None:
    country = normalize_country(value)
    return country or None
