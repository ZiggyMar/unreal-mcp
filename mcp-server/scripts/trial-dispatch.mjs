/**
 * Does calling a tool without switching it on actually work, and does it really leave the tool list
 * alone?
 *
 * Both halves matter and only one of them is obvious. That the dispatcher returns a result can be
 * checked by reading the code. That the advertised tool list is byte-for-byte unchanged afterwards
 * cannot - and that is the entire reason unreal_call_tool exists, because a tool-list change is what
 * invalidates the prompt cache for the whole conversation.
 *
 * Run against a live editor:  node scripts/trial-dispatch.mjs
 */
import { startAndInitialize, listTools } from "./lib/mcpStdio.mjs";

const call = async (server, name, args = {}) => {
  const res = await server.request("tools/call", { name, arguments: args });
  const text = res?.result?.content?.[0]?.text ?? JSON.stringify(res?.result ?? res);
  return { text, isError: res?.result?.isError === true };
};

const results = [];
const check = (label, pass, detail = "") => {
  results.push({ label, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? ` - ${detail}` : ""}`);
};

const server = await startAndInitialize({ UNREAL_MCP_PROFILE: "search" }, "dispatch-trial");

const before = await listTools(server);
const names = before.tools.map((t) => t.name).sort();
check(
  "search advertises the meta-tools plus the dispatcher",
  names.includes("unreal_call_tool") && names.includes("unreal_list_tools"),
  names.join(", ")
);

// The schema for a tool that is switched OFF. This is describe_toolset: the information a caller
// needs to build the call, delivered as a reply instead of as a definition.
const described = await call(server, "unreal_list_tools", { schema: "unreal_get_project_overview" });
check(
  "a disabled tool's schema can be read without switching it on",
  !described.isError && described.text.includes("unreal_get_project_overview") && described.text.includes("parameters"),
  described.text.slice(0, 140)
);

// The dispatch itself, to a tool that is registered and disabled. If enablement were required this
// is where it would fail.
const dispatched = await call(server, "unreal_call_tool", {
  tool: "unreal_get_project_overview",
  args: {},
});
check(
  "a disabled tool runs through the dispatcher",
  !dispatched.isError,
  dispatched.text.slice(0, 160)
);

// The point of the whole exercise.
const after = await listTools(server);
check(
  "the advertised tool list is unchanged after dispatching",
  JSON.stringify(after.tools) === JSON.stringify(before.tools),
  `${before.tokens} tokens before, ${after.tokens} after`
);

// And the contrast: enabling really does move it, which is the cost being avoided.
await call(server, "unreal_enable_tools", { tools: ["unreal_get_project_overview"] });
const afterEnable = await listTools(server);
check(
  "enabling DOES change the tool list, which is the cost being avoided",
  JSON.stringify(afterEnable.tools) !== JSON.stringify(before.tools),
  `${before.tokens} tokens before, ${afterEnable.tokens} after enabling one tool`
);

// Bad arguments must be refused the same way through either path, or the dispatcher is a hole in
// the validation rather than a cheaper door to it.
const badArgs = await call(server, "unreal_call_tool", {
  tool: "unreal_get_project_overview",
  args: { notAParameter: 1 },
});
check(
  "an unknown argument is refused by the dispatcher too",
  badArgs.isError || /not a parameter|bad_args|Unrecognized/i.test(badArgs.text),
  badArgs.text.slice(0, 160)
);

const unknown = await call(server, "unreal_call_tool", { tool: "unreal_get_project_overvieww" });
check(
  "a near-miss name suggests the right tool",
  /unknown_tool/.test(unknown.text) && /unreal_get_project_overview/.test(unknown.text),
  unknown.text.slice(0, 160)
);

const selfCall = await call(server, "unreal_call_tool", { tool: "unreal_call_tool" });
check("the dispatcher refuses to call itself", /cannot call itself/.test(selfCall.text), selfCall.text.slice(0, 120));

server.child.kill();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
