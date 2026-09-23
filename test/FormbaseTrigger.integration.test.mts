/**
 * The whole node against a formbase API speaking real HTTP: pick a form,
 * activate (register a signed subscription), receive a delivery, re-check on
 * the next activation, deactivate. Only n8n's own helpers are stood in for;
 * `formbaseApiRequest` and the wire format are the real ones.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { NodeApiError } from 'n8n-workflow'

import { FormbaseTrigger } from '../nodes/Formbase/FormbaseTrigger.node'
import { ACCESS_TOKEN, FakeFormbase, makeHelpers } from './fakeFormbase.mts'

const WEBHOOK_URL = 'https://n8n.example.com/webhook/formbase'

let formbase: FakeFormbase

beforeAll(async () => {
  formbase = await new FakeFormbase({
    forms: [
      { id: 'form_live', name: 'Vendor onboarding', published: true },
      { id: 'form_draft', name: 'Draft', published: false },
    ],
  }).start()
})

afterAll(() => formbase.stop())

function makeHookContext(options: { event?: string; idleWindow?: string; staticData?: Record<string, unknown>; accessToken?: string } = {}) {
  const staticData = options.staticData ?? {}
  return {
    ...makeHelpers(formbase.baseUrl, options.accessToken ?? ACCESS_TOKEN),
    getNodeWebhookUrl: vi.fn().mockReturnValue(WEBHOOK_URL),
    getNodeParameter: vi.fn((name: string) => {
      if (name === 'formId') return 'form_live'
      if (name === 'event') return options.event ?? 'submission_created'
      if (name === 'idleWindow') return options.idleWindow ?? '12h'
      return undefined
    }),
    getWorkflowStaticData: vi.fn().mockReturnValue(staticData),
    staticData,
  }
}

function makeWebhookContext(staticData: Record<string, unknown>, delivery: { headers: Record<string, string>; content: string }) {
  const response = { status: vi.fn(), send: vi.fn(), end: vi.fn() }
  response.status.mockReturnValue(response)
  response.send.mockReturnValue(response)
  return {
    ...makeHelpers(formbase.baseUrl),
    getBodyData: vi.fn().mockReturnValue(JSON.parse(delivery.content)),
    getHeaderData: vi.fn().mockReturnValue(delivery.headers),
    getRequestObject: vi.fn().mockReturnValue({ rawBody: Buffer.from(delivery.content) }),
    getResponseObject: vi.fn().mockReturnValue(response),
    getWorkflowStaticData: vi.fn().mockReturnValue(staticData),
    response,
  }
}

describe('formbase Trigger lifecycle', () => {
  it('goes from form picker to delivered submission and back to deactivated', async () => {
    const trigger = new FormbaseTrigger()

    // 1. The form picker lists the workspace's forms.
    const forms = await trigger.methods.loadOptions.getForms.call(makeHelpers(formbase.baseUrl) as never)
    expect(forms).toEqual([
      { name: 'Vendor onboarding', value: 'form_live' },
      { name: 'Draft', value: 'form_draft' },
    ])

    // 2. Activation finds nothing registered yet, then registers a signed subscription.
    const activation = makeHookContext()
    expect(await trigger.webhookMethods.default.checkExists.call(activation as never)).toBe(false)
    expect(await trigger.webhookMethods.default.create.call(activation as never)).toBe(true)
    const subscriptionId = activation.staticData.subscriptionId as string
    expect(formbase.subscriptions.get(subscriptionId)).toMatchObject({
      provider: 'n8n',
      targetUrl: WEBHOOK_URL,
      eventType: 'submission_created',
      signingSecret: activation.staticData.webhookSecret,
    })

    // 3. formbase delivers a submission; the node verifies it and emits the envelope untouched.
    const event = formbase.buildEvent({
      formId: 'form_live',
      answers: { company_name: 'Acme', plan: 'pro', contacts: [{ name: 'Ada' }] },
      display: { company_name: 'Acme', plan: 'Pro', contacts: 'Ada' },
      request: { id: 'req_1', externalId: 'run-42' },
    })
    const delivery = formbase.deliver(subscriptionId, event)
    const received = makeWebhookContext(activation.staticData, delivery)
    const result = await trigger.webhook.call(received as never)
    expect(result.workflowData).toEqual([[{ json: event }]])
    expect(received.response.status).not.toHaveBeenCalled()

    // 4. A delivery signed with another secret is answered 401 and starts nothing.
    const forged = { ...delivery, headers: { ...delivery.headers, 'x-formbase-signature': delivery.headers['x-formbase-signature'].replace(/sha256=.*/, `sha256=${'0'.repeat(64)}`) } }
    const rejected = makeWebhookContext(activation.staticData, forged)
    expect(await trigger.webhook.call(rejected as never)).toEqual({ noWebhookResponse: true })
    expect(rejected.response.status).toHaveBeenCalledWith(401)

    // 5. The next activation recognises its own subscription and registers nothing new.
    const reactivation = makeHookContext({ staticData: activation.staticData })
    expect(await trigger.webhookMethods.default.checkExists.call(reactivation as never)).toBe(true)
    expect(formbase.subscriptions.size).toBe(1)

    // 6. Changing the event replaces the subscription rather than adding a second delivery path.
    const changed = makeHookContext({ event: 'submission_abandoned', idleWindow: '3d', staticData: activation.staticData })
    expect(await trigger.webhookMethods.default.checkExists.call(changed as never)).toBe(false)
    expect(await trigger.webhookMethods.default.create.call(changed as never)).toBe(true)
    expect(formbase.subscriptions.size).toBe(2)
    expect(formbase.subscriptions.get(changed.staticData.subscriptionId as string)).toMatchObject({ eventType: 'submission_abandoned', idleWindow: '3d' })
    // The created-submission subscription is not this node's any more, but it belongs to a different event, so it is left alone …
    expect(formbase.subscriptions.has(subscriptionId)).toBe(true)

    // 7. Deactivation removes the subscription; deactivating again is still a success.
    expect(await trigger.webhookMethods.default.delete.call(changed as never)).toBe(true)
    expect(changed.staticData).toEqual({})
    expect(await trigger.webhookMethods.default.delete.call(changed as never)).toBe(true)

    // … and is cleaned up when the node activates on that event again without a secret for it.
    const orphaned = makeHookContext({ staticData: { subscriptionId } })
    expect(await trigger.webhookMethods.default.checkExists.call(orphaned as never)).toBe(false)
    expect(formbase.subscriptions.size).toBe(0)
  })

  it('treats a subscription formbase already dropped as deleted', async () => {
    const trigger = new FormbaseTrigger()
    const ctx = makeHookContext({ staticData: { subscriptionId: 'int_gone', webhookSecret: 'x' } })

    expect(await trigger.webhookMethods.default.delete.call(ctx as never)).toBe(true)
    expect(ctx.staticData).toEqual({})
  })

  it('surfaces an expired token as a 401 NodeApiError so n8n refreshes the credential', async () => {
    const trigger = new FormbaseTrigger()
    const ctx = makeHookContext({ accessToken: 'fbo_expired' })

    await expect(trigger.webhookMethods.default.checkExists.call(ctx as never)).rejects.toSatisfy((error: unknown) => {
      return error instanceof NodeApiError && error.httpCode === '401'
    })
  })
})
