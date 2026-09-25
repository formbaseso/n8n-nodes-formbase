/**
 * Version 2 of the formbase node: the Form and Request resource locators, the
 * Fields mapper and what Create sends from it. Version 1 keeps its own
 * parameters and is covered by Formbase.test.mts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { INodeProperties } from 'n8n-workflow'

vi.mock('../nodes/Formbase/GenericFunctions', () => ({
  formbaseApiRequest: vi.fn(),
}))

import { formbaseApiRequest } from '../nodes/Formbase/GenericFunctions'
import { Formbase } from '../nodes/Formbase/Formbase.node'

const mockedRequest = formbaseApiRequest as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  mockedRequest.mockReset()
})

const NODE = { name: 'formbase', type: 'formbase', typeVersion: 2 }

const FIELDS = [
  { key: 'company_name', type: 'text', title: 'Company', prefillable: true },
  { key: 'plan', type: 'select', title: 'Plan', prefillable: true, options: [{ key: 'pro', label: 'Pro' }, { key: 'team', label: 'Team' }] },
  { key: 'topics', type: 'checkbox', title: 'Topics', prefillable: true, options: [{ key: 'news', label: 'News' }, { key: 'offers', label: 'Offers' }] },
  { key: 'seats', type: 'number', title: 'Seats', prefillable: true },
  { key: 'start_date', type: 'date', title: 'Start date', prefillable: true },
  { key: 'rating', type: 'matrix', title: 'How did we do?', prefillable: true, rows: [{ key: 'speed', label: 'Speed' }], columns: [{ key: 'good', label: 'Good' }] },
  { key: 'contacts', type: 'group', repeating: true, members: [{ key: 'name', type: 'text', title: 'Name', prefillable: true }] },
  { key: 'case_id', type: 'hidden', title: 'Case', prefillable: false, context: true },
  { key: 'total', type: 'number', title: 'Total', prefillable: false, calculated: true },
  { key: 'signature', type: 'signature', title: 'Sign here', prefillable: false },
  { key: 'contract', type: 'documents', title: 'Your contract', prefillable: false },
]

function respond(handler: (method: string, params: Record<string, unknown>) => unknown) {
  mockedRequest.mockImplementation((_context: unknown, method: string, params: Record<string, unknown> = {}) =>
    Promise.resolve(handler(method, params))
  )
}

/** Answers `fields.list` with FIELDS and `requests.create` with a created request. */
function respondWithForm() {
  respond((method) => {
    if (method === 'fields.list') return { published: true, items: FIELDS, hasMore: false }
    return { id: 'req_1', status: 'pending', url: 'https://forms.formbase.so/r/rq_1' }
  })
}

function sentParams(method: string): Array<Record<string, unknown>> {
  return mockedRequest.mock.calls.filter((call) => call[1] === method).map((call) => call[2] as Record<string, unknown>)
}

/** A resource locator value, the way n8n stores one. */
function locator(value: string, mode = 'list') {
  return { __rl: true, mode, value }
}

/** Reads a parameter the way n8n does: dotted paths into objects, and `extractValue` unwrapping a resource locator. */
function readParameter(parameters: Record<string, unknown>, name: string, fallback: unknown, options?: { extractValue?: boolean }) {
  const value = name.split('.').reduce<unknown>((current, part) => (current as Record<string, unknown> | undefined)?.[part], parameters)
  if (value === undefined) return fallback
  if (options?.extractValue && typeof value === 'object' && value !== null && '__rl' in value) return (value as { value: unknown }).value
  return value
}

function makeExecuteContext(parameters: Array<Record<string, unknown>>, inputs: Array<Record<string, unknown>> = parameters.map(() => ({}))) {
  return {
    getInputData: vi.fn().mockReturnValue(inputs.map((json) => ({ json }))),
    getNodeParameter: vi.fn((name: string, itemIndex: number, fallback?: unknown, options?: { extractValue?: boolean }) =>
      readParameter(parameters[itemIndex] ?? {}, name, fallback, options)
    ),
    evaluateExpression: vi.fn(),
    continueOnFail: vi.fn().mockReturnValue(false),
    getNode: vi.fn().mockReturnValue(NODE),
    helpers: {
      returnJsonArray: (input: unknown) => (Array.isArray(input) ? input : [input]).map((json) => ({ json })),
      constructExecutionMetaData: (items: Array<{ json: unknown }>, { itemData }: { itemData: { item: number } }) =>
        items.map((item) => ({ ...item, pairedItem: itemData })),
    },
  }
}

