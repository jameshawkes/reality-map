"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function parseCargoToml(text) {
  // 1. Normalise CRLF → LF
  text = text.replace(/\r\n/g, '\n');
  const lines = text.split('\n');

  // 2. Pass 1: mark line ranges inside triple-quoted strings as "skip"
  const skipLines = new Set();
  {
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      // Check for triple-quoted string opens on this line
      const tripleDouble = line.indexOf('"""');
      const tripleSingle = line.indexOf("'''");
      let openIdx = -1;
      let closeSeq = null;
      if (tripleDouble !== -1 && (tripleSingle === -1 || tripleDouble < tripleSingle)) {
        openIdx = tripleDouble;
        closeSeq = '"""';
      } else if (tripleSingle !== -1) {
        openIdx = tripleSingle;
        closeSeq = "'''";
      }
      if (openIdx !== -1) {
        // Check if close is on the same line (after the open)
        const afterOpen = line.indexOf(closeSeq, openIdx + 3);
        if (afterOpen !== -1) {
          // Single-line triple-quoted string — no lines to skip
          i++;
          continue;
        }
        // Multi-line: skip from next line until we find the close
        const startLine = i;
        i++;
        while (i < lines.length) {
          const closeIdx = lines[i].indexOf(closeSeq);
          if (closeIdx !== -1) {
            // Mark lines startLine+1 through i (inclusive) as skip
            for (let s = startLine + 1; s <= i; s++) {
              skipLines.add(s);
            }
            i++;
            break;
          }
          i++;
        }
        continue;
      }
      i++;
    }
  }

  // 3. Pass 2: parse sections and key-value pairs
  const result = {
    package: null,
    lib: null,
    bin: [],
    workspace: null,
  };

  let currentSection = null; // e.g. "package", "lib", "workspace"
  let currentBinEntry = null;
  let inArrayKey = null;   // key name if we're inside a multi-line array
  let arrayAccum = [];     // accumulates array items across lines

  function flushArray() {
    if (inArrayKey === null) return;
    const key = inArrayKey;
    const vals = arrayAccum.slice();
    inArrayKey = null;
    arrayAccum = [];
    applyKeyValue(currentSection, currentBinEntry, key, vals);
  }

  function applyKeyValue(section, binEntry, key, value) {
    if (section === 'package') {
      if (!result.package) result.package = {};
      result.package[key] = value;
    } else if (section === 'lib') {
      if (!result.lib) result.lib = {};
      result.lib[key] = value;
    } else if (section === 'workspace') {
      if (!result.workspace) result.workspace = {};
      result.workspace[key] = value;
    } else if (section === 'bin' && binEntry) {
      binEntry[key] = value;
    }
    // unknown sections: tolerate silently
  }

  function parseStringValue(s) {
    // s is the raw value portion after key =
    // Strip inline comment (only outside quotes)
    s = s.trim();
    // Try to extract a quoted string
    const dq = s.match(/^"([^"]*)"/) ;
    if (dq) return dq[1];
    const sq = s.match(/^'([^']*)'/) ;
    if (sq) return sq[1];
    // Unquoted — strip trailing comment
    return s.replace(/#.*$/, '').trim();
  }

  function parseSingleLineArray(s) {
    // s is the content between [ and ]
    const items = [];
    const re = /"([^"]*)"|'([^']*)'/g;
    let m;
    while ((m = re.exec(s)) !== null) {
      items.push(m[1] !== undefined ? m[1] : m[2]);
    }
    return items;
  }

  function stripComment(line) {
    // Strip # comment that is not inside a quoted string
    let inStr = false;
    let strChar = null;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (!inStr && (ch === '"' || ch === "'")) {
        inStr = true;
        strChar = ch;
      } else if (inStr && ch === strChar && line[i - 1] !== '\\') {
        inStr = false;
        strChar = null;
      } else if (!inStr && ch === '#') {
        return line.slice(0, i).trimEnd();
      }
    }
    return line;
  }

  for (let i = 0; i < lines.length; i++) {
    if (skipLines.has(i)) continue;

    let line = stripComment(lines[i]).trimEnd();
    const trimmed = line.trim();

    if (trimmed === '') continue;

    // If we're accumulating a multi-line array
    if (inArrayKey !== null) {
      // Check for closing ]
      if (trimmed === ']' || trimmed.endsWith(']')) {
        // Extract any items on this line before ]
        const closeIdx = trimmed.lastIndexOf(']');
        const before = trimmed.slice(0, closeIdx);
        if (before.trim()) {
          const items = parseSingleLineArray(before);
          arrayAccum.push(...items);
        }
        flushArray();
      } else {
        // Accumulate items from this line
        const items = parseSingleLineArray(trimmed);
        arrayAccum.push(...items);
      }
      continue;
    }

    // Detect [[section]] (array-of-tables)
    const doubleSection = trimmed.match(/^\[\[([^\]]+)\]\]/);
    if (doubleSection) {
      flushArray();
      const secName = doubleSection[1].trim();
      if (secName === 'bin') {
        currentBinEntry = {};
        result.bin.push(currentBinEntry);
        currentSection = 'bin';
      } else {
        currentSection = secName;
        currentBinEntry = null;
      }
      continue;
    }

    // Detect [section]
    const singleSection = trimmed.match(/^\[([^\]]+)\]/);
    if (singleSection) {
      flushArray();
      const secName = singleSection[1].trim();
      currentSection = secName;
      currentBinEntry = null;
      continue;
    }

    // Key = value
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    const rawVal = trimmed.slice(eqIdx + 1).trim();

    // Detect inline table { ... } — skip/discard
    if (rawVal.startsWith('{')) continue;

    // Detect array start
    if (rawVal.startsWith('[')) {
      const closeIdx = rawVal.lastIndexOf(']');
      if (closeIdx !== -1 && closeIdx > 0) {
        // Single-line array
        const inner = rawVal.slice(1, closeIdx);
        const items = parseSingleLineArray(inner);
        applyKeyValue(currentSection, currentBinEntry, key, items);
      } else if (rawVal === '[') {
        // Multi-line array
        inArrayKey = key;
        arrayAccum = [];
      } else {
        // Array open with content but no close yet
        const inner = rawVal.slice(1);
        inArrayKey = key;
        arrayAccum = parseSingleLineArray(inner);
      }
      continue;
    }

    // Regular string value
    const val = parseStringValue(rawVal);
    applyKeyValue(currentSection, currentBinEntry, key, val);
  }

  // Flush any pending array
  flushArray();

  return result;
}

