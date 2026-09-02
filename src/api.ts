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

export type CurrentPhase = 'A' | 'B' | 'C' | 'N'
export type CurrentDirection = 'normal' | 'reversed'
export type CurrentInputOrder = 'ABC' | 'ACB' | 'CUSTOM'

export interface CurrentWiringChannel {
  phase: CurrentPhase
  direction: CurrentDirection
}

export interface CurrentWiringChannels {
  ch0: CurrentWiringChannel
  ch1: CurrentWiringChannel
  ch2: CurrentWiringChannel
  ch3: CurrentWiringChannel
}

export interface CurrentWiringConfiguration {
  input_order: CurrentInputOrder
  channels: CurrentWiringChannels
}

export interface CurrentWiringReadback extends CurrentWiringConfiguration {
  phase_map: number
  invert_mask: number
}

export interface CurrentWiringHealth {
  requested: CurrentWiringReadback
  active: CurrentWiringReadback
  generation: number
  match: boolean
  last_apply_result: 'none' | 'success' | 'failed' | 'rolled_back' | 'rollback_failed' | 'unknown'
  readback_mismatch_count: number
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
  current_wiring: CurrentWiringHealth
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
  utc_start_nanoseconds?: number
  utc_uncertainty_nanoseconds?: number
}

export type MeterReadingQuality =
  | 'valid'
  | 'unavailable'
  | 'invalid'
  | 'out_of_range'
  | 'timed_out'
  | 'arithmetic_error'

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
  /** True only after all derived siblings belong to `sequence`. */
  record_complete: boolean
  // Present on every basic record since BASIC-v3; kept
  // optional so a stale document renders gracefully.
  timing?: MeterBlockTiming
}

export interface MeterReadingAttribute {
  key: string
  unit: string
  valid: boolean
  value: number
  quality: MeterReadingQuality
  source_sequence: number
}

/**
 * One RMS channel of a finalized aggregate. Derived catalog quantities travel
 * separately in the response's `attributes` array; there is no mean correction
 * term or per-channel RMS accumulator count, so those fields are absent rather
 * than zero.
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
  /** Catalog attributes from the aggregate POWER/PHASOR/UNBAL record family. */
  attributes: MeterReadingAttribute[]
  frequency: MeterAggregateFrequency
  record_complete: boolean
  utc_start_nanoseconds?: number
  utc_uncertainty_nanoseconds?: number
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
 * One completed UTC-aligned IEC 61000-4-30 ten-second frequency result.
 * Exact sample, UTC, and Q16 audit integers remain decimal strings so the
 * browser never rounds them through JavaScript Number.
 */
export interface MeterFrequency10sResult {
  available: true
  sequence: number
  configuration_generation: number
  valid: boolean
  quality: MeterReadingQuality
  /** Omitted for every invalid completed interval; zero is never substituted. */
  frequency_hz?: number
  frequency_millihz?: number
  time_quality: 'unsynchronized' | 'synchronized' | 'holdover'
  /** Kernel clock discipline state, independent of the Class A error bound. */
  clock_synchronized: boolean
  /** True only when the synchronized UTC uncertainty is at most 1 ms. */
  class_a_time_qualified: boolean
  age_ms: number
  first_sample_index: string
  interval_end_sample_index: string
  sample_count: number
  sample_rate_hz: number
  measured_sample_rate_millihz: number
  cycle_count: number
  utc_start_nanoseconds: string
  utc_end_nanoseconds: string
  utc_uncertainty_nanoseconds: string
  source_sequence: number
  boundary_generation: number
  source_status: number
  source_status_flags: string[]
  status: number
  status_flags: string[]
  reasons: number
  rejection_reasons: string[]
  observer_drop_count: number
  guard_flags: number
  guard_flag_names: string[]
  observed_crossings: number
  included_crossings: number
  rejected_cycles: number
  duration_q16_samples: string
  first_crossing_q16_samples: string
  last_crossing_q16_samples: string
  nominal_frequency_hz: number
  reference_channel: number
  filter_profile: number
  calibration_profile: number
}

export interface MeterFrequency10sPending {
  available: false
}

export type MeterFrequency10s = MeterFrequency10sResult | MeterFrequency10sPending

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
  record_complete: boolean
  utc_start_nanoseconds?: number
  utc_uncertainty_nanoseconds?: number
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
  thd: HarmonicDistortion
  orders: HarmonicOrder[]
}

