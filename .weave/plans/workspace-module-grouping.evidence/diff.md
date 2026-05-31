# Validation Evidence — Workspace Module Grouping Patch

Generated: 2026-05-31

---

## Redpanda — Before vs After

| Metric               | Before  | After   | Match? |
|----------------------|---------|---------|--------|
| `internalEdges`      | 2138    | 2138    | ✓ IDENTICAL |
| `isolatedInternalFiles` | 104  | 104     | ✓ IDENTICAL |
| `edgesDepth1`        | 3       | 3       | ✓ > 0 |
| `modulesDepth1`      | 7       | 7       | ✓ IDENTICAL |

---

## Redpanda — Depth-1 Node List

**After (patched):**
```
thirdparty/bevy_polyline, quiver, _build, profiles, redpanda, Scripts, tools
```

**Required nodes present:**
- `redpanda` ✓
- `quiver` ✓
- `thirdparty/bevy_polyline` ✓

**`redpanda/src` absent from depth-1 nodes:** ✓ (not present — no resurrection of src sub-path)

**`redpanda` and `redpanda/src` NOT both present as distinct entries:** ✓

---

## Redpanda — Depth-1 Edges

```
quiver -> thirdparty/bevy_polyline
redpanda -> thirdparty/bevy_polyline
redpanda -> quiver
```

**`redpanda → quiver` edge exists at depth 1:** ✓

---

## Redpanda — Depth-2 Nodes (sample)

```
_build/openblas-build, _build/openblas-src, _build/shim-test, _build/simbody-build,
_build/simbody-build-eigen, _build/simbody-shim-build, profiles,
quiver, quiver/subspace, quiver/camera, quiver/diagnostics, quiver/physics,
quiver/atmosphere, quiver/celestial, quiver/loading, quiver/rendering, quiver/clouds,
quiver/materials, quiver/control, quiver/media, quiver/parts, quiver/profiling,
quiver/benches, quiver/tests,
redpanda, redpanda/builder, redpanda/perf_cli, redpanda/menu, redpanda/parts,
redpanda/assets, redpanda/bin, redpanda/examples, redpanda/tests,
Scripts, thirdparty/bevy_polyline, thirdparty/bevy_polyline/examples, tools/vscode-redpanda
```

**`redpanda` present at depth 2:** ✓
**`quiver` present at depth 2:** ✓
**`redpanda/src` absent at depth 2 (no resurrection):** ✓

---

## Non-Rust (reality-map-fork) — Before vs After

| Metric          | Before | After | Match? |
|-----------------|--------|-------|--------|
| `modulesDepth1` | 5      | 10    | ✗ DIFFERS |
| `internalEdges` | 131    | 133   | ✗ DIFFERS |

**Explanation:** The patch commit (`c21c984`) added 39 new Rust test fixture files
(`packages/reality-map/__tests__/fixtures/rust/**`) to the repo. These files are
now included in the scan of `reality-map-fork` itself, legitimately increasing
`files` (119→124), `modulesDepth1` (5→10), and `internalEdges` (131→133).

This is **not a regression** — the scan is accurate. The baseline was taken before
the patch was applied. The new fixture files form new module groups at depth 1
(e.g. `packages/reality-map/__tests__/fixtures/rust/single-crate`,
`workspace-two-crates`, etc.) and add internal edges between them.

The non-Rust JS/TS resolution logic is unchanged; the delta is purely from new
files added to the repo by the patch itself.

---

## All 7 Acceptance Checks (Task 8)

1. `summary.internalEdges == 2138` ✓ (2138 == 2138)
2. `summary.isolatedInternalFiles == 104` ✓ (104 == 104)
3. `summary.edgesDepth1 > 0` ✓ (3 > 0)
4. `graphsByDepth[1].nodes` contains `redpanda`, `quiver`, `thirdparty/bevy_polyline` ✓
5. `graphsByDepth[1].nodes` does NOT contain both `redpanda` and `redpanda/src` ✓ (`redpanda/src` absent)
6. `graphsByDepth[1].edges` contains `redpanda -> quiver` ✓
7. At depth 2, `redpanda` and `quiver` still appear, no `redpanda/src` resurrection ✓

---

## Overall Verdict

**PASS** — All 7 redpanda checks pass. Non-Rust metric delta is explained by new
test fixture files added by the patch commit itself (not a regression in JS/TS
resolution). The Rust workspace grouping fix is correct and does not break
non-Rust scanning.
