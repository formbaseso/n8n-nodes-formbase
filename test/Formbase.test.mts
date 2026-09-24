import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { NodeApiError, NodeOperationError } from 'n8n-workflow'

vi.mock('../nodes/Formbase/GenericFunctions', () => ({
  formbaseApiRequest: vi.fn(),
}))

import { formbaseApiRequest } from '../nodes/Formbase/GenericFunctions'
import { Formbase } from '../nodes/Formbase/Formbase.node'

const mockedRequest = formbaseApiRequest as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  mockedRequest.mockReset()
})

const NODE = { name: 'formbase', type: 'formbase', typeVersion: 1 }
const RESUME_URL = 'https://n8n.example/webhook-waiting/123'

function respond(handler: (method: string, params: Record<string, unknown>) => unknown) {
  mockedRequest.mockImplementation((_context: unknown, method: string, params: Record<string, unknown> = {}) =>
    Promise.resolve(handler(method, params))
  )
}

function calledWith(method: string, params: Record<string, unknown>) {
  return expect(mockedRequest).toHaveBeenCalledWith(expect.anything(), method, params)
}

/** The params of the one `method` call, so a test can assert on what the node sent. */
function sentParams(method: string): Record<string, unknown> {
  const call = mockedRequest.mock.calls.find((candidate) => candidate[1] === method)
  if (!call) throw new Error(`${method} was not called`)
  return call[2] as Record<string, unknown>
}

/**
 * An IExecuteFunctions stand-in: one item per entry of `parameters`, each
 * entry naming the node parameters for that item.
 */
interface ExecuteOptions {
  resumeUrl?: string
  continueOnFail?: boolean
  /** Binary fields of every input item, by field name. */
  binary?: Record<string, { mimeType: string; fileName?: string; bytes: Buffer }>
}

function makeExecuteContext(parameters: Array<Record<string, unknown>>, options: ExecuteOptions = {}) {
  const binaryField = (name: string) => {
    const file = options.binary?.[name]
    if (!file) throw new NodeOperationError(NODE as never, `This operation expects the node's input data to contain a binary file '${name}'`)
    return file
  }
  return {
    getInputData: vi.fn().mockReturnValue(parameters.map(() => ({ json: {} }))),
    getNodeParameter: vi.fn((name: string, itemIndex: number, fallback?: unknown) => {
      const value = parameters[itemIndex]?.[name]
      return value === undefined ? fallback : value
    }),
    evaluateExpression: vi.fn((expression: string) => (expression === '{{ $execution.resumeUrl }}' ? options.resumeUrl : undefined)),
    continueOnFail: vi.fn().mockReturnValue(options.continueOnFail ?? false),
    getNode: vi.fn().mockReturnValue(NODE),
    helpers: {
      assertBinaryData: vi.fn((_itemIndex: number, name: string) => {
        const { mimeType, fileName } = binaryField(name)
        return { mimeType, fileName, data: '' }
      }),
      getBinaryDataBuffer: vi.fn(async (_itemIndex: number, name: string) => binaryField(name).bytes),
      httpRequest: vi.fn().mockResolvedValue(''),
      returnJsonArray: (input: unknown) => (Array.isArray(input) ? input : [input]).map((json) => ({ json })),
      constructExecutionMetaData: (items: Array<{ json: unknown }>, { itemData }: { itemData: { item: number } }) =>
        items.map((item) => ({ ...item, pairedItem: itemData })),
    },
  }
}

function makeLoadOptionsContext(currentParameters: Record<string, unknown> = {}) {
  return {
    getNode: vi.fn().mockReturnValue(NODE),
    getCurrentNodeParameter: vi.fn((name: string) => currentParameters[name]),
  }
}

async function run(parameters: Array<Record<string, unknown>>, options?: ExecuteOptions) {
  const ctx = makeExecuteContext(parameters, options)
  const [items] = await new Formbase().execute.call(ctx as never)
  return items
}

