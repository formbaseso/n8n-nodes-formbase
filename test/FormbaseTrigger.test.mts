import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { NodeApiError } from 'n8n-workflow'

vi.mock('../nodes/Formbase/GenericFunctions', () => ({
  formbaseApiRequest: vi.fn(),
}))

import { formbaseApiRequest } from '../nodes/Formbase/GenericFunctions'
import { FormbaseTrigger } from '../nodes/Formbase/FormbaseTrigger.node'

const mockedRequest = formbaseApiRequest as unknown as ReturnType<typeof vi.fn>

function makeLoadOptionsContext() {
  return {
    getNode: vi.fn().mockReturnValue({ name: 'formbase Trigger', type: 'formbaseTrigger', typeVersion: 1 }),
  }
}

function makeHookContext(opts: {
  webhookUrl?: string
  formId?: string
  event?: string
  staticData?: Record<string, unknown>
}) {
  const staticData: Record<string, unknown> = opts.staticData ?? {}
  return {
    getNodeWebhookUrl: vi.fn().mockReturnValue(opts.webhookUrl ?? 'https://n8n.example/webhook/abc'),
    getNodeParameter: vi.fn((name: string) => {
      if (name === 'formId') return opts.formId ?? 'form_1'
      if (name === 'event') return opts.event ?? 'submission_created'
      return undefined
    }),
    getWorkflowStaticData: vi.fn().mockReturnValue(staticData),
    getNode: vi.fn().mockReturnValue({ name: 'formbase Trigger', type: 'formbaseTrigger', typeVersion: 1 }),
    _staticData: staticData,
  }
}

function signWebhookBody(secret: string, timestamp: number, rawBody: string): string {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')
  return `t=${timestamp},sha256=${digest}`
}

function makeWebhookContext(opts: {
  body: Record<string, unknown>
  secret?: string
  signatureHeader?: string
  rawBody?: string | false
}) {
  const rawBody = opts.rawBody === false ? undefined : Buffer.from(opts.rawBody ?? JSON.stringify(opts.body))
  const response = {
    status: vi.fn(),
    send: vi.fn(),
    end: vi.fn(),
  }
  response.status.mockReturnValue(response)
  response.send.mockReturnValue(response)
  response.end.mockReturnValue(response)

  return {
    getBodyData: vi.fn().mockReturnValue(opts.body),
    getHeaderData: vi.fn().mockReturnValue(
      opts.signatureHeader === undefined ? {} : { 'x-formbase-signature': opts.signatureHeader }
    ),
    getRequestObject: vi.fn().mockReturnValue(rawBody === undefined ? {} : { rawBody }),
    getResponseObject: vi.fn().mockReturnValue(response),
    getWorkflowStaticData: vi.fn().mockReturnValue(
      opts.secret === undefined ? {} : { webhookSecret: opts.secret }
    ),
    helpers: {
      returnJsonArray: (input: unknown) => [{ json: input }],
    },
    _response: response,
  }
}

describe('formbase Trigger description', () => {
  it('uses lowercase formbase branding', () => {
    const trigger = new FormbaseTrigger()

    expect(trigger.description.displayName).toBe('formbase Trigger')
    expect(trigger.description.description).toContain('formbase')
    expect(trigger.description.description).not.toContain('Formbase')
    expect(trigger.description.icon).toEqual({
      light: 'file:formbase-logo.svg',
      dark: 'file:formbase-logo.dark.svg',
    })
  })

  it('uses human-facing trigger labels and descriptions', () => {
    const trigger = new FormbaseTrigger()
    const eventProperty = trigger.description.properties.find((property) => property.name === 'event')

    expect(trigger.description.subtitle).toContain('On submission created')
    expect(trigger.description.subtitle).toContain('On submission abandoned')
    expect(eventProperty).toMatchObject({
      options: [
        {
          name: 'Submission Abandoned',
          value: 'submission_abandoned',
          action: 'On submission abandoned',
          description:
            'Runs when a respondent leaves the selected form before submitting it; requires partial submission tracking',
        },
        {
          name: 'Submission Created',
          value: 'submission_created',
          action: 'On submission created',
          description: 'Runs when a respondent submits the selected form',
        },
      ],
    })
  })

  it('does not expose the webhook trigger as an AI tool', () => {
    const trigger = new FormbaseTrigger()

    expect(trigger.description.usableAsTool).toBeUndefined()
  })

  it('ships codex metadata for n8n discovery and documentation', () => {
    const codex = JSON.parse(
      readFileSync(new URL('../nodes/Formbase/FormbaseTrigger.node.json', import.meta.url), 'utf8')
    ) as Record<string, unknown>

    expect(codex).toMatchObject({
      node: 'n8n-nodes-formbase',
      nodeVersion: '1.0',
      codexVersion: '1.0',
      categories: ['Marketing & Content', 'Productivity'],
    })
  })

  it('ships an importable example workflow', () => {
    const workflow = JSON.parse(
      readFileSync(new URL('../examples/formbase-submission.json', import.meta.url), 'utf8')
    ) as { nodes: Array<{ type: string }>; active: boolean }

    expect(workflow.active).toBe(false)
    expect(workflow.nodes.map((node) => node.type)).toEqual([
      'n8n-nodes-formbase.formbaseTrigger',
      'n8n-nodes-base.set',
    ])
  })
})

