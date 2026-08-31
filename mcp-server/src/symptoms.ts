/**
 * What a person says is wrong, mapped to the tools that find it.
 *
 * The premise of this whole project is that you describe a bug in plain language and the model finds
 * it. The entry point for that is the `search` profile, whose discovery tool is
 * `unreal_list_tools({match})` - and `match` is a substring search over tool NAMES and SUMMARIES.
 * Measured against the words a person actually uses:
 *
 *   match: "upgrade"       0 tools
 *   match: "shop"          0 tools
 *   match: "missing"       0 tools
 *   match: "not showing"   0 tools
 *   match: "bug"           0 tools
 *   match: "empty"         2 tools   (check_data_tables, create_level)
 *   match: "data table"    2 tools
 *   match: "broken"        2 tools   (audit_project, doctor)
 *
 * Only the words a tool AUTHOR would use find anything. "Upgrades aren't showing up in the shop" is
 * a real bug in this project - two Data Table references are empty, which unreal_check_data_tables
 * reports immediately - and every word of that sentence returns nothing.
 *
 * So this is a second index over the same catalogue, keyed on failure vocabulary instead of tool
 * vocabulary. It is consulted only when the literal match finds nothing, because a model that got
 * results already has what it asked for.
 *
 * ## What this is not
 *
 * It is not language understanding, and it must not be described as though it were. It is a keyword
 * table with a curated list of symptom words, and it says so in its own reply - a caller that
 * believes it was understood will trust a wrong answer, while a caller that knows it matched the
 * word "crash" can judge the suggestion for itself.
 *
 * Entries earn their place by naming a tool that specifically finds that class of failure. The
 * temptation is to map everything to search_project, which is true of any symptom and therefore
 * worth nothing.
 *
 * ## Order is the ranking
 *
 * At most two entries answer, taken in the order below, so this list is sorted by how much a match
 * tells you. Descriptions of the FAILURE come before nouns naming the SUBJECT: "enemies don't take
 * damage" matched the `enemy` entry before the `damage` one and led with read_behavior_tree, when
 * the useful answer is trace_variable - the subject being an enemy is the least informative word in
 * that sentence.
 *
 * A sentence matching two entries is usually genuinely ambiguous - "enemies don't take damage" is a
 * fair question about either the AI or the damage number - so both are returned with their reasons
 * and the caller picks. This does not try to disambiguate, because it cannot, and a keyword table
 * that pretended to would be wrong confidently.
 */

export interface SymptomEntry {
  /** Lowercase words and phrases a person might use. Matched as substrings of the caller's text. */
  says: string[];
  /** The tools that find this, most specific first. */
  tools: string[];
  /** Why those tools, in the caller's terms rather than the tool's. */
  because: string;
}

