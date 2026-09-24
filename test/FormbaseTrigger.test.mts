import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { NodeApiError, NodeOperationError } from 'n8n-workflow'

vi.mock('../nodes/Formbase/GenericFunctions', () => ({
  formbaseApiRequest: vi.fn(),
}))

import { formbaseApiRequest } from '../nodes/Formbase/GenericFunctions'
import { FormbaseTrigger } from '../nodes/Formbase/FormbaseTrigger.node'
import { signEvent } from './fakeFormbase.mts'

const mockedRequest = formbaseApiRequest as unknown as ReturnType<typeof vi.fn>

// Braces on purpose: a hook that returns the mock hands vitest a "cleanup"
// that calls it after the test, with whatever implementation the test set.
beforeEach(() => {
  mockedRequest.mockReset()
})
const NODE = { name: 'formbase Trigger', type: 'formbaseTrigger', typeVersion: 1 }
const SECRET = `whsec_${'a'.repeat(64)}`

/** Answers `method` with `result` whatever the context; the context itself is not under test here. */
function respond(handler: (method: string, params: Record<string, unknown>) => unknown) {
  mockedRequest.mockImplementation((_context: unknown, method: string, params: Record<string, unknown> = {}) =>
    Promise.resolve(handler(method, params))
  )
}

function calledWith(method: string, params?: Record<string, unknown>) {
  return expect(mockedRequest).toHaveBeenCalledWith(expect.anything(), method, ...(params ? [params] : []))
}

function makeLoadOptionsContext() {
  return { getNode: vi.fn().mockReturnValue(NODE) }
}

function makeHookContext(opts: {
  webhookUrl?: string
  formId?: string
  event?: string
  idleWindow?: string
  staticData?: Record<string, unknown>
}) {
  const staticData: Record<string, unknown> = opts.staticData ?? {}
  return {
    getNodeWebhookUrl: vi.fn().mockReturnValue(opts.webhookUrl ?? 'https://n8n.example/webhook/abc'),
    getNodeParameter: vi.fn((name: string) => {
      if (name === 'formId') return opts.formId ?? 'form_1'
      if (name === 'event') return opts.event ?? 'submission_created'
      if (name === 'idleWindow') return opts.idleWindow ?? '12h'
      return undefined
    }),
    getWorkflowStaticData: vi.fn().mockReturnValue(staticData),
    getNode: vi.fn().mockReturnValue(NODE),
    _staticData: staticData,
  }
}

function makeWebhookContext(opts: {
  body: Record<string, unknown>
  secret?: string
  signatureHeader?: string
  rawBody?: string | false
}) {
  const rawBody = opts.rawBody === false ? undefined : Buffer.from(opts.rawBody ?? JSON.stringify(opts.body))
  const response = { status: vi.fn(), send: vi.fn(), end: vi.fn() }
  response.status.mockReturnValue(response)
  response.send.mockReturnValue(response)
  response.end.mockReturnValue(response)

  return {
    getBodyData: vi.fn().mockReturnValue(opts.body),
    getHeaderData: vi.fn().mockReturnValue(opts.signatureHeader === undefined ? {} : { 'x-formbase-signature': opts.signatureHeader }),
    getRequestObject: vi.fn().mockReturnValue(rawBody === undefined ? {} : { rawBody }),
    getResponseObject: vi.fn().mockReturnValue(response),
    getWorkflowStaticData: vi.fn().mockReturnValue(opts.secret === undefined ? {} : { webhookSecret: opts.secret }),
    helpers: { returnJsonArray: (input: unknown) => [{ json: input }] },
    _response: response,
  }
}

