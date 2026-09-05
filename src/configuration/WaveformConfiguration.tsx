import { type FormEvent, useEffect, useState } from 'react'
import { api, ApiError, type ProductSettings } from '../api'
import './waveformConfiguration.css'

const IDENTITY_FIELDS = [
  { key: 'station_id', label: 'Station ID' },
  { key: 'station_name', label: 'Station name' },
  { key: 'site_id', label: 'Site ID' },
  { key: 'site_name', label: 'Site name' },
  { key: 'circuit_id', label: 'Circuit ID' },
  { key: 'circuit_name', label: 'Circuit name' },
  { key: 'device_serial', label: 'Device serial' },
  { key: 'calibration_id', label: 'Calibration ID' },
] as const

export function WaveformConfiguration({ onUnauthorized }: {
  onUnauthorized: () => void
}) {
  const [settings, setSettings] = useState<ProductSettings['waveform']>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  useEffect(() => {
    let active = true
    api.activeSettings().then((result) => {
      if (active) setSettings(structuredClone(result.settings.waveform))
    }).catch((reason) => {
      if (!active) return
      if (reason instanceof ApiError && reason.status === 401) return onUnauthorized()
      setError(reason instanceof Error ? reason.message : 'Unable to load waveform settings')
    })
    return () => { active = false }
  }, [onUnauthorized])

  async function save(event: FormEvent) {
    event.preventDefault()
    if (!settings) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      // Read the latest document and modify only this form's owned fields.
      // Manual capture defaults and PQ event policies belong to other forms.
      const active = await api.activeSettings()
      const product = structuredClone(active.settings)
      for (const { key } of IDENTITY_FIELDS) product.waveform[key] = settings[key]
      product.waveform.calibration_status = settings.calibration_status
      product.waveform.archive_limit_gib = settings.archive_limit_gib
      const saved = await api.saveSettings(product)
      setSettings(structuredClone(saved.settings.waveform))
      setMessage('Applied and saved. Identity and calibration changes apply to new captures only.')
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) return onUnauthorized()
      setError(reason instanceof Error ? reason.message : 'Unable to save waveform settings')
    } finally { setBusy(false) }
  }

  return <div className="waveform-configuration">
    <section className="section-heading configuration-heading">
      <div><p className="eyebrow">Waveform</p><h2>Capture configuration</h2></div>
      <span>Manual capture controls remain on the Waveforms page.</span>
    </section>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {!settings && !error && <p>Loading waveform settings…</p>}
    {settings && <form className="waveform-settings-form" onSubmit={save}>
      <fieldset disabled={busy}>
        <legend>MNCWF identity and storage</legend>
        <p>Identity fields are optional. Leave unknown values empty; COMTRADE and PQDIF
          exports retain them as unspecified. Saved captures are never rewritten.</p>
        <label>Waveform archive limit (GiB)
          <input type="number" min="1" max="16" step="1" required
            value={settings.archive_limit_gib}
            onChange={(event) => setSettings({ ...settings,
              archive_limit_gib: Number(event.target.value),
            })} />
          <small>Oldest completed captures expire after this physical storage limit.</small>
        </label>
        <div className="waveform-identity-grid">
          {IDENTITY_FIELDS.map(({ key, label }) => <label key={key}>{label}
            <input maxLength={128} value={settings[key]}
              required={key === 'calibration_id' && settings.calibration_status !== 'unknown'}
              onChange={(event) => setSettings({ ...settings, [key]: event.target.value })} />
          </label>)}
          <label>Calibration status
            <select value={settings.calibration_status}
              onChange={(event) => setSettings({ ...settings,
                calibration_status: event.target.value as ProductSettings['waveform']['calibration_status'],
              })}>
              <option value="unknown">Unknown</option><option value="valid">Valid</option>
              <option value="expired">Expired</option><option value="invalid">Invalid</option>
            </select>
          </label>
        </div>
        <p>Leave calibration Unknown unless verified. A known status requires a calibration ID.
          Unknown calibration does not prevent export or imply calibrated measurements.</p>
      </fieldset>
      <div className="waveform-settings-actions">
        <button type="submit" disabled={busy}>{busy ? 'Applying…' : 'Apply and save'}</button>
        <span role="status">{message}</span>
      </div>
    </form>}
  </div>
}
