import { clearInterval, setInterval } from 'node:timers';

/** Keep an admitted owner alive while joining promises, even when a privileged
 * callback owns no Node handles. This is not a deadline or forced termination. */
export function retainAgentWork(): () => void {
  const reference = setInterval(() => undefined, 60_000);
  return () => clearInterval(reference);
}
