/**
 * Does a busy game thread still cost the next caller its connection?
 *
 * The bug: Tick adopted queued connections before reaping dead ones, so on the first tick after a
 * block the queue drained oldest-first and every slot went to a client that had already given up.
 * The caller actually waiting was refused with too_many_connections - a second failure, arriving
 * after its cause was already gone.
 *
 * What has to be true for the bug to bite is NOT that the game thread is blocked for a long time.
 * It is that more than MCPMaxClients connections are sitting in PendingClients, already dead, when
 * a tick finally runs. Any command that keeps the game thread busy long enough to accept 48 sockets
 * without ticking will do - and on this bridge that is half a second, not ten.
 *
 * Two earlier versions of this trial passed while proving nothing: one used the wrong request
 * envelope so every command returned "unknown_cmd", and one slept 800ms before opening the sockets,
 * by which time the command it was supposedly racing had already finished. Both "passed". So this
 * version asserts its own precondition directly - the sockets must be opened and abandoned while the
 * heavy command is still in flight - rather than inferring it from elapsed time. A trial that cannot
 * fail is not evidence.
 *
 * Run:  node trial-slotstarve.mjs
 */
import net from "node:net";
import { call } from "./trial-bridge.mjs";

const PORT = 8765;
const HOST = "127.0.0.1";
const CORPSES = 48; // comfortably more than MCPMaxClients (32)
const BIG_BP = "/Game/AntiVirusSquad/_Core/Characters/Players/BP_Player"; // 819 nodes

const bad = (msg) => {
  console.log("\nINVALID - " + msg);
  process.exit(2);
};

// --- precondition 1: we speak the protocol --------------------------------------------------------
const warm = await call("pie_status", {}, 30000);
if (!warm?.ok) bad(`the bridge did not answer a trivial command: ${JSON.stringify(warm)}`);
console.log("protocol ok:", JSON.stringify(warm.result));

// --- occupy the game thread, and race it ----------------------------------------------------------
// compile_blueprint on the project's biggest graph takes ~480ms of game-thread work. That is not a
// long block, and it does not need to be.
console.log(`\ncompiling ${BIG_BP.split("/").pop()} (819 nodes) and racing it...`);
let heavyDone = false;
const t0 = Date.now();
const heavy = call("compile_blueprint", { path: BIG_BP }, 120000).then((r) => {
  heavyDone = true;
  return r;
});

// No sleep. Open and abandon immediately, so they queue behind the command rather than after it.
const socks = [];
for (let i = 0; i < CORPSES; i++) {
  await new Promise((res) => {
    const s = net.connect(PORT, HOST, res);
    s.on("error", res);
    socks.push(s);
  });
}
const openedMs = Date.now() - t0;
for (const s of socks) s.destroy();

// The live caller has to be in the SAME queue drain as the corpses, sitting behind them - that is
// what happened in the incident, and it is the only arrangement the bug can bite. Connecting after
// the game thread frees up is the easy case: by then the reap loop has already run once and cleared
// them, so it would pass on the broken code too and prove nothing.
const racer = call("pie_status", {}, 60000);
const stillBusy = !heavyDone;
console.log(`  ${socks.length} opened in ${openedMs}ms and abandoned, then one live call issued behind them`);
console.log(`  command still in flight when the live call was issued: ${stillBusy}`);

const heavyResult = await heavy;
console.log(`  compile returned after ${Date.now() - t0}ms`);

const racerResult = await racer.catch((e) => ({ ok: false, error: e.message }));
if (/too_many_connections/.test(JSON.stringify(racerResult))) {
  console.log("\n  THE QUEUED LIVE CALL WAS REFUSED - too_many_connections. The starvation bug is PRESENT.");
  process.exit(1);
}
console.log(`  the queued live call was served: ${JSON.stringify(racerResult).slice(0, 80)}`);

// --- precondition 2: the race actually happened ---------------------------------------------------
if (!heavyResult?.ok) bad(`the heavy command failed, so nothing was occupied: ${JSON.stringify(heavyResult).slice(0, 200)}`);
if (!stillBusy)
  bad(`the ${CORPSES} connections finished opening after the command had already returned - they never queued behind it`);

// --- the actual test ------------------------------------------------------------------------------
console.log("\nfirst call once the game thread is free:");
const after = await call("pie_status", {}, 30000);
if (/too_many_connections/.test(JSON.stringify(after))) {
  console.log("  REFUSED - too_many_connections. The starvation bug is PRESENT.");
  process.exit(1);
}
console.log("  OK - answered normally.");

for (let i = 0; i < 3; i++) {
  const r = await call("pie_status", {}, 30000);
  if (/too_many_connections/.test(JSON.stringify(r))) {
    console.log(`  follow-up ${i + 1} REFUSED`);
    process.exit(1);
  }
}
console.log("  three follow-ups OK");
console.log(
  `\nPASS - ${CORPSES} connections were queued and abandoned while the game thread was busy, and the live caller was still served.`
);
