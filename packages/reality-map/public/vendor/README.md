# Vendored Browser Libraries

These files are pre-built UMD bundles vendored directly into `public/vendor/` so the
dashboard can load them via `<script>` tags without a bundler or npm install.

## dagre (Sugiyama layered layout)

| Field | Value |
|---|---|
| Package | `@dagrejs/dagre` |
| Version | 3.0.0 |
| Source URL | https://unpkg.com/@dagrejs/dagre/dist/dagre.min.js |
| File | `vendor/dagre.min.js` |
| Size | 40949 bytes |
| SHA-256 | 1c0a293258078a8e7d34493e3500d7a1018434e30e5a30d81318d98328bde655 |
| License | MIT |

### Upgrade procedure
1. `npm pack @dagrejs/dagre` to get the tarball
2. Extract `dist/dagre.min.js` and replace `vendor/dagre.min.js`
3. Update version, size, and SHA-256 in this README

---

## elkjs (ELK graph layout engine)

| Field | Value |
|---|---|
| Package | `elkjs` |
| Version | 0.11.1 |
| Source URL | https://unpkg.com/elkjs/lib/elk.bundled.js |
| File | `vendor/elk.bundled.js` |
| Size | 1607470 bytes (1.53 MB) |
| SHA-256 | 20dd2114d683ce758b3ce19bcc56e28a504a617b0d280f760407c37314631d0e |
| License | **EPL-2.0** (Eclipse Public License 2.0 — NOT MIT) |

**License note**: elkjs is EPL-2.0. This is a weak copyleft license. The vendored file is
kept separate in `vendor/` with this attribution. Downstream consumers should be aware.

### Upgrade procedure
1. `npm pack elkjs` to get the tarball
2. Extract `lib/elk.bundled.js` and replace `vendor/elk.bundled.js`
3. Update version, size, and SHA-256 in this README

---

## Init-time behaviour note

elk is lazy-loaded (injected via `<script>` on first user click of the `elk` button).
If `localStorage.rm-layout === 'elk'` on page reload, the dashboard silently downgrades
to `server` layout to avoid a surprise 1.5 MB fetch on tab open. The user can re-click
`elk` to trigger the load.

dagre (~30 KB) is eager-loaded via `<script src="vendor/dagre.min.js">` in `index.html`.

---

## NW/NH note

Both layout engines use `width=220, height=70` (matching `NW`/`NH` in `draw()`).
If `draw()` ever changes these constants, update the layout compute functions accordingly.
