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

import { FORMBASE_WEBHOOK_EVENTS, type FormbaseWebhookEvent } from './constants'
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
      throw new NodeApiError(context.getNode(), { message: 'Formbase returned an incomplete forms page' })
    }
    cursor = result.nextCursor
  } while (cursor)

  return forms
}

function findWebhookSubscription(
  subscriptions: WebhookSubscription[],
  targetUrl: string,
  eventType: FormbaseWebhookEvent
): WebhookSubscription | undefined {
  return subscriptions.find(
    (subscription) =>
      subscription.targetUrl === targetUrl && subscription.provider === 'n8n' && subscription.eventType === eventType
  )
}

export class FormbaseTrigger implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Formbase Trigger',
    name: 'formbaseTrigger',
    icon: { light: 'file:formbase.svg', dark: 'file:formbase.dark.svg' },
    group: ['trigger'],
    version: 1,
    subtitle: '={{$parameter["event"]}}',
    description: 'Starts the workflow when a Formbase form receives a submission',
    usableAsTool: true,
    defaults: {
      name: 'Formbase Trigger',
    },
    inputs: [],
    outputs: [NodeConnectionTypes.Main],
    credentials: [
      {
        name: 'formbaseApi',
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
      header: 'Listening for Formbase submissions',
      executionsHelp: {
        inactive:
          'While building the workflow, click <em>Listen for Test Event</em> and submit the form once. New submissions arrive in real time after the workflow is activated.',
        active:
          'New submissions to the selected form trigger this workflow. The webhook remains registered while the workflow is active.',
      },
      activationHint: 'Activate the workflow to register the webhook with Formbase. Deactivating removes it.',
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
          },
          {
            name: 'Submission Created',
            value: FORMBASE_WEBHOOK_EVENTS.submissionCreated,
          },
        ],
        default: 'submission_created',
        description: 'Event to subscribe to. Abandoned submissions require partial submission tracking.',
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

        const webhookData = this.getWorkflowStaticData('node')
        const result = (await formbaseApiRequest.call(this, 'webhooks.list', {
          formId,
        })) as ListResponse<WebhookSubscription>

        const match = findWebhookSubscription(result.items, webhookUrl, eventType)
        if (match) {
          webhookData.subscriptionId = match.subscriptionId
          return true
        }
        return false
      },

      async create(this: IHookFunctions): Promise<boolean> {
        const webhookUrl = this.getNodeWebhookUrl('default')
        if (!webhookUrl) return false
        const formId = this.getNodeParameter('formId') as string
        const eventType = this.getNodeParameter('event') as FormbaseWebhookEvent

        const created = (await formbaseApiRequest.call(this, 'webhooks.create', {
          formId,
          targetUrl: webhookUrl,
          provider: 'n8n',
          eventType,
        })) as WebhookCreateResponse

        const webhookData = this.getWorkflowStaticData('node')
        webhookData.subscriptionId = created.subscriptionId
        return true
      },

      async delete(this: IHookFunctions): Promise<boolean> {
        const webhookData = this.getWorkflowStaticData('node')
        const subscriptionId = webhookData.subscriptionId
        if (typeof subscriptionId !== 'string') return true

        try {
          await formbaseApiRequest.call(this, 'webhooks.delete', {
            subscriptionId,
          })
        } catch (error: unknown) {
          if (!(error instanceof NodeApiError) || error.httpCode !== '404') {
            return false
          }
        }
        delete webhookData.subscriptionId
        return true
      },
    },
  }

  async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
    const body: IDataObject = this.getBodyData()
    return {
      workflowData: [this.helpers.returnJsonArray(body)],
    }
  }
}
