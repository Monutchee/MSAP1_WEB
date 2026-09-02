import type { SystemHealth } from './api'

export type SystemReadinessState =
  | 'initializing'
  | 'healthy'
  | 'degraded'
  | 'unavailable'

export interface SystemReadiness {
  state: SystemReadinessState
  acquisitionReachable: boolean
  liveDataReady: boolean
}

/**
 * Converts the health endpoint into the four operator-facing states. A
 * successful response proves IPC reachability even when the pipeline itself
 * is degraded. Live values require a fresh first record so stale values are
 * never carried across a capture loss.
 */
export function classifySystemReadiness(
  health: SystemHealth | undefined,
  failure?: { code?: string; retryable?: boolean },
): SystemReadiness {
  if (health) {
    const liveDataReady = health.acquisition.running &&
      health.acquisition.record_available && !health.acquisition.record_stale
    if (health.healthy) {
      return { state: 'healthy', acquisitionReachable: true, liveDataReady }
    }
    if (health.acquisition.running && !health.acquisition.record_available) {
      return { state: 'initializing', acquisitionReachable: true, liveDataReady: false }
    }
    return { state: 'degraded', acquisitionReachable: true, liveDataReady }
  }
  if (!failure || (failure.code === 'system_not_ready' && failure.retryable === true)) {
    return { state: 'initializing', acquisitionReachable: false, liveDataReady: false }
  }
  return { state: 'unavailable', acquisitionReachable: false, liveDataReady: false }
}
