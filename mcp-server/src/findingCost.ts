/**
 * What each kind of finding costs you, and therefore what to read first.
 *
 * Lifted out of audit.ts so review_blueprint can use it too. It could not before, because audit
 * imports review and the dependency would have been circular - so the per-Blueprint review sorted by
 * SEVERITY alone and, within "warning", by whatever order the graphs happened to be read in. On
 * BP_Player that put a cost-40 unhandled cast ahead of four cost-55 tick findings, in the one field
 * whose whole job is to say what to do next.
 *
 * The ranking is the entire product of both tools. Having two of them rank differently is worse than
 * either ranking being imperfect.
 */
export const FINDING_COST: Record<string, number> = {
  "cast-to-server-only-class": 100,
  // The same 100, because it is the same defect and it fails just as certainly.
  //
  // A cast to a GameMode fails on every client; a Get of a variable HOLDING one returns null on
  // every client. Nothing about the consequence differs, and the only reason this was not here is
  // that the check looked at Cast nodes and this project caches the reference in a variable
  // instead - ten Blueprints do. Scored lower, it would sort below findings that merely might
  // matter, which is how a defect with runtime proof ends up under a style warning.
  "reads-server-only-variable": 100,
  "server-writes-unreplicated": 100,
  // High, and below the silent-breakage hundreds on purpose. The game still works - it just feels
  // broken to everyone except the listen-server host, who is the authority and never sees it. That
  // asymmetry is what makes it expensive: it survives every test the person most likely to run one
  // can perform.
  "authority-gated-character-movement": 85,
  // A handle, not state. Deliberately far cheaper than the check above, because the commonest case
  // is not a bug at all: an object reference to an Actor that replicates itself. Costing it at 100
  // put correct code at the top of the audit, where a model acts on it first.
  "server-writes-unreplicated-handle": 15,
  // A state nothing leaves freezes the character in one pose for the rest of the round, and the
  // machine looks finished in the editor because the state IS wired - just not outward.
  // Below anim-state-no-exit, which freezes the character outright. A duplicate transition does not
  // break what is there - the first copy still fires - it means a case the author added a
  // transition FOR is not handled, which shows up as "it doesn't switch out of aiming when I jump"
  // rather than as a frozen pose.
  // Low, and info severity, because nothing is broken right now. In this project all four spaced
  // names are self-consistent - the variable, its repNotify field and the handler graph all carry
  // the space - so the binding works. What it costs is the NEXT rename, the next search, and the
  // next person who types the name correctly and finds nothing. A trap, not a fault.
  "name-has-stray-whitespace": 10,
  "anim-duplicate-transition": 45,
  "anim-state-no-exit": 80,
  // A system that can render nothing, spawned by a Blueprint that looks correct.
  // A name typed as text that names nothing. The Blueprint compiles and the call does nothing.
  "row-name-not-in-table": 85,
  "timer-target-missing": 85,
  // A call whose only job is to use an asset, running with that asset pin empty. Priced just under
  // the two above because those are always a defect and this one has a rare honest form: an author
  // who has wired the node and has not yet picked the asset. Everything else about it is the same
  // shape - it compiles, it runs, it reports success, and it does nothing.
  "asset-pin-empty": 80,
  "niagara-system-empty": 60,
  "niagara-all-emitters-disabled": 60,
  // Draws exactly like a working transition and behaves like a wall.
  "anim-transition-never-fires": 70,
  // Costs the most that any of these can cost: the game builds, hosts, searches, reports no error,
  // and the lobby list is empty. It cannot be reproduced on one machine.
  "session-lan-mismatch": 100,
  // Same tier as the casts that only fail on clients, and for the same reason: on a listen server
  // the host IS the server, so it works on the machine the developer is looking at.
  "server-event-touches-widget": 95,
  // The parent's work simply does not happen, on every machine, and nothing warns. The child's own
  // logic still works, which is what makes it survive.
  "parent-event-not-called": 95,
  // Was 90. Not because the check is wrong - an unhandled cast really does stop the chain silently -
  // but because 90 is the band reserved for "this WILL fail", and this check has no evidence of that.
  //
  // To be accurate about what was actually wrong: groups are ordered by cost alone, so 90 placed this
  // fifth overall rather than burying anything. What it did was put an idiom that appears 111 times
  // in a shipping game (measured, on 150 Blueprints, after the filtering ones are excluded)
  // immediately below "this cast fails on every client, every time" and "the parent's setup never
  // runs". A reader working down by severity met sixty-three graphs of mostly-fine casts fifth.
  //
  // The comparison that settles the number: cast-to-server-only-class is the SAME defect shape WITH
  // decisive evidence that it will fail, and it is 100. Without that evidence this is "might stop
  // silently, if it ever fails" - weaker than branch-dead-path (60), which never runs at all, and
  // about the strength of empty-event (40). So 40, beside it.
  "unhandled-cast-failure": 40,
  "level-sweep-every-frame": 85,
  "spawn-every-frame": 85,
  "state-outlives-owner": 80,
  "session-host-paths-disagree": 65,
  "session-host-without-search": 45,
  "cast-every-frame": 70,
  "repnotify-does-nothing": 60,
  // Was branch-dead-path, which never fired - it tested for pins named "true"/"false" and a Branch
  // names them "then"/"else". Renamed rather than repaired, because repairing it as written meant
  // reporting 147 of 254 Branches. This one fires only when a Branch's two arms reach the same node,
  // which is never correct: the condition is computed and discarded, so a guard that was written is
  // not guarding. Runtime-confirmed on BP_FireWall.TakeDamage, 40 null reads a session.
  "branch-decides-nothing": 60,
  "tick-heavy": 55,
  "level-sweep-maybe-repeating": 50,
  // Several Get All Actors Of Class in one graph: each walks the whole level, and if they are
  // looking for the same thing it is one sweep repeated. Priced beside graph-too-large because it is
  // the mildest of the three sweep checks and is reported at "info".
  //
  // It had NO entry until a mutation test found it, which meant `FINDING_COST[check] ?? 1` gave it 1
  // and it sank under every cosmetic finding in the audit. Not a decision anyone made - a name that
  // was never added here, scoring the fallback in silence.
  "level-sweep-repeated": 20,
  "replicated-set-without-server-event": 50,
  // A muted track has keys and does not evaluate. Muting is how you audition a change and it is the
  // state most often left behind afterwards, so this is a real defect rather than a tidy-up - but it
  // is also a legitimate working state, which is why it sits with empty-event rather than above it.
  "sequence-track-muted": 40,
  // In the outliner with an empty timeline. Never evaluates, and a camera cut track in this state is
  // the usual reason a cutscene plays from the wrong angle.
  "sequence-track-no-sections": 35,
  // The actor is bound and nothing animates it. Usually what is left after the tracks were deleted,
  // harmless to run and misleading to read - which is where debug-print-left-in sits.
  "sequence-binding-no-tracks": 25,
  // Between empty-event and repnotify-does-nothing, and the gap is the point. An empty RepNotify is
  // definitely wrong - choosing RepNotify and writing nothing has no reading in which it is intended.
  // An empty function might be a stub somebody means to fill this afternoon, and it only becomes a
  // defect when something calls it, which this check cannot see.
  "empty-function": 50,
  "empty-event": 40,
  "dead-node": 30,
  "debug-print-left-in": 25,
  "graph-too-large": 20,
  "long-exec-chain": 15,
  "placeholder-name": 10,
  "unlabelled-sections": 5,
};
