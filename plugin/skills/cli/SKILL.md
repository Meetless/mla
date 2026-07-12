---
name: mla
description: Use when An runs /mla (optionally with a subcommand like activate, doctor, review, ask, kb, rules, enrich, stats), or asks to run the Meetless agent CLI. With no subcommand it runs bare `mla`, which prints the CLI usage (the full command catalog).
---

Run the Meetless agent CLI (`"${CLAUDE_PLUGIN_ROOT}/scripts/resolve-mla"`) and print its output verbatim.

ONE exception, handle it first: if the subcommand is `onboard` (`/mla onboard`), `mla` has no such command. Do NOT run `"${CLAUDE_PLUGIN_ROOT}/scripts/resolve-mla" onboard`. Invoke the `mla-onboard` skill instead; it drives the agent-orchestrated onboarding. Everything below applies to every OTHER subcommand.

The user's text after `/mla` is the subcommand and its arguments. Forward it to `"${CLAUDE_PLUGIN_ROOT}/scripts/resolve-mla"` exactly as given, and nothing more:

- `/mla activate` runs `"${CLAUDE_PLUGIN_ROOT}/scripts/resolve-mla" activate`
- `/mla doctor` runs `"${CLAUDE_PLUGIN_ROOT}/scripts/resolve-mla" doctor`
- `/mla stats --window 7d` runs `"${CLAUDE_PLUGIN_ROOT}/scripts/resolve-mla" stats --window 7d`
- `/mla` with no subcommand runs `"${CLAUDE_PLUGIN_ROOT}/scripts/resolve-mla"` with no arguments (the CLI prints its own usage); do NOT substitute a command.

Rules:

1. Build the command by appending the user's verbatim arguments to `"${CLAUDE_PLUGIN_ROOT}/scripts/resolve-mla"`. Never add, drop, or rewrite an argument. When the user gives no subcommand, run bare `"${CLAUDE_PLUGIN_ROOT}/scripts/resolve-mla"` and let it print usage; do NOT guess a default such as `review`.
2. Do NOT inject any token the user did not type (no `review`, no `latest`, no `by-session`, no flags). The skill is a pure pass-through. It is better to surface the CLI's usage than to run the wrong thing.
3. Run it once via the Bash tool and print the output verbatim. Do not summarize or reformat.
4. If the command exits non-zero, print the captured stderr and suggest running `"${CLAUDE_PLUGIN_ROOT}/scripts/resolve-mla" doctor` to diagnose.
5. The single non-pass-through subcommand is `onboard`: route it to the `mla-onboard` skill (see the exception above). Forward every other subcommand to `"${CLAUDE_PLUGIN_ROOT}/scripts/resolve-mla"` verbatim per rule 1.
6. Onboarding auto-chain (ONLY after `"${CLAUDE_PLUGIN_ROOT}/scripts/resolve-mla" activate`): once you have printed the activate output, scan it for a line that reads exactly `MLA_NEXT: onboard`. If that line is present, activate just provisioned a fresh workspace whose governed memory is empty, and onboarding is the next step. Do NOT ask whether to proceed and do NOT wait for the user: immediately invoke the `mla-onboard` skill (the same flow as `/mla onboard`) to seed the governed memory. If the line is absent, do nothing extra. This is the ONLY subcommand that chains to another skill on its own; every other subcommand still stops after printing output per rule 3.