export const SYMPTOMS: SymptomEntry[] = [
  {
    // The contractions are not optional. The first version of this list had "not showing" and
    // "doesn't show" and missed "upgrades AREN'T SHOWING up in the shop" - the exact sentence quoted
    // at the top of this file as the reason it exists. People negate with contractions; a symptom
    // table that only knows the formal spellings knows the wrong half of the language.
    says: ["not showing", "not show", "doesn't show", "does not show", "don't show", "do not show", "aren't showing", "are not showing", "isn't showing", "is not showing", "won't show", "will not show", "never shows", "never show", "nothing shows", "missing", "no data", "blank", "is empty", "are empty", "empty list", "nothing in the list", "doesn't appear", "does not appear", "don't appear", "aren't appearing", "no items", "nothing appears", "not appearing"],
    tools: ["unreal_check_data_tables", "unreal_list_data_table_rows", "unreal_audit_project"],
    because:
      "In a data-driven game the commonest cause of 'nothing is there' is a Data Table that is empty, " +
      "full of default rows, or referenced but never filled in. check_data_tables finds all three across " +
      "the project in one call.",
  },
  {
    says: ["nothing happens", "no effect", "doesn't do anything", "does not do anything", "doesn't work", "does not work", "not working", "never runs", "doesn't fire", "does not fire", "not firing", "doesn't trigger", "no response"],
    tools: ["unreal_audit_project", "unreal_trace_function_calls", "unreal_review_blueprint"],
    because:
      "Something that looks finished and does nothing is usually a node wired to nothing, an event with " +
      "an empty body, or a function nobody calls. audit_project finds the first two project-wide; " +
      "trace_function_calls answers whether the thing you are looking at is reached at all.",
  },
  {
    says: ["crash", "crashes", "crashed", "freeze", "freezes", "hang", "hangs", "locks up", "closes itself", "quits"],
    tools: ["unreal_read_runtime_errors", "unreal_project_health", "unreal_watch_runtime"],
    because:
      "read_runtime_errors reads what the engine already logged, which names the asset and often the node. " +
      "Guessing from the Blueprint before reading the log is how an afternoon disappears.",
  },
  {
    says: ["slow", "lag", "laggy", "fps", "framerate", "frame rate", "stutter", "hitch", "performance", "drops frames"],
    tools: ["unreal_audit_project", "unreal_review_blueprint"],
    because:
      "The tick-heavy check finds work running every frame that does not need to, which is the most common " +
      "Blueprint performance bug and the easiest to fix once seen.",
  },
  {
    says: ["only the host", "only host", "only the server", "only works for the server", "other players", "client doesn't", "clients don't", "multiplayer", "replication", "not replicated", "doesn't replicate", "second player", "other player can't", "only works for me"],
    tools: ["unreal_audit_project", "unreal_guard_with_authority", "unreal_map_system"],
    because:
      "Works-for-the-host is nearly always state written on the server that never replicates, or logic " +
      "running on both sides that should run on one. The audit's multiplayer checks name which, and " +
      "guard_with_authority applies the usual fix.",
  },
  {
    says: ["key", "keys", "button", "buttons", "input", "controller", "gamepad", "keybind", "binding", "doesn't respond", "won't respond", "mapping"],
    tools: ["unreal_list_input_mappings", "unreal_read_input_context", "unreal_map_input_key"],
    because:
      "An input that does nothing is usually unbound, bound in a context that is not active, or bound to a " +
      "different action than the one the graph listens for. These read the actual mappings rather than the graph.",
  },
  {
    says: ["won't compile", "will not compile", "compile error", "compiler error", "compile", "red node", "errors in", "build error", "won't build"],
    tools: ["unreal_compile_blueprint", "unreal_project_health", "unreal_doctor"],
    because:
      "compile_blueprint returns the actual compiler messages for one asset; project_health finds every " +
      "Blueprint in the project that does not compile, which is the question worth asking first.",
  },
  {
    says: ["damage", "health", "score", "currency", "money", "stat", "value is wrong", "wrong number"],
    tools: ["unreal_trace_variable", "unreal_map_system", "unreal_audit_project"],
    because:
      "A number that ends up wrong is a question about every place that writes it. trace_variable lists those; " +
      "map_system shows the assets the whole system spans.",
  },  {
    says: ["animation", "anim", "montage", "doesn't animate", "not animating", "wrong pose", "t-pose", "tpose", "idle"],
    tools: ["unreal_read_anim_blueprint", "unreal_audit_project"],
    because:
      "read_anim_blueprint reads the state machine, its transitions and their conditions - a transition " +
      "whose condition can never be true looks exactly like a broken animation.",
  },
  {
    says: ["widget", "ui", "hud", "menu", "on screen", "button on screen", "health bar", "interface"],
    tools: ["unreal_list_widgets", "unreal_review_blueprint", "unreal_audit_project"],
    because:
      "A widget that never appears was usually created without being added to the viewport, or added on a " +
      "path nothing runs. The audit's client-sync checks cover the server-side half of this.",
  },
  {
    says: ["ai", "enemy", "enemies", "behavior tree", "behaviour tree", "pathfinding", "won't move", "doesn't move", "stuck", "not attacking"],
    tools: ["unreal_read_behavior_tree", "unreal_audit_project"],
    because:
      "read_behavior_tree reads the tree, its decorators and their blackboard keys - an AI that stands still " +
      "is usually a decorator on a key nothing ever sets.",
  },
  {
    says: ["particle", "vfx", "niagara", "effect", "no effect appears", "fx"],
    tools: ["unreal_read_niagara_system", "unreal_audit_project"],
    because: "read_niagara_system reports emitters that are disabled or have no spawn rate, which produce nothing and no error.",
  },
  {
    says: ["cutscene", "sequence", "sequencer", "timeline", "camera", "cinematic"],
    tools: ["unreal_read_level_sequence", "unreal_audit_project"],
    because:
      "read_level_sequence reports the three silent failures: a binding with no tracks, a track with no " +
      "sections, and a muted track. All three play perfectly and do nothing.",
  },
  {
    says: ["where is", "who calls", "what uses", "what references", "find the", "which blueprint", "can't find", "cannot find", "where does"],
    tools: ["unreal_search_project", "unreal_find_references", "unreal_find_source"],
    because:
      "search_project finds an asset by what it contains rather than by where it is; find_references answers " +
      "what points at a thing; find_source finds the C++ when the answer is not in a Blueprint at all.",
  },
  {
    says: ["save", "saving", "doesn't save", "load", "loading", "doesn't load", "lost progress", "resets"],
    // Led with search_project until a test asked whether any entry leads with a tool that is true of
    // every symptom. This one did - and its own `because` line already named trace_variable as the
    // answer. The reason and the recommendation disagreed, in the file written to stop exactly that.
    tools: ["unreal_trace_variable", "unreal_search_project", "unreal_audit_project"],
    because:
      "Save bugs are usually a variable written but never handed to the save object, or a save object written " +
      "and never flushed. trace_variable follows one variable through every graph that touches it.",
  },

];

export interface SymptomMatch {
  matched: string[];
  tools: string[];
  because: string[];
}

/**
 * Symptom entries whose vocabulary appears in the caller's text.
 *
 * Substring matching in both directions is deliberate. "crash" must match a caller who wrote
 * "the game crashes when I open the shop", and "not showing" must match "upgrades are not showing
 * up" - neither is a whole-word match, and requiring one would fail on exactly the sentences this
 * exists to serve.
 */
export function matchSymptoms(text: string): SymptomMatch | undefined {
  const said = (text ?? "").toLowerCase();
  if (said.length === 0) return undefined;

  const matched: string[] = [];
  const tools: string[] = [];
  const because: string[] = [];

  for (const entry of SYMPTOMS) {
    const hit = entry.says.find((phrase) => said.includes(phrase));
    if (!hit) continue;
    matched.push(hit);
    because.push(entry.because);
    for (const tool of entry.tools) if (!tools.includes(tool)) tools.push(tool);
    // Two entries at most.
    //
    // "The game crashes when I open the menu" matches both `crash` and `menu`, and answering with
    // both cost 667 tokens - six tools and two paragraphs - for a sentence whose first three words
    // already said where to look. A suggestion list long enough to need reading is not a
    // suggestion. Entries are ordered most-specific-first, so the earlier match is the better one.
    if (matched.length >= 2) break;
  }

  if (tools.length === 0) return undefined;
  // Four tools at most. Two entries of three tools each cost 667 tokens on "the game crashes when I
  // open the menu", for a sentence whose first three words already said where to look.
  return { matched, tools: tools.slice(0, 4), because };
}
