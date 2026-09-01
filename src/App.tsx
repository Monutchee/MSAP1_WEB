import {
  FormEvent, type KeyboardEvent as ReactKeyboardEvent, ReactNode,
  useCallback, useEffect, useRef, useState,
} from 'react'
import {
  api, AdcSimulatorConfiguration, AdcSimulatorEvent, AdcSimulatorEventCommand,
  AdcSimulatorHarmonic,
  AdcSource, ApiError, DeveloperAbout, SingleCycleStatus, PowerQualityStatus,
  DeveloperLogEntry, FrequencyConfiguration, LogPriority,
  MeterAggregate, MeterAggregateResult,
  MeterTenMinute, MeterTenMinuteResult,
  MeterTwoHour, MeterTwoHourResult,
  MeasurementTopology, DemandConfiguration, CurrentWiringConfiguration,
  CurrentPhase,
  MeterChannel, MeterReadings, Session, SocTemperature, SocTemperatures,
  SystemAbout, SystemHealth, WaveformStatus, ProductSettings, SettingsDocument,
  PowerQualityEvents, openApiDocumentDownloadPath,
  modbusRegisterDocumentDownloadPath,
} from './api'
import { WaveformExplorer } from './waveform/WaveformExplorer'
import { DeveloperDatabasePage } from './developer/DeveloperDatabasePage'
import { DeveloperDataRecorderPage } from './developer/DeveloperDataRecorderPage'
import { HistoryPage } from './history/HistoryPage'
import { ReadingPage } from './reading/ReadingPage'
import { ModbusConfiguration } from './configuration/ModbusConfiguration'
import { MqttConfiguration } from './configuration/MqttConfiguration'
import { PowerQualityConfiguration } from './configuration/PowerQualityConfiguration'
import { DataLoggingPage } from './configuration/dataLogging/DataLoggingPage'
import { ManagementPage } from './management/ManagementPage'
import {
  classifySystemReadiness,
  type SystemReadiness,
  type SystemReadinessState,
} from './systemReadiness'

const HISTORY = 80
const VISIBLE_CHANNELS = new Set([0, 1, 2, 3, 4, 5, 6])
const CURRENT_CHANNEL_KEYS = ['ch0', 'ch1', 'ch2', 'ch3'] as const
const DEFAULT_CURRENT_WIRING: CurrentWiringConfiguration = {
  input_order: 'ABC',
  channels: {
    ch0: { phase: 'A', direction: 'normal' },
    ch1: { phase: 'B', direction: 'normal' },
    ch2: { phase: 'C', direction: 'normal' },
    ch3: { phase: 'N', direction: 'normal' },
  },
}

/**
 * Which measurement tier the dashboard renders. The first two tiers are
 * cycle-defined; the longer tiers are finalized cascaded PL results:
 * the basic measurement block is 10 cycles at 50 Hz nominal and 12 at 60 Hz,
 * the aggregate is exactly 15 consecutive basic blocks, each ten-minute block
 * folds complete basic blocks, and each two-hour block folds 12 complete
 * ten-minute accumulator images.
 */
type MeterTier = 'basic' | 'aggregate' | 'min10Live' | 'min10' | 'hour2Live' | 'hour2'

type SimulatorApplyDialogState = {
  phase: 'hidden' | 'applying' | 'success' | 'error'
  activate: boolean
  message?: string
  httpStatus?: number
}

const TIER_LABELS: Record<MeterTier, string> = {
  basic: 'Basic block (10/12 cycles)',
  aggregate: 'Aggregate (150/180 cycles)',
  min10Live: '10-minute live partial',
  min10: '10-minute aggregate',
  hour2Live: '2-hour live partial',
  hour2: '2-hour aggregate',
}

function formatCount(value: number | undefined) {
  return value === undefined ? '—' : new Intl.NumberFormat('en-US').format(value)
}

function formatBytes(bytes: number | undefined) {
  if (bytes === undefined) return '—'
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

/**
 * Applies one typed form edit and atomically persists it to active.json.
 */
async function saveSettings(
  edit: (settings: ProductSettings) => void,
): Promise<SettingsDocument> {
  const active = await api.activeSettings()
  const settings = structuredClone(active.settings)
  edit(settings)
  return api.saveSettings(settings)
}

function Sparkline({ values, healthy }: { values: number[]; healthy: boolean }) {
  if (values.length < 2) return <div className="sparkline empty" />
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = Math.max(0.001, max - min)
  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * 100
    const y = 30 - ((value - min) / span) * 26
    return `${x.toFixed(2)},${y.toFixed(2)}`
  }).join(' ')
  return <svg className="sparkline" viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true">
    <polyline className={healthy ? 'line good' : 'line warning'} points={points} />
  </svg>
}

function StatusPill({ ok, neutral = false, children }: {
  ok: boolean
  neutral?: boolean
  children: string
}) {
  const state = neutral ? 'neutral' : ok ? 'ok' : 'bad'
  return <span className={`status-pill ${state}`}><i />{children}</span>
}

function SystemReadinessBanner({ readiness, failure }: {
  readiness: SystemReadiness
  failure: Error | undefined
}) {
  if (readiness.state === 'healthy') return null
  const copy: Record<Exclude<SystemReadinessState, 'healthy'>, {
    title: string; detail: string
  }> = {
    initializing: {
      title: 'System initializing or recovering',
      detail: 'Metering is not ready yet. This page remains available and will retry automatically.',
    },
    degraded: {
      title: 'System needs attention',
      detail: 'The metering service is reachable, but one or more health checks report a fault.',
    },
    unavailable: {
      title: 'System unavailable',
      detail: failure?.message ?? 'The health service could not be reached. Retrying automatically.',
    },
  }
  const message = copy[readiness.state]
  return <div className={`system-readiness-banner ${readiness.state}`}
    role={readiness.state === 'initializing' ? 'status' : 'alert'}
    aria-live={readiness.state === 'initializing' ? 'polite' : 'assertive'}>
    <i aria-hidden="true" />
    <div><strong>{message.title}</strong><span>{message.detail}</span></div>
  </div>
}

function SimulatorApplyDialog({ state, onClose, onRetry }: {
  state: SimulatorApplyDialogState
  onClose: () => void
  onRetry: () => void
}) {
  const panel = useRef<HTMLElement>(null)
  const visible = state.phase !== 'hidden'
  const applying = state.phase === 'applying'

  useEffect(() => {
    if (!visible) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    panel.current?.focus()
    return () => { document.body.style.overflow = previousOverflow }
  }, [visible, state.phase])

  if (!visible) return null

  const title = applying
    ? state.activate ? 'Applying simulator profile' : 'Saving simulator profile'
    : state.phase === 'success'
      ? state.activate ? 'Simulator profile applied' : 'Simulator profile saved'
      : 'Simulator profile was not applied'
  const description = applying
    ? state.activate
      ? 'The complete profile is being committed to R5C0 and the PL simulator, verified by readback, and saved.'
      : 'The profile is being validated against the simulator hardware and saved while the physical ADC remains selected.'
    : state.message ?? ''

  return <div className="simulator-apply-backdrop">
    <section ref={panel} tabIndex={-1}
      className={`simulator-apply-dialog ${state.phase}`}
      role={state.phase === 'error' ? 'alertdialog' : 'dialog'}
      aria-modal="true" aria-labelledby="simulator-apply-title"
      aria-describedby="simulator-apply-description" aria-busy={applying}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          if (!applying) onClose()
          return
        }
        if (event.key !== 'Tab') return
        const controls = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>(
          'button:not(:disabled)',
        ) ?? [])
        if (controls.length === 0) {
          event.preventDefault()
          return
        }
        const first = controls[0]
        const last = controls[controls.length - 1]
        if (event.shiftKey &&
            (document.activeElement === first || document.activeElement === panel.current)) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }}>
      <div className={`simulator-apply-symbol ${state.phase}`} aria-hidden="true">
        {applying ? <span className="simulator-apply-spinner" />
          : state.phase === 'success' ? '✓' : '!'}
      </div>
      <div className="simulator-apply-copy" aria-live="polite">
        <p className="eyebrow">ADC simulator settings</p>
        <h2 id="simulator-apply-title">{title}</h2>
        <p id="simulator-apply-description">{description}</p>
        {applying && <p className="simulator-apply-note">
          Capture can pause briefly during this coordinated transaction. Do not reload this page.</p>}
        {state.phase === 'success' && <p className="simulator-apply-note">
          The backend confirmed both the hardware apply and persistent save.</p>}
        {state.phase === 'error' && <>
          {state.httpStatus !== undefined && <code className="simulator-apply-code">
            HTTP {state.httpStatus}</code>}
          <p className="simulator-apply-note">
            The previous active profile remains in service. Close this dialog to edit the profile, or retry the same transaction.</p>
        </>}
      </div>
      {!applying && <div className="simulator-apply-actions">
        {state.phase === 'error' && <button type="button" className="secondary"
          onClick={onClose}>Review settings</button>}
        {state.phase === 'error' && <button type="button" onClick={onRetry}>Retry apply</button>}
        {state.phase === 'success' && <button type="button" onClick={onClose}>Done</button>}
      </div>}
    </section>
  </div>
}

function Login({ onLogin }: { onLogin: (session: Session) => void }) {
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api.login(username, password)
      onLogin(await api.session())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Login failed')
    } finally { setBusy(false) }
  }

  return <main className="login-shell"><section className="login-card">
    <div className="brand-mark">M</div>
    <p className="eyebrow">Monutchee instrumentation</p><h1>MSAP1 Meter</h1>
    <p className="login-intro">Sign in to inspect live grid measurements.</p>
    <form onSubmit={submit}>
      <label>Username<input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" /></label>
      <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus /></label>
      {error && <p className="form-error">{error}</p>}
      <button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
    </form>
    <p className="development-note">Development account: <code>admin / admin</code></p>
  </section></main>
}

/**
 * The card renders any tier's per-channel RMS. Only the footer differs, because
 * the 150/180-cycle aggregate carries no mean correction and no RMS count.
 */
type ChannelReading = Pick<MeterChannel, 'index' | 'name' | 'unit' | 'valid' | 'rms'>

function ReadingCard({ channel, values, healthy, footer }: {
  channel: ChannelReading
  values: number[]
  healthy: boolean
  footer: ReactNode
}) {
  return <article className="channel-card">
    <div className="channel-title"><span>CH{channel.index}</span><strong>{channel.name}</strong><i>{channel.unit === 'V' ? 'Voltage' : 'Current'}</i></div>
    <div className="channel-value">{channel.valid ? channel.rms.toFixed(3) : '—'}<small> {channel.unit} RMS</small></div>
    <Sparkline values={values} healthy={healthy && channel.valid} />
    <div className="range">{footer}</div>
  </article>
}

/**
 * CH7/VCM stays in the API model and history for future reference monitoring
 * but is not presented as a user-facing meter channel yet.
 */
function displayedChannels<T extends { index: number; unit: string }>(channels: T[]) {
  return [
    ...channels.filter((channel) => VISIBLE_CHANNELS.has(channel.index) && channel.unit === 'V'),
    ...channels.filter((channel) => VISIBLE_CHANNELS.has(channel.index) && channel.unit === 'A'),
  ]
}

function frequencyUnavailableReason(readings: MeterReadings | undefined) {
  const frequency = readings?.frequency
  if (!frequency) return 'waiting for meter record'
  if (!frequency.enabled) return 'disabled'
  if (frequency.arithmetic_error) return 'arithmetic fault'
  if (!frequency.reference_valid) return 'VLA reference unavailable'
  if (frequency.out_of_range) return 'outside configured range'
  if (frequency.timed_out) return 'no qualified zero crossing'
  return 'measuring'
}

function FrequencyCard({ readings, history, healthy }: {
  readings: MeterReadings | undefined
  history: MeterReadings[]
  healthy: boolean
}) {
  const frequency = readings?.frequency
  const values = history
    .filter((record) => record.frequency.valid)
    .map((record) => record.frequency.hz)
  const minimum = values.length > 0 ? Math.min(...values).toFixed(3) : '—'
  const maximum = values.length > 0 ? Math.max(...values).toFixed(3) : '—'
  return <article className="channel-card frequency-card">
    <div className="channel-title"><span>GRID</span><strong>Frequency</strong><i>CH6 VLA</i></div>
    <div className="channel-value">{frequency?.valid ? frequency.hz.toFixed(3) : '—'}<small> Hz</small></div>
    <Sparkline values={values} healthy={healthy && (frequency?.valid ?? false)} />
    <div className="range">
      {frequency?.valid
        ? <><span>min {minimum} Hz</span><span>max {maximum} Hz</span></>
        : <><span>{frequencyUnavailableReason(readings)}</span><span>unavailable</span></>}
    </div>
  </article>
}

/**
 * Aggregate grid frequency. IEC 61000-4-30:2025 defines the standardized
 * frequency product over its own 10 s interval, which this tier is not, so the
 * value is presented as informative and never as a Class A measurement.
 */
function AggregateFrequencyCard({ aggregate, history, healthy }: {
  aggregate: MeterAggregateResult
  history: MeterAggregateResult[]
  healthy: boolean
}) {
  // The PL reports 0 mHz when it could not compute the mean (any contributing
  // block had an invalid frequency). 0 Hz is not a meaningful grid frequency,
  // so treat it as "not computed" rather than displaying a fabricated value.
  const computed = aggregate.frequency.millihz > 0
  const values = history
    .filter((record) => record.frequency.millihz > 0)
    .map((record) => record.frequency.millihz / 1000)
  return <article className="channel-card frequency-card">
    <div className="channel-title"><span>GRID</span><strong>Frequency</strong><i>informative</i></div>
    <div className="channel-value">{computed
      ? (aggregate.frequency.millihz / 1000).toFixed(3)
      : '—'}<small> Hz</small></div>
    <Sparkline values={values} healthy={healthy && computed} />
    <p className="channel-note">Informative — the standardized frequency
      measurement is defined over a 10 s interval, not this tier, so this
      mean is not a Class A frequency measurement.</p>
  </article>
}

/**
 * Compact provenance for the displayed aggregate: what was aggregated, which
 * basic measurement blocks it came from, and how trustworthy its timing is.
 */
function AggregateProvenance({ aggregate }: { aggregate: MeterAggregateResult }) {
  const blockCycles = aggregate.basic_block_count > 0
    ? Math.round(aggregate.cycle_count / aggregate.basic_block_count)
    : 0
  return <section className="aggregate-provenance">
    <span>Window <strong>{aggregate.cycle_count} cycles</strong> ({aggregate.nominal_frequency_hz} Hz nominal, ~3 s nominal)</span>
    <span>Blocks <strong>{aggregate.basic_block_count} × {blockCycles}-cycle</strong></span>
    <span>Basic sequence <strong>{aggregate.first_basic_sequence}..{aggregate.last_basic_sequence}</strong></span>
    <span>Aggregate <strong>#{aggregate.sequence}</strong></span>
    <span>Age <strong>{formatCount(aggregate.age_ms)} ms</strong></span>
    <StatusPill ok={aggregate.time_quality === 'synchronized'}>
      {`Time ${aggregate.time_quality}`}</StatusPill>
    {aggregate.arithmetic_error &&
      <span className="saturated"><strong>Arithmetic error — aggregation saturated</strong></span>}
  </section>
}

/**
 * Identity and sample-range provenance for the authoritative Basic result.
 * Keeping this beside the aggregate provenance makes it possible to correlate
 * a displayed 10/12-cycle block with R5C1 input and acquisition diagnostics.
 */
function BasicProvenance({ readings }: { readings: MeterReadings | undefined }) {
  const timing = readings?.timing
  if (!readings || !timing) return null

  const lastSample = timing.sample_count > 0
    ? timing.first_sample_index + timing.sample_count - 1
    : timing.first_sample_index

  return <section className="aggregate-provenance">
    <span>Window <strong>{timing.cycle_count} cycles</strong> ({timing.nominal_frequency_hz} Hz nominal)</span>
    <span>Basic <strong>#{timing.block_sequence}</strong></span>
    <span>Meter record <strong>#{readings.sequence}</strong></span>
    <span>Samples <strong>{formatCount(timing.first_sample_index)}..{formatCount(lastSample)}</strong></span>
    <StatusPill ok={timing.time_quality === 'synchronized'}>
      {`Time ${timing.time_quality}`}</StatusPill>
  </section>
}

/**
 * Not an error: the first aggregate simply needs 15 consecutive eligible basic
 * measurement blocks, which is roughly three seconds of acquisition.
 */
function AggregatePending() {
  return <section className="aggregate-pending">
    <strong>Waiting for the first 150/180-cycle aggregate</strong>
    <span>This tier aggregates 15 consecutive basic measurement blocks — 150
      cycles at 50 Hz nominal, 180 cycles at 60 Hz nominal, roughly three
      seconds. A result appears as soon as 15 consecutive eligible basic blocks
      have been collected. Acquisition is not degraded while this is shown.</span>
  </section>
}

