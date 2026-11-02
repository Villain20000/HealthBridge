# Project Operating Instructions

## OmniMem Persistent Semantic Memory

This project uses **OmniMem** for persistent memory across sessions and tools.

- **Session Start**: Call `briefing(project="HealthBridge")` to review current project state, active patterns, and past abandoned approaches (graveyard).
- **Before Implementing Solutions**: Check `warn_if_abandoned("<library_or_approach>")` and `recall("<topic>")`. Avoid repeating previously abandoned dead ends.
- **Dead Ends**: Record failed/abandoned approaches immediately using `record_abandoned` or `log_abandoned` with the reason and effort score.
- **Session End**: Call `update_project_state("HealthBridge", current_state="...", notes="...")` and save key architectural decisions or patterns with `remember()`.
