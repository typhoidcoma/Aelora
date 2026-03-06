import { LinearClient, type IssueSearchResult } from "@linear/sdk";
import { defineTool, param } from "./types.js";

function getClient(apiKey: string): LinearClient {
  return new LinearClient({ apiKey });
}

const ALL_ACTIONS = [
  "list_issues", "get_issue", "search", "my_issues", "list_projects", "list_teams",
  "create_issue", "update_issue", "add_comment", "delete_issue",
] as const;

export default defineTool({
  name: "linear",
  description:
    "Full read/write access to Linear project management. " +
    "Read: list_issues, get_issue, search, my_issues, list_projects, list_teams. " +
    "Write: create_issue (requires title + team), update_issue (requires issue_id), " +
    "add_comment (requires issue_id + comment), delete_issue (requires issue_id).",

  params: {
    action: param.enum("The action to perform.", ALL_ACTIONS, { required: true }),
    query: param.string("Search query (for 'search' action)."),
    issue_id: param.string(
      "Issue identifier, e.g. 'ENG-123' (for get_issue, update_issue, add_comment, delete_issue).",
    ),
    team: param.string(
      "Team key (e.g. 'ENG'). Required for create_issue, optional filter for list_issues.",
    ),
    status: param.string(
      "Status name (e.g. 'In Progress', 'Done'). Filter for list/my_issues, or set on create/update.",
    ),
    limit: param.number("Max results to return (1-50). Default: 10.", { minimum: 1, maximum: 50 }),
    title: param.string("Issue title (for create_issue, or update_issue to rename)."),
    description: param.string("Issue description in markdown (for create_issue or update_issue)."),
    priority: param.number(
      "Priority: 0=none, 1=urgent, 2=high, 3=medium, 4=low (for create_issue or update_issue).",
      { minimum: 0, maximum: 4 },
    ),
    assignee_email: param.string(
      "Assignee email (for create_issue or update_issue). Use to assign/reassign.",
    ),
    due_date: param.date("Due date (for create_issue or update_issue).", { format: "date" }),
    estimate: param.number("Estimate points (for create_issue or update_issue)."),
    labels: param.array("Label names to apply (for create_issue or update_issue)."),
    comment: param.string("Comment body in markdown (for add_comment action)."),
    project: param.string("Project name (for create_issue or update_issue)."),
    since: param.date("Only return issues updated after this timestamp (ISO 8601). For list_issues and my_issues.", { format: "date-time" }),
  },

  config: ["linear.apiKey"],

  handler: async (args, { toolConfig }) => {
    const apiKey = toolConfig.apiKey as string;
    const client = getClient(apiKey);
    const maxResults = args.limit ?? 10;

    switch (args.action) {
      // ── Read actions ──────────────────────────────────────────────

      case "my_issues": {
        const me = await client.viewer;
        const myFilter: Record<string, unknown> = {};
        if (args.status) myFilter.state = { name: { eq: args.status } };
        if (args.since) myFilter.updatedAt = { gte: new Date(args.since) };
        const assigned = await me.assignedIssues({
          first: maxResults,
          filter: Object.keys(myFilter).length > 0 ? myFilter : undefined,
        });
        return formatIssueList(assigned.nodes, `My assigned issues`);
      }

      case "list_issues": {
        const filter: Record<string, unknown> = {};
        if (args.team) filter.team = { key: { eq: args.team } };
        if (args.status) filter.state = { name: { eq: args.status } };
        if (args.since) filter.updatedAt = { gte: new Date(args.since) };

        const issues = await client.issues({
          first: maxResults,
          filter: Object.keys(filter).length > 0 ? filter : undefined,
        });
        const label = args.team ? `Issues for team ${args.team}` : "Issues";
        return formatIssueList(issues.nodes, label);
      }

      case "get_issue": {
        if (!args.issue_id) return "Error: issue_id is required for get_issue action.";
        const issue = await client.issue(args.issue_id);
        const state = await issue.state;
        const assignee = await issue.assignee;
        const proj = await issue.project;
        const issueLabels = await issue.labels();
        const comments = await issue.comments({ first: 5 });

        const lines = [
          `**${issue.identifier}: ${issue.title}**`,
          `Status: ${state?.name ?? "Unknown"}`,
          `Priority: ${priorityLabel(issue.priority)}`,
          assignee ? `Assignee: ${assignee.name}` : "Assignee: Unassigned",
          proj ? `Project: ${proj.name}` : null,
          issueLabels.nodes.length > 0 ? `Labels: ${issueLabels.nodes.map(l => l.name).join(", ")}` : null,
          issue.dueDate ? `Due: ${issue.dueDate}` : null,
          issue.estimate ? `Estimate: ${issue.estimate}` : null,
          "",
          issue.description ?? "_No description._",
        ];

        if (comments.nodes.length > 0) {
          lines.push("", "**Recent comments:**");
          for (const c of comments.nodes) {
            const author = await c.user;
            lines.push(`- ${author?.name ?? "Unknown"}: ${c.body.slice(0, 200)}`);
          }
        }

        return {
          text: lines.filter(l => l !== null).join("\n"),
          data: {
            action: "get_issue",
            identifier: issue.identifier,
            title: issue.title,
            status: state?.name,
            priority: issue.priority,
          },
        };
      }

      case "search": {
        if (!args.query) return "Error: query is required for search action.";
        const results = await client.searchIssues(args.query, { first: maxResults });
        return formatSearchResults(results.nodes, `Search results for "${args.query}"`);
      }

      case "list_projects": {
        const projects = await client.projects({ first: maxResults });
        if (projects.nodes.length === 0) return "No projects found.";

        const lines = projects.nodes.map(p => {
          const progress = p.progress != null ? ` (${Math.round(p.progress * 100)}%)` : "";
          return `- **${p.name}**${progress}: ${p.state}`;
        });
        return {
          text: `**Projects:**\n${lines.join("\n")}`,
          data: {
            action: "list_projects",
            count: projects.nodes.length,
            projects: projects.nodes.map(p => ({ name: p.name, state: p.state, progress: p.progress })),
          },
        };
      }

      case "list_teams": {
        const teams = await client.teams({ first: maxResults });
        if (teams.nodes.length === 0) return "No teams found.";

        const lines = teams.nodes.map(t => `- **${t.name}** (${t.key}): ${t.description ?? "No description"}`);
        return {
          text: `**Teams:**\n${lines.join("\n")}`,
          data: {
            action: "list_teams",
            count: teams.nodes.length,
            teams: teams.nodes.map(t => ({ name: t.name, key: t.key })),
          },
        };
      }

      // ── Write actions ─────────────────────────────────────────────

      case "create_issue": {
        if (!args.title) return "Error: title is required for create_issue.";
        if (!args.team) return "Error: team is required for create_issue.";

        const teams = await client.teams({ filter: { key: { eq: args.team } } });
        const teamNode = teams.nodes[0];
        if (!teamNode) return `Error: team '${args.team}' not found.`;

        const input: { teamId: string; title: string; [k: string]: unknown } = {
          teamId: teamNode.id,
          title: args.title,
        };
        if (args.description) input.description = args.description;
        if (args.priority != null) input.priority = args.priority;
        if (args.due_date) input.dueDate = args.due_date;
        if (args.estimate != null) input.estimate = args.estimate;

        if (args.assignee_email) {
          const userId = await resolveUserByEmail(client, args.assignee_email);
          if (!userId) return `Error: no Linear user found with email '${args.assignee_email}'.`;
          input.assigneeId = userId;
        }

        if (args.status) {
          const stateId = await resolveStateByName(client, teamNode.id, args.status);
          if (!stateId) return `Error: status '${args.status}' not found for team '${args.team}'.`;
          input.stateId = stateId;
        }

        if (args.labels && args.labels.length > 0) {
          const labelIds = await resolveLabelsByName(client, teamNode.id, args.labels as string[]);
          if (labelIds.length > 0) input.labelIds = labelIds;
        }

        if (args.project) {
          const projectId = await resolveProjectByName(client, args.project);
          if (projectId) input.projectId = projectId;
        }

        const result = await client.createIssue(input as Parameters<typeof client.createIssue>[0]);
        const created = await result.issue;
        if (!created) return "Error: failed to create issue.";

        return {
          text: `Created **${created.identifier}**: ${created.title}`,
          data: { action: "create_issue", identifier: created.identifier, title: created.title },
        };
      }

      case "update_issue": {
        if (!args.issue_id) return "Error: issue_id is required for update_issue.";

        const issue = await client.issue(args.issue_id);
        const teamRef = await issue.team;

        const input: Record<string, unknown> = {};
        if (args.title) input.title = args.title;
        if (args.description) input.description = args.description;
        if (args.priority != null) input.priority = args.priority;
        if (args.due_date) input.dueDate = args.due_date;
        if (args.estimate != null) input.estimate = args.estimate;

        if (args.assignee_email) {
          const userId = await resolveUserByEmail(client, args.assignee_email);
          if (!userId) return `Error: no Linear user found with email '${args.assignee_email}'.`;
          input.assigneeId = userId;
        }

        if (args.status && teamRef) {
          const stateId = await resolveStateByName(client, teamRef.id, args.status);
          if (!stateId) return `Error: status '${args.status}' not found.`;
          input.stateId = stateId;
        }

        if (args.labels && args.labels.length > 0 && teamRef) {
          const labelIds = await resolveLabelsByName(client, teamRef.id, args.labels as string[]);
          if (labelIds.length > 0) input.labelIds = labelIds;
        }

        if (args.project) {
          const projectId = await resolveProjectByName(client, args.project);
          if (projectId) input.projectId = projectId;
        }

        if (Object.keys(input).length === 0) return "Error: no fields to update provided.";

        await client.updateIssue(issue.id, input);
        const updated = await client.issue(args.issue_id);
        const newState = await updated.state;

        return {
          text: `Updated **${updated.identifier}**: ${updated.title} [${newState?.name ?? "?"}]`,
          data: { action: "update_issue", identifier: updated.identifier, title: updated.title },
        };
      }

      case "add_comment": {
        if (!args.issue_id) return "Error: issue_id is required for add_comment.";
        if (!args.comment) return "Error: comment is required for add_comment.";

        const issue = await client.issue(args.issue_id);
        await client.createComment({ issueId: issue.id, body: args.comment });

        return {
          text: `Added comment to **${issue.identifier}**: ${args.comment.slice(0, 100)}${args.comment.length > 100 ? "..." : ""}`,
          data: { action: "add_comment", identifier: issue.identifier },
        };
      }

      case "delete_issue": {
        if (!args.issue_id) return "Error: issue_id is required for delete_issue.";

        const issue = await client.issue(args.issue_id);
        const identifier = issue.identifier;
        const issueTitle = issue.title;
        await client.deleteIssue(issue.id);

        return {
          text: `Deleted **${identifier}**: ${issueTitle}`,
          data: { action: "delete_issue", identifier },
        };
      }

      default:
        return `Unknown action: ${args.action}`;
    }
  },
});