export type HarmonicDistortionStatus =
  | 'valid'
  | 'interval_invalid'
  | 'channel_unavailable'
  | 'fundamental_unavailable'
  | 'insufficient_order_range'
  | 'harmonic_unavailable'

/** APU-calculated product THD. Null is unavailable and is never numeric zero. */
export interface HarmonicDistortion {
  percent: number | null
  first_order: 2
  last_order: 50
  status: HarmonicDistortionStatus
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

export type MeterAttributeUsage = 'snapshot' | 'historian'
export type MeterAttributeCalculation =
  | 'minimum' | 'maximum' | 'average' | 'last'
  | 'circular_average' | 'first' | 'delta'

export interface MeterAttributeDescriptor {
  id: string
  label: string
  group: string
  unit: string
  value_kind: 'linear' | 'circular_angle' | 'cumulative_counter' | 'peak' | 'categorical'
  search_aliases: string[]
  calculations: MeterAttributeCalculation[]
  periods: string[]
}

export interface MeterAttributePeriod {
  id: string
  label: string
  attributes: string[]
}

export interface MeterAttributeCatalog {
  usage: MeterAttributeUsage
  periods: MeterAttributePeriod[]
  attributes: MeterAttributeDescriptor[]
}

export type DataChannelProtocol = 'http' | 'https' | 'ftp' | 'sftp'
export type DataChannelAuthentication =
  | 'none' | 'basic' | 'bearer' | 'mtls' | 'password' | 'private_key'

export interface DataChannelSettings {
  id: string
  name: string
  enabled: boolean
  protocol: DataChannelProtocol
  host: string
  port: number
  http_path: string
  remote_directory: string
  authentication: DataChannelAuthentication
  username: string
  connect_timeout_seconds: number
  transfer_timeout_seconds: number
  use_system_ca: boolean
  use_uploaded_ca: boolean
  use_client_certificate: boolean
  insecure_transport_acknowledged: boolean
}

export interface DataLoggingSelectionSettings {
  attribute: string
  calculation: MeterAttributeCalculation
}

export interface DataLoggingJobSettings {
  id: string
  name: string
  enabled: boolean
  revision: number
  source_period: string
  generation_interval_seconds: number
  row_interval_seconds: number
  selections: DataLoggingSelectionSettings[]
  format: 'json' | 'csv'
  destination: 'remote' | 'local_only'
  channel_ids: string[]
}

export interface DataLoggingStorageSettings {
  maximum_bytes: number
  minimum_free_bytes: number
  completed_metadata_retention_days: number
}

export interface DataLoggingSettings {
  channels: DataChannelSettings[]
  jobs: DataLoggingJobSettings[]
  storage: DataLoggingStorageSettings
}

export interface DataChannelMaterialStatus {
  channel_id: string
  password_configured: boolean
  bearer_token_configured: boolean
  private_key_passphrase_configured: boolean
  ca_configured: boolean
  client_certificate_configured: boolean
  client_key_configured: boolean
  sftp_private_key_configured: boolean
  known_hosts_configured: boolean
}

export interface DataLoggingConfigurationDocument {
  settings: DataLoggingSettings
  materials: DataChannelMaterialStatus[]
  demand_window_seconds: number
}

export interface DataLoggingJobStatus {
  id: string
  revision: number
  enabled: boolean
  next_start_nanoseconds?: number
  next_end_nanoseconds?: number
  last_start_nanoseconds?: number
  last_end_nanoseconds?: number
  last_generated_at_nanoseconds: number
  last_error: string
}

export interface DataChannelStatus {
  id: string
  name: string
  protocol: DataChannelProtocol
  enabled: boolean
  ready: boolean
  readiness_error: string
  last_test_state: string
  last_test_message: string
  last_test_at_nanoseconds: number
}

export interface DataLoggingStatus {
  health: string
  message: string
  artifact_count: number
  outbox_count: number
  outbox_bytes: number
  archive_count: number
  archive_bytes: number
  completed_metadata_count: number
  missing_payload_count: number
  pending_delivery_count: number
  blocked_delivery_count: number
  oldest_pending_created_at_nanoseconds?: number
  maximum_bytes: number
  available_bytes: number
  minimum_free_bytes: number
  generation_allowed: boolean
  storage_blocking_reason: string
  jobs: DataLoggingJobStatus[]
  channels: DataChannelStatus[]
}

export interface GeneratedArtifactSummary {
  id: string
  job_id: string
  job_revision: number
  filename: string
  mime_type: string
  sha256: string
  size_bytes: number
  source_start_nanoseconds: number
  source_end_nanoseconds: number
  generated_at_nanoseconds: number
  created_at_nanoseconds: number
  state: string
  local_only: boolean
  payload_present: boolean
  delivery_count: number
  succeeded_count: number
  blocked_count: number
  recovery_error: string
}

export interface GeneratedArtifactList {
  artifacts: GeneratedArtifactSummary[]
  offset: number
  returned: number
}

export interface GeneratedDeliveryDetail {
  channel_id: string
  state: string
  attempt_count: number
  next_attempt_nanoseconds: number
  last_attempt_nanoseconds: number
  remote_result: string
  last_error: string
}

export interface GeneratedArtifactDetail {
  artifact: GeneratedArtifactSummary
  deliveries: GeneratedDeliveryDetail[]
}

export interface GeneratedFileDeletionResult {
  deleted: number
  discarded_deliveries: number
}

export interface DataChannelTestResult {
  channel_id: string
  state: string
  message: string
  tested_at_nanoseconds: number
}

/** Presentation topology for the three voltage measurement inputs. */
export type MeasurementTopology = 'wye' | 'delta'
export type DemandMethod = 'fixed_block' | 'sliding'
export type TimeSynchronization = 'ntp' | 'ptp'

export interface TimeSynchronizationSettings {
  synchronization: TimeSynchronization
}

export interface DemandConfiguration {
  method: DemandMethod
  window_seconds: 60 | 300 | 600 | 900 | 1800
}

export interface EventWaveformPolicy {
  enabled: boolean
  pretrigger_ms: number
  posttrigger_ms: number
  decimation: 1 | 2 | 4 | 8 | 16 | 32
}

export type EventPhasePolicy = 'per_phase' | 'polyphase'

export interface EventProfileSettings {
  enabled: boolean
  threshold_percent: number
  hysteresis_percent: number
  phase_mask: number
  phase_policy: EventPhasePolicy
  waveform: EventWaveformPolicy
}

export interface PowerQualityEventSettings {
  reference_current_amperes: number
  voltage_sag: EventProfileSettings
  voltage_swell: EventProfileSettings
  voltage_interruption: EventProfileSettings
  rapid_voltage_change: EventProfileSettings
  voltage_unbalance: EventProfileSettings
  current_sag: EventProfileSettings
  current_swell: EventProfileSettings
  current_unbalance: EventProfileSettings
  transient_voltage: EventProfileSettings
}

export interface FlickerSettings {
  enabled: boolean
  phase_mask: number
  lamp_voltage: 120 | 230
  live_cadence_ms: 1000
  pst_interval_seconds: 600
  plt_pst_count: 12
}

export interface MainsSignallingSettings {
  enabled: boolean
  carrier_frequency_hz: number
  bandwidth_hz: number
  observation_ms: 200
  phase_mask: number
  threshold_percent: number
}

export interface ProductSettings {
  schema_version: number
  metering: {
    sample_rate_hz: number
    // Declared nominal grid frequency (50 or 60), selecting the
    // IEC 61000-4-30 basic block: 50 Hz -> 10 cycles, 60 Hz -> 12 cycles.
    nominal_frequency_hz: number
    // Presentation-only input topology. It does not alter PL/RPU algorithms.
    measurement_topology: MeasurementTopology
    // Voltage-phasor radial reference: L-N for wye and L-L for delta.
    // It does not rescale measured values.
    system_nominal_voltage_v: number
    rms: RmsSettings
    frequency: FrequencyConfiguration
    // IEC 61000-4-30 Urms(1/2) event detection. reference_volts = 0 is
    // the DISARMED state: the PL still measures half-cycle RMS but never
    // declares a sag, swell, or interruption.
    power_quality: PowerQualitySettings
    events: PowerQualityEventSettings
    flicker: FlickerSettings
    mains_signalling: MainsSignallingSettings
    demand: DemandConfiguration
    current_wiring: CurrentWiringConfiguration
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
  time: TimeSynchronizationSettings
  waveform: {
    default_pretrigger_ms: number
    default_posttrigger_ms: number
    // Capture-file decimation divisor (1, 2, 4, 8, 16, or 32).
    default_decimation: number
    station_id: string
    station_name: string
    site_id: string
    site_name: string
    circuit_id: string
    circuit_name: string
    device_serial: string
    calibration_id: string
    calibration_status: 'unknown' | 'valid' | 'expired' | 'invalid'
  }
  database: DatabaseSettings
  modbus: ModbusSettings
  mqtt: MqttSettings
  data_logging: DataLoggingSettings
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
  demand: DatasetStorageSettings
  seconds_10: DatasetStorageSettings
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
    power_quality_event_count: number
    datasets: DatabaseDatasetStatus[]
  }
}

export type HistorianDataset =
  | 'basic' | 'cycles_150_180' | 'minutes_10' | 'hours_2' | 'demand' | 'seconds_10'
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
  after?: string
}