describe('FormbaseTrigger.methods.loadOptions.getForms', () => {
  beforeEach(() => mockedRequest.mockReset())

  it('loads forms from the token workspace', async () => {
    mockedRequest.mockImplementation((method: string) => {
      if (method === 'workspaces.list') {
        return Promise.resolve({ items: [{ id: 'ws_1', name: 'Acme' }], hasMore: false })
      }
      return Promise.resolve({
        items: [
          { id: 'f1', name: 'Customer Survey', workspaceId: 'ws_1' },
          { id: 'f2', name: 'Feedback', workspaceId: 'ws_1' },
        ],
        hasMore: false,
        nextCursor: null,
      })
    })

    const trigger = new FormbaseTrigger()
    const result = await trigger.methods.loadOptions.getForms.call(makeLoadOptionsContext() as never)

    expect(result).toEqual([
      { name: 'Customer Survey', value: 'f1' },
      { name: 'Feedback', value: 'f2' },
    ])
    expect(mockedRequest).toHaveBeenCalledWith('workspaces.list', {})
    expect(mockedRequest).toHaveBeenCalledWith('forms.list', { workspaceId: 'ws_1', limit: 100 })
  })

  it('paginates forms and prefixes names when multiple workspaces are available', async () => {
    mockedRequest.mockImplementation((method: string, params: Record<string, unknown> = {}) => {
      if (method === 'workspaces.list') {
        return Promise.resolve({
          items: [
            { id: 'ws_1', name: 'Acme' },
            { id: 'ws_2', name: 'Personal' },
          ],
          hasMore: false,
        })
      }
      if (params.workspaceId === 'ws_1' && !params.cursor) {
        return Promise.resolve({
          items: [{ id: 'f1', name: 'Survey', workspaceId: 'ws_1' }],
          hasMore: true,
          nextCursor: 'cursor_2',
        })
      }
      if (params.workspaceId === 'ws_1') {
        return Promise.resolve({
          items: [{ id: 'f2', name: 'Signup', workspaceId: 'ws_1' }],
          hasMore: false,
          nextCursor: null,
        })
      }
      return Promise.resolve({
        items: [{ id: 'f3', name: 'Contact', workspaceId: 'ws_2' }],
        hasMore: false,
        nextCursor: null,
      })
    })

    const trigger = new FormbaseTrigger()
    const result = await trigger.methods.loadOptions.getForms.call(makeLoadOptionsContext() as never)

    expect(result).toEqual([
      { name: 'Acme / Survey', value: 'f1' },
      { name: 'Acme / Signup', value: 'f2' },
      { name: 'Personal / Contact', value: 'f3' },
    ])
    expect(mockedRequest).toHaveBeenCalledWith('forms.list', {
      workspaceId: 'ws_1',
      limit: 100,
      cursor: 'cursor_2',
    })
  })

  it('returns an empty list when the token has no workspaces', async () => {
    mockedRequest.mockResolvedValue({ items: [], hasMore: false })

    const trigger = new FormbaseTrigger()
    const result = await trigger.methods.loadOptions.getForms.call(makeLoadOptionsContext() as never)

    expect(result).toEqual([])
    expect(mockedRequest).toHaveBeenCalledTimes(1)
  })
})