function runCargoMetadata(manifestPath) {
  const spawnResult = spawnSync(
    "cargo",
    ["metadata", "--format-version=1", `--manifest-path=${manifestPath}`],
    { timeout: 60_000, maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }
  );

  if (spawnResult.error && spawnResult.error.code === "ENOENT") {
    process.stderr.write(
      "reality-map: --follow-deps: cargo not found on PATH — skipping external deps\n"
    );
    return { ok: false, reason: "cargo-not-found" };
  }

  if (spawnResult.status === null && spawnResult.signal === "SIGTERM") {
    process.stderr.write(
      "reality-map: --follow-deps: cargo metadata timed out (60s) — skipping external deps\n"
    );
    return { ok: false, reason: "timeout" };
  }

  if (spawnResult.status !== 0) {
    process.stderr.write(
      "reality-map: --follow-deps: cargo metadata failed — skipping external deps\n"
    );
    return { ok: false, reason: "cargo-error", stderr: spawnResult.stderr.toString() };
  }

  return { ok: true, metadata: JSON.parse(spawnResult.stdout.toString()) };
}

// depsFilter contract: pass a RegExp instance or null. Strings will blow up
// at filter.test(). CLI compiles strings; downstream callers must compile.
function extractExternalDeps(metadata, filter = null) {
  if (!metadata || !metadata.packages || metadata.packages.length === 0) {
    return [];
  }

  const workspaceMemberSet = new Set(metadata.workspace_members || []);
  const result = [];

  for (const pkg of metadata.packages) {
    // External = NOT in workspace_members
    if (workspaceMemberSet.has(pkg.id)) continue;

    // Find best target: prefer lib, fall back to bin
    const targets = pkg.targets || [];
    let chosenTarget = targets.find(t => t.kind && t.kind.includes("lib"));
    if (!chosenTarget) {
      chosenTarget = targets.find(t => t.kind && t.kind.includes("bin"));
    }
    // Skip proc-macro-only, cdylib-only, or packages with no lib/bin target
    if (!chosenTarget) continue;

    if (filter && !filter.test(pkg.name)) continue;

    const srcRoot = path.dirname(chosenTarget.src_path);
    result.push({
      name: pkg.name,
      manifestPath: pkg.manifest_path,
      srcRoot,
    });
  }

  return result;
}

