export const DEFAULT_FORMBASE_API_URL = 'https://api.formbase.so'

export const FORMBASE_API_PATH = '/api/v1'

export const FORMBASE_API_RESOURCE_URL = `${DEFAULT_FORMBASE_API_URL}${FORMBASE_API_PATH}`

export const FORMBASE_OAUTH2_CREDENTIAL_NAME = 'formbaseOAuth2Api'

export const FORMBASE_WEBHOOK_EVENTS = {
  submissionCreated: 'submission_created',
  submissionAbandoned: 'submission_abandoned',
} as const

export type FormbaseWebhookEvent = (typeof FORMBASE_WEBHOOK_EVENTS)[keyof typeof FORMBASE_WEBHOOK_EVENTS]
