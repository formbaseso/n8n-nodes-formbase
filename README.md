# n8n-nodes-formbase

Community nodes for [n8n](https://n8n.io) that create [formbase](https://formbase.so) requests, pause a workflow until a customer completes one, and start workflows when a request is completed, expires or is canceled, or when a form is submitted. formbase collects and verifies information from customers for workflows and AI agents: a workflow creates a request, the recipient completes a branded form without an account, and the verified answers arrive in n8n keyed by stable field keys.

## Features

- **formbase** node: create a request for a form and a recipient, with prefilled and read-only fields, context, reminders, expiry and delivery by email; get, cancel, remind, list requests; replay a request's callback.
- Pause a workflow until the recipient answers: **Wait for the Outcome** points the request's callback at n8n's Wait node, so the workflow resumes with the completed, expired or canceled request as its input.
- **formbase Trigger** node: start a workflow when a request is completed, expires or is canceled, or when a customer submits a form. `data.request` carries the request ID and the caller's `externalId` and `metadata`, so the workflow that created the request can pick up where it left off.
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

## Use the formbase node

Add **formbase** to a workflow, select the **Request** resource and an operation. Every operation returns the formbase response as one item per request, with `pairedItem` set, and honours **Continue on Fail**.

| Operation           | formbase method           | What it does                                                                                                                                                                                                 |
| ------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Create**          | `requests.create`         | Creates a request for a published form. Returns the request summary, including the share link in `url`.                                                                                                     |
| **Get**             | `requests.get`            | Reads one request: status, outcome, recipient, `answers` and `display` once it is completed.                                                                                                                 |
| **Get Many**        | `requests.list`           | Lists the requests of a form or of the whole workspace, newest first, with status, outcome, external ID and test filters. **Return All** follows the cursor across every page; otherwise **Limit** caps it. |
| **Cancel**          | `requests.cancel`         | Cancels a pending request, with an optional reason the recipient sees.                                                                                                                                       |
| **Remind**          | `requests.remind`         | Sends the recipient a reminder email now.                                                                                                                                                                    |
| **Replay Callback** | `requests.replayCallback` | Delivers the callback of a completed, expired or canceled request again, for example after n8n was down.                                                                                                     |

### Create a request

1. Pick the **Form**. The picker lists the published and unpublished forms of the credential's workspace; a request needs a published form.
2. Enter the **Recipient Email** when formbase should email the link or send reminders; leave it empty for a request you hand out yourself.
3. Under **Prefill**, add one entry per field key and value. The key picker loads the form's prefillable fields; turn on **Parse as JSON** for a value that is not plain text, such as a repeating group's rows or a number.
4. Under **Context**, add values for the form's context fields: they are stored with the request and returned with the answers, but the recipient never sees them.
5. Under **Read-Only Fields**, pick the prefilled fields the recipient may see but not change.
6. In **Additional Fields**, set **Delivery** to `Email` to have formbase send the link, **Reminders** such as `2d, 5d` (leave the field empty to send none; remove it to inherit the form's schedule), **Expires At**, **Language**, **Recipient Name**, **Metadata** (a JSON object handed back with every event), **Test Mode**, or a **Callback URL** of your own.
7. Set **External ID** to your own identifier, for example `{{ $execution.id }}`. The node also sends it as the request's `idempotencyKey`, so a retried execution gets the same request back (`deduplicated: true`) instead of creating a second one.

Every request also carries `formId`, `status`, `url`, `externalId`, `isTest`, `deliveryStatus`, `hasCallback`, `remindersSent`, `expiresAt` and `createdAt` in its summary.

### Wait for the outcome

A request is answered minutes or days later. To pause the workflow until then:

1. On the **Create** operation, turn on **Wait for the Outcome**. The node sets the request's callback URL to `{{ $execution.resumeUrl }}`, the URL n8n's Wait node listens on for this execution. Do not set **Callback URL** at the same time; the node refuses the combination.
2. Add a **Wait** node right after it, with **Resume** set to **On Webhook Call** and the HTTP method left at `POST`. The execution pauses here.
3. When the request is completed, expires or is canceled, formbase posts the event envelope to that URL and the execution resumes. The Wait node emits the delivery as one item with the envelope under `$json.body`.
4. Branch on `{{ $json.body.type }}` (`request.completed`, `request.expired` or `request.canceled`) and read the answers from `{{ $json.body.data.answers.<field_key> }}`, the outcome from `{{ $json.body.data.request.outcome }}`, and the request ID from `{{ $json.body.data.request.id }}`.

[`examples/formbase-request-wait.json`](examples/formbase-request-wait.json) shows the whole pattern: formbase **Create** with **Wait for the Outcome** → **Wait** → **Switch** on the event type → **Set** reading the answers.

A resume URL only exists once the execution runs, so the test run of a Create node in the editor waits for a real answer just like a production run. Give the request an **Expires At** or a **Reminders** schedule so a forgotten request does not hold the execution open forever; an expired request resumes the workflow with `request.expired`. If n8n was unreachable when the callback fired, run **Replay Callback** for the request, or read it with **Get**: the resume URL of a finished execution is gone, so a replay only helps while the execution is still waiting.

The Wait node cannot check the `X-formbase-Signature` header that the callback carries. The resume URL is unguessable, which is what n8n relies on for every Wait node; if that is not enough for a workflow, use the trigger node instead, which verifies every delivery.

## Use the trigger

1. Add **formbase Trigger** to a workflow.
2. Select form and event: a request that is completed, expires or is canceled, or a submission that is created or abandoned. For an abandoned-submission event, select how long the response must remain unchanged.
3. For a test execution, select **Listen for Test Event**, then submit the selected form.
4. Activate the workflow. n8n registers its production webhook with formbase and removes it when the workflow is deactivated or deleted.

n8n webhook URL must be publicly reachable over HTTPS. For reverse-proxy or tunnel deployments, configure n8n's `WEBHOOK_URL` so generated webhook URLs use public origin.

n8n generates a separate 256-bit signing secret for each registration. Incoming requests must contain a valid `X-formbase-Signature` header with a timestamp no more than five minutes old. Missing, stale, or invalid signatures receive `401 Unauthorized` and do not start the workflow.

Abandoned-submission timing is enforced by formbase, not n8n. formbase checks incomplete responses hourly and calls the registered n8n webhook after the selected idle window, so delivery can occur up to about one hour after the threshold.

One channel, one event: **Submission Created** runs for share-link submissions only, and a completed request runs **Request Completed** alone, never Submission Created. A workflow that wants every answer, whichever channel produced it, uses one trigger node on each event.

## Example workflows

- [`examples/formbase-request-wait.json`](examples/formbase-request-wait.json): a formbase **Create** node with **Wait for the Outcome**, a **Wait** node, a **Switch** on `request.completed` / `request.expired` / `request.canceled`, and a **Set** node that reads the request ID, outcome and an answer. Connect the credential, pick a form with a `company_name` field (or change the prefill and the Set node), and run it.
- [`examples/formbase-submission.json`](examples/formbase-submission.json): a **formbase Trigger** that maps event ID, event type, submission ID, respondent email, and form name into stable output fields. Connect the credential, select a form, then activate the workflow.

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

A submission event never carries `data.request`: a submission that answered a request arrives as a `request.completed` event instead. A response saved to PDF carries `data.submission.pdfUrl`; it is `null` when no PDF is kept. `test` is `true` for a test delivery, so a workflow can branch on it.

A request event carries the request itself in `data.request`: `id`, `status`, `outcome` (`approve`, `changes` or `decline` when the form has a decision), `externalId`, `metadata`, `context`, `recipient`, `language`, `createdAt` and `completedAt`, `expiredAt` or `canceledAt` (with `cancelReason`). A `request.completed` event also carries `form`, `submission`, `answers` and `display` exactly like a submission event; an expired or canceled request has no answers.

```json
{
  "id": "evt_req123",
  "type": "request.completed",
  "createdAt": "2026-09-22T12:34:56.000Z",
  "apiVersion": "2026-09-22",
  "test": false,
  "data": {
    "request": {
      "id": "req_abc123",
      "status": "completed",
      "outcome": "approve",
      "externalId": "run-42",
      "metadata": { "runId": "run-42" },
      "context": { "case_id": "CASE-9" },
      "recipient": { "email": "ada@acme.com", "name": "Ada" },
      "completedAt": "2026-09-22T12:34:56.000Z"
    },
    "form": { "id": "frm_abc123", "name": "Vendor onboarding", "snapshotId": "snp_..." },
    "submission": { "id": "sub_xyz789", "respondentEmail": "ada@acme.com", "submittedAt": "2026-09-22T12:34:56.000Z", "pdfUrl": null, "language": "en" },
    "answers": { "company_name": "Acme" },
    "display": { "company_name": "Acme" }
  }
}
```

Delivered events use these `type` values:

| `type`                 | Meaning                                                                  |
| ---------------------- | ------------------------------------------------------------------------ |
| `request.completed`    | The recipient completed the request. `data.answers` holds the answers.   |
| `request.expired`      | The request reached its expiry before it was completed.                  |
| `request.canceled`     | The caller canceled the request.                                         |
| `submission.completed` | A respondent completed a new response.                                   |
| `submission.updated`   | An existing completed response changed.                                  |
| `submission.abandoned` | An incomplete response reached the configured idle window.               |

Webhook registration events (`request_completed`, `request_expired`, `request_canceled`, `submission_created` and `submission_abandoned`) select which deliveries trigger the workflow. The event `type` identifies what happened. Use `id` to deduplicate retries; the same values arrive as `X-formbase-Event-Id` and `X-formbase-Event-Type` headers.

Full contracts: [formbase API methods](https://docs.formbase.so/developers/rest-api) and [webhook reference](https://docs.formbase.so/developers/webhooks-reference).

## Develop

```bash
npm ci
npm test
npm run build
npm run lint
```

`npm test` runs unit tests plus lifecycle tests that drive both nodes against an in-process formbase API over real HTTP (`test/fakeFormbase.mts`). `npm run dev` starts n8n with the node loaded and rebuilds on changes. Compiled package files are written to `dist/`. Run `npm pack --dry-run` before publishing to inspect package contents.

## License

MIT
