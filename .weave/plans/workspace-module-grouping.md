# Workspace-Aware Module Grouping (Rust) — v3

## TL;DR
> **Summary**: Teach `buildGraphForDepth()` in `lib/scan.js` to bucket Rust files by their Cargo workspace-member path relative to the scan root (e.g. `thirdparty/bevy_polyline/src/foo.rs` → module `thirdparty/bevy_polyline`, NOT `thirdparty`; and `redpanda/src/foo.rs` at depth 2 → `redpanda`, NOT `redpanda/src`) by consulting the `fileToPackage` + `packages` maps already produced by `discoverCratePackages`. File-edge counts and non-Rust bucketing must not change.
> **Estimated Effort**: Quick (≈ 1–2 Yaks)

## Context

### Original Request
After the merged Cargo-aware resolver fix (`c21c984`), file-edge resolution on `/home/james/gamedev/redpanda/redpanda` is correct (2138 internal edges, 2.6% isolated, all 5 spot-checks pass). But the **module-grouping layer** shows a misleading picture once the user views the graph at depth ≥ 2, and also at depth 1 for any workspace member whose declared path is multi-segment (e.g. `thirdparty/bevy_polyline`). The user-visible mental model "the workspace member is the module boundary" is not encoded anywhere — the bucketer is purely path-based.

### Key Findings (verified against the codebase)
- **`moduleOf(rel, depth)` is at `lib/scan.js:468–484`.** Algorithm:
  1. Split `rel` by separator, drop the filename, leaving `dirs`.
  2. If `dirs[0] === "src"` → return `"src"` (or `"src/<deeper>"` at higher depths).
  3. If `dirs[0] === "app"` → return `"app"` (or `"app/<deeper>"`).
  4. Otherwise return `dirs.slice(0, depth).join("/")`, or `"(Project Root)"` if no dirs.
- **Single call site**: `buildGraphForDepth(depth)` at `scan.js:863–870`. Builds `modFiles: Map<moduleName, Set<absFilePath>>`. All downstream module-graph data (edges, fanIn, fanOut, cycles, sort) derives from this map.
- **Concrete demonstration that current behaviour is wrong**:
  - For `thirdparty/bevy_polyline/src/foo.rs`, depth-1 `moduleOf()` returns `"thirdparty"`. Should be `"thirdparty/bevy_polyline"`.
  - For `redpanda/src/foo.rs`, depth-1 returns `"redpanda"` (correct by luck — single-segment member dir name happens to equal the workspace member path). But at depth 2 returns `"redpanda/src"`. Should still be `"redpanda"` because `src` is *inside* the member, not a peer of it.
  - For `redpanda/src/sim/world.rs`, depth-2 returns `"redpanda/src"` and depth-3 returns `"redpanda/src/sim"`. Should be `"redpanda"` at depth 1, `"redpanda/sim"` at depth 2 (one extra dir-segment after the elided `src/`), and `"redpanda/sim"` at depth 3 (no further intermediate dirs available — `world.rs` is the file itself).
- **`discoverCratePackages` is already invoked at `scan.js:778`** before the parse loop. Both `packages` and `fileToPackage` are in scope when `buildGraphForDepth` is defined inside `scanProject`. No new computation required — just thread the maps in.
- **`packages.get(name)` returns `{ root, manifest, kind }`** where `manifest` is the absolute path to the member's `Cargo.toml`. The member directory is `path.dirname(manifest)`. The relative member path (POSIX) is what we want to use as the module-name prefix.
- **`fileToPackage` covers every `.rs` file with a manifest above it.** For grouping we only act when the owning package is in `packages` (workspace members, or standalone when there is no workspace). Files outside any member (e.g. `_build/foo.cpp`, build scripts at workspace root, an excluded crate) must fall through to default `moduleOf()`.
- **Override only fires for `.rs` files owned by a workspace member.** Build artifacts (`.cpp`, `.h`, generated `.js`) inside a member dir like `redpanda/_build/openblas/foo.cpp` are NOT `.rs` and therefore are NOT touched by the override — they keep default path-based grouping. This is the right behaviour: they're not Rust crate code.
- **Existing fixture `workspace-two-crates`** has single-segment members `["core", "app"]`. With current `moduleOf()`, files in `core/src/lib.rs` already bucket to `core` at depth 1 — so testing the single-segment case alone CANNOT prove the fix is RED at depth 1. The depth-2 behaviour CAN (current returns `core/src`, post-fix returns `core`). For an unambiguous depth-1 RED test, the fixture MUST include at least one multi-segment member.
- **`uniquePackages` (`scan.js:582`) is sourced from `externalCounts.size` inside `buildInsights`.** It counts external NPM/Cargo dependencies, NOT module-graph nodes. The grouping change does not touch it.
- **`lib/impact.js:127–133` defines a separate `moduleOfPath()`** used only by impact analysis, not the dashboard's module graph. This PR deliberately does NOT change it (different consumer, different invariants). Flagged in non-goals.
- **`scan.rust.test.ts` already exists** and exercises `scanProject`. Add new tests there.

