/**
 * An n8n node error, recognized by its shape. n8n's own helpers throw errors
 * built by n8n's copy of n8n-workflow, and `instanceof` against the copy this
 * package ships fails for them, so a check by class would treat them as
 * unknown and lose their `httpCode`.
 */
export interface NodeErrorShape {
  name: 'NodeApiError' | 'NodeOperationError'
  node: unknown
  message?: string
  httpCode?: string | null
}

export function isNodeError(error: unknown): error is NodeErrorShape {
  if (typeof error !== 'object' || error === null) return false
  if (!('node' in error) || !('name' in error)) return false
  return error.name === 'NodeApiError' || error.name === 'NodeOperationError'
}
