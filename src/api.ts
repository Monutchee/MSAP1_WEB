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

export interface MeterBlockTiming {
  block_sequence: number
  first_sample_index: number
  sample_count: number
  cycle_count: number
  nominal_frequency_hz: number
  cycle_locked: boolean
  free_run_fallback: boolean
  time_quality: 'unsynchronized' | 'synchronized' | 'holdover'
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
  // Absent while the meter still emits old-format records without
  // IEC 61000-4-30 basic measurement block timing.
  timing?: MeterBlockTiming
}

/**
 * One channel of a 150/180-cycle aggregate. The aggregate publishes RMS only:
 * there is no mean correction term and no per-channel RMS accumulator count,
 * so those fields are absent rather than zero.
 */
export interface MeterAggregateChannel {
  index: number
  name: string
  unit: string
  valid: boolean
  rms: number
}

/**
 * Aggregate grid frequency. Per IEC 61000-4-30:2025 the standardized frequency
 * product is defined over its own 10 s interval, which this tier is not, so the
 * APU publishes the Cycles150_180 frequency with quality "unavailable". The
 * value is informative only and deliberately carries no validity flag.
 */
export interface MeterAggregateFrequency {
  millihz: number
  informative: true
}

/**
 * A produced 150/180-cycle aggregate: exactly 15 consecutive basic measurement
 * blocks, so 150 cycles at 50 Hz nominal and 180 cycles at 60 Hz nominal.
 */
export interface MeterAggregateResult {
  available: true
  sequence: number
  configuration_generation: number
  sample_rate_hz: number
  sample_count: number
  first_sample_index: number
  first_basic_sequence: number
  last_basic_sequence: number
  basic_block_count: number
  cycle_count: number
  nominal_frequency_hz: number
  arithmetic_error: boolean
  time_quality: 'unsynchronized' | 'synchronized' | 'holdover'
  age_ms: number
  channels: MeterAggregateChannel[]
  frequency: MeterAggregateFrequency
}

/**
 * No aggregate has been produced yet: acquisition is healthy but 15 consecutive
 * eligible basic measurement blocks have not been collected. Nothing beyond
 * `available` is required to be present.
 */
export interface MeterAggregatePending {
  available: false
}

/**
 * Discriminated on `available` so the pending state must be handled before any
 * aggregate field can be read.
 */
export type MeterAggregate = MeterAggregateResult | MeterAggregatePending

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

export interface RmsSettings {
  window_ms: number
  remove_dc: boolean
}

export interface CurrentChannelConfiguration {
  channel: number
  name: string
  enabled: boolean
  adc_pga_gain: number
  sensor_model: string
  primary_rated_amps: number
  secondary_rated_amps: number
  burden_ohms: number
  rated_output_millivolts: number
  frontend_gain: number
}

export interface VoltageChannelConfiguration {
  channel: number
  name: string
  enabled: boolean
  adc_pga_gain: number
  rin_ohms: number
  rf_ohms: number
}

export interface ModbusTcpSettings {
  enabled: boolean
  listen_address: string
  port: number
  maximum_clients: number
  unit_id: number
}

export interface ModbusRtuPortSettings {
  enabled: boolean
  device: string
  baud_rate: number
  parity: 'none' | 'even' | 'odd'
  data_bits: 7 | 8
  stop_bits: 1 | 2
  unit_id: number
}

/** Persistent Modbus policy owned by the central MSAP1 settings service. */
export interface ModbusSettings {
  enabled: boolean
  tcp: ModbusTcpSettings
  rtu: ModbusRtuPortSettings[]
}

export interface ProductSettings {
  schema_version: number
  metering: {
    sample_rate_hz: number
    // Declared nominal grid frequency (50 or 60), selecting the
    // IEC 61000-4-30 basic block: 50 Hz -> 10 cycles, 60 Hz -> 12 cycles.
    nominal_frequency_hz: number
    rms: RmsSettings
    frequency: FrequencyConfiguration
    conversion: {
      profile_id: string
      adc_reference_volts: number
      current_channels: CurrentChannelConfiguration[]
      voltage_channels: VoltageChannelConfiguration[]
    }
  }
  adc: {
    source: AdcSource['source']
    simulator: {
      frequency_hz: number
      channels: AdcSimulatorChannel[]
    }
  }
  waveform: {
    default_pretrigger_ms: number
    default_posttrigger_ms: number
  }
  database: DatabaseSettings
  modbus: ModbusSettings
}