// ── Helpers ──────────────────────────────────────────────────────────

type IssueNode = Awaited<ReturnType<LinearClient["issues"]>>["nodes"][number];

async function formatIssueList(nodes: IssueNode[], heading: string) {
  if (nodes.length === 0) return { text: `${heading}: no issues found.`, data: { action: "list", count: 0, issues: [] } };

  const lines: string[] = [];
  const issueData: Record<string, unknown>[] = [];

  for (const issue of nodes) {
    const state = await issue.state;
    const assignee = await issue.assignee;
    const statusStr = state?.name ?? "?";
    const assigneeStr = assignee?.name ?? "Unassigned";
    const due = issue.dueDate ? ` | Due: ${issue.dueDate}` : "";

    lines.push(
      `- **${issue.identifier}**: ${issue.title}  [${statusStr}] (${assigneeStr})${due}`,
    );
    issueData.push({
      identifier: issue.identifier,
      title: issue.title,
      status: statusStr,
      assignee: assigneeStr,
      priority: issue.priority,
      dueDate: issue.dueDate ?? null,
    });
  }

  return {
    text: `**${heading}** (${nodes.length}):\n${lines.join("\n")}`,
    data: { action: "list", count: nodes.length, issues: issueData },
  };
}

async function formatSearchResults(nodes: IssueSearchResult[], heading: string) {
  if (nodes.length === 0) return { text: `${heading}: no issues found.`, data: { action: "search", count: 0, issues: [] } };

  const lines: string[] = [];
  const issueData: Record<string, unknown>[] = [];

  for (const issue of nodes) {
    const state = await issue.state;
    const assignee = await issue.assignee;
    const statusStr = state?.name ?? "?";
    const assigneeStr = assignee?.name ?? "Unassigned";
    const due = issue.dueDate ? ` | Due: ${issue.dueDate}` : "";

    lines.push(
      `- **${issue.identifier}**: ${issue.title}  [${statusStr}] (${assigneeStr})${due}`,
    );
    issueData.push({
      identifier: issue.identifier,
      title: issue.title,
      status: statusStr,
      assignee: assigneeStr,
      priority: issue.priority,
      dueDate: issue.dueDate ?? null,
    });
  }

  return {
    text: `**${heading}** (${nodes.length}):\n${lines.join("\n")}`,
    data: { action: "search", count: nodes.length, issues: issueData },
  };
}

