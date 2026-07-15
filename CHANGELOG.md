# Changelog

All notable changes to this project will be documented here.

## 0.3.0 - 2026-07-15

- Sign webhook registrations and reject missing, invalid, or stale delivery signatures.
- Disable unsupported AI-tool exposure for webhook trigger.
- Add importable example workflow.

## 0.2.1 - 2026-07-15

- Replace placeholder node and credential icons with the formbase brand mark.
- Show human-readable trigger subtitles and event descriptions.
- Add n8n codex metadata for categories and documentation links.

## 0.2.0 - 2026-07-15

- Replace expiring manual API-key credentials with OAuth 2.1 authorization code + PKCE.
- Register each n8n callback automatically through Dynamic Client Registration.
- Refresh access automatically with rotating workspace-scoped refresh tokens.

## 0.1.0 - 2026-07-15

- Add formbase API token credentials.
- Add completed and abandoned submission triggers.
- Add dynamic workspace and form discovery with pagination.
- Add webhook registration and cleanup for n8n workflow lifecycle events.
- Add formbase Cloud API support.
