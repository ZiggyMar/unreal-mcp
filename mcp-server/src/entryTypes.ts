/**
 * The node types execution STARTS at.
 *
 * One list, imported by everything that needs it, because there were three and they disagreed.
 * `explainGraph` knew about bound events and the legacy input nodes; `graphSummary` knew about four
 * kinds and used its list to decide what survives a node cap; the C++ side tested two classes. A
 * node kind missing from any one of them is not a small gap - it is a whole feature reported as
 * dead code by whichever reader was asked.
 *
 * The omission that prompted this: K2Node_EnhancedInputAction, which is how every modern Unreal
 * project drives movement, jump, fire, interact - everything. It does not derive from K2Node_Event,
 * so no reader here counted it. explain_graph listed 25 entry points for a real player Blueprint
 * and not one input action, and trace_function_calls called a working ping system dead, advising
 * "Do not fix it; find what took over". A model that believes that deletes working code.
 *
 * The C++ side now tests IK2Node_EventNodeInterface instead of a class list, which is the honest
 * question and cannot go stale. There is no such reflection here - these are type name strings off
 * the wire - so this list is checked against the bridge by a guard rather than trusted.
 */
export const ENTRY_TYPES: readonly string[] = [
  "K2Node_Event",
  "K2Node_CustomEvent",

  // Enhanced Input: the modern path, and the one that was missing.
  //
  // K2Node_EnhancedInputAction is the node placed in a graph when you add an IA_ event.
  // K2Node_EnhancedInputActionEvent is the inner event node it expands to, which shows up when
  // reading some graphs directly. Both start a chain.
  "K2Node_EnhancedInputAction",
  "K2Node_EnhancedInputActionEvent",

  // The legacy input path, still present in older projects and still an entry point.
  "K2Node_InputAxisEvent",
  "K2Node_InputActionEvent",
  "K2Node_InputKeyEvent",
  "K2Node_InputTouchEvent",
  "K2Node_InputVectorAxisEvent",
  "K2Node_InputAxisKeyEvent",

  // A button's On Clicked is a ComponentBoundEvent, and leaving these out described every widget
  // Blueprint as almost entirely dead: the handlers became "not reached by any event chain", and
  // the logic hanging off them - the whole menu - went with them. Found by reading a real UI
  // Blueprint and not believing the answer.
  "K2Node_ComponentBoundEvent",
  "K2Node_ActorBoundEvent",

  "K2Node_FunctionEntry",
  "K2Node_Timeline",
];

/**
 * Does execution start at this node type? Tolerates undefined, which is what the wire may carry.
 *
 * Accepts the bare form too - "CustomEvent" as well as "K2Node_CustomEvent" - because the graph
 * summary strips the prefix before a caller ever sees a type, while the bridge and this list use
 * the full class name. Matching only the full name made every entry node in a real graph invisible:
 * the box suggester went from offering 89 of 100 to 0 of 100, because "CustomEvent" is not in a list
 * of "K2Node_CustomEvent". The unit tests missed it by using the unstripped form, which is more
 * faithful to the class name and less faithful to what actually arrives.
 */
export const isEntryType = (type: string | undefined): boolean =>
  typeof type === "string" &&
  (ENTRY_TYPES.includes(type) || ENTRY_TYPES.includes(`K2Node_${type}`));
