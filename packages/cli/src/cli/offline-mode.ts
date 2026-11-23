/** Process-only startup policy, not a network sandbox or a ban on explicit turns. */
export function resolveOfflineMode(flag?: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  return flag === true || /^(?:1|true|yes)$/iu.test(env.AI_HARNESS_OFFLINE?.trim() ?? '');
}
