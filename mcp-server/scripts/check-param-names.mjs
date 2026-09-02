#!/usr/bin/env node
// One concept, one parameter name - or an accepted alias.
//
// I got a parameter name wrong three times in one session, on my own tools, while doing real work:
//
//   unreal_trace_variable        takes `variable`,  six other tools take `variableName`
//   unreal_trace_function_calls  takes `function`,  six other tools take `functionName`
//   unreal_find_node             takes `query`
//
// That is not a model being careless. A model that has just read six tools taking `variableName`
// types `variableName` at the seventh, because that is what the surface taught it. Each miss cost a
// round trip - and this server's own standing instructions say "never guess a name; a guess costs a
// failed call", which only holds up if the names do not need guessing at.
//
// The validation errors were excellent: they named the right parameter and said "Nothing ran". Good
// errors are the second line of defence. The first is not needing them.
//
// So: when a name is used by several tools for the same thing, a tool using a DIFFERENT name for
// that same thing has to accept the common one too. The odd spelling can stay - renaming a published
// parameter breaks callers - but it cannot be the only way in.
//
// Run: npm run check:params  (also part of npm test)

import { startAndInitialize, listTools } from "./lib/mcpStdio.mjs";

// Pairs that mean the same thing, minority spelling first. Found rather than assumed: the majority
// name is whichever appears in more tools, and that is checked below so this table cannot drift into
// claiming the wrong one is common.
const SYNONYMS = [
  { odd: "variable", common: "variableName" },
  { odd: "function", common: "functionName" },
  // Added after four more misses in one working session. The table was too narrow: it covered the
  // two pairs that had bitten by then, so the guard passed while the same class of mistake kept
  // costing round trips. These come from measuring the whole surface rather than from taste -
  // `name` is on 34 tools, `nodeId` on 12, and connect_pins was the only tool of 126 spelling a
  // node id `sourceNodeId`.
  { odd: "functionName", common: "name" },
  // Found by using this server for a real feature and getting the name wrong, twice, after having
  // just read tools that spell it the other way. Ten tools take `match`; four took `query` and only
  // `query`. Four take `className`; unreal_list_actors was the only tool in the project spelling it
  // `classFilter`.
  //
  // Neither pair was visible to the derived sweep below, and that is worth writing down rather than
  // quietly fixing: the sweep groups spellings that differ by a Name/Path/Id SUFFIX, so it can see
  // variable/variableName and is blind to two different WORDS for one idea. It found the shape it
  // was built to find. These two came from a model tripping over them, which is the other way this
  // list is supposed to grow.
  { odd: "query", common: "match" },
  { odd: "classFilter", common: "className" },
  // connect_pins' source/target spelling is deliberately NOT here. This guard's argument is a
  // majority one - "a model that has read the other eighteen will type the common word" - and
  // source/target vs from/to is one tool against one tool, so there is no majority to appeal to.
  // It got aliased in index.ts on the separate ground that twelve tools spell a node id `nodeId`
  // and this was the only one that did not, but that is a claim this table cannot check, and an
  // entry the guard has to be argued out of is worse than no entry.
];

/**
 * Concepts spelled more than one way that this guard has looked at and is letting stand.
 *
 * SYNONYMS above is hand-written, and its own comment records it being widened once after "four
 * more misses in one working session" - it covered the two pairs that had bitten by then and passed
 * happily while the same class of mistake kept costing round trips. A table that has already been
 * too narrow once will be too narrow again, and nothing in the guard could notice.
 *
 * So the pairs are DERIVED below, from the parameters the tools actually declare, and every
 * multi-spelled concept must be either covered by SYNONYMS or waived here with a reason. The list
 * stops being something someone has to remember to extend.
 */
const WAIVED = [
  {
    concept: "event",
    why:
      "add_node takes `eventName`, add_event_handler takes `event`, and that is one tool against " +
      "one. This guard's argument is a majority one - a model that has read the other seven will " +
      "type the common word - and there is no majority here to appeal to. Same reasoning that keeps " +
      "connect_pins' source/target out of SYNONYMS, and for the same reason it is written down " +
      "rather than left absent: an unexplained gap and a considered one look identical.",
  },
];

