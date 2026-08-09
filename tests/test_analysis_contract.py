from backend.analysis_contract import (
    EvidenceReference,
    MethodDocument,
    MethodStep,
    compile_method_document,
    excerpt_fingerprint,
    validate_method_document,
)


def test_method_steps_require_resource_scoped_evidence_or_explicit_unknown():
    source = EvidenceReference("resource-paper-1", "page=4;section=methods")
    document = compile_method_document(
        title="controlled method",
        sources=[source],
        steps=[
            MethodStep("load", "Load data", "read input", evidence=(source,)),
            MethodStep("confirm", "Confirm threshold", "ask user", unknown_parameters=("padj",)),
        ],
    )
    assert document.to_json()["steps"][0]["evidence"][0]["resource_id"] == "resource-paper-1"


def test_method_contract_rejects_silent_unsupported_claim():
    errors = validate_method_document(
        MethodDocument(version="method-v1", title="bad", sources=(), steps=(MethodStep("s", "", ""),))
    )
    assert any("requires title" in error for error in errors)


def test_excerpt_fingerprint_does_not_store_excerpt():
    digest = excerpt_fingerprint("private paper excerpt")
    assert len(digest) == 64
    assert "private" not in digest
