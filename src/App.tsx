import { FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { AdcMetadata, api, ApiError, SampleFrame, Session, SystemHealth } from './api'

const HISTORY = 80

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
  const span = Math.max(1, max - min)
  const points = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * 100
      const y = 30 - ((value - min) / span) * 26
      return `${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')
  return (
    <svg className="sparkline" viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true">
      <polyline className={healthy ? 'line good' : 'line warning'} points={points} />
    </svg>
  )
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
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="login-shell">
      <section className="login-card">
        <div className="brand-mark">M</div>
        <p className="eyebrow">Monutchee instrumentation</p>
        <h1>MSAP1 Meter</h1>
        <p className="login-intro">Sign in to inspect the live AD7771 acquisition path.</p>
        <form onSubmit={submit}>
          <label>Username<input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" /></label>
          <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus /></label>
          {error && <p className="form-error">{error}</p>}
          <button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
        <p className="development-note">Development account: <code>admin / admin</code></p>
      </section>
    </main>
  )
}

function Dashboard({ session, onLogout, onUnauthorized }: {
  session: Session
  onLogout: () => void
  onUnauthorized: () => void
}) {
  const [health, setHealth] = useState<SystemHealth>()
  const [metadata, setMetadata] = useState<AdcMetadata>()
  const [history, setHistory] = useState<SampleFrame[]>([])
  const [error, setError] = useState('')
  const cursor = useRef<number>()

  const handleError = useCallback((reason: unknown) => {
    if (reason instanceof ApiError && reason.status === 401) {
      onUnauthorized()
      return
    }
    setError(reason instanceof Error ? reason.message : 'Request failed')
  }, [onUnauthorized])

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const [nextHealth, nextMetadata] = await Promise.all([api.health(), api.metadata()])
        if (active) {
          setHealth(nextHealth)
          setMetadata(nextMetadata)
          setError('')
        }
      } catch (reason) { if (active) handleError(reason) }
    }
    void load()
    const timer = window.setInterval(load, 2000)
    return () => { active = false; window.clearInterval(timer) }
  }, [handleError])

  useEffect(() => {
    let active = true
    let pending = false
    const load = async () => {
      if (pending) return
      pending = true
      try {
        const response = await api.samples(cursor.current)
        if (active) {
          cursor.current = response.next_sequence
          setHistory((current) => [...current, ...response.frames].slice(-HISTORY))
          setError('')
        }
      } catch (reason) { if (active) handleError(reason) }
      finally { pending = false }
    }
    void load()
    const timer = window.setInterval(load, 250)
    return () => { active = false; window.clearInterval(timer) }
  }, [handleError])

  const latest = history.at(-1)
  const channelHistory = (index: number) => history.map((frame) => frame.values[index])

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark small">M</span><div><strong>MSAP1</strong><small>Electricity meter</small></div></div>
        <div className="session"><span>{session.username}</span><em>{session.role}</em><button className="text-button" onClick={onLogout}>Sign out</button></div>
      </header>

      <section className="hero">
        <div><p className="eyebrow">Live acquisition</p><h1>AD7771 signal monitor</h1><p>Eight synchronized channels · signed 24-bit raw counts</p></div>
        <StatusPill ok={health?.healthy ?? false}>{health?.healthy ? 'System healthy' : 'Needs attention'}</StatusPill>
      </section>

      {error && <div className="error-banner"><strong>Data unavailable</strong><span>{error}</span></div>}

      <section className="metric-grid">
        <article className="metric"><span>Capture rate</span><strong>{formatCount(metadata?.sample_rate_hz)} <small>frame/s</small></strong></article>
        <article className="metric"><span>IIO frames</span><strong>{formatCount(health?.acquisition.frames)}</strong></article>
        <article className="metric"><span>DMA traffic</span><strong>{formatBytes(health?.acquisition.bytes)}</strong></article>
        <article className="metric"><span>Capture flags</span><strong>{metadata ? `0x${metadata.capture_flags.toString(16).padStart(8, '0')}` : '—'}</strong></article>
      </section>

      <section className="section-heading"><div><p className="eyebrow">Raw channels</p><h2>Live sample overview</h2></div><span>Display stream: 20 frame/s</span></section>
      <section className="channel-grid">
        {(metadata?.channels ?? Array.from({ length: 8 }, (_, index) => ({ index, name: `CH${index}`, unit: 'raw_count' }))).map((channel) => {
          const values = channelHistory(channel.index)
          return (
            <article className="channel-card" key={channel.index}>
              <div className="channel-title"><span>CH{channel.index}</span><strong>{channel.name}</strong><i>{channel.index < 4 ? 'Current' : 'Voltage'}</i></div>
              <div className="channel-value">{formatCount(latest?.values[channel.index])}<small> raw</small></div>
              <Sparkline values={values} healthy={health?.adc.healthy ?? false} />
              <div className="range"><span>{values.length ? formatCount(Math.min(...values)) : '—'}</span><span>{values.length ? formatCount(Math.max(...values)) : '—'}</span></div>
            </article>
          )
        })}
      </section>

      <section className="health-panel">
        <div><p className="eyebrow">Pipeline health</p><h2>Acquisition components</h2></div>
        <div className="health-list">
          <StatusPill ok={health?.adc.spi_responsive ?? false}>AD7771 SPI</StatusPill>
          <StatusPill ok={health?.adc.headers_valid ?? false}>Frame headers</StatusPill>
          <StatusPill ok={health?.adc.fifo_ok ?? false}>PL FIFO</StatusPill>
          <StatusPill ok={(health?.acquisition.read_errors ?? 1) === 0}>Linux IIO</StatusPill>
          <StatusPill ok={health?.web.nginx_running ?? false}>nginx</StatusPill>
        </div>
      </section>
    </main>
  )
}

export default function App() {
  const [session, setSession] = useState<Session>()
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    api.session().then(setSession).catch(() => setSession(undefined)).finally(() => setChecking(false))
  }, [])

  async function logout() {
    try { await api.logout() } finally { setSession(undefined) }
  }

  if (checking) return <main className="loading"><span className="brand-mark">M</span><p>Connecting to MSAP1…</p></main>
  if (!session) return <Login onLogin={setSession} />
  return <Dashboard session={session} onLogout={logout} onUnauthorized={() => setSession(undefined)} />
}
