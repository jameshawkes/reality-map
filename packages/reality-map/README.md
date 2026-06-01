<p align="center">
  <img src="https://raw.githubusercontent.com/g0GobliN/reality-map/main/src/img/git_logo.PNG" alt="RealityMap Logo" width="420" />
  <br/><br/>
  <strong>Visual architecture explorer for any JavaScript/TypeScript codebase. Zero config, zero upload, runs entirely local.</strong>
  <br/>
  <code>npx reality-map</code>
  <br/>
  <sub>By <a href="https://github.com/g0GobliN">Vishal Gurung</a> · <a href="https://github.com/g0GobliN">@g0GobliN</a></sub>
</p>

---

## What it does

Most codebases grow faster than anyone can understand them. `reality-map` gives you an instant visual overview — modules, dependencies, cycles, coupling hubs — and lets you drill all the way down to individual files and functions.

<p align="center">
  <img src="https://raw.githubusercontent.com/g0GobliN/reality-map/main/src/img/ss/2D891534-ACC7-4327-B054-8240BE3013E5.PNG" alt="RealityMap Interactive 3D/Radial Dependency Map" width="850" />
</p>

---

## Features

### 🗺 Interactive Architecture Graph

A live, zoomable graph of your entire project — modules, services, databases, and their connections — rendered in the browser with full interaction.

**Phase 1 · Interaction**

- **Edge focus mode** — hover any node to highlight its connected edges; unrelated edges drop to near-invisible
- **Path highlighting** — click a node to lock focus; its neighbours glow, everything else fades to 20% opacity; click again or click the canvas to deselect
- **Edge filtering** — toggle edge views: `all` (everything), `warn` (edges touching circular-dep modules), `hot` (edges with ≥ 3 imports), `clean` (no warnings and lightweight); at least one filter always stays active

**Phase 2 · Clustering**

- **Domain clusters** — nodes are auto-grouped by top-level path segment (e.g. `src`, `lib`, `api`), each shown with a translucent group background
- **Collapse & expand** — click a cluster toggle pill to collapse the group into a single summary card; inter-cluster edges auto-reroute and deduplicate; click the card to expand again
- **Cluster focus** — click a cluster pill a second time to isolate just that cluster's nodes; click again to return to the full graph
- **Cluster metrics** — each collapsed cluster card shows aggregated module count and warning count

**Phase 3 · Layouts & Abstraction**

- **Multiple layouts** — switch between three named arrangements:
  - `server` — server-computed positions (default, preserves module hierarchy)
  - `radial` — nodes arranged evenly around a circle
  - `force` — organic scatter with cluster proximity preserved
- **Smooth transitions** — switching layouts or toggling clusters triggers an animated `fitView` so context is never lost
- **Persistent layout** — your last-used layout is saved in `localStorage` and restored on next open

**Core graph features**

- Module-level graph with configurable depth (1–5)
- **Hierarchical layout at depth 2+** — nodes are grouped into horizontal strips by top-level folder (`src/`, `packages/`, etc.) so the visual hierarchy always matches your directory tree; depth 1 shows only top-level folders as single nodes
- **Double-click to drill in** — zoom into any module to see its sub-modules, then files, then symbols; use **Back** to navigate back up
- Drag nodes to rearrange, pan and zoom freely
- Animated edges show import direction and weight
- Cycle detection — circular dependencies highlighted in rose

<p align="center">
  <img src="https://raw.githubusercontent.com/g0GobliN/reality-map/main/src/img/ss/Screenshot%20from%202026-05-20%2011-44-26.png" alt="RealityMap Sub-dependency Graph" width="850" />
</p>

### 🔍 Deep File Exploration

- Click any module at max depth → side drawer opens with all files
- See every function, class, interface, and type with line numbers
- Full import list with exact line numbers and import statements
- Search symbols inside any file instantly
- Breadcrumb navigation — go back up the drill-down path

### 💥 Change Impact Analysis _(new)_

Enter any file paths → instantly see:

- Every file that could break (direct + transitive)
- Risk score per affected file (1–10)
- Module-level blast radius summary
- Color-coded: high / medium / low risk

### 🏥 Codebase Health Score _(new)_

A single 0–100 score with letter grade (A–F) based on:

- Circular dependency count
- Isolated file ratio
- Oversized files (>500 LOC)
- Highly-coupled hubs

Includes a **copy-ready README badge**:

```
![Health 87/100](https://img.shields.io/static/v1?label=health&message=87/100&color=brightgreen)
```