/** Long-interval records intentionally contain no frequency estimate. */
function LongIntervalFrequencyCard({ interval }: { interval: string }) {
  return <article className="channel-card frequency-card">
    <div className="channel-title"><span>GRID</span><strong>Frequency</strong><i>separate interval</i></div>
    <div className="channel-value">—<small> Hz</small></div>
    <div className="sparkline empty" />
    <p className="channel-note">Unavailable at this tier — standardized grid
      frequency is measured over its own 10-second interval and is not
      synthesized from the {interval} aggregate.</p>
  </article>
}

/** Identity and timing provenance shared by finalized long-interval tiers. */
function LongIntervalProvenance({ aggregate, window, composition }: {
  aggregate: MeterTenMinuteResult | MeterTwoHourResult
  window: string
  composition: string
}) {
  return <section className="aggregate-provenance">
    {aggregate.open_interval && <span className="saturated"><strong>
      Live partial · non-normative</strong></span>}
    <span>Window <strong>{window}</strong> ({composition})</span>
    <span>Cycles <strong>{formatCount(aggregate.cycle_count)}</strong> ({aggregate.nominal_frequency_hz} Hz nominal)</span>
    <span>Samples <strong>{formatCount(aggregate.sample_count)}</strong></span>
    <span>First sample <strong>{formatCount(aggregate.first_sample_index)}</strong></span>
    <span>Aggregate <strong>#{aggregate.sequence}</strong></span>
    <span>Age <strong>{formatCount(aggregate.age_ms)} ms</strong></span>
    {aggregate.open_interval && <>
      <span>Progress <strong>{formatCount(aggregate.source_interval_count)} source intervals</strong></span>
      <span>Elapsed <strong>{formatCount(aggregate.elapsed_milliseconds)} ms</strong></span>
      <span>Source sequence <strong>{formatCount(aggregate.first_source_sequence)}..{formatCount(aggregate.last_source_sequence)}</strong></span>
    </>}
    <StatusPill ok={aggregate.time_quality === 'synchronized'}>
      {`Time ${aggregate.time_quality}`}</StatusPill>
    {aggregate.open_interval && <StatusPill ok={aggregate.boundary_valid && !aggregate.contaminated}>
      {aggregate.contaminated ? 'Contaminated' : aggregate.boundary_valid
        ? 'Boundary valid' : 'Boundary pending'}</StatusPill>}
    {aggregate.arithmetic_error &&
      <span className="saturated"><strong>Arithmetic error — aggregation saturated</strong></span>}
  </section>
}

/** Waiting for an aligned long interval is normal and is not a fault. */
function LongIntervalPending({ title, detail }: { title: string; detail: string }) {
  return <section className="aggregate-pending">
    <strong>{title}</strong>
    <span>{detail} Acquisition is not degraded while this is shown.</span>
  </section>
}

const LOG_COMPONENTS = [
  { value: '', label: 'All components' },
  { value: 'fpga-acquisition', label: 'FPGA acquisition' },
  { value: 'web-backend', label: 'Web backend' },
  { value: 'mqtt-publisher', label: 'MQTT publisher' },
  { value: 'modbus', label: 'Modbus server' },
  { value: 'firmware', label: 'Firmware lifecycle' },
]

const LOG_MODULES = [
  { value: '', label: 'All modules' },
  { value: 'lifecycle', label: 'Lifecycle' },
  { value: 'dma', label: 'DMA' },
  { value: 'rpmsg', label: 'RPMsg' },
  { value: 'adc-config', label: 'ADC configuration' },
  { value: 'health', label: 'Health' },
  { value: 'nginx', label: 'nginx' },
  { value: 'http', label: 'HTTP' },
  { value: 'auth', label: 'Authentication' },
  { value: 'pl', label: 'PL firmware' },
  { value: 'rpu', label: 'RPU firmware' },
]

const LOG_PRIORITIES: { value: LogPriority; label: string }[] = [
  { value: 'debug', label: 'Debug and above' },
  { value: 'info', label: 'Info and above' },
  { value: 'notice', label: 'Notice and above' },
  { value: 'warning', label: 'Warning and above' },
  { value: 'error', label: 'Error and above' },
  { value: 'critical', label: 'Critical and above' },
  { value: 'alert', label: 'Alert and above' },
  { value: 'emergency', label: 'Emergency only' },
]

function logTimestamp(timestampUsec: number) {
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  }).format(new Date(timestampUsec / 1000))
}

function prettyRawLog(raw: string) {
  try { return JSON.stringify(JSON.parse(raw), null, 2) }
  catch { return raw }
}

function TemperatureCard({ sensor, history }: {
  sensor: SocTemperature
  history: number[]
}) {
  const minimum = history.length > 0 ? Math.min(...history).toFixed(3) : '—'
  const maximum = history.length > 0 ? Math.max(...history).toFixed(3) : '—'
  return <article className="temperature-card">
    <div className="temperature-title">
      <span>{sensor.zone}</span><strong>{sensor.label}</strong>
      <StatusPill ok={sensor.available}>{sensor.available ? 'Available' : 'Unavailable'}</StatusPill>
    </div>
    <div className="temperature-value">
      {sensor.available ? sensor.temperature_c.toFixed(3) : '—'}<small> °C</small>
    </div>
    <Sparkline values={history} healthy={sensor.available} />
    <div className="range"><span>min {minimum} °C</span><span>max {maximum} °C</span></div>
  </article>
}

function TelemetryPanel({ health, readings }: {
  health: SystemHealth | undefined
  readings: MeterReadings | undefined
}) {
  return <section className="telemetry-panel">
    <header className="temperature-panel-header">
      <div><p className="eyebrow">Acquisition telemetry</p><h2>PL and DMA counters</h2></div>
      <span>Live diagnostic data</span>
    </header>
    <div className="metric-grid developer-metrics">
      <article className="metric"><span>Sample rate</span><strong>{formatCount(readings?.sample_rate_hz)} <small>frame/s</small></strong></article>
      <article className="metric"><span>ADC DCLK</span><strong>{health?.adc.dclk_frequency_hz ? formatCount(health.adc.dclk_frequency_hz) : '—'} <small>Hz</small></strong></article>
      <article className="metric"><span>ADC DRDY</span><strong>{health?.adc.drdy_frequency_hz ? formatCount(health.adc.drdy_frequency_hz) : '—'} <small>frame/s</small></strong></article>
      <article className="metric"><span>ADC packets</span><strong>{formatCount(health?.adc.packets)}</strong></article>
      <article className="metric"><span>Meter records</span><strong>{formatCount(health?.acquisition.records)}</strong></article>
      <article className="metric"><span>DMA traffic</span><strong>{formatBytes(health?.acquisition.bytes)}</strong></article>
      <article className="metric"><span>Configuration</span><strong>{readings ? `0x${readings.configuration_generation.toString(16).padStart(8, '0')}` : '—'}</strong></article>
    </div>
  </section>
}

function AboutPage({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [about, setAbout] = useState<SystemAbout>()
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    api.about().then((value) => {
      if (active) { setAbout(value); setError('') }
    }).catch((reason) => {
      if (!active) return
      if (reason instanceof ApiError && reason.status === 401) {
        onUnauthorized()
        return
      }
      setError(reason instanceof Error ? reason.message : 'Unable to read system information')
    })
    return () => { active = false }
  }, [onUnauthorized])

  return <section className="about-page">
    <div className="developer-heading">
      <div><p className="eyebrow">About</p><h1>System information</h1>
        <p>Software identity for this MSAP1 meter.</p></div>
    </div>
    {error && <div className="error-banner"><strong>System information unavailable</strong><span>{error}</span></div>}
    <section className="about-panel">
      <div className="about-product">
        <span className="brand-mark">M</span>
        <div><p className="eyebrow">Monutchee instrumentation</p>
          <h2>{about?.product ?? 'MSAP1'}</h2>
          <p>{about?.operating_system ?? 'MNCOS'}</p></div>
      </div>
      <dl className="about-details">
        <div><dt>Yocto system version</dt><dd>{about?.yocto_system_version || '—'}</dd></div>
        <div><dt>Build hex</dt><dd><code>{about?.build_hex || '—'}</code></dd></div>
        <div><dt>Software build date</dt><dd>{about?.software_build_date || '—'}</dd></div>
        <div><dt>Image recipe</dt><dd>{about?.image_recipe || '—'}</dd></div>
        <div><dt>Machine</dt><dd>{about?.machine || '—'}</dd></div>
      </dl>
    </section>
    <section className="documentation-panel" aria-labelledby="documentation-title">
      <div>
        <p className="eyebrow">Documentation</p>
        <h2 id="documentation-title">Product integration files</h2>
        <p>Download the immutable API contract and Modbus register map built into this software image.</p>
      </div>
      <div className="documentation-downloads">
        <a href={openApiDocumentDownloadPath} download="msap1_api.yaml">
          <span>OpenAPI 3.1</span>
          <strong>Download OpenAPI YAML</strong>
          <small>msap1_api.yaml</small>
        </a>
        <a href={modbusRegisterDocumentDownloadPath}
          download="msap1_modbus_registers.xlsx">
          <span>Modbus map</span>
          <strong>Download Modbus registers XLSX</strong>
          <small>msap1_modbus_registers.xlsx</small>
        </a>
      </div>
    </section>
  </section>
}

/** Per-component pipeline pills, moved off the dashboard to keep it lean. */
function PipelineHealthPanel({ health }: { health: SystemHealth | undefined }) {
  const aggregation = health?.aggregation
  return <section className="health-panel">
    <div><p className="eyebrow">Pipeline health</p><h2>Meter components</h2></div>
    <div className="health-details">
      <div className="health-list">
        {health?.adc.source === 'simulator'
          ? <StatusPill ok={health.adc.simulator_healthy}>ADC simulator</StatusPill>
          : <StatusPill ok={health?.adc.spi_responsive ?? false}>AD7771 SPI</StatusPill>}
        <StatusPill ok={health?.adc.rate_match ?? false}>ADC sample rate</StatusPill>
        <StatusPill ok={health?.adc.headers_valid ?? false}>Frame headers</StatusPill>
        <StatusPill ok={health?.adc.fifo_ok ?? false}>PL FIFO</StatusPill>
        <StatusPill ok={health?.adc.meter_generation_match ?? false}>PL configuration</StatusPill>
        <StatusPill ok={health?.adc.current_wiring.match ?? false}
          neutral={!health?.adc.current_wiring}>Current wiring</StatusPill>
        <StatusPill ok={(health?.acquisition.read_errors ?? 1) === 0 &&
          !(health?.acquisition.record_stale ?? true)}>Meter DMA</StatusPill>
        <StatusPill ok={!(health?.acquisition.health_probe_pending ?? true)}>
          ADC health audit
        </StatusPill>
        {aggregation?.available
          ? <StatusPill ok={aggregation.healthy}>
              {`RPU aggregation (${aggregation.authoritative ? 'authoritative' : 'shadow'})`}
            </StatusPill>
          : <StatusPill ok={false} neutral>RPU aggregation unavailable</StatusPill>}
        <StatusPill ok={health?.frequency_arithmetic_ok ?? false}>Frequency arithmetic</StatusPill>
        <StatusPill ok={health?.nginx_running ?? false}>nginx</StatusPill>
      </div>
      {(health?.adc.degraded_reasons?.length ?? 0) > 0 &&
        <ul className="health-reasons" aria-label="ADC degradation reasons">
          {health?.adc.degraded_reasons?.map((reason) =>
            <li key={reason.code}><code>{reason.code}</code>{reason.message}</li>)}
        </ul>}
      {(aggregation?.degraded_reasons?.length ?? 0) > 0 &&
        <ul className="health-reasons" aria-label="RPU aggregation degradation reasons">
          {aggregation?.degraded_reasons?.map((reason) =>
            <li key={reason.code}><code>{reason.code}</code>{reason.message}</li>)}
        </ul>}
    </div>
  </section>
}

function DeveloperOverview({ onUnauthorized, health, readings }: {
  onUnauthorized: () => void
  health: SystemHealth | undefined
  readings: MeterReadings | undefined
}) {
  const [temperatures, setTemperatures] = useState<SocTemperatures>()
  const [history, setHistory] = useState<Record<string, number[]>>({})
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    let pending = false
    const load = async () => {
      if (pending) return
      pending = true
      try {
        const next = await api.developerTemperatures()
        if (active) {
          setTemperatures(next)
          setHistory((current) => {
            const updated = { ...current }
            for (const sensor of next.sensors) {
              if (!sensor.available) continue
              updated[sensor.zone] =
                [...(current[sensor.zone] ?? []), sensor.temperature_c].slice(-HISTORY)
            }
            return updated
          })
          setError('')
        }
      } catch (reason) {
        if (!active) return
        if (reason instanceof ApiError && reason.status === 401) {
          onUnauthorized()
          return
        }
        setError(reason instanceof Error ? reason.message : 'Unable to read SoC temperatures')
      } finally { pending = false }
    }
    void load()
    const timer = window.setInterval(load, 2000)
    return () => { active = false; window.clearInterval(timer) }
  }, [onUnauthorized])

  return <div className="developer-overview">
    <TelemetryPanel health={health} readings={readings} />
    <PipelineHealthPanel health={health} />
    <section className="temperature-panel">
    <header className="temperature-panel-header">
      <div><p className="eyebrow">Thermal monitoring</p><h2>SoC temperatures</h2></div>
      <span>Updated every 2 seconds</span>
    </header>
    {error && <div className="log-error">{error}</div>}
    <div className="temperature-grid">
      {(temperatures?.sensors ?? [
        { zone: 'LPD', label: 'Temp_LPD', available: false, millidegrees_c: 0, temperature_c: 0 },
        { zone: 'FPD', label: 'Temp_FPD', available: false, millidegrees_c: 0, temperature_c: 0 },
        { zone: 'PL', label: 'Temp_PL', available: false, millidegrees_c: 0, temperature_c: 0 },
      ]).map((sensor) =>
        <TemperatureCard key={sensor.zone} sensor={sensor}
          history={history[sensor.zone] ?? []} />)}
    </div>
    </section>
  </div>
}

function DeveloperAboutPage({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [about, setAbout] = useState<DeveloperAbout>()
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    api.developerAbout().then((value) => {
      if (active) { setAbout(value); setError('') }
    }).catch((reason) => {
      if (!active) return
      if (reason instanceof ApiError && reason.status === 401) {
        onUnauthorized()
        return
      }
      setError(reason instanceof Error ? reason.message : 'Unable to fingerprint deployed components')
    })
    return () => { active = false }
  }, [onUnauthorized])

  return <section className="component-panel">
    <header className="temperature-panel-header">
      <div><p className="eyebrow">Deployed software</p><h2>Component fingerprints</h2></div>
      <span>{about?.digest_algorithm ?? 'MD5'} diagnostic identity</span>
    </header>
    {error && <div className="log-error">{error}</div>}
    <p className="digest-purpose">{about?.digest_purpose ??
      'Fingerprint data is loading. MD5 values are diagnostic identifiers, not security checks.'}</p>
    <div className="component-list">
      {(about?.components ?? []).map((component) =>
        <article className="component-row" key={component.id}>
          <div><span>{component.component_type}</span><strong>{component.label}</strong>
            <code>{component.path}</code></div>
          <div className="component-digest">
            <span>{component.available ? formatBytes(component.size_bytes) : 'Unavailable'}</span>
            <code>{component.available ? component.md5 : 'file not found'}</code>
          </div>
        </article>)}
      {!about && !error && <div className="log-empty"><strong>Reading deployed components…</strong></div>}
    </div>
  </section>
}

