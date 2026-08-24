import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// connector/public/ is served to the browser verbatim: app.js is never
// compiled, never typechecked, and no other test loads it. So a mismatch
// between the ids app.js looks up and the ids index.html defines is invisible
// until an operator opens the inspector and a handler throws on `null.hidden`.
//
// This was not hypothetical. Removing the env-mode banner deleted
// #tunnel-env-mode and #tunnel-mode-badge from index.html and dropped their
// two consts from app.js — while showTunnelView() still assigned to both. The
// build passed, the whole vitest suite passed, and the Tunnel panel would have
// thrown a TypeError on first render. A grep missed it because the consts are
// `elTunnelEnvMode`, so a search for "tunnelEnvMode" does not match.
//
// Checked both directions: a lookup with no element is a latent crash, and an
// element nothing looks up is usually a leftover worth noticing.

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, "../../public");

const html = readFileSync(join(PUBLIC, "index.html"), "utf8");
const js = readFileSync(join(PUBLIC, "app.js"), "utf8");

/** ids app.js resolves via getElementById('...'). */
function lookedUpIds(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)) out.add(m[1]);
  return [...out].sort();
}

/** ids declared in the markup. */
function declaredIds(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(/\sid=["']([^"']+)["']/g)) out.add(m[1]);
  return out;
}

describe("inspector public assets — DOM contract", () => {
  it("every getElementById in app.js resolves to an id in index.html", () => {
    const declared = declaredIds(html);
    const missing = lookedUpIds(js).filter((id) => !declared.has(id));
    expect(missing, "app.js looks up ids that index.html does not define").toEqual([]);
  });

  it("app.js assigns only to consts it still declares", () => {
    // Catches the exact shape of the near-miss: a `const elFoo = ...` deleted
    // while `elFoo.hidden = ...` survived. Any el* identifier that is assigned
    // a property must also be declared in the file.
    const declaredConsts = new Set(
      [...js.matchAll(/\bconst\s+(el[A-Za-z0-9_]+)\s*=/g)].map((m) => m[1]),
    );
    const used = new Set([...js.matchAll(/\b(el[A-Za-z0-9_]+)\s*\./g)].map((m) => m[1]));
    const undeclared = [...used].filter((n) => !declaredConsts.has(n)).sort();
    expect(undeclared, "app.js dereferences el* identifiers it never declares").toEqual([]);
  });

  it("the removed env-mode elements are gone from both files", () => {
    for (const id of ["tunnel-env-mode", "tunnel-mode-badge"]) {
      expect(html, `index.html still declares #${id}`).not.toContain(`id="${id}"`);
      expect(js, `app.js still references #${id}`).not.toContain(id);
    }
  });
});
