import type { Icon, ICredentialTestRequest, ICredentialType, INodeProperties } from 'n8n-workflow'

import { FORMBASE_API_RESOURCE_URL, FORMBASE_OAUTH2_CREDENTIAL_NAME } from '../nodes/Formbase/constants'

export class FormbaseOAuth2Api implements ICredentialType {
  name = FORMBASE_OAUTH2_CREDENTIAL_NAME

  extends = ['oAuth2Api']

  // eslint-disable-next-line n8n-nodes-base/cred-class-field-display-name-miscased -- formbase brand is lowercase.
  displayName = 'formbase OAuth2 API'

  icon: Icon = {
    light: 'file:../nodes/Formbase/formbase-logo.svg',
    dark: 'file:../nodes/Formbase/formbase-logo.dark.svg',
  }

  documentationUrl = 'https://github.com/formbaseso/n8n-nodes-formbase#configure-credentials'

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
