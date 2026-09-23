import { createHmac } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { NodeApiError } from 'n8n-workflow'
import { vi } from 'vitest'

export const ACCESS_TOKEN = 'fbo_access'
const IDLE_WINDOWS = ['12h', '1d', '3d', '1w']

interface FakeForm {
  id: string
  name: string
  published: boolean
}

interface StoredSubscription {
  subscriptionId: string
  formId: string
  provider: string
  targetUrl: string
  eventType: string
  idleWindow?: string
  status: 'active'
  createdAt: number
  signingSecret?: string
}

type RpcResult = { data: unknown } | { status: number; error: { code: string; message: string } }

export interface FakeEventOptions {
  formId: string
  type?: string
  test?: boolean
  answers?: Record<string, unknown>
  display?: Record<string, string>
  pdfUrl?: string | null
  request?: Record<string, unknown>
}

export function signEvent(secret: string, timestampSeconds: number, rawBody: string): string {
  const digest = createHmac('sha256', secret).update(`${timestampSeconds}.${rawBody}`).digest('hex')
  return `t=${timestampSeconds},sha256=${digest}`
}

/**
 * An in-process formbase external API: enough of `POST /api/v1` for the node to
 * run its whole lifecycle over real HTTP. It validates like the server (bearer
 * token, webhooks.create rules), stores subscriptions, and signs deliveries with
 * the secret each subscription registered.
 */
export class FakeFormbase {
  readonly workspace = { id: 'ws_1', name: 'Acme' }
  readonly forms: FakeForm[]
  readonly fields: Record<string, unknown[]>
  readonly subscriptions = new Map<string, StoredSubscription>()
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = []
  baseUrl = ''
  private server?: http.Server
  private nextSubscriptionId = 1

  constructor(options: { forms?: FakeForm[]; fields?: Record<string, unknown[]> } = {}) {
    this.forms = options.forms ?? [{ id: 'form_1', name: 'Customer Feedback', published: true }]
    this.fields = options.fields ?? {}
  }

