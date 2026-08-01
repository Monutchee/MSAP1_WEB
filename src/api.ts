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
  source: 'physical' | 'simulator' | 'unknown'
  physical_diagnostics_available: boolean
  simulator_healthy: boolean
  simulator_active_generation: number
  simulator_frame_count: number
  simulator_saturation_count: number
  simulator_missed_sample_count: number
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

export interface AdcSource {
  source: 'physical' | 'simulator'
  configuration_generation: number
  active: boolean
  healthy: boolean
}

export interface AdcSimulatorChannel {
  channel: number
  rms: number
  phase_degrees: number
}

export interface AdcSimulatorConfiguration {
  frequency_hz: number
  channels: AdcSimulatorChannel[]
  active_source: 'physical' | 'simulator'
  configuration_generation: number
  active_generation: number
  generated_frames: number
  saturation_count: number
  missed_sample_count: number
  healthy: boolean
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

export interface SocTemperature {
  zone: string
  label: string
  available: boolean
  millidegrees_c: number
  temperature_c: number
}

export interface SocTemperatures {
  sampled_at_unix_ms: number
  sensors: SocTemperature[]
}

export interface SystemAbout {
  available: boolean
  product: string
  operating_system: string
  yocto_system_version: string
  build_hex: string
  software_build_date: string
  image_recipe: string
  machine: string
}

export interface ComponentFingerprint {
  id: string
  label: string
  component_type: string
  path: string
  available: boolean
  size_bytes: number
  md5: string
}

export interface DeveloperAbout {
  digest_algorithm: string
  digest_purpose: string
  components: ComponentFingerprint[]
}

export interface WaveformSession {
  id: number
  state: 'capturing' | 'complete' | 'incomplete'
  trigger_sequence: number
  first_sequence: number
  last_sequence: number
  trigger_tai_nanoseconds: number
  trigger_realtime_nanoseconds: number
  sample_rate_hz: number
  event_count: number
  filename: string
}

export interface WaveformStatus {
  running: boolean
  active_session: boolean
  sample_rate_hz: number
  transport_ring_blocks: number
  blocks: number
  frames: number
  bytes: number
  invalid_blocks: number
  sequence_gaps: number
  transport_overrun_blocks: number
  materialization_failures: number
  history_oldest_sequence: number
  history_latest_sequence: number
  history_capacity_frames: number
  completed_sessions: number
  incomplete_sessions: number
  sessions: WaveformSession[]
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

async function requestBinary(path: string): Promise<ArrayBuffer> {
  const response = await fetch(path, { credentials: 'same-origin' })
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}))
    throw new ApiError(response.status, payload.error ?? `Request failed (${response.status})`)
  }
  return response.arrayBuffer()
}

export function waveformViewPath(filename: string) {
  return `/protected/waveforms/view/${encodeURIComponent(filename)}`
}

export function waveformDownloadPath(filename: string) {
  return `/protected/waveforms/download/${encodeURIComponent(filename)}`
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
  about: () => request<SystemAbout>('/api/v1/about'),
  meterReadings: () => request<MeterReadings>('/api/v1/meter/readings'),
  frequencyConfiguration: () =>
    request<FrequencyConfiguration>('/api/v1/meter/configuration/frequency'),
  updateFrequencyConfiguration: (configuration: FrequencyConfiguration) =>
    request<FrequencyConfiguration>('/api/v1/meter/configuration/frequency', {
      method: 'PUT',
      body: JSON.stringify(configuration),
    }),
  adcSource: () => request<AdcSource>('/api/v1/adc/source'),
  updateAdcSource: (source: AdcSource['source']) =>
    request<AdcSource>('/api/v1/adc/source', {
      method: 'PUT',
      body: JSON.stringify({ source }),
    }),
  adcSimulator: () =>
    request<AdcSimulatorConfiguration>('/api/v1/adc/simulator'),
  updateAdcSimulator: (configuration: AdcSimulatorConfiguration) =>
    request<AdcSimulatorConfiguration>('/api/v1/adc/simulator', {
      method: 'PUT',
      body: JSON.stringify(configuration),
    }),
  waveforms: () => request<WaveformStatus>('/api/v1/waveforms'),
  waveformFile: (filename: string) => requestBinary(waveformViewPath(filename)),
  triggerWaveform: (pretrigger_ms: number, posttrigger_ms: number) =>
    request<WaveformStatus>('/api/v1/waveforms/trigger', {
      method: 'POST',
      body: JSON.stringify({ pretrigger_ms, posttrigger_ms }),
    }),
  deleteWaveform: (session_id: number) =>
    request<WaveformStatus>('/api/v1/waveforms', {
      method: 'DELETE',
      body: JSON.stringify({ session_id }),
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
  developerTemperatures: () =>
    request<SocTemperatures>('/api/v1/developer/temperatures'),
  developerAbout: () =>
    request<DeveloperAbout>('/api/v1/developer/about'),
}
