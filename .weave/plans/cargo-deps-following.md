# Cargo External-Dependency Following for the Rust Resolver — v2

## TL;DR
> **Summary**: Add an opt-in `--follow-deps` flag that shells out to `cargo metadata`, ingests every dependency package (path, git, registry) into the same Rust resolver pipeline that already handles workspace members, and renders them as one connected graph.
> **Estimated Effort**: Large (≈ 3–5 Yaks)
> **Version**: v2 (revised after Weft review — see "Changes from v1" at bottom)

## Context

### Original Request
Extend the reality-map-fork Rust resolver so that when scanning a Cargo project (e.g. `~/work/code/polytope-server`), external Cargo dependencies — especially git deps under `~/.cargo/git/checkouts/` (like `bits-broker`) and registry deps under `~/.cargo/registry/src/` — are followed into the scan. The user sees workspace members **and** external dep crates as one connected graph instead of `frontend → bits` going to a dead `null`.

### Key Findings

**Existing Rust pipeline (verified line numbers in `packages/reality-map/lib/rust.js`, 846 LOC):**

- `parseCargoToml(text)` — lines 6–233. Hand-rolled, zero-dep TOML reader. Returns `{ package, lib, bin, workspace }`. Does NOT parse `[dependencies]` (and we will not start: cargo does that for us).
- `discoverCratePackages(root, files)` — lines 235–394. Pure filesystem walk:
  - `findManifest(dir)` (lines 245–263): walks up directory chain looking for `Cargo.toml`. Caches in `dirToManifest`.
  - Step 1 (276–281): maps each input `.rs` file to its nearest `Cargo.toml`.
  - Step 2 (283–303): collects unique manifests; also climbs up to find an ancestor workspace root.
  - Step 3 (308–337): from each workspace manifest, expands `[workspace].members` (including single-level `*` globs) into `workspaceMembers` set.
  - Step 4 (346–382): builds `packages: Map<name, { root, manifest, kind }>` where `kind ∈ { "workspace-member", "standalone" }`.
  - Step 5 (385–391): builds `fileToPackage: Map<absFile, name>` for every `.rs` file under a `Cargo.toml`.
- `resolveRustImport` external branch — lines 770–787. **Exact insertion point** for the new behaviour:
  ```js
  // line 774–775 currently:
  if (!pkg || pkg.kind !== "workspace-member") return null;
  ```
  This is the line that drops `use bits::Foo` from polytope. It must become aware of any followable package kind (workspace-member, standalone, or external-cargo-dep).

**Scan glue (`packages/reality-map/lib/scan.js`, 1205 LOC):**

- Line 774: `const files = await walk(root, { ignoreMatchers, codeExtSet });` — this `walk()` (lines 117–142) honours `IGNORE_DIRS` and `.realitymapignore`; it does NOT cross into arbitrary absolute paths. External dep files must be discovered by a separate walker because they live under `~/.cargo/...`, outside `root`.
- Line 814–815: `discoverCratePackages(root, files)` invoked. This is where we add the cargo-metadata pre-step that augments `files`, `packages`, and `fileToPackage`.
- Line 843: `const ctx = { cratePackages, fileToPackage, allFiles: fileSet };` — same ctx is reused for all `.rs` files; once `fileSet` and `cratePackages` are extended, the resolver "just works".
- Line 855: `if (!cratePackages.has(crateName))` — controls whether an import counts as a known crate vs. an `externalCounts` bump. Followed deps will now be in `cratePackages`, so this drops the "unknown external" noise automatically.
- Lines 911–941 `rustModuleOf`: buckets `.rs` files by their workspace member's path *relative to `root`*. External dep files have absolute paths under `~/.cargo/...` — `path.relative(root, ...)` will produce `../../../.cargo/...` style strings. That bucketing must be overridden for `external-cargo-dep` packages (see Step 7).
- Lines 1149 and 1184: `generatedAt: new Date().toISOString()` — two non-deterministic timestamps in the output. Relevant for regression strategy (Step 16).

**CLI (`packages/reality-map/bin/cli.js`, 1034 LOC):**

- `parseArgs` starts at line 26; the `args` defaults object is lines 27–71. New default goes here.
- The arg parsing loop (lines 72–460ish) is a long `if/else if` chain. New flag handler joins it.
- Help text is in the `--help` branch starting at line 248.
- `scanOpts` object built at lines 569–579, passed to `scanProject` at line 590. New option plumbs through here.

**Tests (`packages/reality-map/__tests__/scan.rust.test.ts`, 619 LOC):**