function makeLoadOptionsContext(currentParameters: Record<string, unknown> = {}) {
  return {
    getNode: vi.fn().mockReturnValue(NODE),
    getCurrentNodeParameter: vi.fn((name: string, options?: { extractValue?: boolean }) =>
      readParameter(currentParameters, name, undefined, options)
    ),
  }
}

async function run(parameters: Array<Record<string, unknown>>, inputs?: Array<Record<string, unknown>>) {
  const [items] = await new Formbase().execute.call(makeExecuteContext(parameters, inputs) as never)
  return items
}

function propertiesNamed(name: string): INodeProperties[] {
  return new Formbase().description.properties.filter((property) => property.name === name)
}

/** The property named `name` that shows for version 2. */
function v2Property(name: string): INodeProperties | undefined {
  return propertiesNamed(name).find((property) => {
    const versions = property.displayOptions?.show?.['@version']
    return versions === undefined || JSON.stringify(versions) === JSON.stringify([{ _cnd: { gte: 2 } }])
  })
}

describe('formbase node versions', () => {
  it('defaults new nodes to version 2 and keeps version 1 for saved workflows', () => {
    const { description } = new Formbase()

    expect(description.version).toEqual([1, 2])
    expect(description.defaultVersion).toBe(2)
  })

  it('keeps the key/value Prefill and Context lists on version 1 only', () => {
    for (const name of ['prefill', 'context']) {
      expect(propertiesNamed(name).map((property) => property.displayOptions?.show?.['@version'])).toEqual([[1]])
    }
    expect(propertiesNamed('fields').map((property) => property.displayOptions?.show?.['@version'])).toEqual([[{ _cnd: { gte: 2 } }]])
  })

  it('picks the form and the request with a list or an ID on version 2', () => {
    const formIds = propertiesNamed('formId').filter((property) => property.type === 'resourceLocator')
    expect(formIds).toHaveLength(2) // Create, and Get Many in form scope
    for (const formId of formIds) {
      expect(formId.modes?.map((mode) => mode.name)).toEqual(['list', 'id'])
      expect(formId.modes?.[0]?.typeOptions).toEqual({ searchListMethod: 'searchForms', searchable: true })
    }

    const requestId = v2Property('requestId')
    expect(requestId).toMatchObject({ type: 'resourceLocator', default: { mode: 'id', value: '' } })
    expect(requestId?.modes?.map((mode) => mode.name)).toEqual(['id', 'list'])
  })

  it('maps fields with a resource mapper that follows the picked form', () => {
    expect(v2Property('fields')).toMatchObject({
      type: 'resourceMapper',
      typeOptions: {
        loadOptionsDependsOn: ['formId.value'],
        resourceMapper: { resourceMapperMethod: 'getMappingFields', mode: 'add', supportAutoMap: true },
      },
    })
  })
})

