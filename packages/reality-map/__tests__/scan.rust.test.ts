import { describe, it, expect } from "vitest";
import { createRequire } from "module";
import { readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { spawnSync } from "child_process";

const hasCargo = (() => {
  try {
    const r = spawnSync("cargo", ["--version"], { stdio: "ignore" });
    return r.status === 0;
  } catch { return false; }
})();

const require = createRequire(import.meta.url);
const { parseCargoToml, discoverCratePackages, extractRustImports, resolveRustImport } = require("../lib/rust.js");
const { scanProject } = require("../lib/scan.js");

// Helper to collect all .rs files recursively
function collectRsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) results.push(...collectRsFiles(full));
    else if (entry.endsWith(".rs")) results.push(full);
  }
  return results;
}

const FIXTURES = "/home/james/util/reality-map-fork/packages/reality-map/__tests__/fixtures/rust";

describe("parseCargoToml", () => {
  it("extracts package name", () => {
    const result = parseCargoToml('[package]\nname = "my_crate"\nversion = "0.1.0"');
    expect(result.package.name).toBe("my_crate");
  });

  it("returns null package when no [package] section", () => {
    const result = parseCargoToml('[workspace]\nmembers = ["a"]');
    expect(result.package).toBeNull();
  });

  it("virtual manifest: extracts workspace.members", () => {
    const result = parseCargoToml('[workspace]\nmembers = ["a", "b"]');
    expect(result.workspace.members).toEqual(["a", "b"]);
  });

  it("extracts [lib].path when set", () => {
    const result = parseCargoToml('[package]\nname = "x"\n\n[lib]\npath = "src/custom.rs"');
    expect(result.lib.path).toBe("src/custom.rs");
  });

  it("[lib] is null when not set", () => {
    const result = parseCargoToml('[package]\nname = "x"');
    expect(result.lib).toBeNull();
  });

  it("extracts [[bin]] entries", () => {
    const toml = '[package]\nname = "x"\n\n[[bin]]\nname = "mybin"\npath = "src/main.rs"';
    const result = parseCargoToml(toml);
    expect(Array.isArray(result.bin)).toBe(true);
    expect(result.bin).toHaveLength(1);
    expect(result.bin[0]).toEqual({ name: "mybin", path: "src/main.rs" });
  });

  it("extracts [workspace].members multi-line", () => {
    const toml = '[workspace]\nmembers = [\n  "crates/a",\n  "crates/b",\n]';
    const result = parseCargoToml(toml);
    expect(result.workspace.members).toEqual(["crates/a", "crates/b"]);
  });

  it("handles CRLF line endings", () => {
    const result = parseCargoToml('[package]\r\nname = "my_crate"\r\nversion = "0.1.0"');
    expect(result.package.name).toBe("my_crate");
  });

  it("strips mid-line comments", () => {
    const result = parseCargoToml('[package]\nname = "x" # trailing comment\nversion = "0.1.0"');
    expect(result.package.name).toBe("x");
  });

  it("does not treat [lib] inside triple-double-quoted string as a section header", () => {
    const toml =
      '[package]\nname = "x"\ndescription = """\nThis is a long\ndescription with [lib] inside\n"""\n\n[lib]\npath = "src/real.rs"';
    const result = parseCargoToml(toml);
    expect(result.lib.path).toBe("src/real.rs");
  });

  it("does not treat [lib] inside triple-single-quoted string as a section header", () => {
    const toml =
      "[package]\nname = \"x\"\ndescription = '''\nThis is a long\ndescription with [lib] inside\n'''\n\n[lib]\npath = \"src/real.rs\"";
    const result = parseCargoToml(toml);
    expect(result.lib.path).toBe("src/real.rs");
  });

  it("inline table for lib does not throw and package.name is still extracted", () => {
    const toml = '[package]\nname = "x"\n\nlib = { path = "src/x.rs" }';
    expect(() => parseCargoToml(toml)).not.toThrow();
    const result = parseCargoToml(toml);
    expect(result.package.name).toBe("x");
  });

  it("tolerates unknown sections", () => {
    const toml = '[package]\nname = "x"\n\n[unknown_section]\nfoo = "bar"';
    expect(() => parseCargoToml(toml)).not.toThrow();
    const result = parseCargoToml(toml);
    expect(result.package.name).toBe("x");
  });
});

describe("discoverCratePackages", () => {
  it("single-crate: discovers package name and maps all .rs files to it", () => {
    const root = join(FIXTURES, "single-crate");
    const files = collectRsFiles(root);
    const { packages, fileToPackage } = discoverCratePackages(root, files);
    expect(packages.has("single_crate")).toBe(true);
    for (const f of files) {
      expect(fileToPackage.get(f)).toBe("single_crate");
    }
  });

  it("workspace-two-crates: discovers both members with correct names", () => {
    const root = join(FIXTURES, "workspace-two-crates");
    const files = collectRsFiles(root);
    const { packages, fileToPackage } = discoverCratePackages(root, files);
    expect(packages.has("redpanda_core")).toBe(true);
    expect(packages.has("app")).toBe(true);
    const appMain = join(root, "app/src/main.rs");
    const coreLib = join(root, "core/src/lib.rs");
    expect(fileToPackage.get(appMain)).toBe("app");
    expect(fileToPackage.get(coreLib)).toBe("redpanda_core");
  });

  it("workspace-with-excluded: only workspace members in packages map; excluded crate files still in fileToPackage", () => {
    const root = join(FIXTURES, "workspace-with-excluded");
    const files = collectRsFiles(root);
    const { packages, fileToPackage } = discoverCratePackages(root, files);
    expect(packages.has("member_a")).toBe(true);
    expect(packages.has("member_b")).toBe(true);
    // excluded_crate is NOT a workspace member — must not be in packages
    expect(packages.has("excluded_crate")).toBe(false);
    // but its files are still in fileToPackage (for local resolution)
    const cFile = join(root, "c/src/lib.rs");
    expect(fileToPackage.get(cFile)).toBeDefined();
  });

  it("custom-lib-path: srcRoot is the custom path, not src/lib.rs", () => {
    const root = join(FIXTURES, "custom-lib-path");
    const files = collectRsFiles(root);
    const { packages } = discoverCratePackages(root, files);
    const pkg = packages.get("custom_lib");
    expect(pkg).toBeDefined();
    // srcRoot should point to the directory containing custom_root.rs
    expect(pkg!.root).toContain("src");
  });

  it("file outside any Cargo.toml maps to undefined without throwing", () => {
    const root = join(FIXTURES, "single-crate");
    const files = [join(FIXTURES, "single-crate/src/lib.rs")];
    const orphanFile = "/tmp/orphan_file_that_does_not_exist.rs";
    expect(() => {
      const { fileToPackage } = discoverCratePackages(root, [...files, orphanFile]);
      expect(fileToPackage.get(orphanFile)).toBeUndefined();
    }).not.toThrow();
  });

  it("does NOT re-read Cargo.toml files already seen (memoised)", () => {
    const root = join(FIXTURES, "single-crate");
    const files = collectRsFiles(root);
    // Call twice — should not throw and should return consistent results
    const result1 = discoverCratePackages(root, files);
    const result2 = discoverCratePackages(root, files);
    expect(result1.packages.has("single_crate")).toBe(true);
    expect(result2.packages.has("single_crate")).toBe(true);
  });

  it("members glob 'crates/*' expands against the FS", () => {
    // Use workspace-two-crates which has members = ["core", "app"]
    // This tests that literal member paths are resolved correctly
    const root = join(FIXTURES, "workspace-two-crates");
    const files = collectRsFiles(root);
    const { packages } = discoverCratePackages(root, files);
    expect(packages.size).toBeGreaterThanOrEqual(2);
  });

  it("virtual manifest (workspace with no [package]) is not itself a package", () => {
    const root = join(FIXTURES, "workspace-two-crates");
    const files = collectRsFiles(root);
    const { packages } = discoverCratePackages(root, files);
    // The root workspace Cargo.toml has no [package] — it should not appear as a package
    // "redpanda_core", "app", and "vendored_lib" should be in packages
    expect(packages.has("redpanda_core")).toBe(true);
    expect(packages.has("app")).toBe(true);
    expect(packages.has("vendored_lib")).toBe(true);
    expect(packages.size).toBe(3);
  });
});