function makeEventBody(type: string): Record<string, unknown> {
  return {
    id: 'evt_abc123',
    type,
    createdAt: '2026-09-22T12:34:56.000Z',
    apiVersion: '2026-09-24',
    test: false,
    data: {
      form: { id: 'frm_abc123', name: 'Customer Feedback', snapshotId: 'snp_1' },
      submission: {
        id: 'sub_xyz789',
        respondentEmail: 'respondent@example.com',
        submittedAt: '2026-09-22T12:34:56.000Z',
        pdfUrl: '/api/storage/receipt-key',
        language: 'en',
      },
      answers: { recommend: 9, plan: 'pro', contacts: [{ name: 'Ada' }] },
      display: { recommend: '9', plan: 'Pro', contacts: 'Ada' },
    },
  }
}

function makeRequestEventBody(type: string): Record<string, unknown> {
  const status = type.replace('request.', '')
  const request = {
    id: 'req_1',
    externalId: 'run-42',
    status,
    language: 'en',
    recipient: { email: 'ada@acme.com', name: 'Ada' },
    metadata: { runId: 'run-42' },
    context: { case_id: 'CASE-9' },
    createdAt: '2026-09-22T09:00:00.000Z',
    ...(status === 'completed' ? { outcome: 'approve', completedAt: '2026-09-22T12:34:56.000Z' } : {}),
    ...(status === 'expired' ? { expiredAt: '2026-09-22T12:34:56.000Z' } : {}),
    ...(status === 'canceled' ? { canceledAt: '2026-09-22T12:34:56.000Z', cancelReason: 'duplicate' } : {}),
  }
  const completion =
    status === 'completed'
      ? {
          form: { id: 'frm_abc123', name: 'Vendor onboarding', snapshotId: 'snp_1' },
          submission: { id: 'sub_xyz789', respondentEmail: 'ada@acme.com', submittedAt: '2026-09-22T12:34:56.000Z', pdfUrl: null, language: 'en' },
          answers: { company_name: 'Acme' },
          display: { company_name: 'Acme' },
        }
      : {}
  return { id: 'evt_req123', type, createdAt: '2026-09-22T12:34:56.000Z', apiVersion: '2026-09-24', test: false, data: { request, ...completion } }
}

const subscription = (overrides: Record<string, unknown>) => ({
  subscriptionId: 'sub_match',
  targetUrl: 'https://n8n.example/hook/X',
  provider: 'n8n',
  eventType: 'submission_created',
  ...overrides,
})

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

  it('offers the default event first and idle windows shortest first', () => {
    const trigger = new FormbaseTrigger()
    const eventProperty = trigger.description.properties.find((property) => property.name === 'event')
    const idleWindowProperty = trigger.description.properties.find((property) => property.name === 'idleWindow')

    expect(trigger.description.subtitle).toContain('On public link submission created')
    expect(trigger.description.subtitle).toContain('On public link submission updated')
    expect(trigger.description.subtitle).toContain('On public link submission abandoned')
    expect(trigger.description.subtitle).toContain('On request completed')
    expect(eventProperty).toMatchObject({
      default: 'submission_created',
      options: [
        expect.objectContaining({ name: 'Public Link Submission Created', value: 'submission_created', action: 'On public link submission created' }),
        expect.objectContaining({ name: 'Public Link Submission Updated', value: 'submission_updated', action: 'On public link submission updated' }),
        expect.objectContaining({ name: 'Public Link Submission Abandoned', value: 'submission_abandoned', action: 'On public link submission abandoned' }),
        expect.objectContaining({ name: 'Request Completed', value: 'request_completed', action: 'On request completed' }),
        expect.objectContaining({ name: 'Request Expired', value: 'request_expired', action: 'On request expired' }),
        expect.objectContaining({ name: 'Request Canceled', value: 'request_canceled', action: 'On request canceled' }),
      ],
    })
    expect(eventProperty?.options?.[0]?.description).toContain('submission.completed')
    expect(eventProperty?.options?.[0]?.description).not.toContain('submission.updated')
    expect(eventProperty?.options?.[1]?.description).toContain('submission.updated')
    expect(idleWindowProperty).toMatchObject({
      displayOptions: { show: { event: ['submission_abandoned'] } },
      default: '12h',
      required: true,
      options: [
        { name: '12 Hours', value: '12h' },
        { name: '1 Day', value: '1d' },
        { name: '3 Days', value: '3d' },
        { name: '1 Week', value: '1w' },
      ],
    })
  })

  it('does not expose the webhook trigger as an AI tool', () => {
    expect(new FormbaseTrigger().description.usableAsTool).toBeUndefined()
  })

  it('ships codex metadata for n8n discovery and documentation', () => {
    const codex = JSON.parse(readFileSync(new URL('../nodes/Formbase/FormbaseTrigger.node.json', import.meta.url), 'utf8')) as Record<string, unknown>

    expect(codex).toMatchObject({
      node: 'n8n-nodes-formbase',
      nodeVersion: '1.0',
      codexVersion: '1.0',
      categories: ['Marketing & Content', 'Productivity'],
    })
  })

  it('ships an importable example workflow that reads the envelope', () => {
    const workflow = JSON.parse(readFileSync(new URL('../examples/formbase-submission.json', import.meta.url), 'utf8')) as {
      nodes: Array<{ type: string; parameters?: { assignments?: { assignments?: Array<{ name: string; value: string }> } } }>
      active: boolean
    }

    expect(workflow.active).toBe(false)
    expect(workflow.nodes.map((node) => node.type)).toEqual(['n8n-nodes-formbase.formbaseTrigger', 'n8n-nodes-base.set'])
    const assignments = workflow.nodes[1]?.parameters?.assignments?.assignments ?? []
    expect(assignments).toContainEqual(expect.objectContaining({ name: 'eventId', value: '={{ $json.id }}' }))
    expect(assignments).toContainEqual(expect.objectContaining({ name: 'eventType', value: '={{ $json.type }}' }))
    expect(assignments).toContainEqual(expect.objectContaining({ name: 'submissionId', value: '={{ $json.data.submission.id }}' }))
    for (const assignment of assignments) {
      expect(assignment.value).not.toContain('$json.fields')
    }
  })
})

