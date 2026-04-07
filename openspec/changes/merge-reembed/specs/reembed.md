# Spec: Re-embed After Merge

## Requirement: Vector Update on Text Change

When autoDream merges two or more memories into one, the resulting memory SHALL have its embedding vector regenerated from the merged text.

### Scenario: Successful merge with re-embed
- GIVEN two duplicate memories with IDs A and B
- WHEN autoDream merges them into memory A with combined text
- THEN the embedding vector for memory A is regenerated using `embedder.embed(mergedText)`
- AND the new vector is written to LanceDB alongside the updated text
- AND memory B is deleted

### Scenario: Embedding API failure during merge
- GIVEN a merge operation that updates text
- WHEN the embedding API call fails (timeout, rate limit, etc.)
- THEN the merge proceeds with the old vector (graceful degradation)
- AND a warning is logged: `[autodream] re-embed failed for {id}, keeping old vector: {error}`

### Scenario: Text-only update (time normalization, etc.)
- GIVEN a memory whose text is modified by time-normalizer or stale-cleaner
- WHEN the text change is semantically significant (not just whitespace)
- THEN the vector SHOULD also be re-embedded
- AND if the text change is minor (whitespace only), re-embed MAY be skipped

## Requirement: Embedder Access

autoDream SHALL receive the embedder instance from lancedb-pro's plugin context or from its own configuration.

### Scenario: Embedder available via plugin config
- GIVEN `autodream.config.embeddingModel` is set (e.g., "text-embedding-3-small")
- WHEN autoDream initializes
- THEN it creates its own embedder instance for re-embedding

### Scenario: Embedder not available
- GIVEN no embedding configuration
- WHEN autoDream runs merge operations
- THEN merges proceed without re-embedding (current behavior)
- AND a warning is logged once per run