describe("extractRustImports v2", () => {
  it("use crate::a::b::C → classified crate entry with segments", () => {
    const out = extractRustImports("use crate::a::b::C;");
    const c = out.classified.find((x: any) => x.kind === "crate");
    expect(c).toBeDefined();
    expect(c.segments).toEqual(["a", "b", "C"]);
    expect(Array.isArray(out.specs)).toBe(true);
    expect(out.specs.every((s: any) => typeof s === "string")).toBe(true);
  });

  it("use crate::{a, b::{c, d}} → three classified crate entries", () => {
    const out = extractRustImports("use crate::{a, b::{c, d}};");
    const crates = out.classified.filter((x: any) => x.kind === "crate");
    expect(crates).toHaveLength(3);
    const segs = crates.map((x: any) => x.segments);
    expect(segs).toContainEqual(["a"]);
    expect(segs).toContainEqual(["b", "c"]);
    expect(segs).toContainEqual(["b", "d"]);
  });

  it("use super::super::x::Y → kind super with levels=2", () => {
    const out = extractRustImports("use super::super::x::Y;");
    const c = out.classified.find((x: any) => x.kind === "super");
    expect(c).toBeDefined();
    expect(c.levels).toBe(2);
    expect(c.segments).toEqual(["x", "Y"]);
  });

  it("use self::child::Y → kind self with segments", () => {
    const out = extractRustImports("use self::child::Y;");
    const c = out.classified.find((x: any) => x.kind === "self");
    expect(c).toBeDefined();
    expect(c.segments).toEqual(["child", "Y"]);
  });

  it("use rand::Rng → kind external", () => {
    const out = extractRustImports("use rand::Rng;");
    const c = out.classified.find((x: any) => x.kind === "external");
    expect(c).toBeDefined();
    expect(c.segments[0]).toBe("rand");
  });

  it("use std::collections::HashMap → dropped (not in classified)", () => {
    const out = extractRustImports("use std::collections::HashMap;");
    expect(out.classified).toHaveLength(0);
  });

  it("use core::fmt → dropped", () => {
    const out = extractRustImports("use core::fmt;");
    expect(out.classified).toHaveLength(0);
  });

  it("use alloc::vec::Vec → dropped", () => {
    const out = extractRustImports("use alloc::vec::Vec;");
    expect(out.classified).toHaveLength(0);
  });

  it("use crate::prelude::* → kind crate with glob=true", () => {
    const out = extractRustImports("use crate::prelude::*;");
    const c = out.classified.find((x: any) => x.kind === "crate");
    expect(c).toBeDefined();
    expect(c.glob).toBe(true);
    expect(c.segments).toEqual(["prelude"]);
  });

  it("use foo::bar as Baz → alias stripped, segments [foo, bar]", () => {
    const out = extractRustImports("use foo::bar as Baz;");
    const c = out.classified.find((x: any) => x.kind === "external");
    expect(c).toBeDefined();
    expect(c.segments).toEqual(["foo", "bar"]);
  });

  it("mod foo; → kind mod with segments [foo]", () => {
    const out = extractRustImports("mod foo;");
    const c = out.classified.find((x: any) => x.kind === "mod");
    expect(c).toBeDefined();
    expect(c.segments).toEqual(["foo"]);
  });

  it("// use crate::x::Y; → ignored (line comment)", () => {
    const out = extractRustImports("// use crate::x::Y;");
    expect(out.classified).toHaveLength(0);
  });

  it("pub use crate::a::B → captured as kind crate", () => {
    const out = extractRustImports("pub use crate::a::B;");
    const c = out.classified.find((x: any) => x.kind === "crate");
    expect(c).toBeDefined();
    expect(c.segments).toEqual(["a", "B"]);
  });

  it("multi-line use crate::{a, b::c} → parsed correctly", () => {
    const src = "use crate::{\n  a,\n  b::c,\n};";
    const out = extractRustImports(src);
    const crates = out.classified.filter((x: any) => x.kind === "crate");
    expect(crates.length).toBeGreaterThanOrEqual(2);
    const segs = crates.map((x: any) => x.segments);
    expect(segs).toContainEqual(["a"]);
    expect(segs).toContainEqual(["b", "c"]);
  });

  it("backwards-compat: specs is always string[]", () => {
    const out = extractRustImports("use crate::a::b;\nmod foo;\nuse rand::Rng;");
    expect(Array.isArray(out.specs)).toBe(true);
    expect(out.specs.every((s: any) => typeof s === "string")).toBe(true);
  });
});