describe('FormbaseTrigger.methods.loadOptions.getForms', () => {
  it('lists the forms of the token workspace', async () => {
    respond((method) => {
      if (method === 'workspaces.list') return { items: [{ id: 'ws_1', name: 'Acme' }], hasMore: false }
      return {
        items: [
          { id: 'f1', name: 'Customer Survey', workspaceId: 'ws_1' },
          { id: 'f2', name: 'Feedback', workspaceId: 'ws_1' },
        ],
        hasMore: false,
        nextCursor: null,
      }
    })

    const result = await new FormbaseTrigger().methods.loadOptions.getForms.call(makeLoadOptionsContext() as never)

    expect(result).toEqual([
      { name: 'Customer Survey', value: 'f1' },
      { name: 'Feedback', value: 'f2' },
    ])
    calledWith('workspaces.list')
    calledWith('forms.list', { workspaceId: 'ws_1', limit: 100 })
  })

  it('follows the cursor across forms.list pages', async () => {
    respond((method, params) => {
      if (method === 'workspaces.list') return { items: [{ id: 'ws_1', name: 'Acme' }], hasMore: false }
      if (!params.cursor) return { items: [{ id: 'f1', name: 'Survey' }], hasMore: true, nextCursor: 'cursor_2' }
      return { items: [{ id: 'f2', name: 'Signup' }], hasMore: false, nextCursor: null }
    })

    const result = await new FormbaseTrigger().methods.loadOptions.getForms.call(makeLoadOptionsContext() as never)

    expect(result).toEqual([
      { name: 'Survey', value: 'f1' },
      { name: 'Signup', value: 'f2' },
    ])
    calledWith('forms.list', { workspaceId: 'ws_1', limit: 100, cursor: 'cursor_2' })
  })

  it('fails when the credential has no workspace instead of offering an empty picker', async () => {
    respond(() => ({ items: [], hasMore: false }))

    await expect(new FormbaseTrigger().methods.loadOptions.getForms.call(makeLoadOptionsContext() as never)).rejects.toBeInstanceOf(NodeOperationError)
    expect(mockedRequest).toHaveBeenCalledTimes(1)
  })
})

