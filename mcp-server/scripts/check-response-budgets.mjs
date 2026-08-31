#!/usr/bin/env node
// Measure what tool REPLIES cost, and refuse to let them creep.
//
// check-tool-parity guards the tool list, check-docs guards the documentation, and
// measure-profiles guards the tool DEFINITIONS - the standing cost paid before a conversation
// starts. Nothing guarded the other half: what a tool costs when it answers.
//
// That gap was not hypothetical. Two things were found the day this script was written, both by
// measuring rather than by reading:
//
//   - unreal_list_tools, the tool whose entire purpose is keeping the surface cheap, answered with
//     every tool at 5,523 tokens. That is more than four times the whole `search` profile it exists
//     to protect. It had grown one tool at a time and nobody re-ran the number.
//   - unreal_enable_tools echoed every enabled tool name back, so enabling ONE tool cost the same
//     700 tokens as enabling thirty-two, and the reply was mostly a repeat of the tools/list the
//     client had just been told about.
//
// Both are the same failure: a reply that grows with the project while the number that would have
// exposed it lives in a document nobody re-measures. This makes it fail the build instead.
//
// Only editor-free tools are covered, deliberately. Anything that reads a real project produces a
// reply whose size depends on the project, so a fixed ceiling would be meaningless and would fail
// on somebody else's machine. Those are measured against a live editor by measure-cost.mjs.
//
// Usage: node scripts/check-response-budgets.mjs [--json]

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, "..", "dist", "index.js");
const NEWLINE = String.fromCharCode(10);

// Ceilings, each with the reason it is where it is. These are budgets argued for, not observations
// rounded up: raising one should be a decision somebody makes on purpose.
const CASES = [
  {
    label: "list_tools (no filter)",
    tool: "unreal_list_tools",
    args: {},
    mustContain: "groups",
    ceiling: 700,
    why: "the first call of every session on `search`; it must cost less than the profile it protects",
  },
  {
    label: "list_tools match",
    tool: "unreal_list_tools",
    args: { match: "data table" },
    mustContain: "unreal_",
    ceiling: 500,
    why: "a narrow search should answer narrowly",
  },
  {
    label: "list_tools all:true",
    tool: "unreal_list_tools",
    args: { all: true },
    mustContain: "unreal_build_graph",
    ceiling: 9000,
    why: "the deliberate everything-at-once case; generous, but not unbounded as it was",
  },
  {
    label: "enable_tools core",
    tool: "unreal_enable_tools",
    args: { groups: ["core"] },
    mustContain: "newlyEnabled",
    ceiling: 600,
    why: "the caller wants to know what was switched on, not a copy of tools/list",
  },
  {
    label: "enable_tools one tool",
    tool: "unreal_enable_tools",
    // Deliberately a tool that does not author graphs.
    //
    // This used to enable unreal_build_graph and started failing at 334 tokens, which was the
    // one-time GROUND TRUTH payload landing in a budget written for the repeated case. Two
    // different things were sharing one ceiling: the reply you get on every enable, and the reply
    // you get once when authoring switches on. They are budgeted separately now rather than by
    // raising a number until the check went quiet.
    args: { tools: ["unreal_compile_cpp"] },
    mustContain: "unreal_compile_cpp",
    ceiling: 200,
    why: "enabling one tool must not cost what enabling thirty-two does - it used to",
  },
  {
    label: "enable_tools first authoring enable",
    tool: "unreal_enable_tools",
    args: { tools: ["unreal_build_graph"] },
    mustContain: "unreal_build_graph",
    ceiling: 450,
    why:
      "once per session, this reply carries the exact pin-name strings that `search` no longer " +
      "keeps in standing text. It is bigger than an ordinary enable ON PURPOSE and must stay a " +
      "one-off: 284 tokens once, against 284 on every turn of the session",
  },
  {
    label: "guide index",
    tool: "unreal_guide",
    args: { topic: "handbook" },
    // unreal_guide is in `core`, not the four-tool `search` spine, so it has to be switched on
    // before it can be called. Without this the call fails and the reply is an eleven-token error,
    // which sails under every ceiling - the first version of this script "passed" exactly that way.
    enableFirst: { tools: ["unreal_guide"] },
    mustContain: "sections",
    ceiling: 600,
    why: "the section index is the cheap way to find one fact; inlining the handbook is not",
  },
  {
    label: "guide section",
    tool: "unreal_guide",
    args: { topic: "handbook", section: "then_0" },
    enableFirst: { tools: ["unreal_guide"] },
    mustContain: "then_0",
    ceiling: 2000,
    why: "one section of prose, not the document",
  },
  {
    label: "doctor, no editor",
    tool: "unreal_doctor",
    args: {},
    mustContain: "bridge reachable",
    ceiling: 1200,
    why: "run when nothing works, so it must stay readable rather than becoming another problem",
  },
];

