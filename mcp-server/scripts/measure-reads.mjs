#!/usr/bin/env node
// Measure what the READ tools cost against a real project, and refuse the ones that are absurd.
//
// check-replies budgets the tools that need no editor. This is the other half, and it exists because
// the half it covers is where the money actually was: read_blueprint_summary on a real 807-node
// EventGraph returned 126,477 tokens - 63% of a 200k context window, in one call, from a project
// whose stated premise is that a model never receives a raw engine dump. list_blueprints was 15,149,
// explain_graph 13,294. None of it was visible from the code; all of it was obvious in one sweep.
//
// That sweep was done by hand once. Nobody will do it by hand again, which is why it is a script.
//
// The ceilings here are deliberately loose and absolute rather than tight and project-specific. A
// reply's size depends on somebody's project, so a tight number would fail on every machine but the
// one it was recorded on and would be deleted within a week. What a loose absolute ceiling catches
// is the class of bug that matters: a read with no bound at all, which grows until it eats a context
// window. Nothing legitimate returns 25k tokens from one call.
//
// Usage: node scripts/measure-reads.mjs [--json]   (needs an editor open on a real project)

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
// For reading the server's OWN advertised text, so the numbers it quotes are checked against
// the sentences a model actually receives rather than against a copy kept in this file.
import { startAndInitialize, listTools } from "./lib/mcpStdio.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, "..", "dist", "index.js");
const NEWLINE = String.fromCharCode(10);

/** No single read should ever cost this much. It is not a budget, it is a smoke alarm. */
const ABSURD = 25_000;

let nextId = 10;

function session(calls) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], {
      env: { ...process.env, UNREAL_MCP_PROFILE: "full" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    let initialised = false;
    let index = 0;
    const out = [];
    let settled = false;

    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      child.kill();
      fn(v);
    };
    const timer = setTimeout(() => done(reject, new Error("editor did not answer in 10 minutes")), 600_000);

    const fire = () => {
      const c = calls[index];
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: 1000 + index, method: "tools/call", params: { name: c.tool, arguments: c.args } }) +
          NEWLINE
      );
    };

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let at;
      while ((at = buffer.indexOf(NEWLINE)) >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (!initialised) {
          initialised = true;
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + NEWLINE);
          fire();
          continue;
        }
        if (msg.id === 1000 + index) {
          const text = ((msg.result && msg.result.content) || []).map((c) => c.text || "").join("");
          out.push({ ...calls[index], text });
          index += 1;
          if (index >= calls.length) {
            clearTimeout(timer);
            done(resolve, out);
          } else {
            fire();
          }
        }
      }
    });
    child.on("error", (err) => done(reject, err));
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "reads", version: "1" } },
      }) + NEWLINE
    );
  });
}

const tokensOf = (t) => Math.round(t.length / 4);

// Find the biggest Blueprint in the project to measure against, rather than a name hardcoded to one
// machine. The worst case is the only case worth measuring: a small graph tells you nothing.
const [listed] = await session([{ tool: "unreal_list_blueprints", args: { maxResults: 5000 } }]);
let blueprints = [];
try {
  blueprints = JSON.parse(listed.text).blueprints ?? [];
} catch {
  console.error("could not read the Blueprint list - is an editor open with a project loaded?");
  process.exit(2);
}
if (blueprints.length === 0) {
  console.error("no Blueprints in the open project, so there is nothing to measure.");
  process.exit(2);
}

const graphCounts = await session(
  blueprints.slice(0, 40).map((b) => ({ tool: "unreal_list_blueprint_graphs", args: { path: b.path } }))
);
let biggest = { path: blueprints[0].path, graphName: "EventGraph", nodes: 0 };