describe('FormbaseTrigger.webhookMethods.default.checkExists', () => {
  it('recognizes the subscription this node registered and leaves other subscriptions alone', async () => {
    const ctx = makeHookContext({
      webhookUrl: 'https://n8n.example/hook/X',
      formId: 'f1',
      staticData: { subscriptionId: 'sub_match', webhookSecret: SECRET },
    })
    respond(() => ({
      items: [
        subscription({ subscriptionId: 'sub_other_provider', provider: 'zapier' }),
        subscription({ subscriptionId: 'sub_other_event', eventType: 'submission_abandoned', idleWindow: '1d' }),
        subscription({ subscriptionId: 'sub_other_url', targetUrl: 'https://n8n.example/hook/Y' }),
        subscription({}),
      ],
      hasMore: false,
    }))

    const exists = await new FormbaseTrigger().webhookMethods.default.checkExists.call(ctx as never)

    expect(exists).toBe(true)
    expect(ctx._staticData.subscriptionId).toBe('sub_match')
    expect(mockedRequest).toHaveBeenCalledTimes(1)
    calledWith('webhooks.list', { formId: 'f1' })
  })

  it('removes a matching subscription it holds no secret for, so activation replaces it', async () => {
    const ctx = makeHookContext({ webhookUrl: 'https://n8n.example/hook/X', formId: 'f1', staticData: { subscriptionId: 'sub_match' } })
    respond((method) => (method === 'webhooks.list' ? { items: [subscription({})], hasMore: false } : { deleted: true }))

    const exists = await new FormbaseTrigger().webhookMethods.default.checkExists.call(ctx as never)

    expect(exists).toBe(false)
    calledWith('webhooks.delete', { subscriptionId: 'sub_match' })
    expect(ctx._staticData).toEqual({})
  })

  it('removes a stale duplicate for the same URL and event while keeping the current one', async () => {
    const ctx = makeHookContext({ webhookUrl: 'https://n8n.example/hook/X', formId: 'f1', staticData: { subscriptionId: 'sub_match', webhookSecret: SECRET } })
    respond((method) => (method === 'webhooks.list' ? { items: [subscription({ subscriptionId: 'sub_stale' }), subscription({})], hasMore: false } : { deleted: true }))

    const exists = await new FormbaseTrigger().webhookMethods.default.checkExists.call(ctx as never)

    expect(exists).toBe(true)
    calledWith('webhooks.delete', { subscriptionId: 'sub_stale' })
    expect(mockedRequest).not.toHaveBeenCalledWith(expect.anything(), 'webhooks.delete', { subscriptionId: 'sub_match' })
  })

  it('replaces an abandoned subscription when its idle window changed', async () => {
    const ctx = makeHookContext({
      webhookUrl: 'https://n8n.example/hook/X',
      formId: 'f1',
      event: 'submission_abandoned',
      idleWindow: '3d',
      staticData: { subscriptionId: 'sub_old', webhookSecret: SECRET },
    })
    respond((method) =>
      method === 'webhooks.list'
        ? { items: [subscription({ subscriptionId: 'sub_old', eventType: 'submission_abandoned', idleWindow: '12h' })], hasMore: false }
        : { deleted: true }
    )

    const exists = await new FormbaseTrigger().webhookMethods.default.checkExists.call(ctx as never)

    expect(exists).toBe(false)
    calledWith('webhooks.delete', { subscriptionId: 'sub_old' })
    expect(ctx._staticData).toEqual({})
  })

  it('returns false when no matching subscription exists', async () => {
    const ctx = makeHookContext({ webhookUrl: 'https://n8n.example/hook/X' })
    respond(() => ({ items: [], hasMore: false }))

    expect(await new FormbaseTrigger().webhookMethods.default.checkExists.call(ctx as never)).toBe(false)
    expect(ctx._staticData.subscriptionId).toBeUndefined()
  })

  it('returns false without an API call when formId is empty', async () => {
    const ctx = makeHookContext({ formId: '' })

    expect(await new FormbaseTrigger().webhookMethods.default.checkExists.call(ctx as never)).toBe(false)
    expect(mockedRequest).not.toHaveBeenCalled()
  })

  it('rejects an idle window outside the offered choices as a configuration error', async () => {
    const ctx = makeHookContext({ event: 'submission_abandoned', idleWindow: '2d' })

    await expect(new FormbaseTrigger().webhookMethods.default.checkExists.call(ctx as never)).rejects.toBeInstanceOf(NodeOperationError)
    expect(mockedRequest).not.toHaveBeenCalled()
  })
})

