/**
 * Telling "the editor is busy" apart from "the editor is gone".
 *
 * A command that times out gets a long, careful message explaining that the connection is fine and
 * the game thread is busy - a big compile, a level load, a modal dialog someone has to click. That
 * message is right almost every time and it names the dialog by title when it can.
 *
 * It was wrong once, in the way that matters. The editor crashed inside the bridge mid-command; the
 * socket sat open while the process died, the call timed out at sixty seconds, and the reply said
 * the connection was fine and the thread was busy. Every remedy it offered - wait and retry, look
 * for a dialog - was advice about an editor that no longer existed.
 *
 * The test that separates the two costs nothing: try to open a socket. A busy editor still accepts
 * connections, because accepting happens below the game thread. A dead one refuses.
 *
 * Deliberately only consulted AFTER a timeout. Probing before every call would add a connection to
 * every command to answer a question that is almost always "yes".
 */

import { createConnection } from "node:net";

/**
 * Is anything still listening?
 *
 * Resolves true when a connection is accepted, false when it is refused or does not complete in
 * `timeoutMs`. Never throws: this runs while another failure is already being reported, and an
 * exception here would replace a real diagnosis with an unrelated one.
 */
export function portIsAccepting(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (answer: boolean) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
      resolve(answer);
    };

    const socket = createConnection({ host, port });
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => done(true));
    socket.on("error", () => done(false));
    socket.on("timeout", () => done(false));
  });
}

/**
 * What to say when a command timed out and the port has since stopped answering.
 *
 * Separate from the message itself so the wording can be tested without a socket.
 */
export function editorGoneMessage(cmd: string, seconds: string): string {
  return (
    `The UnrealMCPBridge plugin did not answer '${cmd}' within ${seconds}, and the port has stopped ` +
    `accepting connections entirely - so the editor is GONE, not busy. It crashed or was closed ` +
    `while the command was in flight.\n` +
    `  - Nothing about this is worth retrying until the editor is open again.\n` +
    `  - If it crashed, Saved/Logs holds the stack: search the project log for "Critical error". A ` +
    `crash whose stack names UnrealMCPBridge is this tool's fault and worth reporting.\n` +
    `  - unreal_doctor after reopening will say whether the plugin is deep into Live Coding patches, ` +
    `which makes a crash much harder to attribute and is cleared by a rebuild.`
  );
}
