import type {
  IDataObject,
  IHookFunctions,
  ILoadOptionsFunctions,
  INodePropertyOptions,
  INodeType,
  INodeTypeDescription,
  IWebhookFunctions,
  IWebhookResponseData,
} from 'n8n-workflow'
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow'

import {
  FORMBASE_IDLE_WINDOW_OPTIONS,
  FORMBASE_OAUTH2_CREDENTIAL_NAME,
  FORMBASE_WEBHOOK_EVENTS,
  isFormbaseIdleWindow,
  type FormbaseIdleWindow,
  type FormbaseWebhookEvent,
} from './constants'
import { listForms, type ListResponse } from './FormbaseCatalog'
import { createFormbaseWebhookSecret, verifyFormbaseWebhookSignature } from './FormbaseWebhookSignature'
import { formbaseApiRequest } from './GenericFunctions'

/** One row of `webhooks.list`. */
interface WebhookSubscription {
  subscriptionId: string
  targetUrl: string
  provider: string
  eventType: FormbaseWebhookEvent
  idleWindow?: FormbaseIdleWindow
}

/** What this node wants registered with formbase, read from its parameters. */
interface Registration {
  webhookUrl: string
  formId: string
  eventType: FormbaseWebhookEvent
  idleWindow?: FormbaseIdleWindow
}

/** The registration the node's parameters describe, or null while the node is not configured. */
function readRegistration(context: IHookFunctions): Registration | null {
  const webhookUrl = context.getNodeWebhookUrl('default')
  const formId = context.getNodeParameter('formId') as string
  if (!webhookUrl || !formId) return null

  const eventType = context.getNodeParameter('event') as FormbaseWebhookEvent
  if (eventType !== FORMBASE_WEBHOOK_EVENTS.submissionAbandoned) return { webhookUrl, formId, eventType }

  const idleWindow = context.getNodeParameter('idleWindow')
  if (!isFormbaseIdleWindow(idleWindow)) {
    const allowed = FORMBASE_IDLE_WINDOW_OPTIONS.map((option) => option.value).join(', ')
    throw new NodeOperationError(context.getNode(), `Idle window must be one of: ${allowed}`)
  }
  return { webhookUrl, formId, eventType, idleWindow }
}

/** A subscription this node's URL and event own, whatever its idle window or secret. */
function isOwnSubscription(subscription: WebhookSubscription, registration: Registration): boolean {
  if (subscription.provider !== 'n8n') return false
  if (subscription.targetUrl !== registration.webhookUrl) return false
  return subscription.eventType === registration.eventType
}

/** The subscription this node registered last, still verifiable and still describing the same event. */
function isCurrentRegistration(subscription: WebhookSubscription, registration: Registration, webhookData: IDataObject): boolean {
  if (subscription.subscriptionId !== webhookData.subscriptionId) return false
  if (typeof webhookData.webhookSecret !== 'string') return false
  return subscription.idleWindow === registration.idleWindow
}

function clearWebhookRegistration(webhookData: IDataObject): void {
  delete webhookData.subscriptionId
  delete webhookData.webhookSecret
}