describe('FormbaseTrigger.webhookMethods.default.checkExists', () => {
  beforeEach(() => mockedRequest.mockReset())

  it('recognizes the matching signed n8n subscription', async () => {
    const ctx = makeHookContext({
      webhookUrl: 'https://n8n.example/hook/X',
      formId: 'f1',
      staticData: { subscriptionId: 'sub_match', webhookSecret: `whsec_${'a'.repeat(64)}` },
    })
    mockedRequest.mockResolvedValue({
      items: [
        {
          subscriptionId: 'sub_other_provider',
          targetUrl: 'https://n8n.example/hook/X',
          provider: 'zapier',
          eventType: 'submission_created',
        },
        {
          subscriptionId: 'sub_other_event',
          targetUrl: 'https://n8n.example/hook/X',
          provider: 'n8n',
          eventType: 'submission_abandoned',
        },
        {
          subscriptionId: 'sub_match',
          targetUrl: 'https://n8n.example/hook/X',
          provider: 'n8n',
          eventType: 'submission_created',
        },
      ],
      hasMore: false,
    })

    const trigger = new FormbaseTrigger()
    const exists = await trigger.webhookMethods.default.checkExists.call(ctx as never)

    expect(exists).toBe(true)
    expect(ctx._staticData.subscriptionId).toBe('sub_match')
    expect(mockedRequest).toHaveBeenCalledWith('webhooks.list', { formId: 'f1' })
  })

  it('removes an unsigned matching subscription so activation can replace it', async () => {
    const ctx = makeHookContext({
      webhookUrl: 'https://n8n.example/hook/X',
      formId: 'f1',
      staticData: { subscriptionId: 'sub_unsigned' },
    })
    mockedRequest.mockResolvedValueOnce({
      items: [
        {
          subscriptionId: 'sub_unsigned',
          targetUrl: 'https://n8n.example/hook/X',
          provider: 'n8n',
          eventType: 'submission_created',
        },
      ],
      hasMore: false,
    })
    mockedRequest.mockResolvedValueOnce({ subscriptionId: 'sub_unsigned', deleted: true })

    const trigger = new FormbaseTrigger()
    const exists = await trigger.webhookMethods.default.checkExists.call(ctx as never)

    expect(exists).toBe(false)
    expect(mockedRequest).toHaveBeenNthCalledWith(2, 'webhooks.delete', { subscriptionId: 'sub_unsigned' })
    expect(ctx._staticData.subscriptionId).toBeUndefined()
    expect(ctx._staticData.webhookSecret).toBeUndefined()
  })

  it('returns false when no matching subscription exists', async () => {
    const ctx = makeHookContext({ webhookUrl: 'https://n8n.example/hook/X' })
    mockedRequest.mockResolvedValue({ items: [], hasMore: false })

    const trigger = new FormbaseTrigger()
    const exists = await trigger.webhookMethods.default.checkExists.call(ctx as never)

    expect(exists).toBe(false)
    expect(ctx._staticData.subscriptionId).toBeUndefined()
  })

  it('returns false without an API call when formId is empty', async () => {
    const ctx = makeHookContext({ formId: '' })
    const trigger = new FormbaseTrigger()
    const exists = await trigger.webhookMethods.default.checkExists.call(ctx as never)

    expect(exists).toBe(false)
    expect(mockedRequest).not.toHaveBeenCalled()
  })
})

describe('FormbaseTrigger.webhookMethods.default.create', () => {
  beforeEach(() => mockedRequest.mockReset())

  it('registers the selected event with a signing secret and stores both IDs', async () => {
    const ctx = makeHookContext({
      webhookUrl: 'https://n8n.example/hook/NEW',
      formId: 'f1',
      event: 'submission_abandoned',
    })
    mockedRequest.mockResolvedValue({ subscriptionId: 'sub_new' })

    const trigger = new FormbaseTrigger()
    const created = await trigger.webhookMethods.default.create.call(ctx as never)

    expect(created).toBe(true)
    expect(mockedRequest).toHaveBeenCalledWith('webhooks.create', {
      formId: 'f1',
      targetUrl: 'https://n8n.example/hook/NEW',
      provider: 'n8n',
      eventType: 'submission_abandoned',
      signingSecret: expect.stringMatching(/^whsec_[a-f0-9]{64}$/),
    })
    expect(ctx._staticData.subscriptionId).toBe('sub_new')
    const createParams = mockedRequest.mock.calls[0][1] as { signingSecret: string }
    expect(ctx._staticData.webhookSecret).toBe(createParams.signingSecret)
  })
})