async function runWithContext(parameters: Array<Record<string, unknown>>, options?: ExecuteOptions) {
  const ctx = makeExecuteContext(parameters, options)
  const [items] = await new Formbase().execute.call(ctx as never)
  return { items, ctx }
}

const CREATE = { resource: 'request', operation: 'create', formId: 'form_1' }

describe('formbase node description', () => {
  it('uses lowercase formbase branding and is usable as an AI tool', () => {
    const node = new Formbase()

    expect(node.description.displayName).toBe('formbase')
    expect(node.description.name).toBe('formbase')
    expect(node.description.description).toContain('formbase')
    expect(node.description.description).not.toContain('Formbase')
    expect(node.description.usableAsTool).toBe(true)
    expect(node.description.icon).toEqual({ light: 'file:formbase-logo.svg', dark: 'file:formbase-logo.dark.svg' })
    expect(node.description.credentials).toEqual([{ name: 'formbaseOAuth2Api', required: true }])
  })

  it('offers the Request resource with its six operations', () => {
    const node = new Formbase()
    const resource = node.description.properties.find((property) => property.name === 'resource')
    const operation = node.description.properties.find((property) => property.name === 'operation')

    expect(resource?.options).toEqual([{ name: 'Request', value: 'request' }])
    expect(operation?.options?.map((option) => 'value' in option && option.value)).toEqual([
      'cancel',
      'create',
      'get',
      'getAll',
      'remind',
      'replayCallback',
    ])
    expect(operation?.default).toBe('create')
  })

  it('loads prefill and context keys per selected form', () => {
    const node = new Formbase()
    const prefill = node.description.properties.find((property) => property.name === 'prefill')
    const context = node.description.properties.find((property) => property.name === 'context')
    const readonly = node.description.properties.find((property) => property.name === 'readonly')
    const keyOf = (collection: typeof prefill) => collection?.options?.[0] && 'values' in collection.options[0] ? collection.options[0].values[0] : undefined

    expect(keyOf(prefill)?.typeOptions).toEqual({ loadOptionsMethod: 'getPrefillKeys', loadOptionsDependsOn: ['formId'] })
    expect(keyOf(context)?.typeOptions).toEqual({ loadOptionsMethod: 'getContextKeys', loadOptionsDependsOn: ['formId'] })
    expect(readonly).toMatchObject({ type: 'multiOptions', typeOptions: { loadOptionsMethod: 'getPrefillKeys', loadOptionsDependsOn: ['formId'] } })
  })

  it('is registered next to the trigger in package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string; n8n: { nodes: string[] } }

    expect(pkg.version).toBe('0.9.0')
    expect(pkg.n8n.nodes).toEqual(['dist/nodes/Formbase/Formbase.node.js', 'dist/nodes/Formbase/FormbaseTrigger.node.js'])
  })

  it('ships codex metadata like the trigger', () => {
    const codex = JSON.parse(readFileSync(new URL('../nodes/Formbase/Formbase.node.json', import.meta.url), 'utf8')) as Record<string, unknown>

    expect(codex).toMatchObject({ node: 'n8n-nodes-formbase', nodeVersion: '1.0', codexVersion: '1.0' })
  })

  it('ships an importable example workflow that creates a request, waits, and reads the outcome', () => {
    const workflow = JSON.parse(readFileSync(new URL('../examples/formbase-request-wait.json', import.meta.url), 'utf8')) as {
      nodes: Array<{ name: string; type: string; parameters: Record<string, unknown> }>
      connections: Record<string, { main: Array<Array<{ node: string }>> }>
      active: boolean
    }

    expect(workflow.active).toBe(false)
    const types = workflow.nodes.map((node) => node.type)
    expect(types).toContain('n8n-nodes-formbase.formbase')
    expect(types).toContain('n8n-nodes-base.wait')
    const create = workflow.nodes.find((node) => node.type === 'n8n-nodes-formbase.formbase')
    const wait = workflow.nodes.find((node) => node.type === 'n8n-nodes-base.wait')
    expect(create?.parameters).toMatchObject({ operation: 'create', waitForOutcome: true })
    expect(wait?.parameters).toMatchObject({ resume: 'webhook' })
    expect(workflow.connections[create!.name]?.main[0]?.[0]?.node).toBe(wait!.name)
  })
})
describe('Formbase.methods.loadOptions', () => {
  const fields = [
    { key: 'company_name', type: 'text', title: 'Company', prefillable: true },
    { key: 'case_id', type: 'hidden', title: 'Case', prefillable: false, context: true },
    { key: 'total', type: 'number', title: 'Total', prefillable: false, calculated: true },
    { key: 'signature', type: 'signature', title: 'Sign here', prefillable: false },
    { key: 'contacts', type: 'group', repeating: true, members: [] },
  ]

  it('offers prefillable fields for prefill and read-only, and context fields for context', async () => {
    respond(() => ({ published: true, items: fields, hasMore: false }))
    const node = new Formbase()
    const ctx = makeLoadOptionsContext({ formId: 'form_1' })

    expect(await node.methods.loadOptions.getPrefillKeys.call(ctx as never)).toEqual([
      { name: 'Company (company_name)', value: 'company_name' },
      { name: 'contacts', value: 'contacts' },
    ])
    expect(await node.methods.loadOptions.getContextKeys.call(ctx as never)).toEqual([{ name: 'Case (case_id)', value: 'case_id' }])
    calledWith('fields.list', { formId: 'form_1' })
  })

  it('offers the Documents blocks for documents', async () => {
    respond(() => ({
      published: true,
      items: [...fields, { key: 'contract_documents', type: 'documents', title: 'Your contract', prefillable: false }],
      hasMore: false,
    }))
    const ctx = makeLoadOptionsContext({ formId: 'form_1' })

    expect(await new Formbase().methods.loadOptions.getDocumentsKeys.call(ctx as never)).toEqual([
      { name: 'Your contract (contract_documents)', value: 'contract_documents' },
    ])
  })

  it('offers nothing until a form is selected', async () => {
    const node = new Formbase()

    expect(await node.methods.loadOptions.getPrefillKeys.call(makeLoadOptionsContext() as never)).toEqual([])
    expect(await node.methods.loadOptions.getContextKeys.call(makeLoadOptionsContext() as never)).toEqual([])
    expect(mockedRequest).not.toHaveBeenCalled()
  })

  it('lists the forms of the token workspace', async () => {
    respond((method) =>
      method === 'workspaces.list'
        ? { items: [{ id: 'ws_1', name: 'Acme' }], hasMore: false }
        : { items: [{ id: 'f1', name: 'Vendor onboarding' }], hasMore: false, nextCursor: null }
    )

    expect(await new Formbase().methods.loadOptions.getForms.call(makeLoadOptionsContext() as never)).toEqual([
      { name: 'Vendor onboarding', value: 'f1' },
    ])
  })
})