export interface HistoryPoint {
  measured_at_nanoseconds: number
  source_sequence: number
  attribute: string
  /** Exact signed int64 decimal; charts convert only their display copy. */
  value: string
  quality: string
  /** Present for energy/demand so plots can break administrative reset epochs. */
  reset_epoch?: string
}

export interface HistoryResponse {
  period: string
  points: HistoryPoint[]
  truncated: boolean
  next_cursor?: string
}

/** Decimal strings are deliberate: these values may exceed JavaScript's safe
 * integer range and must never pass through Number. */
export interface PhaseTotalDecimalStrings {
  phase_a: string
  phase_b: string
  phase_c: string
  total: string
}

export interface MeterEnergy {
  active_import_uwh: PhaseTotalDecimalStrings
  active_export_uwh: PhaseTotalDecimalStrings
  apparent_uvah: PhaseTotalDecimalStrings
  reactive_quadrant_i_uvarh: PhaseTotalDecimalStrings
  reactive_quadrant_ii_uvarh: PhaseTotalDecimalStrings
  reactive_quadrant_iii_uvarh: PhaseTotalDecimalStrings
  reactive_quadrant_iv_uvarh: PhaseTotalDecimalStrings
  session_id: string
  last_sample_index: string
  accepted_samples: string
  skipped_samples: string
  accepted_blocks: number
  skipped_blocks: number
  reset_epoch: string
  last_durable_update_nanoseconds: string
  quality: MeterReadingQuality
  incomplete_accumulation: boolean
  saturated: boolean
  discontinuity: boolean
}

