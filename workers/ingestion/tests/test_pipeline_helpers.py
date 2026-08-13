from open_rag_ingestion.pipeline import batched


def test_batched_preserves_order() -> None:
    assert list(batched(["a", "b", "c", "d", "e"], 2)) == [
        ["a", "b"],
        ["c", "d"],
        ["e"],
    ]
