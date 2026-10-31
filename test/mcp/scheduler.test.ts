import { expect, test } from "vitest";
import { msUntilNextHour, startNightly } from "../../src/mcp/scheduler.js";

test("msUntilNextHour returns time until today's hour when it's still ahead", () => {
  expect(msUntilNextHour(4, new Date("2026-07-24T01:00:00"))).toBe(3 * 3600 * 1000);
});

test("msUntilNextHour rolls to tomorrow when the hour has passed", () => {
  expect(msUntilNextHour(4, new Date("2026-07-24T05:00:00"))).toBe(23 * 3600 * 1000);
});

test("startNightly schedules once with an injected timer and runs the task when fired", async () => {
  let ran = 0;
  const fns: (() => void)[] = [];
  const fakeTimer = (fn: () => void) => { fns.push(fn); return 0 as unknown as ReturnType<typeof setTimeout>; };
  const h = startNightly(async () => { ran++; }, { hour: 4, now: () => new Date("2026-07-24T01:00:00"), timer: fakeTimer });
  expect(fns.length).toBe(1);
  fns[0]();
  await new Promise((r) => setTimeout(r, 0));
  expect(ran).toBe(1);
  h.stop();
});

test("startNightly logs a failing task's error and still reschedules", async () => {
  const fns: (() => void)[] = [];
  const fakeTimer = (fn: () => void) => { fns.push(fn); return 0 as unknown as ReturnType<typeof setTimeout>; };
  const errors: unknown[][] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { errors.push(a); };
  try {
    startNightly(async () => { throw new Error("boom"); }, { hour: 4, now: () => new Date("2026-07-24T01:00:00"), timer: fakeTimer });
    fns[0]();
    await new Promise((r) => setTimeout(r, 0));
    expect(errors.length).toBeGreaterThan(0);
    expect(fns.length).toBe(2); // rescheduled after the failure
  } finally {
    console.error = orig;
  }
});
