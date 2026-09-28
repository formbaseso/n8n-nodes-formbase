import type { Icon, ICredentialTestRequest, ICredentialType, INodeProperties } from 'n8n-workflow'

import { FORMBASE_API_RESOURCE_URL, FORMBASE_CREDENTIAL_TYPE } from '../nodes/Formbase/constants'

export class FormbaseOAuth2Api implements ICredentialType {
  name = FORMBASE_CREDENTIAL_TYPE

  extends = ['oAuth2Api']

  // n8n's verification scanner ignores eslint-disable comments, so the brand takes title case here.
  displayName = 'Formbase OAuth2 API'

  icon: Icon = {
    light: 'file:../nodes/Formbase/formbase-logo.svg',
    dark: 'file:../nodes/Formbase/formbase-logo.dark.svg',
  }

  documentationUrl = 'https://docs.formbase.so/guides/n8n/connect/'

  properties: INodeProperties[] = [
    {
      displayName: 'Use Dynamic Client Registration',
      name: 'useDynamicClientRegistration',
      type: 'hidden',
      default: true,
    },
    {
      displayName: 'Server URL',
      name: 'serverUrl',
      type: 'hidden',
      default: FORMBASE_API_RESOURCE_URL,
      required: true,
    },
  ]

  test: ICredentialTestRequest = {
    request: {
      url: '={{$credentials.serverUrl}}',
      method: 'POST',
      body: {
        method: 'me.get',
        params: {},
      },
    },
  }
}