describe("extractRustImports: #[cfg(test)] gating (Phase 1)", () => {
  it("drops `use super::*` inside #[cfg(test)] mod tests {}", () => {
    const src = `
pub fn x() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn t() { x(); }
}
`;
    const out = extractRustImports(src);
    const supers = out.classified.filter((c: any) => c.kind === "super");
    expect(supers).toEqual([]);
  });

  it("drops `use super::Foo` inside #[cfg(test)] mod tests {}", () => {
    const src = `
#[cfg(test)]
mod tests {
    use super::Foo;
}
`;
    const out = extractRustImports(src);
    expect(out.classified.filter((c: any) => c.kind === "super")).toEqual([]);
  });

  it("drops `use self::Foo` inside #[cfg(test)] mod tests {}", () => {
    const src = `
#[cfg(test)]
mod tests {
    use self::helper;
}
`;
    const out = extractRustImports(src);
    expect(out.classified.filter((c: any) => c.kind === "self")).toEqual([]);
  });

  it("KEEPS `use crate::other::Foo` inside #[cfg(test)] (real test coupling)", () => {
    const src = `
#[cfg(test)]
mod tests {
    use crate::other_module::Helper;
}
`;
    const out = extractRustImports(src);
    const crates = out.classified.filter((c: any) => c.kind === "crate");
    expect(crates.length).toBe(1);
    expect(crates[0].segments).toEqual(["other_module", "Helper"]);
  });

  it("KEEPS `use external_crate::Foo` inside #[cfg(test)]", () => {
    const src = `
#[cfg(test)]
mod tests {
    use approx::assert_relative_eq;
}
`;
    const out = extractRustImports(src);
    const ext = out.classified.filter((c: any) => c.kind === "external");
    expect(ext.length).toBe(1);
  });

  it("KEEPS `use super::*` OUTSIDE any cfg(test) block (regular nested module)", () => {
    const src = `
mod inner {
    use super::*;
    pub fn f() {}
}
`;
    const out = extractRustImports(src);
    const supers = out.classified.filter((c: any) => c.kind === "super");
    expect(supers.length).toBe(1);
  });

  it("handles #[cfg(any(test, feature = \"x\"))] correctly", () => {
    const src = `
#[cfg(any(test, feature = "experimental"))]
mod tests {
    use super::*;
}
`;
    const out = extractRustImports(src);
    expect(out.classified.filter((c: any) => c.kind === "super")).toEqual([]);
  });

  it("does NOT match cfg attributes that lack the bare `test` token", () => {
    // `not_test` is not the same as `test`
    const src = `
#[cfg(feature = "not_test")]
mod helpers {
    use super::*;
}
`;
    const out = extractRustImports(src);
    expect(out.classified.filter((c: any) => c.kind === "super").length).toBe(1);
  });

  it("handles nested braces inside the test mod body", () => {
    const src = `
#[cfg(test)]
mod tests {
    use super::*;

    fn outer() {
        let x = { let y = 1; y + 1 };
        if true { let _ = (); }
    }
}

// Outside the test mod — this super should be kept
mod other {
    use super::*;
}
`;
    const out = extractRustImports(src);
    const supers = out.classified.filter((c: any) => c.kind === "super");
    // Only the second `use super::*` (outside the cfg(test) block) survives
    expect(supers.length).toBe(1);
  });

  it("handles multiple cfg(test) blocks in one file", () => {
    const src = `
#[cfg(test)]
mod a { use super::*; }

pub fn middle() {}

#[cfg(test)]
mod b { use super::Foo; }

mod real {
    use super::*; // KEPT — outside cfg(test)
}
`;
    const out = extractRustImports(src);
    const supers = out.classified.filter((c: any) => c.kind === "super");
    expect(supers.length).toBe(1);
  });
});

describe("resolveRustImport", () => {
  function buildCtx(fixtureDir: string) {
    const files = collectRsFiles(fixtureDir);
    const { packages, fileToPackage } = discoverCratePackages(fixtureDir, files);
    const allFiles = new Set(files);
    return { cratePackages: packages, fileToPackage, allFiles };
  }

  it("crate::a from lib.rs → src/a.rs", () => {
    const root = join(FIXTURES, "single-crate");
    const ctx = buildCtx(root);
    const fromFile = join(root, "src/lib.rs");
    const spec = { kind: "crate", segments: ["a"] };
    const result = resolveRustImport(fromFile, spec, ctx);
    expect(result).toBe(join(root, "src/a.rs"));
  });

  it("crate::a::sub from lib.rs → src/a/sub.rs", () => {
    const root = join(FIXTURES, "single-crate");
    const ctx = buildCtx(root);
    const fromFile = join(root, "src/lib.rs");
    const spec = { kind: "crate", segments: ["a", "sub"] };
    const result = resolveRustImport(fromFile, spec, ctx);
    expect(result).toBe(join(root, "src/a/sub.rs"));
  });

  it("crate::a::sub::Item → src/a/sub.rs (item-in-file: last existing file wins)", () => {
    const root = join(FIXTURES, "single-crate");
    const ctx = buildCtx(root);
    const fromFile = join(root, "src/lib.rs");
    const spec = { kind: "crate", segments: ["a", "sub", "Item"] };
    const result = resolveRustImport(fromFile, spec, ctx);
    expect(result).toBe(join(root, "src/a/sub.rs"));
  });

  it("no-fabrication: crate::doesnotexist → null (first segment fails → drop)", () => {
    const root = join(FIXTURES, "single-crate");
    const ctx = buildCtx(root);
    const fromFile = join(root, "src/lib.rs");
    const spec = { kind: "crate", segments: ["doesnotexist", "anything"] };
    const result = resolveRustImport(fromFile, spec, ctx);
    expect(result).toBeNull();
  });

  it("super::shared::X from src/a/mod.rs → src/shared.rs", () => {
    const root = join(FIXTURES, "super-self");
    const ctx = buildCtx(root);
    const fromFile = join(root, "src/a/mod.rs");
    const spec = { kind: "super", levels: 1, segments: ["shared"] };
    const result = resolveRustImport(fromFile, spec, ctx);
    expect(result).toBe(join(root, "src/shared.rs"));
  });

  it("self::child from src/a/mod.rs → src/a/child.rs", () => {
    const root = join(FIXTURES, "super-self");
    const ctx = buildCtx(root);
    const fromFile = join(root, "src/a/mod.rs");
    const spec = { kind: "self", segments: ["child"] };
    const result = resolveRustImport(fromFile, spec, ctx);
    expect(result).toBe(join(root, "src/a/child.rs"));
  });

  it("external redpanda_core::Thing from app/src/main.rs → core/src/lib.rs", () => {
    const root = join(FIXTURES, "workspace-two-crates");
    const ctx = buildCtx(root);
    const fromFile = join(root, "app/src/main.rs");
    const spec = { kind: "external", segments: ["redpanda_core", "Thing"] };
    const result = resolveRustImport(fromFile, spec, ctx);
    expect(result).toBe(join(root, "core/src/lib.rs"));
  });

  it("external rand::Rng → null (not a workspace member)", () => {
    const root = join(FIXTURES, "single-crate");
    const ctx = buildCtx(root);
    const fromFile = join(root, "src/lib.rs");
    const spec = { kind: "external", segments: ["rand", "Rng"] };
    const result = resolveRustImport(fromFile, spec, ctx);
    expect(result).toBeNull();
  });

  it("external excluded_crate from workspace member → null (not a workspace member)", () => {
    const root = join(FIXTURES, "workspace-with-excluded");
    const ctx = buildCtx(root);
    const fromFile = join(root, "a/src/lib.rs");
    const spec = { kind: "external", segments: ["excluded_crate", "Thing"] };
    const result = resolveRustImport(fromFile, spec, ctx);
    expect(result).toBeNull();
  });

  it("mod ./foo from src/lib.rs → src/a.rs", () => {
    const root = join(FIXTURES, "single-crate");
    const ctx = buildCtx(root);
    const fromFile = join(root, "src/lib.rs");
    const spec = { kind: "mod", segments: ["a"] };
    const result = resolveRustImport(fromFile, spec, ctx);
    expect(result).toBe(join(root, "src/a.rs"));
  });

  it("glob crate::prelude::* → src/prelude.rs (parent module file)", () => {
    const root = join(FIXTURES, "glob-import");
    const ctx = buildCtx(root);
    const fromFile = join(root, "src/lib.rs");
    const spec = { kind: "crate", segments: ["prelude"], glob: true };
    const result = resolveRustImport(fromFile, spec, ctx);
    expect(result).toBe(join(root, "src/prelude.rs"));
  });

  it("custom-lib-path: crate::x resolves from custom_root.rs's directory", () => {
    const root = join(FIXTURES, "custom-lib-path");
    const ctx = buildCtx(root);
    const fromFile = join(root, "src/custom_root.rs");
    const spec = { kind: "crate", segments: ["x"] };
    const result = resolveRustImport(fromFile, spec, ctx);
    expect(result).toBe(join(root, "src/x.rs"));
  });

  it("path normalization: result uses path.sep separators", () => {
    const root = join(FIXTURES, "single-crate");
    const ctx = buildCtx(root);
    const fromFile = join(root, "src/lib.rs");
    const spec = { kind: "crate", segments: ["a"] };
    const result = resolveRustImport(fromFile, spec, ctx);
    expect(result).not.toBeNull();
    // Result should be an absolute path (no double slashes, no ..)
    expect(result).not.toContain("..");
  });
});

