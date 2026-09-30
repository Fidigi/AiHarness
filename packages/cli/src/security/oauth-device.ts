export interface OAuthDeviceConfig {
  deviceAuthorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  scope?: string;
}

export interface OAuthDevicePrompt {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

export class OAuthDeviceClient {
  constructor(private readonly config: OAuthDeviceConfig) {}

  async requestCode(): Promise<OAuthDevicePrompt> {
    const response = await fetch(this.config.deviceAuthorizationUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ client_id: this.config.clientId, ...(this.config.scope ? { scope: this.config.scope } : {}) }),
    });
    if (!response.ok) throw new Error(`OAuth device authorization failed (${response.status})`);
    const data = await response.json() as Record<string, unknown>;
    return {
      deviceCode: String(data.device_code),
      userCode: String(data.user_code),
      verificationUri: String(data.verification_uri || data.verification_url),
      verificationUriComplete: typeof data.verification_uri_complete === 'string' ? data.verification_uri_complete : undefined,
      expiresIn: Number(data.expires_in) || 900,
      interval: Number(data.interval) || 5,
    };
  }

  async pollToken(prompt: OAuthDevicePrompt, signal?: AbortSignal): Promise<string> {
    const deadline = Date.now() + prompt.expiresIn * 1000;
    let interval = prompt.interval * 1000;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('Authentification OAuth annulée.');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, interval);
        signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Authentification OAuth annulée.')); }, { once: true });
      });
      const response = await fetch(this.config.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          client_id: this.config.clientId,
          device_code: prompt.deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
        signal,
      });
      const data = await response.json() as Record<string, unknown>;
      if (typeof data.access_token === 'string') return data.access_token;
      if (data.error === 'slow_down') {
        interval += 5000;
        continue;
      }
      if (data.error === 'authorization_pending') continue;
      throw new Error(`OAuth token exchange failed: ${String(data.error_description || data.error || response.status)}`);
    }
    throw new Error('Le code OAuth a expiré.');
  }
}

export function oauthConfigFromEnv(provider: string): OAuthDeviceConfig | undefined {
  const prefix = `AI_HARNESS_OAUTH_${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const deviceAuthorizationUrl = process.env[`${prefix}_DEVICE_URL`];
  const tokenUrl = process.env[`${prefix}_TOKEN_URL`];
  const clientId = process.env[`${prefix}_CLIENT_ID`];
  if (!deviceAuthorizationUrl || !tokenUrl || !clientId) return undefined;
  return { deviceAuthorizationUrl, tokenUrl, clientId, scope: process.env[`${prefix}_SCOPE`] };
}
