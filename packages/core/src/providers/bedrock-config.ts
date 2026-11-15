import path from 'node:path';
import { resolveBedrockProfileEnvironment } from './bedrock-profile.js';
import { BedrockEcsCredentials, type BedrockEcsConfig } from './bedrock-ecs.js';
import type { BedrockProviderConfig } from './index.js';

/** Trusted host selection only: explicit profile intent never silently changes identity to a container source. */
export async function resolveBedrockCredentialsEnvironment(env: NodeJS.ProcessEnv, signal?: AbortSignal, allowNetwork = true): Promise<BedrockProviderConfig | undefined> {
  signal?.throwIfAborted();
  if (env.AWS_PROFILE) return resolveBedrockProfileEnvironment(env, signal);
  if (!allowNetwork || env.AWS_BEARER_TOKEN_BEDROCK || env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
    || !env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI && !env.AWS_CONTAINER_CREDENTIALS_FULL_URI) return undefined;
  const bedrockEcs: BedrockEcsConfig = { relativeUri: env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || undefined, fullUri: env.AWS_CONTAINER_CREDENTIALS_FULL_URI || undefined,
    authorizationToken: env.AWS_CONTAINER_AUTHORIZATION_TOKEN || undefined,
    authorizationTokenFile: env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE ? path.resolve(env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE) : undefined, signal };
  try { new BedrockEcsCredentials(bedrockEcs); } catch { return undefined; } // Endpoint/header/path admission only, no file read or GET.
  signal?.throwIfAborted(); return { type: 'bedrock', model: env.BEDROCK_MODEL, baseUrl: env.BEDROCK_BASE_URL, region: env.AWS_REGION || env.AWS_DEFAULT_REGION, bedrockEcs };
}
