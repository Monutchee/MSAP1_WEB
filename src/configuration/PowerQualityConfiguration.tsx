import { FormEvent, useEffect, useState } from 'react'
import {
  api, ApiError, EventProfileSettings, FlickerSettings, MainsSignallingSettings,
  PowerQualityEventSettings, ProductSettings,
} from '../api'
import './powerQuality.css'

type EventProfileKey = Exclude<keyof PowerQualityEventSettings, 'reference_current_amperes'>
type WaveformIdentity = Pick<ProductSettings['waveform'],
  | 'station_id' | 'station_name' | 'site_id' | 'site_name'
  | 'circuit_id' | 'circuit_name' | 'device_serial'
  | 'calibration_id' | 'calibration_status'>

interface PowerQualityDraft {
  events: PowerQualityEventSettings
  flicker: FlickerSettings
  mains: MainsSignallingSettings
  waveform: WaveformIdentity
}

const EVENT_PROFILES: Array<{ key: EventProfileKey; label: string; classification: string }> = [
  { key: 'voltage_sag', label: 'Voltage sag', classification: 'IEC 61000-4-30' },
  { key: 'voltage_swell', label: 'Voltage swell', classification: 'IEC 61000-4-30' },
  { key: 'voltage_interruption', label: 'Voltage interruption', classification: 'IEC 61000-4-30' },
  { key: 'rapid_voltage_change', label: 'Rapid voltage change', classification: 'IEC 61000-4-30' },
  { key: 'voltage_unbalance', label: 'Voltage unbalance', classification: 'Product alarm' },
  { key: 'current_sag', label: 'Current sag', classification: 'Product alarm' },
  { key: 'current_swell', label: 'Current swell', classification: 'Product alarm' },
  { key: 'current_unbalance', label: 'Current unbalance', classification: 'Product alarm' },
  { key: 'transient_voltage', label: 'Transient voltage', classification: 'Unavailable' },
]

const IDENTITY_FIELDS: Array<{ key: Exclude<keyof WaveformIdentity, 'calibration_status'>; label: string }> = [
  { key: 'station_id', label: 'Station ID' },
  { key: 'station_name', label: 'Station name' },
  { key: 'site_id', label: 'Site ID' },
  { key: 'site_name', label: 'Site name' },
  { key: 'circuit_id', label: 'Circuit ID' },
  { key: 'circuit_name', label: 'Circuit name' },
  { key: 'device_serial', label: 'Device serial' },
  { key: 'calibration_id', label: 'Calibration ID' },
]

function identity(settings: ProductSettings): WaveformIdentity {
  return {
    station_id: settings.waveform.station_id,
    station_name: settings.waveform.station_name,
    site_id: settings.waveform.site_id,
    site_name: settings.waveform.site_name,
    circuit_id: settings.waveform.circuit_id,
    circuit_name: settings.waveform.circuit_name,
    device_serial: settings.waveform.device_serial,
    calibration_id: settings.waveform.calibration_id,
    calibration_status: settings.waveform.calibration_status,
  }
}

function draft(settings: ProductSettings): PowerQualityDraft {
  return {
    events: structuredClone(settings.metering.events),
    flicker: structuredClone(settings.metering.flicker),
    mains: structuredClone(settings.metering.mains_signalling),
    waveform: identity(settings),
  }
}

function PhaseMask({ value, onChange, label }: {
  value: number
  onChange: (value: number) => void
  label: string
}) {
  return <fieldset className="power-quality-phase-mask">
    <legend>{label}</legend>
    {['A', 'B', 'C'].map((phase, index) => {
      const bit = 1 << index
      const checked = (value & bit) !== 0
      return <label key={phase}><input type="checkbox" checked={checked}
        disabled={checked && (value & 0x7) === bit}
        onChange={(event) => onChange(event.target.checked ? value | bit : value & ~bit)} />
        Phase {phase}</label>
    })}
  </fieldset>
}