<p align="center">
  <img src="https://raw.githubusercontent.com/g0GobliN/reality-map/main/src/img/ss/Screenshot%20from%202026-05-20%2011-45-32.png" alt="RealityMap Codebase Health Dashboard" width="850" />
</p>

### 🧹 Dead Code & Unreachable File Detection

Finds files that are probably unused — scored by confidence, not just "0 importers":

- No internal importers
- Not an entry point, test, or config file
- Confidence score based on multiple signals
- Shows potential LOC savings

**Unreachable file analysis** — traces which source files can never be reached from your named entry points (e.g. `src/index.ts`, `src/main.ts`) via any import path. Complements dead code detection with graph-traversal certainty instead of heuristics.

```bash
# Report unreachable files in src/ from entry points
npx reality-map --unreachable-files src

# Output as JSON (for CI / scripting)
npx reality-map --unreachable-files-json src
```

The UI dead code panel merges both signals — confirmed dead-code candidates and graph-unreachable files — sorted by severity.

<p align="center">
  <img src="https://raw.githubusercontent.com/g0GobliN/reality-map/main/src/img/ss/Screenshot%20from%202026-05-20%2011-45-18.png" alt="RealityMap Dead Code Candidates" width="850" />
</p>

### 📦 Dependency Intelligence _(new)_

Full local analysis of your `package.json` — no registry upload, works offline after install.

<p align="center">
  <img src="https://raw.githubusercontent.com/g0GobliN/reality-map/main/src/img/ss/Screenshot%20from%202026-05-20%2011-45-01.png" alt="RealityMap Dependency Intelligence Dashboard" width="850" />
</p>

**Unused detection** — packages declared but never imported in source are flagged as `unused`. Packages only found in config files (`eslint.config.js`, `vite.config.ts`, etc.) are labelled `config-only` instead, which is a distinct and valid usage pattern.

**Vulnerability scan** — runs `npm audit` locally and surfaces results grouped by severity: `critical` / `high` / `moderate` / `low`. Gracefully skips if `npm audit` is unavailable.

**Outdated packages** — uses `npm outdated` to detect stale versions, then classifies the gap:

- `outdated (major)` — breaking version behind, shown in amber
- `outdated (minor)` — non-breaking feature behind, shown dim
- `outdated (patch)` — safe bug-fix behind, low noise

**Deprecated packages** — reads the `deprecated` field directly from `node_modules/[pkg]/package.json` — fully offline, no registry call needed.

**Risk score (0–10)** — per-package score combining all signals:

| Signal                 | Points |
| ---------------------- | ------ |
| Critical vulnerability | +4     |
| High vulnerability     | +3     |
| Moderate vulnerability | +2     |
| Low vulnerability      | +0.5   |
| Deprecated             | +2     |
| Unused (runtime dep)   | +1     |
| Major version behind   | +1.5   |
| Minor version behind   | +0.5   |

**Overlapping ecosystem detection** — warns when multiple libraries serve the same purpose (e.g. `moment` + `date-fns` + `dayjs`), covering 10 ecosystem groups: date, HTTP client, state management, forms, CSS-in-JS, animation, validation, ORM, routing, and data-fetching.

**Package detail drawer** — click any package to see: importing files, vulnerability details with links, installed vs latest version, risk score breakdown, and deprecation message.

**CLI usage:**

```bash
# Print dep intelligence report to terminal
npx reality-map --deps

# Output as JSON (for CI / scripting)
npx reality-map --deps-json

# Exit 1 if any critical vulnerabilities found
npx reality-map --deps --fail-on-vuln critical

# Exit 1 if any high-or-above vulnerabilities found
npx reality-map --deps --fail-on-vuln high
```

### 📊 Insights Dashboard

- Largest files by LOC
- Most imported files (your critical shared code)
- Coupling hubs (high fan-in AND fan-out)
- Files with no internal importers (potential entry points or dead code)
- **Directory architecture** — per-folder breakdown of file count, LOC, inbound/outbound cross-folder edges, and coupling % (cross-directory edges ÷ all edges for that folder); plus a dependency flow table showing which folders import from which

### 🔎 Global Search

`Ctrl+K` — fuzzy search across all files, jump directly to any file's detail view.

### 📦 Minimap

Always-visible overview of the full graph while you're zoomed in.

---

## Usage

