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
    // The failure unreal_find_orphans actually finds, which is NOT "unused assets".
    //
    // Worth writing down because the obvious reading of the tool's name is wrong and I nearly routed
    // it that way: find_orphans is about ACTORS IN A LEVEL that lost the partner they were placed
    // with - a nav link and its door, a trigger and the thing it triggers, a spawn point and its
    // volume. Delete one half and the other stays behind, still ticking, still handling events,
    // pointing at nothing, and nothing warns, because an actor with a null reference is a perfectly
    // legal actor.
    //
    // So the words that reach it are the words for that: something that worked before a deletion,
    // or something that works for some instances and not others. The generic "nothing happens" entry
    // covers the same sentence phrased without that history, which is correct - the history is the
    // only thing that distinguishes this cause from every other cause of nothing happening.
    says: [
      "after i deleted",
      "since i deleted",
      "after deleting",
      "stopped working after",
      "some of them work",
      "only some of them",
      "half of them",
      "worked before",
    ],
    tools: ["unreal_find_orphans", "unreal_audit_project"],
    because:
      "Actors placed in pairs break in a way nothing reports: delete one half and the other is still a valid " +
      "actor holding a null. find_orphans pairs each actor of one class to its nearest of another BY POSITION " +
      "- the reference is the broken thing, so it cannot be trusted to say what it should have pointed at - " +
      "and reports the ones left standing alone, plus any partner nothing paired to.",
  },
  {
    // No bare "spawn". A caller asking "how do I spawn an actor" is asking how to BUILD something,
    // and this entry answers a question about what is WRONG - it would send them to project settings
    // to learn node syntax. Only the failure phrasings are listed, which is the difference between a
    // symptom table and a keyword table that happens to contain the word.
    says: ["doesn't spawn", "does not spawn", "don't spawn", "won't spawn", "will not spawn", "not spawning", "nothing spawns", "never spawns", "no player", "no pawn", "no character", "wrong pawn", "wrong character", "wrong gamemode", "wrong game mode", "spawns as", "possess", "not possessed", "no controller"],
    tools: ["unreal_get_game_settings", "unreal_audit_project", "unreal_read_class_defaults"],
    because:
      "Whether anything spawns is decided in two places that disagree freely: the project's default " +
      "GameMode, and a World Settings override on the level you actually opened. get_game_settings " +
      "reports both, because the answer in project settings is often not the one in force. If the " +
      "GameMode is right, the next question is what it points at - a GameMode that names a GameState " +
      "and a Controller but leaves DefaultPawnClass at the engine default spawns a floating camera " +
      "with no character, which audit_project reports as gamemode-has-no-pawn.",
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
    // "user interface", never bare "interface". In Unreal the unqualified word almost always means a
    // Blueprint Interface - a class construct with no screen involved - and "the interface isn't
    // implemented on the turret" was being answered with list_widgets. UI has its own vocabulary
    // here (widget, HUD, menu, on screen) and does not need to borrow the ambiguous one.
    says: ["widget", "ui", "hud", "menu", "on screen", "button on screen", "health bar", "user interface"],
    tools: ["unreal_list_widgets", "unreal_review_blueprint", "unreal_audit_project"],
    because:
      "A widget that never appears was usually created without being added to the viewport, or added on a " +
      "path nothing runs. The audit's client-sync checks cover the server-side half of this.",
  },
  {
    // "blackboard" was named in this entry's own `because` line and in none of its `says`, so the
    // word that most reliably identifies an AI question could not reach the AI tool. "the blackboard
    // key is never set" matched the INPUT entry instead, on `key`, and came back with three input
    // tools - `key` means a keyboard key there and a blackboard entry here, and only one of those
    // readings was reachable.
    says: [
      "ai",
      "enemy",
      "enemies",
      "behavior tree",
      "behaviour tree",
      "blackboard key",
      "blackboard",
      "pathfinding",
      "won't move",
      "doesn't move",
      "stuck",
      "not attacking",
    ],
    tools: ["unreal_read_behavior_tree", "unreal_audit_project"],
    because:
      "read_behavior_tree reads the tree, its decorators and their blackboard keys - an AI that stands still " +
      "is usually a decorator on a key nothing ever sets.",
  },
  {
    // No bare "effect". It is the loosest word in this table: "status effect", "side effect",
    // "effective", "takes effect" are all ordinary English about things that are not particles.
    //
    // It cost a real misroute. "add a new C++ actor component for status effects" matched `effect`,
    // this entry took one of the two answer slots, and the reply recommended read_niagara_system for
    // a C++ build request - while `c++`, the most informative word in the sentence, lost its slot to
    // it. A loose word does not merely add a wrong suggestion; it EVICTS a right one, because only
    // two entries ever answer.
    //
    // The phrasings that survive either name the thing or pair the word with a visual verb.
    says: [
      "particle",
      "vfx",
      "niagara",
      "fx",
      "visual effect",
      "particle effect",
      "no effect appears",
      "effect doesn't play",
      "effect does not play",
      "effect never plays",
      "effect doesn't spawn",
      "effect isn't showing",
    ],
    tools: ["unreal_read_niagara_system", "unreal_audit_project"],
    because: "read_niagara_system reports emitters that are disabled or have no spawn rate, which produce nothing and no error.",
  },
  {
    // Materials had no entry at all, and unreal_list_material_parameters was reachable from nothing.
    // "the material is the wrong colour" matched NOTHING; "the turret texture doesn't show up" was
    // answered with the Data Table tools, because `doesn't show` is in the first entry and no word
    // in the sentence pointed anywhere better.
    //
    // "texture doesn't show" is spelled out as a phrase deliberately: it has to outrank the generic
    // `doesn't show` on word count, or the domain loses to the catch-all again.
    says: [
      "material",
      "texture",
      "shader",
      "material parameter",
      "texture doesn't show",
      "texture does not show",
      "wrong colour",
      "wrong color",
      "looks black",
      "renders black",
      "untextured",
    ],
    tools: ["unreal_list_material_parameters", "unreal_read_asset_properties", "unreal_audit_project"],
    because:
      "A material that renders wrong is usually an instance overriding a parameter that the parent does not " +
      "expose, or a parameter name that is simply not on the asset. list_material_parameters returns every " +
      "scalar, colour and texture parameter the material actually exposes, with its kind, and says whether " +
      "the asset is an instance at all - which is what set_material_parameter has to be right about before " +
      "it can change anything.",
  },
  {
    // A Timeline is a Blueprint node, not a cutscene, and unreal_read_timeline is its own tool.
    //
    // "timeline" sat in the cinematic entry below, so every sentence about a Blueprint Timeline was
    // answered with read_level_sequence - a route pointing at the wrong tool while the right one
    // existed and was reachable by nothing. Two engine concepts share an English word, and the table
    // knew only the rarer of them.
    //
    // Above the cinematic entry deliberately: "the timeline never finishes" should reach the node
    // that runs on a curve, not the sequence that plays a shot.
    says: ["timeline", "curve doesn't play", "timeline never finishes", "timeline doesn't fire"],
    tools: ["unreal_read_timeline", "unreal_audit_project"],
    because:
      "read_timeline reports what a Blueprint Timeline animates: its curves, their keys, and the length it " +
      "actually runs for. A Timeline with no track, or a track whose curve has a single key, plays without " +
      "error and changes nothing - and it is a different construct from a Level Sequence, which is what " +
      "unreal_read_level_sequence reads.",
  },
  {
    says: ["cutscene", "sequence", "sequencer", "camera", "cinematic"],
    tools: ["unreal_read_level_sequence", "unreal_audit_project"],
    because:
      "read_level_sequence reports the three silent failures: a binding with no tracks, a track with no " +
      "sections, and a muted track. All three play perfectly and do nothing.",
  },
  {
    // The one substrate where finding the value is not the end of the job. A Blueprint change is live
    // the moment it compiles; a C++ change sits in a file the running editor has never read, so a
    // model that edits the header and reports the work done has left the editor running the old code.
    says: ["c++", "cpp", "native class", "native code", "header file", "recompile", "hot reload", "live coding", ".cpp", "in the header"],
    tools: ["unreal_find_source", "unreal_compile_cpp", "unreal_hot_reload_cpp"],
    because:
      "find_source gives the file and line - it returns locations rather than contents on purpose, because your " +
      "own file tools read and edit better than it could. The part that is easy to miss is what comes after: a " +
      "C++ edit changes a file the running editor has never read, so unreal_compile_cpp says whether it built " +
      "and unreal_hot_reload_cpp patches it into the editor already open. Skip that last step and the code on " +
      "disk is right while the editor keeps running the old version, which looks exactly like the change not working.",
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

/**
 * Words that mean "I want this built", as opposed to "this is broken".
 *
 * The index answered only bug reports at first, and the other half of what this project promises is
 * "I tell it a feature I want, it scans the current work, adapts to it, builds with it". Measured,
 * that half landed badly:
 *
 *   "add a new shop upgrade"  -> nothing at all
 *   "I want to add a dash"    -> nothing at all
 *   "add a pause menu"        -> list_widgets, review_blueprint, audit_project
 *   "make the enemies drop loot" -> read_behavior_tree, audit_project
 *
 * Nothing, or a set of tools for finding out what is BROKEN handed to someone who wants something
 * BUILT. The subject was read correctly and the intent was not read at all.
 *
 * Intent picks the approach, subject picks the domain: "add a pause menu" should plan the work and
 * map what exists, AND bring the widget tools because the subject is a menu.
 */
const BUILDING = [
  "add a", "add an", "add some", "i want to add", "i want a", "i want an", "i need a", "i need an",
  "create a", "create an", "make a", "make an", "build a", "build an", "implement", "set up a",
  "set up an", "new feature", "how do i add", "how would i add", "can you add", "let's add",
  "hook up a", "wire up a", "make the", "give the", "give me a",
];

/**
 * Words that mean "this exists and I want it different".
 *
 * The third thing this project promises - "I have a change request, it finds it and changes it,
 * whether it's C++ or Blueprints or a Data Table" - and the one that landed worst:
 *
 *   "change the player walk speed"                  -> nothing at all
 *   "rename FireRate to RateOfFire"                 -> nothing at all
 *   "the machine gun should cost 500 instead of 300" -> nothing at all
 *   "make the health upgrade cost more"             -> read as BUILDING -> plan_feature
 *
 * The last is the dangerous one: plan_feature would set about planning a health upgrade system that
 * already exists, because "make the" reads as a request to create something.
 *
 * Checked BEFORE the build words, because change vocabulary is the more specific of the two. "Make a
 * health upgrade" is building; "make the health upgrade cost more" is a change, and only the second
 * half of that sentence says so.
 */
const CHANGING = [
  "change", "rename", "instead of", "should be", "should cost", "cost more", "cost less",
  "tweak", "swap", "replace the", "bump the", "set the", "adjust",
  // Multi-word on purpose: "increases fire rate" is a feature description, "increase the fire rate"
  // is a change request, and only the space tells them apart.
  "increase the", "decrease the", "raise the", "lower the", "reduce the",
];

/**
 * The tools that find a value before you change it.
 *
 * Deliberately spans the substrates rather than guessing which one holds it. A cost lives in a Data
 * Table, a walk speed on a component, a hard limit in C++ - and the caller asking for the change is
 * exactly the person who does not know which.
 *
 * The first version of this list said search_project "covers Data Table rows and Blueprint contents
 * at once". It does not: it indexes Blueprint names, parent classes, function names and variable
 * names. Searching it for "Weapon_MachineGun", a real row in this project's DT_Upgrades, returns
 * zero hits - and searching for "MaxWalkSpeed" returns zero too, because that is a property on the
 * movement component and read_class_defaults does not carry it either.
 *
 * Both were written as advice before being tried. Finding that out is what produced
 * unreal_find_in_data_tables, which did not exist: nothing in this server could answer "which table
 * has a row called X".
 */
/**
 * A rename and a removal are changes with a tool of their own, and the routing did not know.
 *
 * "Rename FireRate to RateOfFire" is the sentence this whole index was built against. It was routed
 * correctly as a change, handed four tools that FIND things, and advice that named set_data_table_row
 * and set_class_default - none of which renames anything. So the answer was: here is how to locate
 * it, and then nothing.
 *
 * That gap was real until rename_variable and rename_asset existed. Then they were built, and this
 * file was not updated, so the routing still said the same thing while the tool it should have named
 * sat one directory away. Building a capability and not telling the router about it leaves the
 * capability unreachable for exactly the caller it was built for.
 */
const RENAMING = ["rename", "renaming", "call it", "name it", "should be called", "change the name"];
const REMOVING = ["remove", "removing", "delete", "deleting", "get rid of", "take out", "no longer need"];

/**
 * An edit already made, mentioned as history - not an edit being asked for.
 *
 * "The door stopped working after I deleted the trigger" is a bug report whose most useful word is
 * `deleted`, and the intent layer read it as an instruction: the reply came back with
 * remove_variable, remove_function, remove_component and delete_asset - four ways to delete more
 * things, offered to someone whose problem is that something was already deleted.
 *
 * This is the worst direction for a misread to go. Every other misroute in this file costs a wasted
 * read; this one hands a caller the tools to make the damage bigger, and the sentence that triggers
 * it is the single most common way people describe regressions.
 *
 * Past tense is the whole signal. "delete the old health variable" is a request; "I deleted",
 * "after deleting", "since we removed" are all reports of something that already happened, and what
 * follows them is the symptom, not the job. Renames get the same treatment for the same reason -
 * "after I renamed FireRate everything broke" is not a request to rename anything.
 */
const ALREADY_DONE = [
  "i deleted",
  "we deleted",
  "after deleting",
  "since deleting",
  "i removed",
  "we removed",
  "after removing",
  "since removing",
  "i renamed",
  "we renamed",
  "after renaming",
  "since renaming",
  "was deleted",
  "was removed",
  "was renamed",
  "got deleted",
  "used to be called",
];

/** Renaming reaches for the tool that rebinds what referenced the old name, not for a value setter. */
const RENAME_TOOLS = ["unreal_rename_variable", "unreal_rename_asset", "unreal_rename_component", "unreal_search_project"];

const RENAME_BECAUSE =
  "A rename is not a value change, and doing it by editing the thing directly is what breaks a " +
  "project: every node, Blueprint and Data Table that referred to the old name is left pointing at " +
  "something that no longer exists. Each of these rebinds the references as it goes. Which one " +
  "depends on what is being renamed - unreal_rename_variable for a Blueprint variable (the commonest " +
  "case), unreal_rename_component for a component, unreal_rename_asset for the asset itself, which " +
  "also moves it if you give newFolder. If you do not yet know which, unreal_search_project finds it.";

const REMOVE_TOOLS = ["unreal_remove_variable", "unreal_remove_function", "unreal_remove_component", "unreal_delete_asset"];

const REMOVE_BECAUSE =
  "Removing something that other things still use is the risk here, so each of these refuses while " +
  "anything still references what you are deleting and names what does - a variable still read by a " +
  "graph, a function still called, an asset still referenced. That refusal is the useful part: pass " +
  "force only when deleting the dependents is what you actually mean.";

const CHANGE_TOOLS = ["unreal_find_in_data_tables", "unreal_search_project", "unreal_trace_variable", "unreal_find_source"];

const CHANGE_BECAUSE =
  "This is a change to something that already exists, so the work is finding it before editing it, " +
  "and a value lives in one of four places. A Data Table row: unreal_find_in_data_tables searches " +
  "row names and cell values across every table. A Blueprint variable or function: " +
  "unreal_search_project, which indexes names, parent classes, functions and variables - but NOT " +
  "table rows and NOT default values. A component property like walk speed or a collision radius: " +
  "unreal_list_components then unreal_set_component_property, because those are set on the component " +
  "and never appear in read_class_defaults. A C++ default: unreal_find_source. " +
  "Check more than one before concluding a value is not there - a number missing from all of them is " +
  "usually spelled differently, not absent. And if it turns out to be in C++, finding it is only half " +
  "the job: the edit changes a file the running editor has never read, so unreal_hot_reload_cpp is what " +
  "makes it real. Skipping that leaves the code on disk right and the editor running the old version, " +
  "which looks exactly like the change not working.";

/** The tools that answer "build me this", before anything domain-specific. */
const BUILD_TOOLS = ["unreal_plan_feature", "unreal_map_system"];

const BUILD_BECAUSE =
  "This reads as something to build rather than something broken. plan_feature reads the project " +
  "first and returns a plan that fits what is already there - the parent classes, the naming, the " +
  "Data Tables a system is driven by - rather than a generic recipe. map_system shows every asset " +
  "an existing system spans, which is what you extend rather than duplicate. Build on top of those " +
  "two, not from scratch.";

export interface SymptomMatch {
  matched: string[];
  tools: string[];
  because: string[];
  /**
   * What the caller is asking for: something new, something existing made different, or something
   * that is misbehaving. The three want entirely different tools, and reading it wrong sends a model
   * to plan a system that already exists.
   */
  intent: "building" | "changing" | "broken";
}

/**
 * Does one symptom phrase appear in what the caller said?
 *
 * Plain substring matching shipped first and was wrong in a way that produced confident nonsense:
 *
 *   "build a new weapon"    -> ui   (inside b-UI-ld)      -> widget tools
 *   "explain the chain"     -> ai   (inside ch-AI-n)      -> behaviour tree tools
 *   "change the flag"       -> hang, lag                  -> crash and performance tools
 *   "the animal spawns"     -> anim                       -> animation tools
 *   "a monkey and a guide"  -> key, ui                    -> input and widget tools
 *
 * Seventeen phrases were four characters or shorter, and every one of them is a substring of
 * ordinary English. This is exactly the failure the module comment warns about - a caller who
 * believes they were understood trusting a wrong answer - shipped in the same file.
 *
 * The rule now depends on the phrase:
 *
 *   - contains a space -> substring. Multi-word phrases are specific enough on their own, and they
 *     NEED substring matching: "aren't showing" has to match "upgrades aren't showing up".
 *   - single word, 5+ characters -> word boundary at the start, suffix free. "crash" matches
 *     "crashes" and "crashing"; "animation" matches "animations".
 *   - single word, 4 or fewer -> whole word only. "ai" must not match "aim" or "air", "ui" must not
 *     match "build", "lag" must not match "flag". The lists already carry the variants that matters
 *     ("key" and "keys", "save" and "saving", "anim" and "animation"), so nothing is lost.
 */
function saysIt(said: string, phrase: string): boolean {
  if (phrase.includes(" ")) return said.includes(phrase);
  // A phrase with punctuation is already distinctive, and word boundaries do not work around one:
  // /c\+\+/ never matches "C++ class", because the boundary after "+" needs a word character
  // and a space is not one. "c++" is exactly the token this index most needed to match.
  if (/[^a-z0-9]/.test(phrase)) return said.includes(phrase);
  // The phrases are hand-written lowercase words, but escaping costs nothing, and a hyphen or
  // bracket slipped into one later would be a silent misparse rather than an error.
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  const pattern = phrase.length <= 4 ? `\\b${escaped}\\b` : `\\b${escaped}`;
  return new RegExp(pattern).test(said);
}

/**
 * Symptom entries whose vocabulary appears in the caller's text.
 */
export function matchSymptoms(text: string): SymptomMatch | undefined {
  const said = (text ?? "").toLowerCase();
  if (said.length === 0) return undefined;

  const matched: string[] = [];
  const tools: string[] = [];
  const because: string[] = [];

  // Read the intent before the subject. A build request that also names a domain gets both: the
  // tools that plan against what exists, then the tools for that part of the engine.
  // Change before build: "make the health upgrade cost more" says both, and only the change reading
  // is right. A request to build something that already exists is the expensive mistake here.
  // A rename or a removal is a change with its own tool, so those are checked first and lead. The
  // generic change route is for a VALUE change, and it answers a rename with four ways to find the
  // thing and no way to rename it.
  // An edit already made is history, not an instruction. See ALREADY_DONE: reading "the door stopped
  // working after I deleted the trigger" as a removal request answered it with four ways to delete
  // more things. Only the rename and remove routes are suppressed - those are the two that hand back
  // destructive tools. A change or build word alongside "I deleted" is still worth reading as intent.
  const alreadyDone = ALREADY_DONE.some((phrase) => saysIt(said, phrase));
  const renameWord = alreadyDone ? undefined : RENAMING.find((phrase) => saysIt(said, phrase));
  const removeWord = renameWord || alreadyDone ? undefined : REMOVING.find((phrase) => saysIt(said, phrase));
  const changeWord = renameWord ?? removeWord ?? CHANGING.find((phrase) => saysIt(said, phrase));
  const buildWord = changeWord ? undefined : BUILDING.find((phrase) => saysIt(said, phrase));
  if (renameWord) {
    matched.push(renameWord);
    because.push(RENAME_BECAUSE);
    tools.push(...RENAME_TOOLS);
  } else if (removeWord) {
    matched.push(removeWord);
    because.push(REMOVE_BECAUSE);
    tools.push(...REMOVE_TOOLS);
  } else if (changeWord) {
    matched.push(changeWord);
    because.push(CHANGE_BECAUSE);
    tools.push(...CHANGE_TOOLS);
  } else if (buildWord) {
    matched.push(buildWord);
    because.push(BUILD_BECAUSE);
    tools.push(...BUILD_TOOLS);
  }

  /**
   * Every entry that matched, strongest evidence first.
   *
   * Table position used to decide this outright: the loop took the first two entries it met and
   * stopped. The ordering comment said "entries are ordered most-specific-first, so the earlier
   * match is the better one", and that is true of the ENTRIES while saying nothing about the PHRASE
   * that actually matched - which is the thing carrying the evidence.
   *
   * "The blackboard key is never set" is the case that separates them. It matches `key` in the input
   * entry and `blackboard key` in the AI entry. Input sits earlier, so it led, and the reply opened
   * with three keyboard tools for a question about a Behavior Tree. Both readings of `key` are real
   * Unreal vocabulary; only one of them was two words long.
   *
   * So: a phrase matching MORE WORDS of the sentence outranks one matching fewer, and table position
   * breaks ties.
   *
   * Word count, not character length. Character length was the first attempt and it is a bad proxy:
   * it reordered "enemies don't take damage" to lead with the AI tools, because `enemies` is a longer
   * word than `damage` - undoing the exact decision this file's header records making, for a reason
   * that has nothing to do with specificity. A long word is not a specific one. Two words are two
   * words.
   *
   * Ties keep table order, which is almost every sentence, so the ordering argued for above still
   * governs everything except the case where one entry plainly has more of the sentence behind it.
   */
  const words = (phrase: string) => phrase.split(" ").length;
  const hits: { entry: SymptomEntry; hit: string }[] = [];
  for (const entry of SYMPTOMS) {
    const hit = entry.says.find((phrase) => saysIt(said, phrase));
    if (hit) hits.push({ entry, hit });
  }
  // Stable: Array.prototype.sort is specified stable, so equal word counts keep table order.
  hits.sort((a, b) => words(b.hit) - words(a.hit));

  // Two entries at most.
  //
  // "The game crashes when I open the menu" matches both `crash` and `menu`, and answering with
  // both cost 667 tokens - six tools and two paragraphs - for a sentence whose first three words
  // already said where to look. A suggestion list long enough to need reading is not a suggestion.
  for (const { entry, hit } of hits.slice(0, 2)) {
    matched.push(hit);
    because.push(entry.because);
    for (const tool of entry.tools) if (!tools.includes(tool)) tools.push(tool);
  }

  if (tools.length === 0) return undefined;
  // Four tools at most. Two entries of three tools each cost 667 tokens on "the game crashes when I
  // open the menu", for a sentence whose first three words already said where to look.
  return {
    matched,
    tools: tools.slice(0, 4),
    because,
    intent: changeWord ? "changing" : buildWord ? "building" : "broken",
  };
}