describe('Formbase.methods.resourceMapping.getMappingFields', () => {
  it('offers every field a request can fill in, typed by what formbase expects', async () => {
    respondWithForm()
    const ctx = makeLoadOptionsContext({ formId: locator('form_1') })

    const { fields } = await new Formbase().methods.resourceMapping.getMappingFields.call(ctx as never)

    expect(fields.map(({ id, displayName, type }) => ({ id, displayName, type }))).toEqual([
      { id: 'company_name', displayName: 'Company (company_name)', type: 'string' },
      { id: 'plan', displayName: 'Plan (plan)', type: 'options' },
      { id: 'topics', displayName: 'Topics (topics) · list of: news, offers', type: 'array' },
      { id: 'seats', displayName: 'Seats (seats)', type: 'number' },
      { id: 'start_date', displayName: 'Start date (start_date)', type: 'dateTime' },
      { id: 'rating', displayName: 'How did we do? (rating) · row key → column key', type: 'object' },
      { id: 'contacts', displayName: 'contacts · rows of: name', type: 'array' },
      { id: 'case_id', displayName: 'Case (case_id) · context', type: 'string' },
    ])
    expect(fields.find((field) => field.id === 'plan')?.options).toEqual([
      { name: 'Pro', value: 'pro' },
      { name: 'Team', value: 'team' },
    ])
    expect(fields.every((field) => field.required === false && field.display === true)).toBe(true)
    expect(mockedRequest).toHaveBeenCalledWith(expect.anything(), 'fields.list', { formId: 'form_1' })
  })

  it('offers nothing until a form is picked', async () => {
    const ctx = makeLoadOptionsContext({ formId: locator('') })

    await expect(new Formbase().methods.resourceMapping.getMappingFields.call(ctx as never)).resolves.toEqual({ fields: [] })
    expect(mockedRequest).not.toHaveBeenCalled()
  })

  it('reads the picked form of a resource locator in the key pickers too', async () => {
    respondWithForm()
    const ctx = makeLoadOptionsContext({ formId: locator('form_1', 'id') })

    const keys = await new Formbase().methods.loadOptions.getDocumentsKeys.call(ctx as never)

    expect(keys).toEqual([{ name: 'Your contract (contract)', value: 'contract' }])
  })
})

describe('Formbase.methods.listSearch', () => {
  const workspace = { items: [{ id: 'ws_1', name: 'Acme' }], hasMore: false }

  it('lists every form, marking an unpublished one', async () => {
    respond((method) =>
      method === 'workspaces.list'
        ? workspace
        : { items: [{ id: 'f1', name: 'Onboarding', isPublished: true }, { id: 'f2', name: 'Draft', isPublished: false }], hasMore: false }
    )

    const result = await new Formbase().methods.listSearch.searchForms.call(makeLoadOptionsContext() as never)

    expect(result).toEqual({
      results: [
        { name: 'Onboarding', value: 'f1' },
        { name: 'Draft (not published)', value: 'f2' },
      ],
    })
  })

  it('searches forms by name with the typed filter', async () => {
    respond((method) => (method === 'workspaces.list' ? workspace : { items: [{ id: 'f1', name: 'Onboarding', isPublished: true }], hasMore: false }))

    await new Formbase().methods.listSearch.searchForms.call(makeLoadOptionsContext() as never, 'onboard')

    expect(mockedRequest).toHaveBeenCalledWith(expect.anything(), 'forms.list', { workspaceId: 'ws_1', query: 'onboard', limit: 100 })
  })

  it('pages through the newest requests with the formbase cursor', async () => {
    respond((method, params) => {
      if (method === 'workspaces.list') return workspace
      if (params.cursor === undefined) {
        return {
          items: [{ id: 'req_1', status: 'pending', externalId: 'run-42', recipient: { email: 'ada@acme.com', name: 'Ada' } }],
          hasMore: true,
          nextCursor: 'c2',
        }
      }
      return { items: [{ id: 'req_2', status: 'completed', externalId: null, recipient: { email: null, name: null } }], hasMore: false, nextCursor: null }
    })
    const search = new Formbase().methods.listSearch.searchRequests

    const first = await search.call(makeLoadOptionsContext() as never)
    const second = await search.call(makeLoadOptionsContext() as never, undefined, first.paginationToken)

    expect(first).toEqual({ results: [{ name: 'ada@acme.com · pending · run-42', value: 'req_1' }], paginationToken: 'c2' })
    expect(second).toEqual({ results: [{ name: 'No recipient · completed', value: 'req_2' }], paginationToken: undefined })
    expect(mockedRequest).toHaveBeenCalledWith(expect.anything(), 'requests.list', { workspaceId: 'ws_1', limit: 25, cursor: 'c2' })
  })
})

