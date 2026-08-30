import { useCallback, useEffect, useState } from 'react'
import { api, ApiError, DatabaseStatus } from '../api'
import '../developer/database.css'

function formatBytes(bytes: number) {
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

export function DataLoggingStatusPage({ onUnauthorized }: {
  onUnauthorized: () => void
}) {
  const [status, setStatus] = useState<DatabaseStatus>()
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      setStatus(await api.developerDatabase())
      setError('')
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        onUnauthorized()
        return
      }
      setError(reason instanceof Error ? reason.message : 'Unable to read data-logging status')
    }
  }, [onUnauthorized])

  useEffect(() => {
    void load()
    const timer = window.setInterval(load, 3000)
    return () => window.clearInterval(timer)
  }, [load])

  return <section className="database-page">
    <section className="section-heading configuration-heading">
      <div><p className="eyebrow">Data logging</p><h2>Historian status</h2></div>
      <span>Read-only operational summary</span>
    </section>
    {error && <div className="error-banner"><strong>Data logging unavailable</strong>
      <span>{error}</span></div>}
    <div className="database-health-grid">
      <article><span>Meter stream</span>
        <strong>{status?.stream.healthy ? 'Healthy' : 'Unavailable'}</strong>
        <small>{status
          ? `${status.stream.record_count.toLocaleString()} records · ${formatBytes(status.stream.storage_bytes)}`
          : 'Loading…'}</small></article>
      <article><span>Historian</span>
        <strong>{status?.historian.healthy ? 'Healthy' : 'Unavailable'}</strong>
        <small>{status
          ? `${status.historian.block_count.toLocaleString()} blocks · ${formatBytes(status.historian.storage_bytes)}`
          : 'Loading…'}</small></article>
      <article><span>Historian lag</span>
        <strong>{status?.historian.lag_records.toLocaleString() ?? '—'}</strong>
        <small>stream records awaiting acknowledgement</small></article>
      <article><span>Durability</span>
        <strong>{status?.stream.durability ? 'Persistent' : 'Volatile'}</strong>
        <small>{status?.historian.power_quality_event_count.toLocaleString() ?? '—'} PQ events</small></article>
    </div>
    <div className="database-policy-notice">
      <strong>Storage controls are developer settings</strong>
      <span>Backend location, retention, and maximum-size policies are under Developer → Database. Data removal is under Management.</span>
    </div>
  </section>
}
