/**
 * _example-multi-action.ts -- Multi-action tool template
 *
 * Shows the recommended pattern for tools with multiple actions.
 * This file is SKIPPED by the tool registry (underscore prefix).
 *
 * Demonstrates:
 * - Action enum with conditional required params
 * - requireContext() for context validation
 * - param.object() for structured data
 * - param.date() for date parameters
 * - Structured output with { text, data } returns
 * - Standard error formatting ("Error: ...")
 *
 * To use as a real tool:
 * 1. Copy to your-tool.ts (remove the underscore)
 * 2. Rename, adjust params and handler logic
 * 3. Restart the bot — it auto-loads
 */

import { defineTool, param, requireContext } from "./types.js";

export default defineTool({
  name: "example_tasks",
  description:
    "Manage tasks for users. Create, list, complete, or delete tasks. " +
    "Tasks are scoped to the current user.",

  params: {
    action: param.enum(
      "The action to perform.",
      ["create", "list", "complete", "delete"] as const,
      { required: true },
    ),
    title: param.string("Task title. Required for create.", {
      maxLength: 200,
    }),
    dueDate: param.date("When the task is due. Optional for create."),
    metadata: param.object("Additional task metadata. Optional for create.", {
      properties: {
        priority: param.enum("Task priority.", ["low", "medium", "high"] as const),
        tags: param.array("Tags for categorization.", { itemType: "string" }),
      },
    }),
    taskIndex: param.number("Index of the task. Required for complete and delete."),
  },

  handler: async ({ action, title, dueDate, metadata, taskIndex }, ctx) => {
    // --- Validate context ---
    const err = requireContext(ctx, "userId");
    if (err) return err;

    const userId = ctx.userId!;

    switch (action) {
      case "create": {
        if (!title) return "Error: title is required for create.";

        // dueDate arrives as an ISO string (param.date hints the format)
        const due = dueDate ? new Date(dueDate) : null;

        // metadata is a typed object (or undefined)
        const priority = (metadata as Record<string, unknown>)?.priority ?? "medium";
        const tags = ((metadata as Record<string, unknown>)?.tags as string[]) ?? [];

        // ... your create logic here ...

        return {
          text: `Created task "${title}" for user ${userId}.` +
            (due ? ` Due: ${due.toISOString()}.` : "") +
            ` Priority: ${priority}. Tags: ${tags.length > 0 ? tags.join(", ") : "none"}.`,
          data: { action: "create", title, userId, dueDate: due?.toISOString() ?? null, priority, tags },
        };
      }

      case "list": {
        // ... your list logic here ...
        return {
          text: `Tasks for user ${userId}:\n(implement your list logic)`,
          data: { action: "list", userId, tasks: [] },
        };
      }

      case "complete": {
        if (taskIndex === undefined || taskIndex === null) {
          return "Error: taskIndex is required for complete.";
        }
        // ... your complete logic here ...
        return {
          text: `Completed task #${taskIndex}.`,
          data: { action: "complete", taskIndex },
        };
      }

      case "delete": {
        if (taskIndex === undefined || taskIndex === null) {
          return "Error: taskIndex is required for delete.";
        }
        // ... your delete logic here ...
        return {
          text: `Deleted task #${taskIndex}.`,
          data: { action: "delete", taskIndex },
        };
      }

      default:
        return `Error: unknown action "${action}". Use create, list, complete, or delete.`;
    }
  },
});
