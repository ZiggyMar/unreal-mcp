/**
 * Does unreal_find_node find what a person would actually type, and does it stay quiet when it has
 * nothing?
 *
 * Both halves are the point. The catalog is keyed on C++ names - Array_Length - while the editor
 * shows "Array Length", so a model that types what it can see got nothing back, guessed a name, and
 * spent a failed build_graph call finding out. And the old substring match answered "Do N" with
 * GetCustomDoNotImportCurveWithZero, because "...Do N ot Import..." contains those characters: a
 * confident wrong hit, which is worse than no hit, because no hit sends the caller elsewhere.
 *
 * Requires a running editor with the plugin loaded.
 *   node scripts/trial-node-search.mjs
 */
import { startAndInitialize } from "./lib/mcpStdio.mjs";

const server = await startAndInitialize({ UNREAL_MCP_PROFILE: "search" }, "node-search-trial");

// Through the dispatcher, so this costs no tool-list change - and exercises that path too.
const find = async (query, maxResults = 5) => {
  const res = await server.request("tools/call", {
    name: "unreal_call_tool",
    arguments: { tool: "unreal_find_node", args: { query, maxResults } },
  });
  const text = res?.result?.content?.[0]?.text ?? "";
  try {
    const parsed = JSON.parse(text);
    return (parsed.hits ?? []).map((h) => h.functionName ?? h.name ?? "?");
  } catch {
    return [`PARSE_FAIL: ${text.slice(0, 120)}`];
  }
};

const results = [];
const check = (label, pass, detail = "") => {
  results.push(pass);
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? ` - ${detail}` : ""}`);
};

// The headline case: the name the editor puts on the node.
const arrayLength = await find("Array Length");
check("\"Array Length\" finds Array_Length", arrayLength[0] === "Array_Length", arrayLength.join(", "));

// The same question spelled three ways must give the same answer, or the separator is still
// deciding the result.
for (const spelling of ["array_length", "ArrayLength", "array length"]) {
  const hits = await find(spelling);
  check(`"${spelling}" agrees with "Array Length"`, hits[0] === "Array_Length", hits.join(", "));
}

// The noise case. This is the regression that matters: it used to return a confident wrong answer.
const doN = await find("Do N");
check(
  "\"Do N\" does not answer with GetCustomDoNotImportCurveWithZero",
  !doN.some((h) => /DoNotImport/i.test(h)),
  doN.length === 0 ? "(no hits, which is the honest answer)" : doN.join(", ")
);

// Typeahead must survive: someone half-typing the LAST word should still land. Asserted with a
// query that has no exact match, because "len" is the name of a real function and an exact hit
// outranking a prefix hit is correct behaviour, not a miss.
const partial = await find("Array Leng");
check("a half-typed last word still lands", partial[0] === "Array_Length", partial.join(", "));

// ...but not from one or two letters, which is where the noise lives.
const oneLetter = await find("Get N");
check(
  "a single-letter last word does not match anything it likes",
  !oneLetter.some((h) => /DoNotImport|NotImport/i.test(h)),
  oneLetter.slice(0, 3).join(", ") || "(no hits)"
);

// Things that already worked must keep working - a search fix that breaks the common path is a
// net loss no matter how good the new cases look.
for (const [query, expected] of [
  ["Print String", /PrintString/i],
  ["Add Item", /AddItem|Array_Add/i],
  ["Spawn Actor", /SpawnActor/i],
  ["Get Actor Location", /GetActorLocation/i],
]) {
  const hits = await find(query);
  check(`"${query}" still resolves`, hits.some((h) => expected.test(h)), hits.slice(0, 3).join(", "));
}

server.child.kill();

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
