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
import { NodeApiError, NodeConnectionTypes } from 'n8n-workflow'

import {
  FORMBASE_IDLE_WINDOW_OPTIONS,
  FORMBASE_OAUTH2_CREDENTIAL_NAME,
  FORMBASE_WEBHOOK_EVENTS,
  isFormbaseIdleWindow,
  type FormbaseIdleWindow,
  type FormbaseWebhookEvent,
} from './constants'
import { createFormbaseWebhookSecret, verifyFormbaseWebhookSignature } from './FormbaseWebhookSignature'
import { formbaseApiRequest } from './GenericFunctions'

interface FormSummary {
  id: string
  name: string
  workspaceId: string
}

interface WorkspaceSummary {
  id: string
  name: string
}

interface ListResponse<T> {
  items: T[]
  hasMore: boolean
  nextCursor?: string | null
}

interface WebhookSubscription {
  subscriptionId: string
  targetUrl: string
  provider: string
  eventType: FormbaseWebhookEvent
  idleWindow?: FormbaseIdleWindow
}

interface WebhookCreateResponse {
  subscriptionId: string
}

const FORMS_PAGE_SIZE = 100

async function listWorkspaceForms(context: ILoadOptionsFunctions, workspace: WorkspaceSummary): Promise<FormSummary[]> {
  const forms: FormSummary[] = []
  let cursor: string | undefined

  do {
    const result = (await formbaseApiRequest.call(context, 'forms.list', {
      workspaceId: workspace.id,
      limit: FORMS_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    })) as ListResponse<FormSummary>

    forms.push(...result.items)
    if (!result.hasMore) break
    if (!result.nextCursor) {
      throw new NodeApiError(context.getNode(), { message: 'formbase returned an incomplete forms page' })
    }
    cursor = result.nextCursor
  } while (cursor)

  return forms
}

function findWebhookSubscription(
  subscriptions: WebhookSubscription[],
  targetUrl: string,
  eventType: FormbaseWebhookEvent,
  idleWindow: FormbaseIdleWindow | undefined
): WebhookSubscription | undefined {
  return subscriptions.find(
    (subscription) =>
      subscription.targetUrl === targetUrl &&
      subscription.provider === 'n8n' &&
      subscription.eventType === eventType &&
      subscription.idleWindow === idleWindow
  )
}

function findWebhookSubscriptionsByIdentity(
  subscriptions: WebhookSubscription[],
  targetUrl: string,
  eventType: FormbaseWebhookEvent
): WebhookSubscription[] {
  return subscriptions.filter(
    (subscription) =>
      subscription.targetUrl === targetUrl && subscription.provider === 'n8n' && subscription.eventType === eventType
  )
}