function DeveloperLogs({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [component, setComponent] = useState('')
  const [module, setModule] = useState('')
  const [priority, setPriority] = useState<LogPriority>('notice')
  const [raw, setRaw] = useState(false)
  const [live, setLive] = useState(true)
  const [entries, setEntries] = useState<DeveloperLogEntry[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const cursor = useRef('')
  const requestPending = useRef(false)
  const filterGeneration = useRef(0)
  const viewport = useRef<HTMLDivElement>(null)

  const load = useCallback(async (reset = false) => {
    if (requestPending.current) return
    const generation = filterGeneration.current
    requestPending.current = true
    setLoading(true)
    try {
      const page = await api.developerLogs({
        component: component || undefined,
        module: module || undefined,
        priority,
        after: reset ? undefined : cursor.current || undefined,
        limit: reset ? 100 : 200,
      })
      if (generation !== filterGeneration.current) return
      cursor.current = page.next_cursor
      setEntries((current) => {
        if (reset) return page.entries
        if (page.entries.length === 0) return current
        const known = new Set(current.map((entry) => entry.cursor))
        const next = [...current, ...page.entries.filter((entry) => !known.has(entry.cursor))]
        return next.slice(-500)
      })
      setError('')
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        onUnauthorized()
        return
      }
      if (reason instanceof ApiError && reason.status === 409) {
        cursor.current = ''
        setEntries([])
        setError('The journal rotated; loading the newest entries.')
        return
      }
      setError(reason instanceof Error ? reason.message : 'Unable to read the system journal')
    } finally {
      requestPending.current = false
      setLoading(false)
    }
  }, [component, module, onUnauthorized, priority])

  useEffect(() => {
    filterGeneration.current += 1
    cursor.current = ''
    setEntries([])
    void load(true)
  }, [component, module, priority, load])

  useEffect(() => {
    if (!live) return
    const timer = window.setInterval(() => void load(false), 1000)
    return () => window.clearInterval(timer)
  }, [live, load])

  useEffect(() => {
    if (live && viewport.current)
      viewport.current.scrollTop = viewport.current.scrollHeight
  }, [entries, live])

  function clearView() {
    setEntries([])
    setError('')
  }

  return <section className="log-panel">
      <header className="log-panel-header">
        <div><p className="eyebrow">Journal</p><h2>MSAP1 service logs</h2></div>
        <div className="log-actions">
          <button type="button" onClick={() => void load(true)} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
          <button type="button" className={raw ? 'active' : ''} aria-pressed={raw}
            onClick={() => setRaw((value) => !value)}>
            {raw ? 'Condensed view' : 'Raw view'}
          </button>
          <button type="button" className={live ? 'active' : ''} aria-pressed={live}
            onClick={() => setLive((value) => !value)}>
            {live ? 'Pause live' : 'Resume live'}
          </button>
        </div>
      </header>
      <div className="log-toolbar">
        <label>Component<select value={component} onChange={(event) => setComponent(event.target.value)}>
          {LOG_COMPONENTS.map((option) =>
            <option key={option.value} value={option.value}>{option.label}</option>)}
        </select></label>
        <label>Module<select value={module} onChange={(event) => setModule(event.target.value)}>
          {LOG_MODULES.map((option) =>
            <option key={option.value} value={option.value}>{option.label}</option>)}
        </select></label>
        <label>Log level<select value={priority}
          onChange={(event) => setPriority(event.target.value as LogPriority)}>
          {LOG_PRIORITIES.map((option) =>
            <option key={option.value} value={option.value}>{option.label}</option>)}
        </select></label>
      </div>
      {error && <div className="log-error">{error}</div>}
      <div className={`log-viewport ${raw ? 'raw' : ''}`} ref={viewport}
        aria-live={live ? 'polite' : 'off'}>
        {entries.length === 0 && !loading &&
          <div className="log-empty"><strong>No matching log entries</strong>
            <span>Change the filters or wait for a new service event.</span></div>}
        {entries.map((entry) => raw
          ? <pre className={`raw-log priority-${entry.priority}`} key={entry.cursor}>
              {prettyRawLog(entry.raw)}
            </pre>
          : <article className={`log-entry priority-${entry.priority}`} key={entry.cursor}>
              <div className="log-entry-head">
                <time>{logTimestamp(entry.timestamp_usec)}</time>
                <span className="priority-badge">{entry.priority}</span>
                <strong>{entry.component || entry.unit || 'system'}</strong>
                {entry.module && <em>{entry.module}</em>}
              </div>
              <p>{entry.message || '(empty journal message)'}</p>
              <div className="log-meta">
                {entry.event && <span>event: {entry.event}</span>}
                {entry.request_id && <span>request: {entry.request_id}</span>}
                {entry.configuration_generation &&
                  <span>generation: {entry.configuration_generation}</span>}
                {entry.source_file &&
                  <span>source: {entry.source_file}{entry.source_line ? `:${entry.source_line}` : ''}</span>}
              </div>
            </article>)}
      </div>
      <footer className="log-footer">
        <span>Showing {entries.length} newest entries (maximum 500)</span>
        <button type="button" onClick={clearView}>Clear view</button>
      </footer>
  </section>
}

// Sample rates supported by the APU acquisition pipeline.
const SAMPLE_RATES_HZ = [1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000]

function DeveloperTweak({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [sampleRate, setSampleRate] = useState<number>()
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    api.activeSettings().then((activeSettings) => {
      if (active) setSampleRate(activeSettings.settings.metering.sample_rate_hz)
    }).catch((reason) => {
      if (!active) return
      if (reason instanceof ApiError && reason.status === 401) { onUnauthorized(); return }
      setError(reason instanceof Error ? reason.message : 'Unable to read settings')
    })
    return () => { active = false }
  }, [onUnauthorized])

  async function save(event: FormEvent) {
    event.preventDefault()
    if (sampleRate === undefined) return
    setStatus('Saving…')
    setError('')
    try {
      await saveSettings((settings) => { settings.metering.sample_rate_hz = sampleRate })
      setStatus('Applied and saved.')
    } catch (reason) {
      setStatus('')
      if (reason instanceof ApiError && reason.status === 401) { onUnauthorized(); return }
      setError(reason instanceof Error ? reason.message : 'Unable to save settings')
    }
  }

  return <div>
    <section className="section-heading configuration-heading">
      <div><p className="eyebrow">Tweak</p><h2>Acquisition parameters</h2></div>
      <span>Factory default: 128 kSPS</span>
    </section>
    {error && <div className="error-banner"><strong>Settings unavailable</strong><span>{error}</span></div>}
    <form className="frequency-form" onSubmit={save}>
      <label>Sample rate<select value={sampleRate ?? 128000}
        onChange={(event) => setSampleRate(Number(event.target.value))}>
        {SAMPLE_RATES_HZ.map((rate) =>
          <option key={rate} value={rate}>{rate / 1000} kSPS</option>)}
      </select>
        <small>Changing the rate restarts capture</small></label>
      <div className="frequency-actions"><button type="submit">Apply and save</button>
        <span>{status}</span></div>
    </form>
  </div>
}

/** Normalize any angle into the industry 0..359.999-degree convention. */
function wrapDegrees(value: number): number {
  return ((value % 360) + 360) % 360
}

/**
 * Controlled numeric input that tolerates transient states while typing.
 * Coercing every keystroke with Number() swallows a lone "-" or "0."
 * (Number("-") is NaN), which made negative phase angles untypable. The
 * field keeps the raw text as a local draft and propagates only finite
 * parses; blur reverts an unparseable draft to the last good value.
 */
function NumberField({ label, value, onValue, min, max, step }: {
  label: string
  value: number
  onValue: (value: number) => void
  min?: string
  max?: string
  step?: string
}) {
  const [draft, setDraft] = useState(String(value))
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    if (!editing) setDraft(String(value))
  }, [value, editing])
  return <label>{label}<input type="number" min={min} max={max} step={step}
    value={draft}
    onFocus={() => setEditing(true)}
    onBlur={() => {
      setEditing(false)
      const parsed = Number(draft)
      if (draft !== '' && Number.isFinite(parsed)) onValue(parsed)
      else setDraft(String(value))
    }}
    onChange={(event) => {
      setDraft(event.target.value)
      const parsed = Number(event.target.value)
      if (event.target.value !== '' && Number.isFinite(parsed)) onValue(parsed)
  }} /></label>
}

const HARMONIC_RATIO_QUANTUM = 1 / 65536
// The old number input used 1.000015 as its HTML step base, producing values
// such as 5.000015 when the operator selected H5. Snap that decimal artefact,
// but preserve a genuine one-Q16-LSB interharmonic (5.000015258789...).
const HARMONIC_INTEGER_SNAP = HARMONIC_RATIO_QUANTUM - 0.00000015
const SIMULATOR_CHANNEL_NAMES = ['Ia', 'Ib', 'Ic', 'In', 'Vc', 'Vb', 'Va'] as const

function isIntegerHarmonic(order: number): boolean {
  return Math.abs(order - Math.round(order)) < HARMONIC_INTEGER_SNAP
}

/** Mirror the RPU's Q16.16 wire representation and remove UI step artefacts. */
function normalizeToneRatio(order: number): number {
  if (isIntegerHarmonic(order)) return Math.round(order)
  const quantized = Math.round(order * 65536) / 65536
  return quantized
}

function toneTargets(channels: AdcSimulatorHarmonic['channels']): string {
  if (channels === 'voltage') return 'Va, Vb, Vc'
  if (channels === 'current') return 'Ia, Ib, Ic, In'
  return 'all voltage and current lanes'
}

function SimulatorToneCard({ harmonic, index, baseFrequencyHz, sampleRateHz,
  channels, onChange, onRemove }: {
  harmonic: AdcSimulatorHarmonic
  index: number
  baseFrequencyHz: number
  sampleRateHz: number
  channels: AdcSimulatorConfiguration['channels']
  onChange: (changes: Partial<AdcSimulatorHarmonic>) => void
  onRemove: () => void
}) {
  const mode = isIntegerHarmonic(harmonic.order) ? 'harmonic' : 'interharmonic'
  const ratio = normalizeToneRatio(harmonic.order)
  const harmonicOrder = Math.min(127, Math.max(2, Math.round(ratio)))
  const toneFrequencyHz = ratio * baseFrequencyHz
  const nyquistHz = sampleRateHz / 2
  const ratioValid = ratio > 1 && ratio < 128
  const belowNyquist = toneFrequencyHz * 2 < sampleRateHz
  const laneIncluded = (channel: number) => harmonic.channels === 'all' ||
    (harmonic.channels === 'current' && channel < 4) ||
    (harmonic.channels === 'voltage' && channel >= 4 && channel < 7)
  const expected = channels
    .filter((channel) => channel.channel < 7 && laneIncluded(channel.channel))
    .map((channel) => {
      const name = SIMULATOR_CHANNEL_NAMES[channel.channel]
      const unit = channel.channel < 4 ? 'A' : 'V'
      return `${name} ${(channel.rms * harmonic.percent / 100).toFixed(3)} ${unit}`
    })
  const switchMode = (next: 'harmonic' | 'interharmonic') => {
    if (next === mode) return
    onChange({ order: next === 'harmonic'
      ? harmonicOrder
      : Math.min(127.5, harmonicOrder + 0.5) })
  }
  const maximumToneHz = Math.min(baseFrequencyHz * 128, nyquistHz)

  return <article className={`simulator-tone-card ${!ratioValid || !belowNyquist ? 'invalid' : ''}`}>
    <header>
      <div><span>Slot {index + 1}</span>
        <strong>{mode === 'harmonic' ? `H${harmonicOrder}` : 'Interharmonic'}</strong></div>
      <div className="simulator-tone-kind" role="group" aria-label={`Slot ${index + 1} tone type`}>
        <button type="button" className={mode === 'harmonic' ? 'active' : ''}
          onClick={() => switchMode('harmonic')}>Harmonic</button>
        <button type="button" className={mode === 'interharmonic' ? 'active' : ''}
          onClick={() => switchMode('interharmonic')}>Interharmonic</button>
      </div>
      <button className="simulator-tone-remove" type="button" onClick={onRemove}
        aria-label={`Remove tone slot ${index + 1}`}>Remove</button>
    </header>
    <div className="simulator-tone-fields">
      {mode === 'harmonic'
        ? <NumberField label="Harmonic order" min="2" max="127" step="1"
            value={harmonicOrder}
            onValue={(value) => onChange({ order: Math.round(value) })} />
        : <NumberField label="Tone frequency (Hz)"
            min={(baseFrequencyHz + 0.001).toFixed(3)}
            max={Math.max(baseFrequencyHz + 0.001, maximumToneHz - 0.001).toFixed(3)}
            step="0.001" value={toneFrequencyHz}
            onValue={(value) => onChange({ order: value / baseFrequencyHz })} />}
      <NumberField label="Level (% of H1)" min="0" max="99.9"
        step="0.1" value={harmonic.percent}
        onValue={(value) => onChange({ percent: value })} />
      <NumberField label="Additional phase (degrees)" min="0" max="359.999"
        step="0.001" value={wrapDegrees(harmonic.phase_degrees)}
        onValue={(value) => onChange({ phase_degrees: wrapDegrees(value) })} />
      <label>Apply to<select value={harmonic.channels}
        onChange={(event) => onChange({
          channels: event.target.value as AdcSimulatorHarmonic['channels'],
        })}>
        <option value="voltage">Voltage · Va Vb Vc</option>
        <option value="current">Current · Ia Ib Ic In</option>
        <option value="all">All measurement lanes</option>
      </select></label>
    </div>
    <div className="simulator-tone-preview">
      <span><small>Generated tone</small><strong>{toneFrequencyHz.toFixed(3)} Hz</strong>
        <em>{mode === 'harmonic' ? `${harmonicOrder} × ${baseFrequencyHz.toFixed(3)} Hz` : `ratio ${ratio.toFixed(6)}`}</em></span>
      <span><small>Targets</small><strong>{toneTargets(harmonic.channels)}</strong>
        <em>{expected.join(' · ') || 'No receiving lanes'}</em></span>
      <span><small>Sample-rate check</small>
        <strong className={belowNyquist ? 'good' : 'bad'}>
          {belowNyquist ? 'Inside Nyquist band' : 'Tone is not representable'}</strong>
        <em>{sampleRateHz.toLocaleString()} SPS · Nyquist {nyquistHz.toLocaleString()} Hz</em></span>
    </div>
    {!ratioValid && <p className="simulator-tone-error">The frequency ratio must be above 1 and below 128.</p>}
    {ratioValid && !belowNyquist && <p className="simulator-tone-error">
      Lower the tone frequency or select a higher ADC sample rate before applying this profile.</p>}
    {harmonic.percent === 0 && <p className="simulator-tone-hint">
      A 0% level is valid but produces no visible spectral component.</p>}
  </article>
}

type SimulatorCategory = 'measurement' | 'harmonics' | 'power-quality'

const SIMULATOR_LANE_GROUPS = [
  { title: 'Voltage', detail: 'Phase-to-neutral inputs', channels: [6, 5, 4] },
  { title: 'Current', detail: 'Phase and neutral inputs', channels: [0, 1, 2, 3] },
] as const

function SimulatorMeasurementLanes({
  simulator, onChange, onUnauthorized, enabled = true,
}: {
  simulator: AdcSimulatorConfiguration
  onChange: (configuration: AdcSimulatorConfiguration) => void
  onUnauthorized: () => void
  enabled?: boolean
}) {
  return <section id="simulator-panel-measurement" role="tabpanel"
    aria-labelledby="simulator-tab-measurement" className="simulator-category-panel">
    <div className="simulator-form-heading">
      <div><p className="eyebrow">Base waveform</p><h3>Signal and continuity</h3></div>
      <span>H1 establishes every tone's level and phase reference.</span>
    </div>
    <div className="simulator-global-grid">
      <NumberField label="Signal frequency (Hz)" min="0.001" max="1000"
        step="0.001" value={simulator.frequency_hz}
        onValue={(value) => onChange({ ...simulator, frequency_hz: value })} />
      <label className="simulator-checkbox">
        <input type="checkbox" checked={simulator.preserve_phase}
          onChange={(event) => onChange({
            ...simulator, preserve_phase: event.target.checked,
          })} />
        Preserve phase across apply
      </label>
    </div>
    <div className="simulator-form-heading compact">
      <div><p className="eyebrow">Fundamentals</p><h3>Measurement lanes</h3></div>
      <span>RMS, phase, offset, and noise before spectral tones are added.</span>
    </div>
    {SIMULATOR_LANE_GROUPS.map((group) => <section className="simulator-lane-group"
      key={group.title} aria-labelledby={`simulator-${group.title.toLowerCase()}-lanes`}>
      <header><div><h4 id={`simulator-${group.title.toLowerCase()}-lanes`}>
        {group.title}</h4><span>{group.detail}</span></div>
        <small>{group.channels.length} lanes</small></header>
      <div className="simulator-channel-grid">
        {group.channels.flatMap((channelIndex) => {
          const channel = simulator.channels.find((candidate) =>
            candidate.channel === channelIndex)
          if (!channel) return []
          const name = SIMULATOR_CHANNEL_NAMES[channel.channel]
          const unit = channel.channel < 4 ? 'A' : 'V'
          const update = (changes: Partial<typeof channel>) => onChange({
            ...simulator,
            channels: simulator.channels.map((candidate) =>
              candidate.channel === channel.channel ? { ...candidate, ...changes } : candidate),
          })
          return [<fieldset key={channel.channel}>
            <legend>{name}<span>CH{channel.channel}</span></legend>
            <NumberField label={`RMS (${unit})`} min="0" step="0.001"
              value={channel.rms} onValue={(value) => update({ rms: value })} />
            <NumberField label="Phase (degrees)" min="0" max="359.999"
              step="0.001" value={wrapDegrees(channel.phase_degrees)}
              onValue={(value) => update({ phase_degrees: wrapDegrees(value) })} />
            <NumberField label={`DC offset (${unit})`} step="0.001"
              value={channel.dc} onValue={(value) => update({ dc: value })} />
            <NumberField label={`Noise RMS (${unit})`} min="0" step="0.001"
              value={channel.noise_rms}
              onValue={(value) => update({ noise_rms: value })} />
          </fieldset>]
        })}
      </div>
    </section>)}
    <SingleCycleReadout onUnauthorized={onUnauthorized} enabled={enabled} />
    <details className="simulator-explainer"><summary>Measurement-lane details</summary>
      <p>CH7 remains zero and invalid. RMS values become signed 24-bit ADC sine peaks; DC is a constant offset and noise is uniform white fluctuation. Standard ABC rotation is A=0&deg;, B=240&deg;, C=120&deg;; 0/120/240 selects reverse ACB rotation. Preserve phase keeps waveform and packet framing continuous across a reconfiguration.</p>
    </details>
  </section>
}

