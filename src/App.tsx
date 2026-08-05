import { FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import {
  api, AdcSimulatorConfiguration, AdcSource, ApiError, DeveloperAbout,
  DeveloperLogEntry, FrequencyConfiguration, LogPriority,
  MeterChannel, MeterReadings, Session, SocTemperature, SocTemperatures,
  SystemAbout, SystemHealth, WaveformStatus, ProductSettings, SettingsDocument,
} from './api'
import { WaveformExplorer } from './waveform/WaveformExplorer'

const HISTORY = 80
const VISIBLE_CHANNELS = new Set([0, 1, 2, 3, 4, 5, 6])

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

function StatusPill({ ok, children }: { ok: boolean; children: string }) {
  return <span className={`status-pill ${ok ? 'ok' : 'bad'}`}><i />{children}</span>
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

function ReadingCard({ channel, history, healthy }: {
  channel: MeterChannel
  history: MeterReadings[]
  healthy: boolean
}) {
  const values = history.map((record) => record.channels[channel.index]?.rms ?? 0)
  return <article className="channel-card">
    <div className="channel-title"><span>CH{channel.index}</span><strong>{channel.name}</strong><i>{channel.unit === 'V' ? 'Voltage' : 'Current'}</i></div>
    <div className="channel-value">{channel.valid ? channel.rms.toFixed(3) : '—'}<small> {channel.unit} RMS</small></div>
    <Sparkline values={values} healthy={healthy && channel.valid} />
    <div className="range"><span>{channel.valid ? `mean ${channel.mean_micro_units} µ` : 'not implemented'}</span><span>{channel.valid ? `${channel.rms_count} count` : 'invalid'}</span></div>
  </article>
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

const LOG_COMPONENTS = [
  { value: '', label: 'All components' },
  { value: 'fpga-acquisition', label: 'FPGA acquisition' },
  { value: 'web-backend', label: 'Web backend' },
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

function DeveloperPage({ onUnauthorized, health, readings }: {
  onUnauthorized: () => void
  health: SystemHealth | undefined
  readings: MeterReadings | undefined
}) {
  const [activeTab, setActiveTab] = useState<'overview' | 'about' | 'logs'>('overview')
  return <section className="developer-page">
    <div className="developer-heading">
      <div><p className="eyebrow">Developer</p><h1>System diagnostics</h1>
        <p>Inspect platform temperatures and structured service events.</p></div>
    </div>
    <nav className="developer-subtabs" aria-label="Developer tools">
      <button className={activeTab === 'overview' ? 'active' : ''} type="button"
        aria-current={activeTab === 'overview' ? 'page' : undefined}
        onClick={() => setActiveTab('overview')}>Overview</button>
      <button className={activeTab === 'about' ? 'active' : ''} type="button"
        aria-current={activeTab === 'about' ? 'page' : undefined}
        onClick={() => setActiveTab('about')}>About</button>
      <button className={activeTab === 'logs' ? 'active' : ''} type="button"
        aria-current={activeTab === 'logs' ? 'page' : undefined}
        onClick={() => setActiveTab('logs')}>Logs</button>
    </nav>
    {activeTab === 'overview'
      ? <DeveloperOverview onUnauthorized={onUnauthorized} health={health} readings={readings} />
      : activeTab === 'about'
        ? <DeveloperAboutPage onUnauthorized={onUnauthorized} />
        : <DeveloperLogs onUnauthorized={onUnauthorized} />}
  </section>
}

function WaveformConfiguration({ onUnauthorized }: {
  onUnauthorized: () => void
}) {
  const [status, setStatus] = useState<WaveformStatus>()
  const [pretriggerMs, setPretriggerMs] = useState(10000)
  const [posttriggerMs, setPosttriggerMs] = useState(10000)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
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
  }, [onUnauthorized])

  useEffect(() => {
    let active = true
    const refresh = async () => {
      if (active) await load()
    }
    void refresh()
    const timer = window.setInterval(refresh, 1000)
    return () => { active = false; window.clearInterval(timer) }
  }, [load])

  useEffect(() => {
    let active = true
    api.activeSettings().then((activeSettings) => {
      if (!active) return
      setPretriggerMs(activeSettings.settings.waveform.default_pretrigger_ms)
      setPosttriggerMs(activeSettings.settings.waveform.default_posttrigger_ms)
    }).catch((reason) => {
      if (!active) return
      if (reason instanceof ApiError && reason.status === 401) {
        onUnauthorized()
        return
      }
      setError(reason instanceof Error ? reason.message : 'Unable to read waveform defaults')
    })
    return () => { active = false }
  }, [onUnauthorized])

  async function trigger(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setMessage('Arming capture…')
    setError('')
    try {
      const updated = await api.triggerWaveform(pretriggerMs, posttriggerMs)
      setStatus(updated)
      setMessage(updated.active_session
        ? 'Capture active; overlapping triggers will extend this session.'
        : 'Capture request accepted.')
    } catch (reason) {
      setMessage('')
      if (reason instanceof ApiError && reason.status === 401) {
        onUnauthorized()
        return
      }
      setError(reason instanceof Error ? reason.message : 'Unable to trigger waveform capture')
    } finally { setBusy(false) }
  }

  async function saveDefaults() {
    setBusy(true)
    setMessage('Saving defaults…')
    setError('')
    try {
      await saveSettings((settings) => {
        settings.waveform.default_pretrigger_ms = pretriggerMs
        settings.waveform.default_posttrigger_ms = posttriggerMs
      })
      setMessage('Defaults applied and saved.')
    } catch (reason) {
      setMessage('')
      if (reason instanceof ApiError && reason.status === 401) {
        onUnauthorized()
        return
      }
      setError(reason instanceof Error ? reason.message : 'Unable to save waveform defaults')
    } finally { setBusy(false) }
  }

  const retainedSeconds = status?.sample_rate_hz
    ? status.history_capacity_frames / status.sample_rate_hz
    : 0

  return <div className="waveform-configuration">
    <section className="section-heading configuration-heading">
      <div><p className="eyebrow">Waveform</p><h2>Pre/post-trigger capture</h2></div>
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
        <small>{status ? `${status.transport_ring_blocks} DMA-block ring` : 'transport status unavailable'}</small></article>
      <article><span>File write failures</span><strong>{formatCount(status?.materialization_failures)}</strong></article>
      <article><span>Active capture</span><strong>{status?.active_session ? 'Yes' : 'No'}</strong></article>
      <article><span>Completed files</span><strong>{formatCount(status?.completed_sessions)}</strong></article>
    </section>
    <form className="waveform-trigger-form" onSubmit={trigger}>
      <label>History before trigger (ms)<input type="number" min="0" max="120000"
        value={pretriggerMs} onChange={(event) => setPretriggerMs(Number(event.target.value))} /></label>
      <label>Capture after trigger (ms)<input type="number" min="0" max="120000"
        value={posttriggerMs} onChange={(event) => setPosttriggerMs(Number(event.target.value))} /></label>
      <div className="waveform-trigger-action">
        <button type="submit" disabled={busy || !status?.running}>
          {busy ? 'Triggering…' : 'Trigger waveform'}
        </button>
        <button className="secondary" type="button" onClick={() => void saveDefaults()}
          disabled={busy}>Apply and save</button>
        <span>{message}</span>
      </div>
    </form>
  </div>
}

function ConfigurationPage({ configuration, configurationStatus, onChange, onSubmit,
  adcSource, simulator, sourceStatus, simulatorStatus, onSourceChange,
  onSimulatorChange, onSimulatorSubmit, onUnauthorized }: {
  configuration: FrequencyConfiguration | undefined
  configurationStatus: string
  onChange: (configuration: FrequencyConfiguration) => void
  onSubmit: (event: FormEvent) => void
  adcSource: AdcSource | undefined
  simulator: AdcSimulatorConfiguration | undefined
  sourceStatus: string
  simulatorStatus: string
  onSourceChange: (source: AdcSource['source']) => void
  onSimulatorChange: (configuration: AdcSimulatorConfiguration) => void
  onSimulatorSubmit: (event: FormEvent) => void
  onUnauthorized: () => void
}) {
  const [activeTab, setActiveTab] =
    useState<'meter' | 'simulator' | 'waveform'>('meter')
  return <section className="configuration-page">
    <div className="developer-heading">
      <div><p className="eyebrow">Configuration</p><h1>Meter settings</h1>
        <p>Configure programmable-logic measurement behavior.</p></div>
    </div>
    <nav className="developer-subtabs" aria-label="Configuration sections">
      <button className={activeTab === 'meter' ? 'active' : ''} type="button"
        aria-current={activeTab === 'meter' ? 'page' : undefined}
        onClick={() => setActiveTab('meter')}>Meter</button>
      <button className={activeTab === 'waveform' ? 'active' : ''} type="button"
        aria-current={activeTab === 'waveform' ? 'page' : undefined}
        onClick={() => setActiveTab('waveform')}>Waveform</button>
      <button className={activeTab === 'simulator' ? 'active' : ''} type="button"
        aria-current={activeTab === 'simulator' ? 'page' : undefined}
        onClick={() => setActiveTab('simulator')}>ADC Simulator</button>
    </nav>
    {activeTab === 'meter' ? <>
      <section className="section-heading configuration-heading">
      <div><p className="eyebrow">Frequency</p><h2>Zero-crossing configuration</h2></div>
      <span>Reference: CH6 VLA</span>
    </section>
    {configuration && <form className="frequency-form" onSubmit={onSubmit}>
      <label className="toggle"><input type="checkbox" checked={configuration.enabled}
        onChange={(event) => onChange({ ...configuration, enabled: event.target.checked })} />Enable measurement</label>
      <label>Mode<select value={configuration.mode}
        onChange={(event) => onChange({
          ...configuration,
          mode: event.target.value as FrequencyConfiguration['mode'],
        })}>
        <option value="single_cycle">Single cycle</option>
        <option value="rolling_cycles">Rolling cycles</option>
        <option value="rolling_time">Rolling time</option>
      </select></label>
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
      <div className="frequency-actions"><button type="submit">Apply and save</button>
        <span>{configurationStatus}</span></div>
    </form>}</> : activeTab === 'simulator' ? <>
      <section className="section-heading configuration-heading">
        <div><p className="eyebrow">ADC input</p><h2>Raw sample simulator</h2></div>
        <span>{adcSource ? `Generation 0x${adcSource.configuration_generation.toString(16).padStart(8, '0')}` : 'Loading…'}</span>
      </section>
      <div className="simulator-source-panel">
        <label>Active source<select value={adcSource?.source ?? 'physical'}
          onChange={(event) => onSourceChange(event.target.value as AdcSource['source'])}>
          <option value="physical">Physical AD7771</option>
          <option value="simulator">PL simulator</option>
        </select></label>
        <StatusPill ok={adcSource?.healthy ?? false}>
          {adcSource?.source === 'simulator' ? 'Simulator health' : 'Physical ADC health'}
        </StatusPill>
        <span>{sourceStatus}</span>
      </div>
      {simulator && <form className="simulator-form" onSubmit={onSimulatorSubmit}>
        <div className="simulator-summary">
          <label>Signal frequency (Hz)<input type="number" min="0.001" max="1000" step="0.001"
            value={simulator.frequency_hz}
            onChange={(event) => onSimulatorChange({
              ...simulator, frequency_hz: Number(event.target.value),
            })} /></label>
          <span>Frames: {formatCount(simulator.generated_frames)}</span>
          <span>Saturation: {formatCount(simulator.saturation_count)}</span>
          <span>Missed ticks: {formatCount(simulator.missed_sample_count)}</span>
        </div>
        <div className="simulator-channel-grid">
          {simulator.channels.filter((channel) => channel.channel < 7).map((channel) => {
            const names = ['Ia', 'Ib', 'Ic', 'In', 'Vc', 'Vb', 'Va']
            const update = (changes: Partial<typeof channel>) => onSimulatorChange({
              ...simulator,
              channels: simulator.channels.map((candidate) =>
                candidate.channel === channel.channel ? { ...candidate, ...changes } : candidate),
            })
            return <fieldset key={channel.channel}>
              <legend>CH{channel.channel} {names[channel.channel]}</legend>
              <label>RMS ({channel.channel < 4 ? 'A' : 'V'})<input type="number" min="0" step="0.001"
                value={channel.rms} onChange={(event) => update({ rms: Number(event.target.value) })} /></label>
              <label>Phase (degrees)<input type="number" step="0.001"
                value={channel.phase_degrees}
                onChange={(event) => update({ phase_degrees: Number(event.target.value) })} /></label>
            </fieldset>
          })}
        </div>
        <p className="simulator-note">CH7 remains zero and invalid. Values are converted to signed 24-bit raw ADC peaks before they are sent to PL.</p>
        <div className="frequency-actions"><button type="submit">Apply and save</button>
          <span>{simulatorStatus}</span></div>
      </form>}
    </> : <WaveformConfiguration onUnauthorized={onUnauthorized} />}
  </section>
}

function Dashboard({ session, onLogout, onUnauthorized }: {
  session: Session
  onLogout: () => void
  onUnauthorized: () => void
}) {
  const [activeView, setActiveView] =
    useState<'dashboard' | 'waveforms' | 'configuration' | 'about' | 'developer'>('dashboard')
  const [health, setHealth] = useState<SystemHealth>()
  const [readings, setReadings] = useState<MeterReadings>()
  const [history, setHistory] = useState<MeterReadings[]>([])
  const [frequencyConfiguration, setFrequencyConfiguration] =
    useState<FrequencyConfiguration>()
  const [configurationStatus, setConfigurationStatus] = useState('')
  const [adcSource, setAdcSource] = useState<AdcSource>()
  const [simulator, setSimulator] = useState<AdcSimulatorConfiguration>()
  const [sourceStatus, setSourceStatus] = useState('')
  const [simulatorStatus, setSimulatorStatus] = useState('')
  const [error, setError] = useState('')

  const handleError = useCallback((reason: unknown) => {
    if (reason instanceof ApiError && reason.status === 401) { onUnauthorized(); return }
    setError(reason instanceof Error ? reason.message : 'Request failed')
  }, [onUnauthorized])

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const next = await api.health()
        if (active) { setHealth(next); setError('') }
      } catch (reason) { if (active) handleError(reason) }
    }
    void load()
    const timer = window.setInterval(load, 2000)
    return () => { active = false; window.clearInterval(timer) }
  }, [handleError])

  useEffect(() => {
    let active = true
    Promise.all([
      api.adcSource(), api.adcSimulator(), api.activeSettings(),
    ])
      .then(([source, configuration, activeSettings]) => {
        if (active) {
          setAdcSource({ ...source, source: activeSettings.settings.adc.source })
          setSimulator({
            ...configuration,
            frequency_hz: activeSettings.settings.adc.simulator.frequency_hz,
            channels: activeSettings.settings.adc.simulator.channels,
          })
          setFrequencyConfiguration(activeSettings.settings.metering.frequency)
        }
      })
      .catch((reason) => { if (active) handleError(reason) })
    return () => { active = false }
  }, [handleError])

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

  async function saveSimulator(event: FormEvent) {
    event.preventDefault()
    if (!simulator) return
    setSimulatorStatus('Saving…')
    try {
      await saveSettings((settings) => {
        settings.adc.simulator = {
          frequency_hz: simulator.frequency_hz,
          channels: simulator.channels,
        }
      })
      setSimulatorStatus('Applied and saved.')
    } catch (reason) {
      setSimulatorStatus('')
      handleError(reason)
    }
  }

  useEffect(() => {
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
  }, [handleError])

  const channels = readings?.channels ?? Array.from({ length: 8 }, (_, index) => ({
    index, name: ['ILA', 'ILB', 'ILC', 'ILN', 'VLC', 'VLB', 'VLA', 'VCM'][index],
    unit: index >= 4 && index <= 6 ? 'V' : 'A', valid: false,
    mean_micro_units: 0, rms_count: 0, rms: 0,
  }))
  // Preserve CH7/VCM in the API model and history for future monitoring, but
  // do not present it as a user-facing meter channel yet.
  const displayed = [
    ...channels.filter((channel) => VISIBLE_CHANNELS.has(channel.index) && channel.unit === 'V'),
    ...channels.filter((channel) => VISIBLE_CHANNELS.has(channel.index) && channel.unit === 'A'),
  ]

  return <main className="app-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark small">M</span><div><strong>MSAP1</strong><small>Electricity meter</small></div></div>
      <div className="session"><span>{session.username}</span><em>{session.role}</em><button className="text-button" onClick={onLogout}>Sign out</button></div>
    </header>
    <nav className="primary-tabs" aria-label="Primary navigation">
      <button type="button" className={activeView === 'dashboard' ? 'active' : ''}
        aria-current={activeView === 'dashboard' ? 'page' : undefined}
        onClick={() => setActiveView('dashboard')}>Dashboard</button>
      <button type="button" className={activeView === 'waveforms' ? 'active' : ''}
        aria-current={activeView === 'waveforms' ? 'page' : undefined}
        onClick={() => setActiveView('waveforms')}>Waveforms</button>
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
    {activeView === 'developer'
      ? <DeveloperPage onUnauthorized={onUnauthorized} health={health} readings={readings} />
      : activeView === 'about'
        ? <AboutPage onUnauthorized={onUnauthorized} />
      : activeView === 'waveforms'
        ? <WaveformExplorer onUnauthorized={onUnauthorized}
            canDelete={session.role === 'admin'} />
      : activeView === 'configuration'
        ? <ConfigurationPage configuration={frequencyConfiguration}
            configurationStatus={configurationStatus}
            onChange={setFrequencyConfiguration}
            onSubmit={saveFrequencyConfiguration}
            adcSource={adcSource}
            simulator={simulator}
            sourceStatus={sourceStatus}
            simulatorStatus={simulatorStatus}
            onSourceChange={changeAdcSource}
            onSimulatorChange={setSimulator}
            onSimulatorSubmit={saveSimulator}
            onUnauthorized={onUnauthorized} />
      : <>
    <section className="hero">
      <div><p className="eyebrow">Live metering</p><h1>Grid RMS monitor</h1><p>Mean-corrected 200 ms RMS calculated in programmable logic</p></div>
      <StatusPill ok={health?.healthy ?? false}>{health?.healthy ? 'System healthy' : 'Needs attention'}</StatusPill>
    </section>
    {error && <div className="error-banner"><strong>Data unavailable</strong><span>{error}</span></div>}
    <section className="section-heading dashboard-results-heading"><div><p className="eyebrow">Meter results</p><h2>RMS readings</h2></div><span>Update period: 200 ms</span></section>
    <section className="channel-grid">
      <FrequencyCard readings={readings} history={history} healthy={health?.frequency_arithmetic_ok ?? false} />
      {displayed.map((channel) => <ReadingCard key={channel.index} channel={channel} history={history} healthy={health?.healthy ?? false} />)}
    </section>
    <section className="health-panel">
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
          <StatusPill ok={(health?.acquisition.read_errors ?? 1) === 0 &&
            !(health?.acquisition.record_stale ?? true)}>Meter DMA</StatusPill>
          <StatusPill ok={!(health?.acquisition.health_probe_pending ?? true)}>
            ADC health audit
          </StatusPill>
          <StatusPill ok={health?.frequency_arithmetic_ok ?? false}>Frequency arithmetic</StatusPill>
          <StatusPill ok={health?.nginx_running ?? false}>nginx</StatusPill>
        </div>
        {(health?.adc.degraded_reasons?.length ?? 0) > 0 &&
          <ul className="health-reasons" aria-label="ADC degradation reasons">
            {health?.adc.degraded_reasons?.map((reason) =>
              <li key={reason.code}><code>{reason.code}</code>{reason.message}</li>)}
          </ul>}
      </div>
    </section>
    </>}
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
