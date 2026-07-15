import { describe, expect, it } from 'vitest'

import { FormbaseOAuth2Api } from '../credentials/FormbaseOAuth2Api.credentials'

describe('FormbaseOAuth2Api', () => {
  it('uses n8n dynamic client registration against the Formbase API resource', () => {
    const credential = new FormbaseOAuth2Api()

    expect(credential.name).toBe('formbaseOAuth2Api')
    expect(credential.displayName).toBe('formbase OAuth2 API')
    expect(credential.extends).toEqual(['oAuth2Api'])
    expect(credential.properties).toEqual([
      expect.objectContaining({
        name: 'useDynamicClientRegistration',
        type: 'hidden',
        default: true,
      }),
      expect.objectContaining({
        name: 'serverUrl',
        type: 'hidden',
        default: 'https://api.formbase.so/api/v1',
        required: true,
      }),
    ])
  })

  it('tests the OAuth bearer token against me.get', () => {
    const credential = new FormbaseOAuth2Api()

    expect(credential.test).toEqual({
      request: {
        url: '={{$credentials.serverUrl}}',
        method: 'POST',
        body: {
          method: 'me.get',
          params: {},
        },
      },
    })
  })
})