function SimulatorHarmonics({ simulator, simulatorSelected, sampleRateHz, onChange }: {
  simulator: AdcSimulatorConfiguration
  simulatorSelected: boolean
  sampleRateHz: number
  onChange: (configuration: AdcSimulatorConfiguration) => void
}) {
  return <section id="simulator-panel-harmonics" role="tabpanel"
    aria-labelledby="simulator-tab-harmonics"
    className="simulator-category-panel simulator-tone-section">
    <div className="simulator-form-heading">
      <div><p className="eyebrow">Spectrum injection</p><h3>Harmonics and interharmonics</h3></div>
      <span>{simulator.harmonics.length}/4 slots configured · H1 {simulator.frequency_hz.toFixed(3)} Hz</span>
    </div>
    {!simulatorSelected && <div className="simulator-staged-note">
      <strong>The physical ADC is active.</strong>
      <span>These tones are saved as a profile but cannot appear in readings until you switch to the PL simulator. Use “Save and use PL simulator” below to do both atomically.</span>
    </div>}
    <div className="simulator-tone-list">
      {simulator.harmonics.map((harmonic, index) => {
        const update = (changes: Partial<typeof harmonic>) => onChange({
          ...simulator,
          harmonics: simulator.harmonics.map((candidate, position) =>
            position === index ? { ...candidate, ...changes } : candidate),
        })
        return <SimulatorToneCard key={index} harmonic={harmonic} index={index}
          baseFrequencyHz={simulator.frequency_hz} sampleRateHz={sampleRateHz}
          channels={simulator.channels} onChange={update}
          onRemove={() => onChange({
            ...simulator,
            harmonics: simulator.harmonics.filter((_, position) => position !== index),
          })} />
      })}
    </div>
    {simulator.harmonics.length < 4 && <button className="simulator-tone-add"
      type="button" onClick={() => onChange({
        ...simulator,
        harmonics: [...simulator.harmonics,
          { order: 3, percent: 5, phase_degrees: 0, channels: 'voltage' as const }],
      })}><span>+</span><strong>Add spectral tone</strong>
        <small>Choose an integer harmonic order or an interharmonic frequency</small></button>}
    <details className="simulator-explainer"><summary>Spectral-tone details</summary>
      <p>Each tone is a percentage of its receiving lane's fundamental. Lane phase is scaled by the frequency ratio, so a balanced third harmonic is naturally zero-sequence. Integer ratios inject harmonics; fractional ratios inject interharmonics.</p>
    </details>
  </section>
}

function DeveloperPage({ onUnauthorized, health, readings, adcSource, simulator,
  sourceStatus, simulatorStatus, simulatorApplyBusy, onSourceChange, onSimulatorChange,
  onSimulatorSubmit, acquisitionAvailable = true }: {
  onUnauthorized: () => void
  health: SystemHealth | undefined
  readings: MeterReadings | undefined
  adcSource: AdcSource | undefined
  simulator: AdcSimulatorConfiguration | undefined
  sourceStatus: string
  simulatorStatus: string
  simulatorApplyBusy: boolean
  onSourceChange: (source: AdcSource['source']) => void
  onSimulatorChange: (configuration: AdcSimulatorConfiguration) => void
  onSimulatorSubmit: (activate: boolean) => void
  acquisitionAvailable?: boolean
}) {
  const [activeTab, setActiveTab] =
    useState<'overview' | 'tweak' | 'simulator' | 'recorder' | 'database' | 'waveform' | 'about' | 'logs'>('overview')
  const [simulatorCategory, setSimulatorCategory] =
    useState<SimulatorCategory>('measurement')
  const handleSimulatorTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const tabs = Array.from(event.currentTarget.parentElement
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])
    const currentIndex = tabs.indexOf(event.currentTarget)
    if (currentIndex < 0 || tabs.length === 0) return
    const nextIndex = event.key === 'Home' ? 0
      : event.key === 'End' ? tabs.length - 1
        : event.key === 'ArrowRight' ? (currentIndex + 1) % tabs.length
          : (currentIndex - 1 + tabs.length) % tabs.length
    tabs[nextIndex].focus()
    tabs[nextIndex].click()
  }
  const sampleRateHz = health?.adc.sample_rate_hz || readings?.sample_rate_hz || 128000
  const simulatorSelected = adcSource?.source === 'simulator'
  const tonesValid = simulator !== undefined && simulator.frequency_hz > 0 &&
    simulator.frequency_hz <= 1000 && simulator.harmonics.every((harmonic) => {
      const ratio = normalizeToneRatio(harmonic.order)
      return ratio > 1 && ratio < 128 && harmonic.percent >= 0 &&
        harmonic.percent <= 99.9 &&
        ratio * simulator.frequency_hz * 2 < sampleRateHz
    })
  return <section className="developer-page">
    <div className="developer-heading">
      <div><p className="eyebrow">Developer</p><h1>System diagnostics</h1>
        <p>Inspect platform temperatures and structured service events.</p></div>
    </div>
    <nav className="developer-subtabs" aria-label="Developer tools">
      <button className={activeTab === 'overview' ? 'active' : ''} type="button"
        aria-current={activeTab === 'overview' ? 'page' : undefined}
        onClick={() => setActiveTab('overview')}>Overview</button>
      <button className={activeTab === 'tweak' ? 'active' : ''} type="button"
        aria-current={activeTab === 'tweak' ? 'page' : undefined}
        onClick={() => setActiveTab('tweak')}>Tweak</button>
      <button className={activeTab === 'simulator' ? 'active' : ''} type="button"
        aria-current={activeTab === 'simulator' ? 'page' : undefined}
        onClick={() => setActiveTab('simulator')}>ADC Simulator</button>
      <button className={activeTab === 'recorder' ? 'active' : ''} type="button"
        aria-current={activeTab === 'recorder' ? 'page' : undefined}
        onClick={() => setActiveTab('recorder')}>Data recorder</button>
      <button className={activeTab === 'database' ? 'active' : ''} type="button"
        aria-current={activeTab === 'database' ? 'page' : undefined}
        onClick={() => setActiveTab('database')}>Database</button>
      <button className={activeTab === 'waveform' ? 'active' : ''} type="button"
        aria-current={activeTab === 'waveform' ? 'page' : undefined}
        onClick={() => setActiveTab('waveform')}>Waveform</button>
      <button className={activeTab === 'about' ? 'active' : ''} type="button"
        aria-current={activeTab === 'about' ? 'page' : undefined}
        onClick={() => setActiveTab('about')}>About</button>
      <button className={activeTab === 'logs' ? 'active' : ''} type="button"
        aria-current={activeTab === 'logs' ? 'page' : undefined}
        onClick={() => setActiveTab('logs')}>Logs</button>
    </nav>
    {activeTab === 'overview'
      ? <DeveloperOverview onUnauthorized={onUnauthorized} health={health} readings={readings} />
      : activeTab === 'tweak'
        ? <DeveloperTweak onUnauthorized={onUnauthorized} />
      : activeTab === 'simulator' ? <>
      <section className="section-heading configuration-heading">
        <div><p className="eyebrow">ADC input</p><h2>Raw sample simulator</h2></div>
        <span>{adcSource ? `Generation 0x${adcSource.configuration_generation.toString(16).padStart(8, '0')}` : 'Loading…'}</span>
      </section>
      <div className="simulator-source-panel">
        <label>Active source<select value={adcSource?.source ?? 'physical'}
          disabled={!acquisitionAvailable}
          onChange={(event) => onSourceChange(event.target.value as AdcSource['source'])}>
          <option value="physical">Physical AD7771</option>
          <option value="simulator">PL simulator</option>
        </select></label>
        <StatusPill ok={adcSource?.healthy ?? false}>
          {adcSource?.source === 'simulator' ? 'Simulator health' : 'Physical ADC health'}
        </StatusPill>
        <span>{sourceStatus}</span>
      </div>
      <nav className="simulator-category-tabs" role="tablist" aria-orientation="horizontal"
        aria-label="ADC simulator configuration sections">
        <button id="simulator-tab-measurement" role="tab" type="button"
          className={simulatorCategory === 'measurement' ? 'active' : ''}
          aria-selected={simulatorCategory === 'measurement'}
          aria-controls="simulator-panel-measurement"
          tabIndex={simulatorCategory === 'measurement' ? 0 : -1}
          onKeyDown={handleSimulatorTabKeyDown}
          onClick={() => setSimulatorCategory('measurement')}>
          <span>Measurement lanes</span><small>7 inputs</small></button>
        <button id="simulator-tab-harmonics" role="tab" type="button"
          className={simulatorCategory === 'harmonics' ? 'active' : ''}
          aria-selected={simulatorCategory === 'harmonics'}
          aria-controls="simulator-panel-harmonics"
          tabIndex={simulatorCategory === 'harmonics' ? 0 : -1}
          onKeyDown={handleSimulatorTabKeyDown}
          onClick={() => setSimulatorCategory('harmonics')}>
          <span>Harmonics</span><small>{simulator?.harmonics.length ?? 0}/4 slots</small></button>
        <button id="simulator-tab-power-quality" role="tab" type="button"
          className={simulatorCategory === 'power-quality' ? 'active' : ''}
          aria-selected={simulatorCategory === 'power-quality'}
          aria-controls="simulator-panel-power-quality"
          tabIndex={simulatorCategory === 'power-quality' ? 0 : -1}
          onKeyDown={handleSimulatorTabKeyDown}
          onClick={() => setSimulatorCategory('power-quality')}>
          <span>PQ Event maker</span><small>½-cycle disturbances</small></button>
      </nav>
      {simulatorCategory === 'power-quality'
        ? <section id="simulator-panel-power-quality" role="tabpanel"
            aria-labelledby="simulator-tab-power-quality"
            className="simulator-form simulator-category-panel">
            <PowerQualityPanel onUnauthorized={onUnauthorized} simulator={simulator}
              enabled={acquisitionAvailable} />
          </section>
        : simulator
          ? <form className="simulator-form" onSubmit={(event) => {
              event.preventDefault()
              onSimulatorSubmit(true)
            }}>
              <div className="simulator-summary">
                <StatusPill ok={simulatorSelected && simulator.healthy} neutral={!simulatorSelected}>
                  {simulatorSelected ? 'PL simulator active' : 'Profile staged · physical ADC active'}</StatusPill>
                <span>Generation: 0x{simulator.active_generation.toString(16).padStart(8, '0')}</span>
                <span>Frames: {formatCount(simulator.generated_frames)}</span>
                <span>Saturation: {formatCount(simulator.saturation_count)}</span>
                <span>Missed ticks: {formatCount(simulator.missed_sample_count)}</span>
                <span>{sampleRateHz.toLocaleString()} SPS</span>
              </div>
              {simulatorCategory === 'measurement'
                ? <SimulatorMeasurementLanes simulator={simulator}
                    onChange={onSimulatorChange} onUnauthorized={onUnauthorized}
                    enabled={acquisitionAvailable} />
                : <SimulatorHarmonics simulator={simulator}
                    simulatorSelected={simulatorSelected} sampleRateHz={sampleRateHz}
                    onChange={onSimulatorChange} />}
              <div className="frequency-actions simulator-actions">
                {!simulatorSelected && <button className="secondary" type="button"
                  disabled={!acquisitionAvailable || simulatorApplyBusy || !tonesValid}
                  onClick={() => onSimulatorSubmit(false)}>Save profile only</button>}
                <button type="submit"
                  disabled={!acquisitionAvailable || simulatorApplyBusy || !tonesValid}>
                  {simulatorApplyBusy ? 'Applying profile…'
                    : simulatorSelected ? 'Apply to running simulator' : 'Save and use PL simulator'}</button>
                <span>{simulatorStatus}</span>
              </div>
            </form>
          : <div className="simulator-form simulator-category-loading">Loading simulator profile…</div>}
    </>
      : activeTab === 'recorder'
        ? <DeveloperDataRecorderPage onUnauthorized={onUnauthorized} />
      : activeTab === 'database'
        ? <DeveloperDatabasePage onUnauthorized={onUnauthorized} />
      : activeTab === 'waveform'
        ? <DeveloperWaveformStatus onUnauthorized={onUnauthorized}
            enabled={acquisitionAvailable} />
      : activeTab === 'about'
        ? <DeveloperAboutPage onUnauthorized={onUnauthorized} />
        : <DeveloperLogs onUnauthorized={onUnauthorized} />}
  </section>
}

/**
 * Waveform transport diagnostics, hosted under Developer -> Waveform. The
 * manual trigger lives on the Waveforms page next to the history it
 * produces; this grid is the detail behind that page's one-line health flag.
 */
/**
 * Live single-cycle diagnostic readout (SCYC records, metrology M3/M4),
 * shown beside the simulator controls so a phase/amplitude edit and its
 * measured effect sit on one screen. Values convert from the record's
 * micro-units and picowatts to engineering units.
 */
function SingleCycleReadout({ onUnauthorized, enabled = true }: {
  onUnauthorized: () => void
  enabled?: boolean
}) {
  const [status, setStatus] = useState<SingleCycleStatus>()
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!enabled) return
    try {
      setStatus(await api.meterSingleCycle())
      setError('')
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        onUnauthorized()
        return
      }
      setError(reason instanceof Error ? reason.message : 'Unable to read single-cycle diagnostics')
    }
  }, [enabled, onUnauthorized])

  useEffect(() => {
    if (!enabled) {
      setStatus(undefined)
      setError('')
      return
    }
    let active = true
    const refresh = async () => {
      if (active) await load()
    }
    void refresh()
    const timer = window.setInterval(refresh, 1000)
    return () => { active = false; window.clearInterval(timer) }
  }, [enabled, load])

  const lanes = ['Ia', 'Ib', 'Ic', 'In', 'Vc', 'Vb', 'Va']
  const laneUnit = (index: number) => (index < 4 ? 'A' : 'V')
  const pairs = ['Vab', 'Vbc', 'Vca']
  const phases = ['PA', 'PB', 'PC']
  const snapshot = status?.has_snapshot ? status : undefined

  return <section className="simulator-readout-panel">
    <label>
      Single-cycle readout
      <span className="simulator-note">
        {status
          ? snapshot
            ? `cycle #${status.cycle_sequence} — ${status.sample_count} samples, ` +
              `${(status.frequency_millihz / 1000).toFixed(3)} Hz, status 0x${status.status.toString(16)}`
            : 'no snapshot (cycle timing unlocked or capture stopped)'
          : 'loading…'}
      </span>
    </label>
    {error && <span className="simulator-note">{error}</span>}
    {snapshot && <div className="simulator-summary">
      {snapshot.rms_micro_units.map((value, index) =>
        <span key={lanes[index]}>
          {lanes[index]}: {(value / 1e6).toFixed(3)} {laneUnit(index)}
        </span>)}
      {snapshot.vll_rms_micro_units.map((value, index) =>
        <span key={pairs[index]}>
          {pairs[index]}: {(value / 1e6).toFixed(2)} V
        </span>)}
      {snapshot.active_power_picowatts.map((value, index) =>
        <span key={phases[index]}>
          {phases[index]}: {(value / 1e12).toFixed(2)} W
        </span>)}
      {snapshot.phasor_valid
        ? snapshot.fundamental_rms_micro_units.map((value, index) =>
          <span key={`fund-${lanes[index]}`}>
            {lanes[index]} fund: {(value / 1e6).toFixed(3)} {laneUnit(index)}
          </span>)
        : <span>fundamental: invalid (no frequency reference)</span>}
    </div>}
  </section>
}

type PqDisturbancePreset =
  | 'voltage_sag'
  | 'voltage_swell'
  | 'voltage_interruption'
  | 'single_phase_sag'
  | 'current_sag'
  | 'current_swell'
  | 'custom'

const PQ_DISTURBANCE_PRESETS: Array<{
  value: PqDisturbancePreset
  label: string
  channels: string
  fallbackScale: number
  profile?: Exclude<keyof ProductSettings['metering']['events'],
    'reference_current_amperes'>
}> = [
  { value: 'voltage_sag', label: 'Voltage sag', channels: 'voltage',
    fallbackScale: 70, profile: 'voltage_sag' },
  { value: 'voltage_swell', label: 'Voltage swell', channels: 'voltage',
    fallbackScale: 120, profile: 'voltage_swell' },
  { value: 'voltage_interruption', label: 'Voltage interruption', channels: 'voltage',
    fallbackScale: 0, profile: 'voltage_interruption' },
  { value: 'single_phase_sag', label: 'Single-phase sag / unbalance', channels: 'va',
    fallbackScale: 70, profile: 'voltage_sag' },
  { value: 'current_sag', label: 'Current sag', channels: 'current',
    fallbackScale: 70, profile: 'current_sag' },
  { value: 'current_swell', label: 'Current swell', channels: 'current',
    fallbackScale: 120, profile: 'current_swell' },
  { value: 'custom', label: 'Custom amplitude burst', channels: 'voltage',
    fallbackScale: 100 },
]