function computeCrateRootFile(manifestDir, parsedManifest) {
  if (parsedManifest && parsedManifest.lib && parsedManifest.lib.path) {
    return path.resolve(manifestDir, parsedManifest.lib.path);
  }
  if (parsedManifest && parsedManifest.bin && parsedManifest.bin.length > 0 && parsedManifest.bin[0].path) {
    return path.resolve(manifestDir, parsedManifest.bin[0].path);
  }
  const libRs = path.join(manifestDir, "src", "lib.rs");
  const mainRs = path.join(manifestDir, "src", "main.rs");
  if (fs.existsSync(libRs)) return libRs;
  return mainRs;
}

function mergeExternalDeps(existing, externalDeps, externalFiles) {
  // existing: { packages: Map, fileToPackage: Map } from discoverCratePackages
  // externalDeps: [{ name, manifestPath, srcRoot, kind }] from extractExternalDeps
  // externalFiles: [{ file: absPath, depName: string }] from collectExternalDepFiles
  // Returns: { packages: Map, fileToPackage: Map } — extended

  const packages = new Map(existing.packages);
  const fileToPackage = new Map(existing.fileToPackage);

  for (const dep of externalDeps) {
    // External-cargo-dep tagging is authoritative when cargo metadata reported
    // this package as an external dep of the scan root. Override any
    // discoverCratePackages tagging — that pass walks UP from the file, which
    // for files under ~/.cargo/git/checkouts/.../<crate>/src/foo.rs ends up
    // finding the dep's OWN workspace manifest and (incorrectly, from the
    // scan-root's perspective) marking the crate as workspace-member.
    //
    // Only skip if the existing entry's manifest is under the scan root —
    // i.e. it's a real workspace member of the project we're scanning.
    // We detect this by comparing manifest paths: if the existing entry's
    // manifest is the same as the dep's manifestPath, the discovery and
    // cargo-metadata agree and we just refresh the kind. If they differ,
    // it means there's a real workspace member with the same name as a dep —
    // workspace wins (the existing workspace-member entry).
    const existing = packages.get(dep.name);
    if (existing && existing.kind === "workspace-member" && existing.manifest !== dep.manifestPath) {
      // Real workspace member shadows external dep with same name — skip.
      continue;
    }

    const manifestDir = path.dirname(dep.manifestPath);
    let parsedManifest = null;
    try {
      const text = fs.readFileSync(dep.manifestPath, "utf8");
      parsedManifest = parseCargoToml(text);
    } catch { /* best-effort */ }

    const rootFile = computeCrateRootFile(manifestDir, parsedManifest);

    packages.set(dep.name, {
      root: rootFile,
      manifest: dep.manifestPath,
      kind: "external-cargo-dep",
    });
  }

  for (const { file, depName } of externalFiles) {
    // Only set if the dep is actually in packages (it might have been skipped due to name collision)
    if (packages.has(depName)) {
      fileToPackage.set(file, depName);
    }
  }

  return { packages, fileToPackage };
}

