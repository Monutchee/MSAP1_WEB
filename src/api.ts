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
  /** Rejections since the current deliberate capture epoch began. */
  invalid_records: number
  /** Process-lifetime rejection total retained for diagnostics. */
  lifetime_invalid_records: number
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

/** Cached R5C1 aggregation-offload health, independent from R5C0 ADC health. */
export interface AggregationHealth {
  available: boolean
  healthy: boolean
  authoritative: boolean
  transport_available: boolean
  transport_initialized: boolean
  input_healthy: boolean
  engine_ready: boolean
  output_ready: boolean
  output_active: boolean
  probe_pending: boolean
  probe_failures: number
  cache_age_ms: number
  rpmsg_device: string
  health_flags: number
  frames_received: number
  frames_valid: number
  frames_invalid: number
  crc_errors: number
  format_errors: number
  sequence_gaps: number
  ring_overflows: number
  fifo_errors: number
  length_errors: number
  records_queued: number
  records_emitted: number
  output_errors: number
  output_drops: number
  basic_completed: number
  aggregate_completed: number
  ten_minute_completed: number
  two_hour_completed: number
  degraded_reasons: HealthReason[]
}

export interface SystemHealth {
  healthy: boolean
  acquisition: AcquisitionHealth
  adc: AdcHealth
  aggregation: AggregationHealth
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
  block_sample_count: number
  status: number
  capture_frames: number
  header_errors: number
  fifo_overflows: number
  emit_drops: number
  result_drops: number
  frequency: FrequencyReading
  channels: MeterChannel[]
  /** Catalog attributes beyond per-channel RMS (VLL, power, PF, ...):
   *  base engineering units; optional so stale documents render. */
  attributes?: MeterReadingAttribute[]
  // Present on every basic record since the MTR1-v3 format; kept
  // optional so a stale document renders gracefully.
  timing?: MeterBlockTiming
}

export interface MeterReadingAttribute {
  key: string
  unit: string
  valid: boolean
  value: number
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

/**
 * A finalized, clock-aligned ten-minute aggregate produced in programmable
 * logic. Frequency is intentionally absent: its standardized product uses an
 * independent 10-second interval rather than this aggregation tier.
 */
export interface MeterTenMinuteResult {
  available: true
  sequence: number
  configuration_generation: number
  sample_rate_hz: number
  sample_count: number
  first_sample_index: number
  cycle_count: number
  nominal_frequency_hz: number
  arithmetic_error: boolean
  time_quality: 'unsynchronized' | 'synchronized' | 'holdover'
  age_ms: number
  channels: MeterAggregateChannel[]
  attributes: MeterReadingAttribute[]
  /** True only for the operational, still-open interval preview. */
  open_interval: boolean
  /** Open previews are useful for visibility but are not normative results. */
  non_normative: boolean
  source_interval_count: number
  first_source_sequence: number
  last_source_sequence: number
  expected_end_sample_index?: number
  overshoot_samples?: number
  elapsed_milliseconds: number
  time_aligned: boolean
  contaminated: boolean
  boundary_valid: boolean
}

export interface MeterTenMinutePending {
  available: false
}

export type MeterTenMinute = MeterTenMinuteResult | MeterTenMinutePending

/** M14 uses the same public finalized-interval shape as the ten-minute tier. */
export type MeterTwoHourResult = MeterTenMinuteResult
export type MeterTwoHourPending = MeterTenMinutePending
export type MeterTwoHour = MeterTwoHourResult | MeterTwoHourPending

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
  /** Constant offset, engineering units (volts/amps). */
  dc: number
  /** RMS of the uniform white fluctuation the PL adds; 0 disables. */
  noise_rms: number
}

export interface AdcSimulatorHarmonic {
  /** Frequency ratio, >1 and <128; fractional values are interharmonics. */
  order: number
  /** Amplitude, percent of each receiving lane's fundamental (0..99.9). */
  percent: number
  /** Extra phase (degrees) on top of the physical order-scaled lane rule. */
  phase_degrees: number
  /** Which lanes receive it. */
  channels: 'voltage' | 'current' | 'all'
}

export interface AdcSimulatorConfiguration {
  frequency_hz: number
  /** Keep waveform phase/framing across the configuration commit. */
  preserve_phase: boolean
  channels: AdcSimulatorChannel[]
  /** Up to four global harmonic/interharmonic slots; empty keeps a pure tone. */
  harmonics: AdcSimulatorHarmonic[]
  active_source: 'physical' | 'simulator'
  configuration_generation: number
  active_generation: number
  generated_frames: number
  saturation_count: number
  missed_sample_count: number
  healthy: boolean
}

