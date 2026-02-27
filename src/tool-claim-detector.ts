/**
 * Detects phantom tool claims and ignored tool errors in LLM responses.
 *
 * Phantom claim: the LLM says it performed an action (saved, scheduled, etc.)
 * but never actually called the corresponding tool.
 *
 * Ignored error: the LLM called a tool that returned an error but tells the
 * user the action succeeded.
 */

export interface ToolRecord {
  name: string;
  result: string;
  failed: boolean;
}

// ---------------------------------------------------------------------------
// Claim patterns — map tool names to regex patterns that indicate a claim
// ---------------------------------------------------------------------------

interface ClaimPattern {
  tools: string[];
  pattern: RegExp;
  action: string;
}

const CLAIM_PATTERNS: ClaimPattern[] = [
  {
    tools: ["memory"],
    pattern:
      /\b(saved|stored|remembered|memorized|deleted from memory|forgotten|updated (the |your )?memory|noted that|committed .* to memory)\b/i,
    action: "saved to memory",
  },
  {
    tools: ["notes"],
    pattern:
      /\b(saved (the |a |your )?note|created (a |the )?note|deleted (the |a |your )?note|updated (the |a |your )?note|written .* note)\b/i,
    action: "saved/modified a note",
  },
  {
    tools: ["cron"],
    pattern:
      /\b(scheduled|created (the |a )?(cron |scheduled )?task|updated (the |a )?(cron |scheduled )?task|deleted (the |a )?(cron |scheduled )?task|set up (a |the )?recurring)\b/i,
    action: "managed a scheduled task",
  },
  {
    tools: ["calendar", "google_calendar"],
    pattern:
      /\b(added to (the |your )?calendar|created (the |a |an )?event|removed (the |a |an )?event|deleted (the |a |an )?event|updated (the |a |an )?event|scheduled (the |a |an )?event)\b/i,
    action: "managed a calendar event",
  },
  {
    tools: ["todo", "google_tasks"],
    pattern:
      /\b(added (a |the )?to-?do|created (a |the )?task|completed (the |a )?task|marked .* (as )?(done|complete)|deleted (the |a )?to-?do)\b/i,
    action: "managed a todo/task",
  },
  {
    tools: ["web_search"],
    pattern:
      /\b(searched (for|the web)|found (some )?results|according to my search|here'?s what I found online)\b/i,
    action: "performed a web search",
  },
  {
    tools: ["gmail"],
    pattern:
      /\b(sent (the |a |an |your )?email|drafted (the |a |an )?email|replied to .* email)\b/i,
    action: "sent/drafted an email",
  },
  {
    tools: ["google_docs"],
    pattern:
      /\b(created (a |the )?doc(ument)?|updated (a |the )?doc(ument)?|wrote .* to (the |a )?doc)\b/i,
    action: "managed a Google Doc",
  },
  {
    tools: ["set_mood"],
    pattern:
      /\b(set my mood|changed my mood|updated my mood|shifted (to|into) .* mood)\b/i,
    action: "changed mood",
  },
];

// Generic "I did something" pattern for when zero tool calls were made
const GENERIC_ACTION_CLAIM =
  /\b(i'?ve (done|saved|scheduled|created|deleted|updated|set up|taken care of|completed|handled|processed|recorded|stored|noted) (that|it|this|the|a|your))\b/i;

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export function detectPhantomClaims(
  responseText: string,
  toolRecords: ToolRecord[],
): string | null {
  const calledTools = new Set(toolRecords.map((t) => t.name));
  const failedTools = new Map<string, string>();
  for (const t of toolRecords) {
    if (t.failed) failedTools.set(t.name, t.result);
  }

  const issues: string[] = [];

  for (const claim of CLAIM_PATTERNS) {
    if (!claim.pattern.test(responseText)) continue;

    const wasCalled = claim.tools.some((t) => calledTools.has(t));

    if (!wasCalled) {
      // Phantom claim: response says it did X but never called the tool
      issues.push(
        `You claim you ${claim.action}, but no ${claim.tools.join("/")} tool was called.`,
      );
      continue;
    }

    // Check if any matching tool failed
    for (const toolName of claim.tools) {
      const error = failedTools.get(toolName);
      if (error) {
        issues.push(
          `You claim you ${claim.action}, but the ${toolName} tool returned an error: "${error.slice(0, 200)}"`,
        );
      }
    }
  }

  // Generic check: if zero tools were called and response uses action language
  if (
    toolRecords.length === 0 &&
    issues.length === 0 &&
    GENERIC_ACTION_CLAIM.test(responseText)
  ) {
    issues.push(
      "You claim to have performed an action, but no tools were called during this turn.",
    );
  }

  if (issues.length === 0) return null;

  return (
    "[SYSTEM - CORRECTION REQUIRED]\n" +
    "Your previous response contains inaccurate claims about actions you performed.\n\n" +
    issues.map((iss) => `- ${iss}`).join("\n") +
    "\n\nRewrite your response to accurately reflect what happened. " +
    "If an action failed, tell the user what went wrong and suggest next steps. " +
    "If a tool was not called, do not claim you performed the action."
  );
}
