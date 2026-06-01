# polytope-server smoke test results

## Without --follow-deps
- files: 72
- internalEdges: 152
- externalRefs: 539
- isolatedInternalFiles: 15

## With --follow-deps
- files: 14,442 (200x growth)
- internalEdges: 61,641 (405x growth)
- externalRefs: 29,505
- isolatedInternalFiles: 1,718
- depCount: 538 external crates
- fileCount: 14,370 .rs files added
- scanMs: 30,299 ms (~30s — within 60s timeout)

## Bits-broker integration (the motivating case)
- bits-broker .rs files scanned: 34
- frontend → bits-broker resolved edges: 30

## Notes
- 887 cycles surfaced at higher depths (registry crates have lots of internal cycles — normal)
- `extern crate alloc` warnings fire (legacy syntax, dropped — by design)
- modulesDepth1 grew from 12 → 484 (mostly `deps/<crate>` synthetic IDs)
- Scan time acceptable for one-shot operator use; not interactive-fast
