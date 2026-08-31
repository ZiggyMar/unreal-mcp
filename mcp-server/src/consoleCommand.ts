/**
 * The console, reported honestly.
 *
 * The bridge does the running; this decides what the reply says about it. There is only one
 * interesting decision, and it is the one the console itself gets wrong: a misspelled command does
 * nothing, prints nothing, and changes nothing. `stat untis` looks exactly like `stat units` that
 * happened to have no visible effect. A tool that returned an empty reply for both would leave a
 * model concluding the engine ignored a working command, and the next several calls would be spent
 * investigating a game that is fine.
 *
 * So `recognised: false` gets a next step naming the call that lists what does exist, and the
 * successful case stays as small as possible - most of the time the answer is the log, and there is
 * nothing to add to it.
 */

export interface ConsoleReply {
  world?: string;
  recognised?: boolean;
  output?: string;
  log?: string[];
  logLinesTotal?: number;
  error?: string;
  detail?: string;
}

export interface ConsoleReport extends ConsoleReply {
  next?: string;
}

export function describeConsoleResult(command: string, reply: ConsoleReply): ConsoleReport {
  // An error from the bridge already explains itself - a refusal says why it was refused, a missing
  // world says how to get one. Adding a second sentence on top would be noise.
  if (reply.error) return reply;

  if (reply.recognised === false) {
    const verb = command.trim().split(/\s+/)[0] ?? command;
    return {
      ...reply,
      next:
        `"${verb}" is not a command the engine knows, so nothing ran and nothing changed - this is ` +
        `not a command that ran and did nothing. ` +
        `Run \`DumpConsoleCommands ${verb.slice(0, 4)}\` to see what does exist with that prefix, ` +
        `or check whether it needs the running game rather than the editor.`,
    };
  }

  // Ran, and said nothing anywhere. That is normal and common - most cvars are silent - but it is
  // worth one line, because "it worked" and "it produced no evidence that it worked" are different
  // and only the second one is known here.
  if (!reply.output && (reply.log ?? []).length === 0) {
    return {
      ...reply,
      next:
        "The engine accepted the command and neither returned nor logged anything, which is normal " +
        "for cvars and most setters. Nothing here confirms an effect - read the value back, or " +
        "observe the thing it was meant to change.",
    };
  }

  return reply;
}