function EventProfile({ profileKey, label, classification, profile, onChange }: {
  profileKey: EventProfileKey
  label: string
  classification: string
  profile: EventProfileSettings
  onChange: (profile: EventProfileSettings) => void
}) {
  const unavailable = profileKey === 'transient_voltage'
  return <article className={`power-quality-profile${unavailable ? ' unavailable' : ''}`}>
    <header><div><strong>{label}</strong><span>{classification}</span></div>
      <label className="toggle"><input type="checkbox" checked={profile.enabled}
        disabled={unavailable}
        onChange={(event) => onChange({ ...profile, enabled: event.target.checked })} />Enabled</label>
    </header>
    {unavailable && <p>Detection remains disabled until the analogue frontend is characterized.</p>}
    <div className="power-quality-profile-fields">
      <label>Threshold (%)<input type="number" min="0.01" max="655.35" step="0.01"
        value={profile.threshold_percent}
        onChange={(event) => onChange({ ...profile, threshold_percent: Number(event.target.value) })} /></label>
      <label>Hysteresis (%)<input type="number" min="0" max="655.34" step="0.01"
        value={profile.hysteresis_percent}
        onChange={(event) => onChange({ ...profile, hysteresis_percent: Number(event.target.value) })} /></label>
      <label>Phase policy<select value={profile.phase_policy}
        onChange={(event) => onChange({ ...profile,
          phase_policy: event.target.value as EventProfileSettings['phase_policy'],
        })}><option value="per_phase">Per phase</option>
          <option value="polyphase">Polyphase</option></select></label>
      <PhaseMask label="Affected phases" value={profile.phase_mask}
        onChange={(phase_mask) => onChange({ ...profile, phase_mask })} />
    </div>
    <fieldset className="power-quality-capture-policy">
      <legend>Event waveform</legend>
      <label className="toggle"><input type="checkbox" checked={profile.waveform.enabled}
        onChange={(event) => onChange({ ...profile, waveform: {
          ...profile.waveform, enabled: event.target.checked,
        } })} />Capture MNCWF evidence</label>
      <label>Pre-trigger (ms)<input type="number" min="0" max="120000"
        value={profile.waveform.pretrigger_ms}
        onChange={(event) => onChange({ ...profile, waveform: {
          ...profile.waveform, pretrigger_ms: Number(event.target.value),
        } })} /></label>
      <label>Post-trigger (ms)<input type="number" min="0" max="120000"
        value={profile.waveform.posttrigger_ms}
        onChange={(event) => onChange({ ...profile, waveform: {
          ...profile.waveform, posttrigger_ms: Number(event.target.value),
        } })} /></label>
      <label>Decimation<select value={profile.waveform.decimation}
        onChange={(event) => onChange({ ...profile, waveform: {
          ...profile.waveform,
          decimation: Number(event.target.value) as EventProfileSettings['waveform']['decimation'],
        } })}>{[1, 2, 4, 8, 16, 32].map((value) =>
          <option key={value} value={value}>÷ {value}</option>)}</select></label>
    </fieldset>
  </article>
}