function discoverCratePackages(root, files) {
  // packages: Map<packageName, { root: string, manifest: string, kind: 'workspace-member'|'standalone' }>
  // fileToPackage: Map<absRsFilePath, packageName>

  // Memo cache: directory path → nearest Cargo.toml absolute path (or null)
  const dirToManifest = new Map();

  // Parsed manifests cache: Cargo.toml abs path → parsed result
  const manifestCache = new Map();

  function findManifest(dir) {
    if (dirToManifest.has(dir)) return dirToManifest.get(dir);
    const candidate = path.join(dir, "Cargo.toml");
    let exists = false;
    try { exists = fs.existsSync(candidate); } catch (_) {}
    if (exists) {
      dirToManifest.set(dir, candidate);
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      // Reached FS root
      dirToManifest.set(dir, null);
      return null;
    }
    const result = findManifest(parent);
    dirToManifest.set(dir, result);
    return result;
  }

  function getManifest(manifestPath) {
    if (manifestCache.has(manifestPath)) return manifestCache.get(manifestPath);
    let text;
    try { text = fs.readFileSync(manifestPath, "utf8"); } catch (_) { return null; }
    const parsed = parseCargoToml(text);
    manifestCache.set(manifestPath, parsed);
    return parsed;
  }

  // Step 1: Map each file to its nearest Cargo.toml
  const fileManifests = new Map(); // file → manifestPath
  for (const f of files) {
    let dir;
    try { dir = path.dirname(f); } catch (_) { continue; }
    const manifest = findManifest(dir);
    if (manifest) fileManifests.set(f, manifest);
  }

  // Step 2: Collect all unique manifests seen via file traversal
  const allManifests = new Set(fileManifests.values());

  // Step 2b: For each manifest, also walk up to find any workspace root above it
  // (a workspace root Cargo.toml may not be directly found by file traversal if
  //  member crates have their own Cargo.toml that intercepts the walk)
  for (const manifestPath of Array.from(allManifests)) {
    let dir = path.dirname(path.dirname(manifestPath)); // start above the manifest's dir
    while (true) {
      const candidate = path.join(dir, "Cargo.toml");
      let exists = false;
      try { exists = fs.existsSync(candidate); } catch (_) {}
      if (exists) {
        allManifests.add(candidate);
        break; // stop at first ancestor Cargo.toml
      }
      const parent = path.dirname(dir);
      if (parent === dir) break; // FS root
      dir = parent;
    }
  }

  // Step 3: Find workspace manifests and collect their declared members
  // workspaceMembers: Set of absolute Cargo.toml paths that are workspace members
  // workspaceRoots: Set of manifest paths that are workspace roots (virtual or not)
  const workspaceMembers = new Set();
  const workspaceRoots = new Set();

  for (const manifestPath of allManifests) {
    const parsed = getManifest(manifestPath);
    if (!parsed || !parsed.workspace || !parsed.workspace.members) continue;
    workspaceRoots.add(manifestPath);
    const wsDir = path.dirname(manifestPath);
    for (const member of parsed.workspace.members) {
      if (member.includes("*")) {
        // Expand single-level glob
        const starIdx = member.indexOf("*");
        const prefix = member.slice(0, starIdx).replace(/\/$/, "");
        const baseDir = path.join(wsDir, prefix);
        try {
          for (const entry of fs.readdirSync(baseDir)) {
            const memberManifest = path.join(baseDir, entry, "Cargo.toml");
            try {
              if (fs.existsSync(memberManifest)) workspaceMembers.add(memberManifest);
            } catch (_) {}
          }
        } catch (_) {}
      } else {
        const memberManifest = path.join(wsDir, member, "Cargo.toml");
        try {
          if (fs.existsSync(memberManifest)) workspaceMembers.add(memberManifest);
        } catch (_) {}
      }
    }
  }

  // Determine if any workspace roots were found
  const hasWorkspace = workspaceRoots.size > 0;

  // Step 4: Build packages map
  // A manifest goes into packages if:
  //   - It has [package].name, AND
  //   - Either: no workspace was found (all are standalone), OR it's a declared workspace member
  const packages = new Map();

  for (const manifestPath of allManifests) {
    const parsed = getManifest(manifestPath);
    if (!parsed || !parsed.package || !parsed.package.name) continue;

    const name = parsed.package.name;

    // Determine kind and eligibility
    let kind;
    if (!hasWorkspace) {
      kind = "standalone";
    } else if (workspaceMembers.has(manifestPath)) {
      kind = "workspace-member";
    } else {
      // Has a package name but is not a workspace member — skip from packages map
      // (files still go into fileToPackage below)
      continue;
    }

    // Compute root file (crate entry point)
    const manifestDir = path.dirname(manifestPath);
    let rootFile;
    if (parsed.lib && parsed.lib.path) {
      rootFile = path.resolve(manifestDir, parsed.lib.path);
    } else if (parsed.bin && parsed.bin.length > 0 && parsed.bin[0].path) {
      rootFile = path.resolve(manifestDir, parsed.bin[0].path);
    } else {
      const libRs = path.join(manifestDir, "src", "lib.rs");
      const mainRs = path.join(manifestDir, "src", "main.rs");
      let libExists = false;
      try { libExists = fs.existsSync(libRs); } catch (_) {}
      rootFile = libExists ? libRs : mainRs;
    }

    packages.set(name, { root: rootFile, manifest: manifestPath, kind });
  }

  // Step 5: Build fileToPackage map (all files with a manifest, regardless of workspace membership)
  const fileToPackage = new Map();
  for (const [f, manifestPath] of fileManifests) {
    const parsed = getManifest(manifestPath);
    if (parsed && parsed.package && parsed.package.name) {
      fileToPackage.set(f, parsed.package.name);
    }
  }

  return { packages, fileToPackage };
}