```bash
# Scan current directory
npx reality-map

# Scan a specific project
npx reality-map /path/to/project

# Custom port
npx reality-map --port 4000

# Custom depth (1-5, default 3)
npx reality-map --depth 4

# Watch mode (auto-refresh on file changes)
npx reality-map --watch

# Export snapshot as self-contained HTML
npx reality-map --export snapshot.html

# Dependency intelligence (terminal report)
npx reality-map --deps

# Dependency intelligence as JSON
npx reality-map --deps-json

# Fail CI if critical vulnerabilities found
npx reality-map --deps --fail-on-vuln critical
```

---

## Supported languages

| Language   | Extensions                 |
| ---------- | -------------------------- |
| JavaScript | `.js` `.mjs` `.cjs`        |
| TypeScript | `.ts` `.tsx` `.mts` `.cts` |
| JSX        | `.jsx`                     |
| Vue        | `.vue`                     |
| Svelte     | `.svelte`                  |
| Astro      | `.astro`                   |
| Python     | `.py`                      |
| Go         | `.go`                      |
| Rust       | `.rs`                      |

### Rust

The resolver walks `.rs` files and builds edges from `use` statements and `mod` declarations.

**What resolves:**

- `use crate::path::to::Item` — resolved relative to the crate root (`src/lib.rs`, `src/main.rs`, or the path set in `[lib]`/`[[bin]]`)
- Group imports — `use a::{b, c::{d, e}}` is expanded before resolution; each leaf becomes an independent edge
- `mod foo;` declarations — resolved to `foo.rs` or `foo/mod.rs` relative to the declaring file
- `use super::…` — walks up the module tree; multiple `super::` levels are followed correctly; edges land on `mod.rs` / `lib.rs` / `main.rs` when the item is defined there
- `use self::…` — resolved relative to the current module file
- Cross-workspace crate references — `use crate_name::…` is matched against workspace members by package name, then resolved into that crate's root

**Cargo awareness:**

- Workspace manifests — `[workspace] members = [...]` entries are enumerated; glob patterns like `crates/*` are expanded
- Custom lib roots — `[lib] path = "…"` overrides the default `src/lib.rs`
- Binary entries — `[[bin]] path = "…"` entries are registered as additional roots

**Resolution bias — under-resolves rather than fabricates:**

- Half-resolved paths (some segments matched, remainder unresolvable) attribute to the last matched file
- Zero-resolved paths are dropped entirely — no phantom edges
- `super::Item` / `self::Item` where the item lives in the parent module file correctly lands on `mod.rs` / `lib.rs` / `main.rs`

**Limitations:**

- `macro_rules!`-generated modules — not expanded; the resolver treats them as always-present and will not flag missing targets
- `#[path = "alt.rs"] mod foo;` — detected and dropped with a stderr warning; the edge is not emitted
- `extern crate foo;` — detected and dropped with a stderr warning; use `use` statements instead
- `pub use crate::a::B as C;` — captured as a real edge to `B`'s definition location, but re-export chains are not followed; consumers of `C` will not have their edges retargeted through the alias
- Inline-table TOML in `Cargo.toml` (e.g. `lib = { path = "src/mylib.rs" }`) — parsed without error but the custom path is not honoured; the resolver falls back to the default `src/lib.rs` layout

### Following Cargo dependencies — `--follow-deps`

By default, reality-map only scans files inside the directory you point it at. For
Rust projects, that means `use external_crate::Foo` resolves to a dead end — the
external crate's source isn't part of the scan.

Pass `--follow-deps` to make reality-map shell out to `cargo metadata` and pull in
every dependency (path, git, registry) reported by Cargo. External deps appear as
module nodes named `deps/<crate-name>` and their files are scanned alongside your
own.

```sh
node bin/cli.js --follow-deps /path/to/your/cargo/project
```

**Requirements:**
- `cargo` must be on `PATH`. If absent, reality-map emits one stderr line and falls
  back to scanning only the local files.
- The scan root must contain a `Cargo.toml`. If absent, the flag is a no-op.

**Cost:**
- `cargo metadata` typically completes in 1–5 seconds on cached workspaces, up to
  30 seconds if Cargo decides to refresh registry metadata.
- File count balloons. On `polytope-server` (8 workspace members + 538 transitive
  deps), `--follow-deps` adds ~14,000 `.rs` files to the scan and takes ~30 seconds.
- Per-dep cap: each external dep can contribute at most 5000 `.rs` files. Beyond
  that, the remainder is truncated with a stderr warning.

