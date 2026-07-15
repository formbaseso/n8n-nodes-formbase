# Changelog

All notable changes to this project will be documented here.

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
