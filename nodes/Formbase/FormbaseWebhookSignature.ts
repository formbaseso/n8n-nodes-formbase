import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import type { IWebhookFunctions } from 'n8n-workflow'

const SIGNATURE_HEADER_PATTERN = /^t=(\d+),sha256=([a-f0-9]{64})$/
const SIGNATURE_MAX_AGE_SECONDS = 5 * 60

function getRawBody(request: ReturnType<IWebhookFunctions['getRequestObject']>): Buffer | undefined {
  if (!('rawBody' in request)) return undefined

  const rawBody: unknown = request.rawBody
  if (Buffer.isBuffer(rawBody)) return rawBody
  if (typeof rawBody === 'string') return Buffer.from(rawBody)
  return undefined
}

export function createFormbaseWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('hex')}`
}

export function verifyFormbaseWebhookSignature(context: IWebhookFunctions): boolean {
  const webhookData = context.getWorkflowStaticData('node')
  const secret = webhookData.webhookSecret
  if (typeof secret !== 'string' || secret.length === 0) return false

  const signatureHeader = context.getHeaderData()['x-formbase-signature']
  if (typeof signatureHeader !== 'string') return false

  const match = SIGNATURE_HEADER_PATTERN.exec(signatureHeader)
  if (!match) return false

  const [, timestamp, signatureHex] = match
  const timestampSeconds = Number(timestamp)
  if (!Number.isSafeInteger(timestampSeconds)) return false

  const currentTimestampSeconds = Math.floor(Date.now() / 1000)
  if (Math.abs(currentTimestampSeconds - timestampSeconds) > SIGNATURE_MAX_AGE_SECONDS) return false

  const rawBody = getRawBody(context.getRequestObject())
  if (!rawBody) return false

  const expectedSignature = createHmac('sha256', secret).update(timestamp).update('.').update(rawBody).digest()
  const receivedSignature = Buffer.from(signatureHex, 'hex')

  return expectedSignature.length === receivedSignature.length && timingSafeEqual(expectedSignature, receivedSignature)
}