// A second, SMALLER graph, and the reason is that one claim cannot be checked without it.
//
// unreal_explain_graph's description compares itself against the structural read: "a 59-node
// EventGraph costs 2,328 tokens as a node-and-pin structure and 268 here". That comparison is only
// honest below the structural read's 60-node cap. Above it, read_blueprint_summary returns 60 nodes
// of 819 while explain_graph returns all 819, so the "cheaper" read is the one that answered a
// fraction of the question - and checking the claim against the biggest graph in the project
// reported explain_graph as 740% over its quote, comparing a whole-graph explanation with a
// truncated structure.
//
// So the largest graph that still fits under the cap: big enough to be worth measuring, small
// enough that both reads describe the same thing.
const STRUCTURAL_NODE_CAP = 60;
let comparable = null;

for (const r of graphCounts) {
  try {
    const parsed = JSON.parse(r.text);
    for (const g of parsed.graphs ?? []) {
      const nodes = g.nodeCount ?? 0;
      if (nodes > biggest.nodes) {
        biggest = { path: parsed.path, graphName: g.name, nodes };
      }
      if (nodes <= STRUCTURAL_NODE_CAP && nodes > (comparable?.nodes ?? 0)) {
        comparable = { path: parsed.path, graphName: g.name, nodes };
      }
    }
  } catch {
    /* a Blueprint that will not list its graphs is not the one we are measuring */
  }
}

// And the biggest Data Table, discovered the same way and for the same reason. Hardcoding a name
// would measure one machine's project; picking the first would measure whichever happened to sort
// first, which on this project is a five-row table and tells you nothing.
const [tableList] = await session([
  { tool: "unreal_list_assets", args: { className: "DataTable", maxResults: 40 } },
]);
let BIGGEST_DATA_TABLE = null;
try {
  const tables = JSON.parse(tableList.text).assets ?? [];
  const reads = await session(
    tables.map((t) => ({ tool: "unreal_list_data_table_rows", args: { path: t.path } }))
  );
  let worst = 0;
  reads.forEach((r, i) => {
    if (r.text.length > worst) {
      worst = r.text.length;
      BIGGEST_DATA_TABLE = tables[i].path;
    }
  });
} catch (err) {
  // Silence here once hid the whole measurement: the table was never found and the read simply did
  // not appear in the table of results, which reads exactly like "there are no Data Tables".
  console.error(`could not pick a Data Table to measure: ${err.message}`);
}

console.log(`measuring reads against ${biggest.path}`);
console.log(`worst graph found: ${biggest.graphName}, ${biggest.nodes} nodes`);
if (comparable) {
  console.log(
    `comparable graph (under the ${STRUCTURAL_NODE_CAP}-node structural cap): ` +
      `${comparable.path.split("/").pop()} ${comparable.graphName}, ${comparable.nodes} nodes`
  );
}
console.log("");

// The largest Data Asset in the project, picked the same way the Data Table is: measuring the
// generic reader against a trivial asset would report a number nobody pays.
let BIGGEST_DATA_ASSET = null;
try {
  const [assets] = await session([{ tool: "unreal_list_assets", args: { className: "DataAsset", maxResults: 60 } }]);
  const paths = (JSON.parse(assets.text).assets ?? [])
    .map((a) => (typeof a === "string" ? a : a.path))
    .filter(Boolean);
  const sized = await session(paths.map((p) => ({ tool: "unreal_read_asset_properties", args: { path: p } })));
  let best = -1;
  sized.forEach((r, i) => {
    if (r.text.length > best) {
      best = r.text.length;
      BIGGEST_DATA_ASSET = paths[i];
    }
  });
} catch (err) {
  console.error(`could not pick a Data Asset to measure: ${err.message}`);
}

const COMPARABLE_CASES = comparable
  ? [
      {
        label: "structure (comparable)",
        tool: "unreal_read_blueprint_summary",
        args: { path: comparable.path, graphName: comparable.graphName },
        mustContain: "nodes",
      },
      {
        label: "explain_graph (comparable)",
        tool: "unreal_explain_graph",
        args: { path: comparable.path, graphName: comparable.graphName },
        mustContain: "text",
      },
    ]
  : [];

