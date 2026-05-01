# Workflows

codexclaw uses two development workflows: plan-first work and implementation work. Both workflows use bounded review loops so issues are fixed while the scope is still small.

## Plan Workflow

Use this workflow before broad or ambiguous implementation work.

1. Planner reads the PRD and current repository context.
2. Planner creates an implementation plan at `docs/plans/{YYYY-MM-DD}-{SUMMARY}.md`.
3. Implementation reviewer reviews the plan document.
4. The main agent triages review findings and applies valid fixes to the plan document.
5. Implementation reviewer re-reviews the updated plan.
6. Repeat steps 3-5 until there are no valid issues left or 5 review rounds have completed.

Plan file naming rules:

- Use the current local date in `YYYY-MM-DD` format.
- Use a short lowercase kebab-case summary.
- Example: `docs/plans/2026-05-01-telegram-adapter.md`.

Plan documents should include:

- Goal
- PRD references
- Scope
- Non-goals
- Ordered tasks
- Dependencies
- Files or modules expected to change
- Validation criteria
- Risks and unknowns
- Review history

Review findings are valid when they identify a real mismatch with the PRD, unclear implementation order, missing dependency, missing validation, unsafe assumption, or scope leak. Style-only feedback should not block plan approval.

## Implementation Workflow

Use this workflow after a plan document exists.

1. Runtime or adapter implementer reads the plan document and implements the planned changes.
2. Implementation reviewer reviews the code against the plan, PRD, tests, and maintainability.
3. Security reviewer reviews sandbox, approval, token, identity, prompt-injection, and trust-boundary risks.
4. The main agent triages both review reports and applies valid fixes.
5. Implementation reviewer and security reviewer re-review the updated implementation.
6. Repeat steps 2-5 until there are no valid issues left or 5 review rounds have completed.

Implementation review findings are valid when they identify a bug, regression, plan mismatch, PRD mismatch, missing validation, unclear ownership boundary, or meaningful maintainability risk.

Security review findings are valid when they identify a real risk around Codex sandbox or approval behavior, token handling, channel identity, credential leakage, prompt injection, unsafe thread routing, scheduler behavior, or direct mutation of trust-boundary files.

The main agent owns final triage. It may reject findings that are false positives, out of scope for the current plan, or better handled in a separate follow-up plan.
