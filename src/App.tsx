import { FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import {
  api, ApiError, DeveloperLogEntry, FrequencyConfiguration, LogPriority,
  MeterChannel, MeterReadings, Session, SystemHealth,
} from './api'

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

function DeveloperLogs({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [component, setComponent] = useState('')
  const [module, setModule] = useState('')
  const [priority, setPriority] = useState<LogPriority>('debug')
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

  return <section className="developer-page">
    <div className="developer-heading">
      <div><p className="eyebrow">Developer</p><h1>System diagnostics</h1>
        <p>Inspect structured service events from the system journal.</p></div>
      <span className={`live-state ${live ? 'active' : ''}`}><i />{live ? 'Live' : 'Paused'}</span>
    </div>
    <nav className="developer-subtabs" aria-label="Developer tools">
      <button className="active" type="button">Logs</button>
    </nav>
    <section className="log-panel">
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
  </section>
}

function Dashboard({ session, onLogout, onUnauthorized }: {
  session: Session
  onLogout: () => void
  onUnauthorized: () => void
}) {
  const [activeView, setActiveView] = useState<'meter' | 'developer'>('meter')
  const [health, setHealth] = useState<SystemHealth>()
  const [readings, setReadings] = useState<MeterReadings>()
  const [history, setHistory] = useState<MeterReadings[]>([])
  const [frequencyConfiguration, setFrequencyConfiguration] =
    useState<FrequencyConfiguration>()
  const [configurationStatus, setConfigurationStatus] = useState('')
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
    api.frequencyConfiguration()
      .then((configuration) => { if (active) setFrequencyConfiguration(configuration) })
      .catch((reason) => { if (active) handleError(reason) })
    return () => { active = false }
  }, [handleError])

  async function saveFrequencyConfiguration(event: FormEvent) {
    event.preventDefault()
    if (!frequencyConfiguration) return
    setConfigurationStatus('Applying…')
    try {
      const applied = await api.updateFrequencyConfiguration(frequencyConfiguration)
      setFrequencyConfiguration(applied)
      setConfigurationStatus('Applied and saved')
    } catch (reason) {
      setConfigurationStatus('')
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
      <button type="button" className={activeView === 'meter' ? 'active' : ''}
        aria-current={activeView === 'meter' ? 'page' : undefined}
        onClick={() => setActiveView('meter')}>Meter</button>
      {session.role === 'admin' && <button type="button"
        className={activeView === 'developer' ? 'active' : ''}
        aria-current={activeView === 'developer' ? 'page' : undefined}
        onClick={() => setActiveView('developer')}>Developer</button>}
    </nav>
    {activeView === 'developer'
      ? <DeveloperLogs onUnauthorized={onUnauthorized} />
      : <>
    <section className="hero">
      <div><p className="eyebrow">Live metering</p><h1>Grid RMS monitor</h1><p>Mean-corrected 200 ms RMS calculated in programmable logic</p></div>
      <StatusPill ok={health?.healthy ?? false}>{health?.healthy ? 'System healthy' : 'Needs attention'}</StatusPill>
    </section>
    {error && <div className="error-banner"><strong>Data unavailable</strong><span>{error}</span></div>}
    <section className="metric-grid">
      <article className="metric"><span>Sample rate</span><strong>{formatCount(readings?.sample_rate_hz)} <small>frame/s</small></strong></article>
      <article className="metric"><span>ADC DCLK</span><strong>{health?.adc.dclk_frequency_hz ? formatCount(health.adc.dclk_frequency_hz) : '—'} <small>Hz</small></strong></article>
      <article className="metric"><span>ADC DRDY</span><strong>{health?.adc.drdy_frequency_hz ? formatCount(health.adc.drdy_frequency_hz) : '—'} <small>frame/s</small></strong></article>
      <article className="metric"><span>ADC packets</span><strong>{formatCount(health?.adc.packets)}</strong></article>
      <article className="metric"><span>Meter records</span><strong>{formatCount(health?.acquisition.records)}</strong></article>
      <article className="metric"><span>DMA traffic</span><strong>{formatBytes(health?.acquisition.bytes)}</strong></article>
      <article className="metric"><span>Configuration</span><strong>{readings ? `0x${readings.configuration_generation.toString(16).padStart(8, '0')}` : '—'}</strong></article>
    </section>
    <section className="section-heading"><div><p className="eyebrow">Meter results</p><h2>RMS readings</h2></div><span>Update period: 200 ms</span></section>
    <section className="channel-grid">
      <FrequencyCard readings={readings} history={history} healthy={health?.frequency_arithmetic_ok ?? false} />
      {displayed.map((channel) => <ReadingCard key={channel.index} channel={channel} history={history} healthy={health?.healthy ?? false} />)}
    </section>
    <section className="health-panel">
      <div><p className="eyebrow">Pipeline health</p><h2>Meter components</h2></div>
      <div className="health-details">
        <div className="health-list">
          <StatusPill ok={health?.adc.spi_responsive ?? false}>AD7771 SPI</StatusPill>
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
    <section className="section-heading"><div><p className="eyebrow">Frequency</p><h2>Zero-crossing configuration</h2></div><span>Reference: CH6 VLA</span></section>
    {frequencyConfiguration && <form className="frequency-form" onSubmit={saveFrequencyConfiguration}>
      <label className="toggle"><input type="checkbox" checked={frequencyConfiguration.enabled}
        onChange={(event) => setFrequencyConfiguration({ ...frequencyConfiguration, enabled: event.target.checked })} />Enable measurement</label>
      <label>Mode<select value={frequencyConfiguration.mode}
        onChange={(event) => setFrequencyConfiguration({
          ...frequencyConfiguration,
          mode: event.target.value as FrequencyConfiguration['mode'],
        })}>
        <option value="single_cycle">Single cycle</option>
        <option value="rolling_cycles">Rolling cycles</option>
        <option value="rolling_time">Rolling time</option>
      </select></label>
      <label>Averaging cycles<input type="number" min="1" max="64"
        value={frequencyConfiguration.averaging_cycles}
        onChange={(event) => setFrequencyConfiguration({
          ...frequencyConfiguration, averaging_cycles: Number(event.target.value),
        })} /></label>
      <label>Time window (ms)<input type="number" min="100" max="1000"
        value={frequencyConfiguration.averaging_window_ms}
        onChange={(event) => setFrequencyConfiguration({
          ...frequencyConfiguration, averaging_window_ms: Number(event.target.value),
        })} /></label>
      <label>Minimum (Hz)<input type="number" min="10" max="200" step="0.001"
        value={frequencyConfiguration.minimum_hz}
        onChange={(event) => setFrequencyConfiguration({
          ...frequencyConfiguration, minimum_hz: Number(event.target.value),
        })} /></label>
      <label>Maximum (Hz)<input type="number" min="10" max="200" step="0.001"
        value={frequencyConfiguration.maximum_hz}
        onChange={(event) => setFrequencyConfiguration({
          ...frequencyConfiguration, maximum_hz: Number(event.target.value),
        })} /></label>
      <label>Hysteresis (V)<input type="number" min="0.001" max="100" step="0.001"
        value={frequencyConfiguration.hysteresis_volts}
        onChange={(event) => setFrequencyConfiguration({
          ...frequencyConfiguration, hysteresis_volts: Number(event.target.value),
        })} /></label>
      <div className="frequency-actions"><button type="submit" disabled={session.role !== 'admin'}>Apply</button><span>{session.role === 'admin' ? configurationStatus : 'Administrator access required'}</span></div>
    </form>}
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