const CASES = [
  { label: "get_project_overview", tool: "unreal_get_project_overview", args: {}, mustContain: "{" },
  { label: "list_blueprints", tool: "unreal_list_blueprints", args: {}, mustContain: "blueprints" },
  { label: "list_blueprint_graphs", tool: "unreal_list_blueprint_graphs", args: { path: biggest.path }, mustContain: "graphs" },
  {
    label: "read_blueprint_summary",
    tool: "unreal_read_blueprint_summary",
    args: { path: biggest.path, graphName: biggest.graphName },
    mustContain: "nodes",
  },
  {
    label: "explain_graph",
    tool: "unreal_explain_graph",
    args: { path: biggest.path, graphName: biggest.graphName },
    mustContain: "text",
  },
  { label: "list_variables", tool: "unreal_list_variables", args: { path: biggest.path }, mustContain: "variables" },
  // Added after the feature trial showed the two C++ reads were 36% of its whole cost - 1,393 of
  // 3,900 tokens - while being the only expensive reads not watched here. Exactly the gap that let
  // find_references sit at 3,736 tokens unnoticed: a guard covering seven of nine reads is watching
  // the wrong thing on the other two.
  // The largest read in the whole surface, and it was not watched. DT_UniversalActions returned
  // 26,993 characters for NINE rows - more than read_blueprint_summary on an 809-node graph - because
  // Unreal exports every field of every row whether anybody set it or not.
  ...(BIGGEST_DATA_TABLE
    ? [{ label: "list_data_table_rows", tool: "unreal_list_data_table_rows", args: { path: BIGGEST_DATA_TABLE }, mustContain: "rows" }]
    : []),
  // 16,129 characters on BP_Player, second only to the Data Table read, and also unwatched. 167
  // editable properties, of which the Blueprint changed a fraction.
  { label: "read_class_defaults", tool: "unreal_read_class_defaults", args: { path: biggest.path }, mustContain: "class" },
  { label: "find_source (modules)", tool: "unreal_find_source", args: {}, mustContain: "modules" },
  { label: "find_source (symbol)", tool: "unreal_find_source", args: { symbol: "AActor" }, mustContain: "matches" },
  { label: "list_actors", tool: "unreal_list_actors", args: {}, mustContain: "actors" },
  { label: "project_health", tool: "unreal_project_health", args: {}, mustContain: "{" },
  // Added after it turned out to be the most expensive read in the whole surface and the only one
  // nobody was measuring: 3,736 tokens on a real Blueprint, larger than list_blueprints. A guard
  // that watches seven of eight expensive reads watches the wrong thing on the eighth.
  {
    label: "find_references",
    tool: "unreal_find_references",
    args: { path: biggest.path },
    mustContain: "referencedBy",
  },
  // The fourth time an unwatched read has turned out to be the most expensive thing on the surface,
  // after find_references, find_source and list_data_table_rows. 7,562 tokens on BP_Player - more
  // than the Data Table read - because it reported all 60 graphs when 13 had anything to say, and it
  // is the tool a model reaches for first when asked "what is wrong with this Blueprint".
  //
  // The pattern is now unmistakable and worth naming: the reads nobody measures are the composite
  // ones. Every single-bridge-call read was in this list from the start; every tool that loops over
  // graphs or rows arrived late, after a real question made its cost visible. A composite read is
  // exactly where cost hides, because no one call inside it looks expensive.
  // The generic property reader - Data Assets, Curves, Sound Classes, anything that is a bag of
  // settings - and the only read here that is not about a Blueprint or a table. Unwatched until now,
  // which is the pattern this file keeps rediscovering: every single-bridge-call read was measured
  // from the start, and the ones that arrived later arrived unmeasured.
  ...(BIGGEST_DATA_ASSET
    ? [{ label: "read_asset_properties", tool: "unreal_read_asset_properties", args: { path: BIGGEST_DATA_ASSET }, mustContain: "properties" }]
    : []),
  {
    label: "review_blueprint",
    tool: "unreal_review_blueprint",
    args: { path: biggest.path },
    mustContain: "score",
  },
];