describe('FormbaseTrigger.webhookMethods.default.delete', () => {
  beforeEach(() => mockedRequest.mockReset())

  it('deletes the stored subscription and clears static data', async () => {
    const ctx = makeHookContext({
      staticData: { subscriptionId: 'sub_xyz', webhookSecret: `whsec_${'a'.repeat(64)}` },
    })
    mockedRequest.mockResolvedValue({ subscriptionId: 'sub_xyz', deleted: true })

    const trigger = new FormbaseTrigger()
    const deleted = await trigger.webhookMethods.default.delete.call(ctx as never)

    expect(deleted).toBe(true)
    expect(mockedRequest).toHaveBeenCalledWith('webhooks.delete', { subscriptionId: 'sub_xyz' })
    expect(ctx._staticData.subscriptionId).toBeUndefined()
    expect(ctx._staticData.webhookSecret).toBeUndefined()
  })

  it('is a no-op when no subscription ID is stored', async () => {
    const ctx = makeHookContext({})
    const trigger = new FormbaseTrigger()
    const deleted = await trigger.webhookMethods.default.delete.call(ctx as never)

    expect(deleted).toBe(true)
    expect(mockedRequest).not.toHaveBeenCalled()
  })

  it('treats an already-deleted subscription as success', async () => {
    const ctx = makeHookContext({ staticData: { subscriptionId: 'sub_gone' } })
    const notFound = new NodeApiError(ctx.getNode(), { message: 'Webhook not found' }, { httpCode: '404' })
    mockedRequest.mockImplementation((method: string) => {
      if (method === 'webhooks.delete') throw notFound
      return undefined
    })

    const trigger = new FormbaseTrigger()
    const deleted = await trigger.webhookMethods.default.delete.call(ctx as never)

    expect(deleted).toBe(true)
    expect(ctx._staticData.subscriptionId).toBeUndefined()
  })

  it('retains the subscription ID and reports failure on other API errors', async () => {
    const ctx = makeHookContext({ staticData: { subscriptionId: 'sub_retry' } })
    mockedRequest.mockImplementation((method: string) => {
      if (method === 'webhooks.delete') throw new Error('network unavailable')
      return undefined
    })

    const trigger = new FormbaseTrigger()
    const deleted = await trigger.webhookMethods.default.delete.call(ctx as never)

    expect(deleted).toBe(false)
    expect(ctx._staticData.subscriptionId).toBe('sub_retry')
  })
})

describe('FormbaseTrigger.webhook', () => {
  it('emits a valid signed webhook body as one n8n item', async () => {
    const body = { eventId: 'e1', eventType: 'SUBMIT_RESPONSE' }
    const secret = `whsec_${'a'.repeat(64)}`
    const rawBody = JSON.stringify(body)
    const timestamp = Math.floor(Date.now() / 1000)
    const ctx = makeWebhookContext({
      body,
      secret,
      rawBody,
      signatureHeader: signWebhookBody(secret, timestamp, rawBody),
    })

    const trigger = new FormbaseTrigger()
    const result = await trigger.webhook.call(ctx as never)

    expect(result.workflowData).toEqual([[{ json: body }]])
    expect(ctx._response.status).not.toHaveBeenCalled()
  })

  it.each([
    ['missing signature', undefined, undefined],
    ['invalid signature', `t=${Math.floor(Date.now() / 1000)},sha256=${'0'.repeat(64)}`, undefined],
    ['missing raw body', 'valid', false],
  ] as const)('rejects %s', async (_name, signatureHeader, rawBody) => {
    const body = { eventId: 'e1', eventType: 'SUBMIT_RESPONSE' }
    const secret = `whsec_${'a'.repeat(64)}`
    const serializedBody = JSON.stringify(body)
    const timestamp = Math.floor(Date.now() / 1000)
    const resolvedHeader =
      signatureHeader === 'valid' ? signWebhookBody(secret, timestamp, serializedBody) : signatureHeader
    const ctx = makeWebhookContext({ body, secret, signatureHeader: resolvedHeader, rawBody })

    const trigger = new FormbaseTrigger()
    const result = await trigger.webhook.call(ctx as never)

    expect(result).toEqual({ noWebhookResponse: true })
    expect(ctx._response.status).toHaveBeenCalledWith(401)
    expect(ctx._response.send).toHaveBeenCalledWith('Unauthorized')
    expect(ctx.getBodyData).not.toHaveBeenCalled()
  })

  it('rejects a valid signature outside the five-minute replay window', async () => {
    const body = { eventId: 'e1', eventType: 'SUBMIT_RESPONSE' }
    const secret = `whsec_${'a'.repeat(64)}`
    const rawBody = JSON.stringify(body)
    const timestamp = Math.floor(Date.now() / 1000) - 301
    const ctx = makeWebhookContext({
      body,
      secret,
      rawBody,
      signatureHeader: signWebhookBody(secret, timestamp, rawBody),
    })

    const trigger = new FormbaseTrigger()
    const result = await trigger.webhook.call(ctx as never)

    expect(result).toEqual({ noWebhookResponse: true })
    expect(ctx._response.status).toHaveBeenCalledWith(401)
  })
})
