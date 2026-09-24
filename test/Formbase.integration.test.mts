/**
 * The formbase node against a formbase API speaking real HTTP: create a
 * request that waits for its outcome, read it, remind, list, cancel, replay.
 * Only n8n's own helpers are stood in for; `formbaseApiRequest` and the wire
 * format are the real ones.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { NodeApiError } from 'n8n-workflow'

import { Formbase } from '../nodes/Formbase/Formbase.node'
import { FakeFormbase, makeHelpers } from './fakeFormbase.mts'

const RESUME_URL = 'https://n8n.example.com/webhook-waiting/exec_1'

let formbase: FakeFormbase

beforeAll(async () => {
  formbase = await new FakeFormbase({
    forms: [
      { id: 'form_live', name: 'Vendor onboarding', published: true },
      { id: 'form_draft', name: 'Draft', published: false },
    ],
    fields: {
      form_live: [
        { key: 'company_name', type: 'text', title: 'Company', required: true, prefillable: true },
        { key: 'case_id', type: 'hidden', title: 'Case', required: false, prefillable: false, context: true },
      ],
    },
  }).start()
})

afterAll(() => formbase.stop())

function makeExecuteContext(parameters: Record<string, unknown>) {
  return {
    ...makeHelpers(formbase.baseUrl),
    getInputData: vi.fn().mockReturnValue([{ json: {} }]),
    getNodeParameter: vi.fn((name: string, _itemIndex: number, fallback?: unknown) => parameters[name] ?? fallback),
    evaluateExpression: vi.fn().mockReturnValue(RESUME_URL),
    continueOnFail: vi.fn().mockReturnValue(false),
    helpers: {
      ...makeHelpers(formbase.baseUrl).helpers,
      returnJsonArray: (input: unknown) => (Array.isArray(input) ? input : [input]).map((json) => ({ json })),
      constructExecutionMetaData: (items: Array<{ json: unknown }>, { itemData }: { itemData: { item: number } }) =>
        items.map((item) => ({ ...item, pairedItem: itemData })),
    },
  }
}

async function runOperation(parameters: Record<string, unknown>) {
  const [items] = await new Formbase().execute.call(makeExecuteContext({ resource: 'request', ...parameters }) as never)
  return items.map((item) => item.json as Record<string, unknown>)
}

describe('formbase node lifecycle', () => {
  it('creates a request that resumes the workflow, then reads, reminds, lists, cancels and replays it', async () => {
    const node = new Formbase()

    // 1. The pickers list the workspace's forms and the selected form's keys.
    const forms = await node.methods.loadOptions.getForms.call(makeHelpers(formbase.baseUrl) as never)
    expect(forms).toEqual([
      { name: 'Vendor onboarding', value: 'form_live' },
      { name: 'Draft', value: 'form_draft' },
    ])
    const picker = { ...makeHelpers(formbase.baseUrl), getCurrentNodeParameter: () => 'form_live' }
    expect(await node.methods.loadOptions.getPrefillKeys.call(picker as never)).toEqual([{ name: 'Company (company_name)', value: 'company_name' }])
    expect(await node.methods.loadOptions.getContextKeys.call(picker as never)).toEqual([{ name: 'Case (case_id)', value: 'case_id' }])

    // 2. Create sends the resume URL as the callback and the external ID as the idempotency key.
    const [created] = await runOperation({
      operation: 'create',
      formId: 'form_live',
      recipientEmail: 'ada@acme.com',
      prefill: { values: [{ key: 'company_name', value: 'Acme' }] },
      context: { values: [{ key: 'case_id', value: 'CASE-9' }] },
      readonly: ['company_name'],
      waitForOutcome: true,
      additionalFields: { externalId: 'run-42', metadata: '{"runId":"run-42"}' },
    })
    expect(created).toMatchObject({ id: 'req_1', status: 'pending', url: 'https://forms.formbase.so/r/rq_req_1', hasCallback: true, deduplicated: false })
    expect(formbase.requests.get('req_1')?.params).toEqual({
      formId: 'form_live',
      recipient: { email: 'ada@acme.com' },
      prefill: { company_name: 'Acme' },
      context: { case_id: 'CASE-9' },
      readonly: ['company_name'],
      externalId: 'run-42',
      idempotencyKey: 'run-42',
      metadata: { runId: 'run-42' },
      callbackUrl: RESUME_URL,
    })

    // 3. A retried run with the same external ID gets the same request back.
    const [again] = await runOperation({
      operation: 'create',
      formId: 'form_live',
      recipientEmail: 'ada@acme.com',
      prefill: { values: [{ key: 'company_name', value: 'Acme' }] },
      context: { values: [{ key: 'case_id', value: 'CASE-9' }] },
      readonly: ['company_name'],
      waitForOutcome: true,
      additionalFields: { externalId: 'run-42', metadata: '{"runId":"run-42"}' },
    })
    expect(again).toMatchObject({ id: 'req_1', deduplicated: true })
    expect(formbase.requests.size).toBe(1)

    // 4. Get, remind and list read it back.
    const [read] = await runOperation({ operation: 'get', requestId: 'req_1' })
    expect(read).toMatchObject({ id: 'req_1', status: 'pending', answers: null })
    const [reminded] = await runOperation({ operation: 'remind', requestId: 'req_1' })
    expect(reminded).toMatchObject({ id: 'req_1', remindersSent: 1 })
    const listed = await runOperation({ operation: 'getAll', scope: 'form', formId: 'form_live', returnAll: true, filters: { externalId: 'run-42' } })
    expect(listed.map((item) => item.id)).toEqual(['req_1'])

    // 5. Replaying a pending request is refused; cancel settles it, then the replay goes through.
    await expect(runOperation({ operation: 'replayCallback', requestId: 'req_1' })).rejects.toSatisfy(
      (error: unknown) => error instanceof NodeApiError && error.httpCode === '409'
    )
    const [canceled] = await runOperation({ operation: 'cancel', requestId: 'req_1', reason: 'duplicate' })
    expect(canceled).toMatchObject({ id: 'req_1', status: 'canceled', cancelReason: 'duplicate' })
    const [replayed] = await runOperation({ operation: 'replayCallback', requestId: 'req_1' })
    expect(replayed).toEqual({ dispatchId: 'disp_req_1', eventId: 'evt_req_1' })
  })

  it('titles the error with the formbase code and message, and names the cause underneath', async () => {
    const body = { formId: 'form_live', recipientEmail: 'a@example.com', additionalFields: { delivery: 'none', externalId: 'run-conflict' } }
    await runOperation({ operation: 'create', ...body })

    await expect(runOperation({ operation: 'create', ...body, recipientEmail: 'b@example.com' })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof NodeApiError &&
        error.httpCode === '409' &&
        error.message === 'CONFLICT: Idempotency key "run-conflict" was already used for a different request. Use a new key, or resend the original body.' &&
        error.description === 'Reason: IDEMPOTENCY_CONFLICT. Field: idempotencyKey'
    )
  })

  it('surfaces an unpublished form as the formbase validation error', async () => {
    await expect(runOperation({ operation: 'create', formId: 'form_draft' })).rejects.toSatisfy(
      (error: unknown) => error instanceof NodeApiError && error.httpCode === '400' && error.description === 'FORM_NOT_PUBLISHED'
    )
  })
})
