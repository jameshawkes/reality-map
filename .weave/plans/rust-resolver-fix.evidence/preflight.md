# Unsupported-Idiom Preflight

| Repo | #[path=] | pub use | extern crate | macro_rules! |
|------|----------|---------|--------------|--------------|
| redpanda | 6 | 62 | 0 | 1 |
| redpanda-physics | 13 | 62 | 0 | 1 |
| redpanda-terrain | 6 | 71 | 0 | 1 |
| redpanda-vessel-builder | 0 | 41 | 0 | 1 |
| redpanda-wasm | 0 | 0 | 0 | 0 |
| **TOTAL** | **25** | **236** | **0** | **4** |

## Notes
- `redpanda-wasm` repo does not exist at `/home/james/gamedev/redpanda/redpanda-wasm/` — all counts recorded as 0.
- `pub use` total of 236 is the highest count but is handled (captured as real deps).
- `#[path=]` total of 25 (redpanda-physics has 13, the highest single-repo count) — conservative drop rule applies regardless of count.
- `extern crate` is 0 across all repos — no legacy extern crate usage.
- `macro_rules!` total of 4 (one per existing repo) — treated as always-present modules.
- Counts are line-level occurrences in `.rs` files, excluding `target/` and `_build/` directories.
- `rg -g '!target'` glob was found to be insufficient for nested target dirs; counts were obtained via `find -not -path "*/target/*"` piped through `grep -c`.
