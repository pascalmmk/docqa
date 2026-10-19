# DocQA walkthrough and case study

## Two-minute walkthrough

Use a disposable account with a known document set. Create a short document stating a fictional policy, such as “Project Aurora support hours are 09:00–17:00 UTC on weekdays.” Keep all inputs non-sensitive.

| Time | Show | Explain |
| --- | --- | --- |
| 0:00–0:20 | Upload the example document | Ingestion runs in a background worker. |
| 0:20–0:40 | Observe processing and ready states | Parsing, chunking, and embedding precede retrieval. |
| 0:40–1:05 | Ask for the support hours | Retrieval supplies passages to answer generation. |
| 1:05–1:25 | Open the answer's citation | Compare the wording with the supporting passage. |
| 1:25–1:45 | Ask for an unspecified weekend emergency number | Observe whether the model admits missing evidence; do not promise it always will. |
| 1:45–2:00 | Show the retrieval implementation | Explain vector search, keyword search, and rank fusion. |

Record actual waiting time or label edited pauses. If the absent-answer question produces an unsupported answer, discuss it as an evaluation finding rather than silently substituting a successful result.

## Engineering case study

**Problem:** a fluent answer is not enough; users need relevant evidence and a way to inspect it.

**Implementation:** the worker prepares searchable chunks. The API searches the user's ready documents using vector similarity and PostgreSQL full-text search, combines rankings, and sends source context to the model. The browser displays streamed answers and source passages.

**Decision worth discussing:** reciprocal rank fusion combines rank positions from two retrieval methods without directly comparing their raw score scales. The current default takes eight final chunks.

**Tradeoff:** hybrid retrieval can capture both semantic matches and exact terms, but the checked implementation has no separate reranker or relevance cutoff. A top-ranked chunk is not necessarily adequate evidence.

**Evaluation boundary:** the 30-question harness checks gold-answer substring presence in retrieved chunks. It bypasses uploads, storage, queues, and PDF extraction. LLM-based faithfulness scoring is a separate, imperfect measure.

**Next evidence to publish:** the exact commit and fixture set used, successful setup commands, measured hit@8, representative misses, unsupported-question behavior, and optional answer-faithfulness results. Run only with an isolated evaluation database and intentionally configured model credentials; the harness writes records and incurs model calls.

## Capture plan

Capture a ready document, a streamed answer, and an opened citation with the supporting sentence visible. Pair the video with a small evaluation report only after executing the evaluation. No video, fresh benchmark, or live-deployment validation was produced by this documentation update.