describe('FormbaseTrigger.webhookMethods.default.create', () => {
  it('registers the selected event with a signing secret and stores both IDs', async () => {
    const ctx = makeHookContext({ webhookUrl: 'https://n8n.example/hook/NEW', formId: 'f1', event: 'submission_abandoned', idleWindow: '3d' })
    respond(() => ({ subscriptionId: 'sub_new' }))

    const created = await new FormbaseTrigger().webhookMethods.default.create.call(ctx as never)

    expect(created).toBe(true)
    calledWith('webhooks.create', {
      formId: 'f1',
      targetUrl: 'https://n8n.example/hook/NEW',
      provider: 'n8n',
      eventType: 'submission_abandoned',
      idleWindow: '3d',
      signingSecret: expect.stringMatching(/^whsec_[a-f0-9]{64}$/),
    })
    expect(ctx._staticData.subscriptionId).toBe('sub_new')
    const createParams = mockedRequest.mock.calls[0][2] as { signingSecret: string }
    expect(ctx._staticData.webhookSecret).toBe(createParams.signingSecret)
  })

  it('omits idleWindow for completed-submission registrations', async () => {
    const ctx = makeHookContext({ webhookUrl: 'https://n8n.example/hook/NEW', formId: 'f1', event: 'submission_created' })
    respond(() => ({ subscriptionId: 'sub_new' }))

    await new FormbaseTrigger().webhookMethods.default.create.call(ctx as never)

    expect(mockedRequest.mock.calls[0][2]).not.toHaveProperty('idleWindow')
  })

  it.each(['submission_updated', 'request_completed', 'request_expired', 'request_canceled'])('registers %s with a signing secret and no idle window', async (event) => {
    const ctx = makeHookContext({ webhookUrl: 'https://n8n.example/hook/NEW', formId: 'f1', event, idleWindow: '3d' })
    respond(() => ({ subscriptionId: 'sub_new' }))

    expect(await new FormbaseTrigger().webhookMethods.default.create.call(ctx as never)).toBe(true)

    calledWith('webhooks.create', {
      formId: 'f1',
      targetUrl: 'https://n8n.example/hook/NEW',
      provider: 'n8n',
      eventType: event,
      signingSecret: expect.stringMatching(/^whsec_[a-f0-9]{64}$/),
    })
    expect(ctx._staticData.subscriptionId).toBe('sub_new')
  })
})