export interface MeterDemand {
  current_active_uw: PhaseTotalDecimalStrings
  import_peak_uw: PhaseTotalDecimalStrings
  export_peak_uw: PhaseTotalDecimalStrings
  import_peak_sample: PhaseTotalDecimalStrings
  export_peak_sample: PhaseTotalDecimalStrings
  session_id: string
  last_sample_index: string
  interval_anchor_sample: string
  source_interval_count: number
  source_status: number
  method: DemandMethod
  window_seconds: number
  update_seconds: number
  profile_generation: number
  peak_reset_epoch: string
  last_durable_update_nanoseconds: string
  quality: MeterReadingQuality
  time_aligned: boolean
  contaminated: boolean
  boundary_valid: boolean
  incomplete_accumulation: boolean
  saturated: boolean
}

export interface MeterResetResult {
  reset_epoch: string
  replayed: boolean
  request_id: string
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

export type WaveformOrigin = 'manual' | 'power_quality' | 'mixed' | 'legacy'
export type WaveformOriginFilter = 'all' | 'manual' | 'power_quality'

export interface WaveformArchiveDiscovery {
  state: 'not_started' | 'scanning' | 'complete' | 'cancelled' | 'failed'
  scanned_files: number
  total_files: number
  rejected_files: number
}

export interface WaveformPage {
  origin: WaveformOriginFilter
  limit: number
  total_sessions: number
  completed_sessions: number
  incomplete_sessions: number
  active_sessions: number
  returned_sessions: number
  next_before_session_id: number | null
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
  origin: WaveformOrigin
  decimation: number
  filename: string
  continuation_of_session_id: number
  master_session_id: number
  capture_uuid: string
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
  archive_discovery?: WaveformArchiveDiscovery
  page?: WaveformPage
  export_formats: string[]
  sessions: WaveformSession[]
}

export interface WaveformSessionLookup {
  capture_uuid: string
  archive_discovery: WaveformArchiveDiscovery
  session: WaveformSession | null
}

export interface WaveformQuery {
  origin?: WaveformOriginFilter
  before_session_id?: number
  limit?: number
}

export type PowerQualityEventLifecycle = 'start' | 'update' | 'end' | 'abort' | 'unknown'
export type PowerQualityEventType =
  | 'voltage_sag'
  | 'voltage_swell'
  | 'voltage_interruption'
  | 'rapid_voltage_change'
  | 'voltage_unbalance'
  | 'current_sag'
  | 'current_swell'
  | 'current_unbalance'
  | 'transient_voltage'
  | 'unknown'

export interface PowerQualityEvent {
  event_id: string
  source_session: number
  source_counter: number
  lifecycle: PowerQualityEventLifecycle
  type: PowerQualityEventType
  taxonomy: 'iec_61000_4_30' | 'msap1_product_alarm'
  affected_phases: string[]
  trigger_source: number
  sequence: number
  configuration_generation: number
  profile_generation: number
  sample_rate_hz: number
  first_sample: number
  last_sample: number
  trigger_sample: number
  duration_samples: number
  duration_ms: number
  threshold_e4: number
  hysteresis_e4: number
  reference_micro_units: number
  minimum_micro_units: [number, number, number]
  maximum_micro_units: [number, number, number]
  current_micro_units: [number, number, number]
  per_phase: boolean
  status: number
  valid_mask: number
  discontinuities: number
  update_count: number
  time_quality: 'unsynchronized' | 'synchronized' | 'holdover' | string
  start_utc_nanoseconds?: number
  last_utc_nanoseconds?: number
  utc_uncertainty_nanoseconds?: number
  settings_digest: string
  waveform: EventWaveformPolicy
  waveform_capture_uuids: string[]
}

export interface PowerQualityEvents {
  limit: number
  count: number
  export_formats: string[]
  events: PowerQualityEvent[]
}

export interface PowerQualityEventDeleteResult {
  deleted: number
}

export interface PowerQualityEventQuery {
  event_id?: string
  start_utc_ns?: number
  end_utc_ns?: number
  limit?: number
}

export interface FlickerPhase {
  phase: string
  valid: boolean
  pinst: number
  pst: number
  plt: number
  valid_internal_samples: number
}

export interface FlickerRecord {
  kind: 'live' | 'pst' | 'plt'
  sequence: number
  configuration_generation: number
  profile_generation: number
  sample_rate_hz: number
  first_sample: number
  last_sample: number
  sample_count: number
  interval_seconds: number
  lamp_voltage: number
  nominal_frequency_hz: number
  status: number
  source_status: number
  phases: FlickerPhase[]
}

export interface FlickerStatus {
  running: boolean
  records: number
  sequence_gaps: number
  live?: FlickerRecord
  pst?: FlickerRecord
  plt?: FlickerRecord
}

export interface MainsSignalPhase {
  phase: string
  valid: boolean
  detected: boolean
  magnitude_volts: number
  background_volts: number
}

export interface MainsSignalStatus {
  running: boolean
  records: number
  sequence_gaps: number
  available: boolean
  sequence: number
  configuration_generation: number
  profile_generation: number
  sample_rate_hz: number
  first_sample: number
  last_sample: number
  sample_count: number
  configured_hz: number
  measured_hz: number
  bandwidth_hz: number
  observation_ms: number
  threshold_percent: number
  reference_volts: number
  status: number
  source_status: number
  phases: MainsSignalPhase[]
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
    public readonly retryable?: boolean,
  ) {
    super(message)
  }
}