const problems = [];
const exemptions = [];

/**
 * Every tool's parameters, taken from the schemas the server actually sends.
 *
 * This used to parse src/index.ts with a regex for keys at exactly six spaces of indentation. The
 * intent was right - only TOP-LEVEL parameters count, because unreal_add_event_handler has an
 * `actions: [{ function, functionName, className, params }]` array and a field inside that object
 * is not a parameter of the tool. Renaming one to `name` would be actively worse: at the top level
 * `name` means "the thing this tool acts on", and inside an action it could as easily mean the
 * action's own name.
 *
 * But indentation is not the schema, and the regex quietly missed real parameters: the derived
 * check below found `event` and `eventName` as two spellings of one concept when asked the live
 * server, and found nothing at all when asked the source. A guard reading a proxy for the artifact
 * finds proxy answers.
 *
 * So it asks the server on the `full` profile, where every tool is registered, and reads
 * inputSchema.properties - which is exactly the set of names a model can type. Nesting stops being
 * something to detect: a field inside an array-of-objects is simply not a property.
 */
const server = await startAndInitialize({ UNREAL_MCP_PROFILE: "full" }, "check-param-names");
let tools;
try {
  tools = (await listTools(server)).tools.map((t) => ({
    name: t.name,
    params: new Set(Object.keys(t.inputSchema?.properties ?? {})),
  }));
} finally {
  server.child.kill();
}
if (tools.length < 50) {
  problems.push(`only ${tools.length} tools listed on the \`full\` profile - this guard is looking at the wrong thing`);
}

/** Tools declaring a given parameter at the top level of their inputSchema. */
const declaring = (param) => tools.filter((t) => t.params.has(param));

for (const { odd, common } of SYNONYMS) {
  const oddTools = declaring(odd);
  const commonTools = declaring(common);

  // The table says which spelling is the common one. Check that, rather than trust it.
  if (commonTools.length <= oddTools.length) {
    problems.push(
      `SYNONYMS says "${common}" is the common spelling and "${odd}" the odd one, but ${common} is used by ` +
        `${commonTools.length} tool(s) and ${odd} by ${oddTools.length}. Fix the table before trusting it.`
    );
    continue;
  }

  /**
   * A tool that names several things cannot be told to accept a parameter called `name`.
   *
   * unreal_add_node takes eventName, axisName, functionName, variableName, macroName AND graphName.
   * Adding `name` there does not remove a guess, it adds one - the caller now has to work out which
   * of six things the generic word refers to, and any answer the server picks will be wrong for
   * somebody. unreal_rename_function is the same trap in miniature: `name` sitting beside `newName`
   * reads as the new name at least as easily as the old one.
   *
   * The rule is derived rather than a list of tools, so it keeps holding as the surface changes:
   * two or more `*Name` parameters means no single referent, and the alias requirement does not
   * apply. Applied to `functionName` -> `name` it exempts exactly three tools and leaves one real
   * gap, which was the point of asking.
   */
  const ambiguous = (t) => [...t.params].filter((p) => /Name$/.test(p)).length > 1;

  // "Accepts the common one too" is now the same question a model asks: is it in the schema?
  const deaf = oddTools.filter((t) => !t.params.has(common) && !ambiguous(t));
  const exempt = oddTools.filter((t) => !t.params.has(common) && ambiguous(t));
  if (exempt.length > 0) {
    exemptions.push(...exempt.map((t) => `${t.name} (${odd}: names more than one thing)`));
  }
  if (deaf.length > 0) {
    problems.push(
      `${deaf.length} tool(s) take "${odd}" where ${commonTools.length} others take "${common}", and do not ` +
        `accept "${common}" as well:\n` +
        deaf.map((t) => `    - ${t.name}`).join("\n") +
        `\n  A model that has read the other ${commonTools.length} will type "${common}" here and pay a failed\n` +
        `  call to learn a synonym. Accept both and pick whichever is set.`
    );
  }
}

