// Milliseconds from `now` until the next local occurrence of `hour:00:00`.
export function msUntilNextHour(hour: number, now: Date): number {
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

export interface SchedulerHandle {
  stop(): void;
}

// Run `task` at the next `hour` (default 4am local), then every 24h. A failing
// task is caught so it never breaks the schedule. `timer`/`now` are injectable
// for tests; production uses setTimeout + the real clock.
export function startNightly(
  task: () => Promise<void>,
  opts: { hour?: number; now?: () => Date; timer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> } = {},
): SchedulerHandle {
  const hour = opts.hour ?? 4;
  const clock = opts.now ?? (() => new Date());
  const timer = opts.timer ?? setTimeout;
  let handle: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    handle = timer(() => {
      void task().catch((err) => { console.error("[scheduler] nightly task failed:", err); }).then(schedule);
    }, msUntilNextHour(hour, clock()));
  };
  schedule();
  return { stop: () => { if (handle) clearTimeout(handle); } };
}