async function resolveUserByEmail(client: LinearClient, email: string): Promise<string | null> {
  const users = await client.users();
  const match = users.nodes.find(u => u.email === email);
  return match?.id ?? null;
}

async function resolveStateByName(client: LinearClient, teamId: string, name: string): Promise<string | null> {
  const states = await client.workflowStates({ filter: { team: { id: { eq: teamId } }, name: { eq: name } } });
  return states.nodes[0]?.id ?? null;
}

async function resolveLabelsByName(client: LinearClient, teamId: string, names: string[]): Promise<string[]> {
  const allLabels = await client.issueLabels({ filter: { team: { id: { eq: teamId } } } });
  const nameSet = new Set(names.map(n => n.toLowerCase()));
  return allLabels.nodes.filter(l => nameSet.has(l.name.toLowerCase())).map(l => l.id);
}

async function resolveProjectByName(client: LinearClient, name: string): Promise<string | null> {
  const projects = await client.projects({ filter: { name: { eq: name } } });
  return projects.nodes[0]?.id ?? null;
}

function priorityLabel(priority: number): string {
  switch (priority) {
    case 0: return "No priority";
    case 1: return "Urgent";
    case 2: return "High";
    case 3: return "Medium";
    case 4: return "Low";
    default: return `${priority}`;
  }
}
