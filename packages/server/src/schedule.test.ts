import { describe, expect, it } from 'vitest';
import { nextScheduleRun } from './schedule.js';
describe('scheduled local time',()=>{
  it('skips a nonexistent spring-forward time',()=>{const next=nextScheduleRun('30 2 * * *','America/Chicago',new Date('2026-03-07T08:30:00Z'));expect(next?.toISOString()).toBe('2026-03-09T07:30:00.000Z');});
  it('runs a repeated fall-back time once',()=>{const first=nextScheduleRun('30 1 * * *','America/Chicago',new Date('2026-10-31T06:30:00Z'));expect(first?.toISOString()).toBe('2026-11-01T06:30:00.000Z');const second=nextScheduleRun('30 1 * * *','America/Chicago',first!);expect(second?.toISOString()).toBe('2026-11-02T07:30:00.000Z');});
});
