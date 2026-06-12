# Contributing

Contributions are welcome if they improve correctness, source validation, report clarity, or public usability.

## Local Checks

Run this before proposing changes:

```bash
npm test
```

## Rules

- Do not commit secrets, `.env`, downloaded raw data, or private provider exports.
- Do not add report claims that are not supported by a source packet.
- Do not hide missing, stale, conflicted, or single-source inputs.
- Keep the app lightweight unless a dependency clearly pays for itself.
- Add tests for behavior changes.

## Research Quality

Reports should distinguish:

- Internal research draft.
- Validated research memo.
- Investor-ready research.

Investor-ready status requires triangulated valuation, peer/consensus context, sensitivity analysis, source reconciliation, and explicit caveats.