function extractRustImports(src) {
  const warnings = [];

  // Step 1: Strip line comments and block comments
  // Replace // ... to end of line (but not inside strings — simple approach)
  // Replace /* ... */ blocks
  let stripped = src;

  // Remove block comments /* ... */ (non-greedy, dotall)
  stripped = stripped.replace(/\/\*[\s\S]*?\*\//g, (match) => {
    // Preserve newlines so line numbers stay correct
    return match.replace(/[^\n]/g, " ");
  });

  // Remove line comments // ... to end of line
  stripped = stripped.replace(/\/\/[^\n]*/g, (match) => {
    return " ".repeat(match.length);
  });

  // Step 2: Find all `use ...;` statements (multi-line tolerant)
  // Scan for `use ` (possibly preceded by `pub `)
  // Collect chars until `;` at brace depth 0
  const useStatements = []; // { raw, index }

  const useStartRe = /(?:^|\n)([ \t]*(?:pub\s+)?use\s+)/g;
  let useMatch;
  while ((useMatch = useStartRe.exec(stripped)) !== null) {
    // Find the start of the path (after `use `)
    const stmtStart = useMatch.index + (useMatch[0].startsWith("\n") ? 1 : 0);
    // Find where the path starts (skip pub/use keywords)
    const pathStart = useMatch.index + useMatch[0].length;

    // Collect until `;` at brace depth 0
    let depth = 0;
    let i = pathStart;
    while (i < stripped.length) {
      const ch = stripped[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ";" && depth === 0) break;
      i++;
    }

    if (i < stripped.length) {
      const raw = stripped.slice(pathStart, i).trim();
      const lineNum = src.substring(0, stmtStart).split("\n").length;
      const statement = src.substring(stmtStart, i + 1).trim();
      useStatements.push({ raw, index: stmtStart, line: lineNum, statement });
    }
  }

  // Step 3: Expand group imports recursively
  // Returns array of full path strings
  function expandPath(pathStr) {
    pathStr = pathStr.trim();
    // Find the first `{` to detect group imports
    const braceIdx = pathStr.indexOf("{");
    if (braceIdx === -1) {
      // Simple path — strip `as X` alias
      return [pathStr.replace(/\s+as\s+\w+\s*$/, "").trim()];
    }

    // prefix is everything before `{`
    // e.g. "a::b::" or "a::"
    let prefix = pathStr.slice(0, braceIdx);
    // Normalize prefix: ensure it ends with :: if non-empty
    if (prefix.endsWith("::")) {
      prefix = prefix.slice(0, -2); // remove trailing ::
    } else {
      prefix = prefix.replace(/::$/, "");
    }

    // Extract the content inside the outermost braces
    // We need to find the matching closing brace
    let depth = 0;
    let start = braceIdx;
    let end = -1;
    for (let i = braceIdx; i < pathStr.length; i++) {
      if (pathStr[i] === "{") depth++;
      else if (pathStr[i] === "}") {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }

    if (end === -1) return []; // malformed

    const inner = pathStr.slice(braceIdx + 1, end);

    // Split inner by commas at depth 0
    const parts = splitAtDepth0(inner);

    const results = [];
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;

      // Handle `self` inside group — means the prefix itself
      if (trimmed === "self") {
        if (prefix) results.push(prefix);
        continue;
      }

      // Recursively expand
      const subPaths = expandPath(trimmed);
      for (const sub of subPaths) {
        if (prefix) {
          results.push(prefix + "::" + sub);
        } else {
          results.push(sub);
        }
      }
    }

    return results;
  }

  function splitAtDepth0(str) {
    const parts = [];
    let depth = 0;
    let current = "";
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ch === "{") { depth++; current += ch; }
      else if (ch === "}") { depth--; current += ch; }
      else if (ch === "," && depth === 0) {
        parts.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    if (current.trim()) parts.push(current);
    return parts;
  }

  // Step 4: Classify each expanded path
  function classifyPath(fullPath, line, statement) {
    // Detect glob
    let glob = false;
    let p = fullPath;
    if (p.endsWith("::*")) {
      glob = true;
      p = p.slice(0, -3); // remove ::*
    } else if (p === "*") {
      glob = true;
      p = "";
    }

    const segments = p ? p.split("::") : [];
    const first = segments[0] || "";

    if (first === "std" || first === "core" || first === "alloc") {
      return null; // DROP
    }

    if (first === "crate") {
      return {
        kind: "crate",
        segments: segments.slice(1),
        ...(glob ? { glob: true } : {}),
        line,
        raw: fullPath,
      };
    }

    if (first === "super") {
      // Count consecutive super:: prefixes
      let levels = 0;
      let rest = segments;
      while (rest.length > 0 && rest[0] === "super") {
        levels++;
        rest = rest.slice(1);
      }
      return {
        kind: "super",
        levels,
        segments: rest,
        ...(glob ? { glob: true } : {}),
        line,
        raw: fullPath,
      };
    }

    if (first === "self") {
      return {
        kind: "self",
        segments: segments.slice(1),
        ...(glob ? { glob: true } : {}),
        line,
        raw: fullPath,
      };
    }

    // External crate
    return {
      kind: "external",
      segments,
      ...(glob ? { glob: true } : {}),
      line,
      raw: fullPath,
    };
  }

  const classified = [];
  const details = [];
  const specsSet = new Set();

  // Process use statements
  for (const { raw, line, statement } of useStatements) {
    const expanded = expandPath(raw);
    for (const fullPath of expanded) {
      const entry = classifyPath(fullPath, line, statement);
      if (!entry) continue; // dropped (std/core/alloc)

      classified.push(entry);

      // Build backwards-compat spec string
      let spec;
      if (entry.kind === "mod") {
        spec = "./" + entry.segments[0];
      } else if (entry.kind === "crate") {
        spec = "crate::" + entry.segments.join("::");
      } else if (entry.kind === "external") {
        spec = entry.segments[0]; // just the crate name
      } else if (entry.kind === "super") {
        // Reconstruct raw super path
        spec = "super::".repeat(entry.levels) + entry.segments.join("::");
        if (spec.endsWith("::")) spec = spec.slice(0, -2);
      } else if (entry.kind === "self") {
        spec = "self::" + entry.segments.join("::");
        if (spec.endsWith("::")) spec = spec.slice(0, -2);
      }

      if (spec && !specsSet.has(spec)) {
        specsSet.add(spec);
        details.push({ spec, line, statement });
      }
    }
  }

  // Step 5: Find `mod foo;` declarations
  // First, work on stripped source to avoid commented-out mods
  const modRe = /(?:^|\n)([ \t]*(?:pub\s+)?mod\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*;)/g;
  let modMatch;
  while ((modMatch = modRe.exec(stripped)) !== null) {
    const fullMatch = modMatch[1];
    const name = modMatch[2];
    const stmtStart = modMatch.index + (modMatch[0].startsWith("\n") ? 1 : 0);
    const lineNum = src.substring(0, stmtStart).split("\n").length;

    // Check if preceded by #[path = "..."] attribute — emit warning and DROP
    // Look backwards in the original source for a #[path attribute on the preceding line
    const srcBefore = src.substring(0, stmtStart);
    const lines = srcBefore.split("\n");
    const prevLine = lines[lines.length - 1] || "";
    const prevPrevLine = lines.length >= 2 ? lines[lines.length - 2] : "";
    if (/^\s*#\[path\s*=/.test(prevLine) || /^\s*#\[path\s*=/.test(prevPrevLine)) {
      warnings.push(`mod ${name}: #[path] attribute detected — skipping`);
      continue;
    }

    const spec = "./" + name;
    const statement = fullMatch.trim();

    classified.push({
      kind: "mod",
      segments: [name],
      line: lineNum,
      raw: statement,
    });

    if (!specsSet.has(spec)) {
      specsSet.add(spec);
      details.push({ spec, line: lineNum, statement });
    }
  }

  // Step 6: Find `extern crate foo;` → emit warning, DROP
  const externRe = /(?:^|\n)[ \t]*extern\s+crate\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*;/g;
  let externMatch;
  while ((externMatch = externRe.exec(stripped)) !== null) {
    warnings.push(`extern crate ${externMatch[1]}: deprecated extern crate — skipping`);
  }

  const specs = Array.from(specsSet);

  return { specs, details, classified, warnings };
}

