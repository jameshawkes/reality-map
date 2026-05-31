# Rust Module Resolution Fix (TDD) — v3

## TL;DR
> **Summary**: Rewrite Rust import extraction and add a Cargo-aware resolver as a new `lib/rust.js` module wired into the existing `scanProject` pipeline in `lib/scan.js`. Drive every change test-first with `vitest`, prefer under-resolving to inventing edges, prove correctness on James's redpanda repos with both an aggregate metric gate AND a hand-picked spot-check table.
> **Estimated Effort**: Medium (≈ 7–9 Yaks)

## Context

### Original Request
Fix Rust resolution in the reality-map fork at `/home/james/util/reality-map-fork`. Current state on a 325-file Rust workspace: 37 internal edges, 278 isolated files (86%), `edgesDepth1 = 0`, 517 unresolved external refs. End goal: redpanda + its 4 sibling Cargo workspaces render as connected graphs.

### Key Findings (verified against the codebase)
- **`lib/scan.js` is 1090 LoC.** Public API is `module.exports = { scanProject }` at line 1090. The `scan` name does not exist — all plan references use `scanProject`.
- **Bugs in `extractRustImports` (lines 248–282)**:
  - Line 264 drops `crate::` (treated identically to `std/core/alloc`).
  - Line 256 `raw.split("::")[0]` collapses group imports `use {a, b}` and deep paths.
  - `super` / `self` branches (lines 258–263) truncate to first segment after the prefix.
  - External crate names like `rand` survive as barewords but `resolveRel` (line 380) early-returns on anything not starting with `.` or `/`, so cross-workspace edges die.
  - `mod foo;` handling (line 274) works for siblings — preserve.
- **Two integration touchpoints in `scan.js`** (real edits, not a refactor):
  - **Dispatch site at lines 144–149**: the `extractImports(src, filePath)` switch. Replace `.rs` arm to call the new `lib/rust.js` extractor.
  - **Edge-building loop at lines 787–820**: per-file `for (const s of importData.specs)` resolves edges. Add a Rust-specific arm that consumes the new `classified` field and pushes resolved targets into the existing `fileEdges` array. These edges flow into the existing `resolvedEdgesMap` at lines 1059–1064 — no new top-level field.
- **Downstream consumers of `fileDetails`** that the plan MUST NOT break:
  - `lib/impact.js:13–29` reads `fileDetails.imports[file].specs` as **string array**.
  - `lib/deadcode.js:95–109` reads `fileDetails.imports` and `fileDetails.resolvedEdges`.
  - `lib/unreachable.js:98–224` reads `fileDetails.imports`, `fileDetails.resolvedEdges`.
  - Implication: `specs` must remain a `string[]` per file. New Rust data (`classified`) is **additive** on the per-file `importData` object — never displaces `specs`. Resolved Rust edges flow into the existing `resolvedEdges` map exactly like JS/TS/Go edges already do.
- **Existing `resolvedEdges` surface** (`scan.js:1059–1085`): keyed by POSIX-relative file path, values are POSIX-relative target arrays. We reuse this verbatim.
- **Package shape**: `packages/reality-map/package.json` declares **zero runtime dependencies**. The CLI is intentionally dep-free → hand-rolled Cargo.toml parser.
- **Test harness**: 6 test files in `__tests__/`, all `.test.ts`, all use `vitest` + `createRequire`. No fixtures dir exists yet. Repo runs `npx vitest run` from workspace root.
- **README** only mentions Rust in the supported-extensions table (line 241).
- **Targets confirmed present**: `/home/james/gamedev/redpanda/{redpanda,redpanda-physics,redpanda-terrain,redpanda-vessel-builder,redpanda-wasm}`.

## Objectives

### Core Objective
Produce a correct, dependency-free, Cargo-aware Rust resolver wired into `scanProject` that **never invents edges** and produces a connected module graph for real Rust workspaces, with full TDD coverage and zero regressions in TS/JS/Python/Go or in `impact`/`deadcode`/`unreachable`.

### Deliverables
- [ ] New `packages/reality-map/lib/rust.js` exporting `parseCargoToml`, `discoverCratePackages`, `extractRustImports`, `resolveRustImport`.
- [ ] New test file `packages/reality-map/__tests__/scan.rust.test.ts`.
- [ ] On-disk fixtures under `packages/reality-map/__tests__/fixtures/rust/`.
- [ ] Minimal edits at the two named touchpoints in `packages/reality-map/lib/scan.js`.
- [ ] Hand-picked redpanda spot-check table (5 known-correct expected resolutions) recorded in `.weave/plans/rust-resolver-fix.evidence/spot-checks.md` BEFORE the smoke test.
- [ ] Before/after `--summary-json` captures plus a diff in `.weave/plans/rust-resolver-fix.evidence/`.
- [ ] README paragraph in `packages/reality-map/README.md`.
- [ ] Preflight scan of unsupported idioms in target repos, results recorded.

