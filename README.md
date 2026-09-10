# Corgi work trial — Track 3, Neobank

Business current accounts on an append-only, bitemporal, double-entry ledger.

T0 2026-09-09 17:13 PDT · freeze 2026-09-11 17:13 PDT

Status: scaffolding. See `DECISIONS.md` for the running decision log.

## Integration honesty

Every slot is labelled live or simulated. This table is the source of truth and
is updated as slots land.

| Slot | Provider | Status |
| --- | --- | --- |
| Card issuing | Lithic sandbox | not yet wired |
| KYB / KYC | Persona sandbox | not yet wired |
| Open banking funding | Plaid sandbox | not yet wired |
| ACH rail | Increase sandbox | not yet wired |
| Stablecoin payout | USDC, Base Sepolia | not yet wired |