**Scoping with `--deps-filter`:**

Pulling 500+ transitive crates is overwhelming when you only care about a few. Pass
`--deps-filter=REGEX` to restrict `--follow-deps` to crates whose name matches a
JavaScript regex. The filter applies inside `extractExternalDeps` before any file
walking — non-matching crates never enter the pipeline, so the cost saving is real.

```sh
# Only follow crates whose name starts with "bits"
node bin/cli.js --follow-deps --deps-filter='^bits' /path/to/your/cargo/project

# --deps-filter implies --follow-deps (this works too):
node bin/cli.js --deps-filter='^bits' /path/to/your/cargo/project
```

Behaviour:
- Match is unanchored — `--deps-filter='foo'` matches both `foo` and `barfoo`.
  Add `^` and `$` for strict bounds.
- Case-sensitive. No auto `/i`.
- Empty pattern (`--deps-filter=''`) disables the filter.
- Invalid regex exits 1 with `invalid regex: …` on stderr.
- Specifying `--deps-filter` without `--follow-deps` implicitly enables
  `--follow-deps` with a one-line stderr note.

On `polytope-server` (538 transitive crates), `--deps-filter='^bits'` reduces the
scan from 14,442 files / 32 s to 106 files / 473 ms.

**Limitations:**
- No `--deps-mode={path,git,registry,all}` source-type filtering yet (separate
  follow-up).
- No `--deps-exclude` or multiple patterns (separate follow-up).
- No `--deps-offline` flag. If `Cargo.lock` is stale, cargo may fetch from the
  network (we do not pass `--offline`).
- External dep file paths are absolute and machine-specific (under
  `~/.cargo/git/checkouts/...` or `~/.cargo/registry/src/...`). Module-graph IDs
  use a synthetic `deps/<crate-name>` prefix so the graph is portable.
- Workspace member `foo` shadows external dep `foo` — workspace wins.

---

## Ignore files

Create a `.realitymapignore` file in your project root (same syntax as `.gitignore`):

```
# Ignore generated files
src/generated/
*.generated.ts

# Ignore specific directories
legacy/
```

---

## API endpoints

The local server exposes a REST API you can use in scripts:

| Endpoint                     | Method | Description                                                    |
| ---------------------------- | ------ | -------------------------------------------------------------- |
| `/api/graph`                 | GET    | Full scan data                                                 |
| `/api/health`                | GET    | Health score (0–100)                                           |
| `/api/impact`                | POST   | Change impact — body: `{ "paths": ["src/foo.ts"] }`            |
| `/api/deadcode`              | GET    | Dead code candidates                                           |
| `/api/unreachable?src=<dir>` | GET    | Files unreachable from entry points in `<dir>`                 |
| `/api/deps`                  | GET    | Dependency intelligence — unused, vulns, outdated, risk scores |
| `/api/search?q=`             | GET    | File search                                                    |
| `/api/file/:path`            | GET    | File symbols + imports                                         |
| `/api/rescan`                | POST   | Re-scan project                                                |
| `/api/snapshot.html`         | GET    | Download self-contained HTML snapshot                          |

---

## How the health score works

| Factor                            | Max penalty |
| --------------------------------- | ----------- |
| Circular dependencies             | −30 pts     |
| High isolated file ratio (>5%)    | −20 pts     |
| Files over 500 LOC                | −15 pts     |
| Highly-coupled hubs (in≥8, out≥5) | −15 pts     |

Grade scale: A (90–100) · B (80–89) · C (70–79) · D (60–69) · F (<60)

---

## How change impact works

Given a list of changed files, `reality-map` does a reverse BFS through the import graph:

1. Finds all files that directly import the changed files (depth 1)
2. Finds all files that import those (depth 2, 3, …)
3. Scores each affected file by proximity to the change + file size + importer count
4. Groups results by module for a high-level blast radius view

---

## Requirements

- Node.js 18+
- No other dependencies — zero npm install needed in your project

---

## Privacy

Everything runs locally. No files, paths, or code are ever uploaded anywhere.

---

## Contributing

- Maintained by [Vishal Gurung](https://github.com/g0GobliN).
- If you use or share `reality-map`, please credit the author and link back to `https://github.com/g0GobliN/reality-map`.
- Contributions are welcome via pull requests. Please open an issue first to discuss larger changes or feature requests.
- All changes are reviewed and merged by the maintainer.

---

## License

MIT © [Vishal Gurung](https://github.com/g0GobliN)
