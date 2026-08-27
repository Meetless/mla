# Webhook retry implementation
- ADR-0007 specified a fixed 30-second delay and 5 attempts.
- MLA identified an accepted decision that supersedes ADR-0007.
- Implemented exponential full jitter with a 1-second base and 300-second cap.
- Increased the maximum attempts to 8 before dead-lettering.
- Governing citation: `NT:notes/meetless-cli/examples/codex-governed-change/governance/superseding-decision.md`.