describe('FormbaseTrigger.webhookMethods.default.delete', () => {
  it('deletes the stored subscription and clears static data', async () => {
    const ctx = makeHookContext({ staticData: { subscriptionId: 'sub_xyz', webhookSecret: SECRET } })
    respond(() => ({ subscriptionId: 'sub_xyz', deleted: true }))

    expect(await new FormbaseTrigger().webhookMethods.default.delete.call(ctx as never)).toBe(true)
    calledWith('webhooks.delete', { subscriptionId: 'sub_xyz' })
    expect(ctx._staticData).toEqual({})
  })

  it('is a no-op when no subscription ID is stored', async () => {
    const ctx = makeHookContext({})

    expect(await new FormbaseTrigger().webhookMethods.default.delete.call(ctx as never)).toBe(true)
    expect(mockedRequest).not.toHaveBeenCalled()
  })

  it('treats an already-deleted subscription as success', async () => {
    const ctx = makeHookContext({ staticData: { subscriptionId: 'sub_gone' } })
    const notFound = new NodeApiError(NODE, { message: 'Webhook not found' }, { httpCode: '404' })
    mockedRequest.mockImplementation(() => {
      throw notFound
    })

    expect(await new FormbaseTrigger().webhookMethods.default.delete.call(ctx as never)).toBe(true)
    expect(ctx._staticData.subscriptionId).toBeUndefined()
  })

  it('treats a 404 from another copy of n8n-workflow as already deleted', async () => {
    const ctx = makeHookContext({ staticData: { subscriptionId: 'sub_gone' } })
    mockedRequest.mockImplementation(() => {
      throw { name: 'NodeApiError', node: NODE, message: 'Webhook not found', httpCode: '404' }
    })

    expect(await new FormbaseTrigger().webhookMethods.default.delete.call(ctx as never)).toBe(true)
    expect(ctx._staticData.subscriptionId).toBeUndefined()
  })

  it('retains the subscription ID and reports failure on other API errors', async () => {
    const ctx = makeHookContext({ staticData: { subscriptionId: 'sub_retry' } })
    mockedRequest.mockImplementation(() => {
      throw new Error('network unavailable')
    })

    expect(await new FormbaseTrigger().webhookMethods.default.delete.call(ctx as never)).toBe(false)
    expect(ctx._staticData.subscriptionId).toBe('sub_retry')
  })
})