/* eslint-disable @n8n/community-nodes/node-usable-as-tool -- Webhook triggers receive events and have no executable AI-agent action. */
export class FormbaseTrigger implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'formbase Trigger',
    name: 'formbaseTrigger',
    icon: { light: 'file:formbase-logo.svg', dark: 'file:formbase-logo.dark.svg' },
    group: ['trigger'],
    version: 1,
    subtitle:
      '={{ ({ submission_created: "On submission created", submission_abandoned: "On submission abandoned", request_completed: "On request completed", request_expired: "On request expired", request_canceled: "On request canceled" })[$parameter["event"]] }}',
    description:
      'Starts the workflow when a formbase request is completed, expires or is canceled, or when a customer submits a form',
    defaults: {
      name: 'formbase Trigger',
    },
    inputs: [],
    outputs: [NodeConnectionTypes.Main],
    credentials: [
      {
        name: FORMBASE_OAUTH2_CREDENTIAL_NAME,
        required: true,
      },
    ],
    webhooks: [
      {
        name: 'default',
        httpMethod: 'POST',
        responseMode: 'onReceived',
        path: 'formbase',
      },
    ],
    triggerPanel: {
      header: 'Listening for formbase events',
      executionsHelp: {
        inactive:
          'While building the workflow, click <em>Listen for Test Event</em> and submit the form once, or complete, cancel or let a request expire. Events arrive in real time after the workflow is activated.',
        active:
          'Events for the selected form trigger this workflow. The webhook remains registered while the workflow is active.',
      },
      activationHint: 'Activate the workflow to register the webhook with formbase. Deactivating removes it.',
    },
    properties: [
      {
        displayName: 'Form Name or ID',
        name: 'formId',
        type: 'options',
        typeOptions: {
          loadOptionsMethod: 'getForms',
        },
        default: '',
        required: true,
        description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
      },
      {
        displayName: 'Event',
        name: 'event',
        type: 'options',
        // eslint-disable-next-line @n8n/community-nodes/options-sorted-alphabetically -- The default comes first.
        options: [
          {
            name: 'Submission Created',
            value: FORMBASE_WEBHOOK_EVENTS.submissionCreated,
            action: 'On submission created',
            description:
              'Runs when a respondent submits the selected form, and again when a completed submission is edited (event type submission.updated)',
          },
          {
            name: 'Submission Abandoned',
            value: FORMBASE_WEBHOOK_EVENTS.submissionAbandoned,
            action: 'On submission abandoned',
            description:
              'Runs when a respondent leaves the selected form before submitting it; requires partial submission tracking',
          },
          {
            name: 'Request Completed',
            value: FORMBASE_WEBHOOK_EVENTS.requestCompleted,
            action: 'On request completed',
            description:
              'Runs when a recipient completes a request for the selected form, with the answers and the outcome (event type request.completed)',
          },
          {
            name: 'Request Expired',
            value: FORMBASE_WEBHOOK_EVENTS.requestExpired,
            action: 'On request expired',
            description: 'Runs when a request for the selected form reaches its expiry without being completed',
          },
          {
            name: 'Request Canceled',
            value: FORMBASE_WEBHOOK_EVENTS.requestCanceled,
            action: 'On request canceled',
            description: 'Runs when a request for the selected form is canceled, with the reason when one was given',
          },
        ],
        default: 'submission_created',
        description:
          'Event to subscribe to. A completed request also counts as a submission, so a node on Submission Created runs for it too. Abandoned submissions require partial submission tracking.',
      },
      {
        displayName: 'Consider Abandoned After',
        name: 'idleWindow',
        type: 'options',
        displayOptions: {
          show: {
            event: [FORMBASE_WEBHOOK_EVENTS.submissionAbandoned],
          },
        },
        options: [...FORMBASE_IDLE_WINDOW_OPTIONS],
        default: '12h',
        required: true,
        description:
          'Runs after the response has no saved changes for this long. The hourly sweep can add up to about one hour.',
      },
    ],
  }

  methods = {
    loadOptions: {
      async getForms(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
        const forms = await listForms(this)
        return forms.map((form) => ({ name: form.name, value: form.id }))
      },
    },
  }

  webhookMethods = {
    default: {
      /**
       * True when formbase still holds the subscription this node registered.
       * Any other subscription for this node's URL and event — one with no
       * stored secret, a different idle window, or a stale duplicate — is
       * removed rather than left as a second, unverifiable delivery path.
       */
      async checkExists(this: IHookFunctions): Promise<boolean> {
        const registration = readRegistration(this)
        if (!registration) return false

        const webhookData = this.getWorkflowStaticData('node')
        const { items } = await formbaseApiRequest<ListResponse<WebhookSubscription>>(this, 'webhooks.list', {
          formId: registration.formId,
        })

        let current = false
        for (const subscription of items) {
          if (!isOwnSubscription(subscription, registration)) continue
          if (isCurrentRegistration(subscription, registration, webhookData)) {
            current = true
            continue
          }
          await formbaseApiRequest(this, 'webhooks.delete', { subscriptionId: subscription.subscriptionId })
        }

        if (!current) clearWebhookRegistration(webhookData)
        return current
      },

      async create(this: IHookFunctions): Promise<boolean> {
        const registration = readRegistration(this)
        if (!registration) return false

        const webhookSecret = createFormbaseWebhookSecret()
        const created = await formbaseApiRequest<{ subscriptionId: string }>(this, 'webhooks.create', {
          formId: registration.formId,
          targetUrl: registration.webhookUrl,
          provider: 'n8n',
          eventType: registration.eventType,
          ...(registration.idleWindow ? { idleWindow: registration.idleWindow } : {}),
          signingSecret: webhookSecret,
        })

        const webhookData = this.getWorkflowStaticData('node')
        webhookData.subscriptionId = created.subscriptionId
        webhookData.webhookSecret = webhookSecret
        return true
      },

      async delete(this: IHookFunctions): Promise<boolean> {
        const webhookData = this.getWorkflowStaticData('node')
        const subscriptionId = webhookData.subscriptionId
        if (typeof subscriptionId !== 'string') {
          clearWebhookRegistration(webhookData)
          return true
        }

        try {
          await formbaseApiRequest(this, 'webhooks.delete', { subscriptionId })
        } catch (error: unknown) {
          // Already gone on the formbase side is the outcome we wanted.
          if (!(error instanceof NodeApiError) || error.httpCode !== '404') return false
        }
        clearWebhookRegistration(webhookData)
        return true
      },
    },
  }

  /** One item per delivery: the formbase event envelope, untouched, once its signature checks out. */
  async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
    if (!verifyFormbaseWebhookSignature(this)) {
      this.getResponseObject().status(401).send('Unauthorized').end()
      return { noWebhookResponse: true }
    }

    const body: IDataObject = this.getBodyData()
    return {
      workflowData: [this.helpers.returnJsonArray(body)],
    }
  }
}
/* eslint-enable @n8n/community-nodes/node-usable-as-tool */