function eventPresetScale(
  preset: typeof PQ_DISTURBANCE_PRESETS[number],
  settings: ProductSettings | undefined,
) {
  if (!preset.profile || !settings) return preset.fallbackScale
  const profile = settings.metering.events[preset.profile]
  if (preset.value === 'voltage_interruption') return 0
  const margin = Math.max(5, profile.hysteresis_percent)
  const scale = preset.value.endsWith('swell')
    ? profile.threshold_percent + margin
    : profile.threshold_percent - margin
  return Math.round(Math.max(0, Math.min(400, scale)) * 1000) / 1000
}

function eventTypeLabel(type: string) {
  return type === 'unknown' ? 'Unknown event' : type.split('_')
    .map((word) => word[0].toUpperCase() + word.slice(1)).join(' ')
}

function selectedEventChannels(channels: string, channel: number) {
  if (channels === 'all') return channel < 7
  if (channels === 'voltage') return channel >= 4 && channel < 7
  if (channels === 'current') return channel < 4
  return channels.split(',').includes(
    SIMULATOR_CHANNEL_NAMES[channel]?.toLowerCase())
}

/**
 * Named amplitude disturbances, live Urms(1/2), and the durable event
 * catalogue form one end-to-end PQ EventEngine test surface.
 */
export function PowerQualityPanel({ onUnauthorized, simulator, enabled = true }: {
  onUnauthorized: () => void
  simulator: AdcSimulatorConfiguration | undefined
  enabled?: boolean
}) {
  const [status, setStatus] = useState<PowerQualityStatus>()
  const [sequencer, setSequencer] = useState<AdcSimulatorEvent>()
  const [canonicalEvents, setCanonicalEvents] = useState<PowerQualityEvents>()
  const [productSettings, setProductSettings] = useState<ProductSettings>()
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [commandBusy, setCommandBusy] = useState(false)
  const [preset, setPreset] = useState<PqDisturbancePreset>('voltage_sag')
  const [channels, setChannels] = useState('voltage')
  const [scalePercent, setScalePercent] = useState(70)
  const [durationHalfCycles, setDurationHalfCycles] = useState(20)
  const [periodHalfCycles, setPeriodHalfCycles] = useState(200)
  const [repeat, setRepeat] = useState(false)

  const handle = useCallback((reason: unknown, fallback: string) => {
    if (reason instanceof ApiError && reason.status === 401) {
      onUnauthorized()
      return
    }
    setError(reason instanceof Error ? reason.message : fallback)
  }, [onUnauthorized])

  const load = useCallback(async () => {
    if (!enabled) return
    try {
      const [quality, event, events] = await Promise.all([
        api.meterPowerQuality(), api.adcSimulatorEvent(),
        api.powerQualityEvents({ limit: 5 }),
      ])
      setStatus(quality)
      setSequencer(event)
      setCanonicalEvents(events)
      setError('')
    } catch (reason) {
      handle(reason, 'Unable to read power-quality state')
    }
  }, [enabled, handle])

  useEffect(() => {
    if (!enabled) {
      setStatus(undefined)
      setSequencer(undefined)
      setCanonicalEvents(undefined)
      setError('')
      return
    }
    let active = true
    const refresh = async () => { if (active) await load() }
    void refresh()
    const timer = window.setInterval(refresh, 1000)
    return () => { active = false; window.clearInterval(timer) }
  }, [enabled, load])

  useEffect(() => {
    let active = true
    api.activeSettings().then((document) => {
      if (active) setProductSettings(document.settings)
    }).catch((reason) => {
      if (active) handle(reason, 'Unable to read active PQ Event profiles')
    })
    return () => { active = false }
  }, [handle])

  function selectPreset(value: PqDisturbancePreset) {
    setPreset(value)
    const selected = PQ_DISTURBANCE_PRESETS.find(
      (candidate) => candidate.value === value)
    if (!selected || value === 'custom') return
    setChannels(selected.channels)
    setScalePercent(eventPresetScale(selected, productSettings))
  }

  async function command(action: AdcSimulatorEventCommand['action']) {
    setMessage(action === 'arm' ? 'Arming…' : 'Sending…')
    setCommandBusy(true)
    try {
      const next = await api.commandAdcSimulatorEvent(action === 'arm'
        ? {
          action, channels, scale_percent: scalePercent,
          duration_half_cycles: durationHalfCycles,
          period_half_cycles: periodHalfCycles, repeat,
        }
        : { action })
      setSequencer(next)
      setMessage(action === 'arm'
        ? 'PQ disturbance armed — it starts at the next half-cycle boundary.'
        : 'Done.')
      setError('')
    } catch (reason) {
      setMessage('')
      handle(reason, 'Unable to drive the event sequencer')
    } finally {
      setCommandBusy(false)
    }
  }

  const latest = status?.has_latest ? status.latest : undefined
  const event = status?.has_event ? status.event : undefined
  const state = sequencer?.running ? 'running'
    : sequencer?.holding ? 'holding'
    : sequencer?.armed ? 'armed' : 'idle'
  const selectedPreset = PQ_DISTURBANCE_PRESETS.find(
    (candidate) => candidate.value === preset)!
  const selectedProfile = selectedPreset.profile && productSettings
    ? productSettings.metering.events[selectedPreset.profile] : undefined
  const expectedLevels = (simulator?.channels ?? [])
    .filter((channel) => channel.channel < 7 &&
      selectedEventChannels(channels, channel.channel))
    .map((channel) => {
      const name = SIMULATOR_CHANNEL_NAMES[channel.channel]
      const unit = channel.channel < 4 ? 'A' : 'V'
      return `${name} ${(channel.rms * scalePercent / 100).toFixed(3)} ${unit}`
    })
  const canonical = canonicalEvents?.events[0]

  return <section className="simulator-power-quality-panel">
    <div className="simulator-form-heading">
      <div><p className="eyebrow">End-to-end test</p><h3>PQ Event maker</h3></div>
      <span>The simulator changes only amplitude at a half-cycle boundary; PQ EventEngine 0x0006 classifies the resulting samples.</span>
    </div>
    <ol className="simulator-event-test-guide">
      <li><strong>Use PL simulator</strong><span>Select it above and keep the base voltage/current lanes at their nominal RMS values.</span></li>
      <li><strong>Choose a disturbance</strong><span>The preset uses the active PQ Event threshold with a safe detection margin.</span></li>
      <li><strong>Create and verify</strong><span>Watch the live Urms edge, then confirm the durable result here or under History → PQ Event catalogue.</span></li>
    </ol>
    {error && <div className="error-banner"><strong>PQ Event test unavailable</strong>
      <span>{error}</span></div>}

    <section className="simulator-event-maker" aria-labelledby="pq-event-maker-title">
      <header><div><p className="eyebrow">Disturbance generator</p>
        <h4 id="pq-event-maker-title">Create a sampled PQ event</h4></div>
        <span className={`status-pill ${sequencer?.simulator_active ? 'ok' : 'bad'}`}><i />
          {sequencer?.simulator_active ? 'PL simulator active' : 'Select PL simulator first'}
        </span></header>
      <div className="simulator-global-grid">
        <label>Disturbance preset<select value={preset}
          onChange={(event_) => selectPreset(event_.target.value as PqDisturbancePreset)}>
          {PQ_DISTURBANCE_PRESETS.map((candidate) => <option
            key={candidate.value} value={candidate.value}>{candidate.label}</option>)}
        </select></label>
        <label>Channels<select value={channels}
          onChange={(event_) => setChannels(event_.target.value)}>
          <option value="voltage">All voltages</option>
          <option value="va">Va only</option>
          <option value="vb">Vb only</option>
          <option value="vc">Vc only</option>
          <option value="va,vb">Va and Vb</option>
          <option value="current">All currents</option>
          <option value="ia">Ia only</option>
          <option value="ib">Ib only</option>
          <option value="ic">Ic only</option>
          <option value="all">All channels</option>
        </select></label>
        <NumberField label="Amplitude (% of configured RMS)" min="0" max="400" step="0.1"
          value={scalePercent} onValue={setScalePercent} />
        <NumberField label="Duration (half cycles)" min="1" max="65535" step="1"
          value={durationHalfCycles} onValue={setDurationHalfCycles} />
        <NumberField label="Repeat period (half cycles)" min="0" max="65535"
          step="1" value={periodHalfCycles} onValue={setPeriodHalfCycles} />
        <label className="simulator-checkbox">
          <input type="checkbox" checked={repeat}
            onChange={(event_) => setRepeat(event_.target.checked)} />
          Repeat until cancelled
        </label>
      </div>
      <div className="simulator-event-preview">
        <span><small>Selected profile</small><strong>{selectedPreset.label}</strong>
          <em>{selectedProfile
            ? `${selectedProfile.enabled ? 'enabled' : 'DISABLED'} · threshold ${selectedProfile.threshold_percent.toFixed(2)}% · hysteresis ${selectedProfile.hysteresis_percent.toFixed(2)}%`
            : 'Custom burst; the enabled engines decide its classification'}</em></span>
        <span><small>Expected event level</small><strong>{scalePercent.toFixed(1)}%</strong>
          <em>{expectedLevels.join(' · ') || 'Load a simulator profile to preview engineering levels'}</em></span>
        <span><small>Sequencer</small><strong>{state}</strong>
          <em>{sequencer
            ? `${formatCount(sequencer.completed)} completed` +
              (sequencer.running
                ? ` · ${sequencer.remaining_half_cycles} half cycles left` : '')
            : 'Loading state…'}</em></span>
      </div>
      {selectedProfile && !selectedProfile.enabled &&
        <p className="simulator-event-warning">This detector profile is disabled. Enable it under Meter settings → Power Quality → PQ Event profiles before running the test.</p>}
      <div className="simulator-event-actions">
        <button type="button" disabled={!enabled || commandBusy || !sequencer?.simulator_active}
          onClick={() => void command('arm')}>Create PQ event</button>
        <button type="button" disabled={!enabled || commandBusy}
          onClick={() => void command('cancel')}>Cancel event</button>
        <button type="button" disabled={!enabled || commandBusy}
          onClick={() => void command('clear')}>Clear counter</button>
        <span>{message}</span>
      </div>
    </section>

    <section className="simulator-event-observation" aria-labelledby="pq-urms-result-title">
      <header><div><p className="eyebrow">Immediate response</p>
        <h4 id="pq-urms-result-title">Live Urms(1/2) detector</h4></div>
        <span className="simulator-note">{status
          ? latest
            ? `${formatCount(status.records)} records · ${formatCount(status.events)} edge(s)` +
              (latest.armed
                ? ` · armed at ${latest.reference_volts.toFixed(1)} V`
                : ' · DISARMED (set the Urms reference in Meter settings)')
            : 'No record yet; the sliding tier may still be priming'
          : 'Loading…'}</span></header>
      {latest && <div className="simulator-summary">
        {latest.phases.map((phase) =>
          <span key={phase.phase}>U{phase.phase}: {phase.urms_half.toFixed(2)} V
            {' '}(min {phase.urms_half_minimum.toFixed(2)},
            {' '}max {phase.urms_half_maximum.toFixed(2)})</span>)}
        {latest.phases.map((phase) =>
          <span key={`i-${phase.phase}`}>I{phase.phase}: {phase.irms_half.toFixed(3)} A</span>)}
      </div>}
      {event && <div className="simulator-summary simulator-event-edge">
        <span>Last edge: {event.event_type}</span>
        <span>{event.kind === 'event_end' ? 'ended' : 'in progress'}</span>
        <span>Phases: {event.affected_phases.join(', ') || 'none'}</span>
        <span>{event.duration_ms.toFixed(1)} ms ({formatCount(event.duration_samples)} samples)</span>
        <span>Residual/peak: {event.phases
          .map((phase) => event.event_type === 'swell'
            ? phase.urms_half_maximum.toFixed(2)
            : phase.urms_half_minimum.toFixed(2)).join(' / ')} V</span>
      </div>}
    </section>

    <section className="simulator-event-observation" aria-labelledby="pq-event-engine-result-title">
      <header><div><p className="eyebrow">Durable result</p>
        <h4 id="pq-event-engine-result-title">PQ EventEngine 0x0006</h4></div>
        <span className="simulator-note">{canonicalEvents
          ? `${canonicalEvents.count.toLocaleString()} catalogued event(s)` : 'Loading…'}</span></header>
      {canonical ? <div className="simulator-summary simulator-canonical-event">
        <span><strong>{eventTypeLabel(canonical.type)}</strong></span>
        <span>Lifecycle: {canonical.lifecycle}</span>
        <span>Phases: {canonical.affected_phases.join(', ') || 'none'}</span>
        <span>Duration: {canonical.duration_ms.toFixed(1)} ms</span>
        <span>Profile generation: {canonical.profile_generation}</span>
        <span>Waveforms: {canonical.waveform_capture_uuids.length}</span>
      </div> : <p className="simulator-event-empty">No durable PQ event yet. Create a disturbance that crosses an enabled profile threshold.</p>}
    </section>
  </section>
}

function DeveloperWaveformStatus({ onUnauthorized, enabled = true }: {
  onUnauthorized: () => void
  enabled?: boolean
}) {
  const [status, setStatus] = useState<WaveformStatus>()
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!enabled) return
    try {
      setStatus(await api.waveforms())
      setError('')
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        onUnauthorized()
        return
      }
      setError(reason instanceof Error ? reason.message : 'Unable to read waveform status')
    }
  }, [enabled, onUnauthorized])

  useEffect(() => {
    if (!enabled) {
      setStatus(undefined)
      setError('')
      return
    }
    let active = true
    const refresh = async () => {
      if (active) await load()
    }
    void refresh()
    const timer = window.setInterval(refresh, 1000)
    return () => { active = false; window.clearInterval(timer) }
  }, [enabled, load])

  const retainedSeconds = status?.sample_rate_hz
    ? status.history_capacity_frames / status.sample_rate_hz
    : 0

  return <div className="waveform-configuration">
    <section className="section-heading configuration-heading">
      <div><p className="eyebrow">Waveform</p><h2>Transport diagnostics</h2></div>
      <span>Continuous 8-channel DDR history</span>
    </section>
    {error && <div className="error-banner"><strong>Waveform unavailable</strong><span>{error}</span></div>}
    <section className="waveform-status-grid">
      <article><span>Waveform DMA</span><strong>{status?.running ? 'Running' : 'Stopped'}</strong></article>
      <article><span>History</span><strong>{status ? formatBytes(status.history_capacity_frames * 32) : '—'}</strong>
        <small>{retainedSeconds ? `${retainedSeconds.toFixed(1)} seconds` : 'waiting for sample rate'}</small></article>
      <article><span>DMA blocks</span><strong>{formatCount(status?.blocks)}</strong></article>
      <article><span>Sequence gaps</span><strong>{formatCount(status?.sequence_gaps)}</strong></article>
      <article><span>Transport overruns</span><strong>{formatCount(status?.transport_overrun_blocks)}</strong>
        <small>{status ? `lapped-ring events, ${status.transport_ring_blocks}-block ring` : 'transport status unavailable'}</small></article>
      <article><span>Invalid blocks</span><strong>{formatCount(status?.invalid_blocks)}</strong>
        <small>discarded before history</small></article>
      <article><span>PL dropped frames</span><strong>{formatCount(status?.pl_dropped_frames)}</strong>
        <small>lost upstream of the DMA</small></article>
      <article><span>File write failures</span><strong>{formatCount(status?.materialization_failures)}</strong></article>
      <article><span>Active capture</span><strong>{status?.active_session ? 'Yes' : 'No'}</strong></article>
      <article><span>Completed files</span><strong>{formatCount(status?.completed_sessions)}</strong></article>
      <article><span>Archive index</span><strong>{status?.archive_discovery
        ? status.archive_discovery.state === 'complete' ? 'Complete'
          : `${formatCount(status.archive_discovery.scanned_files)} / ${formatCount(status.archive_discovery.total_files)}`
        : '—'}</strong>
        <small>{status?.archive_discovery
          ? `${formatCount(status.archive_discovery.rejected_files)} rejected`
          : 'discovery status unavailable'}</small></article>
    </section>
  </div>
}

function WaveformConfiguration() {
  return <div className="waveform-configuration">
    <section className="section-heading configuration-heading">
      <div><p className="eyebrow">Waveform</p><h2>Capture configuration</h2></div>
      <span>Continuous 8-channel DDR history</span>
    </section>
    <div className="waveform-config-placeholder">
      <strong>No configurable waveform options yet</strong>
      <span>Manual captures are triggered from the Waveforms page; transport
        diagnostics live under Developer → Waveform.</span>
    </div>
  </div>
}

