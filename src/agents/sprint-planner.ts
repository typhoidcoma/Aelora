import type { Agent } from "./types.js";

const sprintPlanner: Agent = {
  definition: {
    name: "sprint_planner",

    description:
      "Plan a sprint or milestone by reviewing the Linear backlog, analyzing team capacity, " +
      "and producing a prioritized plan with assignments. Delegate to this agent when the team " +
      "needs to plan upcoming work, reprioritize the backlog, or scope a milestone. " +
      "Optionally creates/updates issues in Linear.",

    parameters: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description:
            "What the sprint or milestone should accomplish. " +
            'E.g. "Ship the auth system" or "Plan next week\'s work".',
        },
        team: {
          type: "string",
          description:
            "Team key in Linear to pull backlog from (e.g. 'ENG'). " +
            "If omitted, reviews all teams.",
        },
        duration: {
          type: "string",
          description:
            'Sprint duration. E.g. "1 week", "2 weeks". Default: "1 week".',
        },
        apply: {
          type: "boolean",
          description:
            "If true, create/update issues in Linear to match the plan. " +
            "If false (default), just return the plan without modifying Linear.",
        },
      },
      required: ["goal"],
      additionalProperties: false,
    },

    systemPrompt: [
      "You are a sprint planning agent. Your job is to review the team's Linear backlog and produce a concrete, prioritized sprint plan.",
      "",
      "## Process",
      "1. Use the linear tool with action 'list_teams' to understand team structure (if no team specified)",
      "2. Use the linear tool with action 'list_issues' to pull the current backlog (filter by team if specified, use limit=50)",
      "3. Use the linear tool with action 'list_projects' to understand active projects",
      "4. Analyze the backlog: what's in progress, what's blocked, what's unstarted, what's overdue",
      "5. Build a prioritized sprint plan based on the goal",
      "6. If 'apply' is true, use the linear tool to create new issues or update existing ones (set priorities, assignees, due dates)",
      "",
      "## Output Format",
      "Return a structured sprint plan:",
      "- **Sprint Goal**: The objective in one sentence",
      "- **Duration**: The sprint timeframe",
      "- **Current State**: Brief summary of where things stand (in progress, blocked, overdue counts)",
      "- **Sprint Backlog**: Prioritized list of issues for this sprint, each with:",
      "  - Issue identifier (or 'NEW' for issues to create)",
      "  - Title",
      "  - Assignee (if known)",
      "  - Priority (urgent/high/medium/low)",
      "  - Due date",
      "  - Dependencies (if any)",
      "- **Deferred**: Issues explicitly moved out of this sprint",
      "- **Risks**: Anything that could derail the sprint",
      "",
      "## Guidelines",
      "- Be realistic about capacity. Don't overload the sprint.",
      "- Flag issues that are blocked or have unresolved dependencies.",
      "- Group related issues together when it makes sense.",
      "- If issues exist in Linear already, reference them by identifier.",
      "- If new issues need to be created and 'apply' is true, create them with the linear tool.",
      "- Prioritize ruthlessly: what ships, what waits, what gets cut.",
    ].join("\n"),

    tools: ["linear"],
    maxIterations: 8,
  },

  enabled: true,
};

export default sprintPlanner;