### RED-test baseline rule
Every "RED" test in step 4 must demonstrably fail against current `scan.js` before any code change. The check: for each fixture file, mentally evaluate current `moduleOf(rel, depth)` per the algorithm above. If that value differs from the post-fix expected value, the test is genuinely RED. If it matches, the test would pass even without the fix and must be dropped or reworked. Step 3 records the pre-fix `moduleOf` output for every asserted file so the RED status is auditable.

## Objectives

### Core Objective
Make module-graph buckets for `.rs` files in a Cargo workspace correspond 1:1 with workspace-member paths (relative to scan root) at every depth, without altering any file-edge data or any non-Rust bucketing.

### Deliverables
- [ ] Modified `packages/reality-map/lib/scan.js`: `buildGraphForDepth` consults `fileToPackage` + `packages` to override `moduleOf()` for `.rs` files owned by a workspace member.
- [ ] Extended fixture `packages/reality-map/__tests__/fixtures/rust/workspace-two-crates/` with one additional multi-segment workspace member.
- [ ] New tests in `packages/reality-map/__tests__/scan.rust.test.ts` (workspace-grouping `describe` block) covering: multi-segment member (depth 1 + 2 + 3), depth-2 collapse for single-segment member, cross-crate module edge, non-Rust file in member dir (fallback), out-of-workspace file (fallback), and file-edge count parity.
- [ ] Naming rule recorded in source comment and in §4 of this plan.
- [ ] Evidence at `.weave/plans/workspace-module-grouping.evidence/`: before/after summary JSON for redpanda, before/after summary JSON for a non-Rust repo (this fork), and a diff note.

### Definition of Done
- [ ] `npx vitest run` from repo root passes (prior count + new tests).
- [ ] `npx eslint packages/reality-map/lib/scan.js packages/reality-map/__tests__/scan.rust.test.ts` clean.
- [ ] On `/home/james/gamedev/redpanda/redpanda`:
  - Depth-1 nodes include `redpanda`, `quiver`, and `thirdparty/bevy_polyline` as distinct entries.
  - Neither `redpanda` nor `quiver` appears in any isolation list at depth 1.
  - At least one depth-1 edge connects `redpanda` ↔ `quiver` (from `use quiver::camera::OrbitCameraPlugin` in the redpanda crate).
  - `summary.internalEdges` is **byte-identical** to the pre-fix value (2138).
  - `summary.edgesDepth1 > 0`.
- [ ] On a non-Rust repo (this fork itself): `summary.modulesDepth1` and the `graphsByDepth[1].nodes` set are unchanged from a baseline captured before the patch.
- [ ] JSON schema unchanged: same field names; only values for Rust-workspace files change.

### Guardrails (Must NOT)
- Change `extractRustImports` / `resolveRustImport` in `lib/rust.js`.
- Change `moduleOf()`'s behaviour for any non-`.rs` file. Confirm via regression tests on `.ts`/`.js`/`.cpp` paths.
- Change `fileEdges` content, ordering, or count. Module-graph derivation only.
- Add a new top-level field to the scan result.
- Touch `lib/impact.js`'s `moduleOfPath` (separate code path; deferred).
- Touch the frontend.
- Add a runtime dependency.
- Re-walk the filesystem; reuse the existing `fileToPackage` + `packages` maps.

## Decision Log

### §3. Where the workspace-awareness injects — Option 2 (chosen)

| Option | Mechanism | Why not |
|---|---|---|
| 1. Post-process module graph | Build graph with `moduleOf()`, then rename/merge nodes | Forces a second graph pass; merging nodes after edge counts are computed is fragile. |
| 2. **Rust-aware override at bucketing call site** | Inside `buildGraphForDepth`, for `.rs` files consult `fileToPackage` + `packages` and return `<memberRel>/<inside-segments truncated to depth>`. Otherwise call existing `moduleOf()`. | Single decision point. No mutation of existing structures. Default falls through unchanged. **Chosen.** |
| 3. Generalise `moduleOf()` with Cargo rules baked in | One unified function | Bleeds workspace state into a path-only helper; hard to test in isolation. |

### §4. Naming rule — workspace member path relative to scan root (chosen)

The module-name prefix for a `.rs` file owned by a workspace member is the **member's path relative to the scan root, POSIX-separated**, exactly as it appears in the workspace `Cargo.toml`'s `members = [...]` (after glob expansion).

The full module-name computation lives in §5 below. §4 just pins the high-level rule: **member-as-unit**. A file owned by member `M` is always bucketed under `M` (in full, whether `M` is one segment or many) at every depth ≥ 1. The depth parameter only controls how many *intermediate-dir* segments **within** the member we keep — never how deep we slice **into** the member's own path.