describe('Formbase.execute: create with the Fields mapper', () => {
  const CREATE = { resource: 'request', operation: 'create', formId: locator('form_1') }

  it('splits mapped values into prefill and context by the live field list', async () => {
    respondWithForm()
    // n8n hands a mapped date over as a Luxon DateTime.
    const startDate = { toISODate: () => '2026-03-04' }

    await run([
      {
        ...CREATE,
        fields: {
          mappingMode: 'defineBelow',
          value: {
            company_name: 'Acme',
            plan: 'pro',
            topics: ['news'],
            seats: 12,
            start_date: startDate,
            rating: { speed: 'good' },
            contacts: [{ name: 'Ada' }],
            case_id: 'CASE-9',
            signature: null,
            total: '',
          },
        },
        readonly: ['company_name'],
      },
    ])

    expect(sentParams('requests.create')).toEqual([
      {
        formId: 'form_1',
        prefill: {
          company_name: 'Acme',
          plan: 'pro',
          topics: ['news'],
          seats: 12,
          start_date: '2026-03-04',
          rating: { speed: 'good' },
          contacts: [{ name: 'Ada' }],
        },
        context: { case_id: 'CASE-9' },
        readonly: ['company_name'],
      },
    ])
  })

  it('sends a date typed as text or an ISO timestamp as the date alone', async () => {
    respondWithForm()

    await run([
      { ...CREATE, fields: { mappingMode: 'defineBelow', value: { start_date: '2026-03-04T23:30:00.000Z' } } },
      { ...CREATE, fields: { mappingMode: 'defineBelow', value: { start_date: new Date('2026-05-06T10:00:00.000Z') } } },
    ])

    expect(sentParams('requests.create').map((params) => params.prefill)).toEqual([{ start_date: '2026-03-04' }, { start_date: '2026-05-06' }])
  })

  it('sends a value under a key the form no longer has, so formbase names it in its error', async () => {
    respondWithForm()

    await run([{ ...CREATE, fields: { mappingMode: 'defineBelow', value: { renamed_field: 'x' } } }])

    expect(sentParams('requests.create')[0]).toMatchObject({ prefill: { renamed_field: 'x' } })
  })

  it('maps automatically from the input item, keeping only the form\'s field keys', async () => {
    respondWithForm()

    await run(
      [{ ...CREATE, fields: { mappingMode: 'autoMapInputData', value: null } }],
      [{ company_name: 'Acme', case_id: 'CASE-9', unrelated: 'left out', signature: 'not prefillable' }]
    )

    expect(sentParams('requests.create')).toEqual([{ formId: 'form_1', prefill: { company_name: 'Acme' }, context: { case_id: 'CASE-9' } }])
  })

  it('reads the field list once per form, however many items there are', async () => {
    respondWithForm()
    const item = { ...CREATE, fields: { mappingMode: 'defineBelow', value: { company_name: 'Acme' } } }

    await run([item, item, { ...item, formId: locator('form_2', 'id') }])

    expect(sentParams('fields.list')).toEqual([{ formId: 'form_1' }, { formId: 'form_2' }])
    expect(sentParams('requests.create').map((params) => params.formId)).toEqual(['form_1', 'form_1', 'form_2'])
  })
})

describe('Formbase.execute: operations', () => {
  it('refuses an operation it does not have, even one named like an object method', async () => {
    await expect(run([{ resource: 'request', operation: 'toString' }])).rejects.toThrow('The operation "toString" is not supported')
    expect(mockedRequest).not.toHaveBeenCalled()
  })
})

describe('Formbase.execute: a request picked with the resource locator', () => {
  it.each([
    ['get', 'requests.get'],
    ['remind', 'requests.remind'],
    ['replayCallback', 'requests.replayCallback'],
    ['cancel', 'requests.cancel'],
  ])('%s sends the ID behind the locator', async (operation, method) => {
    respond(() => ({ id: 'req_1' }))

    await run([{ resource: 'request', operation, requestId: locator('req_1') }])

    expect(sentParams(method)).toEqual([{ requestId: 'req_1' }])
  })

  it('lists the requests of the form behind the locator', async () => {
    respond(() => ({ items: [], hasMore: false, nextCursor: null }))

    await run([{ resource: 'request', operation: 'getAll', returnAll: true, scope: 'form', formId: locator('form_1', 'id') }])

    expect(sentParams('requests.list')).toEqual([{ formId: 'form_1', limit: 100 }])
  })
})