- 137 tests pass today.
- Fixtures live under `__tests__/fixtures/rust/{workspace-two-crates, workspace-with-excluded, single-crate, super-self, glob-import, group-imports, nested-mods, custom-lib-path}`.
- `workspace-with-excluded/c/` is a Cargo crate that exists in the tree but is NOT listed in `[workspace].members` — this is the canonical "Cargo.toml present, not a member" reference point.
- (Note: `workspace-two-crates/thirdparty/vendored_lib/` is itself a workspace member; do not use it as a non-member example.)
- Existing tests at line 369 (`"external rand::Rng → null"`) and line 378 (`"external excluded_crate from workspace member → null"`) remain valid because rand/excluded_crate are not in `cratePackages`. Those tests must continue passing as-is.

**Motivating real case:**

- `~/work/code/polytope-server/frontend/Cargo.toml` declares `bits = { git = "...bits-broker.git", rev = "d6ceded..." }`.
- Cargo resolves this to `~/.cargo/git/checkouts/bits-broker-57f368889c747477/d6ceded/` which contains three crates: `bits`, `bits-py`, `bits-server`.
- `cargo metadata --format-version=1` (run from polytope root) emits a `packages[]` array. Each entry has:
  - `name`, `version`, `id`, `manifest_path` (absolute)
  - `targets[]` (each with `kind: [...]` and `src_path` — absolute path to entry file)
  - `source` — **per cargo docs**: this is `null` for path deps AND for workspace members. Non-null (`registry+...`, `git+...`) only for registry and git deps. **Therefore the dep type must be inferred from `manifest_path` location and `workspace_members[]` membership, not from `source` alone.** v1 just needs "is this a workspace member or not", which `workspace_members[]` gives directly.
- `workspace_members[]` is a list of `package_id` strings identifying which entries are local workspace members.

## Objectives

### Core Objective
Make `npx reality-map --follow-deps ~/work/code/polytope-server` produce a single connected graph that includes:
- All 8 polytope workspace members (current behaviour), AND
- The 3 bits-broker crates from the git checkout, AND
- (Optionally, by default with `--follow-deps`) all transitive registry crates.

The `frontend → bits` edge resolves to a real file in `~/.cargo/git/checkouts/.../bits/src/lib.rs`. Internal edges within bits-broker (e.g. `bits::types::FooBar`) are present. No new noise without the flag.

### v1 Scope
- `--follow-deps` is **boolean, all-or-nothing**: every dep cargo reports is followed.
- `--deps-mode={workspace-only,path,git,registry,all}` filtering is a **v2 follow-up** if anyone complains.
- `--deps-filter=PATTERN` regex filter is also v2.
- v1 is also offline-agnostic: we do not pass `--offline` to cargo. If cargo decides to fetch on first run, that's cargo's call (documented as a caveat).

### Deliverables
- [ ] `--follow-deps` CLI flag with `--help` documentation
- [ ] `runCargoMetadata(manifestPath)` helper
- [ ] `extractExternalDeps(metadata)` helper (filters out workspace members)
- [ ] `mergeExternalDeps(existing, externalDeps, externalFiles)` helper with explicit signature (see Step 5)
- [ ] External-dep file walker (separate from main `walk()` because it traverses outside `root`)
- [ ] Resolver change in `resolveRustImport` external branch (line 775 of rust.js)
- [ ] `rustModuleOf` update to give `external-cargo-dep` packages synthetic `deps/<name>` IDs (new Step 7)
- [ ] Unit tests using a fake-external-dep fixture (no cargo binary required)
- [ ] One integration smoke test that shells out to `cargo metadata` on a small fixture (skipped if cargo absent)
- [ ] Regression assertion using normalized-JSON diff (Step 16)
- [ ] README section documenting the flag, runtime cost, and caveats

### Definition of Done
- [ ] `npm test` in `packages/reality-map/` passes (137 baseline + new tests, all green)
- [ ] Normalized-JSON regression diff is empty (see Step 16)
- [ ] `node packages/reality-map/bin/cli.js --follow-deps --no-serve --json ~/work/code/polytope-server` produces a graph that includes `bits-broker` files; `jq '.scannedFilePaths | map(select(test("bits-broker")))' | length' > 0`
- [ ] At least one resolved edge from a polytope frontend file to a bits-broker file in `fileDetails.resolvedEdges`
- [ ] `--help` output lists `--follow-deps`
- [ ] No new dependencies added to `package.json`

### Guardrails (Must NOT)
- Do NOT parse `[dependencies]` from `Cargo.toml` ourselves — always use `cargo metadata`.
- Do NOT change behaviour for non-Rust projects (TS, Python, Go, etc.).
- Do NOT change behaviour when `--follow-deps` is absent. Normalized output must be byte-identical.
- Do NOT add `toml`, `@iarna/toml`, `cargo-toml`, or any TOML/JSON-extra dep to `package.json`.
- Do NOT auto-fetch crates (no `cargo fetch`, no network calls from our code).
- Do NOT recurse into `target/` outputs.
- Do NOT block the scan indefinitely on `cargo metadata` — 60s timeout.
- Do NOT leak cargo's stderr into the dashboard output stream.
- Do NOT assume cargo is on PATH — graceful degrade with a single stderr warning.
- Do NOT require a `Cargo.toml` at scan root when flag is absent. When flag is present and no `Cargo.toml` is found, print one info line and proceed normally (no-op).

