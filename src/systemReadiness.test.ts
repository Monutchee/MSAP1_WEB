import { describe, expect, it } from 'vitest'
import type { SystemHealth } from './api'
import { classifySystemReadiness } from './systemReadiness'

function health(overrides: Partial<SystemHealth['acquisition']> = {}, healthy = true) {
  return {
    healthy,
    acquisition: {
      running: true, record_available: true, record_stale: false,
      record_age_ms: 0, rpu_health_age_ms: 0, health_probe_failures: 0,
      health_probe_pending: false, records: 1, bytes: 1, read_errors: 0,
      invalid_records: 0, lifetime_invalid_records: 0, sequence_gaps: 0,
      configuration_generation: 1, ...overrides,
    },
  } as SystemHealth
}

describe('system readiness classification', () => {
  it('treats retryable startup errors and a reachable pipeline awaiting its first record as initializing', () => {
    expect(classifySystemReadiness(undefined, {
      code: 'system_not_ready', retryable: true,
    })).toEqual({ state: 'initializing', acquisitionReachable: false, liveDataReady: false })
    expect(classifySystemReadiness(health({ record_available: false }, false)))
      .toEqual({ state: 'initializing', acquisitionReachable: true, liveDataReady: false })
  })

  it('distinguishes healthy, degraded, and unavailable states and rejects stale live data', () => {
    expect(classifySystemReadiness(health()).state).toBe('healthy')
    expect(classifySystemReadiness(health({ record_stale: true }, false)))
      .toEqual({ state: 'degraded', acquisitionReachable: true, liveDataReady: false })
    expect(classifySystemReadiness(undefined, { code: 'network_failure' }).state)
      .toBe('unavailable')
  })
})
