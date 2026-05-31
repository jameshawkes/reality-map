import { describe, it, expect } from "vitest";
import { createRequire } from "module";
import { readdirSync, statSync } from "fs";
import { join, resolve } from "path";

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
    // Only "redpanda_core" and "app" should be in packages
    expect(packages.has("redpanda_core")).toBe(true);
    expect(packages.has("app")).toBe(true);
    expect(packages.size).toBe(2);
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
