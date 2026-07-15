# n8n-nodes-formbase

Community node for [n8n](https://n8n.io) that starts workflows when a [formbase](https://formbase.so) form receives a submission.

## Features

- Trigger on completed submissions.
- Trigger on abandoned submissions when partial submission tracking is enabled.
- Load forms dynamically from every workspace available to the credential.
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
2. Select form and event.
3. For a test execution, select **Listen for Test Event**, then submit the selected form.
4. Activate the workflow. n8n registers its production webhook with formbase and removes it when the workflow is deactivated or deleted.

n8n webhook URL must be publicly reachable over HTTPS. For reverse-proxy or tunnel deployments, configure n8n's `WEBHOOK_URL` so generated webhook URLs use public origin.

n8n generates a separate 256-bit signing secret for each registration. Incoming requests must contain a valid `X-formbase-Signature` header with a timestamp no more than five minutes old. Missing, stale, or invalid signatures receive `401 Unauthorized` and do not start the workflow.

## Example workflow

Import [`examples/formbase-submission.json`](examples/formbase-submission.json), connect formbase credential, select form, then activate workflow. Example maps event ID, submission ID, respondent email, and form name into stable output fields.

## Output

Each webhook produces one n8n item containing formbase payload:

```json
{
  "eventId": "evt_abc123",
  "eventType": "SUBMIT_RESPONSE",
  "eventTimestamp": "2026-04-25T12:34:56.000Z",
  "form": {
    "id": "frm_abc123",
    "name": "Customer Feedback"
  },
  "submission": {
    "id": "sub_xyz789",
    "respondentEmail": "respondent@example.com",
    "submittedAt": "2026-04-25T12:34:56.000Z",
    "submissionPdfLink": "https://api.formbase.so/api/storage/...",
    "language": "en"
  },
  "fields": [
    {
      "fieldId": "fld_rating",
      "title": "How likely are you to recommend us?",
      "type": "rating",
      "value": {
        "raw": 9,
        "display": "9"
      }
    }
  ]
}
```

`eventType` is `SUBMIT_RESPONSE` for a new completed or abandoned response and `UPDATE_RESPONSE` when an existing response changes. Use `eventId` to deduplicate retries.

Full contracts: [formbase API methods](https://docs.formbase.so/developers/rest-api) and [webhook reference](https://docs.formbase.so/developers/webhooks-reference).

## Develop

```bash
npm ci
npm test
npm run build
npm run lint
```

`npm run dev` starts n8n with the node loaded and rebuilds on changes. Compiled package files are written to `dist/`. Run `npm pack --dry-run` before publishing to inspect package contents.

## License

MIT
