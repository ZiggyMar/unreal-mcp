// Every bridge command that only looks at things must be classified as a read.
//
// `isWrite` is the negation of READ_ONLY_COMMANDS, which makes it a denylist: a command missing from
// that set is a write by default. Fifteen reads had drifted in that way - describe_class,
// list_variables, read_class_defaults and twelve more - all added to the bridge after the set was
// written. unreal_session_changes, the tool whose whole job is answering "what did I change this
// session", reported 359 writes across 190 assets after a session that made none.
//
// A list that has to be updated by hand every time the bridge grows will drift again. This is the
// thing that notices. It reads the bridge's own dispatch chain, so a command cannot exist without
// being considered here.
//
// The rule is naming, and it is checked in one direction only. A command called read_*, list_*,
// find_*, describe_*, get_* or search_* has told you what it does, and every one of the 29 that
// currently match was confirmed against its C++ handler to touch nothing. The other direction is NOT
// asserted: plenty of pure reads are named otherwise - ping, pie_status, project_health,
// trace_variable - and demanding they be listed would fail for commands that are correctly
// classified. Those are added by hand after reading the handler, which is the slow half on purpose.
//
// The asymmetry is deliberate. A read filed as a write is noise in a log. A write filed as a read
// disappears from the journal completely, and the journal is what the undo advice is built from. So
// this guard only ever pushes commands toward "read" when their own name has already said so.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const handlerPath = join(repoRoot, "UnrealMCPBridge", "Source", "UnrealMCPBridge", "Private", "MCPCommandHandler.cpp");
const journalPath = join(here, "..", "src", "journal.ts");

/** The bridge's own dispatch chain: a command cannot be reached without appearing here. */
const bridgeCommands = [
  ...new Set([...readFileSync(handlerPath, "utf8").matchAll(/Cmd\s*==\s*TEXT\("([a-z0-9_]+)"\)/g)].map((m) => m[1])),
].sort();

const journalSource = readFileSync(journalPath, "utf8");
const setStart = journalSource.indexOf("const READ_ONLY_COMMANDS = new Set([");
if (setStart === -1) {
  console.error("journal check FAILED: could not find READ_ONLY_COMMANDS in journal.ts");
  process.exit(1);
}
const setEnd = journalSource.indexOf("]);", setStart);
const readOnly = new Set(
  [...journalSource.slice(setStart, setEnd).matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1])
);

/** A name that has already announced the command only inspects things. */
const READS_BY_NAME = /^(read|list|find|describe|get|search)_/;

const misfiled = bridgeCommands.filter((cmd) => READS_BY_NAME.test(cmd) && !readOnly.has(cmd));

// A name in the set that the bridge no longer dispatches is dead weight, and worse, it hides the
// fact that the real command is now unclassified under some new name.
const stale = [...readOnly].filter((cmd) => !bridgeCommands.includes(cmd)).sort();

const problems = [];
if (misfiled.length > 0) {
  problems.push(
    `${misfiled.length} read-named command(s) are logged as changes to the project: ${misfiled.join(", ")}.\n` +
      `  Read each handler in MCPCommandHandler.cpp, confirm it touches nothing, then add it to\n` +
      `  READ_ONLY_COMMANDS in src/journal.ts. If one of them DOES write, rename it so its name stops lying.`
  );
}
if (stale.length > 0) {
  problems.push(
    `${stale.length} command(s) in READ_ONLY_COMMANDS are not dispatched by the bridge: ${stale.join(", ")}.\n` +
      `  Either the command was renamed - in which case the new name is currently counted as a write -\n` +
      `  or it was removed and the entry is dead.`
  );
}

if (problems.length > 0) {
  console.error("journal check FAILED");
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}

const readNamed = bridgeCommands.filter((cmd) => READS_BY_NAME.test(cmd)).length;
console.log(
  `journal ok: ${bridgeCommands.length} bridge commands, ${readOnly.size} classified read-only ` +
    `(${readNamed} of them named as reads), none logged as a change it does not make`
);
