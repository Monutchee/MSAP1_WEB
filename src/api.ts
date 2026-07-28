export interface Session {
  username: string
  role: string
}
export interface AcquisitionHealth {
  running: boolean
  record_available: boolean
  record_stale: boolean
  record_age_ms: number
  rpu_health_age_ms: number
  health_probe_failures: number
  health_probe_pending: boolean
  records: number
  bytes: number
  read_errors: number
  invalid_records: number
  sequence_gaps: number
  configuration_generation: number
}

export interface HealthReason {
  code: string
  message: string
}

export interface AdcHealth {
  healthy: boolean
  spi_responsive: boolean
  initialized: boolean
  init_complete: boolean
  configuration_match: boolean
  rate_match: boolean
  capture_active: boolean
  fifo_ok: boolean
  headers_valid: boolean
  meter_configured: boolean
  meter_generation_match: boolean
  dc_offset_removal: boolean
  sample_rate_hz: number
  frames: number
  packets: number
  dclk_frequency_hz: number
  drdy_frequency_hz: number
  fifo_overflows: number
  header_errors: number
  spi_protocol_errors: number
  spi_retry_recoveries: number
  spi_last_failed_register: number
  spi_last_received_header: number
  degraded_reasons: HealthReason[]
}

export interface SystemHealth {
  healthy: boolean
  acquisition: AcquisitionHealth
  adc: AdcHealth
  frequency_arithmetic_ok: boolean
  backend_running: boolean
  nginx_running: boolean
}

export interface MeterChannel {
  index: number
  name: string
  unit: string
  valid: boolean
  mean_micro_units: number
  rms_count: number
  rms: number
}

export interface MeterReadings {
  sequence: number
  configuration_generation: number
  sample_rate_hz: number
  rms_window_samples: number
  status: number
  capture_frames: number
  header_errors: number
  fifo_overflows: number
  packetizer_drops: number
  hub_drops: number
  frequency: FrequencyReading
  channels: MeterChannel[]
}

export interface FrequencyReading {
  enabled: boolean
  valid: boolean
  reference_valid: boolean
  out_of_range: boolean
  timed_out: boolean
  arithmetic_error: boolean
  hz: number
  millihz: number
  period_q16_samples: number
  measurement_sequence: number
  mode: number
  reference_channel: number
  cycles_used: number
}

export interface FrequencyConfiguration {
  enabled: boolean
  reference_channel: number
  mode: 'single_cycle' | 'rolling_cycles' | 'rolling_time'
  averaging_cycles: number
  averaging_window_ms: number
  minimum_hz: number
  maximum_hz: number
  hysteresis_volts: number
}

export type LogPriority =
  | 'emergency'
  | 'alert'
  | 'critical'
  | 'error'
  | 'warning'
  | 'notice'
  | 'info'
  | 'debug'

export interface DeveloperLogEntry {
  timestamp_usec: number
  cursor: string
  priority: LogPriority
  message: string
  component: string
  module: string
  event: string
  request_id: string
  configuration_generation: string
  unit: string
  executable: string
  source_file: string
  source_line: string
  source_function: string
  raw: string
}

export interface DeveloperLogPage {
  entries: DeveloperLogEntry[]
  next_cursor: string
}

export interface DeveloperLogQuery {
  component?: string
  module?: string
  priority?: LogPriority
  after?: string
  limit?: number
}

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new ApiError(response.status, payload.error ?? `Request failed (${response.status})`)
  }
  return payload as T
}

export const api = {
  login: (username: string, password: string) =>
    request<{ status: string }>('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request<{ status: string }>('/api/logout', { method: 'POST' }),
  session: () => request<Session>('/api/v1/session'),
  health: () => request<SystemHealth>('/api/v1/health'),
  meterReadings: () => request<MeterReadings>('/api/v1/meter/readings'),
  frequencyConfiguration: () =>
    request<FrequencyConfiguration>('/api/v1/meter/configuration/frequency'),
  updateFrequencyConfiguration: (configuration: FrequencyConfiguration) =>
    request<FrequencyConfiguration>('/api/v1/meter/configuration/frequency', {
      method: 'PUT',
      body: JSON.stringify(configuration),
    }),
  developerLogs: (query: DeveloperLogQuery = {}) => {
    const parameters = new URLSearchParams()
    if (query.component) parameters.set('component', query.component)
    if (query.module) parameters.set('module', query.module)
    if (query.priority) parameters.set('priority', query.priority)
    if (query.after) parameters.set('after', query.after)
    if (query.limit) parameters.set('limit', query.limit.toString())
    const suffix = parameters.size > 0 ? `?${parameters.toString()}` : ''
    return request<DeveloperLogPage>(`/api/v1/developer/logs${suffix}`)
  },
}