export function ConfigurationPage({ configuration, configurationStatus, onChange, onSubmit,
  nominalFrequency, onNominalFrequencyChange,
  measurementTopology, onMeasurementTopologyChange,
  systemNominalVoltage, onSystemNominalVoltageChange,
  demandConfiguration, onDemandConfigurationChange,
  currentWiring, onCurrentWiringChange, currentWiringHealth,
  simulator, onSimulatorChange, onUnauthorized }: {
  configuration: FrequencyConfiguration | undefined
  configurationStatus: string
  onChange: (configuration: FrequencyConfiguration) => void
  onSubmit: (event: FormEvent) => void
  nominalFrequency: number | undefined
  onNominalFrequencyChange: (nominalFrequency: number) => void
  measurementTopology: MeasurementTopology | undefined
  onMeasurementTopologyChange: (topology: MeasurementTopology) => void
  systemNominalVoltage: number | undefined
  onSystemNominalVoltageChange: (systemNominalVoltage: number) => void
  demandConfiguration: DemandConfiguration | undefined
  onDemandConfigurationChange: (configuration: DemandConfiguration) => void
  currentWiring: CurrentWiringConfiguration | undefined
  onCurrentWiringChange: (configuration: CurrentWiringConfiguration) => void
  currentWiringHealth: SystemHealth['adc']['current_wiring'] | undefined
  simulator: AdcSimulatorConfiguration | undefined
  onSimulatorChange: (configuration: AdcSimulatorConfiguration) => void
  onUnauthorized: () => void
}) {
  const [activeTab, setActiveTab] =
    useState<'meter' | 'power-quality' | 'waveform' | 'data-logging' | 'modbus' | 'mqtt'>('meter')
  const nominalVoltageReference = measurementTopology === 'delta' ? 'L-L' : 'L-N'
  const wiring = currentWiring ?? DEFAULT_CURRENT_WIRING
  const wiringApplyFailed = currentWiringHealth !== undefined &&
    !['none', 'success'].includes(currentWiringHealth.last_apply_result)

  function selectCurrentPreset(preset: 'ABC' | 'ACB') {
    const phases: CurrentPhase[] = preset === 'ABC'
      ? ['A', 'B', 'C', 'N'] : ['A', 'C', 'B', 'N']
    const channels = structuredClone(wiring.channels)
    CURRENT_CHANNEL_KEYS.forEach((channel, index) => {
      channels[channel].phase = phases[index]
    })
    onCurrentWiringChange({ input_order: preset, channels })
  }

  function selectCurrentPhase(channel: typeof CURRENT_CHANNEL_KEYS[number], phase: CurrentPhase) {
    const channels = structuredClone(wiring.channels)
    const previousPhase = channels[channel].phase
    const swapped = CURRENT_CHANNEL_KEYS.find((candidate) =>
      candidate !== channel && channels[candidate].phase === phase)
    channels[channel].phase = phase
    if (swapped) channels[swapped].phase = previousPhase
    onCurrentWiringChange({ input_order: 'CUSTOM', channels })
  }

  function selectCurrentDirection(
    channel: typeof CURRENT_CHANNEL_KEYS[number],
    direction: CurrentWiringConfiguration['channels']['ch0']['direction'],
  ) {
    const channels = structuredClone(wiring.channels)
    channels[channel].direction = direction
    onCurrentWiringChange({ ...wiring, channels })
  }
  return <section className="configuration-page">
    <div className="developer-heading">
      <div><p className="eyebrow">Configuration</p><h1>Meter settings</h1>
        <p>Configure nominal grid identity, demand, and measurement behavior.</p></div>
    </div>
    <nav className="developer-subtabs" aria-label="Configuration sections">
      <button className={activeTab === 'meter' ? 'active' : ''} type="button"
        aria-current={activeTab === 'meter' ? 'page' : undefined}
        onClick={() => setActiveTab('meter')}>Meter</button>
      <button className={activeTab === 'waveform' ? 'active' : ''} type="button"
        aria-current={activeTab === 'waveform' ? 'page' : undefined}
        onClick={() => setActiveTab('waveform')}>Waveform</button>
      <button className={activeTab === 'power-quality' ? 'active' : ''} type="button"
        aria-current={activeTab === 'power-quality' ? 'page' : undefined}
        onClick={() => setActiveTab('power-quality')}>Power Quality</button>
      <button className={activeTab === 'data-logging' ? 'active' : ''} type="button"
        aria-current={activeTab === 'data-logging' ? 'page' : undefined}
        onClick={() => setActiveTab('data-logging')}>Data Logging</button>
      <button className={activeTab === 'modbus' ? 'active' : ''} type="button"
        aria-current={activeTab === 'modbus' ? 'page' : undefined}
        onClick={() => setActiveTab('modbus')}>Modbus</button>
      <button className={activeTab === 'mqtt' ? 'active' : ''} type="button"
        aria-current={activeTab === 'mqtt' ? 'page' : undefined}
        onClick={() => setActiveTab('mqtt')}>MQTT</button>
    </nav>
    {activeTab === 'meter' ? <>
      <section className="section-heading configuration-heading">
        <div><p className="eyebrow">Meter</p><h2>Measurement configuration</h2></div>
        <span>Grid, demand, and frequency processing</span>
      </section>
      {configuration && <form className="frequency-form meter-settings-form" onSubmit={onSubmit}>
        <section className="meter-settings-section" aria-labelledby="nominal-grid-settings-title">
          <header><div><p className="eyebrow">Grid service</p>
            <h3 id="nominal-grid-settings-title">Nominal grid configuration</h3></div>
            <span>Electrical-system identity and display reference</span></header>
          <div className="meter-settings-grid nominal-grid-settings">
            <label>Nominal grid frequency<select value={nominalFrequency ?? 60}
              onChange={(event) => onNominalFrequencyChange(Number(event.target.value))}>
              <option value={50}>50 Hz</option>
              <option value={60}>60 Hz</option>
            </select>
              <small>Basic measurement block: {(nominalFrequency ?? 60) === 50 ? 10 : 12} cycles</small></label>
            <label>Measurement connection<select value={measurementTopology ?? 'wye'}
              onChange={(event) => onMeasurementTopologyChange(
                event.target.value as MeasurementTopology)}>
              <option value="wye">Star (wye)</option>
              <option value="delta">Delta</option>
            </select>
              <small>Operator interpretation only; PL/RPU sequence calculations are unchanged</small></label>
            <label>System nominal voltage (V {nominalVoltageReference})<input type="number"
              min="1" max="1000000" step="0.001" required
              value={systemNominalVoltage ?? 120}
              onChange={(event) => onSystemNominalVoltageChange(Number(event.target.value))} />
              <small>{nominalVoltageReference} reference for diagrams; measurements are unchanged</small></label>
          </div>
        </section>

        <section className="meter-settings-section" aria-labelledby="current-wiring-settings-title">
          <header><div><p className="eyebrow">Current inputs</p>
            <h3 id="current-wiring-settings-title">ADC current-channel assignment</h3></div>
            <span>Physical CH0–CH3 route to canonical A/B/C/N lanes</span></header>
          {(currentWiringHealth && (!currentWiringHealth.match || wiringApplyFailed)) &&
            <div className="error-banner current-wiring-warning" role="alert">
              <strong>{currentWiringHealth.last_apply_result === 'rolled_back'
                ? 'The latest current-wiring change was rolled back'
                : currentWiringHealth.match
                  ? 'The latest current-wiring apply failed'
                  : 'Current wiring is not active as requested'}</strong>
              <span>Last apply: {currentWiringHealth.last_apply_result.replaceAll('_', ' ')};
                generation 0x{currentWiringHealth.generation.toString(16).padStart(8, '0')}.
                Meter results may not correspond to the selected wiring.</span>
            </div>}
          <div className="current-wiring-preset">
            <label>Current input order<select aria-label="Current input order"
              value={wiring.input_order}
              onChange={(event) => {
                const value = event.target.value
                if (value === 'ABC' || value === 'ACB') selectCurrentPreset(value)
              }}>
              <option value="ABC">ABC</option>
              <option value="ACB">ACB</option>
              <option value="CUSTOM" disabled>Custom</option>
            </select>
              <small>ABC/ACB are presets; direction remains tied to each ADC channel</small></label>
            <div className="current-wiring-state" aria-label="Current wiring status">
              <span>Requested <strong>{wiring.input_order}</strong></span>
              <span>Active <strong>{currentWiringHealth?.active.input_order ?? '—'}</strong></span>
              <StatusPill ok={currentWiringHealth?.match ?? false}
                neutral={!currentWiringHealth}>
                {!currentWiringHealth ? 'Wiring status unavailable'
                  : currentWiringHealth.match ? 'Requested wiring active' : 'Readback mismatch'}
              </StatusPill>
            </div>
          </div>
          <div className="current-wiring-grid">
            {CURRENT_CHANNEL_KEYS.map((channel, index) => {
              const active = currentWiringHealth?.active.channels[channel]
              return <div className="current-wiring-row" key={channel}>
                <label>{`ADC CH${index} connected to`}<select
                  value={wiring.channels[channel].phase}
                  onChange={(event) => selectCurrentPhase(
                    channel, event.target.value as CurrentPhase)}>
                  {(['A', 'B', 'C', 'N'] as CurrentPhase[]).map((phase) =>
                    <option key={phase} value={phase}>{`Phase ${phase}`}</option>)}
                </select></label>
                <label>{`ADC CH${index} direction`}<select
                  value={wiring.channels[channel].direction}
                  onChange={(event) => selectCurrentDirection(channel,
                    event.target.value as CurrentWiringConfiguration['channels']['ch0']['direction'])}>
                  <option value="normal">Normal</option>
                  <option value="reversed">Reversed</option>
                </select></label>
                <small>Active: {active ? `Phase ${active.phase}, ${active.direction}` : 'unavailable'}</small>
              </div>
            })}
          </div>
          {currentWiringHealth && <div className="current-wiring-diagnostics">
            <span>Last apply <strong>{currentWiringHealth.last_apply_result.replaceAll('_', ' ')}</strong></span>
            <span>Readback mismatches <strong>{formatCount(currentWiringHealth.readback_mismatch_count)}</strong></span>
            <span>Requested map <strong>0x{currentWiringHealth.requested.phase_map.toString(16).padStart(2, '0')}</strong>,
              direction mask <strong>0x{currentWiringHealth.requested.invert_mask.toString(16)}</strong></span>
            <span>Active map <strong>0x{currentWiringHealth.active.phase_map.toString(16).padStart(2, '0')}</strong>,
              direction mask <strong>0x{currentWiringHealth.active.invert_mask.toString(16)}</strong></span>
          </div>}
        </section>

        <section className="meter-settings-section" aria-labelledby="demand-settings-title">
          <header><div><p className="eyebrow">Demand</p>
            <h3 id="demand-settings-title">Active-demand configuration</h3></div>
            <span>Calculation method, window, and publication cadence</span></header>
          <div className="meter-settings-grid demand-settings-grid">
            <label>Demand calculation<select value={demandConfiguration?.method ?? 'sliding'}
              onChange={(event) => onDemandConfigurationChange({
                method: event.target.value as DemandConfiguration['method'],
                window_seconds: event.target.value === 'fixed_block'
                  ? 600 : demandConfiguration?.method === 'sliding'
                    ? demandConfiguration.window_seconds : 60,
              })}>
              <option value="sliding">Sliding window</option>
              <option value="fixed_block">Fixed UTC 10-minute block</option>
            </select>
              <small>{demandConfiguration?.method === 'fixed_block'
                ? 'Publishes when each aligned UTC 10-minute block closes'
                : 'Refreshes every 3 seconds after the selected window fills'}</small></label>
            <label>Demand averaging window<select
              disabled={demandConfiguration?.method === 'fixed_block'}
              value={demandConfiguration?.window_seconds ?? 60}
              onChange={(event) => onDemandConfigurationChange({
                method: demandConfiguration?.method ?? 'sliding',
                window_seconds: Number(event.target.value) as DemandConfiguration['window_seconds'],
              })}>
              <option value={60}>1 minute</option>
              <option value={300}>5 minutes</option>
              <option value={600}>10 minutes</option>
              <option value={900}>15 minutes</option>
              <option value={1800}>30 minutes</option>
            </select></label>
          </div>
        </section>

        <section className="meter-settings-section" aria-labelledby="zero-crossing-settings-title">
          <header><div><p className="eyebrow">Frequency</p>
            <h3 id="zero-crossing-settings-title">Zero-crossing configuration</h3></div>
            <span>Reference: CH6 VLA</span></header>
          <div className="meter-settings-grid zero-crossing-settings-grid">
            <label className="toggle"><input type="checkbox" checked={configuration.enabled}
              onChange={(event) => onChange({
                ...configuration, enabled: event.target.checked,
              })} />Enable measurement</label>
            <label>Mode<select value={configuration.mode}
              onChange={(event) => onChange({
                ...configuration,
                mode: event.target.value as FrequencyConfiguration['mode'],
              })}>
              <option value="single_cycle">Single cycle</option>
              <option value="rolling_cycles">Rolling cycles</option>
              <option value="rolling_time">Rolling time</option>
            </select></label>
            {simulator && <label>Signal frequency (Hz)<input type="number"
              min="0.001" max="1000" step="0.001" value={simulator.frequency_hz}
              onChange={(event) => onSimulatorChange({
                ...simulator, frequency_hz: Number(event.target.value),
              })} />
              <small>Drives the ADC simulator source</small></label>}
            <label>Averaging cycles<input type="number" min="1" max="64"
              value={configuration.averaging_cycles}
              onChange={(event) => onChange({
                ...configuration, averaging_cycles: Number(event.target.value),
              })} /></label>
            <label>Time window (ms)<input type="number" min="100" max="1000"
              value={configuration.averaging_window_ms}
              onChange={(event) => onChange({
                ...configuration, averaging_window_ms: Number(event.target.value),
              })} /></label>
            <label>Minimum (Hz)<input type="number" min="10" max="200" step="0.001"
              value={configuration.minimum_hz}
              onChange={(event) => onChange({
                ...configuration, minimum_hz: Number(event.target.value),
              })} /></label>
            <label>Maximum (Hz)<input type="number" min="10" max="200" step="0.001"
              value={configuration.maximum_hz}
              onChange={(event) => onChange({
                ...configuration, maximum_hz: Number(event.target.value),
              })} /></label>
            <label>Hysteresis (V)<input type="number" min="0.001" max="100" step="0.001"
              value={configuration.hysteresis_volts}
              onChange={(event) => onChange({
                ...configuration, hysteresis_volts: Number(event.target.value),
              })} /></label>
          </div>
        </section>

        <div className="frequency-actions"><button type="submit"
          disabled={configurationStatus === 'Saving…'}>Apply and save</button>
          <span>{configurationStatus}</span></div>
      </form>}</> : activeTab === 'power-quality'
      ? <PowerQualityConfiguration onUnauthorized={onUnauthorized} />
      : activeTab === 'waveform'
        ? <WaveformConfiguration />
      : activeTab === 'data-logging'
        ? <DataLoggingPage onUnauthorized={onUnauthorized} />
        : activeTab === 'modbus'
          ? <ModbusConfiguration onUnauthorized={onUnauthorized} />
          : <MqttConfiguration onUnauthorized={onUnauthorized} />}
  </section>
}

