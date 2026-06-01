# --deps-filter: scope `--follow-deps` to a regex on crate name

## TL;DR
> **Summary**: Add `--deps-filter=PATTERN` CLI flag that restricts `--follow-deps` to external Cargo crates whose name matches a JavaScript regex, applied at `extractExternalDeps` so non-matching crates never enter the scan pipeline.
> **Estimated Effort**: Short (~0.5–1 Yak / ~30 min human / ~5 min AI)

## Context

### Original Request
Add `--deps-filter=PATTERN` regex to the reality-map fork's `--follow-deps` feature so users can scope which external Cargo deps are ingested.

Motivating case: running `--follow-deps` on polytope-server (8 workspace members) ingests **538 external crates / 14,442 files / ~30 s** when the user only wants the `bits` family (3 crates: `bits`, `bits-py`, `bits-server`, ~34 files).

### Key Findings
The `--follow-deps` plumbing is well-isolated and the filter slots in cleanly at one chokepoint:

- **`packages/reality-map/bin/cli.js`** — flag parsing at L218–219 (`--follow-deps`), default at L71, threaded into `scanOpts` at L576 and L989, help text at L321, summary line at L733.
- **`packages/reality-map/lib/scan.js`** — wiring at L838–858 inside `if (opts.followDeps)`; calls `extractExternalDeps(result.metadata)` at L849. Summary attached at L1296.
- **`packages/reality-map/lib/rust.js`** — `extractExternalDeps(metadata)` at L267 is the single funnel for all external crate discovery. Exported at L1001.
- **`packages/reality-map/lib/server.js`** — `startServer({…, followDeps})` at L45 threaded into `scanProject` at L56 (rescan path).
- **Tests** — `__tests__/scan.rust.test.ts` already has 5 `extractExternalDeps` unit tests (L656–708) plus integration tests (L747–792) using fixture `WSDEP` (`workspace-with-external-dep`). New tests slot alongside.
- **Determinism guard** — existing parity test at L779–792 strips `followDeps` from normalized JSON and asserts byte-identical output. We must preserve this when `depsFilter` is unset.

Branch `feat/dagre-elk-layouts`, last commit `3649656`, 148/148 tests green.

## Objectives

### Core Objective
Let users scope `--follow-deps` to a regex-matched subset of external Cargo crates, applied early enough that non-matching crates never trigger file walks.

### Deliverables
- [ ] `--deps-filter <pattern>` CLI flag with regex compilation + validation at parse time
- [ ] `extractExternalDeps(metadata, filter)` accepts an optional `RegExp` (or `null`) and filters by `pkg.name`
- [ ] Threaded through `scan.js` and `server.js` rescan path
- [ ] README documents the flag with the polytope-server / `^bits` example
- [ ] Unit + integration tests covering filter, no-filter, and invalid-regex cases
- [ ] Verification run on polytope-server captured in the evidence file

### Definition of Done
- [ ] `cd packages/reality-map && npm test` → 148 + new tests pass
- [ ] `node packages/reality-map/bin/cli.js --follow-deps --deps-filter='^bits' /path/to/polytope-server` reports ~3 external crates / ~34 files (not 538 / 14,442)
- [ ] `node packages/reality-map/bin/cli.js --follow-deps /path/to/workspace-with-external-dep` (no filter) produces byte-identical normalized JSON vs. main — parity test still green
- [ ] `node packages/reality-map/bin/cli.js --follow-deps --deps-filter='[invalid(' .` exits 1 with a clear error
- [ ] README has a `--deps-filter` section with an executable example

### Guardrails (Must NOT)
- Do NOT change behaviour when `--deps-filter` is unset — existing output must be byte-identical
- Do NOT apply the filter after file walks; it must short-circuit inside `extractExternalDeps`
- Do NOT auto-add `^`/`$` anchors or `/i` flag — pass the user's pattern through verbatim
- Do NOT add `--deps-exclude`, `--deps-mode`, multiple patterns, or glob support (separate v2 work)
- Do NOT silently ignore `--deps-filter` when `--follow-deps` is absent

## Decisions (pinned)

