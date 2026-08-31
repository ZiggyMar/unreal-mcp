import test from "node:test";
import assert from "node:assert/strict";

import { stripSchemaDeclaration } from "../dist/trimSchemaDeclaration.js";

/**
 * Measured on the `full` profile: the standing payload is 146,119 characters, of which 23% is JSON
 * Schema STRUCTURE rather than anything anyone wrote. Its biggest single line item is one string
 * repeated once per tool:
 *
 *   "$schema":"http://json-schema.org/draft-07/schema#"
 *
 * 50 characters x 107 tools = about 1,338 tokens paid on every request, declaring a dialect that
 * changes nothing about what these schemas accept. Removing it took `full` from 37,400 to 36,009
 * and every other profile with it.
 */

const listReply = (tools) => ({ jsonrpc: "2.0", id: 1, result: { tools } });

test("the declaration goes and the schema does not change", () => {
  const message = listReply([
    {
      name: "unreal_add_variable",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, variableName: { type: "string" } },
        required: ["path", "variableName"],
        additionalProperties: false,
        $schema: "http://json-schema.org/draft-07/schema#",
      },
    },
  ]);
  const out = stripSchemaDeclaration(message);
  const schema = out.result.tools[0].inputSchema;
  assert.equal("$schema" in schema, false);
  assert.deepEqual(schema, {
    type: "object",
    properties: { path: { type: "string" }, variableName: { type: "string" } },
    required: ["path", "variableName"],
    additionalProperties: false,
  });
});

test("additionalProperties survives, because the strict refusal depends on it", () => {
  // "not a parameter of unreal_list_blueprints. It accepts: ..." is built on additionalProperties
  // being false. Dropping the wrong key here would silently re-open the 53x cost that made schemas
  // strict in the first place.
  const out = stripSchemaDeclaration(
    listReply([{ name: "t", inputSchema: { type: "object", additionalProperties: false, $schema: "x" } }])
  );
  assert.equal(out.result.tools[0].inputSchema.additionalProperties, false);
});

test("an outputSchema is treated the same way", () => {
  const out = stripSchemaDeclaration(
    listReply([{ name: "t", inputSchema: { type: "object", $schema: "x" }, outputSchema: { type: "object", $schema: "x" } }])
  );
  assert.equal("$schema" in out.result.tools[0].inputSchema, false);
  assert.equal("$schema" in out.result.tools[0].outputSchema, false);
});

test("every other message passes through as the same object", () => {
  // This runs on every outgoing message, so the no-op path has to be free and must not rebuild
  // anything. Identity is the assertion, not deep equality.
  for (const message of [
    { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "hello" }] } },
    { jsonrpc: "2.0", id: 3, result: {} },
    { jsonrpc: "2.0", id: 4, error: { code: -32602, message: "nope" } },
    { jsonrpc: "2.0", method: "notifications/message", params: {} },
  ]) {
    assert.equal(stripSchemaDeclaration(message), message);
  }
});

test("a tools/list that never carried a declaration is returned untouched", () => {
  const message = listReply([{ name: "t", inputSchema: { type: "object" } }]);
  assert.equal(stripSchemaDeclaration(message), message, "no rebuild when there is nothing to strip");
});

test("nothing that is not a message breaks it", () => {
  assert.equal(stripSchemaDeclaration(null), null);
  assert.equal(stripSchemaDeclaration(undefined), undefined);
  assert.equal(stripSchemaDeclaration("text"), "text");
  const empty = listReply([]);
  assert.equal(stripSchemaDeclaration(empty), empty);
});

test("a tool with no schema at all is left alone", () => {
  const message = listReply([{ name: "t" }]);
  assert.equal(stripSchemaDeclaration(message), message);
});