### Definition of Done
- [ ] `npx vitest run` from repo root: all prior tests pass, all new Rust tests pass.
- [ ] `npx eslint packages/reality-map/lib/scan.js packages/reality-map/lib/rust.js` clean.
- [ ] **All 5 redpanda spot-checks resolve to the exact expected file** (step 18). If any one fails, the gate fails regardless of aggregate metrics.
- [ ] AND on `/home/james/gamedev/redpanda/redpanda` and `/home/james/gamedev/redpanda/redpanda-physics`: `edgesDepth1 > 0`, `internalEdges` ≥ 10× baseline, `isolatedInternalFiles / scannedFiles < 0.30`.
- [ ] Output JSON schema unchanged: same `fileDetails.imports[file].specs` string-array shape; resolved edges land in existing `fileDetails.resolvedEdges` map.

### Guardrails (Must NOT)
- Add any runtime dependency to `packages/reality-map/package.json`.
- Change the shape of `fileDetails.imports[file].specs` (must stay `string[]`).
- Introduce a parallel resolved-edge field — reuse `fileDetails.resolvedEdges`.
- Introduce a `scanWarnings` / `warnings` field on the scan result. Warnings go to stderr only (see step 14b).
- Resolve any `.rs` import via the generic `resolveRel` or `resolveAlias` path. Rust uses `resolveRustImport` exclusively.
- Double-resolve `mod foo;` (once via `classified` and again via `specs`). `classified` is the single source.
- Touch resolver behaviour for `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.py`, `.go`.
- Implement macro expansion, `#[path = "…"]`, `extern crate`, or `pub use` re-export following.
- Re-walk the FS for Cargo discovery per-file (cache parent-directory lookups).
- Fabricate edges. Half-resolved → attribute to deepest matched file; zero-resolved → drop and skip.

## TODOs

- [x] 1. Baseline & branch
  **What**: Create branch `fix/rust-resolver`. Run `npx vitest run` from repo root and capture pass count (expected: 73). Run the CLI against `/home/james/gamedev/redpanda/redpanda` and `redpanda-physics` with `--summary-json`. Save to `.weave/plans/rust-resolver-fix.evidence/before-{repo}.json`.
  **Files**: `.weave/plans/rust-resolver-fix.evidence/before-redpanda.json`, `before-redpanda-physics.json`
  **Acceptance**: Both JSON files exist; contain `internalEdges`, `isolatedInternalFiles`, `edgesDepth1`. Baseline test count recorded in commit body.

- [x] 2. Unsupported-idiom preflight
  **What**: Grep all 5 redpanda repos for unsupported idioms and record counts:
    - `rg -c '#\[path\s*=' /home/james/gamedev/redpanda/*/`
    - `rg -c '^\s*pub use' /home/james/gamedev/redpanda/*/`
    - `rg -c '^\s*extern crate' /home/james/gamedev/redpanda/*/`
    - `rg -c 'macro_rules!' /home/james/gamedev/redpanda/*/` (and any `include!` for module bodies)
  Record findings in `.weave/plans/rust-resolver-fix.evidence/preflight.md`. If counts are non-trivial (>20 in any category), the plan stands but step 11 must emit a per-file warning when these are encountered and conservatively **drop** the edge rather than guess.
  **Files**: `.weave/plans/rust-resolver-fix.evidence/preflight.md`
  **Acceptance**: File exists and lists per-repo counts for the four idioms.

- [x] 3. Hand-picked spot-check table (gate artifact)
  **What**: Before any code changes, hand-pick exactly 5 real `use` lines / `mod` declarations from the redpanda workspaces — one of each kind — and document the exact target file each should resolve to. This becomes the gate in step 18.
  Required coverage:
    - one `use crate::…::Item` within a single crate
    - one `use super::…` (or `super::super::…`)
    - one `use self::…`
    - one cross-crate `use redpanda_xxx::…` between workspace members
    - one `mod foo;` declaration
  Record each as: `{ fromFile (relative), useStatement, expectedTarget (relative) }`.
  **Files**: `.weave/plans/rust-resolver-fix.evidence/spot-checks.md`
  **Acceptance**: 5 entries, all five categories present, each with a verified expected target (open the file, confirm the path on disk).

- [x] 4. Stub `lib/rust.js` and dispatch wiring
  **What**: Create `packages/reality-map/lib/rust.js` exporting placeholders that **preserve current behaviour** by delegating to the existing inline `extractRustImports` logic. In `scan.js:144–149`, replace the `.rs` arm to call `require("./rust.js").extractRustImports`. Do not change any other behaviour yet. Purpose: surface area in place, all 73 tests still green, ready for TDD.
  **Files**: `packages/reality-map/lib/rust.js` (new), `packages/reality-map/lib/scan.js` (one-line change at line 148)
  **Acceptance**: `npx vitest run` — 73/73 still pass. `node -e "require('./packages/reality-map/lib/rust.js')"` succeeds.