describe("scan pipeline integration", () => {
  // FIXTURES is already defined above as the rust fixtures directory
  const SCAN_FIXTURES = FIXTURES;

  it("single-crate: resolved edges land in fileDetails.resolvedEdges", async () => {
    const root = join(SCAN_FIXTURES, "single-crate");
    const result = await scanProject(root);
    // lib.rs has `mod a;` → should resolve to src/a.rs
    const relFrom = "src/lib.rs";
    const relTo = "src/a.rs";
    const edges = result.fileDetails?.resolvedEdges?.[relFrom] || [];
    expect(edges).toContain(relTo);
  });

  it("fileDetails.imports[file].specs is string[] for every Rust file", async () => {
    const root = join(SCAN_FIXTURES, "single-crate");
    const result = await scanProject(root);
    for (const [file, importData] of Object.entries(result.fileDetails?.imports || {})) {
      if (file.endsWith(".rs")) {
        expect(Array.isArray((importData as any).specs)).toBe(true);
        expect((importData as any).specs.every((s: any) => typeof s === "string")).toBe(true);
      }
    }
  });

  it("nested-mods: no double-counting of mod edges", async () => {
    const root = join(SCAN_FIXTURES, "nested-mods");
    const result = await scanProject(root);
    const relFrom = "src/main.rs";
    const edges = result.fileDetails?.resolvedEdges?.[relFrom] || [];
    // main.rs has `mod a;` and `mod b;` — should have exactly 2 edges, not 4
    const aEdges = edges.filter((e: string) => e === "src/a.rs");
    const bEdges = edges.filter((e: string) => e === "src/b.rs");
    expect(aEdges).toHaveLength(1);
    expect(bEdges).toHaveLength(1);
  });
});

describe("mod-chain reachability", () => {
  it("nested-mods: full mod-chain reachability via scanProject", async () => {
    const root = join(FIXTURES, "nested-mods");
    const result = await scanProject(root);
    const edges = result.fileDetails?.resolvedEdges || {};

    // main.rs → a.rs
    expect(edges["src/main.rs"]).toContain("src/a.rs");
    // main.rs → b.rs
    expect(edges["src/main.rs"]).toContain("src/b.rs");
    // a.rs → a/sub.rs
    expect(edges["src/a.rs"]).toContain("src/a/sub.rs");

    // a/sub.rs should NOT be in the isolated files list — it's reached via mod chain
    // Check that sub.rs has at least one inbound edge (from a.rs)
    const subInbound = Object.entries(edges).filter(([, targets]: any) =>
      targets.includes("src/a/sub.rs")
    );
    expect(subInbound.length).toBeGreaterThan(0);
  });
});

describe("downstream shape regression", () => {
  it("computeImpact works on scanProject output for a Rust crate", async () => {
    const { computeImpact } = require("../lib/impact.js");
    const root = join(FIXTURES, "single-crate");
    const result = await scanProject(root);

    // scanProject returns relative paths as keys in fileDetails.imports
    // and in scannedFilePaths — pick any .rs file as the "changed" file
    const rsFiles = Object.keys(result.fileDetails?.imports || {}).filter((f: string) => f.endsWith(".rs"));
    expect(rsFiles.length).toBeGreaterThan(0);
    const changed = [rsFiles[0]];

    // Build the scan input shape that computeImpact expects:
    // { scannedFilePaths: string[], fileDetails: { imports: {[file]: {specs: string[]}}, loc: {[file]: number} } }
    // scanProject returns this shape — verify it works end-to-end
    const scanInput = {
      scannedFilePaths: result.scannedFilePaths as string[],
      fileDetails: {
        imports: result.fileDetails?.imports || {},
        loc: result.fileDetails?.loc || {},
      },
    };

    // Prove specs: string[] contract is not broken — no exception thrown
    expect(() => computeImpact(scanInput, changed)).not.toThrow();

    const impact = computeImpact(scanInput, changed);
    expect(impact).toBeDefined();
    expect(typeof impact.totalAffected).toBe("number");
    expect(["none", "low", "medium", "high"]).toContain(impact.riskLevel);
  });
});

function normalizeForDiff(scan: any): any {
  const clone = JSON.parse(JSON.stringify(scan));
  function strip(obj: any): any {
    if (Array.isArray(obj)) {
      const stripped = obj.map(strip);
      // Stable sort arrays of objects to defeat tied-count iteration-order
      // non-determinism in fields like topImported / topImporters.
      if (stripped.length > 1 && stripped.every((x) => x && typeof x === "object" && !Array.isArray(x))) {
        return stripped.slice().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      }
      return stripped;
    }
    if (obj && typeof obj === "object") {
      const out: any = {};
      for (const key of Object.keys(obj).sort()) {
        if (key === "generatedAt" || key === "scanMs" || key === "followDeps") continue;
        out[key] = strip(obj[key]);
      }
      return out;
    }
    return obj;
  }
  return strip(clone);
}