/** GET /api/v1/meter/single-cycle — SCYC diagnostic snapshot (metrology M3-M5). */
export interface SingleCycleStatus {
  running: boolean
  has_snapshot: boolean
  records: number
  sequence: number
  cycle_sequence: number
  sample_count: number
  first_sample: number
  last_sample: number
  processing_tick: number
  nominal_hz: number
  flags: number
  status: number
  frequency_millihz: number
  rms_micro_units: number[]
  vll_rms_micro_units: number[]
  active_power_picowatts: number[]
  /** Fundamental (phasor) RMS per lane; meaningful only when phasor_valid. */
  fundamental_rms_micro_units: number[]
  phasor_valid: boolean
}

/**
 * GET /api/v1/meter/power-quality — the Urms(1/2) sliding tier (metrology
 * M12). `latest` is the newest record of any kind (live half-cycle RMS);
 * `event` is the newest event EDGE, kept apart so the heartbeat stream
 * cannot erase a short sag before the page reads it.
 */
export interface PowerQualityPhase {
  phase: string
  /** Volts. */
  urms_half: number
  urms_half_minimum: number
  urms_half_maximum: number
  /** Amperes. */
  irms_half: number
  /** msap1::MeasurementQuality; 1 = a live measurement. */
  quality: number
}

export interface PowerQualityRecord {
  kind: 'periodic' | 'event_start' | 'event_end' | 'unknown'
  event_type: 'none' | 'sag' | 'swell' | 'interruption' | 'unknown'
  affected_phases: string[]
  sequence: number
  event_sequence: number
  first_sample: number
  last_sample: number
  sample_count: number
  half_cycle_updates: number
  /** Exact event length from the PL sample counter. */
  duration_samples: number
  duration_ms: number
  /** False when no reference voltage is configured: detection is off. */
  armed: boolean
  cycle_locked: boolean
  synthetic_half_cycle: boolean
  reference_volts: number
  sag_percent: number
  swell_percent: number
  interruption_percent: number
  hysteresis_percent: number
  phases: PowerQualityPhase[]
}

export interface PowerQualityStatus {
  running: boolean
  records: number
  events: number
  has_latest: boolean
  has_event: boolean
  latest: PowerQualityRecord
  event: PowerQualityRecord
}

/** One order in the M16 IEC-style subgroup spectrum. */
export interface HarmonicOrder {
  order: number
  magnitude_micro_units: number
  /** Engineering units: amperes for current channels, volts for voltage. */
  magnitude: number
  magnitude_valid: boolean
  angle_millidegrees: number
  /** Relative to order * Va fundamental angle, wrapped onto [0, 360). */
  angle_degrees: number
  angle_valid: boolean
}

export interface HarmonicChannel {
  channel: number
  name: string
  unit: 'A' | 'V'
  orders: HarmonicOrder[]
}

export type HarmonicPeriod =
  | 'cycles_150_180'
  | 'minutes_10'
  | 'hours_2'
  | 'basic'

/** GET /api/v1/meter/harmonics — latest complete 42-record M16 family. */
export interface HarmonicSpectrum {
  running: boolean
  available: boolean
  records: number
  families: number
  incomplete_families: number
  period: HarmonicPeriod
  sequence: number
  configuration_generation: number
  sample_rate_hz: number
  sample_count: number
  first_sample: number
  measured_frequency_millihz: number
  qualified_max_order: number
  nominal_frequency_hz: number
  cycle_count: number
  filter_profile_id: number
  valid_mask: number
  status: number
  emit_drops: number
  result_drops: number
  target_sample: number
  contributors: number
  overshoot_samples: number
  first_source_sequence: number
  last_source_sequence: number
  time_aligned: boolean
  contaminated: boolean
  interval_valid: boolean
  arithmetic_error: boolean
  grid_locked: boolean
  conditioner_valid: boolean
  fft_valid: boolean
  full_range: boolean
  first_after_discontinuity: boolean
  rate_limited: boolean
  channels: HarmonicChannel[]
}

/**
 * GET/POST /api/v1/adc/simulator/event — the simulator's amplitude
 * envelope. Arming is NOT a configuration change: the burst starts on the
 * generator's own half-cycle boundary, so the programmed amplitude step
 * is the only discontinuity the metrology engines see.
 */