describe('Formbase.execute: create', () => {
  it('creates a request from the form, recipient, prefill, context and read-only keys', async () => {
    respond(() => ({ id: 'req_1', status: 'pending', url: 'https://forms.formbase.so/r/rq_1' }))

    const items = await run([
      {
        ...CREATE,
        recipientEmail: 'ada@acme.com',
        prefill: {
          values: [
            { key: 'company_name', value: 'Acme' },
            { key: 'contacts', value: '[{"name":"Ada"}]', json: true },
            { key: 'headcount', value: 42 },
          ],
        },
        context: { values: [{ key: 'case_id', value: 'CASE-9' }] },
        readonly: ['company_name'],
        additionalFields: { recipientName: 'Ada', language: 'de', delivery: 'email' },
      },
    ])

    calledWith('requests.create', {
      formId: 'form_1',
      recipient: { email: 'ada@acme.com', name: 'Ada' },
      prefill: { company_name: 'Acme', contacts: [{ name: 'Ada' }], headcount: 42 },
      context: { case_id: 'CASE-9' },
      readonly: ['company_name'],
      language: 'de',
      delivery: 'email',
    })
    expect(items).toEqual([{ json: { id: 'req_1', status: 'pending', url: 'https://forms.formbase.so/r/rq_1' }, pairedItem: { item: 0 } }])
  })

  it('sends only the form when nothing else is set', async () => {
    respond(() => ({ id: 'req_1' }))

    await run([CREATE])

    calledWith('requests.create', { formId: 'form_1' })
  })

  it('derives the idempotency key from the external ID', async () => {
    respond(() => ({ id: 'req_1' }))

    await run([{ ...CREATE, additionalFields: { externalId: 'run-42' } }])

    expect(sentParams('requests.create')).toMatchObject({ externalId: 'run-42', idempotencyKey: 'run-42' })
  })

  it('points the callback at the execution resume URL when waiting for the outcome', async () => {
    respond(() => ({ id: 'req_1' }))
    const ctx = makeExecuteContext([{ ...CREATE, waitForOutcome: true }], { resumeUrl: RESUME_URL })

    await new Formbase().execute.call(ctx as never)

    expect(ctx.evaluateExpression).toHaveBeenCalledWith('{{ $execution.resumeUrl }}', 0)
    expect(sentParams('requests.create')).toMatchObject({ callbackUrl: RESUME_URL })
  })

  it('fails when waiting for the outcome and n8n has no resume URL', async () => {
    await expect(run([{ ...CREATE, waitForOutcome: true }])).rejects.toBeInstanceOf(NodeOperationError)
    expect(mockedRequest).not.toHaveBeenCalled()
  })

  it('refuses a callback URL of your own together with waiting for the outcome', async () => {
    await expect(
      run([{ ...CREATE, waitForOutcome: true, additionalFields: { callbackUrl: 'https://mine.example/hook' } }], { resumeUrl: RESUME_URL })
    ).rejects.toThrow(/Wait for the Outcome/)
    expect(mockedRequest).not.toHaveBeenCalled()
  })

  it('passes a callback URL of your own through when not waiting', async () => {
    respond(() => ({ id: 'req_1' }))

    await run([{ ...CREATE, additionalFields: { callbackUrl: 'https://mine.example/hook' } }])

    expect(sentParams('requests.create')).toMatchObject({ callbackUrl: 'https://mine.example/hook' })
  })

  it('maps reminders, expiry, metadata and test mode onto the API shapes', async () => {
    respond(() => ({ id: 'req_1' }))

    await run([
      {
        ...CREATE,
        additionalFields: {
          reminders: '2d, 5d',
          expiresAt: '2026-10-01T00:00:00.000Z',
          metadata: '{"runId":"run-42"}',
          test: true,
        },
      },
    ])

    expect(sentParams('requests.create')).toEqual({
      formId: 'form_1',
      reminders: ['2d', '5d'],
      expiresAt: Date.parse('2026-10-01T00:00:00.000Z'),
      metadata: { runId: 'run-42' },
      test: true,
    })
  })

  it('sends an empty reminders list to turn reminders off, and accepts metadata an expression already built', async () => {
    respond(() => ({ id: 'req_1' }))

    await run([{ ...CREATE, additionalFields: { reminders: '', metadata: { ticket: 7 } } }])

    expect(sentParams('requests.create')).toEqual({ formId: 'form_1', reminders: [], metadata: { ticket: 7 } })
  })

  it('uploads each input file as a document and hands it to the request', async () => {
    const pdf = Buffer.from('%PDF-1.7 lease')
    const png = Buffer.from('\x89PNG floor plan')
    let reserved = 0
    respond((method) => {
      if (method === 'documents.create') {
        reserved += 1
        return { id: `doc_${reserved}`, uploadUrl: `https://r2.example/upload/${reserved}` }
      }
      return { id: 'req_1' }
    })

    const { ctx } = await runWithContext(
      [
        {
          ...CREATE,
          documents: {
            values: [
              { binaryProperty: 'data', name: '' },
              { binaryProperty: 'plan', name: 'Floor plan', field: 'appendix' },
            ],
          },
        },
      ],
      {
        binary: {
          data: { mimeType: 'application/pdf', fileName: 'lease.pdf', bytes: pdf },
          plan: { mimeType: 'image/png', fileName: 'plan.png', bytes: png },
        },
      }
    )

    calledWith('documents.create', {
      formId: 'form_1',
      name: 'lease.pdf',
      contentType: 'application/pdf',
      size: pdf.length,
      sha256: createHash('sha256').update(pdf).digest('hex'),
    })
    calledWith('documents.create', {
      formId: 'form_1',
      name: 'Floor plan',
      contentType: 'image/png',
      size: png.length,
      sha256: createHash('sha256').update(png).digest('hex'),
    })
    expect(ctx.helpers.httpRequest).toHaveBeenCalledWith({
      method: 'PUT',
      url: 'https://r2.example/upload/1',
      body: pdf,
      headers: { 'Content-Type': 'application/pdf' },
    })
    expect(ctx.helpers.httpRequest).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://r2.example/upload/2', body: png }))
    expect(sentParams('requests.create')).toEqual({
      formId: 'form_1',
      documents: [{ documentId: 'doc_1' }, { documentId: 'doc_2', field: 'appendix' }],
    })
  })

  it('fails on a missing binary field before reserving anything', async () => {
    await expect(run([{ ...CREATE, documents: { values: [{ binaryProperty: 'data' }] } }])).rejects.toBeInstanceOf(NodeOperationError)
    expect(mockedRequest).not.toHaveBeenCalled()
  })

  it('uploads nothing when another parameter is wrong', async () => {
    await expect(
      run([{ ...CREATE, additionalFields: { expiresAt: 'tomorrow' }, documents: { values: [{ binaryProperty: 'data' }] } }], {
        binary: { data: { mimeType: 'application/pdf', fileName: 'lease.pdf', bytes: Buffer.from('%PDF') } },
      })
    ).rejects.toBeInstanceOf(NodeOperationError)
    expect(mockedRequest).not.toHaveBeenCalled()
  })

  it.each([
    ['metadata that is not JSON', { additionalFields: { metadata: '{oops' } }],
    ['metadata that is not an object', { additionalFields: { metadata: '[1]' } }],
    ['an expiry that is not a date', { additionalFields: { expiresAt: 'tomorrow' } }],
    ['a prefill value flagged as JSON that is not JSON', { prefill: { values: [{ key: 'contacts', value: '[', json: true }] } }],
    ['a prefill entry without a key', { prefill: { values: [{ key: '', value: 'x' }] } }],
    ['a field key listed twice', { prefill: { values: [{ key: 'a', value: '1' }, { key: 'a', value: '2' }] } }],
  ])('rejects %s before calling formbase', async (_name, parameters) => {
    await expect(run([{ ...CREATE, ...parameters }])).rejects.toBeInstanceOf(NodeOperationError)
    expect(mockedRequest).not.toHaveBeenCalled()
  })
})

