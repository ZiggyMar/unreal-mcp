/**
 * Drop the `$schema` declaration from every tool schema on the way out.
 *
 * Measured on the `full` profile: the standing payload is 146,119 characters, and its composition is
 *
 *   descriptions      70,614   48%
 *   input schemas     59,200   41%   (of which parameter prose 26,138 = 18%)
 *   titles             4,199    3%
 *   names              2,582    2%
 *
 * so 23% - about 33,000 characters - is JSON Schema STRUCTURE rather than anything anyone wrote. The
 * biggest single line item in it is one string repeated once per tool:
 *
 *   "$schema":"http://json-schema.org/draft-07/schema#"
 *
 * 50 characters x 107 tools = 5,350 characters, about **1,338 tokens paid on every single request**.
 * It is emitted by zod-to-json-schema, which the MCP SDK calls without an option to turn it off.
 *
 * ## Why this is not a quality trade
 *
 * `$schema` declares which dialect a schema is written in. It is optional metadata: a validator with
 * no declaration uses its newest supported draft, and every construct these schemas actually use -
 * `type`, `properties`, `required`, `additionalProperties`, `items`, `enum`, and a union spelled
 * `"type": ["string","number","boolean"]` - means precisely the same thing in draft-07 and 2020-12.
 * Nothing about what a caller may send, or what is rejected, changes.
 *
 * That is the whole test for a saving like this: a compaction that removes an ABILITY is not worth
 * having at any price, and this removes a label.
 *
 * ## Why at the transport
 *
 * The schemas are built by the SDK from zod, so there is no earlier point that owns them. Rewriting
 * outgoing messages is the one place that sees the finished payload, and it is deliberately narrow:
 * it touches `tools/list` results and the `$schema` key alone, and returns the message untouched
 * when there is nothing to strip.
 */

/** Shape of the bit of a tools/list reply this cares about. */
interface ToolsListish {
  result?: {
    tools?: Array<Record<string, unknown>>;
  };
}

const SCHEMA_KEYS = ["inputSchema", "outputSchema"] as const;

/**
 * Return the message with `$schema` removed from each tool schema, or the same object when there was
 * nothing to remove.
 *
 * Identity is preserved on the no-op path so the transport is not made to rebuild every message it
 * sends - only tools/list carries schemas, and it is sent once per session.
 */
export function stripSchemaDeclaration<T>(message: T): T {
  const tools = (message as ToolsListish)?.result?.tools;
  if (!Array.isArray(tools) || tools.length === 0) return message;

  let changed = false;
  const rewritten = tools.map((tool) => {
    let next = tool;
    for (const key of SCHEMA_KEYS) {
      const schema = next[key];
      if (schema && typeof schema === "object" && "$schema" in (schema as Record<string, unknown>)) {
        const { $schema: _dropped, ...rest } = schema as Record<string, unknown>;
        next = { ...next, [key]: rest };
        changed = true;
      }
    }
    return next;
  });

  if (!changed) return message;
  const msg = message as ToolsListish;
  return { ...(message as object), result: { ...msg.result, tools: rewritten } } as T;
}