- [x] 5. Fixture tree (on-disk)
  **What**: Build `packages/reality-map/__tests__/fixtures/rust/` with eight subtrees. On-disk over temp-dirs because (a) Cargo discovery walks parents → real `..` exercised, (b) fixtures double as docs, (c) read-only cleanup is free.
  Subtrees:
    - `single-crate/` — `Cargo.toml` + `src/lib.rs` (`mod a;`) + `src/a.rs` + `src/a/sub.rs`
    - `nested-mods/` — `src/main.rs` (`mod a; mod b;`) + `src/a.rs` (`mod sub;`) + `src/a/sub.rs` + `src/b.rs`
    - `workspace-two-crates/` — root `[workspace] members = ["core", "app"]` + `core/` (`name = "redpanda_core"`) + `app/src/main.rs` with `use redpanda_core::Thing;`
    - `group-imports/` — single crate with `use crate::{a, b::{c, d}};`
    - `super-self/` — `src/a/mod.rs` with `use super::shared::X; use self::child::Y;`
    - `glob-import/` — `use crate::prelude::*;` resolving to `src/prelude.rs`
    - `custom-lib-path/` — `Cargo.toml` with `[lib] path = "src/custom_root.rs"`
    - `workspace-with-excluded/` — root `[workspace] members = ["a", "b"]`; standalone `c/Cargo.toml` not in members; files in `c/` are scanned but not treated as a workspace dep target
  **Files**: 8 subdirectories under `packages/reality-map/__tests__/fixtures/rust/`
  **Acceptance**: `fd -t f . packages/reality-map/__tests__/fixtures/rust/ | wc -l` ≥ 22.

