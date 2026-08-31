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
for (const r of graphCounts) {
  try {
    const parsed = JSON.parse(r.text);
    for (const g of parsed.graphs ?? []) {
      if ((g.nodeCount ?? 0) > biggest.nodes) {
        biggest = { path: parsed.path, graphName: g.name, nodes: g.nodeCount };
      }
    }
  } catch {
    /* a Blueprint that will not list its graphs is not the one we are measuring */
  }
}

console.log(`measuring reads against ${biggest.path}`);
console.log(`worst graph found: ${biggest.graphName}, ${biggest.nodes} nodes`);
console.log("");

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
];

const results = (await session(CASES)).map((r) => ({ ...r, tokens: tokensOf(r.text) }));

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
console.log(`reads ok: ${results.length} measured, none above ${ABSURD} tokens`);
