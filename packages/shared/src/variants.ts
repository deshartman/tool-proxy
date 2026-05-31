// Shared "Change document" implementation. Both the shim's filesystem adapter
// and the laptop-side local-server call this so there's one canonical
// algorithm for swapping a doc's step 1 between two variants.
//
// LOAD-BEARING INVARIANT: shims MUST NOT cache document content in memory.
// FilesystemAdapter.fetch re-reads on every call; that's why the local-server
// can write the file directly and the next ask_procedure call from the shim
// will see the new content. If we ever add caching to the shim, this whole
// path needs invalidation.

import { readFile, writeFile } from "node:fs/promises";

export type DocVariantName = "original" | "alternate";

export interface DocVariants {
  original: string;
  alternate: string;
}

/** Detect which variant currently lives in the file at `absolutePath`. */
export async function detectVariantInFile(
  absolutePath: string,
  variants: DocVariants
): Promise<DocVariantName | undefined> {
  const text = await readFile(absolutePath, "utf8");
  // Match by the first line of each variant — exact text match is too brittle
  // when a partial swap left the file in a mixed state, but the first-line
  // string is unique enough in practice for the demo's two procedures.
  if (text.includes(variants.alternate.split("\n")[0])) return "alternate";
  if (text.includes(variants.original.split("\n")[0])) return "original";
  return undefined;
}

/**
 * Swap step 1 of the document at `absolutePath` between the two variants.
 * If `target` is omitted, toggles to whichever isn't currently active.
 * Returns the resulting active variant.
 */
export async function applyVariantInFile(
  absolutePath: string,
  variants: DocVariants,
  target?: DocVariantName
): Promise<DocVariantName> {
  const text = await readFile(absolutePath, "utf8");
  const current = await detectVariantInFile(absolutePath, variants);
  if (!current) {
    throw new Error(
      "neither variant detected in document — cannot determine where step 1 is"
    );
  }
  const next: DocVariantName =
    target ?? (current === "alternate" ? "original" : "alternate");
  if (current === next) return current;

  // The variant currently in the file IS our marker — find it and replace it
  // with the other variant in place. Robust regardless of which is active.
  const currentText = current === "original" ? variants.original : variants.alternate;
  const idx = text.indexOf(currentText);
  if (idx === -1) {
    throw new Error("variant detected but exact text not found — file may have drifted");
  }
  const nextText = next === "original" ? variants.original : variants.alternate;
  const newText = text.slice(0, idx) + nextText + text.slice(idx + currentText.length);
  await writeFile(absolutePath, newText, "utf8");
  return next;
}