- [x] 6. RED: Cargo.toml parser tests
  **What**: In `scan.rust.test.ts` add tests for `parseCargoToml(text)` covering MUST-handle cases (the parser must not desync on any of these):
    - extracts `[package].name`
    - returns null name when no `[package]` section
    - **virtual manifest**: `[workspace]` with no `[package]` parses cleanly and exposes `workspace.members`
    - extracts `[lib].path` when set; defaults to `src/lib.rs` otherwise
    - extracts `[[bin]]` entries with name+path (array-of-tables)
    - extracts `[workspace].members` as array (single-line and multi-line `[`…`]`)
    - **CRLF line endings** parse identically to LF
    - **mid-line comments**: `name = "x" # trailing comment` → `name == "x"`
    - **multiline strings**: `description = """long\nblock\n"""` followed by `[lib] path = "src/x.rs"` — `[lib].path` is still found (parser must skip enclosed lines, not treat `[lib]` inside the string as a section)
    - same for `'''…'''`
    - **inline tables**: `lib = { path = "src/x.rs" }` is safely ignored without crashing or desyncing (we don't need to parse it for v1, but it must not break subsequent sections); tolerated, documented as a limitation
    - tolerates unknown sections without errors
  **Files**: `packages/reality-map/__tests__/scan.rust.test.ts`
  **Acceptance**: ~11 failing tests in this group.

- [x] 7. GREEN: minimal Cargo.toml parser
  **What**: Implement `parseCargoToml` in `lib/rust.js`. Strategy:
    1. Normalise CRLF → LF.
    2. Two-pass: pass 1 scans for triple-quote opens (`"""` / `'''`), advances past matching closes, marks those line ranges as "inside string — skip in pass 2". Tracks single-line strings inline.
    3. Pass 2 walks lines outside string ranges; handles section headers `[x]` and `[[x]]`, key=value pairs, single-line and multi-line arrays.
    4. Strip mid-line `# ...` comments only when outside quoted regions.
    5. Inline tables `{ ... }` are detected and skipped (the value is discarded; section continues).
    6. Return `{ package?: {name}, lib?: {path}, bin: [{name,path}], workspace?: {members: []} }`. On any parse anomaly, return what's been parsed so far (best-effort); never throw.
  **Files**: `packages/reality-map/lib/rust.js`
  **Acceptance**: All step-6 tests pass. **Regression gate**: `npx vitest run` — 73 baseline + new tests all green.

- [x] 8. RED: Cargo discovery tests
  **What**: Tests for `discoverCratePackages(root, files)` returning `{ packages: Map<name, {root, manifest, kind}>, fileToPackage: Map<absRsFile, name> }`.
  Tests (using fixtures):
    - `single-crate: name → src/lib.rs root; all .rs files map to "single_crate"`
    - `workspace-two-crates: both members discovered; app/src/main.rs → "app", core/src/lib.rs → "redpanda_core"`
    - `workspace-with-excluded: only a, b are in `packages`; files in c/ have fileToPackage entry pointing at `c` (the local manifest) but `c` is NOT marked as a workspace member — cross-crate imports to it from a/b must NOT resolve (asserted in resolver tests later)`
    - `custom-lib-path: lib root is src/custom_root.rs`
    - `file outside any Cargo.toml maps to undefined owner without throwing`
    - `does NOT re-read Cargo.toml files already seen` (spy on `fs.readFileSync`; assert called once per unique manifest)
    - `parent-walk is memoised per directory` (instrument a counter inside the helper)
    - `members glob "crates/*" expands against the FS` (single `*` only)
  **Files**: `packages/reality-map/__tests__/scan.rust.test.ts`
  **Acceptance**: 8 failing tests added.

- [x] 9. GREEN: Cargo discovery + per-dir memo cache
  **What**: Implement `discoverCratePackages`. Algorithm:
    1. For each `.rs` file's directory, walk up to find the nearest `Cargo.toml`. **Memo cache** keyed by directory path → resolved manifest path (so a 70-file crate touches the manifest once).
    2. Parse each unique manifest once.
    3. If `[workspace].members` present, expand `*` globs against FS (one level only); build the canonical member set.
    4. Compute `srcRoot` from `[lib].path` || `src/lib.rs` || first `[[bin]].path` || `src/main.rs`.
    5. Build `fileToPackage` by deepest-Cargo.toml-wins (a file under `workspace/a/src/x.rs` maps to `a`, not the workspace root).
    6. **Virtual manifests** (workspace root with no `[package]`) are recorded only as workspace metadata, not as a package.
    7. **Excluded crates** (have `Cargo.toml` but not listed in any workspace's `members`) are present in `fileToPackage` for local resolution within that directory but are excluded from cross-crate `external` resolution from other members.
  **Files**: `packages/reality-map/lib/rust.js`
  **Acceptance**: Step 8 tests pass. **Regression gate**: `npx vitest run` all green.

- [x] 10. RED: `extractRustImports` v2 tests
  **What**: Tests for the rewritten extractor. Returns `{ specs, details, classified }` where:
    - `specs: string[]` — **backwards-compatible** strings used by `impact.js` / `deadcode.js` / `unreachable.js`. For Rust: `./foo` for `mod`, `"crate::a::b"` for crate paths, the bareword first segment for external. Never an object.
    - `details: { spec, line, statement }[]` — unchanged shape.
    - `classified: { kind, segments, levels?, glob?, line, raw }[]` — new, consumed only by the Rust resolver arm in `scan.js`.
  Specific tests:
    - `use crate::a::b::C; → classified[0] = { kind:"crate", segments:["a","b","C"] }`
    - `use crate::{a, b::{c, d}}; → three classified entries, kind:"crate", segments [["a"],["b","c"],["b","d"]]`
    - `use a::b::{self, c}; → expands to ["a","b"] and ["a","b","c"]`
    - `use super::super::x::Y; → { kind:"super", levels:2, segments:["x","Y"] }`
    - `use self::child::Y; → { kind:"self", segments:["child","Y"] }`
    - `use rand::Rng; → { kind:"external", segments:["rand","Rng"] }`
    - `use std::collections::HashMap; → dropped (not in classified)`
    - `use core::fmt; / use alloc::vec::Vec; → dropped`
    - `use crate::prelude::*; → { kind:"crate", segments:["prelude"], glob:true }`
    - `use foo::bar as Baz; → alias stripped, segments:["foo","bar"]`
    - `mod foo; → { kind:"mod", segments:["foo"] }`
    - `// use crate::x::Y; → ignored`; same for `/* ... */`
    - `pub use crate::a::B; → captured as kind:"crate"` (still a real dep)
    - `use crate  ::  a :: b ;` (whitespace) → parsed correctly
    - multi-line `use crate::{\n  a,\n  b::c,\n};` parsed
    - **Backwards-compat assertion**: for every test above, `specs` is `string[]` (use `expect(Array.isArray(out.specs)).toBe(true)` and `expect(out.specs.every(s => typeof s === "string")).toBe(true)`)
  **Files**: `packages/reality-map/__tests__/scan.rust.test.ts`
  **Acceptance**: ~15 failing tests added.

- [x] 11. GREEN: rewrite `extractRustImports`
  **What**: Implement in `lib/rust.js`. Strategy:
    1. Strip `//…` and `/*…*/` comments.
    2. Find each `use …;` statement (multi-line tolerant; scan until terminating `;` at brace depth 0).
    3. Recursive group expander: `a::b::{c, d::{e, f}}` → `a::b::c`, `a::b::d::e`, `a::b::d::f`. Handle `self` inside groups (`a::{self, b}` → `a` and `a::b`).
    4. Strip ` as X` aliases. Detect glob `*` → `glob:true`, drop the `*` segment.
    5. Classify by first segment: `crate` / `super` (count consecutive `super::` prefixes) / `self` / drop if `std`/`core`/`alloc` / else `external`.
    6. Extract `mod foo;` declarations (preserve current behaviour); emit `./foo` into `specs` so existing `mod`-chain handling continues to work.
    7. Populate `specs` per the backwards-compat rule.
    8. **Conservative fallback for unsupported idioms**: when the source contains `#[path = "…"] mod foo;`, do NOT emit `./foo` (the path attribute would point elsewhere and we'd mis-resolve). Emit a warning entry into a sidecar **helper-local** `warnings: string[]` on the return object — this is transient, internal to the Rust integration code path, and is drained to stderr by step 14 before the scan result is built. Same for `extern crate` (drop). `pub use` is fine. **Invariant**: no `warnings` or `scanWarnings` field ever appears on the final scan result object emitted by `scanProject` — see step 14b.
  **Files**: `packages/reality-map/lib/rust.js`
  **Acceptance**: Step 10 tests pass. **Regression gate**: `npx vitest run` all green.

- [x] 12. RED: `resolveRustImport` unit tests (pure helper, no scan integration)
  **What**: Tests for `resolveRustImport(fromFile, classifiedSpec, ctx)` where `ctx = { cratePackages, fileToPackage, allFiles: Set<absPath> }`. Returns absolute path string or `null`.
  Tests use the on-disk fixtures and assemble `ctx` by calling `discoverCratePackages` directly.
    - `crate::a in single-crate from src/lib.rs → src/a.rs`
    - `crate::a::sub from src/lib.rs → src/a/sub.rs`
    - `crate::a::sub::Item → src/a/sub.rs (item-in-file: last existing file wins for remaining segments)`
    - `crate::a::b::c → src/a.rs (b and c are items inside src/a.rs)`
    - **No-fabrication rule**: `crate::doesnotexist::anything → null` (first segment after `crate::` has no file/dir match → drop the edge entirely; do NOT map to crate root)
    - `super::shared::X from src/a/mod.rs → src/shared.rs`
    - `super::super::x from src/a/b.rs → src/x.rs (or src/x/mod.rs)`
    - `self::child from src/a.rs → src/a/child.rs`
    - `external redpanda_core::Thing from workspace-two-crates/app/src/main.rs → workspace-two-crates/core/src/lib.rs`
    - `external rand::Rng → null`
    - `external excluded_crate::Thing from a member of workspace-with-excluded → null (c/ is not a workspace member)`
    - `mod ./foo from src/lib.rs → src/foo.rs or src/foo/mod.rs`
    - `glob crate::prelude::* → src/prelude.rs (target = the parent module file)`
    - `custom-lib-path: crate::x resolves from custom_root.rs's directory`
    - Path normalization: assertions written with POSIX separators; output passes through `path.posix.normalize` at the boundary.
  **Files**: `packages/reality-map/__tests__/scan.rust.test.ts`
  **Acceptance**: ~14 failing tests added.

- [x] 13. GREEN: implement `resolveRustImport`
  **What**: In `lib/rust.js`. Algorithm per classified spec:
    - `mod`: existing `resolveRel` semantics (`./foo` → `foo.rs` / `foo/mod.rs`).
    - `crate`: start at owning package's `srcRoot` directory.
    - `super`: walk `levels` directories up from `path.dirname(fromFile)`; if `fromFile` is `foo/mod.rs`, treat `foo/` as the module dir (don't double-pop).
    - `self`: start at `path.dirname(fromFile)` (or `foo/` for `foo/mod.rs`).
    - `external`: look up first segment in `cratePackages`; **only treat as resolvable if the package is a workspace member or the same-package root**. If not a workspace member (e.g. an excluded local crate, or a third-party crate), return `null`. Segments shift left by one and resolution proceeds from that crate's `srcRoot` dir.
    - **Segment walk**: try `dir/seg.rs`, `dir/seg/mod.rs`, `dir/seg/lib.rs` in `allFiles`, in that order. If `seg+1` fails to resolve under `dir/seg/`, return the **last file** that did resolve (item-in-file rule).
    - **No-fabrication rule**: if the **first** segment fails to resolve to ANY file/dir, return `null`. Half-resolved is fine and represents item-in-file; zero-resolved is dropped.
    - Glob sentinel (`glob:true`): return the parent module file already found; if no parent file resolved, return `null`.
    - All return paths go through `path.posix.normalize` so Windows users get POSIX-style edges in `resolvedEdges`.
  **Trade-off (documented in code comment)**: under-resolves in rare cases (real edges that needed item-in-file fallback when the first segment also happened to be an item-only) but never invents edges. This is the correct bias for agent-monitoring.
  **Files**: `packages/reality-map/lib/rust.js`
  **Acceptance**: Step 12 tests pass. **Regression gate**: `npx vitest run` all green.

- [x] 14. Wire into scan pipeline (integration)
  **Invariant (applies to this step and all downstream Rust handling)**: For `.rs` files, all import edges flow through `resolveRustImport`. The generic `resolveRel` path is never reached for `.rs`. The generic `resolveAlias` path is never reached for `.rs`. `mod foo;` is resolved exclusively as `classified` entries of `kind: "mod"` via `resolveRustImport` — `importData.specs` is NOT replayed through `resolveRel` for `.rs`.
  **What**: Edit `scan.js` at the two named touchpoints:
    1. **Lines 144–149 (dispatch)**: already wired in step 4 — confirm it now calls the v2 `extractRustImports` and returns `{ specs, details, classified, warnings }`. `specs` continues to flow into `fileImports` map → `fileDetails.imports` for downstream-consumer shape compatibility only (`impact.js`/`deadcode.js`/`unreachable.js` read it as `string[]`). For `.rs`, `specs` is **not** consumed by the edge-building loop.
    2. **Lines 787–820 (edge-building loop)**: before the loop, call `const cratePackages = discoverCratePackages(root, files);` once. Inside the loop, when `ext === ".rs"`:
        - **Branch entirely out of the generic resolver flow.** Do not enter the `if (s.startsWith(".") || s.startsWith("/"))` arm. Do not enter the `resolveAlias` arm. Do not iterate `importData.specs` here at all.
        - Iterate `importData.classified` and call `resolveRustImport(f, c, { cratePackages, fileToPackage, allFiles: fileSet })` for every entry, including `kind: "mod"`. This is the single resolution path for Rust.
        - For each resolved target, push `[f, tgt]` into `fileEdges` (same array JS/Go/Python populate).
        - For unresolved `external` whose first segment is not in `cratePackages` (real third-party crates like `serde`, `tokio`), bump `externalCounts` so the "top external" panel still reflects real deps.
        - `importData.warnings` (if any) is sent to stderr via the existing logging path used elsewhere in `scan.js` (search for `console.warn` / `process.stderr` usage and match the style). No new field is added to the scan result object — see step 14b for the rationale.
    3. Confirm the resolved Rust edges land in `resolvedEdgesMap` (scan.js:1059–1064) automatically because that map is built from `fileEdges`.
  **Files**: `packages/reality-map/lib/scan.js`
  **Acceptance**:
    - All prior 73 tests still pass (no JS/TS/Py/Go regression).
    - `fileDetails.imports[file].specs` is `string[]` for every Rust file (asserted via a dedicated regression test).
    - A new integration test invokes `scanProject(fixturePath)` against `single-crate` and `workspace-two-crates` and asserts the expected edges land in `fileDetails.resolvedEdges`.
    - **No double-counting of `mod` edges**: integration test against `nested-mods` asserts that for each `mod foo;` declaration there is **exactly one** entry in `resolvedEdges[from]` pointing to the resolved target (not two).
    - **Generic-path isolation**: a targeted test mocks/spies `resolveRel` (or asserts via instrumentation) and confirms it is never called with a `.rs` `fromFile`. Same for `resolveAlias`.
    - **Regression gate**: `npx vitest run` all green.

- [x] 14b. Confirm `scanWarnings` is NOT introduced (shape guard decision)
  **What**: This step makes the warnings-channel decision explicit so it isn't accidentally revisited. **Decision: stderr only, no new scan-result field.** Rationale: keeps the diff small, keeps the JSON contract surface untouched, removes any risk of a downstream consumer (current or future) coupling to a `scanWarnings` / `warnings` field. The CLI already has a stderr channel and that's the natural place for "we saw `#[path = ...]` and dropped the edge" messages.
  Verification: run `rg -n "scanWarnings|\\.warnings\\b" packages/reality-map/` and confirm no current consumer reads such a field. If the grep returns hits in any non-Rust-related file, re-evaluate before proceeding.
  **Files**: none modified; this is a verification + decision record.
  **Acceptance**: grep returns no consumer hits; commit body notes the stderr-only decision.

- [x] 15. End-to-end mod-chain reachability test (post-integration)
  **What**: Now that the resolver is wired, add an integration test using the `nested-mods` fixture: call `scanProject(fixturePath)`, assert `fileDetails.resolvedEdges` contains `main.rs → a.rs`, `main.rs → b.rs`, `a.rs → a/sub.rs`, and confirm `a/sub.rs` does not appear in any "isolated" summary field. This validates the mod-chain transitive case end-to-end against the real pipeline (previously planned as step 12 in v1, but reaches into the scan API so it belongs after step 14).
  **Files**: `packages/reality-map/__tests__/scan.rust.test.ts`
  **Acceptance**: Test passes without any additional production code changes. If it fails, fix the layer where the bug actually lives — if the resolver helper is correct in isolation (step 13 tests still pass) but integration in `scan.js` mis-wires the call (e.g. wrong `ctx` shape, missed `kind: "mod"` dispatch), fix `scan.js`; otherwise fix `lib/rust.js`. Do not paper over a resolver bug at the integration layer or vice versa. **Regression gate**: `npx vitest run` all green.

- [x] 16. Downstream shape regression test
  **What**: Add a dedicated test that loads `scanProject` against the `single-crate` fixture and feeds the result into `computeImpact` (from `lib/impact.js`) with a synthetic changed file. Asserts no throw and a reasonable answer. Proves the `specs:string[]` contract held by `impact.js:18` is not broken for Rust files.
  **Files**: `packages/reality-map/__tests__/scan.rust.test.ts`
  **Acceptance**: Test passes; no shape errors.

- [x] 17. Lint & full test sweep
  **What**: `npx eslint packages/reality-map/lib/scan.js packages/reality-map/lib/rust.js` and `npx vitest run` from repo root. Capture totals.
  **Acceptance**: Zero lint errors. All baseline + new tests green. Commit body records the new total.

- [x] 18. Spot-check gate on redpanda (HARD GATE — overrides aggregates)
  **What**: Run `scanProject` against `/home/james/gamedev/redpanda/redpanda` (and against the workspace root containing all 5 sibling crates if cross-crate edges are part of the spot-checks). For each of the 5 entries in `.weave/plans/rust-resolver-fix.evidence/spot-checks.md`, look up `fileDetails.resolvedEdges[fromFile]` and assert the expected target file appears in the resolved list — exactly that file, not "any file", not "deepest reachable".
  Write outcomes to `.weave/plans/rust-resolver-fix.evidence/spot-checks-result.md` as a pass/fail table.
  **Files**: `.weave/plans/rust-resolver-fix.evidence/spot-checks-result.md`
  **Acceptance**: **All 5 entries pass**. If any one fails, return to step 13 and refine — the gate is binary. Aggregate metrics in step 19 are checked only after this passes.

- [x] 19. Aggregate smoke-test gate on redpanda
  **What**: With the spot-check gate green, run the patched CLI against `redpanda` and `redpanda-physics`. Capture `--summary-json` to `.weave/plans/rust-resolver-fix.evidence/after-{repo}.json`. Diff against baseline.
  **Files**: `.weave/plans/rust-resolver-fix.evidence/after-redpanda.json`, `after-redpanda-physics.json`, `diff.md`
  **Acceptance**: For both repos: `edgesDepth1 > 0`, `internalEdges ≥ 10× baseline`, `isolatedInternalFiles / scannedFiles < 0.30`. `diff.md` summarises numbers.

- [x] 20. README note
  **What**: Add a paragraph after the supported-languages table in `packages/reality-map/README.md` covering: Cargo + workspace awareness, what resolves (`use crate::`, group imports, `mod`, `super`, `self`, cross-workspace `use`), the under-resolve-not-invent bias, and explicit limitations (`macro_rules!`-generated modules, `#[path = "…"]` attributes, `extern crate`, `pub use` re-export retargeting, inline-table `lib = { path = … }` in Cargo.toml).
  **Files**: `packages/reality-map/README.md`
  **Acceptance**: Paragraph reads clearly, lists all five limitations, matches existing doc tone.

- [ ] 21. Commit-ready branch
  **What**: Clean history on `fix/rust-resolver`. Commit message body records: baseline test count, new test count, before/after aggregate numbers for both redpanda repos, and the spot-check pass table. Do NOT push or open the PR.
  **Acceptance**: `git diff main --stat` shows: `lib/rust.js` new, `lib/scan.js` small delta at the two named touchpoints, `__tests__/scan.rust.test.ts` new, `__tests__/fixtures/rust/**` new, `README.md` modified, `.weave/plans/**` new evidence files.

## Verification

- [ ] `npx vitest run` from repo root: previous 73 tests + new Rust tests all pass.
- [ ] `npx eslint packages/reality-map/lib/scan.js packages/reality-map/lib/rust.js` clean.
- [ ] Spot-check gate (step 18): all 5 hand-picked edges resolve to the exact expected target file.
- [ ] Aggregate gate (step 19): both redpanda repos meet the three thresholds.
- [ ] `fileDetails.imports[file].specs` is `string[]` for every file (no shape drift).
- [ ] `fileDetails.resolvedEdges` is the only resolved-edge surface (no parallel field).
- [ ] No new entries in `packages/reality-map/package.json` deps.

## Risk Register

1. **Regression in downstream consumers (`impact.js`, `deadcode.js`, `unreachable.js`).** They all read `fileDetails.imports[file].specs` as `string[]` and (where applicable) `fileDetails.resolvedEdges`. Mitigation: `specs` shape is contractually preserved (step 10 has an explicit assertion; step 16 has a downstream shape regression test). New Rust data lives in the additive `classified` field only consumed by the scan loop.
2. **Output schema drift.** Frontend reads `summary.{internalEdges, edgesDepth1, …}` and `graph.{nodes, edges}`. We change values, not keys. No new top-level fields in `summary`.
3. **Performance on large workspaces.** Discovery is O(files × parent-walks) worst case but each unique directory's parent walk is cached, and each Cargo.toml is parsed once. For redpanda (5 crates × ~70 files avg), expect <50 ms. Acceptance: log a warning if discovery exceeds 1 s. **Honest claim**: this is not formally O(n) — it's O(unique-dirs × workspace-depth) for discovery + O(files × max-segments) for resolution, which is effectively linear in practice but not in theory.
4. **Hand-rolled TOML parser drift.** Covers MUST-handle cases enumerated in step 6. Inline tables for `lib`/`bin` are tolerated-but-not-parsed (documented limitation). Real-world Cargo.toml files rarely use inline-table layout for `lib`/`bin`.
5. **Edge fabrication risk.** Mitigated by the no-fabrication rule in step 13: zero-resolved first segment → `null`, never crate-root fallback. Spot-check gate in step 18 enforces this against known-correct answers.
6. **Path-separator drift on Windows.** All resolver outputs pass through `path.posix.normalize` at the boundary (step 13). All test assertions written in POSIX form (step 12).
7. **Workspace-member glob expansion.** Single `*` only; no `**` or `?`. Documented as a limitation in the README note.
8. **Unsupported idioms in real targets.** Preflight in step 2 surfaces volume. Step 11 emits warnings and drops edges rather than guessing for `#[path]` and `extern crate`. `pub use` follows the path but does not retarget the edge — documented.
9. **Mod-chain regression.** Step 15 validates end-to-end against `nested-mods` after wiring. If broken, fix the layer where the bug actually lives — `lib/rust.js` if the resolver helper is wrong, `scan.js` if integration wiring is wrong. Match the fix to the failure mode rather than constraining the location up front.

## Non-Goals / Explicit Deferrals
- Macro-generated modules (`macro_rules!`, proc-macros, `include!`).
- `#[path = "alt.rs"] mod foo;` — warn and drop.
- Legacy `extern crate foo;` — warn and drop.
- Following `pub use crate::a::B as C;` to retarget edges to original sites — v2 follow-up.
- Conditional compilation (`#[cfg(…)] mod`) — treated as always-present.
- Cargo features affecting which modules are compiled — treated as always-on.
- Inline-table `lib = { path = "…" }` / `bin = { … }` — tolerated by parser but not honoured; falls back to default layout.

## Changes from v1 (Weft review trail)

**Blocking issues addressed:**

1. **Sequencing (step 12 vs 14 — chose Option A, split).** v1 step 12 conflated pure unit tests on `lib/rust.js` helpers with an end-to-end assertion that depended on integration wiring not yet done. Split into v2 step 12 (pure unit tests on `resolveRustImport` using `discoverCratePackages` directly — no scan integration needed) and v2 step 15 (end-to-end mod-chain reachability via `scanProject`, placed after the integration in step 14). **Why Option A**: keeps TDD red→green→refactor tight per helper; the resolver gets full unit-test coverage before any scan-pipeline complexity is layered on; the end-to-end test in step 15 then becomes a smoke check rather than a debugging mess if it fails. Option B (hoist wiring) would have forced wiring to happen before the resolver is fully proven, inverting the TDD order.

2. **Integration framed as real work, not refactor.** Renamed touchpoints explicitly: `scan.js:144–149` (dispatch) and `scan.js:787–820` (edge loop). Added downstream-consumer audit: `impact.js:13–29`, `deadcode.js:95–109`, `unreachable.js:98–224`. Plan now guarantees `specs` stays as `string[]` (step 10 assertion + step 16 regression test) and resolved Rust edges flow into the existing `fileDetails.resolvedEdges` map (`scan.js:1059–1085`) rather than a parallel field. Public API name corrected to `scanProject` throughout.

3. **Spot-check gate added.** New step 3 (hand-pick before any code) + new step 18 (binary pass/fail gate). Five real `use`/`mod` cases from redpanda with known-correct expected targets must each resolve to exactly the expected file. Aggregate metrics in step 19 only count after this gate passes.

**Secondary gaps addressed:**

4. **TOML parser scope tightened (step 6/7).** Added: triple-quoted multiline strings (`"""` and `'''`), inline tables `{...}` (safely-ignored), mid-line `# comment`, CRLF, virtual manifests (`[workspace]` with no `[package]`). Two-pass strategy in step 7 handles multiline-string desync.

5. **No-fabrication rule (step 13).** Zero-resolved first segment → `null`. Half-resolved (item-in-file) → attribute to last matched file. Trade-off explicitly stated: under-resolve > fabricate, correct bias for agent-monitoring.

6. **Regression gates between clusters.** Every GREEN step (7, 9, 11, 13, 14, 15) now ends with "Regression gate: `npx vitest run` all green" — not just at the start and end.

7. **Unsupported-idiom preflight (step 2).** Grep counts for `#[path]`, `pub use`, `extern crate`, `macro_rules!`/`include!` across all 5 redpanda repos before coding. Step 11 codifies the fallback: warn + drop edge, never guess.

8. **Excluded crates fixture (step 5: `workspace-with-excluded`)** + unit test in step 8 + resolver test in step 12. Files in non-member local crates are scanned but cross-crate imports targeting them return `null`.

9. **Path normalization.** All test assertions use POSIX separators (step 12). All resolver outputs pass through `path.posix.normalize` at the boundary (step 13).

10. **Performance honesty.** Risk #3 rewritten: not formally linear; effectively linear via per-dir memo cache. Step 9 implements the cache explicitly and step 8 asserts it via a `fs.readFileSync` spy.

### Changes from v2 → v3 (Weft re-review)

**Blocker A — `mod` edge double-count in step 14.** v2 step 14 told the integration to (a) resolve everything via `classified` + `resolveRustImport` AND (b) replay `importData.specs` mod-style entries through `resolveRel`. Every `mod foo;` would land in `fileEdges` twice. v3 fix: declared an invariant at the top of step 14 — "For `.rs` files, all import edges flow through `resolveRustImport`. The generic `resolveRel` path is never reached for `.rs`." `mod` is resolved exclusively as `classified` entries of `kind: "mod"`. Removed the `specs`-replay line entirely. Added two new acceptance tests in step 14: (i) integration assertion against `nested-mods` that each `mod foo;` produces exactly one `resolvedEdges` entry; (ii) spy/instrumentation assertion that `resolveRel` and `resolveAlias` are never called with a `.rs` `fromFile`. Mirrored the invariant in Guardrails.

**Blocker B — step 15 over-constrained fix location.** v2 step 15 said mod-chain failures "must be fixed in `lib/rust.js` only". v3 relaxes to: "fix the layer where the bug actually lives" — if step 13 resolver tests still pass in isolation but integration mis-wires (e.g. wrong `ctx` shape, missed `kind: "mod"` dispatch), fix `scan.js`; otherwise fix `lib/rust.js`. Explicit: do not paper over a resolver bug at the integration layer or vice versa.

**Blocker C — `scanWarnings` field with no shape guard.** Chose the second option (stderr only, no new field). Cleaner: keeps the diff small and the JSON contract untouched, eliminates any risk of a future consumer coupling to a `scanWarnings` field. Added new step 14b that records the decision, requires a `rg -n "scanWarnings|\.warnings\b" packages/reality-map/` verification grep to confirm no current consumer reads such a field, and notes the stderr-only route for `#[path]` / `extern crate` / unresolved-cross-crate warnings. Added matching entry to Guardrails. Removed `scanWarnings` mention from step 14.