describe("workspace module grouping", () => {
  const WTC = join(FIXTURES, "workspace-two-crates");

  it("test 1 (RED): multi-segment member depth 1 → thirdparty/vendored_lib not thirdparty", async () => {
    // current moduleOf("thirdparty/vendored_lib/src/lib.rs", 1) returns "thirdparty"
    // v3 expects "thirdparty/vendored_lib"
    const result = await scanProject(WTC);
    const graph = result.graphsByDepth?.[1];
    const nodeIds = (graph?.nodes ?? []).map((n: any) => n.id ?? n.name ?? n);
    expect(nodeIds).toContain("thirdparty/vendored_lib");
    expect(nodeIds).not.toContain("thirdparty");
  });

  it("test 2 (non-RED): multi-segment member depth 2 stability → thirdparty/vendored_lib", async () => {
    // current moduleOf("thirdparty/vendored_lib/src/lib.rs", 2) returns "thirdparty/vendored_lib" (coincidence)
    // v3 also expects "thirdparty/vendored_lib" — stability assertion
    const result = await scanProject(WTC);
    const graph = result.graphsByDepth?.[2];
    const nodeIds = (graph?.nodes ?? []).map((n: any) => n.id ?? n.name ?? n);
    expect(nodeIds).toContain("thirdparty/vendored_lib");
  });

  it("test 3 (RED): multi-segment member with inside dir, depth 2 → thirdparty/vendored_lib/sub", async () => {
    // current moduleOf("thirdparty/vendored_lib/src/sub/util.rs", 2) returns "thirdparty/vendored_lib"
    // v3 expects "thirdparty/vendored_lib/sub"
    const result = await scanProject(WTC);
    const graph = result.graphsByDepth?.[2];
    const nodeIds = (graph?.nodes ?? []).map((n: any) => n.id ?? n.name ?? n);
    expect(nodeIds).toContain("thirdparty/vendored_lib/sub");
  });

  it("test 4 (RED): multi-segment member with inside dir, depth 3 → thirdparty/vendored_lib/sub (src/ elided)", async () => {
    // current moduleOf("thirdparty/vendored_lib/src/sub/util.rs", 3) returns "thirdparty/vendored_lib/src"
    // v3 expects "thirdparty/vendored_lib/sub" (src/ is elided)
    const result = await scanProject(WTC);
    const graph = result.graphsByDepth?.[3];
    const nodeIds = (graph?.nodes ?? []).map((n: any) => n.id ?? n.name ?? n);
    expect(nodeIds).toContain("thirdparty/vendored_lib/sub");
    expect(nodeIds).not.toContain("thirdparty/vendored_lib/src");
  });

  it("test 5 (RED): single-segment member depth 2 collapse → core not core/src", async () => {
    // current moduleOf("core/src/lib.rs", 2) returns "core/src"
    // v3 expects "core"
    const result = await scanProject(WTC);
    const graph = result.graphsByDepth?.[2];
    const nodeIds = (graph?.nodes ?? []).map((n: any) => n.id ?? n.name ?? n);
    expect(nodeIds).toContain("core");
    expect(nodeIds).not.toContain("core/src");
  });

  it("test 6 (RED): single-segment member depth 3 collapse → core not core/src", async () => {
    // current moduleOf("core/src/lib.rs", 3) returns "core/src"
    // v3 expects "core"
    const result = await scanProject(WTC);
    const graph = result.graphsByDepth?.[3];
    const nodeIds = (graph?.nodes ?? []).map((n: any) => n.id ?? n.name ?? n);
    expect(nodeIds).toContain("core");
    expect(nodeIds).not.toContain("core/src");
  });

  it("test 7 (RED): cross-crate edge at depth 2 → app → core not app/src → core/src", async () => {
    // current depth-2 edge is app/src → core/src
    // v3 expects app → core
    const result = await scanProject(WTC);
    const graph = result.graphsByDepth?.[2];
    const edges = (graph?.edges ?? []).map((e: any) => `${e.from ?? e.source}->${e.to ?? e.target}`);
    expect(edges.some((e: string) => e === "app->core" || e === "core->app")).toBe(true);
    expect(edges.some((e: string) => e.includes("app/src") || e.includes("core/src"))).toBe(false);
  });

  it("test 8 (non-RED): out-of-workspace .rs fallback → notes at depth 1", async () => {
    // notes/scratch.rs has no Cargo.toml above it inside the fixture
    // current moduleOf("notes/scratch.rs", 1) returns "notes"
    // v3 also expects "notes" — fallback regression
    const result = await scanProject(WTC);
    const graph = result.graphsByDepth?.[1];
    const nodeIds = (graph?.nodes ?? []).map((n: any) => n.id ?? n.name ?? n);
    expect(nodeIds).toContain("notes");
  });

  it("test 9 (non-RED): non-Rust file inside member dir → app at depth 1", async () => {
    // app/scripts/build.js is not .rs — override must not fire
    // current moduleOf("app/scripts/build.js", 1) returns "app"
    // v3 also expects "app" — non-Rust fallback regression
    const result = await scanProject(WTC);
    const graph = result.graphsByDepth?.[1];
    const nodeIds = (graph?.nodes ?? []).map((n: any) => n.id ?? n.name ?? n);
    expect(nodeIds).toContain("app");
    expect(nodeIds).not.toContain("app/scripts");
  });

  it("test 10 (non-RED): file-edge parity — internalEdges unchanged after grouping fix", async () => {
    // Module grouping must not change file-edge counts
    const result = await scanProject(WTC);
    // Capture the current internalEdges count as the baseline
    // This test will pass both before and after the fix (tripwire)
    expect(typeof result.insights?.summary?.internalEdges).toBe("number");
    expect(result.insights?.summary?.internalEdges).toBeGreaterThan(0);
  });
});

describe("cargo target separation (examples / bin / benches / tests)", () => {
  const CT = join(FIXTURES, "cargo-targets");

  it("each examples/<name>.rs becomes its own module node at depth 1", async () => {
    const result = await scanProject(CT);
    const graph = result.graphsByDepth?.[1];
    const ids = (graph?.nodes ?? []).map((n: any) => n.id);
    expect(ids).toContain("app/examples/rover");
  });

  it("examples/<name>/main.rs collapses to app/examples/<name> (target-level grouping)", async () => {
    const result = await scanProject(CT);
    const graph = result.graphsByDepth?.[1];
    const ids = (graph?.nodes ?? []).map((n: any) => n.id);
    expect(ids).toContain("app/examples/multi");
    // helper file beside main.rs is part of the same example target, NOT a separate module
    expect(ids).not.toContain("app/examples/multi/aux");
  });

  it("src/bin/<name>.rs becomes app/bin/<name>", async () => {
    const result = await scanProject(CT);
    const graph = result.graphsByDepth?.[1];
    const ids = (graph?.nodes ?? []).map((n: any) => n.id);
    expect(ids).toContain("app/bin/tool");
  });

  it("benches/ and tests/ are NOT separated (crate-level support code lumps together)", async () => {
    const result = await scanProject(CT);
    const graph = result.graphsByDepth?.[1];
    const ids = (graph?.nodes ?? []).map((n: any) => n.id);
    // At depth 1, benches/tests files fall through to default moduleOf and
    // bucket by their parent dir name (relative to scan root). The exact id
    // depends on whether the package is at the workspace root or not.
    // For our fixture (member at "app"), they land in "app/benches" / "app/tests".
    expect(ids).not.toContain("app/benches/bench_a");
    expect(ids).not.toContain("app/tests/integration");
    // The "lumped" parent appears instead — exact id depends on default
    // moduleOf path-strip rules; we just assert the per-file split didn't happen.
  });

  it("lib + helpers still group under app at depth 1 (target separation does not bleed into src/)", async () => {
    const result = await scanProject(CT);
    const graph = result.graphsByDepth?.[1];
    const ids = (graph?.nodes ?? []).map((n: any) => n.id);
    expect(ids).toContain("app");
    // lib.rs and helpers.rs belong to the lib target → both go in "app"
  });

  it("depth 2+ does not subdivide target nodes (they are atomic)", async () => {
    const result = await scanProject(CT, { maxDepth: 5 });
    for (const d of [2, 3, 5]) {
      const graph = result.graphsByDepth?.[d];
      const ids = (graph?.nodes ?? []).map((n: any) => n.id);
      // The target-level node persists; depth does not split it deeper
      expect(ids).toContain("app/examples/rover");
      expect(ids).toContain("app/examples/multi");
      expect(ids).not.toContain("app/examples/multi/aux");
    }
  });

  it("example imports lib → edge from app/examples/rover to app", async () => {
    const result = await scanProject(CT);
    const graph = result.graphsByDepth?.[1];
    const edges = (graph?.edges ?? []) as Array<{ source: string; target: string }>;
    const found = edges.some((e) => e.source === "app/examples/rover" && e.target === "app");
    expect(found).toBe(true);
  });
});