## TODOs

- [x] 1. **Add CLI flag plumbing**
  **What**: Add `--follow-deps` (boolean) to `parseArgs`. Default `false`. Pass through `scanOpts.followDeps` to `scanProject`. Add a single line to `--help` text.
  **Files**:
    - `packages/reality-map/bin/cli.js` (default near line 67; handler in the `if/else` chain near `--deps` at line 215; help text near line 270; `scanOpts` plumbing at line 569)
  **Acceptance**: `node packages/reality-map/bin/cli.js --help | grep follow-deps` shows the flag; `args.followDeps === true` when present; `scanOpts.followDeps` is forwarded.

- [x] 2. **Create `runCargoMetadata` helper**
  **What**: New function exported from `packages/reality-map/lib/rust.js` (append after `parseCargoToml`). Uses `child_process.spawnSync("cargo", ["metadata", "--format-version=1", "--manifest-path=<abs>"], { timeout: 60_000, maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] })`. Use `spawnSync` (not `execSync`) so stderr is captured separately and `timeout` is enforced. Return:
    - `{ ok: false, reason: "cargo-not-found" }` when `error.code === "ENOENT"`
    - `{ ok: false, reason: "timeout" }` when `status === null` and `signal === "SIGTERM"`
    - `{ ok: false, reason: "cargo-error", stderr }` when exit code ≠ 0
    - `{ ok: true, metadata }` otherwise (parsed JSON)

  Emit ONE stderr line via `process.stderr.write(...)` on any non-`ok` outcome.
  **Files**:
    - `packages/reality-map/lib/rust.js` (append)
  **Acceptance**: Unit test: stubbing `child_process.spawnSync` returns `{ ok: false, reason: "cargo-not-found" }` on `ENOENT`. Real `cargo metadata` on a fixture returns `{ ok: true }` (skipped if cargo absent via `it.skipIf(!hasCargo)`).

- [x] 3. **Filter cargo-metadata output to followable deps**
  **What**: Helper `extractExternalDeps(metadata)`. Returns `[{ name, manifestPath, srcRoot, kind }]` where:
    - **Membership test**: `pkg.id ∉ metadata.workspace_members` — the only reliable way to identify "external dep" (NOT `pkg.source`, which is `null` for path deps AND workspace members).
    - `srcRoot` = directory containing the first target with `kind: ["lib"]`; fall back to first target whose `kind` is exactly `["bin"]`. Skip packages with neither (e.g. proc-macro-only, cdylib-only — document for v1).
    - For v1, follow ALL non-workspace packages regardless of where they live on disk. Per v1 scope above, no source-type filtering.
  **Files**:
    - `packages/reality-map/lib/rust.js`
  **Acceptance**: Unit test feeds a hand-crafted `metadata` object (no cargo invocation) and asserts: (a) workspace members are excluded via `workspace_members` check, (b) git/registry/path deps are all included, (c) proc-macro-only packages are excluded, (d) returned `srcRoot` is the directory of the lib target's `src_path`.

- [x] 4. **Walk external dep src directories for `.rs` files**
  **What**: Add `collectExternalDepFiles(srcRoot)` near `walk()` in `scan.js` (around line 117). Recursively collects `.rs` files. Ignores nothing (these dirs are already curated by cargo). Hard cap at 5000 files per dep — beyond cap, stop and emit a stderr warning with the dep name.
  **Files**:
    - `packages/reality-map/lib/scan.js`
  **Acceptance**: Unit test on the fake fixture from Step 10 confirms `.rs` files are discovered; non-`.rs` files (e.g. `Cargo.toml`, `README.md`) are excluded; cap is honoured (test with a tweaked cap value).