// The numbers this server QUOTES have to match the numbers it measures.
//
// The standing instructions - the text every model reads before its first call - carried
// "the difference is 4,685 tokens against 292, not a trim". Every figure in that sentence, and three
// more like it in the tool descriptions, had gone stale: the real numbers were 3,237 and 218, about
// 30% out. They drifted DOWNWARD, because compact JSON, float trimming and deduplicated fix text all
// made the reads cheaper, and because `fields` on a Data Table did not exist when the sentence was
// written.
//
// Wrong in the harmless direction is still wrong, and this repo's whole argument rests on its
// measurements being real. A stale number in the one text nobody can skip undermines every other
// number beside it.
//
// So the quotes are checked against this run. The tolerance is wide - these are illustrations, not
// contracts, and a project's own content moves them - but 30% drift fails.
//
// The quotes are READ OUT OF THE SERVER'S OWN TEXT, not copied here.
//
// This table used to hold its own numbers, and that is the same defect it exists to catch: two
// places describing one thing, free to drift apart. It did. `read_class_defaults` was corrected in
// the standing instructions and this table kept failing the run against its stale copy - the guard
// complaining about a number that had already been fixed, which is the failure mode that teaches
// people to ignore a guard.
//
// So each entry carries a PATTERN instead of a number, matched against the text the server actually
// advertises: the `instructions` from initialize, plus every tool description. If the pattern stops
// matching, that is a failure too - a sentence that has been reworded is a sentence whose number is
// no longer being checked, and silently passing would make this vacuous.
const CORPUS_CLAIMS = [
  {
    label: "read_class_defaults",
    // "the difference is 1,691 tokens against 218, not a trim."
    pattern: /the difference is ([\d,]+) tokens against ([\d,]+)/,
    where: "the HOW TO WORK instructions",
  },
  {
    // Measured on the comparable graph, not the biggest one - see STRUCTURAL_NODE_CAP above.
    // The sentence quotes a PAIR, so both halves are checked: a structural cost that drifts while
    // the explanation holds still would leave the ratio - which is the actual claim - wrong.
    label: "explain_graph (comparable)",
    alsoLabel: "structure (comparable)",
    // "A 59-node EventGraph costs 2,328 tokens as a node-and-pin structure and 268 here"
    pattern: /costs ([\d,]+) tokens as a node-and-pin structure and ([\d,]+) here/,
    where: "the unreal_explain_graph description",
    capture: 2,
    alsoCapture: 1,
  },
];

// Numbers that live only in source comments. Still worth measuring - a comment that lies costs the
// next reader an afternoon - but they are NOT what a model reads, and saying they were was itself
// an inaccuracy in this file. Kept honest and kept separate.
const COMMENT_QUOTES = [
  { label: "list_variables", quoted: 1732, where: "comments in compactRows.ts and index.ts" },
  { label: "list_data_table_rows", quoted: 1723, where: "comments in index.ts" },
];
const TOLERANCE = 0.15;

const results = (await session([...CASES, ...COMPARABLE_CASES])).map((r) => ({ ...r, tokens: tokensOf(r.text) }));

// A reply that is an error is not a cheap reply, it is a broken measurement. This check exists
// because the sibling script once reported two cases comfortably under budget at eleven tokens,
// having faithfully measured the size of "Tool disabled".
const broken = results.filter((r) => r.mustContain && !r.text.includes(r.mustContain));
if (broken.length > 0) {
  for (const b of broken) {
    console.error(`${b.label}: reply does not contain ${JSON.stringify(b.mustContain)} - measured nothing useful.`);
    console.error(`  began: ${b.text.slice(0, 160)}`);
  }
  process.exit(1);
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(results.map(({ label, tokens }) => ({ label, tokens })), null, 2));
} else {
  console.log(`  ${"read".padEnd(26)}${"~tokens".padStart(9)}`);
  console.log(`  ${"-".repeat(26)}${"-".repeat(9)}`);
  for (const r of results) {
    console.log(`  ${r.label.padEnd(26)}${String(r.tokens).padStart(9)}  ${r.tokens > ABSURD ? "ABSURD" : ""}`);
  }
}

