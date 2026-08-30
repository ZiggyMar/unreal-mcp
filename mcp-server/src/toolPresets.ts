/**
 * Named tool sets for the jobs people actually ask for.
 *
 * Measured, and this is the whole reason the file exists: naming the eight tools one Blueprint
 * feature needs costs 4,552 tokens against 11,666 for enabling the `core` group - 61% less, with the
 * five-surface feature trial still passing on a named set. The saving is real and it is not bought
 * with capability.
 *
 * But a model cannot take it. On the `search` profile it starts with four tools and no idea which
 * eight to name, so its choices are to call unreal_list_tools and reason about a catalogue, or to
 * enable `core` and pay 11,666. Guesswork stands between every session and the cheapest path, which
 * makes the cheap path an expert move rather than the default. That is a design failure, not a
 * documentation one: advice a model cannot act on without extra calls is advice that costs tokens.
 *
 * A preset is the answer to "I know what job I am doing, give me the tools for it". Deterministic,
 * not inferred - the server does not try to guess intent from a sentence, because a wrong guess
 * leaves a model without a tool it needs and no clue why.
 *
 * Two rules held while choosing these:
 *
 * - Every preset is checked against a trial that uses it, so "sufficient" means a run passed and not
 *   that the list looked complete. `trial:diagnose --by-preset` runs the whole find-and-fix loop on
 *   `diagnose` alone.
 * - When in doubt a tool is IN. A missing tool costs a round trip and a confused model; a spare one
 *   costs a few hundred tokens. Those are not the same size of mistake.
 */

export interface ToolPreset {
  /** What job this is for, in the words someone would use to describe it. */
  what: string;
  tools: string[];
}

/**
 * Reading tools, shared by every preset that has to understand a project before touching it.
 *
 * "Scans the current work, adapts to it, builds with it" is the stated requirement, and none of it
 * happens without these. They are the cheapest tools in the server and the ones that stop a model
 * guessing at names, which is the most expensive mistake it can make.
 */
const ORIENT = [
  "unreal_get_project_overview",
  "unreal_search_project",
  "unreal_list_blueprints",
  "unreal_read_blueprint_summary",
  "unreal_find_node",
];

export const TOOL_PRESETS: Record<string, ToolPreset> = {
  diagnose: {
    what: "find and fix a reported bug, without authoring anything new",
    tools: [
      ...ORIENT,
      "unreal_list_blueprint_graphs",
      "unreal_explain_graph",
      "unreal_review_blueprint",
      "unreal_compile_blueprint",
      "unreal_audit_project",
      "unreal_project_health",
      "unreal_read_runtime_errors",
      "unreal_find_references",
      // Added because trial:diagnose --by-preset failed without it. It was missing from a list I had
      // written and read twice: a tool whose entire job is finding something wrong, absent from the
      // preset for finding things wrong. Running the loop found it in one go.
      "unreal_find_orphans",
      // The fix half. A preset that can only diagnose leaves the model to enable more before it can
      // act on what it just found, which is the round trip this is meant to remove.
      "unreal_build_graph",
      "unreal_cleanup_blueprint",
      "unreal_save_blueprint",
      "unreal_verify_feature",
    ],
  },

  feature: {
    what: "build a new Blueprint feature into an existing project",
    tools: [
      ...ORIENT,
      "unreal_plan_feature",
      "unreal_describe_class",
      "unreal_scaffold_blueprint",
      "unreal_add_component",
      // A feature that adds a component almost always sets something on it - a radius, a mesh, a
      // collision profile. Leaving this out would have made the commonest next call a round trip.
      "unreal_set_component_property",
      "unreal_add_variable",
      "unreal_add_event_handler",
      "unreal_build_graph",
      "unreal_compile_blueprint",
      "unreal_review_blueprint",
      "unreal_save_blueprint",
      "unreal_verify_feature",
    ],
  },

  ui: {
    what: "build or change UMG widgets, and bind them to something",
    tools: [
      ...ORIENT,
      "unreal_scaffold_widget",
      "unreal_create_widget_blueprint",
      "unreal_add_widget",
      "unreal_list_widgets",
      "unreal_set_widget_property",
      "unreal_build_graph",
      "unreal_compile_blueprint",
      "unreal_save_blueprint",
    ],
  },

  data: {
    what: "work on Data Tables, structs and enums",
    tools: [
      ...ORIENT,
      "unreal_list_assets",
      "unreal_create_struct",
      "unreal_add_struct_field",
      "unreal_list_struct_fields",
      "unreal_create_data_table",
      "unreal_list_data_table_rows",
      "unreal_add_data_table_row",
      "unreal_set_data_table_row",
      "unreal_remove_data_table_row",
      "unreal_check_data_tables",
      // Data Assets are the typed sibling of a Data Table and there were 41 of them in the project
      // this was measured on, so a "data" preset without them was answering half the question.
      "unreal_read_asset_properties",
      "unreal_set_asset_property",
      "unreal_save_asset",
    ],
  },

  cpp: {
    what: "read and change the project's C++",
    tools: [...ORIENT, "unreal_find_source", "unreal_compile_cpp", "unreal_describe_class", "unreal_find_references"],
  },
};

export const PRESET_NAMES = Object.keys(TOOL_PRESETS);

/** Resolve a preset name to its tools, or undefined if there is no such preset. */
export function presetTools(name: string): string[] | undefined {
  return TOOL_PRESETS[name]?.tools;
}