// --- the half that finds pairs instead of being told them ----------------------------------------
//
// Every top-level parameter on every tool, grouped by the concept it names. Two spellings land in
// the same group when they differ only by a `Name`/`Path`/`Id` suffix, which is the exact shape of
// every miss recorded at the top of this file: variable/variableName, function/functionName,
// functionName/name, event/eventName.
//
// This does not attempt semantic synonyms with different words - target vs actor, from vs source.
// It could not judge those without knowing what the tools mean, and a guard that guesses at meaning
// is one that eventually argues for a wrong rename. Narrow and reliable beats broad and arguable.
const conceptOf = (param) => param.replace(/(Name|Path|Id)$/, "").toLowerCase();

const spellingsByConcept = new Map();
for (const tool of tools) {
  for (const param of tool.params) {
    const concept = conceptOf(param);
    if (!concept) continue;
    if (!spellingsByConcept.has(concept)) spellingsByConcept.set(concept, new Set());
    spellingsByConcept.get(concept).add(param);
  }
}

const covered = (spellings) =>
  SYNONYMS.some((s) => spellings.has(s.odd) && spellings.has(s.common)) ;

const split = [...spellingsByConcept].filter(([, spellings]) => spellings.size > 1);
const unexamined = split.filter(
  ([concept, spellings]) => !covered(spellings) && !WAIVED.some((w) => w.concept === concept)
);

if (unexamined.length > 0) {
  problems.push(
    `${unexamined.length} concept(s) are spelled more than one way across the tool surface, and ` +
      `neither SYNONYMS nor WAIVED mentions them:\n` +
      unexamined
        .map(([concept, spellings]) => {
          const counts = [...spellings]
            .map((s) => `${s} (${declaring(s).length} tool${declaring(s).length === 1 ? "" : "s"})`)
            .join(", ");
          return `    - ${concept}: ${counts}`;
        })
        .join("\n") +
      `\n  A model that learned one spelling will type it at the tool using the other and pay a\n` +
      `  failed call. Alias the minority spelling and add it to SYNONYMS, or - if there is no\n` +
      `  majority to appeal to - waive it in WAIVED with the reason. Both answers are fine; the\n` +
      `  one thing this refuses is the pair nobody has looked at.`
  );
}

// A waiver for a concept that is no longer split is a note about a problem that went away, and it
// makes the list look better-considered than it is.
const stale = WAIVED.filter((w) => !split.some(([concept]) => concept === w.concept));
if (stale.length > 0) {
  problems.push(
    `${stale.length} WAIVED entr(y/ies) name a concept that is no longer spelled two ways: ` +
      stale.map((w) => w.concept).join(", ") +
      `. Remove them - a waiver watching nothing reads as a decision that is still load-bearing.`
  );
}

if (problems.length > 0) {
  console.error("\nparameter name check FAILED:\n");
  for (const problem of problems) console.error(`  - ${problem}\n`);
  process.exit(1);
}

// Said precisely, because the two numbers count different things and a line where they do not add up
// reads as a guard that has not thought about its own scope - which is the failure this whole session
// kept finding in other guards.
//
// SYNONYMS holds pairs; `split` holds concepts spelled more than one way. They overlap but are not
// the same set: `functionName` -> `name` is an enforced pair whose two spellings normalise to
// DIFFERENT concepts, so it is a pair without being a split.
const aliasedSplits = split.filter(([, spellings]) => covered(spellings)).length;
console.log(
  `parameter names ok: ${tools.length} tools, ${spellingsByConcept.size} concepts, ` +
    `${split.length} spelled more than one way (${aliasedSplits} aliased, ${WAIVED.length} waived with a reason); ` +
    `${SYNONYMS.length} synonym pairs enforced` +
    (exemptions.length > 0
      ? `, ${exemptions.length} tool(s) exempt for naming more than one thing: ${exemptions.join(", ")}`
      : "")
);