describe('Formbase.execute: get, cancel, remind, replay callback', () => {
  it('reads a request', async () => {
    respond(() => ({ id: 'req_1', status: 'completed', answers: { plan: 'pro' } }))

    const items = await run([{ resource: 'request', operation: 'get', requestId: 'req_1' }])

    calledWith('requests.get', { requestId: 'req_1' })
    expect(items[0]?.json).toEqual({ id: 'req_1', status: 'completed', answers: { plan: 'pro' } })
  })

  it('cancels a request with an optional reason', async () => {
    respond(() => ({ id: 'req_1', status: 'canceled' }))

    await run([
      { resource: 'request', operation: 'cancel', requestId: 'req_1', reason: 'duplicate' },
      { resource: 'request', operation: 'cancel', requestId: 'req_2' },
    ])

    calledWith('requests.cancel', { requestId: 'req_1', reason: 'duplicate' })
    calledWith('requests.cancel', { requestId: 'req_2' })
  })

  it('reminds the recipient', async () => {
    respond(() => ({ id: 'req_1', remindersSent: 1 }))

    await run([{ resource: 'request', operation: 'remind', requestId: 'req_1' }])

    calledWith('requests.remind', { requestId: 'req_1' })
  })

  it('replays the callback', async () => {
    respond(() => ({ dispatchId: 'disp_1', eventId: 'evt_1' }))

    const items = await run([{ resource: 'request', operation: 'replayCallback', requestId: 'req_1' }])

    calledWith('requests.replayCallback', { requestId: 'req_1' })
    expect(items[0]?.json).toEqual({ dispatchId: 'disp_1', eventId: 'evt_1' })
  })
})

