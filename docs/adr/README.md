# Architecture Decision Records

ADRs pin down load-bearing decisions made in
[docs/design.md](../design.md) at a level of detail useful to the
people who will implement and review code. The design doc says *what*
and *why*; ADRs say *exactly how* at the API and audit-log level.

## Lifecycle

- An ADR starts as `Proposed`.
- It moves to `Accepted` after at least one independent review and a
  reference from a Move package, service, or `core/` interface that
  enforces its claims.
- It moves to `Superseded by 00XX` rather than being deleted. The old
  ADR remains as historical context.

## Index

- [0001 — Wallet service boundary: typed transaction intents](0001-wallet-service-boundary.md)
- [0002 — Custodial decrypt logging policy](0002-custodial-decrypt-logging.md)

## Cross-references

ADRs may reference:

- Sections of [docs/design.md](../design.md).
- `.planning/subagents/*.md` integrator sketches.
- ditz issues by id.

If an ADR contradicts the design doc, the ADR is wrong until it has
been explicitly accepted and the design doc has been updated to match.