1. **Where regex compiles**: CLI layer. `bin/cli.js` does `args.depsFilter = pattern ? new RegExp(pattern) : null`. Downstream (`scan.js`, `rust.js`, `server.js`) accept a compiled `RegExp` or `null`. Single validation point, single error message.
   **Strict downstream contract**: `extractExternalDeps`, `scanProject`, and `startServer` accept only a `RegExp` instance or `null` for `depsFilter`. A programmatic caller passing a string would blow up at `filter.test(...)`. Document this as the contract in code comments — do NOT add string-coercion downstream. The CLI is the only entry point that compiles strings.
2. **`--deps-filter` without `--follow-deps`**: **implicitly enable `--follow-deps`** (option (a) in the brief). Most user-friendly; "I asked to filter deps, of course I want to follow them." Print a one-line info note: `reality-map: --deps-filter implies --follow-deps`.
3. **Match semantics**: `filter.test(pkg.name)` — **unanchored**. Users add `^`/`$` if they want strict bounds. Documented in README and `--help`.
4. **Case sensitivity**: regex's own. No auto `/i`. Documented.
5. **Invalid regex**: CLI catches the `new RegExp(...)` throw, prints `reality-map: --deps-filter: invalid regex: <message>` to stderr, exits 1.
6. **Empty pattern (`--deps-filter=''`)**: collapses to `null` via `pattern ? new RegExp(pattern) : null`, i.e. "match all" / no filter. Since the resulting `args.depsFilter` is `null`, the implicit-follow-deps note does NOT fire (the test is `args.depsFilter !== null`, not "user passed the flag"). Documented in `--help`: "empty value disables the filter".
7. **Regex matching zero crates**: silent — no warning. Result is a normal scan with zero external deps. Test case included to confirm.

## TODOs

- [x] 1. **Add `--deps-filter` to CLI arg parser**
  **What**: Parse `--deps-filter <pattern>` and `--deps-filter=<pattern>`. Default `args.depsFilter = null`. Compile to `RegExp` immediately; on throw, print error to stderr and `process.exit(1)`. If `depsFilter` is set and `followDeps` is false, set `followDeps = true` and write a one-line note to stderr.
  **Files**: `packages/reality-map/bin/cli.js` (extend arg loop near L218; default near L71; threading near L576 and L989)
  **Acceptance**: `node bin/cli.js --help` shows the new flag; `--deps-filter='[invalid('` exits 1; `--deps-filter='^bits'` alone (no `--follow-deps`) emits the implies-note and proceeds with follow-deps enabled.

- [x] 2. **Update `--help` text**
  **What**: Add a `--deps-filter <regex>` line under the existing `--follow-deps` entry near L321. Note: implies `--follow-deps`; unanchored by default; case-sensitive unless pattern uses `(?i)` syntax inapplicable in JS — instead document adding `i` is not auto-applied.
  **Files**: `packages/reality-map/bin/cli.js`
  **Acceptance**: `--help` output mentions `--deps-filter` with one-line example `--follow-deps --deps-filter='^bits'`.

- [x] 3. **Change `extractExternalDeps` signature**
  **What**: Change L267 from `function extractExternalDeps(metadata)` to `function extractExternalDeps(metadata, filter = null)`. After the existing workspace-member / proc-macro filtering, add: `if (filter && !filter.test(pkg.name)) continue;`. Export unchanged.
  **Files**: `packages/reality-map/lib/rust.js`
  **Acceptance**: Existing 5 unit tests pass unchanged (calling without `filter` arg); new tests with `filter` arg behave as specified.

- [x] 4. **Thread `depsFilter` through `scan.js`**
  **What**: In `lib/scan.js` at L849, change `extractExternalDeps(result.metadata)` to `extractExternalDeps(result.metadata, opts.depsFilter || null)`. No other call sites. Confirm `scanProject` signature already accepts an opts bag — no new param needed, just consume `opts.depsFilter`.
  **Files**: `packages/reality-map/lib/scan.js`
  **Acceptance**: `scanProject(root, { followDeps: true, depsFilter: /^bits/ })` returns only `bits*` external crates in `result.followDeps`.

- [x] 5. **Thread `depsFilter` through `server.js` rescan path**
  **What**: Extend `startServer({…, followDeps, depsFilter})` at L45. Pass `depsFilter` into the `scanProject` call at L56. Same pattern as `followDeps`. Update both CLI call sites in `bin/cli.js` (L576, L989) to forward `args.depsFilter`.
  **Files**: `packages/reality-map/lib/server.js`, `packages/reality-map/bin/cli.js`
  **Acceptance**: Server rescans honour the filter on every reload (verify via watch-mode manual run, or by inspecting that `depsFilter` reaches `scanProject` — covered by integration test below).

