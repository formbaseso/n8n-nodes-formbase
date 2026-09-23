import { NodeApiError, NodeOperationError } from 'n8n-workflow'

import { formbaseApiRequest, type FormbaseRpcContext } from './GenericFunctions'

export interface FormSummary {
  id: string
  name: string
}

export interface WorkspaceSummary {
  id: string
  name: string
}

export interface ListResponse<T> {
  items: T[]
  hasMore: boolean
  nextCursor?: string | null
}

/** One row of `fields.list`: a keyed field of the form's current published version. */
export interface FormField {
  key: string
  type: string
  title?: string
  prefillable?: boolean
  context?: boolean
  calculated?: boolean
}

const PAGE_SIZE = 100

/**
 * Every item of a cursor-paged list method, up to `max`. formbase answers
 * `hasMore` with a `nextCursor`; a page that claims more without one is a
 * broken page, not the end of the list.
 */
export async function collectPages<T>(
  context: FormbaseRpcContext,
  method: string,
  params: Record<string, unknown>,
  max = Number.POSITIVE_INFINITY
): Promise<T[]> {
  const items: T[] = []
  let cursor: string | undefined
  do {
    const page = await formbaseApiRequest<ListResponse<T>>(context, method, {
      ...params,
      limit: Math.min(PAGE_SIZE, max - items.length),
      ...(cursor ? { cursor } : {}),
    })
    items.push(...page.items)
    if (page.hasMore && !page.nextCursor) {
      throw new NodeApiError(context.getNode(), { message: `formbase returned an incomplete ${method} page` })
    }
    cursor = page.hasMore ? (page.nextCursor ?? undefined) : undefined
  } while (cursor && items.length < max)

  return items.slice(0, max)
}

/**
 * The connected workspace. A formbase OAuth token is scoped to the one
 * workspace the user picked on the consent screen, so `workspaces.list`
 * answers with exactly that workspace.
 */
export async function readWorkspace(context: FormbaseRpcContext): Promise<WorkspaceSummary> {
  const workspaces = await formbaseApiRequest<ListResponse<WorkspaceSummary>>(context, 'workspaces.list')
  const workspace = workspaces.items[0]
  if (!workspace) {
    throw new NodeOperationError(context.getNode(), 'This formbase credential has no workspace. Reconnect it and pick one.')
  }
  return workspace
}

/** Every form of the connected workspace, across every `forms.list` page. */
export async function listForms(context: FormbaseRpcContext): Promise<FormSummary[]> {
  const workspace = await readWorkspace(context)
  return collectPages<FormSummary>(context, 'forms.list', { workspaceId: workspace.id })
}

/** The keyed fields of a form's current published version; empty while the form is unpublished. */
export async function listFields(context: FormbaseRpcContext, formId: string): Promise<FormField[]> {
  const fields = await formbaseApiRequest<ListResponse<FormField>>(context, 'fields.list', { formId })
  return fields.items
}
