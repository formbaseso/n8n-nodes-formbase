# Changelog

All notable changes to this project will be documented here.

## 0.5.0 - 2026-09-22

- Read the formbase event envelope (`id`, `type`, `createdAt`, `apiVersion`, `test`, `data`) that replaced the flat payload. `fields[]` is gone: every answer arrives once in `data.answers` keyed by field key, with the readable text in `data.display`. Event types are `submission.completed`, `submission.updated` and `submission.abandoned`; the PDF link is `data.submission.pdfUrl`.
- Pass the envelope to the workflow unchanged instead of flattening answers into the item. A field key can therefore never collide with `id`, `type` or `test`, and `{{ $json.data.answers.<field_key> }}` reads the same path the formbase contract documents.
- Carry `data.request` through for a submission that answered a request, and `test` for a test delivery.
- The example workflow maps the new paths.
- Register exactly one subscription per node: activation keeps the subscription it registered last and removes any other n8n subscription for the same webhook URL and event, so a second, unverifiable delivery path never stays open.
- List forms from the workspace the credential is scoped to, across every `forms.list` page, instead of fanning out over workspaces.
- Offer the default event first and idle windows shortest first.
- Describe the node in terms of requests: it resumes workflows when a customer completes a request or submits a form.

## 0.4.1 - 2026-07-16

- Allow n8n OAuth credentials to refresh expired access tokens automatically.

## 0.4.0 - 2026-07-16

- Require and persist a selectable idle window for abandoned-submission registrations.
- Surface abandoned deliveries as `ABANDON_RESPONSE` instead of `SUBMIT_RESPONSE`.

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
