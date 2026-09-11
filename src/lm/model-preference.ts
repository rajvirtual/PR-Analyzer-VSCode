/**
 * Which model does the background work.
 *
 * The default is whatever the platform offers first, because that is what was
 * drawing when the diagram was accepted on 2026-09-06. Reordering by a preference
 * list silently changed the output, so a preference now applies only when the
 * reader asks for one.
 */

export interface ModelLike {
  id: string;
  name: string;
  family: string;
}

export function chooseModel<T extends ModelLike>(models: T[], preferred = ""): T | undefined {
  if (models.length === 0) return undefined;

  const wanted = preferred.trim();
  if (!wanted) return models[0];

  const exact = models.find(
    (model) =>
      model.id === wanted ||
      model.family === wanted ||
      model.name.toLowerCase() === wanted.toLowerCase(),
  );
  if (exact) return exact;

  const partial = models.find((model) =>
    `${model.id} ${model.family} ${model.name}`.toLowerCase().includes(wanted.toLowerCase()),
  );

  return partial ?? models[0];
}
