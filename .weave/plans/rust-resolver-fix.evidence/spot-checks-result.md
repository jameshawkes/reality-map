# Spot-Check Gate Result (HARD GATE)

| # | Kind | fromFile | expectedTarget | actualResolvedEdges | Pass/Fail |
|---|------|----------|----------------|---------------------|-----------|
| 1 | crate:: | redpanda/src/perf_cli/summary.rs | redpanda/src/perf_cli/reader.rs | `["redpanda/src/perf_cli/reader.rs","redpanda/src/perf_cli/mod.rs"]` | ✓ PASS |
| 2 | super:: | redpanda/src/parts/hud.rs | redpanda/src/parts/mod.rs | `["redpanda/src/parts/catalog.rs","redpanda/src/parts/mod.rs"]` | ✓ PASS |
| 3 | self:: | quiver/src/physics/mod.rs | quiver/src/physics/mujoco_systems.rs | 10 edges including `quiver/src/physics/mujoco_systems.rs` | ✓ PASS |
| 4 | cross-crate | redpanda/src/main.rs | quiver/src/camera/mod.rs | `["quiver/src/camera/mod.rs","quiver/src/diagnostics/mod.rs","quiver/src/materials/mod.rs","quiver/src/textures.rs","redpanda/src/app.rs","redpanda/src/loading.rs","redpanda/src/menu/mod.rs","redpanda/src/parts/mod.rs","redpanda/src/state.rs"]` | ✓ PASS |
| 5 | mod | redpanda/src/main.rs | redpanda/src/loading.rs | present in main.rs edges (same scan as SC4) | ✓ PASS |

## Overall verdict: PASS

## Fix applied (Task 18 follow-up)

**File**: `packages/reality-map/lib/rust.js`

Added `findModuleFile(dir, allFiles)` helper that checks for `mod.rs`, `lib.rs`, `main.rs` in a directory.

In `resolveRustImport`:
- `kind === "super"`: if `walkSegments` returns `null` (first segment fails → no file found), fall back to `findModuleFile(startDir, allFiles)` — the parent module file. Also handles bare `super` (segments.length === 0) by returning the parent module file.
- `kind === "self"`: same pattern — if `walkSegments` returns `null`, fall back to `findModuleFile(startDir, allFiles)`.
- `kind === "crate"`: **unchanged** — no-fabrication rule preserved.

**Root cause of SC2 fix**: `use super::{catalog, PartId, PartPaletteRoot}` from `hud.rs` expands to three classified entries all with `kind:"super", levels:1`. `catalog` resolves to `parts/catalog.rs` (file exists). `PartId` and `PartPaletteRoot` have no corresponding file — they are items defined in `parts/mod.rs`. Previously these returned `null` (dropped). Now they return `parts/mod.rs` via `findModuleFile`.

## Test results

- **127/127 tests pass** (`npx vitest run` from `/home/james/util/reality-map-fork`)
- No-fabrication rule for `crate::doesnotexist → null` still passes (crate branch unchanged)
- All existing `super::` and `self::` tests still pass

## Notes

Warnings emitted during scan: `reality-map: mod common: #[path] attribute detected — skipping` (×6, from quiver test helpers — not relevant to spot-checks)
