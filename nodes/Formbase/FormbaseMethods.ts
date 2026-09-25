import type {
  ILoadOptionsFunctions,
  INodeListSearchResult,
  INodePropertyOptions,
  ResourceMapperFields,
} from 'n8n-workflow'

import { listFields, listForms, listRequestsPage, searchFormsByName, type FormField, type FormSummary, type RequestSummary } from './FormbaseCatalog'
import { fieldOption, isPrefillable, mappableFields, mapperField } from './FormFields'

/**
 * A form as a picker lists it. An unpublished form is still offered, since a
 * trigger can be wired up before the form goes live, but it says so: a
 * request needs a published form.
 */
function formOption(form: FormSummary): INodePropertyOptions {
  return { name: form.isPublished ? form.name : `${form.name} (not published)`, value: form.id }
}

/** How a request reads in a picker: who it is for, where it stands, and the caller's id for it. */
function requestOption(request: RequestSummary): INodePropertyOptions {
  const recipient = request.recipient.email || request.recipient.name || 'No recipient'
  const name = [recipient, request.status, request.externalId].filter(Boolean).join(' · ')
  return { name, value: request.id }
}

/** The picked form's id, whether the Form parameter is a dropdown (version 1) or a resource locator (version 2). */
function currentFormId(context: ILoadOptionsFunctions): string | undefined {
  const formId = context.getCurrentNodeParameter('formId', { extractValue: true })
  return typeof formId === 'string' && formId.length > 0 ? formId : undefined
}

/** The picked form's fields that pass `keep`, as options; nothing until a form is picked. */
async function currentFieldOptions(context: ILoadOptionsFunctions, keep: (field: FormField) => boolean): Promise<INodePropertyOptions[]> {
  const formId = currentFormId(context)
  if (!formId) return []
  const fields = await listFields(context, formId)
  return fields.filter(keep).map(fieldOption)
}

export async function getForms(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
  const forms = await listForms(this)
  return forms.map(formOption)
}

export const loadOptions = {
  getForms,

  async getPrefillKeys(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
    return currentFieldOptions(this, isPrefillable)
  },

  async getContextKeys(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
    return currentFieldOptions(this, (field) => field.context === true)
  },

  async getDocumentsKeys(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
    return currentFieldOptions(this, (field) => field.type === 'documents')
  },
}

export const listSearch = {
  /** Every form, or with a search term the forms whose name matches it. */
  async searchForms(this: ILoadOptionsFunctions, filter?: string): Promise<INodeListSearchResult> {
    const forms = filter ? await searchFormsByName(this, filter) : await listForms(this)
    return { results: forms.map(formOption) }
  },

  /** The workspace's requests, newest first, one formbase page per list page. */
  async searchRequests(this: ILoadOptionsFunctions, _filter?: string, paginationToken?: string): Promise<INodeListSearchResult> {
    const page = await listRequestsPage(this, paginationToken)
    return {
      results: page.items.map(requestOption),
      paginationToken: page.hasMore ? (page.nextCursor ?? undefined) : undefined,
    }
  },
}

export const resourceMapping = {
  /** The Fields mapper of Create: every field of the picked form a request can carry a value for. */
  async getMappingFields(this: ILoadOptionsFunctions): Promise<ResourceMapperFields> {
    const formId = currentFormId(this)
    if (!formId) return { fields: [] }
    const fields = await listFields(this, formId)
    return {
      fields: mappableFields(fields).map(mapperField),
      emptyFieldsNotice: 'This form has no field a request can fill in. Publish the form first, or pick another one.',
    }
  },
}