interface ApiErrorPayload {
  error?: string
  code?: string
  retryable?: boolean
}

function apiError(status: number, payload: ApiErrorPayload, fallback: string) {
  return new ApiError(status, payload.error ?? fallback,
    payload.code, payload.retryable)
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
  const payload: ApiErrorPayload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw apiError(response.status, payload, `Request failed (${response.status})`)
  }
  return payload as T
}

async function requestBinary(path: string): Promise<ArrayBuffer> {
  const response = await fetch(path, { credentials: 'same-origin' })
  if (!response.ok) {
    const payload: ApiErrorPayload = await response.json().catch(() => ({}))
    throw apiError(response.status, payload, `Request failed (${response.status})`)
  }
  return response.arrayBuffer()
}

async function uploadFile<T = MqttCredentialStatus>(path: string, file: File): Promise<T> {
  const response = await fetch(path, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-File-Name': file.name,
    },
    body: file,
  })
  const payload: ApiErrorPayload = await response.json().catch(() => ({}))
  if (!response.ok)
    throw apiError(response.status, payload, `Upload failed (${response.status})`)
  return payload as T
}

export function waveformViewPath(filename: string) {
  return `/protected/waveforms/view/${encodeURIComponent(filename)}`
}

export function waveformDownloadPath(filename: string) {
  return `/protected/waveforms/download/${encodeURIComponent(filename)}`
}

