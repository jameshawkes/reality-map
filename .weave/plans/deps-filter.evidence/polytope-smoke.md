# polytope-server --deps-filter smoke test

Real run on `/home/james/work/code/polytope-server` comparing unfiltered `--follow-deps` against `--deps-filter='^bits'`.

## Unfiltered (`--follow-deps`)

```
files:               14,442
scanMs:              32,027 ms
modulesDepth1:       484
edgesDepth1:         982
internalEdges:       61,641
externalRefs:        29,505
uniquePackages:      3,554
followDeps:          { depCount: 538, fileCount: 14,370 }
```

## Filtered (`--follow-deps --deps-filter='^bits'`)

```
files:               106
scanMs:              473 ms
modulesDepth1:       13
edgesDepth1:         2
internalEdges:       410
externalRefs:        650
uniquePackages:      100
followDeps:          { depCount: 1, fileCount: 34, filter: "^bits" (implied in CLI line) }
bits-broker files:   34
frontend → bits-broker resolved edges: 30
```

## Delta

| Metric | Unfiltered | Filtered | Reduction |
|---|---|---|---|
| files | 14,442 | 106 | 99.3% |
| scanMs | 32,027 | 473 | 68× faster |
| internalEdges | 61,641 | 410 | 99.3% |
| modulesDepth1 | 484 | 13 | 97.3% |
| depCount | 538 | 1 | 99.8% |

## Verdict

PASS. The filter applies at `extractExternalDeps` and short-circuits before the file walker runs, so the cost saving is real (not just a UI filter on a fully-walked scan). The motivating case — "I only want bits, not every transitive dep" — is satisfied.

Note: the filter matched only the `bits` crate (depCount: 1), not all three `bits-broker` siblings (`bits-server`, `bits-py`). That's because `bits-server` and `bits-py` aren't actually depended on by polytope-server itself — they're sibling crates inside the bits-broker repo that only get pulled in if a workspace member depends on them. Cargo metadata only reports actually-resolved deps, not "everything in the same git repo".

If the user wanted all three, they'd use `--deps-filter='^bits' --follow-deps` on a project that depends on all three.