export interface AdcSimulatorEvent {
  action: 'arm' | 'cancel' | 'clear' | 'query'
  /** 'voltage' | 'current' | 'all', or a comma-separated lane list. */
  channels: string
  /** 100 unity, 0 a full interruption, 110 a 10 % swell. */
  scale_percent: number
  /** Burst length in HALF cycles — Urms(1/2)'s own resolution. */
  duration_half_cycles: number
  period_half_cycles: number
  repeat: boolean
  armed: boolean
  running: boolean
  holding: boolean
  completed: number
  remaining_half_cycles: number
  until_repeat_half_cycles: number
  simulator_active: boolean
}

export interface AdcSimulatorEventCommand {
  action: AdcSimulatorEvent['action']
  channels?: string
  scale_percent?: number
  duration_half_cycles?: number
  period_half_cycles?: number
  repeat?: boolean
}

export interface PowerQualitySettings {
  /** Declared reference Udin, volts. 0 disables event detection. */
  reference_volts: number
  /** Thresholds as a percent of the reference; ordered
   *  interruption < sag < swell, with a hysteresis below the sag. */
  sag_percent: number
  swell_percent: number
  interruption_percent: number
  hysteresis_percent: number
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

export type MqttTransport = 'mqtt' | 'mqtts' | 'ws' | 'wss'

export interface MqttConnectionSettings {
  transport: MqttTransport
  broker_host: string
  broker_port: number
  websocket_path: string
  client_id: string
  username: string
  keep_alive_seconds: number
  connect_timeout_seconds: number
  reconnect_min_seconds: number
  reconnect_max_seconds: number
}

export interface MqttTlsSettings {
  use_system_ca: boolean
  verify_peer: boolean
  verify_hostname: boolean
  use_client_certificate: boolean
}

export interface MqttPublicationSettings {
  id: string
  enabled: boolean
  topic: string
  period: string
  interval_ms: number
  qos: 0 | 1 | 2
  retain: boolean
  attributes: string[]
}

/** Persistent MQTT policy. Passwords and TLS assets never appear here. */
export interface MqttSettings {
  enabled: boolean
  connection: MqttConnectionSettings
  tls: MqttTlsSettings
  publications: MqttPublicationSettings[]
}

export interface MqttCredentialStatus {
  password_configured: boolean
  private_key_passphrase_configured: boolean
  ca_configured: boolean
  client_certificate_configured: boolean
  client_key_configured: boolean
}

export interface MqttConfigurationDocument {
  settings: MqttSettings
  credentials: MqttCredentialStatus
}

export interface MqttPeriodCapability {
  id: string
  attributes: { id: string; unit: string }[]
}

export interface MqttPublicationStatus {
  attempts: number
  successes: number
  failures: number
  last_source_sequence: number
  last_successful_publish_unix_ms: number
  last_error: string
}

export interface MqttStatus {
  enabled: boolean
  state: string
  server_uri: string
  last_error: string
  successful_publishes: number
  last_successful_publish_unix_ms: number
  publications: Record<string, MqttPublicationStatus>
}

export interface ProductSettings {
  schema_version: number
  metering: {
    sample_rate_hz: number
    // Declared nominal grid frequency (50 or 60), selecting the
    // IEC 61000-4-30 basic block: 50 Hz -> 10 cycles, 60 Hz -> 12 cycles.
    nominal_frequency_hz: number
    // Declared line-to-neutral system voltage used as the voltage-phasor
    // radial reference. It does not rescale measured values.
    system_nominal_voltage_v: number
    rms: RmsSettings
    frequency: FrequencyConfiguration
    // IEC 61000-4-30 Urms(1/2) event detection. reference_volts = 0 is
    // the DISARMED state: the PL still measures half-cycle RMS but never
    // declares a sag, swell, or interruption.
    power_quality: PowerQualitySettings
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
      preserve_phase: boolean
      channels: AdcSimulatorChannel[]
      harmonics: AdcSimulatorHarmonic[]
    }
  }
  waveform: {
    default_pretrigger_ms: number
    default_posttrigger_ms: number
    // Capture-file decimation divisor (1, 2, 4, 8, 16, or 32).
    default_decimation: number
  }
  database: DatabaseSettings
  modbus: ModbusSettings
  mqtt: MqttSettings
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
  harmonic_cycles_150_180: DatasetStorageSettings
  harmonic_minutes_10: DatasetStorageSettings
  harmonic_hours_2: DatasetStorageSettings
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
  | 'basic' | 'cycles_150_180' | 'minutes_10' | 'hours_2'
  | 'harmonic_cycles_150_180' | 'harmonic_minutes_10'
  | 'harmonic_hours_2'

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
  decimation: number
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
  pl_dropped_frames: number
  max_capture_frames: number
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

async function uploadFile(path: string, file: File): Promise<MqttCredentialStatus> {
  const response = await fetch(path, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-File-Name': file.name,
    },
    body: file,
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok)
    throw new ApiError(response.status, payload.error ?? `Upload failed (${response.status})`)
  return payload as MqttCredentialStatus
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
  meterTenMinute: () => request<MeterTenMinute>('/api/v1/meter/minutes-10'),
  meterTwoHour: () => request<MeterTwoHour>('/api/v1/meter/hours-2'),
  meterTenMinuteLive: () => request<MeterTenMinute>('/api/v1/meter/minutes-10/live'),
  meterTwoHourLive: () => request<MeterTwoHour>('/api/v1/meter/hours-2/live'),
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
  meterSingleCycle: () =>
    request<SingleCycleStatus>('/api/v1/meter/single-cycle'),
  meterPowerQuality: () =>
    request<PowerQualityStatus>('/api/v1/meter/power-quality'),
  meterHarmonics: (period: HarmonicPeriod = 'cycles_150_180') =>
    request<HarmonicSpectrum>(`/api/v1/meter/harmonics?period=${encodeURIComponent(period)}`),
  adcSimulatorEvent: () =>
    request<AdcSimulatorEvent>('/api/v1/adc/simulator/event'),
  commandAdcSimulatorEvent: (command: AdcSimulatorEventCommand) =>
    request<AdcSimulatorEvent>('/api/v1/adc/simulator/event', {
      method: 'POST',
      body: JSON.stringify(command),
    }),
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
  triggerWaveform: (pretrigger_ms: number, posttrigger_ms: number,
    decimation: number) =>
    request<WaveformStatus>('/api/v1/waveforms/trigger', {
      method: 'POST',
      body: JSON.stringify({ pretrigger_ms, posttrigger_ms, decimation }),
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
  mqttCapabilities: () =>
    request<MqttPeriodCapability[]>('/api/v1/mqtt/capabilities'),
  mqttConfiguration: () =>
    request<MqttConfigurationDocument>('/api/v1/mqtt/configuration'),
  updateMqttConfiguration: (settings: MqttSettings) =>
    request<MqttConfigurationDocument>('/api/v1/mqtt/configuration', {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),
  mqttStatus: () => request<MqttStatus>('/api/v1/mqtt/status'),
  setMqttPassword: (password: string) =>
    request<MqttCredentialStatus>('/api/v1/mqtt/credentials/password', {
      method: 'PUT', body: JSON.stringify({ password }),
    }),
  clearMqttPassword: () =>
    request<MqttCredentialStatus>('/api/v1/mqtt/credentials/password', {
      method: 'DELETE',
    }),
  setMqttPrivateKeyPassphrase: (password: string) =>
    request<MqttCredentialStatus>('/api/v1/mqtt/credentials/private-key-passphrase', {
      method: 'PUT', body: JSON.stringify({ password }),
    }),
  clearMqttPrivateKeyPassphrase: () =>
    request<MqttCredentialStatus>('/api/v1/mqtt/credentials/private-key-passphrase', {
      method: 'DELETE',
    }),
  uploadMqttCa: (file: File) => uploadFile('/api/v1/mqtt/tls/ca', file),
  deleteMqttCa: () =>
    request<MqttCredentialStatus>('/api/v1/mqtt/tls/ca', { method: 'DELETE' }),
  uploadMqttClientCertificate: (file: File) =>
    uploadFile('/api/v1/mqtt/tls/client-certificate', file),
  deleteMqttClientCertificate: () =>
    request<MqttCredentialStatus>('/api/v1/mqtt/tls/client-certificate', { method: 'DELETE' }),
  uploadMqttClientKey: (file: File) =>
    uploadFile('/api/v1/mqtt/tls/client-key', file),
  deleteMqttClientKey: () =>
    request<MqttCredentialStatus>('/api/v1/mqtt/tls/client-key', { method: 'DELETE' }),
}

export const mqttCaDownloadPath = '/api/v1/mqtt/tls/ca'
export const mqttClientCertificateDownloadPath =
  '/api/v1/mqtt/tls/client-certificate'
