import { createHash } from 'node:crypto'

import type {
  IDataObject,
  IExecuteFunctions,
  ILoadOptionsFunctions,
  INodeExecutionData,
  INodePropertyOptions,
  INodeType,
  INodeTypeDescription,
} from 'n8n-workflow'
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow'

import { FORMBASE_OAUTH2_CREDENTIAL_NAME } from './constants'
import { collectPages, listFields, listForms, readWorkspace, type FormField } from './FormbaseCatalog'
import { formbaseApiRequest } from './GenericFunctions'

type RequestOperation = 'cancel' | 'create' | 'get' | 'getAll' | 'remind' | 'replayCallback'

/** One row of a prefill or context collection: a field key and the value to send under it. */
interface KeyValuePair {
  key?: string
  value?: unknown
  json?: boolean
}

/** One row of the documents collection: a binary field of the input item and where it goes. */
interface DocumentRow {
  binaryProperty?: string
  name?: string
  field?: string
}

/** What `documents.create` answers: the reserved document and the presigned URL its bytes go to. */
interface ReservedDocument {
  id: string
  uploadUrl: string
}

interface CreateAdditionalFields {
  callbackUrl?: string
  delivery?: 'none' | 'email'
  expiresAt?: string
  externalId?: string
  language?: string
  metadata?: unknown
  recipientName?: string
  reminders?: string
  test?: boolean
}

interface ListFilters {
  externalId?: string
  includeTest?: boolean
  outcome?: string
  status?: string
}

function fieldOption(field: FormField): INodePropertyOptions {
  const name = field.title ? `${field.title} (${field.key})` : field.key
  return { name, value: field.key }
}

/** Fields `requests.create` accepts in `prefill`: visible questions, never a context field or a calculated one. */
function isPrefillable(field: FormField): boolean {
  if (field.context === true) return false
  if (field.calculated === true) return false
  return field.prefillable !== false
}

/** The key/value pairs of a prefill or context collection as the object `requests.create` takes. */
function readPairs(context: IExecuteFunctions, parameter: string, itemIndex: number): Record<string, unknown> {
  const collection = context.getNodeParameter(parameter, itemIndex, {}) as { values?: KeyValuePair[] }
  const values: Record<string, unknown> = {}
  for (const pair of collection.values ?? []) {
    if (!pair.key) {
      throw new NodeOperationError(context.getNode(), `Every ${parameter} entry needs a field key`, { itemIndex })
    }
    if (pair.key in values) {
      throw new NodeOperationError(context.getNode(), `Field key "${pair.key}" is listed twice in ${parameter}`, { itemIndex })
    }
    values[pair.key] = pair.json ? parseJsonValue(context, pair.value, `${parameter} value for "${pair.key}"`, itemIndex) : pair.value
  }
  return values
}

/** A JSON-typed parameter, whether n8n handed over its text or an expression already produced the object. */
function parseJsonValue(context: IExecuteFunctions, value: unknown, what: string, itemIndex: number): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    throw new NodeOperationError(context.getNode(), `The ${what} is not valid JSON`, { itemIndex })
  }
}

function readMetadata(context: IExecuteFunctions, metadata: unknown, itemIndex: number): Record<string, unknown> | undefined {
  if (metadata === undefined || metadata === '') return undefined
  const parsed = parseJsonValue(context, metadata, 'metadata', itemIndex)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new NodeOperationError(context.getNode(), 'Metadata must be a JSON object', { itemIndex })
  }
  return parsed as Record<string, unknown>
}

function readExpiresAt(context: IExecuteFunctions, expiresAt: string, itemIndex: number): number {
  const timestamp = Date.parse(expiresAt)
  if (Number.isNaN(timestamp)) {
    throw new NodeOperationError(context.getNode(), `Expires At "${expiresAt}" is not a date`, { itemIndex })
  }
  return timestamp
}

/** `"2d, 5d"` → `["2d", "5d"]`; an empty string is an explicit `[]`, which turns reminders off. */
function readReminders(reminders: string): string[] {
  return reminders
    .split(',')
    .map((offset) => offset.trim())
    .filter((offset) => offset.length > 0)
}

/**
 * The URL n8n resumes this execution on. n8n exposes it to expressions as
 * `$execution.resumeUrl`; a Wait node set to "On webhook call" parks the
 * execution until formbase POSTs the request callback to it.
 */