function tryResolveFile(dir, name, allFiles) {
  // Try: dir/name.rs, dir/name/mod.rs, dir/name/lib.rs
  const candidates = [
    path.join(dir, name + ".rs"),
    path.join(dir, name, "mod.rs"),
    path.join(dir, name, "lib.rs"),
  ];
  for (const c of candidates) {
    if (allFiles.has(c)) return c;
  }
  return null;
}

function walkSegments(startDir, segments, allFiles) {
  // Walk each segment, trying to resolve to a file.
  // If a segment resolves to a file, continue from that file's directory.
  // If a segment doesn't resolve:
  //   - first segment fails → no-fabrication rule → return null
  //   - later segment fails → item-in-file rule → return last resolved file
  // All segments resolved → return last resolved file.

  let currentDir = startDir;
  let lastResolved = null;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const resolved = tryResolveFile(currentDir, seg, allFiles);

    if (resolved) {
      lastResolved = resolved;
      // Determine next directory to walk into
      const base = path.basename(resolved);
      if (base === "mod.rs" || base === "lib.rs") {
        // foo/mod.rs → next segment looks in foo/
        currentDir = path.dirname(resolved);
      } else {
        // foo.rs → next segment looks in foo/ (the module directory)
        currentDir = path.join(path.dirname(resolved), path.basename(resolved, ".rs"));
      }
    } else {
      if (i === 0) {
        // First segment failed → no-fabrication rule
        return null;
      }
      // Later segment failed → item-in-file rule
      return lastResolved;
    }
  }

  return lastResolved;
}

