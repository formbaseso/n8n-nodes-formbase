# n8n-nodes-formbase

Community node for [n8n](https://n8n.io) that starts workflows when a [Formbase](https://formbase.so) form receives a submission.

## Features

- Trigger on completed submissions.
- Trigger on abandoned submissions when partial submission tracking is enabled.
- Load forms dynamically from every workspace available to the credential.
- Register and remove Formbase webhook subscriptions with the n8n workflow lifecycle.
- Connect securely with workspace-scoped Formbase API tokens.

## Install

Open **Settings → Community Nodes**, select **Install**, and enter:

```text
n8n-nodes-formbase
```

Community nodes must be enabled on self-hosted n8n. Installation in n8n Cloud requires a verified community node.

## Configure credentials

1. In Formbase, open **OAuth and API Keys** in the workspace sidebar.
2. Create an API token and copy it immediately. Tokens start with `fb_` and are shown once.
3. In n8n, create a **Formbase API** credential and paste the token.
4. Keep **API Base URL** set to `https://api.formbase.so`.
5. Select **Test**. n8n calls `me.get` to verify the token.

Formbase API tokens expire after 30 days. Rotate the token and update the n8n credential before expiration.

## Use trigger

1. Add **Formbase Trigger** to a workflow.
2. Select form and event.
3. For a test execution, select **Listen for Test Event**, then submit the selected form.
4. Activate the workflow. n8n registers its production webhook with Formbase and removes it when the workflow is deactivated or deleted.

n8n webhook URL must be publicly reachable over HTTPS. For reverse-proxy or tunnel deployments, configure n8n's `WEBHOOK_URL` so generated webhook URLs use public origin.

## Output

Each webhook produces one n8n item containing Formbase payload:

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

Full contracts: [Formbase API methods](https://docs.formbase.so/developers/rest-api) and [webhook reference](https://docs.formbase.so/developers/webhooks-reference).

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