describe('FormbaseTrigger.webhook', () => {
  it.each(['submission.completed', 'submission.updated', 'submission.abandoned'])('emits a valid signed %s webhook body as one n8n item', async (type) => {
    const body = makeEventBody(type)
    const rawBody = JSON.stringify(body)
    const ctx = makeWebhookContext({ body, secret: SECRET, rawBody, signatureHeader: signEvent(SECRET, Math.floor(Date.now() / 1000), rawBody) })

    const result = await new FormbaseTrigger().webhook.call(ctx as never)

    expect(result.workflowData).toEqual([[{ json: body }]])
    expect(ctx._response.status).not.toHaveBeenCalled()
  })

  it.each(['request.completed', 'request.expired', 'request.canceled'])('emits a valid signed %s event as one n8n item', async (type) => {
    const body = makeRequestEventBody(type)
    const rawBody = JSON.stringify(body)
    const ctx = makeWebhookContext({ body, secret: SECRET, rawBody, signatureHeader: signEvent(SECRET, Math.floor(Date.now() / 1000), rawBody) })

    const result = await new FormbaseTrigger().webhook.call(ctx as never)

    expect(result.workflowData).toEqual([[{ json: body }]])
    const data = (result.workflowData?.[0]?.[0]?.json as { data: Record<string, unknown> }).data
    expect(data.request).toMatchObject({ id: 'req_1', externalId: 'run-42', status: type.replace('request.', '') })
    if (type === 'request.completed') expect(data.answers).toEqual({ company_name: 'Acme' })
    else expect(data).not.toHaveProperty('answers')
  })

  it('passes the envelope through untouched so answers stay under their field keys', async () => {
    // A key this version does not know about must survive too: the node never trims the envelope.
    const body = makeEventBody('submission.completed')
    body.data = { ...(body.data as Record<string, unknown>), unknownBlock: { id: 'blk_1', label: 'later' } }
    const rawBody = JSON.stringify(body)
    const ctx = makeWebhookContext({ body, secret: SECRET, rawBody, signatureHeader: signEvent(SECRET, Math.floor(Date.now() / 1000), rawBody) })

    const result = await new FormbaseTrigger().webhook.call(ctx as never)
    const item = result.workflowData?.[0]?.[0]?.json as Record<string, unknown>
    const data = item.data as Record<string, unknown>

    expect(item).toMatchObject({ id: 'evt_abc123', type: 'submission.completed', test: false })
    expect(data.answers).toEqual({ recommend: 9, plan: 'pro', contacts: [{ name: 'Ada' }] })
    expect(data.display).toEqual({ recommend: '9', plan: 'Pro', contacts: 'Ada' })
    expect(data.unknownBlock).toEqual({ id: 'blk_1', label: 'later' })
    expect(item).not.toHaveProperty('fields')
  })

  it('passes a booking and a payment answer through as objects, with their text under display', async () => {
    const booking = {
      status: 'confirmed',
      start: '2026-09-29T07:00:00.000Z',
      end: '2026-09-29T07:30:00.000Z',
      timeZone: 'Europe/Oslo',
      attendee: { name: 'Grace Hopper', email: 'grace@example.com' },
      meetingUrl: 'https://app.cal.com/video/example',
      provider: 'cal.com',
      providerBookingId: 'booking_1',
      eventTitle: 'Intro call',
    }
    const payment = {
      status: 'paid',
      amount: 40,
      currency: 'USD',
      amountRefunded: 0,
      receiptUrl: 'https://pay.stripe.com/receipts/example',
      paidAt: '2026-09-24T10:12:00.000Z',
      refundedAt: null,
      disputedAt: null,
      provider: 'stripe',
      providerPaymentIntentId: 'pi_1',
    }
    const body = makeEventBody('submission.completed')
    const eventData = body.data as Record<string, Record<string, unknown>>
    body.data = {
      ...eventData,
      answers: { ...eventData.answers, book_a_call: booking, pay_the_fee: payment },
      display: { ...eventData.display, book_a_call: 'Intro call · Sep 29, 2026, 9:00 AM - 9:30 AM (Europe/Oslo)', pay_the_fee: '$40.00 USD · Paid' },
    }
    const rawBody = JSON.stringify(body)
    const ctx = makeWebhookContext({ body, secret: SECRET, rawBody, signatureHeader: signEvent(SECRET, Math.floor(Date.now() / 1000), rawBody) })

    const result = await new FormbaseTrigger().webhook.call(ctx as never)
    const data = (result.workflowData?.[0]?.[0]?.json as Record<string, Record<string, unknown>>).data

    expect(data.answers.book_a_call).toEqual(booking)
    expect(data.answers.pay_the_fee).toEqual(payment)
    expect(data.display.pay_the_fee).toBe('$40.00 USD · Paid')
  })

  it.each([
    ['missing signature', undefined, undefined],
    ['invalid signature', `t=${Math.floor(Date.now() / 1000)},sha256=${'0'.repeat(64)}`, undefined],
    ['missing raw body', 'valid', false],
  ] as const)('rejects %s', async (_name, signatureHeader, rawBody) => {
    const body = makeEventBody('submission.completed')
    const serializedBody = JSON.stringify(body)
    const resolvedHeader = signatureHeader === 'valid' ? signEvent(SECRET, Math.floor(Date.now() / 1000), serializedBody) : signatureHeader
    const ctx = makeWebhookContext({ body, secret: SECRET, signatureHeader: resolvedHeader, rawBody })

    const result = await new FormbaseTrigger().webhook.call(ctx as never)

    expect(result).toEqual({ noWebhookResponse: true })
    expect(ctx._response.status).toHaveBeenCalledWith(401)
    expect(ctx._response.send).toHaveBeenCalledWith('Unauthorized')
    expect(ctx.getBodyData).not.toHaveBeenCalled()
  })

  it('rejects a valid signature outside the five-minute replay window', async () => {
    const body = makeEventBody('submission.completed')
    const rawBody = JSON.stringify(body)
    const ctx = makeWebhookContext({ body, secret: SECRET, rawBody, signatureHeader: signEvent(SECRET, Math.floor(Date.now() / 1000) - 301, rawBody) })

    const result = await new FormbaseTrigger().webhook.call(ctx as never)

    expect(result).toEqual({ noWebhookResponse: true })
    expect(ctx._response.status).toHaveBeenCalledWith(401)
  })
})
