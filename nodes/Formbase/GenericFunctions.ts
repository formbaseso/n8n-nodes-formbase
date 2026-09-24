import type {
  IExecuteFunctions,
  IHookFunctions,
  ILoadOptionsFunctions,
  IWebhookFunctions,
  IHttpRequestOptions,
  JsonObject,
} from 'n8n-workflow'
import { NodeApiError } from 'n8n-workflow'

import { FORMBASE_API_RESOURCE_URL, FORMBASE_OAUTH2_CREDENTIAL_NAME } from './constants'

export type FormbaseRpcContext = IExecuteFunctions | IHookFunctions | ILoadOptionsFunctions | IWebhookFunctions

interface FormbaseRpcOk<T> {
  ok: true
  data: T
}

/** The API's error body; `details` names the specific cause behind a reused code. */
interface FormbaseApiError {
  code: string
  message: string
  details?: { reason?: string; field?: string; validKeys?: string[] }
}

interface FormbaseRpcErr {
  ok: false
  error: FormbaseApiError
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

function isErrorEnvelope(value: unknown): value is FormbaseRpcErr {
  if (typeof value !== 'object' || value === null) return false
  // Untyped JSON from the API boundary; the checks below narrow it.
  const { ok, error } = value as { ok?: unknown; error?: unknown }
  if (ok !== false || typeof error !== 'object' || error === null) return false
  const { code, message } = error as { code?: unknown; message?: unknown }
  return typeof code === 'string' && typeof message === 'string'
}

/**
 * The formbase error body inside an error thrown by n8n's request helper.
 *
 * Checked by shape, not with `instanceof NodeApiError`: n8n can load its own
 * copy of n8n-workflow next to this package's, and the class from one copy
 * does not match an instance from the other.
 */
function errorEnvelopeOf(error: unknown): { error: FormbaseApiError; httpCode: string | undefined } | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  // A thrown value is untyped; the checks below narrow it.
  const { context, httpCode } = error as { context?: { data?: unknown }; httpCode?: unknown }
  if (!isErrorEnvelope(context?.data)) return undefined
  return { error: context.data.error, httpCode: typeof httpCode === 'string' ? httpCode : undefined }
}

/**
 * The formbase error as n8n shows it: `CODE: message` as the title, so a
 * workflow branching on the error can match the code, and the specific cause
 * (reason, the field it concerns, the keys that would have worked) underneath.
 */
function formbaseError(context: FormbaseRpcContext, error: FormbaseApiError, httpCode: string): NodeApiError {
  const { code, message, details } = error
  const causes = [
    details?.reason === undefined ? undefined : `Reason: ${details.reason}`,
    details?.field === undefined ? undefined : `Field: ${details.field}`,
    details?.validKeys === undefined || details.validKeys.length === 0 ? undefined : `Valid keys: ${details.validKeys.join(', ')}`,
  ].filter((cause) => cause !== undefined)
  return new NodeApiError(
    context.getNode(),
    { message, code },
    { message: `${code}: ${message}`, description: causes.length > 0 ? causes.join('. ') : message, httpCode }
  )
}

/**
 * Call one formbase JSON-RPC method and return its `data`.
 *
 * The API answers an error with a non-2xx status and an `{ ok: false, error }`
 * body. n8n's authenticated request helper refreshes the OAuth token on a 401
 * and throws a NodeApiError for any other non-2xx status, titled with a generic
 * status message and holding the body in `context.data`; that body is unwrapped
 * here so the formbase code and message reach the workflow. A 200 that carries
 * the error envelope is unwrapped the same way.
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

  let response: FormbaseRpcResponse<T> | null
  try {
    // The HTTP helper returns untyped JSON at this external API boundary.
    response = (await context.helpers.httpRequestWithAuthentication.call(
      context,
      FORMBASE_OAUTH2_CREDENTIAL_NAME,
      options
    )) as FormbaseRpcResponse<T> | null
  } catch (error) {
    const envelope = errorEnvelopeOf(error)
    if (envelope) {
      throw formbaseError(context, envelope.error, envelope.httpCode ?? String(ERROR_CODE_TO_HTTP[envelope.error.code] ?? 500))
    }
    // Hands back an error that is already a NodeApiError unchanged.
    throw new NodeApiError(context.getNode(), error as JsonObject)
  }

  if (!response || typeof response !== 'object') {
    throw new NodeApiError(context.getNode(), { message: 'Invalid response from formbase API' })
  }

  if (response.ok === false) {
    const code = response.error?.code ?? 'INTERNAL_ERROR'
    const apiError = { ...response.error, code, message: response.error?.message ?? 'formbase API error' }
    throw formbaseError(context, apiError, String(ERROR_CODE_TO_HTTP[code] ?? 500))
  }

  if (response.ok !== true || !('data' in response)) {
    throw new NodeApiError(context.getNode(), { message: 'Invalid response from formbase API' })
  }

  return response.data
}
