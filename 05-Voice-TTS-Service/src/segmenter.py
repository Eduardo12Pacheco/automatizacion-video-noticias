from __future__ import annotations

from dataclasses import asdict, dataclass
import re
from typing import List


WORD_PATTERN = re.compile(r"\b\w+[\w'-]*\b", flags=re.UNICODE)
SENTENCE_SPLIT_PATTERN = re.compile(r"(?<=[.!?])\s+")
CLAUSE_SPLIT_PATTERN = re.compile(r"(?<=[,;:])\s+")


@dataclass
class Segment:
    index: int
    paragraph_index: int
    text: str
    word_count: int
    char_count: int
    pause_after_ms: int

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class SegmenterConfig:
    mode: str = "paragraph_first"
    min_words_per_segment: int = 35
    max_words_per_segment: int = 70
    hard_max_words_per_segment: int = 90


def _count_words(text: str) -> int:
    return len(WORD_PATTERN.findall(text))


def _split_into_sentences(paragraph: str) -> List[str]:
    pieces = [p.strip() for p in SENTENCE_SPLIT_PATTERN.split(paragraph.strip()) if p.strip()]
    return pieces if pieces else [paragraph.strip()]


def _split_oversized_sentence(sentence: str, hard_max_words: int) -> List[str]:
    words = _count_words(sentence)
    if words <= hard_max_words:
        return [sentence.strip()]

    clauses = [c.strip() for c in CLAUSE_SPLIT_PATTERN.split(sentence.strip()) if c.strip()]
    if len(clauses) <= 1:
        tokens = sentence.split()
        chunks: List[str] = []
        start = 0
        while start < len(tokens):
            end = min(start + hard_max_words, len(tokens))
            chunks.append(" ".join(tokens[start:end]).strip())
            start = end
        return [c for c in chunks if c]

    chunks: List[str] = []
    current = ""
    for clause in clauses:
        candidate = clause if not current else f"{current} {clause}"
        if _count_words(candidate) <= hard_max_words:
            current = candidate
        else:
            if current:
                chunks.append(current.strip())
            current = clause

    if current:
        chunks.append(current.strip())

    out: List[str] = []
    for chunk in chunks:
        out.extend(_split_oversized_sentence(chunk, hard_max_words))
    return out


def _segment_paragraph(paragraph: str, cfg: SegmenterConfig) -> List[str]:
    sentences = _split_into_sentences(paragraph)

    normalized: List[str] = []
    for sentence in sentences:
        normalized.extend(_split_oversized_sentence(sentence, cfg.hard_max_words_per_segment))

    chunks: List[str] = []
    current = ""
    for sentence in normalized:
        if not current:
            current = sentence
            continue

        candidate = f"{current} {sentence}".strip()
        cand_words = _count_words(candidate)

        if cand_words <= cfg.max_words_per_segment:
            current = candidate
            continue

        if _count_words(current) < cfg.min_words_per_segment:
            current = candidate
            continue

        chunks.append(current.strip())
        current = sentence

    if current:
        chunks.append(current.strip())

    if len(chunks) > 1:
        merged: List[str] = []
        i = 0
        while i < len(chunks):
            cur = chunks[i]
            cur_words = _count_words(cur)
            if (
                cur_words < cfg.min_words_per_segment
                and i + 1 < len(chunks)
                and _count_words(f"{cur} {chunks[i+1]}") <= cfg.hard_max_words_per_segment
            ):
                merged.append(f"{cur} {chunks[i+1]}")
                i += 2
                continue

            merged.append(cur)
            i += 1
        chunks = merged

    return chunks


def _segment_sentence_first(paragraph: str, cfg: SegmenterConfig) -> List[str]:
    sentences = _split_into_sentences(paragraph)
    chunks: List[str] = []
    for sentence in sentences:
        chunks.extend(_split_oversized_sentence(sentence, cfg.hard_max_words_per_segment))
    return [c.strip() for c in chunks if c.strip()]


def detect_pause_ms(text: str, *, is_paragraph_end: bool, pauses: dict) -> int:
    if is_paragraph_end:
        return int(pauses.get("paragraph_break", 600))

    stripped = text.rstrip()
    if stripped.endswith(","):
        return int(pauses.get("comma", 120))
    if stripped.endswith(";"):
        return int(pauses.get("semicolon", 180))
    if stripped.endswith(":"):
        return int(pauses.get("colon", 180))
    if stripped.endswith("?"):
        return int(pauses.get("question", 300))
    if stripped.endswith("!"):
        return int(pauses.get("exclamation", 300))
    if stripped.endswith("."):
        return int(pauses.get("period", 260))
    return int(pauses.get("default", 220))


def segment_text(raw_text: str, cfg: SegmenterConfig, pauses: dict) -> List[Segment]:
    normalized_text = raw_text.replace("\r\n", "\n").replace("\r", "\n")
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", normalized_text) if p.strip()]

    segments: List[Segment] = []
    idx = 0

    for p_idx, paragraph in enumerate(paragraphs):
        mode = (cfg.mode or "paragraph_first").strip().lower()
        if mode == "sentence_first":
            chunks = _segment_sentence_first(paragraph, cfg)
        else:
            chunks = _segment_paragraph(paragraph, cfg)
        for c_idx, chunk in enumerate(chunks):
            idx += 1
            is_paragraph_end = c_idx == len(chunks) - 1
            segments.append(
                Segment(
                    index=idx,
                    paragraph_index=p_idx + 1,
                    text=chunk,
                    word_count=_count_words(chunk),
                    char_count=len(chunk),
                    pause_after_ms=detect_pause_ms(chunk, is_paragraph_end=is_paragraph_end, pauses=pauses),
                )
            )

    return segments
