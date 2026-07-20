# Decision: webhook retries must use exponential backoff with jitter (supersedes ADR-0007)

- Status: Accepted
- Date: 2026-07-15
- Supersedes: ADR-0007 (fixed 30-second interval, 5 attempts)
- Owner ruling: Platform lead

## Ruling

ADR-0007 is **superseded**. The outbound webhook dispatcher must retry failed
deliveries using **exponential backoff with full jitter**, not a fixed interval:

- Base delay: 1 second.
- Multiplier: 2x per attempt (1s, 2s, 4s, 8s, ...).
- Full jitter: each delay is a random value in `[0, computed_delay]`.
- Delay cap: 300 seconds.
- Maximum attempts: 8, then dead-letter.

The fixed 30-second interval from ADR-0007 is **prohibited** for all new
delivery code.

## Rationale

On 2026-07-14 a downstream partner had a 20-minute outage. Because every failed
delivery retried on the same fixed 30-second cadence, all pending events retried
in lockstep, producing synchronized bursts against the partner the moment it
recovered. That thundering herd extended the incident and tripped their rate
limiter. Exponential backoff with full jitter spreads retries out and removes the
synchronized burst.

## Scope

Applies to every new or modified webhook delivery path. Existing code is migrated
opportunistically; no new code may implement the fixed-interval policy.
