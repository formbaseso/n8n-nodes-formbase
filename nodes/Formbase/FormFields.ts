import type { FieldType, INodePropertyOptions, ResourceMapperField } from 'n8n-workflow'

import type { FormField } from './FormbaseCatalog'

/** The values of one request's fields, split the way `requests.create` takes them. */
export interface FieldValues {
  prefill: Record<string, unknown>
  context: Record<string, unknown>
}

/** Fields `requests.create` accepts in `prefill`: visible questions, never a context field or a calculated one. */
export function isPrefillable(field: FormField): boolean {
  if (field.context === true) return false
  if (field.calculated === true) return false
  return field.prefillable !== false
}

/** How a field reads in a picker: its question and, since workflows address it by key, the key. */
function fieldLabel(field: FormField): string {
  return field.title ? `${field.title} (${field.key})` : field.key
}

export function fieldOption(field: FormField): INodePropertyOptions {
  return { name: fieldLabel(field), value: field.key }
}

const SINGLE_CHOICE_TYPES: ReadonlySet<string> = new Set(['radio', 'select'])

/**
 * The n8n input for each `fields.list` type whose prefill value is not text
 * (docs/external-api.md § Prefill value shapes). A single choice is an
 * `options` dropdown of its option keys, handled apart because it needs them.
 */
const MAPPER_TYPE_BY_FIELD_TYPE: Readonly<Record<string, FieldType>> = {
  number: 'number',
  rating: 'number',
  scale: 'number',
  switch: 'boolean',
  date: 'dateTime',
  time: 'time',
  checkbox: 'array',
  ranking: 'array',
  'picture-choice': 'array',
  matrix: 'object',
  group: 'array',
}

/** What to type into a JSON input, for the shapes a label alone does not explain. */
function shapeHint(field: FormField): string | undefined {
  const type = MAPPER_TYPE_BY_FIELD_TYPE[field.type]
  if (type === 'array' && field.options) return `list of: ${field.options.map((option) => option.key).join(', ')}`
  if (field.type === 'matrix') return 'row key → column key'
  if (field.type === 'group' && field.members) return `rows of: ${field.members.map((member) => member.key).join(', ')}`
  return undefined
}

/** The fields a request can carry a value for: every prefillable question and every context field. */
export function mappableFields(fields: FormField[]): FormField[] {
  return fields.filter((field) => field.context === true || isPrefillable(field))
}

/**
 * One field of the Fields mapper. Its id is the field key, so Map
 * Automatically matches an input item's keys to the form's field keys.
 * Nothing is required: a request prefills whatever the workflow has.
 */
export function mapperField(field: FormField): ResourceMapperField {
  const base = { id: field.key, required: false, defaultMatch: false, canBeUsedToMatch: false, display: true }
  if (field.context === true) return { ...base, displayName: `${fieldLabel(field)} · context`, type: 'string' }
  if (SINGLE_CHOICE_TYPES.has(field.type) && field.options) {
    const options = field.options.map((option) => ({ name: option.label, value: option.key }))
    return { ...base, displayName: fieldLabel(field), type: 'options', options }
  }
  const hint = shapeHint(field)
  const displayName = hint ? `${fieldLabel(field)} · ${hint}` : fieldLabel(field)
  return { ...base, displayName, type: MAPPER_TYPE_BY_FIELD_TYPE[field.type] ?? 'string' }
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || value === ''
}

/** A value with a Luxon-style `toISODate`, which is what n8n's field mapper makes of a date. */
function hasToIsoDate(value: unknown): value is { toISODate: () => string | null } {
  return typeof value === 'object' && value !== null && 'toISODate' in value && typeof value.toISODate === 'function'
}

const ISO_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}/

/**
 * A date field's prefill value, `"2026-03-04"`. The mapper hands a date over
 * as a Luxon DateTime; an expression or an input item can hand over an ISO
 * string or a Date. Anything else is left for formbase to reject with its own
 * INVALID_PREFILL_VALUE.
 */
function toIsoDate(value: unknown): unknown {
  if (hasToIsoDate(value)) return value.toISODate()
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'string' && ISO_DATE_PREFIX.test(value)) return value.slice(0, 10)
  return value
}

/**
 * Splits mapped values into `prefill` and `context` by the form's live field
 * list, skipping blanks. `onlyFormFields` is for Map Automatically, where the
 * input item carries whatever the previous node produced and only the keys of
 * this form are meant; a value mapped by hand under a key the form no longer
 * has is sent anyway, so formbase names it in its error.
 */
export function splitFieldValues(fields: FormField[], values: Record<string, unknown>, onlyFormFields: boolean): FieldValues {
  const byKey = new Map(fields.map((field) => [field.key, field]))
  const prefill: Record<string, unknown> = {}
  const context: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(values)) {
    if (isBlank(value)) continue
    const field = byKey.get(key)
    if (!field) {
      if (!onlyFormFields) prefill[key] = value
      continue
    }
    if (field.context === true) context[key] = value
    else if (isPrefillable(field)) prefill[key] = field.type === 'date' ? toIsoDate(value) : value
  }
  return { prefill, context }
}
