import type { IExecuteFunctions, INodeExecutionData, INodeType, INodeTypeDescription } from 'n8n-workflow'
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow'

import { requestProperties } from './actions/RequestDescription'
import type { FieldLookup } from './actions/RequestCreate'
import { isRequestOperation, REQUEST_OPERATIONS } from './actions/RequestOperations'
import { FORMBASE_CREDENTIAL_TYPE } from './constants'
import { listFields, type FormField } from './FormbaseCatalog'
import { listSearch, loadOptions, resourceMapping } from './FormbaseMethods'
import { isNodeError } from './NodeErrors'

/** `fields.list` for each form an execution creates requests for, called once per form however many items there are. */
function createFieldLookup(context: IExecuteFunctions): FieldLookup {
  const byForm = new Map<string, Promise<FormField[]>>()
  return (formId) => {
    const cached = byForm.get(formId)
    if (cached) return cached
    const fields = listFields(context, formId)
    byForm.set(formId, fields)
    return fields
  }
}

export class Formbase implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'formbase',
    name: 'formbase',
    icon: { light: 'file:formbase-logo.svg', dark: 'file:formbase-logo.dark.svg' },
    group: ['transform'],
    version: [1, 2],
    defaultVersion: 2,
    subtitle: '={{ $parameter["operation"] + ": " + $parameter["resource"] }}',
    description: 'Create, read, cancel and remind formbase requests, and pause a workflow until a customer completes one',
    defaults: {
      name: 'formbase',
    },
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    usableAsTool: true,
    credentials: [
      {
        name: FORMBASE_CREDENTIAL_TYPE,
        required: true,
      },
    ],
    properties: requestProperties,
  }

  methods = { loadOptions, listSearch, resourceMapping }

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData()
    const returnData: INodeExecutionData[] = []
    const operation = this.getNodeParameter('operation', 0) as string
    if (!isRequestOperation(operation)) {
      throw new NodeOperationError(this.getNode(), `The operation "${operation}" is not supported`)
    }
    const run = REQUEST_OPERATIONS[operation]
    const fieldsOf = createFieldLookup(this)

    for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
      try {
        const data = await run(this, itemIndex, fieldsOf)
        returnData.push(
          ...this.helpers.constructExecutionMetaData(this.helpers.returnJsonArray(data), { itemData: { item: itemIndex } })
        )
      } catch (error) {
        if (this.continueOnFail()) {
          const message = error instanceof Error ? error.message : String(error)
          returnData.push({ json: { error: message }, pairedItem: { item: itemIndex } })
          continue
        }
        // formbase errors already carry their code and message; anything else gets the failing item.
        throw isNodeError(error) ? error : new NodeOperationError(this.getNode(), error as Error, { itemIndex })
      }
    }

    return [returnData]
  }
}
