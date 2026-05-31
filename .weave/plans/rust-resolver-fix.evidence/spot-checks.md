# Spot-Check Table (Gate Artifact)

These 5 entries are the hard gate for step 18. All must pass.

| # | Kind | Repo | fromFile | useStatement | expectedTarget | verified |
|---|------|------|----------|--------------|----------------|----------|
| 1 | crate:: | redpanda | redpanda/src/perf_cli/summary.rs:6 | `use crate::perf_cli::reader::DerivedSpan;` | redpanda/src/perf_cli/reader.rs | ✓ exists |
| 2 | super:: | redpanda | redpanda/src/parts/hud.rs:5 | `use super::{catalog, PartId, PartPaletteRoot};` | redpanda/src/parts/mod.rs | ✓ exists |
| 3 | self:: | redpanda | quiver/src/physics/mod.rs:320 | `use self::mujoco_systems::{…};` | quiver/src/physics/mujoco_systems.rs | ✓ exists |
| 4 | cross-crate | redpanda | redpanda/src/main.rs:4 | `use quiver::camera::OrbitCameraPlugin;` | quiver/src/camera/mod.rs | ✓ exists |
| 5 | mod | redpanda | redpanda/src/main.rs:11 | `mod loading;` | redpanda/src/loading.rs | ✓ exists |

All paths are relative to the workspace root `/home/james/gamedev/redpanda/redpanda/`.

## Notes

- No `redpanda_xxx` crate names exist in these repos. The workspace has two crates: `quiver` (library) and `redpanda` (binary). Cross-crate imports use `use quiver::…` from within the `redpanda` binary crate.
- `use self::` appears inside a function body (`build_mujoco_plugin`) at `quiver/src/physics/mod.rs:320`, not at module top-level. This is valid Rust and is the only `use self::` occurrence in the codebase.
- `use super::` at `parts/hud.rs:5` resolves to the parent module `parts`, whose items are declared in `parts/mod.rs`. The resolver must walk up one level from `hud.rs` to `parts/mod.rs`.
- `use crate::perf_cli::reader::DerivedSpan` from `perf_cli/summary.rs` resolves to `perf_cli/reader.rs` — a sibling file, reached via the crate root path.
- `mod loading;` in `main.rs` resolves to `src/loading.rs` (flat file, not a directory module).

## Verification commands run

```
ls /home/james/gamedev/redpanda/redpanda/redpanda/src/perf_cli/reader.rs   # ✓
ls /home/james/gamedev/redpanda/redpanda/redpanda/src/parts/mod.rs          # ✓
ls /home/james/gamedev/redpanda/redpanda/quiver/src/physics/mujoco_systems.rs # ✓
ls /home/james/gamedev/redpanda/redpanda/quiver/src/camera/mod.rs           # ✓
ls /home/james/gamedev/redpanda/redpanda/redpanda/src/loading.rs            # ✓
```