export function PowerQualityConfiguration({ onUnauthorized }: {
  onUnauthorized: () => void
}) {
  const [settings, setSettings] = useState<PowerQualityDraft>()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    api.activeSettings().then((document) => {
      if (active) setSettings(draft(document.settings))
    }).catch((reason) => {
      if (!active) return
      if (reason instanceof ApiError && reason.status === 401) return onUnauthorized()
      setError(reason instanceof Error ? reason.message : 'Unable to read power-quality settings')
    })
    return () => { active = false }
  }, [onUnauthorized])

  function updateProfile(key: EventProfileKey, profile: EventProfileSettings) {
    setSettings((current) => current ? {
      ...current, events: { ...current.events, [key]: profile },
    } : current)
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    if (!settings) return
    setBusy(true)
    setError('')
    setMessage('Applying power-quality settings…')
    try {
      const active = await api.activeSettings()
      const product = structuredClone(active.settings)
      product.metering.events = structuredClone(settings.events)
      product.metering.flicker = structuredClone(settings.flicker)
      product.metering.mains_signalling = structuredClone(settings.mains)
      Object.assign(product.waveform, structuredClone(settings.waveform))
      const saved = await api.saveSettings(product)
      setSettings(draft(saved.settings))
      setMessage('Applied and saved. New records will carry the updated profile generation.')
    } catch (reason) {
      setMessage('')
      if (reason instanceof ApiError && reason.status === 401) return onUnauthorized()
      setError(reason instanceof Error ? reason.message : 'Unable to save power-quality settings')
    } finally {
      setBusy(false)
    }
  }

  return <div className="power-quality-configuration">
    <section className="section-heading configuration-heading">
      <div><p className="eyebrow">Metrology</p><h2>Power-quality configuration</h2></div>
      <span>Events, flicker, signalling, and evidence identity</span>
    </section>
    {error && <div className="error-banner"><strong>Power-quality settings unavailable</strong>
      <span>{error}</span></div>}
    {!settings && !error && <div className="database-progress">Loading power-quality settings…</div>}
    {settings && <form className="power-quality-form" onSubmit={save}>
      <fieldset className="power-quality-settings-group">
        <legend>Flicker</legend>
        <div className="power-quality-settings-fields">
          <label className="toggle"><input type="checkbox" checked={settings.flicker.enabled}
            onChange={(event) => setSettings({ ...settings, flicker: {
              ...settings.flicker, enabled: event.target.checked,
            } })} />Enable IEC flicker processing</label>
          <label>Lamp model<select value={settings.flicker.lamp_voltage}
            onChange={(event) => setSettings({ ...settings, flicker: {
              ...settings.flicker, lamp_voltage: Number(event.target.value) as 120 | 230,
            } })}><option value={120}>120 V</option><option value={230}>230 V</option></select></label>
          <PhaseMask label="Measured phases" value={settings.flicker.phase_mask}
            onChange={(phase_mask) => setSettings({ ...settings, flicker: {
              ...settings.flicker, phase_mask,
            } })} />
        </div>
        <p>Fixed product cadence: 1-second live Pinst, 10-minute Pst, and Plt over 12 Pst values.</p>
      </fieldset>

      <fieldset className="power-quality-settings-group">
        <legend>Mains signalling</legend>
        <div className="power-quality-settings-fields">
          <label className="toggle"><input type="checkbox" checked={settings.mains.enabled}
            onChange={(event) => setSettings({ ...settings, mains: {
              ...settings.mains, enabled: event.target.checked,
            } })} />Enable carrier detection</label>
          <label>Carrier frequency (Hz)<input type="number" min="0.001" max="12499"
            step="0.001" value={settings.mains.carrier_frequency_hz}
            onChange={(event) => setSettings({ ...settings, mains: {
              ...settings.mains, carrier_frequency_hz: Number(event.target.value),
            } })} /></label>
          <label>Bandwidth (Hz)<input type="number" min="0.004" max="12499"
            step="0.001" value={settings.mains.bandwidth_hz}
            onChange={(event) => setSettings({ ...settings, mains: {
              ...settings.mains, bandwidth_hz: Number(event.target.value),
            } })} /></label>
          <label>Detection threshold (%)<input type="number" min="0" max="655.35"
            step="0.01" value={settings.mains.threshold_percent}
            onChange={(event) => setSettings({ ...settings, mains: {
              ...settings.mains, threshold_percent: Number(event.target.value),
            } })} /></label>
          <PhaseMask label="Measured phases" value={settings.mains.phase_mask}
            onChange={(phase_mask) => setSettings({ ...settings, mains: {
              ...settings.mains, phase_mask,
            } })} />
        </div>
        <p>Each carrier magnitude uses the fixed 200 ms observation window and persisted voltage reference.</p>
      </fieldset>

      <fieldset className="power-quality-settings-group">
        <legend>Event profiles</legend>
        <label className="power-quality-current-reference">Current reference (A)
          <input type="number" min="0" max="4294.967295" step="0.000001"
            value={settings.events.reference_current_amperes}
            onChange={(event) => setSettings({ ...settings, events: {
              ...settings.events, reference_current_amperes: Number(event.target.value),
            } })} />
          <small>A zero reference keeps current-relative alarms disarmed.</small></label>
        <div className="power-quality-profile-list">
          {EVENT_PROFILES.map(({ key, label, classification }) => <EventProfile key={key}
            profileKey={key} label={label} classification={classification}
            profile={settings.events[key]}
            onChange={(profile) => updateProfile(key, profile)} />)}
        </div>
      </fieldset>

      <fieldset className="power-quality-settings-group">
        <legend>MNCWF identity</legend>
        <p>Neutral capture-time metadata retained for later COMTRADE and PQDIF conversion.</p>
        <div className="power-quality-identity-grid">
          {IDENTITY_FIELDS.map(({ key, label }) => <label key={key}>{label}
            <input maxLength={128} value={settings.waveform[key]}
              onChange={(event) => setSettings({ ...settings, waveform: {
                ...settings.waveform, [key]: event.target.value,
              } })} /></label>)}
          <label>Calibration status<select value={settings.waveform.calibration_status}
            onChange={(event) => setSettings({ ...settings, waveform: {
              ...settings.waveform,
              calibration_status: event.target.value as WaveformIdentity['calibration_status'],
            } })}><option value="unknown">Unknown</option><option value="valid">Valid</option>
              <option value="expired">Expired</option><option value="invalid">Invalid</option></select></label>
        </div>
      </fieldset>

      <div className="power-quality-actions"><button type="submit" disabled={busy}>
        {busy ? 'Applying…' : 'Apply and save'}</button><span>{message}</span></div>
    </form>}
  </div>
}
