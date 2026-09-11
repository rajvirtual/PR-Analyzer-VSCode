/**
 * What an answer rested on beyond the diff.
 *
 * The tools let a model read the wider repository; a reader deciding whether to trust
 * the answer wants to see which files it actually opened. These helpers collect those
 * paths and phrase them, so provenance is shown rather than implied.
 */

/** Adds paths to the already-consulted list, deduped and in first-seen order. */
export function mergeConsulted(into: string[], add: readonly string[] | undefined): string[] {
  if (!add || add.length === 0) return into;
  const seen = new Set(into);
  const result = [...into];
  for (const path of add) {
    if (path && !seen.has(path)) {
      seen.add(path);
      result.push(path);
    }
  }
  return result;
}

/** A short line naming what an answer read outside the change, or that it read nothing. */
export function consultedNote(consulted: string[]): string {
  if (consulted.length === 0) {
    return "Answered from the change alone; no other files were read.";
  }
  const shown = consulted.slice(0, 5).join(", ");
  const more = consulted.length > 5 ? `, and ${consulted.length - 5} more` : "";
  return `Read alongside the change: ${shown}${more}.`;
}
