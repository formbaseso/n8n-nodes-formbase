import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NodeApiError } from 'n8n-workflow'

import { formbaseApiRequest } from '../nodes/Formbase/GenericFunctions'

function makeContext(httpResponse: unknown, opts?: { serverUrl?: string }) {
  const httpRequestWithAuthentication = vi.fn().mockResolvedValue(httpResponse)
  const ctx = {
    getCredentials: vi.fn().mockResolvedValue({
      serverUrl: opts?.serverUrl ?? 'https://api.formbase.so/api/v1',
    }),
    getNode: vi.fn().mockReturnValue({ name: 'formbase Trigger', type: 'formbaseTrigger', typeVersion: 1 }),
    helpers: {
      httpRequestWithAuthentication,
    },
  }
  return { ctx, httpRequestWithAuthentication }
}

describe('formbaseApiRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns data from a successful JSON-RPC response', async () => {
    const { ctx, httpRequestWithAuthentication } = makeContext({
      ok: true,
      data: { id: 'u1', email: 'a@b.com', name: 'Ada' },
    })

    const result = await formbaseApiRequest(ctx as never, 'me.get')

    expect(result).toEqual({ id: 'u1', email: 'a@b.com', name: 'Ada' })
    expect(httpRequestWithAuthentication).toHaveBeenCalledTimes(1)
    const [credentialName, options] = httpRequestWithAuthentication.mock.calls[0]
    expect(credentialName).toBe('formbaseOAuth2Api')
    expect(options).toMatchObject({
      method: 'POST',
      url: 'https://api.formbase.so/api/v1',
      body: { method: 'me.get', params: {} },
      json: true,
    })
    // Non-2xx statuses must keep throwing inside n8n's helper: that is what
    // triggers the OAuth refresh on a 401.
    expect(options).not.toHaveProperty('ignoreHttpStatusErrors')
  })

  it('strips trailing slashes from the configured API base URL', async () => {
    const { ctx, httpRequestWithAuthentication } = makeContext(
      { ok: true, data: null },
      { serverUrl: 'https://example.convex.site/api/v1///' }
    )

    await formbaseApiRequest(ctx as never, 'me.get')

    expect(httpRequestWithAuthentication.mock.calls[0][1].url).toBe('https://example.convex.site/api/v1')
  })

  it('maps an error envelope to a NodeApiError with the matching HTTP code', async () => {
    const { ctx } = makeContext({
      ok: false,
      error: { code: 'UNAUTHORIZED', message: 'Bad API token' },
    })

    await expect(formbaseApiRequest(ctx as never, 'me.get')).rejects.toMatchObject({
      message: expect.stringContaining('UNAUTHORIZED'),
      httpCode: '401',
    })
  })

  it('maps unknown methods to HTTP 404', async () => {
    const { ctx } = makeContext({
      ok: false,
      error: { code: 'METHOD_NOT_FOUND', message: 'Unknown method: bogus.method' },
    })

    await expect(formbaseApiRequest(ctx as never, 'bogus.method')).rejects.toMatchObject({
      message: expect.stringContaining('METHOD_NOT_FOUND'),
      httpCode: '404',
    })
  })

  it('rejects malformed API responses', async () => {
    const { ctx } = makeContext({ success: true })

    await expect(formbaseApiRequest(ctx as never, 'me.get')).rejects.toBeInstanceOf(NodeApiError)
  })

  it('forwards params unchanged', async () => {
    const { ctx, httpRequestWithAuthentication } = makeContext({ ok: true, data: [] })

    await formbaseApiRequest(ctx as never, 'forms.list', { workspaceId: 'w1', limit: 100 })

    expect(httpRequestWithAuthentication.mock.calls[0][1].body).toEqual({
      method: 'forms.list',
      params: { workspaceId: 'w1', limit: 100 },
    })
  })
})
