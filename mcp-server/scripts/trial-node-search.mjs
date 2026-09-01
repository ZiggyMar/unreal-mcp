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
const raw = async (query, maxResults = 5) => {
  const res = await server.request("tools/call", {
    name: "unreal_call_tool",
    arguments: { tool: "unreal_find_node", args: { query, maxResults } },
  });
  const text = res?.result?.content?.[0]?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return { parseFail: text.slice(0, 120) };
  }
};

const find = async (query, maxResults = 5) => {
  const parsed = await raw(query, maxResults);
  if (parsed.parseFail) return [`PARSE_FAIL: ${parsed.parseFail}`];
  return (parsed.hits ?? []).map((h) => h.functionName ?? h.name ?? "?");
};

/** The macro and node-kind names a query turns up, which are NOT in the function catalog. */
const findKinds = async (query) => {
  const parsed = await raw(query);
  return [...(parsed.nodeTypes ?? []), ...(parsed.macros ?? [])].map((h) => h.name);
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

// Macros and node kinds. build_graph places every one of these, so find_node reporting nothing -
// or worse, reporting AddBranchNode for "Branch" - was one half of the server calling the other
// half's work nonexistent.
for (const [query, expected] of [
  ["ForEachLoop", "ForEachLoop"],
  ["For Each Loop", "ForEachLoop"],
  ["Do Once", "DoOnce"],
  ["WhileLoop", "WhileLoop"],
  ["FlipFlop", "FlipFlop"],
  ["Gate", "Gate"],
  ["Branch", "Branch"],
  ["Sequence", "Sequence"],
]) {
  const kinds = await findKinds(query);
  check(`"${query}" finds the ${expected} node`, kinds.includes(expected), kinds.join(", ") || "(none)");
}

// And it must say how to place them, or naming them only moves the guess one step along.
const branch = await raw("Branch");
check(
  "a node kind comes with how to place it",
  /nodeType/.test(JSON.stringify(branch.nodeTypes ?? [])),
  JSON.stringify((branch.nodeTypes ?? [])[0] ?? {})
);
const forEach = await raw("ForEachLoop");
check(
  "a macro comes with its macroName",
  /macroName/.test(JSON.stringify(forEach.macros ?? [])),
  JSON.stringify((forEach.macros ?? [])[0] ?? {})
);

// An exact node-kind answer must not drag unrelated functions along with it. "Branch" used to send
// one correct line and then 142 tokens of AddBranchNode, tooltip and all.
const branchHits = await find("Branch");
check(
  "an exact node kind drops the coincidental function hits",
  !branchHits.some((h) => /AddBranchNode|IsInstancedStructValid/.test(h)),
  branchHits.join(", ") || "(no function hits, which is right)"
);
const seqHits = await find("Sequence");
check(
  "\"Sequence\" no longer answers with SequenceEvent",
  !seqHits.some((h) => /SequenceEvent/.test(h)),
  seqHits.join(", ") || "(none)"
);

// ...but the rule must be exactness, not bluntness. IsValid is genuinely BOTH a macro and a
// function, and dropping either would be a wrong answer of the opposite kind.
const isValid = await raw("IsValid");
const isValidKinds = [...(isValid.nodeTypes ?? []), ...(isValid.macros ?? [])].map((h) => h.name);
const isValidFns = (isValid.hits ?? []).map((h) => h.functionName);
check(
  "IsValid keeps both the macro and the real function",
  isValidKinds.includes("IsValid") && isValidFns.includes("IsValid"),
  `kinds=[${isValidKinds.join(", ")}] fns=[${isValidFns.join(", ")}]`
);

// A plain function search must NOT grow a macros/nodeTypes section it does not need.
const plain = await raw("Print String");
check(
  "an ordinary function search stays lean",
  plain.macros === undefined && plain.nodeTypes === undefined && plain.note === undefined,
  `macros=${plain.macros !== undefined} nodeTypes=${plain.nodeTypes !== undefined} note=${plain.note !== undefined}`
);

// The next call after find_node names a macro is for its pins. Being told ForEachLoop does not
// exist, one call after being told it does, is the two-tools-disagreeing defect with a single step
// between the halves - and the didYouMean was the last place "Branch -> AddBranchNode" still lived.
const sig = async (functionName) => {
  const res = await server.request("tools/call", {
    name: "unreal_call_tool",
    arguments: { tool: "unreal_get_node_signature", args: { functionName } },
  });
  const text = res?.result?.content?.[0]?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
};

const forEachSig = await sig("ForEachLoop");
check(
  "get_node_signature knows ForEachLoop exists",
  forEachSig.kind === "macro" && forEachSig.isFunction === false,
  JSON.stringify(forEachSig).slice(0, 140)
);
check(
  "and reports its real pins, read from the macro graph",
  JSON.stringify(forEachSig.outputs ?? []).includes("Array Element"),
  `inputs=${JSON.stringify(forEachSig.inputs ?? [])} outputs=${JSON.stringify(forEachSig.outputs ?? [])}`.slice(0, 200)
);

const branchSig = await sig("Branch");
check(
  "get_node_signature no longer steers Branch to AddBranchNode",
  branchSig.kind === "nodeType" && !JSON.stringify(branchSig).includes("AddBranchNode"),
  JSON.stringify(branchSig).slice(0, 160)
);

// A genuinely unknown name must still fail, or this became a tool that never says no.
const nonsense = await sig("ThisIsNotARealNodeAtAll");
check(
  "an unknown name still fails honestly",
  /node_signature_not_found/.test(JSON.stringify(nonsense)),
  JSON.stringify(nonsense).slice(0, 120)
);

server.child.kill();

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