- [x] 5. **Add `mergeExternalDeps` helper with explicit signature**
  **What**: New exported helper in `rust.js`. Keeps `discoverCratePackages` itself pure.

  **Signature**:
  ```js
  function mergeExternalDeps(existing, externalDeps, externalFiles) { ... }
  ```
  where:
    - `existing` = `{ packages: Map, fileToPackage: Map }` — the output of `discoverCratePackages`
    - `externalDeps` = the array returned by `extractExternalDeps` (i.e. `[{ name, manifestPath, srcRoot, kind }]`)
    - `externalFiles` = an array of `{ file: absPath, depName: string }` (built by Step 4's `collectExternalDepFiles`, wired in Step 8)
    - returns `{ packages: Map, fileToPackage: Map }` — extended (caller can discard `existing` references)

  For each external dep:
    - Compute `rootFile` from manifest using a new extracted helper `computeCrateRootFile(manifestDir, parsedManifest)` (factor out from current rust.js lines 366–379 to avoid duplication).
    - Insert into `packages` with `kind: "external-cargo-dep"`. **On name collision** with an existing entry (workspace member with same name as a dep — unusual but possible), KEEP the existing entry. Workspace wins.
    - For each file in `externalFiles` matching this dep, set `fileToPackage.set(file, depName)`.

  Note that `--deps-mode` is NOT a parameter of this function in v1 (boolean flag only). The signature can be extended in v2 to take a `mode` argument.
  **Files**:
    - `packages/reality-map/lib/rust.js` (new `mergeExternalDeps` export; extract `computeCrateRootFile`)
  **Acceptance**: Unit test: starting from a `discoverCratePackages` result on `workspace-two-crates`, calling `mergeExternalDeps` with a fake "fake-bits" dep adds the entry with `kind: "external-cargo-dep"` and includes its files in `fileToPackage`. Existing workspace-member entries unchanged. Name-collision test confirms workspace wins.

- [x] 6. **Update `resolveRustImport` external branch**
  **What**: Line 775 of `rust.js` currently reads `if (!pkg || pkg.kind !== "workspace-member") return null;`. Change to:
  ```js
  if (!pkg) return null;
  const followable = pkg.kind === "workspace-member"
    || pkg.kind === "standalone"
    || pkg.kind === "external-cargo-dep";
  if (!followable) return null;
  ```
  Making `standalone` explicit avoids any regression in the no-workspace single-crate case (which already worked because `kind` was simply not checked through a different branch — being explicit is safer).
  **Files**:
    - `packages/reality-map/lib/rust.js` (lines 770–787)
  **Acceptance**: Existing tests at lines 360–385 still pass byte-identical. New test: external dep injected via `mergeExternalDeps` resolves correctly to its lib.rs.

- [x] 7. **Update `rustModuleOf` to handle external deps with synthetic IDs**
  **What**: `rustModuleOf` in `scan.js` (lines 911–941) currently does `path.relative(root, memberDir)`. For external deps under `~/.cargo/...`, that produces machine-specific `../../../.cargo/...` IDs — unusable.

  Add an early branch in `rustModuleOf` keyed on `pkg.kind === "external-cargo-dep"`:
  ```js
  function rustModuleOf(absFile, depth, rustCtx) {
    const { root, fileToPackage, packages } = rustCtx;
    const pkgName = fileToPackage.get(absFile);
    if (!pkgName) return null;
    const pkg = packages.get(pkgName);
    if (!pkg) return null;

    if (pkg.kind === "external-cargo-dep") {
      // Synthetic ID: deps/<name>, with optional intermediate-dir segments at depth >= 2
      const base = `deps/${pkgName}`;
      if (depth <= 1) return base;
      // Compute file's path relative to dep's src root (the dir containing pkg.root)
      const depSrcRoot = path.dirname(pkg.root);
      let remainder = path.relative(depSrcRoot, absFile).split(path.sep).join("/");
      // Elide leading "src/" if present (shouldn't be, since depSrcRoot already IS the src dir, but defensive)
      if (remainder.startsWith("src/")) remainder = remainder.slice(4);
      const dirParts = remainder.split("/").slice(0, -1);
      const takeN = Math.max(0, depth - 1);
      const extra = dirParts.slice(0, takeN);
      return extra.length ? `${base}/${extra.join("/")}` : base;
    }

    // ... existing workspace-member / standalone logic unchanged
  }
  ```

  This matches the synthetic-ID decision: at depth 1, all external deps appear as `deps/<name>` nodes. At depth ≥ 2, intermediate subdirectory segments inside the dep get appended, same shape as the workspace-member rule.
  **Files**:
    - `packages/reality-map/lib/scan.js` (lines 911–941)
  **Acceptance**:
    - `rustModuleOf` is currently a local function inside `scanProject`'s closure, not exported. Test it indirectly via `scanProject(fixturePath, { followDeps: true })` and inspecting the returned `graphsByDepth[depth].nodes` for the expected synthetic IDs. Do NOT export `rustModuleOf` just for tests — keeps the public surface minimal and matches how `workspace module grouping` tests already exercise it.
    - Unit test (in `scan.rust.test.ts`, new `cargo deps following` describe block): with the fake-external-dep fixture, scan it with `followDeps: true` and assert `graphsByDepth[1].nodes` contains a node with id `deps/bits`.
    - At depth 2 on a nested file `<cache>/bits/src/sub/util.rs`, the depth-2 graph contains `deps/bits/sub`.
    - Existing `workspace module grouping` tests (line 519+) still pass byte-identical.

- [x] 8. **Wire it all together in `scan.js`**
  **What**: At lines 814–815 of `scan.js`, before calling `discoverCratePackages`, branch on `opts.followDeps`:
  ```js
  const { runCargoMetadata, extractExternalDeps, mergeExternalDeps } = require("./rust.js");

  let externalDeps = [];
  let externalFiles = [];
  if (opts.followDeps) {
    const rootCargo = path.join(root, "Cargo.toml");
    if (fs.existsSync(rootCargo)) {
      onProgress({ phase: "cargo_metadata" });
      const result = runCargoMetadata(rootCargo);
      if (result.ok) {
        externalDeps = extractExternalDeps(result.metadata);
        for (const dep of externalDeps) {
          const depFiles = collectExternalDepFiles(dep.srcRoot);
          for (const f of depFiles) externalFiles.push({ file: f, depName: dep.name });
          files.push(...depFiles);
        }
        onProgress({ phase: "follow_deps_discovered", depCount: externalDeps.length, fileCount: externalFiles.length });
      }
      // result.ok === false → already logged by runCargoMetadata
    } else {
      process.stderr.write(`reality-map: --follow-deps: no Cargo.toml at ${root} — ignoring\n`);
    }
  }

  // Rebuild fileSet AFTER deps mutation (was line 776 — move it down to here)
  const fileSet = new Set(files);

  const { packages: cratePackages0, fileToPackage: fileToPackage0 } = discoverCratePackages(root, files);
  const { packages: cratePackages, fileToPackage } = mergeExternalDeps(
    { packages: cratePackages0, fileToPackage: fileToPackage0 },
    externalDeps,
    externalFiles,
  );
  ```
  **Decision**: rebuild `fileSet` after the external-deps mutation. Move `const fileSet = new Set(files)` from line 776 to immediately before `discoverCratePackages`. Simpler than adding to the existing set.
  **Files**:
    - `packages/reality-map/lib/scan.js` (lines ~776, 814–815)
  **Acceptance**: Without flag, `files`, `fileSet`, `cratePackages`, `fileToPackage` are byte-identical to today (verified by Step 16). With flag set, the scan extends transparently.

- [x] 9. **CLI summary line for `--follow-deps`**
  **What**: When `--follow-deps` is set and non-quiet, print one summary line: `follow-deps: <N> external crates, <M> .rs files added` near the existing `health` block around line 608 of `cli.js`. Source the counts from the scan result — add `scan.followDeps = { depCount, fileCount }` (or similar) to the returned object in `scan.js`. When flag is OFF, no new key is added (preserves byte-identical output for normalized regression diff).
  **Files**:
    - `packages/reality-map/lib/scan.js` (add `followDeps` summary to return; only when flag set)
    - `packages/reality-map/bin/cli.js` (print line)
  **Acceptance**: Running `--follow-deps` on a real workspace prints the summary line; running without it doesn't. Without flag, the returned scan object has no `followDeps` key.

- [x] 10. **Add fake-external-dep fixture for unit tests**
  **What**: New fixture mimicking workspace-with-external-dep WITHOUT requiring cargo:
  ```
  __tests__/fixtures/rust/workspace-with-external-dep/
    Cargo.toml                          # workspace, members = ["app"]
    app/
      Cargo.toml                        # name = "app", deps include "bits"
      src/main.rs                       # `use bits::run;` and `use bits::types::Thing;`
    fake-cargo-cache/
      bits/
        Cargo.toml                      # name = "bits"
        src/lib.rs                      # pub mod types; pub fn run() {}
        src/types.rs                    # pub struct Thing;
        src/sub/util.rs                 # for the depth-2 module-grouping test
        src/sub/mod.rs
  ```
  Tests call `mergeExternalDeps` directly with a hand-built `externalDeps` array pointing at `fake-cargo-cache/bits/`. This avoids needing real cargo for unit tests.
  **Files**:
    - `packages/reality-map/__tests__/fixtures/rust/workspace-with-external-dep/Cargo.toml`
    - `packages/reality-map/__tests__/fixtures/rust/workspace-with-external-dep/app/Cargo.toml`
    - `packages/reality-map/__tests__/fixtures/rust/workspace-with-external-dep/app/src/main.rs`
    - `packages/reality-map/__tests__/fixtures/rust/workspace-with-external-dep/fake-cargo-cache/bits/Cargo.toml`
    - `packages/reality-map/__tests__/fixtures/rust/workspace-with-external-dep/fake-cargo-cache/bits/src/lib.rs`
    - `packages/reality-map/__tests__/fixtures/rust/workspace-with-external-dep/fake-cargo-cache/bits/src/types.rs`
    - `packages/reality-map/__tests__/fixtures/rust/workspace-with-external-dep/fake-cargo-cache/bits/src/sub/mod.rs`
    - `packages/reality-map/__tests__/fixtures/rust/workspace-with-external-dep/fake-cargo-cache/bits/src/sub/util.rs`
  **Acceptance**: `ls __tests__/fixtures/rust/workspace-with-external-dep` shows the structure above.

- [x] 11. **Add unit tests for the new behaviour**
  **What**: In `scan.rust.test.ts`, add a new `describe("follow external cargo deps")` block:
    - `extractExternalDeps: workspace members are filtered via workspace_members[] (not source field)`
    - `extractExternalDeps: git/path/registry deps all included in v1`
    - `extractExternalDeps: proc-macro-only packages are skipped (no lib/bin target)`
    - `extractExternalDeps: source=null path dep is still included if not in workspace_members`
    - `mergeExternalDeps adds external-cargo-dep entries to packages map`
    - `mergeExternalDeps maps external dep files in fileToPackage`
    - `mergeExternalDeps: workspace member shadows dep with same name (workspace wins)`
    - `resolveRustImport: external "bits" from app/src/main.rs → fake-cargo-cache/bits/src/lib.rs (after merge)`
    - `resolveRustImport: external "bits::types::Thing" → fake-cargo-cache/bits/src/types.rs`
    - `resolveRustImport: external unknown crate still returns null after merge (no fabrication)`
    - `rustModuleOf: external dep file at depth 1 → "deps/<name>"`
    - `rustModuleOf: external dep file at depth 2 → "deps/<name>/<subdir>"`
    - `runCargoMetadata: ENOENT → { ok: false, reason: "cargo-not-found" }` (via `vi.mock` or stubbed `spawnSync`)
    - Regression: `external rand::Rng → null` still passes (existing line 369)
    - Regression: `external excluded_crate from workspace member → null` still passes (existing line 378)
  **Files**:
    - `packages/reality-map/__tests__/scan.rust.test.ts`
  **Acceptance**: `npm test` shows new tests pass; existing 137 still pass.

- [x] 12. **Add a real cargo-metadata integration smoke test**
  **What**: One test that:
    - Detects cargo availability (`spawnSync("cargo", ["--version"])`). Skip via `it.skipIf(!hasCargo)` if absent.
    - Runs `runCargoMetadata` against `workspace-two-crates/Cargo.toml`.
    - Asserts `result.ok === true`.
    - Asserts `result.metadata.packages.length >= 1` (defensive; `workspace-two-crates` has multiple members so should be ≥ 2, but allow ≥ 1 to handle the degenerate virtual-only case if one ever appears).
    - Asserts `extractExternalDeps(result.metadata).length === 0` (no external deps declared in that fixture).
    - If `metadata.packages.length === 0` (truly degenerate workspace — should not happen for `workspace-two-crates`): test still passes the smoke check; `extractExternalDeps` trivially returns `[]`. Document this edge case in a comment.

  This proves the cargo invocation actually works in a real environment. CI may or may not have cargo — that's fine, the test skips gracefully.
  **Files**:
    - `packages/reality-map/__tests__/scan.rust.test.ts` (append)
  **Acceptance**: With cargo installed: test runs and passes. Without cargo: test is reported as skipped, suite still green.

- [x] 13. **End-to-end smoke against polytope-server**
  **What**: Manual verification step (not a test). Run:
  ```sh
  cd /home/james/work/code/polytope-server
  node /home/james/util/reality-map-fork/packages/reality-map/bin/cli.js \
    --follow-deps --no-serve --json . > /tmp/with-deps.json
  node /home/james/util/reality-map-fork/packages/reality-map/bin/cli.js \
    --no-serve --json . > /tmp/without-deps.json
  jq '.scannedFilePaths | length' /tmp/{with,without}-deps.json
  jq '[.scannedFilePaths[] | select(test("bits-broker"))] | length' /tmp/with-deps.json
  jq '[.fileDetails.resolvedEdges | to_entries[] | select(.key | test("frontend")) | .value[] | select(test("bits-broker"))] | length' /tmp/with-deps.json
  ```
  Document the before/after counts in the PR description.
  **Files**: (none — manual verification)
  **Acceptance**: bits-broker files appear in `with-deps.json`; without-deps content (after normalization) is unchanged.

- [x] 14. **Performance and timing honesty in code paths**
  **What**:
    - `runCargoMetadata` already has a 60s timeout (Step 2)
    - `collectExternalDepFiles` already has the 5000-file-per-dep cap (Step 4)
    - `onProgress({ phase: "cargo_metadata" })` and `onProgress({ phase: "follow_deps_discovered", ... })` fire in Step 8
    - Step 9 prints the summary line
  This is a checklist step — verify all four are in place; no new code.
  **Acceptance**: Running `--follow-deps` on a real workspace prints the summary line and progress events fire.

- [x] 15. **README documentation**
  **What**: Add a section in `packages/reality-map/README.md` documenting:
    - `--follow-deps` flag and what it does
    - Requirement: `cargo` on PATH (with graceful fallback)
    - Runtime cost: 1–30s for cargo metadata, plus file walk per dep
    - File count warning for big workspaces (note the per-dep 5000-file cap)
    - Limitation: no `--deps-mode` filtering yet (v2 work)
    - Limitation: external dep file paths are absolute and machine-specific; module groups use `deps/<name>` synthetic IDs
    - Caveat: cargo may fetch from network on first run if Cargo.lock is stale (we do not pass `--offline`)
  **Files**:
    - `packages/reality-map/README.md` (or repo-root `README.md` if that's the canonical CLI docs location — check both)
  **Acceptance**: `grep follow-deps README.md packages/reality-map/README.md` returns the new section.

- [x] 16. **Regression strategy: normalized-JSON diff**

  **Chosen strategy: (a) normalized JSON comparison.** Selected over semantic-invariant assertions because it catches arbitrary unintended differences, not just the ones we thought to check.

  **What**: Add a small test helper `normalizeForDiff(scan)` to a test utility file (or inline in `scan.rust.test.ts`). Behaviour:
    - Deep-clone the scan result.
    - Delete top-level `generatedAt` (line 1149 / 1184 of scan.js).
    - Delete any `*.generatedAt` keys recursively (defensive: only top-level set as of today, but cheap to be thorough).
    - Delete `scanMs` if present (it's currently only in CLI output, not in `scanProject` return — but guard for it).
    - Delete any `followDeps` key (only set when flag is on; without flag the key is absent — so the diff is symmetric).
    - JSON-serialise with sorted keys (use a `sortedStringify` helper or `JSON.stringify(obj, Object.keys(obj).sort())` recursively).

  **Confirmed non-deterministic fields in current `scan.js` return value** (verified via `grep -n "new Date\|Date.now\|Math.random"`):
    - `generatedAt` at lines 1149 and 1184 (top-level on the scan return; line 1149 is inside the `buildGraphForDepth` graph object, line 1184 is on the outer scan).
    - `scanMs` is computed in `cli.js` only (line 598), not part of `scan.js` return. Strip defensively anyway.
    - `fileDetails.lastModified` comes from `git log` timestamps (`getGitTimestamps`) — deterministic given a fixed git state. No need to strip.
    - No `Math.random` in the file. No other timestamps.

  **Regression test**: in `scan.rust.test.ts`, add a new test that:
    1. Runs `scanProject` against `workspace-two-crates` fixture without `followDeps` flag.
    2. Runs `scanProject` against the same fixture with `followDeps: true` BUT with `runCargoMetadata` mocked to return `{ ok: false, reason: "cargo-not-found" }` — this exercises the graceful-fallback path so the flag-on output should be identical to flag-off.
    3. Compare `normalizeForDiff(without) === normalizeForDiff(withFlagFallback)`.

  Plus a stronger regression: snapshot `normalizeForDiff(scanProject(workspace-two-crates))` and assert byte-equality against a committed reference at `__tests__/snapshots/workspace-two-crates.normalized.json`. This catches accidental changes even without the new flag.

  **Snapshot refresh procedure**: when `workspace-two-crates` fixture intentionally changes (e.g. a new file added to test a new resolver behaviour), run:
    ```
    PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" UPDATE_SNAPSHOTS=1 npx vitest run packages/reality-map/__tests__/scan.rust.test.ts
    ```
  The test reads `process.env.UPDATE_SNAPSHOTS` and, when set, writes the current normalized output to the snapshot file instead of comparing. Document this in the test file's top comment AND in a snapshot README at `__tests__/snapshots/README.md`. Commit the updated snapshot in the same PR as the fixture change.

  **Diff output on failure**: when the snapshot test fails, emit a readable diff via `vitest`'s built-in `expect(...).toEqual(...)` (which prints a structured diff for JSON), NOT a raw byte-compare. Pseudocode:
    ```js
    const actual = normalizeForDiff(await scanProject(fixture));
    const expected = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
    if (process.env.UPDATE_SNAPSHOTS) {
      fs.writeFileSync(snapshotPath, JSON.stringify(actual, null, 2));
    } else {
      expect(actual).toEqual(expected); // vitest prints structural diff
    }
    ```

  **Files**:
    - `packages/reality-map/__tests__/scan.rust.test.ts` (helper + tests)
    - `packages/reality-map/__tests__/snapshots/workspace-two-crates.normalized.json` (new — committed reference)
    - `packages/reality-map/__tests__/snapshots/README.md` (new — refresh procedure)
  **Acceptance**:
    - `normalizeForDiff(scan_without_flag) === normalizeForDiff(scan_with_flag_but_cargo_mocked_absent)`
    - Snapshot test passes after running with current code; fails with structural diff if any deterministic output changes unintentionally.
    - `UPDATE_SNAPSHOTS=1` env var regenerates the snapshot in place.

## Verification
- [ ] All existing 137 tests pass without modification
- [ ] New tests from Steps 11, 12, 16 pass
- [ ] `--follow-deps` flag visible in `--help`
- [ ] Normalized-JSON diff (Step 16) is empty without flag — and identical between flag-off and flag-on-but-cargo-absent
- [ ] Snapshot reference file matches current normalized scan output
- [ ] Manual polytope-server smoke (Step 13) shows bits-broker integration
- [ ] No new entries in `package.json` dependencies
- [ ] cargo absent → one stderr warning, scan continues without external deps
- [ ] cargo timeout (simulate via `CARGO=/bin/sleep 99999` if needed) → one stderr error, scan continues
- [ ] No leaked cargo stderr in scan stdout
- [ ] `rustModuleOf` produces `deps/<name>` IDs for external dep files at depth 1; `deps/<name>/<subdir>` at depth ≥ 2

## Risk Register
- **cargo not installed**: handled by Step 2's `ENOENT` branch. Graceful stderr warning.
- **cargo metadata hangs**: 60s `spawnSync` timeout. SIGTERM, one stderr line, scan continues.
- **file count explosion**: per-dep 5000-file cap + progress logging. Documented in README.
- **path normalization for external dep file IDs**: handled by Step 7's synthetic `deps/<name>` module grouping.
- **name collision (workspace member shadows dep)**: workspace wins (Step 5). Documented in test.
- **proc-macro / cdylib only packages**: skipped in Step 3 (no lib/bin target). Documented.
- **scan root has no Cargo.toml + flag set**: Step 8 prints info line and proceeds normally (no-op).
- **stale Cargo.lock causes cargo metadata network fetch**: outside our control. Documented in README. v2 may add `--deps-offline`.
- **`source: null` ambiguity**: addressed in Step 3 — `workspace_members[]` membership is the source of truth, not the `source` field.
- **architectural drift**: `discoverCratePackages` stays pure; external-dep ingestion is in the separate `mergeExternalDeps` function. Flagged in PR description.
- **Regression check impossibility from non-determinism**: addressed by Step 16's `normalizeForDiff` strategy.

## Non-Goals (Recap)
- No `--deps-mode={workspace-only,path,git,registry,all}` filtering in v1 (v2 follow-up)
- No `--deps-filter=PATTERN` regex in v1 (v2 follow-up)
- No `--deps-offline` flag in v1 (v2 follow-up)
- No support for non-Cargo dependency systems
- No automatic `cargo fetch` (network purity)
- No reimplementation of `cargo`'s dep resolution
- No scanning of `target/` build outputs

---

## Changes from v1

### Blocker (fixed)
- **Step 15 in v1 said "byte-identical" regression check on full scan JSON, which is impossible** because `scanProject` injects `generatedAt: new Date().toISOString()` at scan.js:1149 and :1184. Two unmodified runs already produce different bytes.
- **Resolution**: v2's regression strategy is now Step 16 — **normalized JSON comparison (strategy (a) from Weft's options)**. A `normalizeForDiff(scan)` helper deletes `generatedAt` (top-level and any recursive occurrences), defensively deletes `scanMs` (not currently in scan return but guard anyway), deletes the `followDeps` summary key (only set when flag is on, so diff stays symmetric), and JSON-serialises with sorted keys.
- **Confirmed non-deterministic fields** in current scan.js: only the two `generatedAt` calls. `fileDetails.lastModified` is git-derived and deterministic. No `Math.random`. No other timestamps. Documented in Step 16.
- v2 also adds a committed reference snapshot (`__tests__/snapshots/workspace-two-crates.normalized.json`) so even deterministic output changes are caught.

### Factual corrections
1. **`packages[].source` semantics**: v1's context block claimed `source` reliably distinguishes dep types. Corrected per cargo docs: `source` is `null` for path deps AND workspace members. v2 Step 3 now uses `workspace_members[]` membership as the source of truth, not `source`. Added an explicit test (`extractExternalDeps: source=null path dep is still included`) in Step 11.
2. **`workspace-two-crates/thirdparty/vendored_lib` is a workspace member**, not a non-member example. v1's context block had this wrong. v2 corrects it and points at `workspace-with-excluded/c/` as the canonical "Cargo.toml present, not a member" example.
3. **`rustModuleOf` needs a dedicated step** to handle `external-cargo-dep` packages. v1 mentioned this only in passing inside the original Step 8. v2 makes it a first-class step (the new Step 7) with explicit algorithm, depth handling, and dedicated tests.

### Other revisions
- Step 5 now states the `mergeExternalDeps` signature explicitly: `(existing, externalDeps, externalFiles) → { packages, fileToPackage }`.
- v1 scope section made explicit: boolean flag only in v1; `--deps-mode`, `--deps-filter`, `--deps-offline` are all v2 follow-ups.
- Step 12 (real cargo smoke test) now explicitly handles the `packages.length === 0` degenerate case.
- Definition of Done's `jq` queries updated to reference real scan.js output keys (`scannedFilePaths`, `fileDetails.resolvedEdges`) instead of generic `files` / `edges`.
- Total step count: **16** (v1 had 15).
