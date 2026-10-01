import { useEffect } from 'react';
import type { SubagentRunSnapshot } from '@ai-harness/core';
import { useI18n } from '../hooks/useI18n';
import { listSubagentRuns } from '../services/api';
import { publishNotice } from '../services/notices';

const notifiedRuns = new Set<string>();

function terminal(status: SubagentRunSnapshot['status']): boolean {
  return ['completed', 'failed', 'stopped'].includes(status);
}

/** Route-independent completion monitoring for background child agents. */
export function SubagentMonitor() {
  const { t } = useI18n();

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const result = await listSubagentRuns();
      if (disposed) return;
      if (result.success && result.data) {
        for (const run of result.data) {
          if (!run.attention || !terminal(run.status) || notifiedRuns.has(run.id)) continue;
          notifiedRuns.add(run.id);
          while (notifiedRuns.size > 200) notifiedRuns.delete(notifiedRuns.values().next().value!);
          publishNotice(
            t(run.status === 'completed' ? 'subagents.completedNotice' : 'subagents.failedNotice', {
              profile: run.profileName,
            }),
            { level: run.status === 'completed' ? 'success' : 'warning', id: `subagent:${run.id}` },
          );
        }
        timer = setTimeout(poll, result.data.some(run => !terminal(run.status)) ? 1_000 : 4_000);
      } else timer = setTimeout(poll, 5_000);
    };
    void poll();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [t]);

  return null;
}
