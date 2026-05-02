/**
 * OAuth 与设备码登录相关 API
 */

import { apiClient } from './client';

export type OAuthProvider =
  | 'codex'
  | 'anthropic'
  | 'antigravity'
  | 'kimi'
  | 'xai'
  | 'kiro';

export interface OAuthStartResponse {
  url?: string;
  state?: string;
}

export type OAuthStatusResponse =
  | { status: 'ok' | 'wait' | 'error'; error?: string }
  | { status: 'device_code'; verification_url: string; user_code: string }
  | { status: 'auth_url'; url: string };

export interface OAuthCallbackResponse {
  status: 'ok';
}

const WEBUI_SUPPORTED: OAuthProvider[] = [
  'codex',
  'anthropic',
  'antigravity',
  'kiro',
  'xai',
];

export const oauthApi = {
  startAuth: (provider: OAuthProvider) => {
    const params: Record<string, string | boolean> = {};
    if (WEBUI_SUPPORTED.includes(provider)) {
      params.is_webui = true;
    }
    return apiClient.get<OAuthStartResponse>(`/${provider}-auth-url`, {
      params: Object.keys(params).length ? params : undefined,
    });
  },

  getAuthStatus: (state: string) =>
    apiClient.get<OAuthStatusResponse>(`/get-auth-status`, {
      params: { state },
    }),

  submitCallback: (provider: OAuthProvider, redirectUrl: string) => {
    return apiClient.post<OAuthCallbackResponse>('/oauth-callback', {
      provider,
      redirect_url: redirectUrl,
    });
  },
};