  async start(): Promise<this> {
    this.server = http.createServer((request, response) => this.handle(request, response))
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', () => resolve()))
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    return this
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server!.close(() => resolve()))
  }

  private handle(request: http.IncomingMessage, response: http.ServerResponse): void {
    let content = ''
    request.on('data', (chunk) => (content += chunk))
    request.on('end', () => {
      const reply = (status: number, body: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(body))
      }
      if (request.url !== '/api/v1' || request.method !== 'POST') {
        return reply(404, { ok: false, error: { code: 'NOT_FOUND', message: 'No route' } })
      }
      if (request.headers.authorization !== `Bearer ${ACCESS_TOKEN}`) {
        return reply(401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Invalid token' } })
      }
      const { method, params = {} } = JSON.parse(content) as { method: string; params?: Record<string, unknown> }
      this.calls.push({ method, params })
      const result = this.dispatch(method, params)
      if ('error' in result) return reply(result.status, { ok: false, error: result.error })
      return reply(200, { ok: true, data: result.data })
    })
  }

  private dispatch(method: string, params: Record<string, unknown>): RpcResult {
    switch (method) {
      case 'me.get':
        return { data: { id: 'u1', email: 'alice@example.com', name: 'Alice' } }
      case 'workspaces.list':
        return { data: { items: [this.workspace], hasMore: false } }
      case 'forms.list':
        return this.listForms(params)
      case 'fields.list':
        return this.listFields(params)
      case 'webhooks.create':
        return this.createWebhook(params)
      case 'webhooks.list':
        return { data: { items: [...this.subscriptions.values()].filter((s) => s.formId === params.formId).map(publicView), hasMore: false } }
      case 'webhooks.delete':
        if (!this.subscriptions.delete(String(params.subscriptionId))) return notFound('Webhook subscription not found')
        return { data: { subscriptionId: params.subscriptionId, deleted: true } }
      case 'submissions.sample':
        return { data: this.buildEvent({ formId: String(params.formId), test: true }) }
      default:
        return { status: 404, error: { code: 'METHOD_NOT_FOUND', message: `Unknown method: ${method}` } }
    }
  }

  private listForms(params: Record<string, unknown>): RpcResult {
    if (params.workspaceId !== this.workspace.id) return notFound('Workspace not found')
    const limit = Number(params.limit ?? 100)
    const start = params.cursor ? Number(params.cursor) : 0
    const items = this.forms.slice(start, start + limit).map((form) => ({ id: form.id, name: form.name, workspaceId: this.workspace.id }))
    const hasMore = start + limit < this.forms.length
    return { data: { items, hasMore, nextCursor: hasMore ? String(start + limit) : null } }
  }

  private listFields(params: Record<string, unknown>): RpcResult {
    const form = this.forms.find((candidate) => candidate.id === params.formId)
    if (!form) return notFound('Form not found')
    if (!form.published) return { data: { published: false, items: [], hasMore: false } }
    return { data: { published: true, items: this.fields[form.id] ?? [], hasMore: false } }
  }

  private createWebhook(params: Record<string, unknown>): RpcResult {
    const invalid = (message: string): RpcResult => ({ status: 400, error: { code: 'VALIDATION_ERROR', message } })
    if (!this.forms.some((form) => form.id === params.formId)) return notFound('Form not found')
    if (!/^https:\/\//.test(String(params.targetUrl ?? ''))) return invalid('targetUrl must be an https URL')
    if (!['zapier', 'make', 'n8n'].includes(String(params.provider))) return invalid('provider must be one of zapier, make, n8n')
    const eventType = String(params.eventType ?? 'submission_created')
    if (eventType !== 'submission_created' && eventType !== 'submission_abandoned') {
      return invalid('eventType must be "submission_created" or "submission_abandoned"')
    }
    if (eventType === 'submission_abandoned' && !IDLE_WINDOWS.includes(String(params.idleWindow))) {
      return invalid('idleWindow is required when eventType is "submission_abandoned"')
    }
    if (eventType === 'submission_created' && params.idleWindow !== undefined) {
      return invalid('idleWindow is only valid when eventType is "submission_abandoned"')
    }
    const signingSecret = params.signingSecret === undefined ? undefined : String(params.signingSecret)
    if (signingSecret !== undefined && (signingSecret.length < 32 || signingSecret.length > 255)) {
      return invalid('signingSecret must be between 32 and 255 characters')
    }
    const subscription: StoredSubscription = {
      subscriptionId: `int_${this.nextSubscriptionId++}`,
      formId: String(params.formId),
      provider: String(params.provider),
      targetUrl: String(params.targetUrl),
      eventType,
      ...(params.idleWindow ? { idleWindow: String(params.idleWindow) } : {}),
      status: 'active',
      createdAt: Date.now(),
      signingSecret,
    }
    this.subscriptions.set(subscription.subscriptionId, subscription)
    return { data: publicView(subscription) }
  }

  /** The event envelope for one form. */
  buildEvent(options: FakeEventOptions): Record<string, unknown> {
    const form = this.forms.find((candidate) => candidate.id === options.formId)
    if (!form) throw new Error(`No form ${options.formId}`)
    const test = options.test ?? false
    return {
      id: test ? 'evt_example000000000000' : `evt_${Math.random().toString(16).slice(2, 14)}`,
      type: options.type ?? 'submission.completed',
      createdAt: '2026-09-22T10:00:00.000Z',
      apiVersion: '2026-09-22',
      test,
      data: {
        form: { id: form.id, name: form.name, snapshotId: form.published ? `snap_${form.id}` : null },
        submission: {
          id: test ? 'sub_example000000000000' : 'sub_1',
          respondentEmail: 'respondent@example.com',
          submittedAt: '2026-09-22T10:00:00.000Z',
          pdfUrl: options.pdfUrl ?? null,
          language: 'en',
        },
        answers: options.answers ?? {},
        display: options.display ?? {},
        ...(options.request ? { request: options.request } : {}),
      },
    }
  }

  /** What formbase POSTs to a subscription's target URL: the signed raw body and its headers. */
  deliver(subscriptionId: string, event: Record<string, unknown>, options: { timestamp?: number } = {}) {
    const subscription = this.subscriptions.get(subscriptionId)
    if (!subscription?.signingSecret) throw new Error(`No signed subscription ${subscriptionId}`)
    const content = JSON.stringify(event)
    const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000)
    return {
      headers: {
        'content-type': 'application/json',
        'x-formbase-event-id': String(event.id),
        'x-formbase-event-type': String(event.type),
        'x-formbase-signature': signEvent(subscription.signingSecret, timestamp, content),
      },
      content,
    }
  }
}

function publicView(subscription: StoredSubscription) {
  const { signingSecret: _secret, ...view } = subscription
  return view
}

function notFound(message: string): RpcResult {
  return { status: 404, error: { code: 'NOT_FOUND', message } }
}

const NODE = { name: 'formbase Trigger', type: 'formbaseTrigger', typeVersion: 1 }

/**
 * The n8n helpers the node touches, backed by real HTTP against `baseUrl`.
 * Like n8n's own helper, a non-2xx status becomes a NodeApiError carrying the
 * status as `httpCode`, so the node's 404-on-delete handling is exercised for real.
 */
export function makeHelpers(baseUrl: string, accessToken = ACCESS_TOKEN) {
  return {
    getCredentials: vi.fn().mockResolvedValue({ serverUrl: `${baseUrl}/api/v1` }),
    getNode: vi.fn().mockReturnValue(NODE),
    helpers: {
      httpRequestWithAuthentication: async function (this: unknown, _credential: string, options: { url: string; body: unknown }) {
        const response = await fetch(options.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
          body: JSON.stringify(options.body),
        })
        const body: unknown = await response.json()
        if (!response.ok) throw new NodeApiError(NODE, body as never, { httpCode: String(response.status) })
        return body
      },
      returnJsonArray: (input: unknown) => [{ json: input }],
    },
  }
}
