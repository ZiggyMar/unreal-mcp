#!/usr/bin/env node
// Audit the claim that restarting the editor mid-session costs nothing.
//
// Complaint A6 says: the MCP server holds no editor connection between calls, so it cannot go
// stale — restart the editor whenever you like and the next tool call reconnects. Competing
// projects report the opposite (zombie processes to kill by hand, both the editor and the client
// needing a full restart), so this is a real differentiator, and it had never been tested.
//
// The test is the honest one: hold ONE long-lived client, restart the editor underneath it, and
// see whether the next call works without touching the client.
//
// Usage: node scripts/verify-restart.mjs --project <path-to-.uproject> --editor <path-to-UnrealEditor.exe>

import { spawn, execFileSync } from "node:child_process";
import { UnrealBridgeClient } from "../dist/bridgeClient.js";

const args = process.argv.slice(2);
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const projectPath = valueOf("--project");
const editorPath = valueOf("--editor");
if (!projectPath || !editorPath) {
  console.error("usage: node scripts/verify-restart.mjs --project <.uproject> --editor <UnrealEditor.exe>");
  process.exit(2);
}

const PORT = Number(process.env.UNREAL_MCP_BRIDGE_PORT ?? 8765);
// One client for the whole run. If this needed recreating, the claim would be false.
const bridge = new UnrealBridgeClient({ port: PORT });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForBridge(timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await bridge.send("ping", {});
      return r;
    } catch {
      await sleep(3000);
    }
  }
  throw new Error(`the bridge did not come up within ${Math.round(timeoutMs / 1000)}s`);
}

function killEditor() {
  for (const image of ["UnrealEditor.exe", "CrashReportClientEditor.exe"]) {
    try {
      execFileSync("taskkill", ["/F", "/IM", image], { stdio: "ignore" });
    } catch {
      /* not running is fine */
    }
  }
}

function startEditor() {
  const child = spawn(editorPath, [projectPath, "-log"], { detached: true, stdio: "ignore" });
  child.unref();
}

async function main() {
  console.log("auditing A6: does one long-lived client survive an editor restart?");
  console.log("");

  console.log("1. first contact");
  const before = await waitForBridge();
  console.log(`   connected to "${before.project}" (protocol ${before.protocolVersion})`);

  console.log("2. killing the editor underneath the client");
  killEditor();
  await sleep(5000);

  let refusedWhileDown = false;
  try {
    await bridge.send("ping", {});
  } catch (err) {
    refusedWhileDown = true;
    const message = err instanceof Error ? err.message : String(err);
    // The error must also be the diagnostic one, not a raw socket code.
    const explains = message.includes("Unreal Editor is running") || message.includes("connection refused");
    console.log(`   with the editor down, the call fails${explains ? " with the diagnostic checklist" : " (but the message is unhelpful)"}`);
    if (!explains) {
      console.log(`   message was: ${message.slice(0, 160)}`);
    }
  }
  if (!refusedWhileDown) {
    console.log("   UNEXPECTED: a call succeeded while the editor was down");
  }

  console.log("3. restarting the editor");
  startEditor();

  console.log("4. same client, no reconnect logic, no restart of this process");
  const after = await waitForBridge();
  console.log(`   reconnected to "${after.project}" (protocol ${after.protocolVersion})`);

  // A real call, not just a ping: the claim is about tools working, not about liveness.
  const overview = await bridge.send("get_project_overview", {});
  console.log(`   and a real tool call works: ${overview.blueprintCount} Blueprints indexed`);

  console.log("");
  if (after.project === before.project) {
    console.log("A6 HOLDS: one client, editor restarted underneath it, next call reconnected with nothing done to the client.");
    process.exit(0);
  }
  console.log(`A6 QUESTIONABLE: reconnected to a different project ("${before.project}" -> "${after.project}")`);
  process.exit(1);
}

main().catch((err) => {
  console.error(`audit could not run: ${err instanceof Error ? err.message : err}`);
  process.exit(2);
});
