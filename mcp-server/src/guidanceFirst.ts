/**
 * Fields that tell a caller what to DO, in the order they should be read.
 *
 * Not a style preference - measured. Across the surface these sat at the END of their replies, which
 * is where a reader loses them first:
 *
 *   audit_project           nextAction  91% of 13,106 chars
 *   read_blueprint_summary  next        96% of  9,260
 *   list_actors             next        96% of  7,162
 *   map_system              note        98% of  3,311
 *   list_blueprints         next        97% of 10,663
 *
 * Every one of those is the sentence explaining what to do, or that the answer is INCOMPLETE - and
 * every one is dropped by a client that truncates, a context that fills, or a person reading the head
 * of the output. That last one is not hypothetical: it cost two wrong readings in the session that
 * measured this, once on start_pie whose `next` named the exact flag needed.
 */
const GUIDANCE_FIRST = ["nextAction", "next", "warning", "remedy", "verdict", "note"];

/**
 * Move the guidance to the front, leaving everything else exactly as it was.
 *
 * Done centrally rather than at each of the thirty-odd places that build a reply, for the reason the
 * write guard above this file gives for itself: a rule with thirty call sites has thirty chances to
 * be forgotten, and a tool added next year gets this for free.
 *
 * Costs nothing. JSON key order is insertion order, JSON.stringify preserves it, and no field is
 * added, dropped or changed - the reply is byte-identical in LENGTH and different only in order.
 * Arrays and primitives pass through untouched; only a plain object is reordered, and only its top
 * level, because a nested `note` belongs with the thing it annotates.
 */
export function guidanceFirst(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  const lead = GUIDANCE_FIRST.filter((k) => k in source);
  if (lead.length === 0) return value;
  const reordered: Record<string, unknown> = {};
  for (const key of lead) reordered[key] = source[key];
  for (const key of Object.keys(source)) if (!(key in reordered)) reordered[key] = source[key];
  return reordered;
}

