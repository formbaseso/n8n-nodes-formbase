# n8n-nodes-formbase

Community node for [n8n](https://n8n.io) that resumes workflows when a customer completes a [formbase](https://formbase.so) request or submits a form. formbase collects and verifies information from customers for workflows and AI agents: a workflow creates a request, the customer completes a branded form without an account, and the verified answers arrive in n8n keyed by stable field keys.

## Features

- Trigger on completed submissions, including submissions that answer a request. `data.request` carries the request ID and the caller's `externalId` and `metadata`, so the workflow that created the request can resume.
- Trigger on abandoned submissions after a selected 12-hour, 1-day, 3-day, or 1-week idle window.
- Load forms dynamically from the workspace the credential is scoped to, across every page.
- Register and remove formbase webhook subscriptions with the n8n workflow lifecycle.
- Verify every webhook with HMAC-SHA256 and reject stale or forged requests.
- Connect through workspace-scoped OAuth 2.1 with PKCE and automatic refresh-token rotation.

## Install

Open **Settings → Community Nodes**, select **Install**, and enter:

```text
n8n-nodes-formbase
```

Community nodes must be enabled on self-hosted n8n. Installation in n8n Cloud requires a verified community node.

OAuth setup requires n8n 2.30 or newer.

## Configure credentials

1. In n8n, create a **formbase OAuth2 API** credential.
2. Select **Connect my account**.
3. Sign in to formbase, choose workspace, and approve requested API access.
4. Select **Test**. n8n calls `me.get` to verify connection.

n8n registers its exact callback URL with formbase automatically through OAuth Dynamic Client Registration. Access tokens expire after one hour and refresh automatically. Rotating refresh token remains valid while connection is used at least once every 30 days.

Self-hosted n8n must use configured HTTPS public URL for OAuth callback. Loopback HTTP is supported for local development.

## Use trigger

1. Add **formbase Trigger** to a workflow.
2. Select form and event. For an abandoned-submission event, select how long the response must remain unchanged.
3. For a test execution, select **Listen for Test Event**, then submit the selected form.
4. Activate the workflow. n8n registers its production webhook with formbase and removes it when the workflow is deactivated or deleted.

n8n webhook URL must be publicly reachable over HTTPS. For reverse-proxy or tunnel deployments, configure n8n's `WEBHOOK_URL` so generated webhook URLs use public origin.

n8n generates a separate 256-bit signing secret for each registration. Incoming requests must contain a valid `X-formbase-Signature` header with a timestamp no more than five minutes old. Missing, stale, or invalid signatures receive `401 Unauthorized` and do not start the workflow.

Abandoned-submission timing is enforced by formbase, not n8n. formbase checks incomplete responses hourly and calls the registered n8n webhook after the selected idle window, so delivery can occur up to about one hour after the threshold.

## Example workflow

Import [`examples/formbase-submission.json`](examples/formbase-submission.json), connect formbase credential, select form, then activate workflow. Example maps event ID, event type, submission ID, respondent email, and form name into stable output fields.

## Output

Each webhook produces one n8n item containing the formbase event envelope. Every answer appears once in `data.answers`, keyed by field key; `data.display` carries the human-readable text under the same keys:

```json
{
  "id": "evt_abc123",
  "type": "submission.completed",
  "createdAt": "2026-04-25T12:34:56.000Z",
  "apiVersion": "2026-09-22",
  "test": false,
  "data": {
    "form": { "id": "frm_abc123", "name": "Customer Feedback", "snapshotId": "snp_..." },
    "submission": {
      "id": "sub_xyz789",
      "respondentEmail": "respondent@example.com",
      "submittedAt": "2026-04-25T12:34:56.000Z",
      "pdfUrl": null,
      "language": "en"
    },
    "answers": { "recommend": 9, "plan": "pro" },
    "display": { "recommend": "9", "plan": "Pro" }
  }
}
```

Read a value with `{{ $json.data.answers.recommend }}`; the field keys come from `fields.list` (or the form's field Configure menu). A choice answer holds the readable option key (`"pro"`), and `display` holds its label (`"Pro"`). A repeating group is an array of row objects in `answers` and one joined line in `display`.

The node passes the envelope through unchanged — it does not flatten answers into the top level of the item. Nothing is dropped, every key stays where the formbase contract puts it, and a field key can never collide with an envelope key such as `type` or `test`. Map the handful of values a workflow needs with a Set node, as the example workflow does.

A submission that answered a request also carries `data.request` (`id`, and the caller's `externalId` and `metadata` when they were supplied). A response saved to PDF carries `data.submission.pdfUrl`; it is `null` when no PDF is kept. `test` is `true` for a test delivery, so a workflow can branch on it.

Delivered events use these `type` values:

| `type`                  | Meaning                                                    |
| ----------------------- | ---------------------------------------------------------- |
| `submission.completed`  | A respondent completed a new response.                     |
| `submission.updated`    | An existing completed response changed.                    |
| `submission.abandoned`  | An incomplete response reached the configured idle window. |

Webhook registration events (`submission_created` and `submission_abandoned`) select which deliveries trigger the workflow. The event `type` identifies what happened to the response. Use `id` to deduplicate retries; the same values arrive as `X-formbase-Event-Id` and `X-formbase-Event-Type` headers.

Full contracts: [formbase API methods](https://docs.formbase.so/developers/rest-api) and [webhook reference](https://docs.formbase.so/developers/webhooks-reference).

## Develop

```bash
npm ci
npm test
npm run build
npm run lint
```

`npm test` runs unit tests plus a lifecycle test that drives the node against an in-process formbase API over real HTTP (`test/fakeFormbase.mts`). `npm run dev` starts n8n with the node loaded and rebuilds on changes. Compiled package files are written to `dist/`. Run `npm pack --dry-run` before publishing to inspect package contents.

## License

MIT
