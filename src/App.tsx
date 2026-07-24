import { FormEvent, useCallback, useEffect, useState } from 'react'
import {
  api, ApiError, FrequencyConfiguration, MeterChannel, MeterReadings, Session,
  SystemHealth,
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

function Dashboard({ session, onLogout, onUnauthorized }: {
  session: Session
  onLogout: () => void
  onUnauthorized: () => void
}) {
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
    <section className="hero">
      <div><p className="eyebrow">Live metering</p><h1>Grid RMS monitor</h1><p>Mean-corrected 200 ms RMS calculated in programmable logic</p></div>
      <StatusPill ok={health?.healthy ?? false}>{health?.healthy ? 'System healthy' : 'Needs attention'}</StatusPill>
    </section>
    {error && <div className="error-banner"><strong>Data unavailable</strong><span>{error}</span></div>}
    <section className="metric-grid">
      <article className="metric"><span>Sample rate</span><strong>{formatCount(readings?.sample_rate_hz)} <small>frame/s</small></strong></article>
      <article className="metric"><span>ADC DCLK</span><strong>{health?.adc.dclk_frequency_hz ? formatCount(health.adc.dclk_frequency_hz) : '—'} <small>Hz</small></strong></article>
      <article className="metric"><span>ADC packets</span><strong>{formatCount(health?.adc.packets)}</strong></article>
      <article className="metric"><span>Meter records</span><strong>{formatCount(health?.acquisition.records)}</strong></article>
      <article className="metric"><span>DMA traffic</span><strong>{formatBytes(health?.acquisition.bytes)}</strong></article>
      <article className="metric"><span>Configuration</span><strong>{readings ? `0x${readings.configuration_generation.toString(16).padStart(8, '0')}` : '—'}</strong></article>
      <article className="metric"><span>Grid frequency</span><strong>{readings?.frequency.valid ? readings.frequency.hz.toFixed(3) : '—'} <small>Hz</small></strong></article>
    </section>
    <section className="section-heading"><div><p className="eyebrow">Meter results</p><h2>RMS readings</h2></div><span>Update period: 200 ms</span></section>
    <section className="channel-grid">
      {displayed.map((channel) => <ReadingCard key={channel.index} channel={channel} history={history} healthy={health?.healthy ?? false} />)}
      <FrequencyCard readings={readings} history={history} healthy={health?.frequency_arithmetic_ok ?? false} />
    </section>
    <section className="health-panel">
      <div><p className="eyebrow">Pipeline health</p><h2>Meter components</h2></div>
      <div className="health-list">
        <StatusPill ok={health?.adc.spi_responsive ?? false}>AD7771 SPI</StatusPill>
        <StatusPill ok={health?.adc.headers_valid ?? false}>Frame headers</StatusPill>
        <StatusPill ok={health?.adc.fifo_ok ?? false}>PL FIFO</StatusPill>
        <StatusPill ok={health?.adc.meter_generation_match ?? false}>PL configuration</StatusPill>
        <StatusPill ok={(health?.acquisition.read_errors ?? 1) === 0}>Meter DMA</StatusPill>
        <StatusPill ok={health?.frequency_arithmetic_ok ?? false}>Frequency arithmetic</StatusPill>
        <StatusPill ok={health?.nginx_running ?? false}>nginx</StatusPill>
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
      <label>Minimum (Hz)<input type="number" min="10" max="100" step="0.001"
        value={frequencyConfiguration.minimum_hz}
        onChange={(event) => setFrequencyConfiguration({
          ...frequencyConfiguration, minimum_hz: Number(event.target.value),
        })} /></label>
      <label>Maximum (Hz)<input type="number" min="10" max="100" step="0.001"
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