function getIdleWindow(context: IHookFunctions, eventType: FormbaseWebhookEvent): FormbaseIdleWindow | undefined {
  if (eventType === FORMBASE_WEBHOOK_EVENTS.submissionCreated) return undefined

  const idleWindow = context.getNodeParameter('idleWindow')
  if (!isFormbaseIdleWindow(idleWindow)) {
    throw new NodeApiError(context.getNode(), {
      message: `Idle window must be one of: ${FORMBASE_IDLE_WINDOW_OPTIONS.map((option) => option.value).join(', ')}`,
    })
  }
  return idleWindow
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
      '={{ $parameter["event"] === "submission_created" ? "On submission created" : "On submission abandoned" }}',
    description: 'Starts the workflow when a formbase form receives a submission',
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
      header: 'Listening for formbase submissions',
      executionsHelp: {
        inactive:
          'While building the workflow, click <em>Listen for Test Event</em> and submit the form once. New submissions arrive in real time after the workflow is activated.',
        active:
          'New submissions to the selected form trigger this workflow. The webhook remains registered while the workflow is active.',
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
        options: [
          {
            name: 'Submission Abandoned',
            value: FORMBASE_WEBHOOK_EVENTS.submissionAbandoned,
            action: 'On submission abandoned',
            description:
              'Runs when a respondent leaves the selected form before submitting it; requires partial submission tracking',
          },
          {
            name: 'Submission Created',
            value: FORMBASE_WEBHOOK_EVENTS.submissionCreated,
            action: 'On submission created',
            description: 'Runs when a respondent submits the selected form',
          },
        ],
        default: 'submission_created',
        description: 'Event to subscribe to. Abandoned submissions require partial submission tracking.',
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
        const workspaceResult = (await formbaseApiRequest.call(this, 'workspaces.list', {})) as ListResponse<WorkspaceSummary>
        const formsByWorkspace = await Promise.all(
          workspaceResult.items.map(async (workspace) => ({
            workspace,
            forms: await listWorkspaceForms(this, workspace),
          }))
        )
        const showWorkspaceName = formsByWorkspace.length > 1

        return formsByWorkspace.flatMap(({ workspace, forms }) =>
          forms.map((form) => ({
            name: showWorkspaceName ? `${workspace.name} / ${form.name}` : form.name,
            value: form.id,
          }))
        )
      },
    },
  }

  webhookMethods = {
    default: {
      async checkExists(this: IHookFunctions): Promise<boolean> {
        const webhookUrl = this.getNodeWebhookUrl('default')
        if (!webhookUrl) return false
        const formId = this.getNodeParameter('formId') as string
        if (!formId) return false
        const eventType = this.getNodeParameter('event') as FormbaseWebhookEvent
        const idleWindow = getIdleWindow(this, eventType)

        const webhookData = this.getWorkflowStaticData('node')
        const result = (await formbaseApiRequest.call(this, 'webhooks.list', {
          formId,
        })) as ListResponse<WebhookSubscription>

        const match = findWebhookSubscription(result.items, webhookUrl, eventType, idleWindow)
        const staleMatches = findWebhookSubscriptionsByIdentity(result.items, webhookUrl, eventType).filter(
          (subscription) => subscription.subscriptionId !== match?.subscriptionId
        )
        for (const staleMatch of staleMatches) {
          await formbaseApiRequest.call(this, 'webhooks.delete', {
            subscriptionId: staleMatch.subscriptionId,
          })
        }
        if (!match) {
          clearWebhookRegistration(webhookData)
          return false
        }

        const registrationMatchesStaticData =
          webhookData.subscriptionId === match.subscriptionId && typeof webhookData.webhookSecret === 'string'
        if (registrationMatchesStaticData) return true

        // Existing unsigned or stale registrations cannot be verified. Replace them
        // during activation instead of leaving a second delivery path active.
        await formbaseApiRequest.call(this, 'webhooks.delete', {
          subscriptionId: match.subscriptionId,
        })
        clearWebhookRegistration(webhookData)
        return false
      },

      async create(this: IHookFunctions): Promise<boolean> {
        const webhookUrl = this.getNodeWebhookUrl('default')
        if (!webhookUrl) return false
        const formId = this.getNodeParameter('formId') as string
        const eventType = this.getNodeParameter('event') as FormbaseWebhookEvent
        const idleWindow = getIdleWindow(this, eventType)
        const webhookSecret = createFormbaseWebhookSecret()

        const created = (await formbaseApiRequest.call(this, 'webhooks.create', {
          formId,
          targetUrl: webhookUrl,
          provider: 'n8n',
          eventType,
          ...(idleWindow !== undefined ? { idleWindow } : {}),
          signingSecret: webhookSecret,
        })) as WebhookCreateResponse

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
          await formbaseApiRequest.call(this, 'webhooks.delete', {
            subscriptionId,
          })
        } catch (error: unknown) {
          if (!(error instanceof NodeApiError) || error.httpCode !== '404') {
            return false
          }
        }
        clearWebhookRegistration(webhookData)
        return true
      },
    },
  }

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
