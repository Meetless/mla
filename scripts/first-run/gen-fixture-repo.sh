#!/usr/bin/env bash
# Generate a small, realistic git repo for the first-run harness to `mla activate`
# against. `activate` scans the repo for material to seed the fresh workspace, so a
# bare `git init` would give it nothing to work with. This writes a README, an
# ARCHITECTURE doc, a CONTRIBUTING doc with EXPLICIT constraints (the kind of
# governance material a real onboarding surfaces), plus a few commits so the history
# has shape. Deterministic on purpose: it is a fixture, not a fuzz target.
#
# Usage: gen-fixture-repo.sh <target-dir>
set -euo pipefail

DIR="${1:?usage: gen-fixture-repo.sh <target-dir>}"
mkdir -p "$DIR"
cd "$DIR"

# Local identity so commits work even in a bare sandbox HOME with no global git cfg.
git init -q
git config user.email "first-run@meetless.local"
git config user.name "First Run Harness"
git config commit.gpgsign false

commit() { git add -A && GIT_COMMITTER_DATE="$2" GIT_AUTHOR_DATE="$2" git commit -q -m "$1"; }

cat > README.md <<'EOF'
# Orders Service

A small service that accepts orders, validates them, and emits an `order.created`
event. Used by the first-run harness as a synthetic activation target.

## What it does
- `POST /orders` validates the payload and persists an order.
- On success it publishes `order.created` to the event bus.
- A nightly job reconciles orders against the ledger.
EOF
commit "docs: initial README for the orders service" "2026-01-05T10:00:00"

cat > ARCHITECTURE.md <<'EOF'
# Architecture

Three components, each with one job:

- **api** validates requests and owns the write path. It NEVER calls the ledger
  directly; it only publishes events.
- **worker** consumes `order.created` and performs downstream effects (email,
  fulfillment). Retries with backoff; idempotent by `orderId`.
- **reconciler** runs nightly, compares orders to the ledger, flags drift.

Data flow: `api -> event bus -> worker`, and separately `reconciler -> ledger`.
The api and the worker share a Postgres INSTANCE but NEVER the same database.
EOF
commit "docs: describe the three-component architecture" "2026-01-06T11:30:00"

cat > CONTRIBUTING.md <<'EOF'
# Contributing — Constraints (read before changing anything)

These are hard rules for this repo. They exist because breaking them has bitten us.

1. **The api MUST NOT talk to the ledger.** All ledger interaction goes through the
   reconciler. If you find yourself importing the ledger client in `api/`, stop.
2. **Every downstream effect MUST be idempotent by `orderId`.** The worker can and
   will receive the same `order.created` event more than once.
3. **Never share a database between api and worker.** A shared Postgres instance is
   fine; a shared database is not. This isolation is load-bearing.
4. **No secrets in the repo.** Config comes from the environment only.
5. **Vietnamese and English are both first-class.** User-facing copy and any NLP
   must handle `vi` and `en`.
EOF
commit "docs: codify the four hard contribution constraints" "2026-01-08T09:15:00"

mkdir -p api worker
cat > api/handler.js <<'EOF'
// POST /orders — validate, persist, then publish order.created.
// Constraint: this file must never import a ledger client (see CONTRIBUTING.md #1).
async function createOrder(req, deps) {
  const order = validate(req.body);        // throws on bad payload
  await deps.orders.insert(order);         // write path owned here
  await deps.bus.publish('order.created', { orderId: order.id });
  return order;
}
module.exports = { createOrder };
EOF
commit "feat(api): create-order handler that publishes order.created" "2026-01-09T14:45:00"

cat > worker/consume.js <<'EOF'
// Consume order.created. Idempotent by orderId (see CONTRIBUTING.md #2): a repeat
// delivery must be a no-op, not a double-effect.
async function onOrderCreated(evt, deps) {
  if (await deps.seen.has(evt.orderId)) return;   // idempotency guard
  await deps.fulfillment.start(evt.orderId);
  await deps.seen.add(evt.orderId);
}
module.exports = { onOrderCreated };
EOF
commit "feat(worker): idempotent order.created consumer" "2026-01-12T16:20:00"

# quiet the "which branch" noise; harmless if it already is main.
git branch -M main 2>/dev/null || true