function findModuleFile(dir, allFiles) {
  for (const name of ["mod.rs", "lib.rs", "main.rs"]) {
    const candidate = path.join(dir, name);
    if (allFiles.has(candidate)) return candidate;
  }
  return null;
}

function resolveRustImport(fromFile, classifiedSpec, ctx) {
  const { kind, segments, levels, glob } = classifiedSpec;
  const { cratePackages, fileToPackage, allFiles } = ctx;

  if (kind === "mod") {
    // mod foo; → Rust module resolution rules:
    // - If fromFile is foo/mod.rs or foo/lib.rs or foo/main.rs (a "module root"),
    //   look for foo.rs or foo/mod.rs in the same directory as fromFile.
    // - If fromFile is foo/bar.rs (a regular file), look in foo/bar/ (the directory
    //   named after the file without .rs extension), because Rust treats bar.rs as
    //   the module root for the bar module, so bar's submodules live in bar/.
    const base = path.basename(fromFile);
    let dir;
    if (base === "mod.rs" || base === "lib.rs" || base === "main.rs") {
      // Module root file: submodules live in the same directory
      dir = path.dirname(fromFile);
    } else {
      // Regular file foo/bar.rs: submodules live in foo/bar/
      dir = path.join(path.dirname(fromFile), path.basename(fromFile, ".rs"));
    }
    const name = segments[0];
    return tryResolveFile(dir, name, allFiles);
  }

  if (kind === "external") {
    // First segment is the crate name
    const crateName = segments[0];
    const pkg = cratePackages.get(crateName);
    // Only resolve if it's a workspace member, standalone, or external-cargo-dep
    if (!pkg) return null;
    const followable = pkg.kind === "workspace-member"
      || pkg.kind === "standalone"
      || pkg.kind === "external-cargo-dep";
    if (!followable) return null;
    const remainingSegments = segments.slice(1);
    if (remainingSegments.length === 0) {
      // Just the crate root file
      return pkg.root;
    }
    // Try to walk remaining segments from the crate's src root dir
    const startDir = path.dirname(pkg.root);
    const walked = walkSegments(startDir, remainingSegments, allFiles);
    // If first remaining segment fails (item is in the crate root), return pkg.root
    if (walked === null) return pkg.root;
    return walked;
  }

  let startDir;

  if (kind === "crate") {
    // Start from the crate's src root directory
    const pkgName = fileToPackage.get(fromFile);
    if (!pkgName) return null;
    const pkg = cratePackages.get(pkgName);
    if (!pkg) return null;
    startDir = path.dirname(pkg.root);
    if (segments.length === 0) return pkg.root;
  } else if (kind === "super") {
    // Walk up `levels` directories from the module's directory.
    // For mod.rs: the module IS the directory, so super goes one level above dirname(fromFile).
    // For regular .rs: the module is inside dirname(fromFile), so super stays at dirname(fromFile).
    const isModRs = path.basename(fromFile) === "mod.rs";
    let dir = path.dirname(fromFile);
    if (isModRs) {
      // mod.rs represents the directory itself; super means parent of that directory
      dir = path.dirname(dir);
    }
    // levels=1 means one super, already handled above for mod.rs.
    // For levels>1, walk up additional times.
    for (let i = 1; i < levels; i++) {
      dir = path.dirname(dir);
    }
    startDir = dir;
    if (segments.length === 0) {
      // bare `super` — return the parent module file itself
      return findModuleFile(startDir, allFiles);
    }
    const superResult = walkSegments(startDir, segments, allFiles);
    if (superResult === null) {
      // No segment resolved as a file → items live in the parent module file
      return findModuleFile(startDir, allFiles);
    }
    return superResult;
  } else if (kind === "self") {
    // self:: means the current module's directory.
    // For mod.rs: the module is the directory containing mod.rs.
    // For regular .rs: the module is inside dirname(fromFile).
    // In both cases, startDir = dirname(fromFile).
    startDir = path.dirname(fromFile);
    if (segments.length === 0) return null;
    const selfResult = walkSegments(startDir, segments, allFiles);
    if (selfResult === null) {
      // No segment resolved as a file → items live in self's module file
      return findModuleFile(startDir, allFiles);
    }
    return selfResult;
  } else {
    return null;
  }

  // Only crate:: reaches here (super/self return early above)
  return walkSegments(startDir, segments, allFiles);
}

module.exports = { parseCargoToml, extractExternalDeps, discoverCratePackages, extractRustImports, resolveRustImport, runCargoMetadata, mergeExternalDeps };
