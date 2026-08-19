import { UnrealBridgeClient } from "./dist/bridgeClient.js";
import { auditProject } from "./dist/audit.js";
const b = new UnrealBridgeClient({ host: "127.0.0.1", port: 8765 });
const t0 = Date.now();
const r = await auditProject(b, { pathPrefix: "/Game", limit: 400, detailedGroups: 3, examplesPerGroup: 6 });
console.log(`scanned ${r.blueprintsScanned} in ${((Date.now()-t0)/1000).toFixed(0)}s`);
for (const g of r.groups.filter(g => /parent-event/.test(g.check))) {
  console.log(`\n[cost ${g.cost}] ${g.check} x${g.count}`);
  for (const e of g.examples) console.log(`   ${e.message}\n`);
}
console.log("top groups:", r.groups.slice(0,6).map(g=>`${g.check}(${g.count})`).join(" "));
