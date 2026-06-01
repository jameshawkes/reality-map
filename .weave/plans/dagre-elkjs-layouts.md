# Dagre + ELKjs Graph Layouts — v3

## TL;DR
> **Summary**: Add two client-side graph layouts to the reality-map dashboard — `dagre` (Sugiyama layered, ~30 KB, eager-loaded) and `elk` (ELK layered via elkjs, ~700 KB, lazy-loaded on first click) — by vendoring pre-built UMD bundles into `packages/reality-map/public/vendor/` and wiring them into the existing `layoutPositions` / `switchLayout` pattern in `app.js`. Includes a corrective: invalidate cached layout positions on every node-set change (drill-in, back, depth change, rescan), which is a pre-existing bug for radial/force at four of those five sites. Frontend-only, no build step, no new npm runtime deps.
> **Estimated Effort**: Short (≈ 1–2 Yaks)

## Context

### Original Request
Add two new graph layout algorithms (dagre Sugiyama-layered, elkjs ELK) to the dashboard toolbar alongside the existing `layered`/`radial`/`force` buttons. Frontend-only, zero-build, lazy-load the heavy one.

### Key Findings (verified against the codebase)
- **Repo state**: branch `fix/workspace-module-grouping`, HEAD `7599c62 fix(rust): workspace-aware module grouping`. Dirty tree has `.weave/plans/*.md` and `packages/reality-map/public/app.js` modified — the new branch must be cut from a clean state so those don't ride along.
- **Static-server contract** (`packages/reality-map/lib/server.js`):
  - `PUBLIC = path.join(__dirname, "..", "public")` (line 17).
  - Static handler at line 247: `let file = url.pathname === "/" ? "/index.html" : url.pathname;` → `safe = path.normalize(path.join(PUBLIC, file))`, with a traversal guard `safe.startsWith(PUBLIC)`. Anything under `public/`, including subdirectories like `public/vendor/`, is served.
  - `MIME` map (line 22–28) includes `.js → application/javascript; charset=utf-8`. Vendored `.js` files get the correct content-type.
  - **Gotcha**: on `fs.readFile` error the handler falls back to `index.html` with 200 (lines 250–256). A typo in a vendored path silently returns HTML, which a `<script>` tag will then parse as JS and throw `Unexpected token '<'`. Step 3 / Step 8 must verify the file actually lands (HTTP 200 with `application/javascript`).
- **`packages/reality-map/package.json`**: zero runtime `dependencies` block (none declared). The `files` array includes `"public"`, so anything vendored under `public/vendor/` ships in the published npm tarball. This matters for bundle size and license attribution.
- **Existing layout machinery** (`packages/reality-map/public/app.js`, all line numbers verified):
  - Line 155–156: `// "server" | "radial" | "force"` then `let currentLayout = localStorage.getItem("rm-layout") || "server";`
  - Line 158: `const layoutPositions = { server: null, radial: null, force: null };`
  - Line 160–170: `function applyLayout(graph)` — given `layoutPositions[currentLayout]` as a `Map<id, {x,y}>`, returns a new `graph` with nodes spread + `x,y` overridden. Returns the input unchanged when positions are missing or layout is `"server"`.
  - Line 172–185: `function computeRadialPositions(nodes)` — pure synchronous, returns `Map<id, {x,y}>`. Centred at `(500, 320)`, radius scales with node count.
  - Line 187–238: `function computeForcePositions(nodes, edges)` — synchronous N² repulsion + edge attraction, 120 iters, normalises to `(60,60)` origin with 200 px padding. Returns same `Map` shape.
  - Line 240–263: `function switchLayout(layout)`:
    - Early-out if `layout === currentLayout`.
    - Sets `currentLayout`, persists to `localStorage`.
    - Lazy-computes positions for `radial` / `force` if `currentViewGraph` exists.
    - Toggles `.active` on `.layout-btn` elements.
    - Calls `render()` for `"server"`, otherwise `applyLayout` → `fit` → `draw`.
    - **Synchronous**: assumes computation returns a value, not a Promise.
  - Line 1054, 1108–1113: render-path lazy-fill — if `currentLayout` is non-server and `layoutPositions[layout]` is `null`, compute it just-in-time before draw.
  - Line 1123: `fitKey` includes `currentLayout` so zoom-fit invalidates when layout changes.
  - Line 1145–1151 (cluster-filter button onclick handler): clears `layoutPositions.radial = null; layoutPositions.force = null;` — **the only existing site that invalidates the position cache anywhere in the codebase.** There is no equivalent clear on depth change (line 308–315), drill-in / `onModuleClick` (line 897–927), back button (line 1849–1859), or — critically — the rescan path (`loadGraph(true)`, line 1862–1890). The "rescan clears positions" behaviour that v2 of this plan asserted was wrong: `loadGraph()` reassigns `scan`, `graphsByDepth`, `view`, `selected`, `stack` (lines 1875–1882), then calls `render()` at line 1887 — but never touches `layoutPositions`. Across a rescan, stale radial/force positions from the previous scan are reapplied to whichever new nodes happen to share an ID. This is a real latent bug that v3 fixes as a side-effect of Blocker 2 (see fix below).
  - Line 1832–1834: button wire-up — `document.querySelectorAll(".layout-btn")` reads `data-layout` and calls `switchLayout`.
  - Line 1862–1890: `async function loadGraph(fromButton)` — both the initial-load path (`fromButton=false`, calls `/api/graph`) and the rescan path (`fromButton=true`, called from `document.getElementById("reload").onclick` at line 1892, calls `/api/rescan`). After reassigning state at 1875–1882 and clearing `lastFitKey` at 1886, calls `render()` at 1887. Insertion point for `invalidateLayoutPositions()` is between 1886 and 1887 (after `lastFitKey = ""`, before `render()`). Note: this also fires on **initial** page load, which is fine — `layoutPositions` is already `{ server: null, radial: null, force: null }` at that point and nulling already-null slots is a no-op.

