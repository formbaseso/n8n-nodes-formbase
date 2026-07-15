import type { IAuthenticateGeneric, Icon, ICredentialTestRequest, ICredentialType, INodeProperties } from 'n8n-workflow'

import { DEFAULT_FORMBASE_API_URL, FORMBASE_API_PATH } from '../nodes/Formbase/constants'

export class FormbaseApi implements ICredentialType {
  name = 'formbaseApi'

  displayName = 'Formbase API'

  icon: Icon = { light: 'file:../nodes/Formbase/formbase.svg', dark: 'file:../nodes/Formbase/formbase.dark.svg' }

  documentationUrl = 'https://docs.formbase.so/developers/api-tokens'

  properties: INodeProperties[] = [
    {
      displayName: 'API Key',
      name: 'apiKey',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      required: true,
      description: 'API token from Formbase (OAuth and API Keys). Starts with <code>fb_</code>.',
    },
    {
      displayName: 'API Base URL',
      name: 'baseUrl',
      type: 'string',
      default: DEFAULT_FORMBASE_API_URL,
      required: true,
      description: 'Formbase API origin. Change only for a self-hosted deployment; omit a trailing slash.',
    },
  ]

  authenticate: IAuthenticateGeneric = {
    type: 'generic',
    properties: {
      headers: {
        Authorization: '=Bearer {{$credentials.apiKey}}',
      },
    },
  }

  test: ICredentialTestRequest = {
    request: {
      baseURL: '={{$credentials.baseUrl}}',
      url: FORMBASE_API_PATH,
      method: 'POST',
      body: {
        method: 'me.get',
        params: {},
      },
    },
  }
}
