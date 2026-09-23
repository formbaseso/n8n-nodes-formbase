import type {
  IExecuteFunctions,
  IHookFunctions,
  ILoadOptionsFunctions,
  IWebhookFunctions,
  IHttpRequestOptions,
} from 'n8n-workflow'
import { NodeApiError } from 'n8n-workflow'

import { FORMBASE_API_RESOURCE_URL, FORMBASE_OAUTH2_CREDENTIAL_NAME } from './constants'

export type FormbaseRpcContext = IExecuteFunctions | IHookFunctions | ILoadOptionsFunctions | IWebhookFunctions

interface FormbaseRpcOk<T> {
  ok: true
  data: T
}

interface FormbaseRpcErr {
  ok: false
  error: { code: string; message: string }
}

type FormbaseRpcResponse<T> = FormbaseRpcOk<T> | FormbaseRpcErr

/** Mirrors ERROR_CODE_TO_STATUS on the formbase API, for a 200 that carries an error envelope. */
const ERROR_CODE_TO_HTTP: Record<string, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  UPGRADE_REQUIRED: 402,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
}

/**
 * Call one formbase JSON-RPC method and return its `data`.
 *
 * n8n's authenticated request helper refreshes the OAuth token on a 401 and
 * throws a NodeApiError (with `httpCode`) for any other non-2xx status, so
 * the error envelope below is only unwrapped when the API answered 200.
 */
export async function formbaseApiRequest<T = unknown>(
  context: FormbaseRpcContext,
  method: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  const credentials = await context.getCredentials(FORMBASE_OAUTH2_CREDENTIAL_NAME)
  const resourceUrl = String(credentials.serverUrl ?? FORMBASE_API_RESOURCE_URL).replace(/\/+$/, '')

  const options: IHttpRequestOptions = {
    method: 'POST',
    url: resourceUrl,
    body: { method, params },
    json: true,
    returnFullResponse: false,
  }

  // The HTTP helper returns untyped JSON at this external API boundary.
  const response = (await context.helpers.httpRequestWithAuthentication.call(
    context,
    FORMBASE_OAUTH2_CREDENTIAL_NAME,
    options
  )) as FormbaseRpcResponse<T> | null

  if (!response || typeof response !== 'object') {
    throw new NodeApiError(context.getNode(), { message: 'Invalid response from formbase API' })
  }

  if (response.ok === false) {
    const code = response.error?.code ?? 'INTERNAL_ERROR'
    const message = response.error?.message ?? 'formbase API error'
    throw new NodeApiError(
      context.getNode(),
      { message, code },
      { message: `${code}: ${message}`, httpCode: String(ERROR_CODE_TO_HTTP[code] ?? 500) }
    )
  }

  if (response.ok !== true || !('data' in response)) {
    throw new NodeApiError(context.getNode(), { message: 'Invalid response from formbase API' })
  }

  return response.data
}