#### Coordinate model — node `x`/`y` are **top-left**, not centres (verified)
- Line 1434: `el("g", { class: "node-group", transform: `translate(${n.x} ${n.y})` })`. The node card's `foreignObject` then renders at `x=0, y=0` inside the translated group (lines 1450–1454). So `(n.x, n.y)` is the top-left of the rendered card.
- Lines 1373–1374 (edge routing): `const aCx = a.x + aW / 2, aCy = a.y + aH / 2;` and `const bCx = b.x + bW / 2, bCy = b.y + bH / 2;` — adds half-width/half-height to derive centres. Confirms `n.x/n.y` are top-left.
- Existing `computeRadialPositions` (line 172–185) and `computeForcePositions` (line 187–238) write their computed values directly to `positions.set(node.id, {x, y})` and `applyLayout` then assigns them straight to `n.x/n.y`. Both pre-existing layouts therefore implicitly treat their outputs as top-left coords (the radial centre at `(500, 320)` is actually the top-left of the bounding ring, not the ring's geometric centre — sloppy but consistent).
- **Rule for the new layouts**:
  - **dagre** returns node-centre coords (`g.node(id).x`, `g.node(id).y` are centres after `dagre.layout()`). **Must convert to top-left**: `x = centreX - width / 2`, `y = centreY - height / 2`.
  - **ELK** returns top-left coords on each laid-out child (`child.x`, `child.y` are the top-left of the rect). **Use directly. Do NOT add `width / 2` / `height / 2`.**
  - Both must use the same `(width, height) = (NW, NH) = (220, 70)` that `draw()` uses (the LOC-based per-node `extraW`/`extraH` scaling at line 1441–1444 is ignored by layout — same simplification the existing layouts make).
- **`NW`/`NH` scope**: declared inside `draw()` at line 1343 as `const NW = 220, NH = 70;`. New compute functions live outside `draw()`. Plan uses local consts in each compute fn rather than hoisting the originals to module scope (smaller diff, less risk of breaking unrelated `draw()` paths).

#### Existing toolbar HTML (`packages/reality-map/public/index.html` lines 164–166)
```html
<button type="button" class="layout-btn" data-layout="server" title="Server-computed layered layout">layered</button>
<button type="button" class="layout-btn" data-layout="radial" title="Radial / circular layout">radial</button>
<button type="button" class="layout-btn" data-layout="force" title="Force-directed layout">force</button>
```

#### CSS
`packages/reality-map/public/styles.css` line 581–588: `.layout-btn` styling is generic — new buttons inherit it automatically. No CSS changes required.

#### Fixtures available for verification
`packages/reality-map/__tests__/fixtures/rust/workspace-two-crates` (tiny, 2-crate) for a sanity check; `/home/james/gamedev/redpanda/redpanda` (325 files, 2138 edges, per the predecessor plan) for the stress case.

#### Library distribution facts
- **dagre** npm package ships `dist/dagre.min.js` UMD bundle (~30 KB). Globally exposes `dagre`, with `dagre.graphlib.Graph` constructor and `dagre.layout(g)` mutator. MIT license. The actively maintained fork is `@dagrejs/dagre` — pick that one and pin it in `vendor/README.md`.
- **elkjs** npm package ships `lib/elk.bundled.js` (UMD, ~700 KB, self-contained entry that exposes `window.ELK`) and a worker variant. EPL-2.0 license (NOT MIT — record this in `vendor/README.md`). `elk.layout(graph)` returns a `Promise<laidOutGraph>`. Default algorithm choice via `layoutOptions["elk.algorithm"] = "layered"`.

### Decision: vendor, do not depend
Vendor both bundles under `public/vendor/` and load via `<script>` tag. No bundler in the path; pinned files are deterministic and ship in the npm tarball; no risk of a downstream `npm install` drifting the API surface.

### Decision: lazy-load only elk, eager-load dagre
dagre at ~30 KB is below the noise floor. elk at ~700 KB roughly doubles initial page weight — lazy-inject on first user click, memoise the load promise.

### Decision: async-aware switchLayout, minimal blast radius
`computeElkPositions` returns a `Promise<Map>`. Keep `switchLayout` synchronous; the elk branch fire-and-forgets, writes into `layoutPositions.elk` when done, then calls `applyLayout`/`fit`/`draw`. Localises async to one branch.

### Decision (Blocker 2, option a): central invalidation helper
Add `function invalidateLayoutPositions()` that nulls every non-`server` slot (`radial`, `force`, `dagre`, `elk`). Call it from all **five** distinct node-set-changing sites:

| # | Site | Lines | Current state |
|---|---|---|---|
| a | Cluster-filter onclick handler | 1145–1151 | Currently has a two-line clear of `radial` and `force` only. **Replace** with helper call. |
| b | Depth change handler | 308–315 | No clear today. **Add** helper call before `render()` at line 314. |
| c | Drill-in (`onModuleClick`) | 897–927 | No clear today. **Add** helper call before `render()` at line 909. |
| d | Back-button handler | 1849–1859 | No clear today. **Add** helper call before `render()` at line 1858. |
| e | `loadGraph()` rescan path | 1862–1890 | No clear today. **Add** helper call between `lastFitKey = ""` (1886) and `render()` (1887). |

Scope expansion: this fixes a latent bug for radial/force at four of the five sites (everywhere except cluster-filter, which already partially clears). The bug at site (e) — stale positions surviving a rescan — is particularly nasty because node IDs frequently survive a rescan and the positions look plausible-but-wrong. The commit body must surface all of this explicitly.

Recompute cost is bounded: dagre and radial are O(n); force is O(n²·120) but bounded by per-view size (typically <100 nodes after drill-in). elk is gated by Blocker 3 fix (no auto-recompute on render path) and only fires on explicit click.

### Decision (Blocker 3, option b for elk, option a for dagre): mixed init policy
On page load, after `currentLayout` is read from `localStorage`:
- If `currentLayout === "elk"`: downgrade to `"server"`, write `"server"` back to `localStorage`. Reason: elk requires a 700 KB script-inject and an async compute; silently triggering it on tab-open would surprise the user and defeat the lazy-load promise. Document in the commit body and `vendor/README.md`.
- If `currentLayout === "dagre"`: leave as-is. The render-path lazy-fill (extended in Step 7) will synchronously compute `layoutPositions.dagre` on first draw. Cheap, no surprise.
- If `currentLayout` is `"radial"` or `"force"`: unchanged from current behaviour (render-path lazy-fill at line 1108–1111 already handles them).

## Objectives

### Core Objective
Two new functional layout buttons (`dagre`, `elk`) that compute legible top-left node positions on click, using vendored client-side libraries, with no build step, no new runtime deps, and zero changes to the existing three layouts' visual output beyond a corrective cache-invalidation that also benefits radial/force.

### Deliverables
- [ ] `public/vendor/` directory containing pinned `dagre.min.js` and `elk.bundled.js` plus a `README.md`.
- [ ] Two new toolbar buttons (`dagre`, `elk`) styled identically to existing layout buttons.
- [ ] `computeDagrePositions(nodes, edges)` returning `Map<id, {x, y}>` with **top-left** coords.
- [ ] async `computeElkPositions(nodes, edges)` returning `Map<id, {x, y}>` with **top-left** coords.
- [ ] `layoutPositions` extended with `dagre: null, elk: null`.
- [ ] `invalidateLayoutPositions()` helper, called from all five distinct sites: cluster-filter toggle (1145), depth change (308), drill-in (897), back button (1849), and `loadGraph()` rescan path (1862).
- [ ] Init-time policy: `currentLayout === "elk"` is downgraded to `"server"` on load; dagre auto-computes via the existing render-path lazy-fill.
- [ ] Lazy-load harness for elk (single-shot promise; subsequent clicks reuse the loaded global).
- [ ] `switchLayout` extended to handle both new cases; elk branch handles async without making the whole function async.
- [ ] Single commit on a new branch `feat/dagre-elk-layouts` cut from `7599c62`.

### Definition of Done
- [ ] `npx vitest run` from repo root: 137/137 passing — no test files touched.
- [ ] `node packages/reality-map/bin/cli.js --root packages/reality-map/__tests__/fixtures/rust/workspace-two-crates --no-open` starts; visiting `http://localhost:4317/vendor/dagre.min.js` returns HTTP 200 with `application/javascript` content-type and a UMD-shaped body.
- [ ] Same for `vendor/elk.bundled.js`.
- [ ] Clicking `dagre` rearranges the workspace-two-crates graph; `localStorage.rm-layout === "dagre"`; nodes do not overlap (top-left coord conversion correct).
- [ ] Clicking `elk` shows transient loading state, injects script exactly once, rearranges nodes; second click is instant; nodes do not overlap (top-left coords from ELK used directly).
- [ ] Drilling into a module while on `dagre` recomputes positions for the new node set (cache cleared by `invalidateLayoutPositions` via the drill-in site).
- [ ] Changing depth while on `radial` or `force` recomputes positions (corrective fix for pre-existing bug at depth-change site).
- [ ] Triggering a rescan (`R` key / reload button) while on `radial`, `force`, or `dagre` recomputes positions against the new scan (corrective fix for pre-existing bug at the `loadGraph()` rescan site — stale positions were surviving rescans on the basis of unchanged node IDs).
- [ ] Reloading the page with `localStorage.rm-layout === "elk"` shows `server` layout active and `localStorage.rm-layout` rewritten to `"server"`; no elk script fetch in the network panel.
- [ ] Reloading with `localStorage.rm-layout === "dagre"` shows `dagre` button active and nodes laid out by dagre on first paint, with no eager-load of elk.
- [ ] On the redpanda graph (325 nodes / 2138 edges), dagre completes in <500 ms and elk in <5 s on dev hardware — or actuals documented.

### Guardrails (Must NOT)
- Do not touch `lib/scan.js`, `lib/rust.js`, `lib/server.js`, or anything under `__tests__/`.
- Do not add entries to `packages/reality-map/package.json` `dependencies` or `devDependencies`.
- Do not introduce a bundler, transpile step, or `node_modules`-resolution for browser code.
- Do not change the JSON contract between server and client.
- Do not modify the existing `server` / `radial` / `force` compute functions themselves.
- Do not make `switchLayout` itself `async`.
- Do not couple the elk web-worker variant — explicit non-goal.
- **Do not convert dagre output as if it were top-left, and do not convert ELK output as if it were centres** — direction of conversion matters.

## TODOs

- [x] 1. **Baseline + branch**
  **What**: From a clean working tree at `7599c62`, create branch `feat/dagre-elk-layouts`. Confirm `npx vitest run` is green before any change. Stash or commit existing dirty plan files separately.
  **Acceptance**: `git status` clean on new branch; `npx vitest run` reports 137 passing; `git rev-parse HEAD` is `7599c62`.

- [x] 2. **Re-verify layout anchor points and coordinate model in `app.js`**
  **What**: Re-read lines 155–263, 308–315, 897–927, 1054, 1108–1113, 1123, 1145–1151, 1343–1344, 1373–1374, 1432–1454, 1832–1834, 1849–1859 to confirm line numbers still hold. Note insertion points for: (a) extending `layoutPositions`, (b) inserting new compute functions, (c) extending `switchLayout`, (d) extending the render-path lazy-fill, (e) replacing the rescan / cluster-filter resets with `invalidateLayoutPositions()`, (f) the init-time policy hook for elk-on-reload. Confirm the coordinate model: `n.x/n.y` are top-left (verified at line 1434 + 1373–1374).
  **Acceptance**: Short note in commit body lists the insertion-point line numbers as found at start of work; if any drifted, update plan in place before continuing.

- [x] 3. **Create `public/vendor/` and write `vendor/README.md`**
  **What**: Create directory. Author `vendor/README.md` listing for each bundle: package name, pinned version, exact source URL, byte size, SHA-256, license (MIT for dagre, EPL-2.0 for elkjs), and a 3-line upgrade procedure. Add a note: "elk is lazy-loaded; if `localStorage.rm-layout === 'elk'` on reload, the dashboard downgrades to `server` to avoid a surprise 700 KB fetch."
  **Files**: `packages/reality-map/public/vendor/README.md` (new)
  **Acceptance**: `ls packages/reality-map/public/vendor/` shows `README.md`; six metadata fields per library; init-time note present.

- [x] 4. **Vendor `dagre.min.js`**
  **What**: Download pinned `dist/dagre.min.js` from `@dagrejs/dagre`. Save as `packages/reality-map/public/vendor/dagre.min.js`. Record size + SHA-256 in `vendor/README.md`.
  **Files**: `packages/reality-map/public/vendor/dagre.min.js` (new); `vendor/README.md` (update)
  **Acceptance**: File 25–60 KB; UMD-shaped first bytes; README row complete.

- [x] 5. **Include dagre in `index.html` and smoke-test the global**
  **What**: Add `<script src="vendor/dagre.min.js"></script>` BEFORE `<script src="app.js"></script>` in `index.html`. Start dashboard against `workspace-two-crates`. In browser console verify `typeof dagre.graphlib.Graph === "function"` and `typeof dagre.layout === "function"`.
  **Files**: `packages/reality-map/public/index.html` (modify)
  **Acceptance**: Both globals present; network panel shows `vendor/dagre.min.js` 200 with `application/javascript`; no console errors on load.

- [x] 6. **Implement `computeDagrePositions(nodes, edges)` with top-left conversion**
  **What**: Add a new function in `app.js` immediately after `computeForcePositions` (around line 239). Inside:
    - `const NW = 220, NH = 70;` (local consts to avoid hoisting from `draw()`)
    - `const g = new dagre.graphlib.Graph({ multigraph: false, compound: false });`
    - `g.setGraph({ rankdir: "TB", nodesep: 60, ranksep: 90, marginx: 40, marginy: 40 });`
    - `g.setDefaultEdgeLabel(() => ({}));`
    - For each node: `g.setNode(n.id, { width: NW, height: NH });`
    - For each edge: `g.setEdge(e.source, e.target);`
    - `console.time("rm-dagre"); dagre.layout(g); console.timeEnd("rm-dagre");`
    - Read back **and convert centre→top-left**: `g.nodes().forEach((id) => { const { x, y } = g.node(id); positions.set(id, { x: Math.round(x - NW / 2), y: Math.round(y - NH / 2) }); });`
    - If `nodes.length === 0`, return empty Map.
  **Files**: `packages/reality-map/public/app.js` (modify)
  **Acceptance**: On workspace-two-crates (4 modules), function returns a Map of size 4; no two entries share `(x, y)`; calling `draw()` after `applyLayout` produces visibly non-overlapping cards (visual confirmation that top-left conversion is correct).

- [x] 7. **Add `dagre` button + extend `switchLayout` + render-path lazy-fill + `layoutPositions` shape**
  **What**:
    - `index.html`: add `<button type="button" class="layout-btn" data-layout="dagre" title="Dagre Sugiyama layered">dagre</button>` after the `force` button.
    - `app.js` line 158: `const layoutPositions = { server: null, radial: null, force: null, dagre: null, elk: null };` (do both keys at once).
    - `switchLayout` (line 246–247 area): add `if (layout === "dagre") layoutPositions.dagre = computeDagrePositions(currentViewGraph.nodes, currentViewGraph.edges);`
    - Render-path lazy-fill (line 1108–1113): add `if (currentLayout === "dagre" && !layoutPositions.dagre) layoutPositions.dagre = computeDagrePositions(graph.nodes, graph.edges);`
  **Files**: `index.html`, `app.js`
  **Acceptance**: Toolbar shows five buttons; clicking `dagre` toggles `.active`, persists `rm-layout=dagre`, visibly re-positions nodes; nodes are non-overlapping.

- [x] 8. **Add `invalidateLayoutPositions()` helper and wire into all five node-set-changing sites**
  **What**:
    - Add helper near `layoutPositions` (top of the closure, around line 159):
      ```js
      function invalidateLayoutPositions() {
        layoutPositions.radial = null;
        layoutPositions.force = null;
        layoutPositions.dagre = null;
        layoutPositions.elk = null;
      }
      ```
    - **Site (a) — cluster-filter onclick handler (lines 1145–1151)**: replace the existing two-line clear
      ```js
      layoutPositions.radial = null;
      layoutPositions.force = null;
      ```
      with `invalidateLayoutPositions();`. Same effect for radial/force; additionally clears dagre/elk so they don't go stale across a cluster-filter change either.
    - **Site (b) — depth-change handler (lines 308–315)**: insert `invalidateLayoutPositions();` immediately before `render();` at line 314. Currently absent — this is the corrective fix for the depth-change stale-positions bug on radial/force.
    - **Site (c) — drill-in (`onModuleClick`, lines 897–927)**: insert `invalidateLayoutPositions();` immediately before `render();` at line 909 (the drill-in branch). Do NOT add it to the max-depth toggle/select branch at lines 913–926 — that branch only changes `selected` and never changes the node set, so positions remain valid. Currently absent — corrective fix.
    - **Site (d) — back-button handler (lines 1849–1859)**: insert `invalidateLayoutPositions();` immediately before `render();` at line 1858. Currently absent — corrective fix.
    - **Site (e) — `loadGraph()` rescan path (lines 1862–1890)**: insert `invalidateLayoutPositions();` between `lastFitKey = "";` (line 1886) and `render();` (line 1887). This fires on both initial page load (`fromButton=false`) and on rescan (`fromButton=true`). Initial-load case is a no-op (slots already null). Rescan case is the corrective fix for the most serious manifestation of the latent bug: node IDs typically survive a rescan, so radial/force positions were being silently reapplied to nodes that may have moved in dependency space — a "the layout didn't update" UX bug. Currently absent — corrective fix.
    - **Do not** add it to the no-op early-out branches anywhere (e.g. `if (layout === currentLayout) return;` at line 241, the max-depth toggle branch at 913–926).
    - **Commit body must explicitly list all five sites** and call out that four of them (b, c, d, e) are corrective fixes for pre-existing radial/force bugs that the user has been living with. Site (e) is the most user-visible — a rescan that "didn't seem to do anything" to the layout.
  **Files**: `app.js`
  **Acceptance**:
    - Drilling into a module on `radial` recomputes positions for the new subset (not the parent view's positions reapplied by node-ID lucky-match). Verify in console: `layoutPositions.radial` is `null` immediately after the drill-in event, then becomes a fresh `Map` once `render()` hits the lazy-fill at line 1108.
    - Changing depth on `force` triggers a fresh force simulation (`console.time` log fires once).
    - Pressing the reload button: `layoutPositions.radial`, `.force`, `.dagre`, `.elk` are all `null` immediately after `loadGraph(true)` resolves, then the relevant ones rehydrate via the render-path lazy-fill.
    - Cluster-filter toggle clears all four slots (not just radial/force).
    - Max-depth toggle (clicking an already-selected module at max depth) does NOT clear positions — the node set is unchanged.

- [x] 9. **Vendor `elk.bundled.js`**
  **What**: Download pinned `lib/elk.bundled.js` from `elkjs`. Save as `packages/reality-map/public/vendor/elk.bundled.js`. Record size, SHA-256, and **EPL-2.0** license in `vendor/README.md`. Do NOT add a `<script>` tag for it.
  **Files**: `vendor/elk.bundled.js` (new); `vendor/README.md` (update)
  **Acceptance**: File 600–800 KB; EPL-2.0 explicit in README; no `<script>` for it in `index.html` (`grep -F 'elk.bundled.js' packages/reality-map/public/index.html` returns 0 hits).

- [x] 10. **Implement elk lazy-loader and `computeElkPositions(nodes, edges)` using top-left coords directly**
  **What**: In `app.js` near the new dagre function:
    - `let _elkLoadPromise = null; let _elkInstance = null;`
    - ```js
      function loadElk() {
        if (_elkLoadPromise) return _elkLoadPromise;
        _elkLoadPromise = new Promise((resolve, reject) => {
          const s = document.createElement("script");
          s.src = "vendor/elk.bundled.js";
          s.async = true;
          s.onload = () => {
            try { _elkInstance = new ELK(); resolve(_elkInstance); }
            catch (e) { reject(e); }
          };
          s.onerror = () => reject(new Error("failed to load vendor/elk.bundled.js"));
          document.head.appendChild(s);
        });
        return _elkLoadPromise;
      }
      ```
    - ```js
      async function computeElkPositions(nodes, edges) {
        if (!nodes.length) return new Map();
        const NW = 220, NH = 70;
        const elk = await loadElk();
        const graph = {
          id: "root",
          layoutOptions: {
            "elk.algorithm": "layered",
            "elk.direction": "DOWN",
            "elk.layered.spacing.nodeNodeBetweenLayers": "80",
            "elk.spacing.nodeNode": "40",
          },
          children: nodes.map(n => ({ id: n.id, width: NW, height: NH })),
          edges: edges.map((e, i) => ({ id: `e${i}`, sources: [e.source], targets: [e.target] })),
        };
        console.time("rm-elk");
        const laid = await elk.layout(graph);
        console.timeEnd("rm-elk");
        const positions = new Map();
        for (const c of laid.children || []) {
          // ELK returns top-left coords; node n.x/n.y are also top-left → no conversion
          positions.set(c.id, { x: Math.round(c.x), y: Math.round(c.y) });
        }
        return positions;
      }
      ```
    - **Critical**: do NOT add `width / 2` or `height / 2` here — ELK's `child.x`/`child.y` are already the top-left of the rect, matching the existing `n.x/n.y` convention.
  **Files**: `app.js`
  **Acceptance**: Calling `await computeElkPositions(currentViewGraph.nodes, currentViewGraph.edges)` in console on workspace-two-crates injects the script (visible once in network panel), returns a Map of size 4 with sane integer top-left coords; second call does not re-inject; visual check that nodes do not overlap after `applyLayout`.

- [x] 11. **Add `elk` button + async branch in `switchLayout`**
  **What**:
    - `index.html`: add `<button type="button" class="layout-btn" data-layout="elk" title="ELK layered (lazy-loaded, recomputes on click)">elk</button>` after the `dagre` button.
    - In `switchLayout`, handle elk separately from the synchronous block:
      ```js
      if (layout === "elk" && currentViewGraph) {
        if (!layoutPositions.elk) {
          const hud = document.getElementById("hud");
          const prevHud = hud ? hud.textContent : "";
          if (hud) hud.textContent = "elk laying out…";
          const inFlightGraph = currentViewGraph;
          computeElkPositions(inFlightGraph.nodes, inFlightGraph.edges).then((map) => {
            layoutPositions.elk = map;
            if (hud) hud.textContent = prevHud;
            // guard: user may have switched away while we were loading
            if (currentLayout !== "elk" || currentViewGraph !== inFlightGraph) return;
            const laid = applyLayout(currentViewGraph);
            currentViewGraph = laid;
            fit(laid);
            draw(laid);
          }).catch((e) => {
            if (hud) hud.textContent = prevHud;
            console.error("[reality-map] elk layout failed:", e);
          });
          return; // sync path below skipped; .then() will draw
        }
        // else: cached, fall through to the sync apply/fit/draw path below
      }
      ```
    - **Render-path lazy-fill caveat**: do NOT auto-trigger elk compute from the render path (line 1108–1113). Reason: drill-in / depth-change calls `invalidateLayoutPositions()` (Step 8), which sets `layoutPositions.elk = null`. If the render path auto-triggered elk on null, every drill-in would silently fire a heavy async compute. Instead, when `currentLayout === "elk"` and `layoutPositions.elk` is null at render-time, the render path leaves the layout as-is (effectively falls back to whatever positions are on the nodes — usually the server-computed layout). The user re-clicks `elk` to recompute on the new view. Document this in the button title (already done: "recomputes on click").
    - **Do not** add elk to the synchronous block at line 246–247.
  **Files**: `index.html`, `app.js`
  **Acceptance**: Six buttons in toolbar; first elk click shows transient HUD + injects script once; nodes re-position non-overlapping; second click instant; switching away mid-flight does not produce a stale draw (guard fires); drilling-in while on elk leaves the previous view's node positions visible until user re-clicks elk.

- [x] 12. **Init-time policy: elk-on-reload downgrade, dagre-on-reload auto-compute**
  **What**: Immediately after line 156 (`let currentLayout = localStorage.getItem("rm-layout") || "server";`), add:
    ```js
    // Elk requires a 700KB script-inject + async compute; don't auto-fire on tab open.
    // Downgrade silently to server; the user can re-click elk if they want it.
    if (currentLayout === "elk") {
      currentLayout = "server";
      localStorage.setItem("rm-layout", "server");
    }
    // Dagre is synchronous and cheap; the render-path lazy-fill (Step 7) will
    // compute layoutPositions.dagre on first draw, so no init action needed here.
    ```
    - Verify the button wire-up at line 1832–1834 picks up the corrected `currentLayout` value when setting `.active` (it reads the live variable, not the localStorage value, so this works).
  **Files**: `app.js`
  **Acceptance**: Set `localStorage.rm-layout = "elk"`, reload — `server` button is active, `localStorage.rm-layout` is rewritten to `"server"`, no `vendor/elk.bundled.js` request in network panel. Set `localStorage.rm-layout = "dagre"`, reload — `dagre` button is active, nodes are laid out by dagre on first paint, no `vendor/elk.bundled.js` request, `console.time("rm-dagre")` fires once.

- [x] 13. **Coordinate-system + cycles spot-check on real graphs**
  **What**: On `workspace-two-crates` and the redpanda graph, verify for each new layout: (a) no two nodes share identical `(x, y)`; (b) cards do not visibly overlap after `applyLayout` + `draw` (this is the empirical confirmation that top-left conversion is correct — overlapping = wrong coordinate convention); (c) `fit()` still zooms-to-fit correctly; (d) cyclic edges are handled (dagre breaks cycles silently; elk-layered has its own cycle handling). Record qualitative legibility notes + actual timings in the commit body.
  **Acceptance**: Notes captured. If overlap is observed, re-check the coord-conversion (Step 6 for dagre, Step 10 for elk) before shipping.

- [x] 14. **No-build + no-dep sanity**
  **What**:
    - `git diff packages/reality-map/package.json` → empty.
    - `git diff packages/reality-map/package-lock.json` → empty.
    - `git diff --stat` shows only: `public/index.html`, `public/app.js`, `public/vendor/README.md`, `public/vendor/dagre.min.js`, `public/vendor/elk.bundled.js`.
    - `npx vitest run` from repo root → 137/137 passing.
    - `node packages/reality-map/bin/cli.js --root packages/reality-map/__tests__/fixtures/rust/workspace-two-crates --no-open` boots.
    - `curl -sI http://127.0.0.1:4317/vendor/dagre.min.js` → 200 + `application/javascript`.
    - `curl -sI http://127.0.0.1:4317/vendor/elk.bundled.js` → 200 + `application/javascript`.
    - `curl -sI http://127.0.0.1:4317/vendor/nope.js` → returns the index.html fallback (negative control for the footgun).
  **Acceptance**: All checks pass.

- [x] 15. **Commit**
  **What**: Single commit on `feat/dagre-elk-layouts`. Title: `feat(ui): add dagre and elk layout options`. Body lists: vendored files with versions / sizes / licenses (MIT + EPL-2.0), lazy-load decision for elk, six toolbar buttons, the **corrective cache-invalidation fix that also benefits radial/force on drill-in / depth-change / back**, the init-time downgrade policy for `rm-layout=elk`, "no new runtime deps" line, and qualitative legibility / timing notes from Step 13.
  **Acceptance**: `git log -1 --stat` shows exactly the five files; body covers all listed sections; branch `feat/dagre-elk-layouts` cut from `7599c62`.

## Verification
- [ ] `npx vitest run` from repo root: 137/137 passing.
- [ ] `git diff main -- packages/reality-map/package.json packages/reality-map/package-lock.json` is empty.
- [ ] `git diff --stat main` lists exactly five paths under `packages/reality-map/`.
- [ ] Dashboard boots; six layout buttons visible.
- [ ] `curl -sI .../vendor/dagre.min.js` → 200 + `application/javascript`.
- [ ] `curl -sI .../vendor/elk.bundled.js` → 200 + `application/javascript`.
- [ ] On load: `typeof dagre.layout === "function"` immediately; `typeof ELK === "undefined"` until first `elk` click.
- [ ] Click `dagre`: nodes re-position non-overlapping; `localStorage.rm-layout === "dagre"`.
- [ ] Click `elk` (first time): one fetch of `vendor/elk.bundled.js` in network panel; transient HUD; nodes re-position non-overlapping.
- [ ] Click `elk` (subsequent same-page): no re-fetch.
- [ ] Drill into a module on `dagre`: positions recompute for new view (no stale parent-view positions). [Site c]
- [ ] Change depth on `radial`: positions recompute (corrective fix). [Site b]
- [ ] Click back button on `force`: positions recompute (corrective fix). [Site d]
- [ ] Toggle a cluster filter on `dagre`: positions recompute, including `elk` slot also cleared. [Site a]
- [ ] Press reload button (rescan): all of `layoutPositions.{radial,force,dagre,elk}` are null between `loadGraph(true)` resolving and the subsequent `render()` lazy-fill. [Site e — corrective fix for the most user-visible stale-positions case]
- [ ] Set `localStorage.rm-layout = "elk"` and reload: `server` active, localStorage rewritten, no elk fetch.
- [ ] Set `localStorage.rm-layout = "dagre"` and reload: `dagre` active, dagre layout applied on first paint, no elk fetch.
- [ ] redpanda graph: dagre <500 ms, elk <5 s, or actuals documented.

## Non-goals / explicit deferrals
- Web-worker variant of elkjs.
- User-tweakable layout parameters (rankdir, spacing, algorithm picker).
- Persisting computed positions across reloads (only the layout *name* persists; positions recompute).
- Edge bundling, curve smoothing, port routing.
- Graph-keyed cache (option b from Blocker 2). Could be a follow-up if recompute cost becomes painful on huge graphs.
- Touching `lib/impact.js`'s `moduleOfPath()`.
- README user-docs update.

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Static-server fallback to `index.html` masks a missing vendor file → `<script>` errors with `Unexpected token '<'` | Medium | Step 14 curls both URLs and checks status + content-type; negative-control curl to `/vendor/nope.js` documents the footgun. |
| dagre coordinate conversion forgotten or sign-flipped (centre vs top-left) | Medium → Low after fix | Plan states the conversion rule explicitly in Step 6 with the formula; visual overlap check in Step 13 catches sign errors. |
| ELK coordinate conversion applied by mistake (treating top-left as centre) | Medium → Low after fix | Plan states explicitly in Step 10: do NOT add `width/2`; Step 13 visual overlap check catches errors. |
| `invalidateLayoutPositions()` called too aggressively → noticeable recompute lag for radial/force on every drill-in | Low | radial is O(n), force is O(n²·120) but bounded by view-size (typically <100 nodes per view after drill-in). Acceptable. dagre similar to radial. elk gated by Blocker 3 fix (no auto-recompute). |
| Drill-in path has multiple sites needing invalidation | Low | Step 2 re-verifies anchors; Step 8 enumerates the five sites. |
| Async race in elk branch produces stale draw after user switches away | Medium → Low after fix | Guard in Step 11: `if (currentLayout !== "elk" || currentViewGraph !== inFlightGraph) return;` |
| dagre UMD doesn't expose `window.dagre` cleanly | Low | Step 5 verifies before any layout code is written. |
| Page-weight regression on initial load if elk eager-loaded by mistake | Low | Lazy-load only path; Step 9 acceptance includes `grep -F 'elk.bundled.js' index.html` → 0 hits. |
| `NW`/`NH` mismatch between layout code and `draw()` | Low | Both use literal `220, 70`. Document in `vendor/README.md` if `draw()` ever switches to dynamic values, layout code must follow. |
| elkjs EPL-2.0 vs project MIT | Low | `vendor/README.md` records explicitly. EPL-2.0 of a vendored runtime library is compatible for distribution but must be disclosed. |
| Vendor files get stale relative to upstream security fixes | Medium | `vendor/README.md` documents pinned versions + upgrade procedure. |
| `currentLayout === "elk"` on reload surprises with 700 KB fetch | N/A — explicitly prevented | Init-time downgrade in Step 12. |

## Effort
≈ 1–2 Yaks (1–2 human hours, ≈10 min AI). The async race-guard in `switchLayout`, the central invalidation helper, and the init-time downgrade are the only non-mechanical pieces.

## Changes from v1

v2 addresses three blockers from Weft's REJECT of v1.

- **Blocker 1 — Coordinate model**. v1 incorrectly claimed `applyLayout` consumes centre coords. Verified against code: `draw()` at line 1434 uses `translate(${n.x} ${n.y})` directly and lines 1373–1374 derive centres by adding half-width/half-height, proving `n.x/n.y` are **top-left**. Fix: dagre output (centres) is converted to top-left via `x - NW/2, y - NH/2` in Step 6; ELK output (already top-left) is used directly in Step 10 with no conversion. The rule is stated explicitly in the "Coordinate model" subsection of Context and reiterated in both implementation steps with the exact formula. Step 13 adds an empirical "no overlap" visual check that catches any direction error.

- **Blocker 2 — Cache invalidation underspecified**. v1 relied on the existing render-path lazy-fill, which only triggers when a layout slot is `null` — but no event nulls the slot on drill-in, depth change, or back. **Chose option (a)**: a central `invalidateLayoutPositions()` helper that nulls all four non-server slots. (v2's specific site enumeration was wrong — see v3 fix below.)

- **Blocker 3 — Persisted `rm-layout=elk` on reload**. v1 didn't address this; a reload with `rm-layout=elk` would show the elk button active but never trigger lazy-load. **Chose option (b) for elk, option (a) for dagre**: in Step 12, immediately after reading `currentLayout` from `localStorage` at line 156, if it equals `"elk"`, downgrade to `"server"` and write `"server"` back to localStorage. For `"dagre"` (lightweight, sync), leave as-is — the render-path lazy-fill extended in Step 7 will compute it on first draw. This preserves the lazy-load contract (no 700 KB fetch on tab open) while keeping dagre's "remembered last layout" UX working. Documented in `vendor/README.md` per Step 3 and in the commit body per Step 15.

Other notable changes from v1:
- Step count grew from 13 to 15 (added Step 8 for `invalidateLayoutPositions`, Step 12 for init-time policy).
- "Coordinate model" subsection added to Context, with line-number citations for top-left evidence.
- Three new explicit Guardrails added (no centre/top-left direction flip, no elk auto-recompute on render path).
- Risk register reordered and the three blocker risks are now marked "Medium → Low after fix" to reflect that the plan resolves them.
- Scope-expansion call-out: this PR now fixes a pre-existing radial/force bug (cache reuse across views). Step 15 requires the commit body to surface this explicitly.

## Changes from v2 → v3

v3 fixes one blocker from Weft's REJECT of v2: the cache-invalidation sites were misidentified.

- **Blocker (v2 Step 8 site enumeration was wrong)**. v2 claimed the rescan path was at "line 1147–1148" (the existing two-line clear of radial/force). That is actually the **cluster-filter onclick handler** — not rescan. The real rescan path is `loadGraph(true)` at lines 1862–1890, and **it does not currently clear `layoutPositions` at all**. This meant v2 would have:
  - Re-replaced the cluster-filter clear (intended).
  - Silently no-op'd on the rescan path it claimed to be fixing (a real existing bug left in place).
  - Counted only four distinct sites while claiming five.

  Verified against code:
  - Site (a) cluster-filter onclick: **1145–1151**, has the two-line clear at 1147–1148.
  - Site (b) depth-change handler: **308–315**, no clear.
  - Site (c) drill-in (`onModuleClick`): **897–927**, no clear; insertion at 909 (drill-in branch only — NOT the max-depth toggle branch at 913–926).
  - Site (d) back-button handler: **1849–1859**, no clear; insertion at 1858.
  - Site (e) `loadGraph()` rescan path: **1862–1890**, no clear today; insertion between `lastFitKey = ""` (1886) and `render()` (1887). Fires on initial load (no-op since slots are null) and on rescan (the real fix).

  v3 Step 8 rewritten with a site table and per-site insertion-point line numbers. Definition of Done, Verification, and the Blocker 2 decision block updated to reference rescan as site (e) explicitly. The corrective scope expansion now covers four pre-existing bugs (sites b, c, d, e), not three — site (e), where stale positions silently survive a rescan, is the most user-visible and was the bug v2 thought it was already fixing.

- Step count unchanged at 15.
- Risk register entry for "Drill-in path has multiple sites needing invalidation" implicitly broadened — five sites, enumerated.