Examples (workspace at scan root) — computed against the rule in §5:
- `members = ["app"]`, file `app/src/main.rs` → depth 1: `app`. Depth 2: `app` (no intermediate dirs between `src/` and `main.rs`). Depth 3: `app`.
- `members = ["core"]`, file `core/src/lib.rs` → depth 1: `core`. Depth 2: `core`. Depth 3: `core`.
- `members = ["redpanda"]`, file `redpanda/src/sim/world.rs` → depth 1: `redpanda`. Depth 2: `redpanda/sim`. Depth 3: `redpanda/sim` (only one intermediate dir available).
- `members = ["redpanda"]`, file `redpanda/src/sim/physics/rigid.rs` → depth 1: `redpanda`. Depth 2: `redpanda/sim`. Depth 3: `redpanda/sim/physics`.
- `members = ["thirdparty/bevy_polyline"]`, file `thirdparty/bevy_polyline/src/poly.rs` → depth 1: `thirdparty/bevy_polyline`. Depth 2: `thirdparty/bevy_polyline`. Depth 3: `thirdparty/bevy_polyline`.
- `members = ["thirdparty/vendored_lib"]`, file `thirdparty/vendored_lib/src/sub/util.rs` → depth 1: `thirdparty/vendored_lib`. Depth 2: `thirdparty/vendored_lib/sub`. Depth 3: `thirdparty/vendored_lib/sub`.
- `members = ["crates/*"]` expanded to `crates/foo`, `crates/bar` → file `crates/foo/src/lib.rs` → depth 1: `crates/foo`. Same per-member treatment.

Rationale: matches what the user sees in `Cargo.toml`'s `members` declaration AND in their file tree. Package name (`redpanda_core`) is the right concept for the *resolver* (already used there) but the wrong concept for the *visualiser* — `core/Cargo.toml` happens to declare `name = "redpanda_core"` but the user navigates the directory as `core`.

Special cases (no override; falls back to default `moduleOf()`):
- Member dir IS the scan root (single-crate-at-root) → member-relative path is `""` → override returns `null`.
- File is `.rs` but `fileToPackage` returns null OR `packages.get(name)` is undefined (excluded crate, stray `.rs` at workspace root with no `[package]`, file under a dir with no Cargo.toml above it inside the scan).
- File is not `.rs` (override is never consulted; guarded by `ext === ".rs"` check at the call site).

### §5. Module-name computation for member-owned `.rs` files

**Rule (canonical):** the module name at depth `d` for a `.rs` file owned by workspace member `M` is:
1. The member's path relative to scan root (`M`), joined with
2. up to `(d − 1)` additional dir segments taken from the file's path inside the member, **after the leading `src/` (if any) is elided**.

`src/` is **always elided** when it is the first segment inside the member. The user wants `redpanda → quiver` at depth 1, not `redpanda/src → quiver/src`; and inside `src/` the meaningful boundary is `sim/`, `render/`, etc., not the `src/` directory itself.

#### Pseudocode

```js
function memberModuleName(fileRel, memberRel, depth) {
  // fileRel:   "thirdparty/vendored_lib/src/sub/util.rs"
  // memberRel: "thirdparty/vendored_lib"
  // depth:     2

  // 1. Strip member prefix + leading slash.
  let remainder = fileRel.slice(memberRel.length).replace(/^\//, "");
  // remainder: "src/sub/util.rs"

  // 2. Elide leading "src/" inside the member, always.
  if (remainder.startsWith("src/")) remainder = remainder.slice(4);
  // remainder: "sub/util.rs"

  // 3. Drop the filename, leaving only intermediate-dir segments.
  const dirParts = remainder.split("/").slice(0, -1);
  // dirParts: ["sub"]

  // 4. Take up to (depth - 1) intermediate dirs.
  const takeN = Math.max(0, depth - 1);
  const extra = dirParts.slice(0, takeN);
  // extra: ["sub"]

  // 5. Join member + extras with "/".
  return extra.length ? `${memberRel}/${extra.join("/")}` : memberRel;
}
```

#### Worked examples (every one matches an assertion in step 4)

| memberRel | fileRel | depth | remainder after step 2 | dirParts | takeN | extra | result |
|---|---|---|---|---|---|---|---|
| `core` | `core/src/lib.rs` | 1 | `lib.rs` | `[]` | 0 | `[]` | `core` |
| `core` | `core/src/lib.rs` | 2 | `lib.rs` | `[]` | 1 | `[]` | `core` |
| `app` | `app/src/main.rs` | 1 | `main.rs` | `[]` | 0 | `[]` | `app` |
| `app` | `app/src/main.rs` | 2 | `main.rs` | `[]` | 1 | `[]` | `app` |
| `thirdparty/vendored_lib` | `thirdparty/vendored_lib/src/lib.rs` | 1 | `lib.rs` | `[]` | 0 | `[]` | `thirdparty/vendored_lib` |
| `thirdparty/vendored_lib` | `thirdparty/vendored_lib/src/lib.rs` | 2 | `lib.rs` | `[]` | 1 | `[]` | `thirdparty/vendored_lib` |
| `thirdparty/vendored_lib` | `thirdparty/vendored_lib/src/sub/util.rs` | 1 | `sub/util.rs` | `["sub"]` | 0 | `[]` | `thirdparty/vendored_lib` |
| `thirdparty/vendored_lib` | `thirdparty/vendored_lib/src/sub/util.rs` | 2 | `sub/util.rs` | `["sub"]` | 1 | `["sub"]` | `thirdparty/vendored_lib/sub` |
| `thirdparty/vendored_lib` | `thirdparty/vendored_lib/src/sub/util.rs` | 3 | `sub/util.rs` | `["sub"]` | 2 | `["sub"]` | `thirdparty/vendored_lib/sub` |
| `redpanda` | `redpanda/src/sim/world.rs` | 2 | `sim/world.rs` | `["sim"]` | 1 | `["sim"]` | `redpanda/sim` |
| `redpanda` | `redpanda/src/sim/physics/rigid.rs` | 3 | `sim/physics/rigid.rs` | `["sim", "physics"]` | 2 | `["sim", "physics"]` | `redpanda/sim/physics` |

