# Security Policy

## Supported Versions

This project is early-stage. Use the latest main branch state.

## Reporting A Security Issue

Do not open a public issue with secrets, API keys, screenshots containing credentials, or private provider exports.

If you find a security problem:

1. Remove any secrets from the reproduction.
2. Share only the affected file, route, or behavior.
3. Rotate any exposed provider keys immediately.

## Secret Handling

- Keep credentials in `.env` or `.env.local`.
- `.env` and `.env.local` are ignored by git.
- Public examples must keep credential values blank.
- API status endpoints should expose only whether a key is configured.