- [x] 6. **Update follow-deps summary line (optional polish)**
  **What**: In `bin/cli.js` near L733, if `args.depsFilter` is set, append `(filter: ${args.depsFilter.source})` to the summary line so the user sees what was applied.
  **Files**: `packages/reality-map/bin/cli.js`
  **Acceptance**: With `--deps-filter='^bits'`, summary reads e.g. `follow-deps  3 external crates, 34 .rs files added (filter: ^bits)`.

- [x] 7. **Add unit tests for `extractExternalDeps` filter**
  **What**: In `packages/reality-map/__tests__/scan.rust.test.ts` near L708, add tests:
  (a) `extractExternalDeps(metadata, null)` returns same as `extractExternalDeps(metadata)` (no-op);
  (b) `extractExternalDeps(metadata, /^bits/)` returns only crates whose name starts with `bits`;
  (c) `extractExternalDeps(metadata, /nomatchxyz/)` returns `[]`;
  (d) unanchored match: `/foo/` matches both `foo` and `barfoo`.
  Reuse the inline `makeMetadata` helper that the existing tests already use.
  **Files**: `packages/reality-map/__tests__/scan.rust.test.ts`
  **Acceptance**: All four cases pass.

- [x] 8. **Add integration test on `workspace-with-external-dep` fixture**
  **What**: Add a `scanProject(WSDEP, { followDeps: true, depsFilter: /<name-from-fixture>/ })` test asserting that `result.followDeps.depCount` and `fileCount` reflect only the matched crate(s). Pair it with a parity assertion: `scanProject(WSDEP, { followDeps: true, depsFilter: null })` produces byte-identical normalized JSON to `scanProject(WSDEP, { followDeps: true })` (extending the existing parity test at L779–792).
  **Files**: `packages/reality-map/__tests__/scan.rust.test.ts`
  **Acceptance**: Filter narrows the result; null filter is byte-identical to no filter.

- [x] 9. **Add CLI behaviour tests (invalid regex + implicit follow-deps)**
  **What**: Two shell-out tests via `spawnSync`:
  (a) Invalid pattern: `spawnSync("node", ["bin/cli.js", "--deps-filter=[bad(", "."])` → assert `status === 1` AND `stderr` contains `invalid regex`.
  (b) Implicit follow-deps: `spawnSync("node", ["bin/cli.js", "--deps-filter=^bits", "--no-serve", "--summary-json", ".../workspace-with-external-dep"])` → assert `stderr` contains `--deps-filter implies --follow-deps` AND `stdout` JSON has `followDeps` summary field (proves the implicit enablement actually fired).
  If shell-out tests don't fit the existing harness, use a direct call to the exported `parseArgs` function (if it's exported) — check the existing CLI tests for the convention.
  **Files**: `packages/reality-map/__tests__/` (new or existing CLI test file)
  **Acceptance**: Both cases pass.

- [x] 10. **Document in README and verify on polytope-server**
  **What**: Add a subsection under `### Following Cargo dependencies — `--follow-deps`` at L276 of `README.md`. Show the `^bits` example with before/after metrics. Then run against `/home/james/work/polytope-server` (or wherever the user's checkout lives) both unfiltered and with `--deps-filter='^bits'`; capture both summary lines into `.weave/plans/deps-filter.evidence`.
  **Files**: `packages/reality-map/README.md`, `.weave/plans/deps-filter.evidence`
  **Acceptance**: README has a working `--deps-filter` example; evidence file shows the dep-count / file-count delta (expected ~3 / ~34 vs ~538 / ~14,442).

## Verification
- [ ] `cd packages/reality-map && npm test` → all tests green (148 existing + new)
- [ ] No-filter parity: normalized JSON for `WSDEP` with `followDeps: true` is byte-identical with and without `depsFilter: null`
- [ ] CLI smoke: `--follow-deps --deps-filter='^bits' /path/to/polytope-server` produces dramatically smaller scan (evidence file captures numbers)
- [ ] CLI error path: `--deps-filter='[invalid('` → exit 1 with `invalid regex` in stderr
- [ ] CLI implicit-follow path: `--deps-filter='^bits'` (no `--follow-deps`) → emits implies-note and follow-deps activates
- [ ] `--help` lists `--deps-filter` with usage hint
- [ ] README renders the new section correctly (visual check)