export function waveformEventExportPath(sessionId: number, eventId: string) {
  const parameters = new URLSearchParams({
    session_id: String(sessionId),
    event_id: eventId,
    format: 'mncwf',
  })
  return `/api/v1/waveforms/export?${parameters.toString()}`
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
  meterAttributes: (usage: MeterAttributeUsage) =>
    request<MeterAttributeCatalog>(`/api/v1/meter/attributes?usage=${usage}`),
  meterAggregate: () => request<MeterAggregate>('/api/v1/meter/aggregate'),
  meterFrequency10s: () =>
    request<MeterFrequency10s>('/api/v1/meter/frequency-10s'),
  meterTenMinute: () => request<MeterTenMinute>('/api/v1/meter/minutes-10'),
  meterTwoHour: () => request<MeterTwoHour>('/api/v1/meter/hours-2'),
  meterTenMinuteLive: () => request<MeterTenMinute>('/api/v1/meter/minutes-10/live'),
  meterTwoHourLive: () => request<MeterTwoHour>('/api/v1/meter/hours-2/live'),
  meterEnergy: () => request<MeterEnergy>('/api/v1/meter/energy'),
  meterDemand: () => request<MeterDemand>('/api/v1/meter/demand'),
  resetMeterEnergy: (expected_epoch: string, idempotency_key: string) =>
    request<MeterResetResult>('/api/v1/meter/energy/reset', {
      method: 'POST',
      body: JSON.stringify({ expected_epoch, idempotency_key }),
    }),
  resetMeterDemandPeaks: (expected_epoch: string, idempotency_key: string) =>
    request<MeterResetResult>('/api/v1/meter/demand/peaks/reset', {
      method: 'POST',
      body: JSON.stringify({ expected_epoch, idempotency_key }),
    }),
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
  powerQualityEvents: (query: PowerQualityEventQuery = {}) => {
    const parameters = new URLSearchParams()
    if (query.event_id) parameters.set('event_id', query.event_id)
    if (query.start_utc_ns !== undefined)
      parameters.set('start_utc_ns', String(query.start_utc_ns))
    if (query.end_utc_ns !== undefined)
      parameters.set('end_utc_ns', String(query.end_utc_ns))
    if (query.limit !== undefined) parameters.set('limit', String(query.limit))
    const suffix = parameters.size === 0 ? '' : `?${parameters.toString()}`
    return request<PowerQualityEvents>(`/api/v1/meter/power-quality/events${suffix}`)
  },
  deletePowerQualityEvents: (event_ids: string[]) =>
    request<PowerQualityEventDeleteResult>('/api/v1/meter/power-quality/events', {
      method: 'DELETE',
      body: JSON.stringify({ event_ids, all: false, confirmed: true }),
    }),
  clearPowerQualityEvents: () =>
    request<PowerQualityEventDeleteResult>('/api/v1/meter/power-quality/events', {
      method: 'DELETE',
      body: JSON.stringify({ event_ids: [], all: true, confirmed: true }),
    }),
  meterFlicker: () => request<FlickerStatus>('/api/v1/meter/flicker'),
  meterMainsSignalling: () =>
    request<MainsSignalStatus>('/api/v1/meter/mains-signalling'),
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
  waveforms: (query: WaveformQuery = {}) => {
    const parameters = new URLSearchParams()
    if (query.origin) parameters.set('origin', query.origin)
    if (query.before_session_id !== undefined)
      parameters.set('before_session_id', String(query.before_session_id))
    if (query.limit !== undefined) parameters.set('limit', String(query.limit))
    const suffix = parameters.size === 0 ? '' : `?${parameters.toString()}`
    return request<WaveformStatus>(`/api/v1/waveforms${suffix}`)
  },
  waveformSession: (captureUuid: string) =>
    request<WaveformSessionLookup>(`/api/v1/waveforms/session?capture_uuid=${
      encodeURIComponent(captureUuid)}`),
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
  clearWaveforms: () =>
    request<WaveformStatus>('/api/v1/waveforms', {
      method: 'DELETE',
      body: JSON.stringify({ session_id: 0, all: true, confirmed: true }),
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
  dataLoggingConfiguration: () =>
    request<DataLoggingConfigurationDocument>('/api/v1/data-logging/configuration'),
  updateDataLoggingConfiguration: (settings: DataLoggingSettings) =>
    request<DataLoggingConfigurationDocument>('/api/v1/data-logging/configuration', {
      method: 'PUT', body: JSON.stringify(settings),
    }),
  dataLoggingStatus: () =>
    request<DataLoggingStatus>('/api/v1/data-logging/status'),
  dataLoggingArtifacts: (query: {
    offset?: number; limit?: number; job_id?: string; state?: string
    start_nanoseconds?: number; end_nanoseconds?: number
  } = {}) => {
    const parameters = new URLSearchParams()
    for (const [key, value] of Object.entries(query))
      if (value !== undefined && value !== '') parameters.set(key, String(value))
    const suffix = parameters.size > 0 ? `?${parameters.toString()}` : ''
    return request<GeneratedArtifactList>(`/api/v1/data-logging/artifacts${suffix}`)
  },
  dataLoggingArtifact: (id: string) =>
    request<GeneratedArtifactDetail>(`/api/v1/data-logging/artifact?id=${encodeURIComponent(id)}`),
  dataLoggingPreview: async (id: string, limit = 16384) => {
    const response = await fetch(`/api/v1/data-logging/artifacts/preview?id=${encodeURIComponent(id)}&limit=${limit}`, {
      credentials: 'same-origin',
    })
    if (!response.ok) {
      const payload: ApiErrorPayload = await response.json().catch(() => ({}))
      throw apiError(response.status, payload, `Preview failed (${response.status})`)
    }
    return response.text()
  },
  retryDataLoggingArtifacts: (ids: string[]) =>
    request<DataLoggingStatus>('/api/v1/data-logging/artifacts/retry', {
      method: 'POST', body: JSON.stringify({ ids }),
    }),
  deleteDataLoggingArtifacts: (requestBody: {
    ids?: string[]; all?: boolean; confirmed: true; discard_unsent: boolean
  }) => request<GeneratedFileDeletionResult>('/api/v1/data-logging/artifacts', {
    method: 'DELETE', body: JSON.stringify({ ids: [], all: false, ...requestBody }),
  }),
  testDataChannel: (channel_id: string) =>
    request<DataChannelTestResult>('/api/v1/data-logging/channels/test', {
      method: 'POST', body: JSON.stringify({ channel_id }),
    }),
  setDataChannelCredential: (channel_id: string, kind: string, value: string) =>
    request<DataChannelMaterialStatus>('/api/v1/data-logging/channel-credential', {
      method: 'PUT', body: JSON.stringify({ channel_id, kind, value }),
    }),
  deleteDataChannelCredential: (channel_id: string, kind: string) =>
    request<DataChannelMaterialStatus>('/api/v1/data-logging/channel-credential', {
      method: 'DELETE', body: JSON.stringify({ channel_id, kind }),
    }),
  uploadDataChannelAsset: (channel_id: string, kind: string, file: File) => {
    const parameters = new URLSearchParams({ channel_id, kind })
    return uploadFile<DataChannelMaterialStatus>(
      `/api/v1/data-logging/channel-asset?${parameters.toString()}`, file)
  },
  deleteDataChannelAsset: (channel_id: string, kind: string) =>
    request<DataChannelMaterialStatus>('/api/v1/data-logging/channel-asset', {
      method: 'DELETE', body: JSON.stringify({ channel_id, kind }),
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

export const openApiDocumentDownloadPath =
  '/api/v1/documentation/msap1_api.yaml'
export const modbusRegisterDocumentDownloadPath =
  '/api/v1/documentation/msap1_modbus_registers.xlsx'

export function dataLoggingArtifactDownloadPath(id: string) {
  return `/api/v1/data-logging/artifacts/download?id=${encodeURIComponent(id)}`
}