const absurd = results.filter((r) => r.tokens > ABSURD);
if (absurd.length > 0) {
  console.log("");
  console.log(`unbounded read(s) (${absurd.length}):`);
  for (const r of absurd) {
    console.log(`  - ${r.label} returned ~${r.tokens} tokens in one call.`);
  }
  console.log("");
  console.log(`  Nothing legitimate costs ${ABSURD}+ tokens per call: that is a context window, not a`);
  console.log(`  reply. Give the tool a cap and a way to ask a narrower question - a \`match\` filter is`);
  console.log(`  usually worth more than a cap, because the caller rarely wanted everything.`);
  process.exit(1);
}

console.log("");
// Compared after the table, so the measured numbers are on screen next to any complaint.
const drifted = [];

const check = (label, where, quoted, measuredTokens) => {
  const off = Math.abs(measuredTokens - quoted) / Math.max(quoted, 1);
  if (off > TOLERANCE) {
    drifted.push(
      `${label} is quoted as ~${quoted} tokens in ${where}, and measures ${measuredTokens} ` +
        `(${Math.round(off * 100)}% out). Update the quote, or explain why the project moved.`
    );
  }
};

// What the server tells a model, fetched the way a client gets it.
const corpusServer = await startAndInitialize({ MCP_PROFILE: "full" }, "measure-reads-corpus");
const { tools: corpusTools } = await listTools(corpusServer);
const corpus = `${corpusServer.instructions ?? ""}\n${corpusTools.map((t) => t.description ?? "").join("\n")}`;

for (const claim of CORPUS_CLAIMS) {
  const measured = results.find((r) => r.label === claim.label);
  if (!measured) {
    drifted.push(`${claim.label} is quoted in ${claim.where} but is not measured here any more`);
    continue;
  }
  const found = claim.pattern.exec(corpus);
  if (!found) {
    drifted.push(
      `${claim.label}: the sentence in ${claim.where} no longer matches the pattern this guards, so ` +
        `its number is not being checked at all. Re-point the pattern at the reworded sentence.`
    );
    continue;
  }
  const quoted = Number(found[claim.capture ?? 1].replace(/,/g, ""));
  check(claim.label, claim.where, quoted, measured.tokens);

  if (claim.alsoLabel) {
    const other = results.find((r) => r.label === claim.alsoLabel);
    const otherQuoted = Number(found[claim.alsoCapture ?? 1].replace(/,/g, ""));
    if (other) check(claim.alsoLabel, claim.where, otherQuoted, other.tokens);
  }
}
corpusServer.child.kill();

for (const q of COMMENT_QUOTES) {
  const measured = results.find((r) => r.label === q.label);
  if (!measured) {
    drifted.push(`${q.label} is quoted in ${q.where} but is not measured here any more`);
    continue;
  }
  check(q.label, q.where, q.quoted, measured.tokens);
}
if (drifted.length > 0) {
  console.error("");
  console.error("quoted numbers have drifted from what this run measured:");
  for (const line of drifted) console.error(`  - ${line}`);
  console.error("");
  console.error("The first group appears in the standing instructions and tool descriptions, which is the");
  console.error("one text a model cannot skip. A number that is wrong there undermines every number beside");
  console.error("it. The second group is source comments, which cost the next reader rather than the model.");
  process.exitCode = 1;
}

console.log(`reads ok: ${results.length} measured, none above ${ABSURD} tokens`);