#### Why the member is always preserved in full

Even when `depth < memberSegs(M)` (e.g. depth 1 against `thirdparty/vendored_lib`), the result is the full member path. This is the v3 decision: the member is the *unit*, never sliced below. Same for `crates/foo` at depth 1. This means at depth 1, the node set may include some multi-segment names — that is correct and matches `Cargo.toml`'s `members = [...]` declaration verbatim.

#### Files-without-`src/` inside a member

If a member happens to put `.rs` files at its own root (e.g. `redpanda/build.rs` if `build.rs` is part of the package — usually it isn't bucketed as a crate file, but in case): step 2 is a no-op (no leading `src/`), and step 3 gives `dirParts = []` → result is `memberRel`. Same outcome. The elision is opt-in to the `src/` prefix, not mandatory.

#### Pin in a code comment

Add a comment above `memberModuleName` in `scan.js` stating: "v3 rule: `src/` inside a workspace member is always elided from the module path. Depth controls only how many intermediate-dir segments **inside** the member (after `src/`) we keep — never how we slice the member path itself."

## TODOs

- [x] 1. Branch + baselines
  **What**: Create branch `fix/workspace-module-grouping` off current main. Run `npx vitest run` from repo root and record the pass count (must be ≥ 127). Capture three baselines:
    - Run the CLI against `/home/james/gamedev/redpanda/redpanda` with `--summary-json`, save to `.weave/plans/workspace-module-grouping.evidence/before-redpanda.json`. Record `summary.internalEdges`, `summary.isolatedInternalFiles`, `summary.edgesDepth1`, and the full `graphsByDepth[1].nodes` and `graphsByDepth[2].nodes` lists.
    - Run the CLI against `/home/james/util/reality-map-fork` itself (a JS/TS project) with `--summary-json`, save to `.weave/plans/workspace-module-grouping.evidence/before-nonrust.json`. Record `summary.modulesDepth1` and the `graphsByDepth[1].nodes` set.
    - Identify ONE single-crate Rust project on disk (no `[workspace]` table; if none available, skip this baseline and document the gap). Scan and save to `before-singlecrate.json`.
  **Files**: three JSON files under `.weave/plans/workspace-module-grouping.evidence/`
  **Acceptance**: Branch created. Pass count recorded. Three (or two, if no single-crate available) baseline JSONs exist with the listed fields.

- [x] 2. Diagnose & document the current bucketing
  **What**: In `lib/scan.js`, add a 4–6 line block comment above `moduleOf` (lines 468–484) summarising the current algorithm verbatim. Also add a comment explaining that for `.rs` files in a Cargo workspace this function is overridden inside `buildGraphForDepth` to bucket by member-relative path (forward reference to the new helper). Explicitly note: the override only fires when (a) file is `.rs`, AND (b) `fileToPackage` says the file is owned by a workspace member present in `packages`. Build artifacts (`.cpp`, `.h`, etc.) inside a member dir keep default path-based grouping because they fail check (a). No behaviour change in this step.
  **Files**: `packages/reality-map/lib/scan.js`
  **Acceptance**: Comment present. `npx vitest run` still passes.

- [x] 3. Extend the fixture
  **What**: Add a multi-segment workspace member to the existing `workspace-two-crates` fixture (do NOT create a new fixture — keeps the test setup compact and lets the existing single-segment tests double as non-regression coverage):
    - Edit `__tests__/fixtures/rust/workspace-two-crates/Cargo.toml` to `members = ["core", "app", "thirdparty/vendored_lib"]`.
    - Create `__tests__/fixtures/rust/workspace-two-crates/thirdparty/vendored_lib/Cargo.toml` with `[package] name = "vendored_lib" version = "0.1.0" edition = "2021"`.
    - Create `__tests__/fixtures/rust/workspace-two-crates/thirdparty/vendored_lib/src/lib.rs` with a stub like `pub fn ping() {}`.
    - Create a deeper file `__tests__/fixtures/rust/workspace-two-crates/thirdparty/vendored_lib/src/sub/util.rs` to exercise depth-3 inside-segments (REQUIRED — step 4 tests 3 and 4 depend on this file existing). Wire a `mod sub;` in `lib.rs` and a `pub mod util;` in `sub/mod.rs` so the resolver builds a file edge (lets us prove file-edge parity AND module aggregation).
    - Add a `__tests__/fixtures/rust/workspace-two-crates/notes/scratch.rs` file OUTSIDE any workspace member (so no Cargo.toml in `notes/`) to exercise the out-of-workspace fallback. Verify by inspection that `discoverCratePackages` will return `fileToPackage.get(notes/scratch.rs)` as undefined (workspace root has no `[package]` and `notes/` has no Cargo.toml).
  Also add a tiny non-Rust file `__tests__/fixtures/rust/workspace-two-crates/app/scripts/build.js` (NOT `.rs`) to assert non-Rust fallback inside a member dir.
  **Files**: 4–6 new files under the fixture; 1 edit to its root `Cargo.toml`
  **Acceptance**: `find` shows the new layout. Manually compute and record in commit body what current `moduleOf` returns at depth 1, 2, 3 for each new file — needed to keep step 4 RED tests honest.

- [x] 4. RED — write the failing tests first
  **What**: In `scan.rust.test.ts`, add `describe("workspace module grouping", ...)`. For every test below, the body states "current returns X; v3 expects Y" so RED status is auditable. Expectations are recomputed against the §5 v3 rule (which elides `src/` inside members and treats the member as a unit).
  
  Tests (10 cases; 6 RED, 4 non-RED):
    1. **Multi-segment member, depth 1** — file `thirdparty/vendored_lib/src/lib.rs` → module `thirdparty/vendored_lib`. Current returns `thirdparty`. **RED.**
    2. **Multi-segment member, depth 2 (stability)** — same file → `thirdparty/vendored_lib`. Current returns `thirdparty/vendored_lib` (coincidence — both member segments fit in depth 2). Not RED. Asserts stability between depths 1 and 2 for member-bounded buckets.
    3. **Multi-segment member with inside dir, depth 2** — file `thirdparty/vendored_lib/src/sub/util.rs` → `thirdparty/vendored_lib/sub`. Current returns `thirdparty/vendored_lib` (depth 2 path-based slice). **RED.**
    4. **Multi-segment member with inside dir, depth 3** — same file → `thirdparty/vendored_lib/sub` (still one extra dir; takeN=2 but dirParts has only one entry). Current returns `thirdparty/vendored_lib/src`. **RED** (this is the `src/`-elision proof at the multi-segment case).
    5. **Single-segment member, depth 2 collapse** — file `core/src/lib.rs` → `core`. Current returns `core/src`. **RED.**
    6. **Single-segment member, depth 3 collapse** — same file → `core`. Current returns `core/src` (depth 3 still hits the path-based slice at length 2). **RED** (this is the `src/`-elision proof at the single-segment case).
    7. **Cross-crate edge at depth 2** — the file edge `app/src/main.rs → core/src/lib.rs` produces a depth-2 module edge `app → core`. Verify the fixture's `app/src/main.rs` actually contains `use redpanda_core::...` (or the package name declared in `core/Cargo.toml`) so the resolver generates the file edge; if not, add one line. Current depth-2 behaviour: edge is between `app/src` and `core/src`. **RED.** (At depth 1 this edge already exists as `app → core` today via the single-segment coincidence — that's covered by an existing test or as a stability assertion; no need for a depth-1 RED here.)
    8. **Out-of-workspace `.rs` fallback** — file `notes/scratch.rs` (no Cargo.toml above it inside the fixture; workspace root has no `[package]`, so `fileToPackage` doesn't claim it) → `notes` at depth 1 (default path-based). Current returns `notes`. Not RED. Fallback regression assertion.
    9. **Non-Rust file inside member dir** — file `app/scripts/build.js` → `app` at depth 1 (current `moduleOf` hits the `dirs[0] === "app"` branch and returns `app`; `dirs.slice(1, 1)` is empty). Post-fix MUST also return `app` (override guarded by `ext === ".rs"`). Not RED. Non-regression assertion.
    10. **File-edge parity** — capture `summary.internalEdges` from a current-code run on the (now-extended) fixture. Hardcode the value in the test (e.g. `expect(summary.internalEdges).toBe(N)`). Assert equality post-fix. Not RED unless the resolver breaks. Tripwire.
  
  Final RED count: **6 RED gates** (tests 1, 3, 4, 5, 6, 7). 4 non-RED (tests 2, 8, 9, 10). The non-RED tests are stability / fallback / non-regression assertions and MUST pass against current code (run them once before any code change to prove they were written correctly).
  
  Run `npx vitest run packages/reality-map/__tests__/scan.rust.test.ts`. Tests 1, 3, 4, 5, 6, 7 must FAIL with the expected shapes:
    - test 1: `expected "thirdparty/vendored_lib", got "thirdparty"`
    - test 3: `expected "thirdparty/vendored_lib/sub", got "thirdparty/vendored_lib"`
    - test 4: `expected "thirdparty/vendored_lib/sub", got "thirdparty/vendored_lib/src"`
    - test 5: `expected "core", got "core/src"`
    - test 6: `expected "core", got "core/src"`
    - test 7: depth-2 edges include `app → core`; current shows `app/src → core/src`.
  Tests 2, 8, 9, 10 must PASS against current code.
  **Files**: `packages/reality-map/__tests__/scan.rust.test.ts`
  **Acceptance**: 6 RED + 4 GREEN against unmodified `scan.js`. Record the exact failure messages in the commit body.

- [x] 5. GREEN — implement override + wire into `buildGraphForDepth`
  **What**: In `lib/scan.js`:
    1. Define a module-scope helper `rustModuleOf(file, depth, rustCtx)` just above `buildGraphForDepth` (around line 860). `rustCtx = { root, fileToPackage, packages }`. Algorithm exactly as §5 above. Returns `null` to signal fallback for: missing `fileToPackage` entry, missing `packages` entry, or member-rel resolving to `""` (single-crate-at-root).
    2. Inside `scanProject`, just before the `for (let depth = 1; depth <= maxDepth; depth++)` loop at line 1085, precompute `const rustCtx = { root, fileToPackage, packages };` so it's closed over by `buildGraphForDepth`.
    3. In `buildGraphForDepth` at line 867, replace the single bucketing line with:
       ```
       const ext = path.extname(f).toLowerCase();
       const mod = (ext === ".rs" ? rustModuleOf(f, depth, rustCtx) : null) ?? moduleOf(rel, depth);
       ```
  Re-run `npx vitest run packages/reality-map/__tests__/scan.rust.test.ts`. All 10 tests must now pass.
  **Files**: `packages/reality-map/lib/scan.js`
  **Acceptance**: 10/10 new workspace-grouping tests green. No other test file modified.

- [x] 6. Full regression suite
  **What**: `npx vitest run` from repo root. All previously-passing tests must still pass. Scan output for any prior test asserting a specific Rust module name like `core/src` or `app/src` — none should exist (prior Rust tests focused on resolver edges, not module bucketing), but confirm.
  **Files**: none
  **Acceptance**: All tests green. Total = pre-fix count + 10.

- [x] 7. Lint pass
  **What**: `npx eslint packages/reality-map/lib/scan.js packages/reality-map/__tests__/scan.rust.test.ts`.
  **Files**: none
  **Acceptance**: Zero new errors. Pre-existing warnings tolerated.

- [x] 8. Validate against redpanda
  **What**: Run CLI on `/home/james/gamedev/redpanda/redpanda` with `--summary-json`, save to `.weave/plans/workspace-module-grouping.evidence/after-redpanda.json`. Assert:
    - `summary.internalEdges` **byte-identical** to `before-redpanda.json` (2138 expected).
    - `summary.isolatedInternalFiles` byte-identical (no file-edge data changed).
    - `summary.edgesDepth1 > 0`.
    - `graphsByDepth[1].nodes` contains entries with IDs `redpanda`, `quiver`, `thirdparty/bevy_polyline` (exact names from the workspace's `Cargo.toml`).
    - `graphsByDepth[1].nodes` does NOT contain both `redpanda` and `redpanda/src` as distinct entries.
    - `graphsByDepth[1].edges` contains at least one edge between `redpanda` and `quiver` (either direction). Justification: `redpanda/src/main.rs` imports `quiver::camera::OrbitCameraPlugin`, so a file edge exists; under the new bucketer both ends sit in distinct depth-1 modules, so the module edge must appear.
    - At depth 2, `redpanda` and `quiver` still appear as top-level nodes (no resurrection of `redpanda/src`).
  Write a one-page summary to `.weave/plans/workspace-module-grouping.evidence/diff.md` with before/after numbers and a short prose verdict.
  **Files**: `after-redpanda.json`, `diff.md`
  **Acceptance**: All seven bullets above hold and are evidenced in `diff.md`.

- [x] 9. Validate non-Rust unchanged
  **What**: Run CLI on `/home/james/util/reality-map-fork` (JS/TS) with `--summary-json`, save to `after-nonrust.json`. Diff against `before-nonrust.json`. `summary.modulesDepth1` and `graphsByDepth[1].nodes` set must be identical. Edge counts must be identical. Acceptable drift: only timestamps or generation metadata. If there's a single-crate Rust baseline, repeat the same diff for it.
  **Files**: `after-nonrust.json`, optionally `after-singlecrate.json`
  **Acceptance**: Diffs are empty modulo metadata. Record outcome in `diff.md`.

- [ ] 10. Commit + push
  **What**: Single commit on `fix/workspace-module-grouping`. Title: `fix(rust): workspace-aware module grouping`. Body lists: before/after metrics on redpanda, non-Rust diff verdict, test count delta, the §4 naming rule in one line, and the §5 inside-segments rule in one line. Push to origin. Do NOT open a PR — leave that to the user.
  **Acceptance**: Branch pushed. Commit body contains all listed facts.

## Risk Register

| Risk | Mitigation |
|---|---|
| File-edge count silently changes | Test 10 (fixture parity tripwire) + step 8 assertion (redpanda parity). |
| Non-Rust file bucketing changes | Test 9 (`app/scripts/build.js` fallback) + step 9 (non-Rust repo diff). Override is guarded by `ext === ".rs"` so this is structurally impossible, but assert anyway. |
| `.cpp` / `.h` / generated artifacts inside a member dir get Rust-ified | Same guard. `redpanda/_build/openblas/foo.cpp` is not `.rs` → override never fires → default `moduleOf()` runs → bucket is `redpanda/_build` (or shallower depending on depth). Explicitly state in step 2 comment. |
| Single-crate-at-root regression (member dir IS scan root) | Override returns `null` when member-rel is empty → default `moduleOf()` runs → `src/` and `app/` collapses preserved. Covered by step 1 single-crate baseline + step 9 diff. |
| Multi-segment member like `thirdparty/bevy_polyline` shows as a 2-segment depth-1 node | This is correct, not a bug. That's what `members = [...]` declares. Documented in §4 and asserted in step 8. |
| Excluded crate (has `[package]` but not in `members`) | `packages.get(name)` returns undefined → override returns `null` → default `moduleOf()` runs. Same behaviour as today. |
| `uniquePackages` field changes | Sourced from `externalCounts.size` in `buildInsights`, independent of module bucketing. Confirmed by reading `scan.js:582`. No change possible from this PR. |
| `lib/impact.js` uses a different bucketer (`moduleOfPath:127-133`) | Out of scope for this PR. Impact analysis is a separate consumer with its own invariants; touching it here would expand scope without evidence the dashboard's impact view is broken. Tracked as known divergence in non-goals. |
| Fixture extension breaks an existing test that walks `workspace-two-crates` and asserts exact crate count | Search `scan.rust.test.ts` and any other test file for `workspace-two-crates` references during step 3; update count assertions if needed. New member adds 1 to crate count and ≥ 2 to `.rs` file count. |
| Test on a different machine fails on absolute fixture paths | Use `path.resolve(__dirname, "../fixtures/rust/...")` — mirror the pattern already used in `scan.rust.test.ts`. |
| `src/` elision inside a member could surprise readers expecting raw paths | v3 decision: `src/` IS elided (rationale in §5 — every Rust crate puts code under `src/`, so it adds noise). Pin in code comment above `memberModuleName`. RED tests 4 and 6 lock the elision in; stability test 2 confirms it doesn't double-elide. |

## Non-Goals

- Do NOT change the Rust resolver (`extractRustImports`, `resolveRustImport`) from `c21c984`.
- Do NOT change file-edge data — only module-graph aggregation.
- Do NOT change bucketing for `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.py`, `.go`, `.cpp`, `.h`, or any other non-`.rs` extension.
- Do NOT rename `summary.modulesDepth1`, `summary.edgesDepth1`, or `graphsByDepth` fields. Only values change for Rust-workspace files.
- Do NOT touch `lib/impact.js:127-133` (`moduleOfPath`). It is a separate bucketing path used by impact analysis only. The dashboard's module graph comes from `scan.js`'s `buildGraphForDepth`, which is the only thing this PR rewires. Aligning the two is a separate, larger change that requires evidence the impact view's grouping is also wrong — not collected yet.
- Do NOT modify the frontend.
<!-- v3: the "do not collapse src/ inside a workspace member" rule from v2 was reversed. v3 elides src/ always. See §5. -->

## Verification

Run from `/home/james/util/reality-map-fork`:

```
# Tests + lint
npx vitest run
npx eslint packages/reality-map/lib/scan.js packages/reality-map/__tests__/scan.rust.test.ts

# Redpanda validation (replace CLI invocation with the actual entry point from bin/)
node packages/reality-map/bin/reality-map.js scan /home/james/gamedev/redpanda/redpanda --summary-json \
  > .weave/plans/workspace-module-grouping.evidence/after-redpanda.json

# Edge-count parity
diff <(jq '.summary.internalEdges, .summary.isolatedInternalFiles' .weave/plans/workspace-module-grouping.evidence/before-redpanda.json) \
     <(jq '.summary.internalEdges, .summary.isolatedInternalFiles' .weave/plans/workspace-module-grouping.evidence/after-redpanda.json)

# Expected depth-1 nodes present
jq -r '.graphsByDepth["1"].nodes[].id' .weave/plans/workspace-module-grouping.evidence/after-redpanda.json \
  | grep -E '^(redpanda|quiver|thirdparty/bevy_polyline)$'

# Cross-crate edge present
jq '.graphsByDepth["1"].edges[] | select((.from == "redpanda" and .to == "quiver") or (.from == "quiver" and .to == "redpanda"))' \
  .weave/plans/workspace-module-grouping.evidence/after-redpanda.json

# Non-Rust unchanged
node packages/reality-map/bin/reality-map.js scan /home/james/util/reality-map-fork --summary-json \
  > .weave/plans/workspace-module-grouping.evidence/after-nonrust.json
diff <(jq '.graphsByDepth["1"].nodes | map(.id) | sort' .weave/plans/workspace-module-grouping.evidence/before-nonrust.json) \
     <(jq '.graphsByDepth["1"].nodes | map(.id) | sort' .weave/plans/workspace-module-grouping.evidence/after-nonrust.json)
```

Verify the exact CLI entry path, JSON shape (`.id` vs `.name`, `.from`/`.to` vs `.source`/`.target`), and summary-flag name against `bin/` in step 1. The shape used above is illustrative.

Expected results:
- All tests pass (prior count + 10).
- ESLint clean.
- `internalEdges` / `isolatedInternalFiles` diffs are empty.
- Three expected depth-1 node IDs present on redpanda.
- At least one `redpanda ↔ quiver` edge present.
- Non-Rust depth-1 nodes diff is empty.

## Changes from v1

1. **Fixture cannot prove the change** — fixed by step 3, which extends `workspace-two-crates` with a multi-segment member `thirdparty/vendored_lib`, an out-of-workspace `notes/scratch.rs`, and a non-Rust `app/scripts/build.js`. Original single-segment members alone could not exercise the bug at depth 1; multi-segment member now does.
2. **RED tests' baseline was wrong** — fixed by step 4, which explicitly computes current `moduleOf()` output per asserted file and only marks tests as RED when the current output differs from the post-fix expectation. After v3 rule changes (always elide `src/`), honest count is **6 genuinely-RED tests** (multi-segment depth 1; multi-segment depth-2 and depth-3 inside-segments; single-segment depth-2 and depth-3 collapse; cross-crate edge at depth 2). The other 4 tests are stability / fallback / non-regression / tripwire assertions, each labelled explicitly in the test body. See the v2 → v3 subsection below for the per-test promotions.
3. **Naming rule reframed** — §4 now states "workspace member path relative to scan root" everywhere, with worked examples for single-segment, multi-segment, and glob-expanded members. Added §5 spelling out exactly how depth interacts with multi-segment member paths and inside-segments.
4. **Build artifacts in member dirs** — clarified in §key-findings, step 2 comment, and the risk register: override fires only when `ext === ".rs"` AND `fileToPackage` recognises the file as owned by a workspace member. `.cpp`/`.h`/generated files in `redpanda/_build/` keep default path-based grouping.

Additional refinements:
- Added `uniquePackages` note to the risk register (sourced from `externalCounts.size`, unaffected).
- Added step 8 (redpanda validation) with explicit assertions on `redpanda`/`quiver`/`thirdparty/bevy_polyline` depth-1 node presence and `redpanda ↔ quiver` edge presence.
- Added step 9 (non-Rust regression) running the CLI on this fork itself and diffing depth-1 nodes.
- Explicit non-goal entry for `lib/impact.js:127-133` (`moduleOfPath`) — separate bucketing path, deferred.
- Pinned the §5 decision and added stability tests to lock it in (note: v3 reverses this — see Changes from v2 → v3 below).

## Changes from v2 → v3

1. **§5 depth math was wrong.** v2's `extraDepth = depth − memberSegs` formula made `core/src/lib.rs` at depth 2 → `core/src` (contradicting v2's own TL;DR which said `core`). Replaced with the canonical rule: result = `memberRel` + up to `(depth − 1)` intermediate-dir segments taken from the member-relative remainder **after eliding a leading `src/`**. §5 now contains the full pseudocode and an 11-row worked-examples table mapping directly to step 4's tests.
2. **`src/` elision reversed.** v2 said "do NOT collapse `src/` inside a member"; v3 says **always elide leading `src/` inside a member**. Rationale: every idiomatic Rust crate puts code under `src/`, so including it adds noise without information. The user wants `redpanda → quiver` at depth 1, not `redpanda/src → quiver/src`. This is the rule that makes the TL;DR, §4 examples, and step 4 expectations all internally consistent. Risk-register row updated; the conflicting non-goal entry was removed (marked with a v3 comment).
3. **Step 8 bullet count corrected.** Acceptance said "All six bullets" but the bullet list had seven. Now says "All seven bullets".
4. **Step 4 test expectations recomputed against the v3 rule.** Now **6 RED tests** (was 3 in v2):
   - Test 1 (multi-segment depth 1): unchanged, still RED.
   - Test 3 (multi-segment + inside dir, depth 2): NEW RED — current returns `thirdparty/vendored_lib`, v3 expects `thirdparty/vendored_lib/sub`.
   - Test 4 (multi-segment + inside dir, depth 3): NEW RED — proves `src/` elision at multi-segment case.
   - Test 5 (single-segment depth 2 collapse): unchanged, still RED.
   - Test 6 (single-segment depth 3 collapse): NEW RED — v2 marked this as coincidence-green; v3 elides `src/` so post-fix is `core` while current is `core/src`.
   - Test 7 (cross-crate edge depth 2): unchanged, still RED.
5. **Test count uplifted from 9 to 10.** Added an explicit stability test (test 2) separating it from test 3 to make the multi-segment depth-2 coincidence visible. Tests 5 and 6 unchanged (renumbered; "single-segment depth 2" stays as the simplest RED gate, "depth 3" becomes a second RED gate proving the elision generalises). Steps 5, 6, and the verification "Expected results" updated to reflect +10.