function readResumeUrl(context: IExecuteFunctions, itemIndex: number): string {
  const resumeUrl = context.evaluateExpression('{{ $execution.resumeUrl }}', itemIndex)
  if (typeof resumeUrl !== 'string' || resumeUrl.length === 0) {
    throw new NodeOperationError(
      context.getNode(),
      'n8n did not provide a resume URL for this execution. Turn off "Wait for the Outcome", or run the workflow where a Wait node set to "On Webhook Call" can resume it.',
      { itemIndex }
    )
  }
  return resumeUrl
}

/**
 * Upload the input item's files named in the documents collection and return
 * the `documents` entries `requests.create` takes. formbase reserves each
 * document with `documents.create` and hands back a presigned URL; the bytes
 * go straight to storage and `requests.create` verifies them against the
 * declared size and sha256.
 */
async function uploadDocuments(
  context: IExecuteFunctions,
  formId: string,
  itemIndex: number
): Promise<Array<Record<string, string>>> {
  const collection = context.getNodeParameter('documents', itemIndex, {}) as { values?: DocumentRow[] }
  const documents: Array<Record<string, string>> = []
  for (const row of collection.values ?? []) {
    const binaryProperty = row.binaryProperty?.trim()
    if (!binaryProperty) {
      throw new NodeOperationError(context.getNode(), 'Every document needs the name of an input binary field', { itemIndex })
    }
    const binary = context.helpers.assertBinaryData(itemIndex, binaryProperty)
    const bytes = await context.helpers.getBinaryDataBuffer(itemIndex, binaryProperty)
    const name = row.name?.trim() || binary.fileName
    if (!name) {
      throw new NodeOperationError(context.getNode(), `The file in "${binaryProperty}" has no file name; set a Name for it`, { itemIndex })
    }

    const reserved = await formbaseApiRequest<ReservedDocument>(context, 'documents.create', {
      formId,
      name,
      contentType: binary.mimeType,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
    await context.helpers.httpRequest({
      method: 'PUT',
      url: reserved.uploadUrl,
      body: bytes,
      headers: { 'Content-Type': binary.mimeType },
    })
    documents.push({ documentId: reserved.id, ...(row.field ? { field: row.field } : {}) })
  }
  return documents
}

/** The `requests.create` params the node's parameters describe for one item. */
async function buildCreateParams(context: IExecuteFunctions, itemIndex: number): Promise<Record<string, unknown>> {
  const formId = context.getNodeParameter('formId', itemIndex) as string
  const recipientEmail = context.getNodeParameter('recipientEmail', itemIndex, '') as string
  const readonly = context.getNodeParameter('readonly', itemIndex, []) as string[]
  const waitForOutcome = context.getNodeParameter('waitForOutcome', itemIndex, false) as boolean
  const additional = context.getNodeParameter('additionalFields', itemIndex, {}) as CreateAdditionalFields

  if (waitForOutcome && additional.callbackUrl) {
    throw new NodeOperationError(
      context.getNode(),
      '"Wait for the Outcome" already sets the callback URL. Turn it off to use a Callback URL of your own.',
      { itemIndex }
    )
  }
  const callbackUrl = waitForOutcome ? readResumeUrl(context, itemIndex) : additional.callbackUrl

  const prefill = readPairs(context, 'prefill', itemIndex)
  const requestContext = readPairs(context, 'context', itemIndex)
  const metadata = readMetadata(context, additional.metadata, itemIndex)
  const expiresAt = additional.expiresAt ? readExpiresAt(context, additional.expiresAt, itemIndex) : undefined
  // Last, so a parameter mistake above never leaves an uploaded document behind.
  const documents = await uploadDocuments(context, formId, itemIndex)
  const recipient = {
    ...(recipientEmail ? { email: recipientEmail } : {}),
    ...(additional.recipientName ? { name: additional.recipientName } : {}),
  }

  return {
    formId,
    ...(Object.keys(recipient).length > 0 ? { recipient } : {}),
    ...(Object.keys(prefill).length > 0 ? { prefill } : {}),
    ...(Object.keys(requestContext).length > 0 ? { context: requestContext } : {}),
    ...(readonly.length > 0 ? { readonly } : {}),
    ...(documents.length > 0 ? { documents } : {}),
    ...(additional.language ? { language: additional.language } : {}),
    ...(additional.delivery ? { delivery: additional.delivery } : {}),
    ...(additional.reminders !== undefined ? { reminders: readReminders(additional.reminders) } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(additional.externalId ? { externalId: additional.externalId, idempotencyKey: additional.externalId } : {}),
    ...(metadata ? { metadata } : {}),
    ...(callbackUrl ? { callbackUrl } : {}),
    ...(additional.test ? { test: true } : {}),
  }
}

async function listRequests(context: IExecuteFunctions, itemIndex: number): Promise<IDataObject[]> {
  const returnAll = context.getNodeParameter('returnAll', itemIndex) as boolean
  const max = returnAll ? Number.POSITIVE_INFINITY : (context.getNodeParameter('limit', itemIndex) as number)
  const scope = context.getNodeParameter('scope', itemIndex) as 'form' | 'workspace'
  const filters = context.getNodeParameter('filters', itemIndex, {}) as ListFilters

  const scopeParams =
    scope === 'form'
      ? { formId: context.getNodeParameter('formId', itemIndex) as string }
      : { workspaceId: (await readWorkspace(context)).id }

  return collectPages<IDataObject>(
    context,
    'requests.list',
    {
      ...scopeParams,
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.outcome ? { outcome: filters.outcome } : {}),
      ...(filters.externalId ? { externalId: filters.externalId } : {}),
      ...(filters.includeTest ? { includeTest: true } : {}),
    },
    max
  )
}

async function runOperation(
  context: IExecuteFunctions,
  operation: RequestOperation,
  itemIndex: number
): Promise<IDataObject | IDataObject[]> {
  if (operation === 'create') {
    return formbaseApiRequest<IDataObject>(context, 'requests.create', await buildCreateParams(context, itemIndex))
  }
  if (operation === 'getAll') return listRequests(context, itemIndex)

  const requestId = context.getNodeParameter('requestId', itemIndex) as string
  if (operation === 'get') return formbaseApiRequest<IDataObject>(context, 'requests.get', { requestId })
  if (operation === 'remind') return formbaseApiRequest<IDataObject>(context, 'requests.remind', { requestId })
  if (operation === 'replayCallback') {
    return formbaseApiRequest<IDataObject>(context, 'requests.replayCallback', { requestId })
  }
  if (operation === 'cancel') {
    const reason = context.getNodeParameter('reason', itemIndex, '') as string
    return formbaseApiRequest<IDataObject>(context, 'requests.cancel', { requestId, ...(reason ? { reason } : {}) })
  }
  throw new NodeOperationError(context.getNode(), `The operation "${String(operation)}" is not supported`, { itemIndex })
}

const REQUEST_ID_OPERATIONS: RequestOperation[] = ['cancel', 'get', 'remind', 'replayCallback']

export class Formbase implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'formbase',
    name: 'formbase',
    icon: { light: 'file:formbase-logo.svg', dark: 'file:formbase-logo.dark.svg' },
    group: ['transform'],
    version: 1,
    subtitle: '={{ $parameter["operation"] + ": " + $parameter["resource"] }}',
    description: 'Create, read, cancel and remind formbase requests, and pause a workflow until a customer completes one',
    defaults: {
      name: 'formbase',
    },
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    usableAsTool: true,
    credentials: [
      {
        name: FORMBASE_OAUTH2_CREDENTIAL_NAME,
        required: true,
      },
    ],
    properties: [
      {
        displayName: 'Resource',
        name: 'resource',
        type: 'options',
        noDataExpression: true,
        options: [
          {
            name: 'Request',
            value: 'request',
          },
        ],
        default: 'request',
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: {
          show: {
            resource: ['request'],
          },
        },
        options: [
          {
            name: 'Cancel',
            value: 'cancel',
            action: 'Cancel a request',
            description: 'Withdraw a pending request so its link stops working',
          },
          {
            name: 'Create',
            value: 'create',
            action: 'Create a request',
            description: 'Ask one recipient to complete a published form',
          },
          {
            name: 'Get',
            value: 'get',
            action: 'Get a request',
            description: 'Read a request, with its answers once it is completed',
          },
          {
            name: 'Get Many',
            value: 'getAll',
            action: 'Get many requests',
            description: 'List the requests of a form or of the workspace',
          },
          {
            name: 'Remind',
            value: 'remind',
            action: 'Remind a request recipient',
            description: 'Email the recipient a reminder now, outside the reminder schedule',
          },
          {
            name: 'Replay Callback',
            value: 'replayCallback',
            action: 'Replay a request callback',
            description: 'Send the callback of a completed, expired or canceled request again',
          },
        ],
        default: 'create',
      },

      // Create
      {
        displayName: 'Form Name or ID',
        name: 'formId',
        type: 'options',
        typeOptions: {
          loadOptionsMethod: 'getForms',
        },
        displayOptions: {
          show: {
            resource: ['request'],
            operation: ['create'],
          },
        },
        default: '',
        required: true,
        description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
      },
      {
        displayName: 'Recipient Email',
        name: 'recipientEmail',
        type: 'string',
        placeholder: 'name@email.com',
        displayOptions: {
          show: {
            resource: ['request'],
            operation: ['create'],
          },
        },
        default: '',
        description: 'Who the request is for. Needed to send the invitation email and reminders.',
      },
      {
        displayName: 'Prefill',
        name: 'prefill',
        type: 'fixedCollection',
        placeholder: 'Add Answer',
        typeOptions: {
          multipleValues: true,
        },
        displayOptions: {
          show: {
            resource: ['request'],
            operation: ['create'],
          },
        },
        default: {},
        description: 'Initial answers the recipient sees, keyed by field key',
        options: [
          {
            name: 'values',
            displayName: 'Answer',
            values: [
              {
                displayName: 'Field Name or ID',
                name: 'key',
                type: 'options',
                typeOptions: {
                  loadOptionsMethod: 'getPrefillKeys',
                  loadOptionsDependsOn: ['formId'],
                },
                default: '',
                description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
              },
              {
                displayName: 'Value',
                name: 'value',
                type: 'string',
                default: '',
                description: 'Sent as text, or as the value it decodes to when Parse as JSON is on',
              },
              {
                displayName: 'Parse as JSON',
                name: 'json',
                type: 'boolean',
                default: false,
                description:
                  'Whether to decode the value as JSON: a number, true or false, a list of option keys, a matrix object or the rows of a repeating group',
              },
            ],
          },
        ],
      },
      {
        displayName: 'Context',
        name: 'context',
        type: 'fixedCollection',
        placeholder: 'Add Context Value',
        typeOptions: {
          multipleValues: true,
        },
        displayOptions: {
          show: {
            resource: ['request'],
            operation: ['create'],
          },
        },
        default: {},
        description: 'Hidden-field values the recipient never sees or edits, keyed by field key and echoed in every callback',
        options: [
          {
            name: 'values',
            displayName: 'Context Value',
            values: [
              {
                displayName: 'Field Name or ID',
                name: 'key',
                type: 'options',
                typeOptions: {
                  loadOptionsMethod: 'getContextKeys',
                  loadOptionsDependsOn: ['formId'],
                },
                default: '',
                description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
              },
              {
                displayName: 'Value',
                name: 'value',
                type: 'string',
                default: '',
                description: 'Sent as text, or as the value it decodes to when Parse as JSON is on',
              },
              {
                displayName: 'Parse as JSON',
                name: 'json',
                type: 'boolean',
                default: false,
                description: 'Whether to decode the value as JSON instead of sending it as text',
              },
            ],
          },
        ],
      },
      {
        displayName: 'Read-Only Field Names or IDs',
        name: 'readonly',
        type: 'multiOptions',
        typeOptions: {
          loadOptionsMethod: 'getPrefillKeys',
          loadOptionsDependsOn: ['formId'],
        },
        displayOptions: {
          show: {
            resource: ['request'],
            operation: ['create'],
          },
        },
        default: [],
        description:
          'Prefilled fields the recipient may see but not change. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
      },
      {
        displayName: 'Documents',
        name: 'documents',
        type: 'fixedCollection',
        placeholder: 'Add Document',
        typeOptions: {
          multipleValues: true,
        },
        displayOptions: {
          show: {
            resource: ['request'],
            operation: ['create'],
          },
        },
        default: {},
        description:
          'Files from the input item the recipient gets in the form\'s Documents block, below the documents the form already has. PDF or image, up to 25 MB each.',
        options: [
          {
            name: 'values',
            displayName: 'Document',
            values: [
              {
                displayName: 'Input Binary Field',
                name: 'binaryProperty',
                type: 'string',
                default: 'data',
                required: true,
                hint: 'The name of the input binary field containing the file',
              },
              {
                displayName: 'Name',
                name: 'name',
                type: 'string',
                default: '',
                description: 'The name the recipient sees. Defaults to the file name.',
              },
              {
                displayName: 'Documents Block Name or ID',
                name: 'field',
                type: 'options',
                typeOptions: {
                  loadOptionsMethod: 'getDocumentsKeys',
                  loadOptionsDependsOn: ['formId'],
                },
                default: '',
                description:
                  'The Documents block the file goes into. Leave empty when the form has one. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
              },
            ],
          },
        ],
      },
      {
        displayName: 'Wait for the Outcome',
        name: 'waitForOutcome',
        type: 'boolean',
        displayOptions: {
          show: {
            resource: ['request'],
            operation: ['create'],
          },
        },
        default: false,
        description:
          'Whether to point the request callback at this execution\'s resume URL. Follow this node with a Wait node set to "On Webhook Call": the workflow resumes with the request event when the request is completed, expires or is canceled.',
      },
      {
        displayName: 'Additional Fields',
        name: 'additionalFields',
        type: 'collection',
        placeholder: 'Add Field',
        displayOptions: {
          show: {
            resource: ['request'],
            operation: ['create'],
          },
        },
        default: {},
        options: [
          {
            displayName: 'Callback URL',
            name: 'callbackUrl',
            type: 'string',
            default: '',
            description:
              'An HTTPS URL of your own that receives the signed request callback. Leave empty when Wait for the Outcome is on.',
          },
          {
            displayName: 'Delivery',
            name: 'delivery',
            type: 'options',
            options: [
              {
                name: 'Email the Invitation',
                value: 'email',
                description: 'Sends the recipient the link by email; needs a recipient email',
              },
              {
                name: 'None',
                value: 'none',
                description: 'You deliver the returned link yourself',
              },
            ],
            default: 'none',
          },
          {
            displayName: 'Expires At',
            name: 'expiresAt',
            type: 'dateTime',
            default: '',
            description: 'When the link stops working. Defaults to 30 days, at most 365.',
          },
          {
            displayName: 'External ID',
            name: 'externalId',
            type: 'string',
            default: '',
            description:
              'Your ID for this request, such as the run or ticket it belongs to. Also used as the idempotency key, so a retried run reuses the request instead of creating a second one.',
          },
          {
            displayName: 'Language',
            name: 'language',
            type: 'string',
            default: '',
            placeholder: 'en',
            description: 'Language the form opens in and the invitation is written in; must be published for the form',
          },
          {
            displayName: 'Metadata',
            name: 'metadata',
            type: 'json',
            default: '{}',
            description: 'JSON object for your own bookkeeping. Never shown to the recipient, echoed in every callback.',
          },
          {
            displayName: 'Recipient Name',
            name: 'recipientName',
            type: 'string',
            default: '',
          },
          {
            displayName: 'Reminders',
            name: 'reminders',
            type: 'string',
            default: '',
            placeholder: '2d, 5d',
            description:
              'Idle offsets after which to remind the recipient, comma-separated, at most five. Leave empty to send no reminders; remove the field to inherit the form\'s schedule.',
          },
          {
            displayName: 'Test Mode',
            name: 'test',
            type: 'boolean',
            default: false,
            description:
              'Whether to create a test request: nothing is emailed, the callback carries test: true, and nothing counts against the quota',
          },
        ],
      },

      // Cancel, Get, Remind, Replay Callback
      {
        displayName: 'Request ID',
        name: 'requestId',
        type: 'string',
        displayOptions: {
          show: {
            resource: ['request'],
            operation: REQUEST_ID_OPERATIONS,
          },
        },
        default: '',
        required: true,
        description: 'The ID formbase returned when the request was created',
      },
      {
        displayName: 'Reason',
        name: 'reason',
        type: 'string',
        displayOptions: {
          show: {
            resource: ['request'],
            operation: ['cancel'],
          },
        },
        default: '',
        description: 'Why the request is withdrawn; echoed in the request.canceled callback',
      },

      // Get Many
      {
        displayName: 'Return All',
        name: 'returnAll',
        type: 'boolean',
        displayOptions: {
          show: {
            resource: ['request'],
            operation: ['getAll'],
          },
        },
        default: false,
        description: 'Whether to return all results or only up to a given limit',
      },
      {
        displayName: 'Limit',
        name: 'limit',
        type: 'number',
        typeOptions: {
          minValue: 1,
        },
        displayOptions: {
          show: {
            resource: ['request'],
            operation: ['getAll'],
            returnAll: [false],
          },
        },
        default: 50,
        description: 'Max number of results to return',
      },
      {
        displayName: 'Scope',
        name: 'scope',
        type: 'options',
        displayOptions: {
          show: {
            resource: ['request'],
            operation: ['getAll'],
          },
        },
        options: [
          {
            name: 'Form',
            value: 'form',
            description: 'The requests of one form',
          },
          {
            name: 'Workspace',
            value: 'workspace',
            description: 'Every request of the connected workspace',
          },
        ],
        default: 'form',
      },
      {
        displayName: 'Form Name or ID',
        name: 'formId',
        type: 'options',
        typeOptions: {
          loadOptionsMethod: 'getForms',
        },
        displayOptions: {
          show: {
            resource: ['request'],
            operation: ['getAll'],
            scope: ['form'],
          },
        },
        default: '',
        required: true,
        description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
      },
      {
        displayName: 'Filters',
        name: 'filters',
        type: 'collection',
        placeholder: 'Add Filter',
        displayOptions: {
          show: {
            resource: ['request'],
            operation: ['getAll'],
          },
        },
        default: {},
        options: [
          {
            displayName: 'External ID',
            name: 'externalId',
            type: 'string',
            default: '',
            description: 'Only the requests created with this external ID',
          },
          {
            displayName: 'Include Test Requests',
            name: 'includeTest',
            type: 'boolean',
            default: false,
            description: 'Whether to include requests created in test mode',
          },
          {
            displayName: 'Outcome',
            name: 'outcome',
            type: 'options',
            options: [
              {
                name: 'Approve',
                value: 'approve',
              },
              {
                name: 'Changes',
                value: 'changes',
              },
              {
                name: 'Decline',
                value: 'decline',
              },
            ],
            default: 'approve',
            description: 'Only completed requests with this verdict from the decision question; takes precedence over Status',
          },
          {
            displayName: 'Status',
            name: 'status',
            type: 'options',
            options: [
              {
                name: 'Canceled',
                value: 'canceled',
              },
              {
                name: 'Completed',
                value: 'completed',
              },
              {
                name: 'Expired',
                value: 'expired',
              },
              {
                name: 'Pending',
                value: 'pending',
              },
            ],
            default: 'pending',
          },
        ],
      },
    ],
  }

  methods = {
    loadOptions: {
      async getForms(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
        const forms = await listForms(this)
        return forms.map((form) => ({ name: form.name, value: form.id }))
      },

      async getPrefillKeys(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
        const formId = this.getCurrentNodeParameter('formId')
        if (typeof formId !== 'string' || !formId) return []
        const fields = await listFields(this, formId)
        return fields.filter(isPrefillable).map(fieldOption)
      },

      async getDocumentsKeys(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
        const formId = this.getCurrentNodeParameter('formId')
        if (typeof formId !== 'string' || !formId) return []
        const fields = await listFields(this, formId)
        return fields.filter((field) => field.type === 'documents').map(fieldOption)
      },

      async getContextKeys(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
        const formId = this.getCurrentNodeParameter('formId')
        if (typeof formId !== 'string' || !formId) return []
        const fields = await listFields(this, formId)
        return fields.filter((field) => field.context === true).map(fieldOption)
      },
    },
  }

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData()
    const returnData: INodeExecutionData[] = []
    const operation = this.getNodeParameter('operation', 0) as RequestOperation

    for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
      try {
        const data = await runOperation(this, operation, itemIndex)
        returnData.push(
          ...this.helpers.constructExecutionMetaData(this.helpers.returnJsonArray(data), { itemData: { item: itemIndex } })
        )
      } catch (error) {
        if (this.continueOnFail()) {
          const message = error instanceof Error ? error.message : String(error)
          returnData.push({ json: { error: message }, pairedItem: { item: itemIndex } })
          continue
        }
        // formbase errors already carry their code and message; anything else gets the failing item.
        const known = error instanceof NodeApiError || error instanceof NodeOperationError
        throw known ? error : new NodeOperationError(this.getNode(), error as Error, { itemIndex })
      }
    }

    return [returnData]
  }
}
