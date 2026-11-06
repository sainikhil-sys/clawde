"""Chunking, ranking, document context assembly and filename sanitising."""

from __future__ import annotations

import itertools

import pytest

from core.context.budget import estimate_tokens
from core.context.documents import DocumentSource, Passage, build_document_context
from services.document_processing.chunking import chunk_text
from services.document_processing.validation import UnsupportedFile, detect, sanitize_filename
from services.retrieval.ranking import bm25_scores, rank, tokenize


def test_chunks_cover_text_with_overlap_and_clean_breaks() -> None:
    text = "\n\n".join(f"Paragraph {i}: " + "word " * 60 for i in range(30))
    chunks = chunk_text(text, size=600, overlap=100)
    assert len(chunks) > 5
    assert chunks[0].start == 0 and chunks[-1].end == len(text)
    for prev, nxt in itertools.pairwise(chunks):
        assert nxt.start < prev.end  # overlap
        assert not text[nxt.start - 1].isalnum() or nxt.start == 0  # never starts mid-word
    assert all(len(c.text) <= 600 for c in chunks)


def test_chunk_short_text_is_single_chunk() -> None:
    assert [c.text for c in chunk_text("short text")] == ["short text"]
    assert chunk_text("   ") == []


def test_tokenize_drops_stopwords_and_handles_unicode() -> None:
    assert tokenize("What is the café's naïve plan?") == ["café", "naïve", "plan"]


def test_bm25_prefers_matching_passage() -> None:
    passages = ["budget meeting notes", "zebra migration routes in Africa", "lunch menu"]
    scores = bm25_scores("zebra migration", passages)
    assert scores.index(max(scores)) == 1


def test_rank_blends_vectors() -> None:
    passages = ["alpha", "beta"]
    lexical_only = rank("nothing matches", passages)
    assert lexical_only == [0.0, 0.0]
    blended = rank(
        "nothing matches", passages, passage_vectors=[[1.0, 0.0], [0.0, 1.0]], query_vector=[0.0, 1.0]
    )
    assert blended[1] > blended[0]


def _doc(text: str, n_passages: int = 0) -> DocumentSource:
    passages = tuple(Passage(i, i * 10, f"passage {i} about topic{i}") for i in range(n_passages))
    return DocumentSource("a" * 32, "doc.txt", "text", text, passages)


def test_full_mode_when_it_fits() -> None:
    ctx = build_document_context([_doc("short content")], query="q", token_budget=1000)
    assert ctx.mode == "full"
    assert "short content" in ctx.content and '<document name="doc.txt"' in ctx.content


def test_excerpt_mode_respects_budget_and_keeps_order() -> None:
    doc = _doc("x" * 50_000, n_passages=200)
    ctx = build_document_context([doc], query="topic150 topic3", token_budget=300)
    assert ctx.mode == "excerpts"
    assert ctx.tokens <= 300 + estimate_tokens(ctx.content.split("\n\n")[0]) + 50
    picked = ctx.used[doc.attachment_id]
    assert picked == sorted(picked)
    assert 150 in picked and 3 in picked


def test_notes_for_images() -> None:
    img = DocumentSource("b" * 32, "pic.png", "image", "", note="Image pic.png cannot be viewed.")
    ctx = build_document_context([img], query="q", token_budget=500)
    assert "cannot be viewed" in ctx.content


@pytest.mark.parametrize(
    ("raw", "clean"),
    [
        ("../../etc/passwd", "passwd"),
        ("C:\\Users\\me\\report.pdf", "report.pdf"),
        ("bad\x00name\n.txt", "badname.txt"),
        ("", "file"),
        ("...", "file"),
        ("a" * 300 + ".pdf", "a" * 196 + ".pdf"),
    ],
)
def test_sanitize_filename(raw: str, clean: str) -> None:
    assert sanitize_filename(raw) == clean


def test_detect_accepts_utf16_text_and_shell_scripts() -> None:
    assert detect("notes.txt", "hello".encode("utf-16")).kind == "text"
    assert detect("run.sh", b"#!/bin/sh\necho hi").kind == "code"
    with pytest.raises(UnsupportedFile):
        detect("tool.sh", b"\x7fELF\x02\x01")