export function Dashboard({ session, onLogout, onUnauthorized }: {
  session: Session
  onLogout: () => void
  onUnauthorized: () => void
}) {
  const [activeView, setActiveView] =
    useState<'dashboard' | 'reading' | 'history' | 'waveforms' | 'management' | 'configuration' | 'about' | 'developer'>('dashboard')
  const [health, setHealth] = useState<SystemHealth>()
  const [healthFailure, setHealthFailure] = useState<Error>()
  const [readings, setReadings] = useState<MeterReadings>()
  const [history, setHistory] = useState<MeterReadings[]>([])
  const [tier, setTier] = useState<MeterTier>('basic')
  const [aggregate, setAggregate] = useState<MeterAggregate>()
  const [aggregateHistory, setAggregateHistory] = useState<MeterAggregateResult[]>([])
  // Kept separate from the shared `error`: the 200 ms readings poll clears
  // that five times a second, which would hide a persistent aggregate fault.
  const [aggregateError, setAggregateError] = useState('')
  const [tenMinute, setTenMinute] = useState<MeterTenMinute>()
  const [tenMinuteHistory, setTenMinuteHistory] = useState<MeterTenMinuteResult[]>([])
  const [tenMinuteError, setTenMinuteError] = useState('')
  const [tenMinuteLive, setTenMinuteLive] = useState<MeterTenMinute>()
  const [tenMinuteLiveHistory, setTenMinuteLiveHistory] = useState<MeterTenMinuteResult[]>([])
  const [tenMinuteLiveError, setTenMinuteLiveError] = useState('')
  const [twoHour, setTwoHour] = useState<MeterTwoHour>()
  const [twoHourHistory, setTwoHourHistory] = useState<MeterTwoHourResult[]>([])
  const [twoHourError, setTwoHourError] = useState('')
  const [twoHourLive, setTwoHourLive] = useState<MeterTwoHour>()
  const [twoHourLiveHistory, setTwoHourLiveHistory] = useState<MeterTwoHourResult[]>([])
  const [twoHourLiveError, setTwoHourLiveError] = useState('')
  const [frequencyConfiguration, setFrequencyConfiguration] =
    useState<FrequencyConfiguration>()
  const [nominalFrequency, setNominalFrequency] = useState<number>()
  const [measurementTopology, setMeasurementTopology] = useState<MeasurementTopology>()
  const [systemNominalVoltage, setSystemNominalVoltage] = useState<number>()
  const [demandConfiguration, setDemandConfiguration] =
    useState<DemandConfiguration>()
  const [currentWiring, setCurrentWiring] =
    useState<CurrentWiringConfiguration>()
  const [configurationStatus, setConfigurationStatus] = useState('')
  const [adcSource, setAdcSource] = useState<AdcSource>()
  const [simulator, setSimulator] = useState<AdcSimulatorConfiguration>()
  const [sourceStatus, setSourceStatus] = useState('')
  const [simulatorStatus, setSimulatorStatus] = useState('')
  const [simulatorApplyDialog, setSimulatorApplyDialog] =
    useState<SimulatorApplyDialogState>({ phase: 'hidden', activate: false })
  const [error, setError] = useState('')
  const readiness = classifySystemReadiness(health,
    healthFailure instanceof ApiError ? healthFailure : healthFailure
      ? { code: undefined, retryable: false } : undefined)

  const handleError = useCallback((reason: unknown) => {
    if (reason instanceof ApiError && reason.status === 401) { onUnauthorized(); return }
    setError(reason instanceof Error ? reason.message : 'Request failed')
  }, [onUnauthorized])

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const next = await api.health()
        if (active) {
          setHealth(next)
          setHealthFailure(undefined)
        }
      } catch (reason) {
        if (!active) return
        if (reason instanceof ApiError && reason.status === 401) {
          onUnauthorized()
          return
        }
        setHealth(undefined)
        setHealthFailure(reason instanceof Error
          ? reason : new Error('Unable to read system health'))
      }
    }
    void load()
    const timer = window.setInterval(load, 2000)
    return () => { active = false; window.clearInterval(timer) }
  }, [onUnauthorized])

  useEffect(() => {
    let active = true
    api.activeSettings()
      .then((activeSettings) => {
        if (active) {
          setFrequencyConfiguration(activeSettings.settings.metering.frequency)
          setNominalFrequency(activeSettings.settings.metering.nominal_frequency_hz)
          setMeasurementTopology(
            activeSettings.settings.metering.measurement_topology ?? 'wye')
          setSystemNominalVoltage(
            activeSettings.settings.metering.system_nominal_voltage_v ?? 120)
          setDemandConfiguration(activeSettings.settings.metering.demand ?? {
            method: 'sliding', window_seconds: 60,
          })
          setCurrentWiring(structuredClone(
            activeSettings.settings.metering.current_wiring ?? DEFAULT_CURRENT_WIRING))
        }
      })
      .catch((reason) => { if (active) handleError(reason) })
    return () => { active = false }
  }, [handleError])

  useEffect(() => {
    if (!readiness.acquisitionReachable) {
      setAdcSource(undefined)
      setSimulator(undefined)
      return
    }
    let active = true
    Promise.all([api.adcSource(), api.adcSimulator(), api.activeSettings()])
      .then(([source, configuration, activeSettings]) => {
        if (!active) return
        setAdcSource({ ...source, source: activeSettings.settings.adc.source })
        setSimulator({
          ...configuration,
          frequency_hz: activeSettings.settings.adc.simulator.frequency_hz,
          preserve_phase: activeSettings.settings.adc.simulator.preserve_phase,
          channels: activeSettings.settings.adc.simulator.channels,
          harmonics: activeSettings.settings.adc.simulator.harmonics,
        })
      })
      .catch((reason) => { if (active) handleError(reason) })
    return () => { active = false }
  }, [handleError, readiness.acquisitionReachable])

  // Source configuration is loaded once, while live health is refreshed every
  // two seconds. Fold the runtime fields back into the source models so the
  // simulator status cannot remain stuck at its startup/transient value.
  useEffect(() => {
    if (!health || health.adc.source === 'unknown') return

    const activeSource = health.adc.source
    setAdcSource((current) => ({
      source: current?.source ?? activeSource,
      configuration_generation: health.acquisition.configuration_generation,
      active: health.adc.capture_active,
      healthy: activeSource === 'simulator'
        ? health.adc.simulator_healthy
        : health.adc.healthy,
    }))
    setSimulator((current) => current ? {
      ...current,
      active_source: activeSource,
      configuration_generation: health.acquisition.configuration_generation,
      active_generation: health.adc.simulator_active_generation,
      generated_frames: health.adc.simulator_frame_count,
      saturation_count: health.adc.simulator_saturation_count,
      missed_sample_count: health.adc.simulator_missed_sample_count,
      healthy: health.adc.simulator_healthy,
    } : current)
  }, [health])

  async function saveFrequencyConfiguration(event: FormEvent) {
    event.preventDefault()
    if (!frequencyConfiguration) return
    setConfigurationStatus('Saving…')
    try {
      await saveSettings((settings) => {
        settings.metering.frequency = frequencyConfiguration
        // The nominal grid frequency lives beside, not inside, the
        // zero-crossing configuration but is edited by the same form.
        if (nominalFrequency !== undefined) {
          settings.metering.nominal_frequency_hz = nominalFrequency
        }
        if (measurementTopology !== undefined) {
          settings.metering.measurement_topology = measurementTopology
        }
        if (systemNominalVoltage !== undefined) {
          settings.metering.system_nominal_voltage_v = systemNominalVoltage
        }
        if (demandConfiguration !== undefined) {
          settings.metering.demand = demandConfiguration
        }
        if (currentWiring !== undefined) {
          settings.metering.current_wiring = currentWiring
        }
        // The simulator signal frequency is edited on the Meter form but
        // persists through the same adc.simulator path the simulator pane
        // uses; channels stay untouched here.
        if (simulator) {
          settings.adc.simulator.frequency_hz = simulator.frequency_hz
        }
      })
      setConfigurationStatus('Applied and saved.')
    } catch (reason) {
      setConfigurationStatus('')
      handleError(reason)
    }
  }

  async function changeAdcSource(source: AdcSource['source']) {
    setSourceStatus('Saving…')
    try {
      await saveSettings((settings) => { settings.adc.source = source })
      setAdcSource((current) => current ? { ...current, source } : current)
      setSourceStatus('Applied and saved.')
    } catch (reason) {
      setSourceStatus('')
      handleError(reason)
    }
  }

  async function saveSimulator(activate: boolean) {
    if (!simulator || simulatorApplyDialog.phase === 'applying') return
    setSimulatorStatus('Applying…')
    setSimulatorApplyDialog({ phase: 'applying', activate })
    try {
      const normalized = {
        ...simulator,
        harmonics: simulator.harmonics.map((harmonic) => ({
          ...harmonic,
          order: normalizeToneRatio(harmonic.order),
          phase_degrees: wrapDegrees(harmonic.phase_degrees),
        })),
      }
      await saveSettings((settings) => {
        if (activate) settings.adc.source = 'simulator'
        settings.adc.simulator = {
          frequency_hz: normalized.frequency_hz,
          preserve_phase: normalized.preserve_phase,
          channels: normalized.channels,
          harmonics: normalized.harmonics,
        }
      })
      setSimulator(normalized)
      if (activate) {
        setAdcSource((current) => current ? { ...current, source: 'simulator' } : current)
        setSourceStatus('PL simulator selected.')
      }
      const message = activate
        ? 'Profile applied; waiting for the next harmonic family.'
        : 'Profile saved. Physical ADC remains active.'
      setSimulatorStatus(message)
      setSimulatorApplyDialog({ phase: 'success', activate, message })
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setSimulatorApplyDialog({ phase: 'hidden', activate })
        onUnauthorized()
        return
      }
      const message = reason instanceof Error ? reason.message : 'Request failed'
      setSimulatorStatus(`Apply failed: ${message}`)
      setSimulatorApplyDialog({
        phase: 'error', activate, message,
        httpStatus: reason instanceof ApiError ? reason.status : undefined,
      })
    }
  }

  useEffect(() => {
    if (readiness.liveDataReady) return
    setReadings(undefined)
    setHistory([])
    setAggregate(undefined)
    setAggregateHistory([])
    setTenMinute(undefined)
    setTenMinuteHistory([])
    setTenMinuteLive(undefined)
    setTenMinuteLiveHistory([])
    setTwoHour(undefined)
    setTwoHourHistory([])
    setTwoHourLive(undefined)
    setTwoHourLiveHistory([])
  }, [readiness.liveDataReady])

  useEffect(() => {
    if (!readiness.liveDataReady) return
    let active = true
    let pending = false
    const load = async () => {
      if (pending) return
      pending = true
      try {
        const next = await api.meterReadings()
        if (active) {
          setReadings(next)
          setHistory((current) => current.at(-1)?.sequence === next.sequence
            ? current : [...current, next].slice(-HISTORY))
          setError('')
        }
      } catch (reason) { if (active) handleError(reason) }
      finally { pending = false }
    }
    void load()
    const timer = window.setInterval(load, 200)
    return () => { active = false; window.clearInterval(timer) }
  }, [handleError, readiness.liveDataReady])

  // The aggregate is polled only while its tier is displayed. The interval is
  // created by this effect and torn down again on tier change, view change, and
  // unmount, so no aggregate request can outlive the selection that made it.
  useEffect(() => {
    if (!readiness.liveDataReady || activeView !== 'dashboard' || tier !== 'aggregate') return
    let active = true
    let pending = false
    const load = async () => {
      if (pending) return
      pending = true
      try {
        const next = await api.meterAggregate()
        if (active) {
          setAggregate(next)
          // Aggregates arrive about every three seconds while this polls every
          // second, so extend the history only when the aggregate sequence
          // advances; otherwise the sparkline would repeat the same point.
          if (next.available) {
            setAggregateHistory((current) => {
              const previous = current.at(-1)
              // A configuration change re-scales the measurement, so a trace
              // must never span two generations.
              if (previous &&
                  previous.configuration_generation !== next.configuration_generation)
                return [next]
              return previous?.sequence === next.sequence
                ? current : [...current, next].slice(-HISTORY)
            })
          }
          setAggregateError('')
        }
      } catch (reason) {
        if (!active) return
        if (reason instanceof ApiError && reason.status === 401) {
          handleError(reason)
          return
        }
        setAggregateError(reason instanceof Error
          ? reason.message
          : 'Unable to read the aggregate')
      }
      finally { pending = false }
    }
    void load()
    const timer = window.setInterval(load, 1000)
    return () => {
      active = false
      window.clearInterval(timer)
      setAggregateHistory([])
      setAggregateError('')
    }
  }, [activeView, tier, handleError, readiness.liveDataReady])

  // The open two-hour preview advances only when a completed ten-minute block
  // is folded into the still-open two-hour accumulator. It is explicitly
  // non-normative and has a sequence space separate from completed results.
  useEffect(() => {
    if (!readiness.liveDataReady || activeView !== 'dashboard' || tier !== 'hour2Live') return
    let active = true
    let pending = false
    const load = async () => {
      if (pending) return
      pending = true
      try {
        const next = await api.meterTwoHourLive()
        if (active) {
          setTwoHourLive(next)
          if (next.available) {
            setTwoHourLiveHistory((current) => {
              const previous = current.at(-1)
              if (previous &&
                  previous.configuration_generation !== next.configuration_generation)
                return [next]
              return previous?.sequence === next.sequence
                ? current : [...current, next].slice(-HISTORY)
            })
          }
          setTwoHourLiveError('')
        }
      } catch (reason) {
        if (!active) return
        if (reason instanceof ApiError && reason.status === 401) {
          handleError(reason)
          return
        }
        setTwoHourLiveError(reason instanceof Error
          ? reason.message
          : 'Unable to read the live two-hour preview')
      } finally { pending = false }
    }
    void load()
    const timer = window.setInterval(load, 10000)
    return () => {
      active = false
      window.clearInterval(timer)
      setTwoHourLiveHistory([])
      setTwoHourLiveError('')
    }
  }, [activeView, tier, handleError, readiness.liveDataReady])

  // The M14 result is sparse (one result every two hours), but querying the
  // cached typed snapshot is cheap. Poll while selected so a newly closed
  // interval appears promptly without coupling this view to the DMA stream.
  useEffect(() => {
    if (!readiness.liveDataReady || activeView !== 'dashboard' || tier !== 'hour2') return
    let active = true
    let pending = false
    const load = async () => {
      if (pending) return
      pending = true
      try {
        const next = await api.meterTwoHour()
        if (active) {
          setTwoHour(next)
          if (next.available) {
            setTwoHourHistory((current) => {
              const previous = current.at(-1)
              if (previous &&
                  previous.configuration_generation !== next.configuration_generation)
                return [next]
              return previous?.sequence === next.sequence
                ? current : [...current, next].slice(-HISTORY)
            })
          }
          setTwoHourError('')
        }
      } catch (reason) {
        if (!active) return
        if (reason instanceof ApiError && reason.status === 401) {
          handleError(reason)
          return
        }
        setTwoHourError(reason instanceof Error
          ? reason.message
          : 'Unable to read the two-hour aggregate')
      } finally { pending = false }
    }
    void load()
    const timer = window.setInterval(load, 10000)
    return () => {
      active = false
      window.clearInterval(timer)
      setTwoHourHistory([])
      setTwoHourError('')
    }
  }, [activeView, tier, handleError, readiness.liveDataReady])

  // A ten-minute preview is finalized from the current merge-safe accumulator
  // after every completed 150/180-cycle block (roughly every three seconds).
  useEffect(() => {
    if (!readiness.liveDataReady || activeView !== 'dashboard' || tier !== 'min10Live') return
    let active = true
    let pending = false
    const load = async () => {
      if (pending) return
      pending = true
      try {
        const next = await api.meterTenMinuteLive()
        if (active) {
          setTenMinuteLive(next)
          if (next.available) {
            setTenMinuteLiveHistory((current) => {
              const previous = current.at(-1)
              if (previous &&
                  previous.configuration_generation !== next.configuration_generation)
                return [next]
              return previous?.sequence === next.sequence
                ? current : [...current, next].slice(-HISTORY)
            })
          }
          setTenMinuteLiveError('')
        }
      } catch (reason) {
        if (!active) return
        if (reason instanceof ApiError && reason.status === 401) {
          handleError(reason)
          return
        }
        setTenMinuteLiveError(reason instanceof Error
          ? reason.message
          : 'Unable to read the live ten-minute preview')
      } finally { pending = false }
    }
    void load()
    const timer = window.setInterval(load, 3000)
    return () => {
      active = false
      window.clearInterval(timer)
      setTenMinuteLiveHistory([])
      setTenMinuteLiveError('')
    }
  }, [activeView, tier, handleError, readiness.liveDataReady])

  // Ten-minute blocks are sparse, but poll often enough that a just-finalized
  // block appears promptly. Sequence de-duplication prevents repeated points
  // while the same immutable result is returned between block boundaries.
  useEffect(() => {
    if (!readiness.liveDataReady || activeView !== 'dashboard' || tier !== 'min10') return
    let active = true
    let pending = false
    const load = async () => {
      if (pending) return
      pending = true
      try {
        const next = await api.meterTenMinute()
        if (active) {
          setTenMinute(next)
          if (next.available) {
            setTenMinuteHistory((current) => {
              const previous = current.at(-1)
              if (previous &&
                  previous.configuration_generation !== next.configuration_generation)
                return [next]
              return previous?.sequence === next.sequence
                ? current : [...current, next].slice(-HISTORY)
            })
          }
          setTenMinuteError('')
        }
      } catch (reason) {
        if (!active) return
        if (reason instanceof ApiError && reason.status === 401) {
          handleError(reason)
          return
        }
        setTenMinuteError(reason instanceof Error
          ? reason.message
          : 'Unable to read the ten-minute aggregate')
      } finally { pending = false }
    }
    void load()
    const timer = window.setInterval(load, 5000)
    return () => {
      active = false
      window.clearInterval(timer)
      setTenMinuteHistory([])
      setTenMinuteError('')
    }
  }, [activeView, tier, handleError, readiness.liveDataReady])

  // Basic measurement block timing is absent while the meter still emits
  // old-format records without cycle-defined block metadata; fall back to
  // generic 10/12-cycle wording then.
  const timing = readings?.timing
  const channels = readings?.channels ?? Array.from({ length: 8 }, (_, index) => ({
    index, name: ['ILA', 'ILB', 'ILC', 'ILN', 'VLC', 'VLB', 'VLA', 'VCM'][index],
    unit: index >= 4 && index <= 6 ? 'V' : 'A', valid: false,
    mean_micro_units: 0, rms_count: 0, rms: 0,
  }))
  const displayed = displayedChannels(channels)
  const aggregateResult = aggregate?.available ? aggregate : undefined
  const aggregateDisplayed = displayedChannels(aggregateResult?.channels ?? [])
  const tenMinuteResult = tenMinute?.available ? tenMinute : undefined
  const tenMinuteDisplayed = displayedChannels(tenMinuteResult?.channels ?? [])
  const tenMinuteLiveResult = tenMinuteLive?.available ? tenMinuteLive : undefined
  const tenMinuteLiveDisplayed = displayedChannels(tenMinuteLiveResult?.channels ?? [])
  const twoHourResult = twoHour?.available ? twoHour : undefined
  const twoHourDisplayed = displayedChannels(twoHourResult?.channels ?? [])
  const twoHourLiveResult = twoHourLive?.available ? twoHourLive : undefined
  const twoHourLiveDisplayed = displayedChannels(twoHourLiveResult?.channels ?? [])
  const isTwoHourTier = tier === 'hour2' || tier === 'hour2Live'
  const isLiveTier = tier === 'min10Live' || tier === 'hour2Live'
  const longIntervalResult = tier === 'hour2' ? twoHourResult
    : tier === 'hour2Live' ? twoHourLiveResult
      : tier === 'min10Live' ? tenMinuteLiveResult : tenMinuteResult
  const longIntervalDisplayed = tier === 'hour2' ? twoHourDisplayed
    : tier === 'hour2Live' ? twoHourLiveDisplayed
      : tier === 'min10Live' ? tenMinuteLiveDisplayed : tenMinuteDisplayed
  const longIntervalHistory = tier === 'hour2' ? twoHourHistory
    : tier === 'hour2Live' ? twoHourLiveHistory
      : tier === 'min10Live' ? tenMinuteLiveHistory : tenMinuteHistory

  // A block that closed on the free-run fallback window was not cycle-defined,
  // so labelling it an N-cycle basic measurement block would misreport it.
  const basicBlockLabel = !timing
    ? 'Basic measurement block (10/12 cycles)'
    : timing.free_run_fallback || !timing.cycle_locked
      ? `Free-running window — grid reference unavailable (${timing.nominal_frequency_hz} Hz nominal)`
      : `Basic measurement block — ${timing.cycle_count} cycles (${timing.nominal_frequency_hz} Hz nominal)`
  const aggregateLabel = aggregateResult
    ? `150/180-cycle aggregate — ${aggregateResult.cycle_count} cycles (${aggregateResult.basic_block_count} × ${aggregateResult.basic_block_count > 0 ? Math.round(aggregateResult.cycle_count / aggregateResult.basic_block_count) : 0}-cycle blocks)`
    : '150/180-cycle aggregate (15 basic blocks)'
  const tenMinuteLabel = tenMinuteResult
    ? `10-minute aggregate — ${formatCount(tenMinuteResult.cycle_count)} cycles (${tenMinuteResult.nominal_frequency_hz} Hz nominal)`
    : 'Clock-aligned 10-minute aggregate'
  const twoHourLabel = twoHourResult
    ? `2-hour aggregate — ${formatCount(twoHourResult.cycle_count)} cycles (12 complete 10-minute intervals)`
    : 'Two-hour aggregate (12 complete 10-minute intervals)'
  const tenMinuteLiveLabel = tenMinuteLiveResult
    ? `10-minute live partial — ${formatCount(tenMinuteLiveResult.source_interval_count)} completed 150/180-cycle blocks`
    : '10-minute live partial (non-normative)'
  const twoHourLiveLabel = twoHourLiveResult
    ? `2-hour live partial — ${formatCount(twoHourLiveResult.source_interval_count)} completed 10-minute intervals`
    : '2-hour live partial (non-normative)'
  const heroSummary = tier === 'aggregate'
    ? aggregateResult
      ? `RMS aggregated over ${aggregateResult.cycle_count} cycles — ${aggregateResult.basic_block_count} consecutive basic measurement blocks, ~3 s nominal`
      : 'RMS aggregated over 15 consecutive basic measurement blocks (150/180 cycles, ~3 s nominal)'
    : tier === 'min10'
      ? 'RMS aggregated over the clock-aligned ten-minute interval, calculated in programmable logic'
      : tier === 'min10Live'
        ? 'Live partial view of the open clock-aligned ten-minute interval — operational and non-normative'
      : tier === 'hour2'
        ? 'RMS aggregated from 12 complete ten-minute intervals, calculated in programmable logic'
        : tier === 'hour2Live'
          ? 'Live partial view of the open two-hour interval — operational and non-normative'
      : timing
        ? `Mean-corrected RMS over the ${timing.cycle_count}-cycle basic measurement block, calculated in programmable logic`
        : 'Mean-corrected RMS over the basic measurement block (10/12 cycles), calculated in programmable logic'

  return <main className="app-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark small">M</span><div><strong>MSAP1</strong><small>Electricity meter</small></div></div>
      <div className="session"><span>{session.username}</span><em>{session.role}</em><button className="text-button" onClick={onLogout}>Sign out</button></div>
    </header>
    <nav className="primary-tabs" aria-label="Primary navigation">
      <button type="button" className={activeView === 'dashboard' ? 'active' : ''}
        aria-current={activeView === 'dashboard' ? 'page' : undefined}
        onClick={() => setActiveView('dashboard')}>Dashboard</button>
      <button type="button" className={activeView === 'reading' ? 'active' : ''}
        aria-current={activeView === 'reading' ? 'page' : undefined}
        onClick={() => setActiveView('reading')}>Reading</button>
      <button type="button" className={activeView === 'history' ? 'active' : ''}
        aria-current={activeView === 'history' ? 'page' : undefined}
        onClick={() => setActiveView('history')}>History</button>
      <button type="button" className={activeView === 'waveforms' ? 'active' : ''}
        aria-current={activeView === 'waveforms' ? 'page' : undefined}
        onClick={() => setActiveView('waveforms')}>Waveforms</button>
      {session.role === 'admin' && <button type="button"
        className={activeView === 'management' ? 'active' : ''}
        aria-current={activeView === 'management' ? 'page' : undefined}
        onClick={() => setActiveView('management')}>Management</button>}
      {session.role === 'admin' && <button type="button"
        className={activeView === 'configuration' ? 'active' : ''}
        aria-current={activeView === 'configuration' ? 'page' : undefined}
        onClick={() => setActiveView('configuration')}>Configuration</button>}
      <button type="button" className={activeView === 'about' ? 'active' : ''}
        aria-current={activeView === 'about' ? 'page' : undefined}
        onClick={() => setActiveView('about')}>About</button>
      {session.role === 'admin' && <button type="button"
        className={activeView === 'developer' ? 'active' : ''}
        aria-current={activeView === 'developer' ? 'page' : undefined}
        onClick={() => setActiveView('developer')}>Developer</button>}
    </nav>
    <SystemReadinessBanner readiness={readiness} failure={healthFailure} />
    {activeView === 'developer'
      ? <DeveloperPage onUnauthorized={onUnauthorized} health={health} readings={readings}
          adcSource={adcSource}
          simulator={simulator}
          sourceStatus={sourceStatus}
          simulatorStatus={simulatorStatus}
          simulatorApplyBusy={simulatorApplyDialog.phase === 'applying'}
          onSourceChange={changeAdcSource}
          onSimulatorChange={setSimulator}
          onSimulatorSubmit={saveSimulator}
          acquisitionAvailable={readiness.acquisitionReachable} />
      : activeView === 'about'
        ? <AboutPage onUnauthorized={onUnauthorized} />
      : activeView === 'management'
        ? <ManagementPage onUnauthorized={onUnauthorized}
            acquisitionAvailable={readiness.acquisitionReachable} />
      : activeView === 'reading'
        ? <ReadingPage readings={readings} onUnauthorized={onUnauthorized}
            systemNominalVoltage={systemNominalVoltage ?? 120}
            measurementTopology={measurementTopology ?? 'wye'}
            canReset={session.role === 'admin'} canConfigure={session.role === 'admin'}
            acquisitionAvailable={readiness.acquisitionReachable &&
              health?.acquisition.running === true} />
      : activeView === 'history'
        ? <HistoryPage onUnauthorized={onUnauthorized}
            canDelete={session.role === 'admin'} />
      : activeView === 'waveforms'
        ? <WaveformExplorer onUnauthorized={onUnauthorized}
            canDelete={session.role === 'admin'}
            acquisitionAvailable={readiness.acquisitionReachable} />
      : activeView === 'configuration'
        ? <ConfigurationPage configuration={frequencyConfiguration}
            configurationStatus={configurationStatus}
            onChange={setFrequencyConfiguration}
            onSubmit={saveFrequencyConfiguration}
            nominalFrequency={nominalFrequency}
            onNominalFrequencyChange={setNominalFrequency}
            measurementTopology={measurementTopology}
            onMeasurementTopologyChange={setMeasurementTopology}
            systemNominalVoltage={systemNominalVoltage}
            onSystemNominalVoltageChange={setSystemNominalVoltage}
            demandConfiguration={demandConfiguration}
            onDemandConfigurationChange={setDemandConfiguration}
            currentWiring={currentWiring}
            onCurrentWiringChange={setCurrentWiring}
            currentWiringHealth={health?.adc.current_wiring}
            simulator={simulator}
            onSimulatorChange={setSimulator}
            onUnauthorized={onUnauthorized} />
      : <>
    <section className="hero">
      <div><p className="eyebrow">Live metering</p><h1>Grid RMS monitor</h1>
        <p>{heroSummary}</p></div>
      <StatusPill ok={readiness.state === 'healthy'}
        neutral={readiness.state === 'initializing'}>
        {readiness.state === 'healthy' ? 'System healthy'
          : readiness.state === 'initializing' ? 'Initializing'
            : readiness.state === 'unavailable' ? 'Unavailable' : 'Needs attention'}
      </StatusPill>
    </section>
    {error && <div className="error-banner"><strong>Data unavailable</strong><span>{error}</span></div>}
    <section className="section-heading dashboard-results-heading"><div><p className="eyebrow">Meter results</p><h2>RMS readings</h2></div>
      <div className="heading-status">
        {tier === 'basic' && timing && <StatusPill ok={timing.time_quality === 'synchronized'}>
          {`Time ${timing.time_quality}`}</StatusPill>}
        <span>{tier === 'aggregate'
          ? aggregateLabel
          : tier === 'min10Live' ? tenMinuteLiveLabel
            : tier === 'min10' ? tenMinuteLabel
              : tier === 'hour2Live' ? twoHourLiveLabel
                : tier === 'hour2' ? twoHourLabel : basicBlockLabel}</span>
        <label className="tier-select">Measurement interval<select value={tier}
          onChange={(event) => setTier(event.target.value as MeterTier)}>
          <option value="basic">{TIER_LABELS.basic}</option>
          <option value="aggregate">{TIER_LABELS.aggregate}</option>
          <option value="min10Live">{TIER_LABELS.min10Live}</option>
          <option value="min10">{TIER_LABELS.min10}</option>
          <option value="hour2Live">{TIER_LABELS.hour2Live}</option>
          <option value="hour2">{TIER_LABELS.hour2}</option>
        </select></label>
      </div></section>
    {tier === 'aggregate' && aggregateError &&
      <div className="error-banner"><strong>Aggregate unavailable</strong>
        <span>{aggregateError}</span></div>}
    {tier === 'min10' && tenMinuteError &&
      <div className="error-banner"><strong>Ten-minute aggregate unavailable</strong>
        <span>{tenMinuteError}</span></div>}
    {tier === 'min10Live' && tenMinuteLiveError &&
      <div className="error-banner"><strong>Ten-minute live partial unavailable</strong>
        <span>{tenMinuteLiveError}</span></div>}
    {tier === 'hour2' && twoHourError &&
      <div className="error-banner"><strong>Two-hour aggregate unavailable</strong>
        <span>{twoHourError}</span></div>}
    {tier === 'hour2Live' && twoHourLiveError &&
      <div className="error-banner"><strong>Two-hour live partial unavailable</strong>
        <span>{twoHourLiveError}</span></div>}
    {tier === 'aggregate'
      ? aggregateResult
        ? <>
            <AggregateProvenance aggregate={aggregateResult} />
            <section className="channel-grid">
              <AggregateFrequencyCard aggregate={aggregateResult} history={aggregateHistory}
                healthy={!aggregateResult.arithmetic_error} />
              {aggregateDisplayed.map((channel) => {
                // An invalid channel is serialised as rms 0; plotting those
                // would pull the trace and the range down to zero.
                const values = aggregateHistory
                  .map((record) => record.channels[channel.index])
                  .filter((entry) => entry?.valid)
                  .map((entry) => entry!.rms)
                const minimum = values.length > 0 ? Math.min(...values).toFixed(3) : '—'
                const maximum = values.length > 0 ? Math.max(...values).toFixed(3) : '—'
                return <ReadingCard key={channel.index} channel={channel} values={values}
                  healthy={health?.healthy ?? false}
                  footer={channel.valid
                    ? <><span>min {minimum} {channel.unit}</span><span>max {maximum} {channel.unit}</span></>
                    : <><span>no aggregate value</span><span>invalid</span></>} />
              })}
            </section>
          </>
        : <AggregatePending />
      : tier === 'min10Live' || tier === 'min10' ||
          tier === 'hour2Live' || tier === 'hour2'
        ? longIntervalResult
          ? <>
              <LongIntervalProvenance aggregate={longIntervalResult}
                window={isTwoHourTier ? '2 hours' : '10 minutes'}
                composition={isTwoHourTier
                  ? '12 complete ten-minute intervals'
                  : isLiveTier ? 'completed 150/180-cycle blocks so far'
                    : 'clock aligned'} />
              <section className="channel-grid">
                <LongIntervalFrequencyCard interval={isTwoHourTier
                  ? 'two-hour' : 'ten-minute'} />
                {longIntervalDisplayed.map((channel) => {
                  const values = longIntervalHistory
                    .map((record) => record.channels[channel.index])
                    .filter((entry) => entry?.valid)
                    .map((entry) => entry!.rms)
                  const minimum = values.length > 0 ? Math.min(...values).toFixed(3) : '—'
                  const maximum = values.length > 0 ? Math.max(...values).toFixed(3) : '—'
                  return <ReadingCard key={channel.index} channel={channel} values={values}
                    healthy={!longIntervalResult.arithmetic_error}
                    footer={channel.valid
                      ? <><span>min {minimum} {channel.unit}</span><span>max {maximum} {channel.unit}</span></>
                      : <><span>no {isTwoHourTier ? 'two-hour' : 'ten-minute'} value</span><span>invalid</span></>} />
                })}
              </section>
            </>
          : <LongIntervalPending
              title={isLiveTier
                ? `Waiting for the first ${isTwoHourTier ? 'two-hour' : 'ten-minute'} live partial`
                : `Waiting for the first ${isTwoHourTier ? 'two-hour' : 'ten-minute'} aggregate`}
              detail={isLiveTier
                ? isTwoHourTier
                  ? 'A non-normative preview appears after the next complete ten-minute interval is folded into the open two-hour accumulator.'
                  : 'A non-normative preview appears after the next complete 150/180-cycle block is folded into the open ten-minute accumulator.'
                : isTwoHourTier
                  ? 'The programmable-logic result requires 12 complete, consecutive ten-minute intervals, so the first production result takes two hours.'
                  : 'The programmable-logic result closes on a clock-aligned ten-minute boundary. After acquisition starts, the first complete result can take up to ten minutes.'} />
      : <><BasicProvenance readings={readings} />
        <section className="channel-grid">
          <FrequencyCard readings={readings} history={history} healthy={health?.frequency_arithmetic_ok ?? false} />
          {displayed.map((channel) => <ReadingCard key={channel.index} channel={channel}
            values={history.map((record) => record.channels[channel.index]?.rms ?? 0)}
            healthy={health?.healthy ?? false}
            footer={channel.valid
              ? <><span>mean {channel.mean_micro_units} µ</span><span>{channel.rms_count} count</span></>
              : <><span>not implemented</span><span>invalid</span></>} />)}
        </section>
        </>}
    </>}
    <SimulatorApplyDialog state={simulatorApplyDialog}
      onClose={() => {
        if (simulatorApplyDialog.phase !== 'applying') {
          setSimulatorApplyDialog({ phase: 'hidden', activate: false })
        }
      }}
      onRetry={() => { void saveSimulator(simulatorApplyDialog.activate) }} />
  </main>
}

export default function App() {
  const [session, setSession] = useState<Session>()
  const [checking, setChecking] = useState(true)
  useEffect(() => { api.session().then(setSession).catch(() => setSession(undefined)).finally(() => setChecking(false)) }, [])
  async function logout() { try { await api.logout() } finally { setSession(undefined) } }
  if (checking) return <main className="loading"><span className="brand-mark">M</span><p>Connecting to MSAP1…</p></main>
  if (!session) return <Login onLogin={setSession} />
  return <Dashboard session={session} onLogout={logout} onUnauthorized={() => setSession(undefined)} />
}
