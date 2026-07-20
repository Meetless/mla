# ADR-0007: Webhook delivery retry policy

- Status: Accepted
- Date: 2026-05-02
- Deciders: Platform team

## Context

The outbound webhook dispatcher delivers events to partner endpoints. Endpoints
fail intermittently, so a delivery that returns a non-2xx (or times out) must be
retried before we give up and dead-letter the event.

## Decision

Retry a failed webhook delivery on a **fixed 30-second interval**, up to **5
attempts** total. After the fifth failed attempt, move the event to the
dead-letter queue and stop.

## Consequences

- Simple to reason about: every retry is exactly 30 seconds after the last.
- No extra dependencies; a single fixed delay constant drives the scheduler.
- Bounded total lifetime: at most ~2 minutes of retrying per event.

> This ADR is the source of truth for how the dispatcher retries. Implement the
> retry loop to match it.
