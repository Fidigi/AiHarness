export const syntheticStsRole = 'arn:aws:iam::123456789012:role/SyntheticNativeRole';
export const syntheticStsSecret = 'SyntheticSTSSecret/+=';
export const syntheticStsSession = 'SyntheticSTSSession/+=';
export function syntheticStsXml(key: string, expiresAt = Date.now() + 3600000): string {
  return `<?xml version="1.0" encoding="UTF-8"?><AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleWithWebIdentityResult><Credentials><AccessKeyId>${key}</AccessKeyId><SecretAccessKey>${syntheticStsSecret}</SecretAccessKey><SessionToken>${syntheticStsSession}</SessionToken><Expiration>${new Date(expiresAt).toISOString()}</Expiration></Credentials></AssumeRoleWithWebIdentityResult><ResponseMetadata><RequestId>synthetic-request</RequestId></ResponseMetadata></AssumeRoleWithWebIdentityResponse>`;
}