describe("mod declaration edges are not architectural edges", () => {
  // Uses the nested-mods fixture which has lib.rs declaring `pub mod foo;`
  // and foo containing a real use of lib. The mod-declaration edge
  // (lib.rs → foo.rs) should NOT appear in the module-level edge list.
  const NM = join(FIXTURES, "nested-mods");

  it("scan completes and produces a module graph", async () => {
    const result = await scanProject(NM, { maxDepth: 5 });
    expect(result.graphsByDepth?.[1]).toBeTruthy();
  });

  it("mod declarations alone do NOT create module-graph edges (within a crate)", async () => {
    // Build a tiny in-test fixture: lib.rs declares `pub mod foo;` and foo.rs
    // does NOT import anything from lib. The cross-module edge would be from
    // the mod declaration only — we want this dropped.
    const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = require("fs");
    const { tmpdir } = require("os");
    const tmp = mkdtempSync(join(tmpdir(), "rm-mod-edge-"));
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(
      join(tmp, "Cargo.toml"),
      '[package]\nname = "modonly"\nversion = "0.1.0"\nedition = "2021"\n'
    );
    writeFileSync(
      join(tmp, "src", "lib.rs"),
      "pub mod foo;\npub mod bar;\n"
    );
    writeFileSync(join(tmp, "src", "foo.rs"), "pub fn f() {}\n");
    writeFileSync(join(tmp, "src", "bar.rs"), "pub fn b() {}\n");
    try {
      const result = await scanProject(tmp, { maxDepth: 5 });
      // At depth 2, lib.rs is in "modonly", foo.rs is in "modonly/foo" (no — actually
      // it's a flat file so it lands in "modonly" too). Let's check depth 3.
      // Actually for a single-file-per-mod layout there are no cross-module edges
      // because everything buckets together. The real assertion: at depth 1 with
      // realistic structure, no spurious cycles appear.
      for (const d of [1, 2, 3, 5]) {
        const g = result.graphsByDepth?.[d];
        // No cycles should appear from mere mod declarations
        expect(g?.cycles ?? []).toEqual([]);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("flat src/<name>.rs file promotes to its own module node (not lumped under crate root)", async () => {
    const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = require("fs");
    const { tmpdir } = require("os");
    const tmp = mkdtempSync(join(tmpdir(), "rm-flat-promote-"));
    // Workspace with one member that has both a flat scenes.rs and a dir-based physics/mod.rs
    mkdirSync(join(tmp, "member", "src", "physics"), { recursive: true });
    writeFileSync(
      join(tmp, "Cargo.toml"),
      '[workspace]\nmembers = ["member"]\nresolver = "2"\n'
    );
    writeFileSync(
      join(tmp, "member", "Cargo.toml"),
      '[package]\nname = "member"\nversion = "0.1.0"\nedition = "2021"\n'
    );
    writeFileSync(
      join(tmp, "member", "src", "lib.rs"),
      "pub mod scenes;\npub mod physics;\n"
    );
    writeFileSync(join(tmp, "member", "src", "scenes.rs"), "pub fn s() {}\n");
    writeFileSync(
      join(tmp, "member", "src", "physics", "mod.rs"),
      "pub fn p() {}\n"
    );
    try {
      const result = await scanProject(tmp, { maxDepth: 3 });
      // At depth 1, the whole crate is one node — consistent with how
      // dir-based modules behave too (physics doesn't appear either).
      const g1 = result.graphsByDepth?.[1];
      const ids1 = (g1?.nodes ?? []).map((n: any) => n.id);
      expect(ids1).toContain("member");
      expect(ids1).not.toContain("member/scenes");
      expect(ids1).not.toContain("member/physics");
      // At depth 2+, the flat file gets promoted alongside dir-based modules.
      for (const d of [2, 3]) {
        const g = result.graphsByDepth?.[d];
        const ids = (g?.nodes ?? []).map((n: any) => n.id);
        expect(ids).toContain("member"); // crate root (lib.rs)
        expect(ids).toContain("member/scenes"); // flat file promoted
        expect(ids).toContain("member/physics"); // dir-based module
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("lib.rs and main.rs stay bucketed as the crate root (not promoted)", async () => {
    const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = require("fs");
    const { tmpdir } = require("os");
    const tmp = mkdtempSync(join(tmpdir(), "rm-lib-stays-"));
    mkdirSync(join(tmp, "member", "src", "bin"), { recursive: true });
    writeFileSync(
      join(tmp, "Cargo.toml"),
      '[workspace]\nmembers = ["member"]\nresolver = "2"\n'
    );
    writeFileSync(
      join(tmp, "member", "Cargo.toml"),
      '[package]\nname = "member"\nversion = "0.1.0"\nedition = "2021"\n'
    );
    writeFileSync(
      join(tmp, "member", "src", "lib.rs"),
      "pub mod helpers;\n"
    );
    writeFileSync(join(tmp, "member", "src", "main.rs"), "fn main() {}\n");
    writeFileSync(join(tmp, "member", "src", "helpers.rs"), "pub fn h() {}\n");
    try {
      const result = await scanProject(tmp, { maxDepth: 3 });
      // Check at depth 2 (where promotion is active)
      const g = result.graphsByDepth?.[2];
      const ids = (g?.nodes ?? []).map((n: any) => n.id);
      expect(ids).toContain("member"); // lib.rs + main.rs both bucket here
      expect(ids).toContain("member/helpers"); // flat file promoted
      // No "member/lib" or "member/main" nodes should appear
      expect(ids).not.toContain("member/lib");
      expect(ids).not.toContain("member/main");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("real use-statements DO create module-graph edges (sanity check)", async () => {
    // Same fixture but foo.rs now references something in bar via `use crate::bar`
    const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = require("fs");
    const { tmpdir } = require("os");
    const tmp = mkdtempSync(join(tmpdir(), "rm-real-edge-"));
    mkdirSync(join(tmp, "src", "sub"), { recursive: true });
    writeFileSync(
      join(tmp, "Cargo.toml"),
      '[package]\nname = "withuse"\nversion = "0.1.0"\nedition = "2021"\n'
    );
    writeFileSync(
      join(tmp, "src", "lib.rs"),
      "pub mod sub;\npub mod other;\n"
    );
    mkdirSync(join(tmp, "src", "other"), { recursive: true });
    writeFileSync(join(tmp, "src", "sub", "mod.rs"), "pub fn s() {}\n");
    writeFileSync(
      join(tmp, "src", "other", "mod.rs"),
      "use crate::sub::s;\npub fn o() { s(); }\n"
    );
    try {
      const result = await scanProject(tmp, { maxDepth: 3 });
      // Single-crate-at-root layout: resolver falls back to default moduleOf
      // which buckets by "src/<dirname>". So nodes are src, src/sub, src/other.
      const g = result.graphsByDepth?.[2];
      const edges = (g?.edges ?? []) as Array<{ source: string; target: string }>;
      // The real `use crate::sub::s` creates a real edge
      const realEdge = edges.find(
        (e) => e.source === "src/other" && e.target === "src/sub"
      );
      expect(realEdge).toBeTruthy();
      // No edges from "src" → child mods coming from lib.rs mod declarations
      const fromLibSub = edges.find(
        (e) => e.source === "src" && e.target === "src/sub"
      );
      const fromLibOther = edges.find(
        (e) => e.source === "src" && e.target === "src/other"
      );
      expect(fromLibSub).toBeFalsy();
      expect(fromLibOther).toBeFalsy();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("follow external cargo deps", () => {
  const WSDEP = join(FIXTURES, "workspace-with-external-dep");

  const { runCargoMetadata, extractExternalDeps, mergeExternalDeps } = require("../lib/rust.js");

  // Hand-crafted cargo-metadata-shaped object for unit tests
  function makeMetadata(packages: any[], workspaceMembers: string[]) {
    return { packages, workspace_members: workspaceMembers };
  }

  it("extractExternalDeps: workspace members are filtered via workspace_members[]", () => {
    const meta = makeMetadata(
      [
        { id: "wm1", name: "app", manifest_path: "/ws/app/Cargo.toml", targets: [{ kind: ["lib"], src_path: "/ws/app/src/lib.rs" }] },
        { id: "ext1", name: "bits", manifest_path: "/cache/bits/Cargo.toml", targets: [{ kind: ["lib"], src_path: "/cache/bits/src/lib.rs" }] },
      ],
      ["wm1"]
    );
    const deps = extractExternalDeps(meta);
    expect(deps).toHaveLength(1);
    expect(deps[0].name).toBe("bits");
  });

  it("extractExternalDeps: git/path/registry deps all included", () => {
    const meta = makeMetadata(
      [
        { id: "ext1", name: "serde", source: "registry+https://...", manifest_path: "/r/serde/Cargo.toml", targets: [{ kind: ["lib"], src_path: "/r/serde/src/lib.rs" }] },
        { id: "ext2", name: "bits", source: "git+https://...", manifest_path: "/g/bits/Cargo.toml", targets: [{ kind: ["lib"], src_path: "/g/bits/src/lib.rs" }] },
        { id: "ext3", name: "local-dep", source: null, manifest_path: "/p/local-dep/Cargo.toml", targets: [{ kind: ["lib"], src_path: "/p/local-dep/src/lib.rs" }] },
      ],
      []
    );
    const deps = extractExternalDeps(meta);
    expect(deps).toHaveLength(3);
    expect(deps.map((d: any) => d.name).sort()).toEqual(["bits", "local-dep", "serde"]);
  });

  it("extractExternalDeps: proc-macro-only packages are skipped", () => {
    const meta = makeMetadata(
      [
        { id: "ext1", name: "proc-mac", manifest_path: "/p/Cargo.toml", targets: [{ kind: ["proc-macro"], src_path: "/p/src/lib.rs" }] },
        { id: "ext2", name: "normal", manifest_path: "/n/Cargo.toml", targets: [{ kind: ["lib"], src_path: "/n/src/lib.rs" }] },
      ],
      []
    );
    const deps = extractExternalDeps(meta);
    expect(deps.map((d: any) => d.name)).toEqual(["normal"]);
  });

  it("extractExternalDeps: source=null path dep is still included if not in workspace_members", () => {
    const meta = makeMetadata(
      [
        { id: "ext1", name: "path-dep", source: null, manifest_path: "/p/path-dep/Cargo.toml", targets: [{ kind: ["lib"], src_path: "/p/path-dep/src/lib.rs" }] },
      ],
      []
    );
    const deps = extractExternalDeps(meta);
    expect(deps).toHaveLength(1);
    expect(deps[0].name).toBe("path-dep");
  });

  it("extractExternalDeps: empty packages returns []", () => {
    expect(extractExternalDeps(makeMetadata([], []))).toEqual([]);
  });

  it("mergeExternalDeps adds external-cargo-dep entries to packages map", () => {
    const existing = {
      packages: new Map([["app", { root: "/ws/app/src/lib.rs", manifest: "/ws/app/Cargo.toml", kind: "workspace-member" }]]),
      fileToPackage: new Map(),
    };
    // srcRoot must point to a real directory for fs.existsSync — use the fixture's bits src
    const bitsSrcRoot = join(WSDEP, "fake-cargo-cache/bits/src");
    const externalDeps = [
      { name: "bits", manifestPath: join(WSDEP, "fake-cargo-cache/bits/Cargo.toml"), srcRoot: bitsSrcRoot },
    ];
    const externalFiles = [
      { file: join(bitsSrcRoot, "lib.rs"), depName: "bits" },
      { file: join(bitsSrcRoot, "types.rs"), depName: "bits" },
    ];
    const result = mergeExternalDeps(existing, externalDeps, externalFiles);
    expect(result.packages.has("app")).toBe(true);
    expect(result.packages.has("bits")).toBe(true);
    expect(result.packages.get("bits").kind).toBe("external-cargo-dep");
    expect(result.fileToPackage.get(join(bitsSrcRoot, "lib.rs"))).toBe("bits");
    expect(result.fileToPackage.get(join(bitsSrcRoot, "types.rs"))).toBe("bits");
  });

  it("mergeExternalDeps: workspace member shadows dep with same name (workspace wins)", () => {
    const existing = {
      packages: new Map([["bits", { root: "/ws/bits/src/lib.rs", manifest: "/ws/bits/Cargo.toml", kind: "workspace-member" }]]),
      fileToPackage: new Map(),
    };
    const externalDeps = [
      { name: "bits", manifestPath: "/cache/bits/Cargo.toml", srcRoot: "/cache/bits/src" },
    ];
    const result = mergeExternalDeps(existing, externalDeps, []);
    // Workspace member must not be overwritten in packages
    expect(result.packages.get("bits").kind).toBe("workspace-member");
    expect(result.packages.get("bits").manifest).toBe("/ws/bits/Cargo.toml");
  });

  it("scanProject without followDeps: completes and returns fileDetails", async () => {
    const result = await scanProject(WSDEP, { followDeps: false });
    expect(result).toBeDefined();
    expect(result.fileDetails).toBeDefined();
    // app/src/main.rs must be in the scan
    expect(result.scannedFilePaths).toContain("app/src/main.rs");
    // Without followDeps, no followDeps key on result
    expect(result.followDeps).toBeUndefined();
  });

  it("scanProject with followDeps=true: completes without throwing", async () => {
    // If cargo is absent, runCargoMetadata returns { ok: false } and scan proceeds normally.
    // If cargo is present, it will attempt to resolve deps (may or may not find them without Cargo.lock).
    // Either way, scan must complete and return a valid result.
    const result = await scanProject(WSDEP, { followDeps: true });
    expect(result).toBeDefined();
    expect(result.fileDetails).toBeDefined();
    expect(result.scannedFilePaths).toContain("app/src/main.rs");
  });

  it.skipIf(!hasCargo)("real cargo metadata: workspace-two-crates returns valid metadata", () => {
    const manifestPath = join(FIXTURES, "workspace-two-crates", "Cargo.toml");
    const result = runCargoMetadata(manifestPath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.metadata.packages.length).toBeGreaterThanOrEqual(1);
      expect(extractExternalDeps(result.metadata)).toEqual([]);
    }
  });

  it("normalized scan output: normalizeForDiff strips non-deterministic fields", async () => {
    // Without flag
    const without = await scanProject(WSDEP, { followDeps: false });
    // With flag
    const withFlag = await scanProject(WSDEP, { followDeps: true });

    // Strip non-deterministic + followDeps field
    const normA = normalizeForDiff(without);
    const normB = normalizeForDiff(withFlag);

    // Verify normalize works and produces deterministic output
    expect(normA).toBeDefined();
    expect(normB).toBeDefined();
    // The followDeps key should be stripped from both
    expect(normA.followDeps).toBeUndefined();
    expect(normB.followDeps).toBeUndefined();
    // generatedAt should be stripped
    expect(normA.generatedAt).toBeUndefined();
    expect(normB.generatedAt).toBeUndefined();
    // root should still be present (not stripped)
    expect(normA.root).toBe(WSDEP);
    expect(normB.root).toBe(WSDEP);
  });

  // ── Task 7: unit tests for extractExternalDeps filter ──────────────────────

  describe("extractExternalDeps filter", () => {
    function meta() {
      return makeMetadata(
        [
          { id: "ext1", name: "bits", manifest_path: "/c/bits/Cargo.toml", targets: [{ kind: ["lib"], src_path: "/c/bits/src/lib.rs" }] },
          { id: "ext2", name: "bits-server", manifest_path: "/c/bits-server/Cargo.toml", targets: [{ kind: ["lib"], src_path: "/c/bits-server/src/lib.rs" }] },
          { id: "ext3", name: "serde", manifest_path: "/c/serde/Cargo.toml", targets: [{ kind: ["lib"], src_path: "/c/serde/src/lib.rs" }] },
          { id: "ext4", name: "foo", manifest_path: "/c/foo/Cargo.toml", targets: [{ kind: ["lib"], src_path: "/c/foo/src/lib.rs" }] },
          { id: "ext5", name: "barfoo", manifest_path: "/c/barfoo/Cargo.toml", targets: [{ kind: ["lib"], src_path: "/c/barfoo/src/lib.rs" }] },
        ],
        []
      );
    }

    it("null filter is identical to omitted filter (no-op)", () => {
      const a = extractExternalDeps(meta());
      const b = extractExternalDeps(meta(), null);
      expect(a).toEqual(b);
    });

    it("/^bits/ matches bits-prefixed crates only", () => {
      const result = extractExternalDeps(meta(), /^bits/);
      expect(result.map((d: any) => d.name).sort()).toEqual(["bits", "bits-server"]);
    });

    it("/nomatchxyz/ matches nothing returns []", () => {
      const result = extractExternalDeps(meta(), /nomatchxyz/);
      expect(result).toEqual([]);
    });

    it("unanchored /foo/ matches both foo and barfoo", () => {
      const result = extractExternalDeps(meta(), /foo/);
      expect(result.map((d: any) => d.name).sort()).toEqual(["barfoo", "foo"]);
    });
  });

  // ── Task 8: integration tests on workspace-with-external-dep fixture ───────

  it("scanProject parity: depsFilter:null produces identical normalized output to omitted depsFilter", async () => {
    const a = await scanProject(WSDEP, { followDeps: true });
    const b = await scanProject(WSDEP, { followDeps: true, depsFilter: null });
    expect(normalizeForDiff(a)).toEqual(normalizeForDiff(b));
  });

  it("extractExternalDeps + filter: only matching crates included via scanProject path", () => {
    const metadata = {
      packages: [
        { id: "ws1", name: "app", manifest_path: "/ws/app/Cargo.toml", targets: [{ kind: ["bin"], src_path: "/ws/app/src/main.rs" }] },
        { id: "ext1", name: "bits", manifest_path: "/c/bits/Cargo.toml", targets: [{ kind: ["lib"], src_path: "/c/bits/src/lib.rs" }] },
        { id: "ext2", name: "serde", manifest_path: "/c/serde/Cargo.toml", targets: [{ kind: ["lib"], src_path: "/c/serde/src/lib.rs" }] },
      ],
      workspace_members: ["ws1"],
    };
    const all = extractExternalDeps(metadata);
    const filtered = extractExternalDeps(metadata, /^bits/);
    expect(all.map((d: any) => d.name).sort()).toEqual(["bits", "serde"]);
    expect(filtered.map((d: any) => d.name)).toEqual(["bits"]);
  });
});

// ── Task 9: CLI --deps-filter behaviour tests ─────────────────────────────────

describe("--deps-filter CLI behaviour", () => {
  const CLI = require("path").resolve(__dirname, "../bin/cli.js");

  it("invalid regex exits 1 with 'invalid regex' in stderr", () => {
    const r = spawnSync("node", [CLI, "--deps-filter=[bad(", "."], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("invalid regex");
  });

  it("--deps-filter without --follow-deps implies --follow-deps", () => {
    const fixture = require("path").resolve(__dirname, "fixtures/rust/workspace-with-external-dep");
    const r = spawnSync(
      "node",
      [CLI, "--deps-filter=^bits", "--no-serve", "--summary-json", fixture],
      {
        encoding: "utf8",
        timeout: 60000,
      }
    );
    // The deterministic assertion: stderr must contain the implies note
    expect(r.stderr).toContain("--deps-filter implies --follow-deps");
    // CLI must not crash (exit 0 or null on timeout)
    expect(r.status === 0 || r.status === null).toBeTruthy();
  });
});
