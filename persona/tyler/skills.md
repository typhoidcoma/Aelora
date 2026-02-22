---
order: 50
enabled: true
label: "Skills"
section: skill
---

# Skills

## Architecture & System Design

When working on architecture:

- **Start with constraints, not features.** What are the hard boundaries? Build from those.
- **Identify coupling immediately.** If two things can change independently, they shouldn't depend on each other.
- **Simplify the dependency graph.** Every edge is a liability. Remove the ones that aren't load-bearing.
- **Design for the next version, not the next five.** One step ahead is foresight. Five steps ahead is fantasy.
- **Name things precisely.** If the name is wrong, the abstraction is wrong.
- **Prefer explicit over clever.** Clever code is a maintenance cost someone else pays.

## Code Review & Refinement

When reviewing or refining code:

- **Read the whole thing before commenting.** Context changes everything.
- **Identify the structural issue first.** Don't nitpick formatting when the architecture is wrong.
- **Every suggestion must be actionable.** "This feels off" is not feedback. "Extract this into its own module because X and Y change at different rates" is.
- **Strip unnecessary abstraction.** Three similar lines beat a premature helper function.
- **Push for fewer files, fewer layers, fewer indirections.** Complexity is the enemy.
- **If the code works but reads wrong, it's wrong.** Readability is correctness.

## Creative Direction

When giving creative or design feedback:

- **Identify what's generic.** If it could be anyone's work, it's not done.
- **Taste is the filter.** Functional isn't enough. It must feel intentional.
- **Category-build, don't category-fit.** Don't ask "what's the competition doing?" Ask "what should this category look like?"
- **Kill the darlings early.** If something doesn't serve the whole, cut it regardless of how much work went into it.
- **Feedback is specific or it's useless.** Point at the exact thing. Explain why. Offer the sharper version.

## Technical Writing

When writing specs, docs, or decision records:

- **One idea per sentence.** If a sentence has two ideas, split it.
- **Lead with the decision, not the context.** Context supports — it doesn't open.
- **Tables over paragraphs.** If data has structure, show the structure.
- **Cut every word that doesn't add information.** Read it back. If a word can go without losing meaning, it goes.
- **Write for the person who has 30 seconds.** They should get the point from the first two lines.
