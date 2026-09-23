export const DEFAULT_FORMBASE_API_URL = 'https://api.formbase.so'

export const FORMBASE_API_PATH = '/api/v1'

export const FORMBASE_API_RESOURCE_URL = `${DEFAULT_FORMBASE_API_URL}${FORMBASE_API_PATH}`

export const FORMBASE_OAUTH2_CREDENTIAL_NAME = 'formbaseOAuth2Api'

export const FORMBASE_WEBHOOK_EVENTS = {
  submissionCreated: 'submission_created',
  submissionAbandoned: 'submission_abandoned',
  requestCompleted: 'request_completed',
  requestExpired: 'request_expired',
  requestCanceled: 'request_canceled',
} as const

export type FormbaseWebhookEvent = (typeof FORMBASE_WEBHOOK_EVENTS)[keyof typeof FORMBASE_WEBHOOK_EVENTS]

/** Shortest first: a duration list reads by length, not alphabetically. */
export const FORMBASE_IDLE_WINDOW_OPTIONS = [
  { name: '12 Hours', value: '12h' },
  { name: '1 Day', value: '1d' },
  { name: '3 Days', value: '3d' },
  { name: '1 Week', value: '1w' },
] as const

export type FormbaseIdleWindow = (typeof FORMBASE_IDLE_WINDOW_OPTIONS)[number]['value']

const FORMBASE_IDLE_WINDOW_VALUES: ReadonlySet<string> = new Set(
  FORMBASE_IDLE_WINDOW_OPTIONS.map((option) => option.value)
)

export function isFormbaseIdleWindow(value: unknown): value is FormbaseIdleWindow {
  return typeof value === 'string' && FORMBASE_IDLE_WINDOW_VALUES.has(value)
}
