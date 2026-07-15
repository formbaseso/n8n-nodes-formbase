import type {
  IHookFunctions,
  ILoadOptionsFunctions,
  IWebhookFunctions,
  IHttpRequestOptions,
} from 'n8n-workflow'
import { NodeApiError } from 'n8n-workflow'

import { FORMBASE_API_RESOURCE_URL, FORMBASE_OAUTH2_CREDENTIAL_NAME } from './constants'

export type FormbaseRpcContext = IHookFunctions | ILoadOptionsFunctions | IWebhookFunctions

interface FormbaseRpcOk<T> {
  ok: true
  data: T
}

interface FormbaseRpcErr {
  ok: false
  error: { code: string; message: string }
}

type FormbaseRpcResponse<T> = FormbaseRpcOk<T> | FormbaseRpcErr

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

export async function formbaseApiRequest<T = unknown>(
  this: FormbaseRpcContext,
  method: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  const credentials = await this.getCredentials(FORMBASE_OAUTH2_CREDENTIAL_NAME)
  const resourceUrl = String(credentials.serverUrl ?? FORMBASE_API_RESOURCE_URL).replace(/\/+$/, '')

  const options: IHttpRequestOptions = {
    method: 'POST',
    url: resourceUrl,
    body: { method, params },
    json: true,
    ignoreHttpStatusErrors: true,
    returnFullResponse: false,
  }

  // HTTP helper returns untyped JSON at this external API boundary.
  const response = (await this.helpers.httpRequestWithAuthentication.call(
    this,
    FORMBASE_OAUTH2_CREDENTIAL_NAME,
    options
  )) as FormbaseRpcResponse<T>

  if (!response || typeof response !== 'object') {
    throw new NodeApiError(this.getNode(), { message: 'Invalid response from Formbase API' })
  }

  if (response.ok === false) {
    const code = response.error?.code ?? 'INTERNAL_ERROR'
    const message = response.error?.message ?? 'Formbase API error'
    throw new NodeApiError(this.getNode(), { message, code }, {
      message: `${code}: ${message}`,
      httpCode: String(ERROR_CODE_TO_HTTP[code] ?? 500),
    })
  }

  if (response.ok !== true || !('data' in response)) {
    throw new NodeApiError(this.getNode(), { message: 'Invalid response from Formbase API' })
  }

  return response.data
}
