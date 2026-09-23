# Changelog

All notable changes to this project will be documented here.

## 0.8.0 - 2026-09-23

0.7.0 was never published to npm. 0.8.0 is the first release carrying its changes and the new updated-submission event.

- **Behaviour change:** a workflow on **Public Link Submission Created** no longer runs when a respondent edits a submission they already sent. It now receives `submission.completed` only. To act on edits, add a trigger node on the new **Public Link Submission Updated** event, which subscribes to `submission_updated` and receives `submission.updated`. The form must allow editing after submit. Requests never produce an update event. Needs a formbase backend that accepts the `submission_updated` subscription event (formbase issue #229).
- The submission events are named **Public Link Submission Created**, **Public Link Submission Updated** and **Public Link Submission Abandoned** and cover public-link submissions only. A completed request runs **Request Completed** alone and no longer runs a submission trigger on the same form (formbase ADR 0030, one channel, one event), so a workflow with both triggers runs once per completion, and a submission event never carries `data.request`. A workflow that wants every answer, whichever channel produced it, uses one trigger node on each event.
- Shorter event descriptions.

## 0.6.0 - 2026-09-23

- Add the **formbase** node with the Request resource: **Create** a request for a form and a recipient with prefilled, read-only and context fields, reminders, expiry, language, metadata, test mode and email delivery; **Get**, **Get Many** (cursor paging across a form or the workspace, with status, outcome, external ID and test filters), **Cancel** with a reason, **Remind**, and **Replay Callback**. Form and field-key pickers load from the credential's workspace. The node is usable as an AI agent tool.
- **Wait for the Outcome** on Create points the request's callback at `{{ $execution.resumeUrl }}`, so a Wait node set to *On Webhook Call* pauses the workflow until the request is completed, expires or is canceled, and resumes it with the event envelope under `$json.body`. Setting a Callback URL of your own at the same time is refused.
- Create sends **External ID** as the request's `idempotencyKey`, so a retried execution gets the same request back instead of creating a second one.
- The trigger offers **Request Completed**, **Request Expired** and **Request Canceled** events next to the submission events, registered and verified the same way. A completed request also runs a Submission Created trigger on the same form.
- Add `examples/formbase-request-wait.json`, the create-wait-branch pattern end to end.

## 0.5.1 - 2026-09-23

- Describe the node in terms of requests: it resumes workflows when a customer completes a request or submits a form.

## 0.5.0 - 2026-09-22

- Read the formbase event envelope (`id`, `type`, `createdAt`, `apiVersion`, `test`, `data`) that replaced the flat payload. `fields[]` is gone: every answer arrives once in `data.answers` keyed by field key, with the readable text in `data.display`. Event types are `submission.completed`, `submission.updated` and `submission.abandoned`; the PDF link is `data.submission.pdfUrl`.
- Pass the envelope to the workflow unchanged instead of flattening answers into the item. A field key can therefore never collide with `id`, `type` or `test`, and `{{ $json.data.answers.<field_key> }}` reads the same path the formbase contract documents.
- Carry `data.request` through for a submission that answered a request, and `test` for a test delivery.
- The example workflow maps the new paths.
- Register exactly one subscription per node: activation keeps the subscription it registered last and removes any other n8n subscription for the same webhook URL and event, so a second, unverifiable delivery path never stays open.
- List forms from the workspace the credential is scoped to, across every `forms.list` page, instead of fanning out over workspaces.
- Offer the default event first and idle windows shortest first.

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