describe('Formbase.execute: get many', () => {
  const GET_ALL = { resource: 'request', operation: 'getAll', scope: 'form', formId: 'form_1' }

  it('follows the cursor until the limit is reached and emits one item per request', async () => {
    respond((_method, params) =>
      params.cursor
        ? { items: [{ id: 'req_3' }, { id: 'req_4' }], hasMore: false, nextCursor: null }
        : { items: [{ id: 'req_1' }, { id: 'req_2' }], hasMore: true, nextCursor: 'c2' }
    )

    const items = await run([{ ...GET_ALL, returnAll: false, limit: 3, filters: { status: 'pending', externalId: 'run-42' } }])

    calledWith('requests.list', { formId: 'form_1', status: 'pending', externalId: 'run-42', limit: 3 })
    calledWith('requests.list', { formId: 'form_1', status: 'pending', externalId: 'run-42', limit: 1, cursor: 'c2' })
    expect(items.map((item) => item.json)).toEqual([{ id: 'req_1' }, { id: 'req_2' }, { id: 'req_3' }])
    expect(items.every((item, index) => item.pairedItem?.item === 0 && index >= 0)).toBe(true)
  })

  it('returns every page in workspace scope, with the test and outcome filters', async () => {
    respond((method, params) => {
      if (method === 'workspaces.list') return { items: [{ id: 'ws_1', name: 'Acme' }], hasMore: false }
      return params.cursor
        ? { items: [{ id: 'req_2' }], hasMore: false, nextCursor: null }
        : { items: [{ id: 'req_1' }], hasMore: true, nextCursor: 'c2' }
    })

    const items = await run([{ resource: 'request', operation: 'getAll', scope: 'workspace', returnAll: true, filters: { includeTest: true, outcome: 'approve' } }])

    calledWith('requests.list', { workspaceId: 'ws_1', includeTest: true, outcome: 'approve', limit: 100 })
    expect(items.map((item) => item.json)).toEqual([{ id: 'req_1' }, { id: 'req_2' }])
  })

  it('treats a page that claims more without a cursor as an API error', async () => {
    respond(() => ({ items: [{ id: 'req_1' }], hasMore: true, nextCursor: null }))

    await expect(run([{ ...GET_ALL, returnAll: true }])).rejects.toBeInstanceOf(NodeApiError)
  })
})

describe('Formbase.execute: errors', () => {
  it('stops on the first failing item by default', async () => {
    mockedRequest.mockImplementation(() => {
      throw new NodeApiError(NODE, { message: 'Request not found' }, { httpCode: '404' })
    })

    await expect(run([{ resource: 'request', operation: 'get', requestId: 'req_missing' }])).rejects.toBeInstanceOf(NodeApiError)
  })

  it('emits the error as the item and carries on when continue on fail is set', async () => {
    mockedRequest.mockImplementation((_context: unknown, _method: string, params: { requestId: string }) => {
      if (params.requestId === 'req_missing') throw new NodeApiError(NODE, { message: 'Request not found' }, { httpCode: '404' })
      return Promise.resolve({ id: params.requestId })
    })

    const items = await run(
      [
        { resource: 'request', operation: 'get', requestId: 'req_missing' },
        { resource: 'request', operation: 'get', requestId: 'req_1' },
      ],
      { continueOnFail: true }
    )

    expect(items).toEqual([
      // n8n rewrites a 404 into its own wording; the node forwards that message as the item.
      { json: { error: 'The resource you are requesting could not be found' }, pairedItem: { item: 0 } },
      { json: { id: 'req_1' }, pairedItem: { item: 1 } },
    ])
  })
})