export type StorageBackend = 'memory' | 'persistent'

export interface DatasetStorageSettings {
  backend: StorageBackend
  maximum_age_seconds: number
  maximum_bytes: number
  volatile_spool_acknowledged: boolean
}

export interface DatabaseSettings {
  spool: DatasetStorageSettings
  basic: DatasetStorageSettings
  cycles_150_180: DatasetStorageSettings
  minutes_10: DatasetStorageSettings
  hours_2: DatasetStorageSettings
}

export interface DatabaseConsumerCursor {
  name: string
  acknowledged_cursor: number
}

export interface DatabaseDatasetStatus {
  dataset: string
  backend: StorageBackend
  block_count: number
  storage_bytes: number
  oldest_nanoseconds?: number
  newest_nanoseconds?: number
}

export interface DatabaseStatus {
  policies: DatabaseSettings
  stream: {
    healthy: boolean
    durability: boolean
    oldest_cursor: number
    newest_cursor: number
    record_count: number
    storage_bytes: number
    consumers: DatabaseConsumerCursor[]
  }
  historian: {
    healthy: boolean
    migration_in_progress: boolean
    backfill_incomplete: boolean
    acknowledged_cursor: number
    oldest_available_stream_cursor: number
    newest_stream_cursor: number
    lag_records: number
    block_count: number
    storage_bytes: number
    datasets: DatabaseDatasetStatus[]
  }
}

export type HistorianDataset =
  'basic' | 'cycles_150_180' | 'minutes_10' | 'hours_2'

export type DatabaseMaintenanceRequest =
  | { action: 'clear_datasets'; datasets: HistorianDataset[]; confirmed: true }
  | { action: 'recreate_historian'; datasets: []; confirmed: true }

export interface HistoryCapability {
  id: string
  unit: string
}

export interface HistoryCapabilities {
  periods: string[]
  attributes: HistoryCapability[]
  maximum_points: number
}

export interface HistoryQuery {
  period: string
  attributes: string[]
  start_nanoseconds: number
  end_nanoseconds: number
  limit: number
}

export interface HistoryPoint {
  measured_at_nanoseconds: number
  source_sequence: number
  attribute: string
  value: number
  quality: string
}

export interface HistoryResponse {
  period: string
  points: HistoryPoint[]
  truncated: boolean
}

export interface SettingsDocument {
  content_hash: string
  recovery_mode: boolean
  recovery_reason: string
  settings: ProductSettings
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
  meterAggregate: () => request<MeterAggregate>('/api/v1/meter/aggregate'),
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
  activeSettings: () => request<SettingsDocument>('/api/v1/settings/active'),
  saveSettings: (settings: ProductSettings) =>
    request<SettingsDocument>('/api/v1/settings/active', {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),
  factoryResetSettings: () =>
    request<SettingsDocument>('/api/v1/settings/factory-reset', {
      method: 'POST',
      body: JSON.stringify({ confirmed: true }),
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
  developerDatabase: () =>
    request<DatabaseStatus>('/api/v1/developer/database'),
  updateDeveloperDatabase: (settings: DatabaseSettings) =>
    request<DatabaseStatus>('/api/v1/developer/database', {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),
  maintainDeveloperDatabase: (maintenance: DatabaseMaintenanceRequest) =>
    request<DatabaseStatus>('/api/v1/developer/database/maintenance', {
      method: 'POST',
      body: JSON.stringify(maintenance),
    }),
  historyCapabilities: () =>
    request<HistoryCapabilities>('/api/v1/meter/history/capabilities'),
  historyQuery: (query: HistoryQuery) =>
    request<HistoryResponse>('/api/v1/meter/history/query', {
      method: 'POST',
      body: JSON.stringify(query),
    }),
}
