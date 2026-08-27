// Finds exported symbols that nothing in production source imports.
//
// The integration sweep found six route registrars written, exported, and
// referenced by nothing -- which shipped a 38-path contract with no way to sign
// in. Nothing failed, because every piece was individually correct.
//
// This is that check, generalised. It is deliberately crude: it counts textual
// references outside the defining file, so a symbol used only in tests, or only
// in its own module, surfaces. Crude and noisy beats absent.

import { readdirSync, statSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.argv[2] ?? "packages";

function files(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...files(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

const all = files(ROOT);
const production = all.filter(f => !f.endsWith(".test.ts"));
const sources = new Map(all.map(f => [f, readFileSync(f, "utf8")]));

// Exported functions, classes and consts. Types are excluded: an unused type is
// harmless, while an unused function is a capability nobody can reach.
const EXPORT = /^export (?:async )?(?:function|class|const) ([A-Za-z_][A-Za-z0-9_]*)/gm;

const findings = [];
for (const file of production) {
  const source = sources.get(file) ?? "";
  for (const match of source.matchAll(EXPORT)) {
    const name = match[1];
    let prodRefs = 0;
    let testRefs = 0;
    for (const [other, text] of sources) {
      if (other === file) continue;
      const hits = text.split(new RegExp(`\\b${name}\\b`)).length - 1;
      if (hits === 0) continue;
      if (other.endsWith(".test.ts")) testRefs += hits;
      else prodRefs += hits;
    }
    if (prodRefs === 0) {
      findings.push({ file: path.relative(".", file), name, testRefs });
    }
  }
}

// An index re-export is a reference, so anything reaching this list is not
// merely un-barrelled -- nothing outside its own file uses it.
findings.sort((a, b) => a.file.localeCompare(b.file));
for (const f of findings) {
  console.log(`${f.testRefs > 0 ? "TESTS-ONLY" : "UNREFERENCED"}  ${f.file}  ${f.name}`);
}
console.log(`\n${String(findings.length)} exported symbols with no production reference outside their own file.`);