/** Tokens estimated from characters, the same 4-chars-per-token rule measure-profiles uses. */
const tokensOf = (text) => Math.round(text.length / 4);

function callTool(tool, args, enableFirst) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], {
      // `search` is what --print-config emits, so it is the configuration real users run.
      env: { ...process.env, UNREAL_MCP_PROFILE: "search" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    let initialised = false;
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      child.kill();
      fn(value);
    };

    const timer = setTimeout(() => finish(reject, new Error(`${tool} did not answer in 30s`)), 30_000);

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let index;
      while ((index = buffer.indexOf(NEWLINE)) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        const callTheTool = () =>
          child.stdin.write(
            JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } }) +
              NEWLINE
          );

        if (!initialised) {
          initialised = true;
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + NEWLINE);
          if (enableFirst) {
            // Sent and WAITED FOR, not fired alongside the call. Writing both at once let the tool
            // call be handled while the enable was still in flight, so the reply was "Tool disabled"
            // - which is how this script first reported an eleven-token pass on a broken case.
            child.stdin.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id: 9,
                method: "tools/call",
                params: { name: "unreal_enable_tools", arguments: enableFirst },
              }) + NEWLINE
            );
          } else {
            callTheTool();
          }
          continue;
        }
        if (message.id === 9) {
          callTheTool();
          continue;
        }
        if (message.id === 2) {
          clearTimeout(timer);
          const text = ((message.result && message.result.content) || []).map((c) => c.text || "").join("");
          finish(resolve, text);
        }
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      finish(reject, err);
    });

    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "budget", version: "1" } },
      }) + NEWLINE
    );
  });
}

const results = [];
for (const testCase of CASES) {
  const text = await callTool(testCase.tool, testCase.args, testCase.enableFirst);
  // A budget that passes on an error message measures nothing. The first version of this script did
  // exactly that for two cases, and reported them comfortably under budget at eleven tokens.
  if (testCase.mustContain && !text.includes(testCase.mustContain)) {
    console.error(
      `${testCase.label}: the reply does not contain ${JSON.stringify(testCase.mustContain)}, so the ` +
        `call did not do what this case measures. Reply began: ${text.slice(0, 200)}`
    );
    process.exit(1);
  }
  results.push({ ...testCase, tokens: tokensOf(text), chars: text.length });
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log("Tool reply cost (estimated at 4 chars/token):");
  console.log("");
  console.log(`  ${"case".padEnd(24)}${"~tokens".padStart(9)}${"ceiling".padStart(10)}`);
  console.log(`  ${"-".repeat(24)}${"-".repeat(9)}${"-".repeat(10)}`);
  for (const r of results) {
    const over = r.tokens > r.ceiling;
    console.log(
      `  ${r.label.padEnd(24)}${String(r.tokens).padStart(9)}${String(r.ceiling).padStart(10)}  ${over ? "OVER" : "ok"}`
    );
  }
}

const over = results.filter((r) => r.tokens > r.ceiling);
if (over.length > 0) {
  console.log("");
  console.log(`reply budget exceeded (${over.length}):`);
  for (const r of over) {
    console.log(`  - ${r.label} is ~${r.tokens} tokens, over its ${r.ceiling} ceiling.`);
    console.log(`    That ceiling exists because: ${r.why}.`);
    console.log(`    Trim what the reply repeats, or argue for a higher ceiling here - but do not`);
    console.log(`    raise it silently. A reply that grows with the project is how this got missed.`);
  }
  process.exit(1);
}

console.log("");
console.log(`reply budgets ok: ${results.length} cases, all within budget`);
