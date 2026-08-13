import { FormEvent, useEffect, useState } from 'react'
import {
  api, ApiError, ModbusRtuPortSettings, ModbusSettings, ProductSettings,
} from '../api'
import './modbus.css'

const DEFAULT_RTU_PORT: ModbusRtuPortSettings = {
  enabled: true,
  device: '/dev/ttyPS1',
  baud_rate: 115200,
  parity: 'even',
  data_bits: 8,
  stop_bits: 1,
  unit_id: 1,
}

/**
 * Edits ProductSettings.modbus through the central settings authority.
 *
 * The form deliberately reads the complete active document again immediately
 * before saving. This prevents a long-open Modbus page from overwriting a
 * newer meter, ADC, waveform, or database setting with a stale copy.
 */
export function ModbusConfiguration({ onUnauthorized }: {
  onUnauthorized: () => void
}) {
  const [settings, setSettings] = useState<ModbusSettings>()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    api.activeSettings().then((document) => {
      if (active) setSettings(document.settings.modbus)
    }).catch((reason) => {
      if (!active) return
      if (reason instanceof ApiError && reason.status === 401)
        return onUnauthorized()
      setError(reason instanceof Error
        ? reason.message : 'Unable to read Modbus settings')
    })
    return () => { active = false }
  }, [onUnauthorized])

  function updateRtu(index: number, update: Partial<ModbusRtuPortSettings>) {
    setSettings((current) => {
      if (!current) return current
      return {
        ...current,
        rtu: current.rtu.map((port, item) =>
          item === index ? { ...port, ...update } : port),
      }
    })
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    if (!settings) return
    setBusy(true)
    setMessage('Applying settings…')
    setError('')
    try {
      const active = await api.activeSettings()
      const document: ProductSettings = structuredClone(active.settings)
      document.modbus = structuredClone(settings)
      const saved = await api.saveSettings(document)
      setSettings(saved.settings.modbus)
      setMessage('Applied and saved. Modbus transports are reloading.')
    } catch (reason) {
      setMessage('')
      if (reason instanceof ApiError && reason.status === 401)
        return onUnauthorized()
      setError(reason instanceof Error
        ? reason.message : 'Unable to save Modbus settings')
    } finally {
      setBusy(false)
    }
  }

  return <div className="modbus-configuration">
    <section className="section-heading configuration-heading">
      <div><p className="eyebrow">Protocol</p><h2>Modbus server</h2></div>
      <span>Hot-reloaded by msap1-modbus-server</span>
    </section>
    {error && <div className="error-banner"><strong>Modbus settings unavailable</strong>
      <span>{error}</span></div>}
    {!settings && !error && <div className="database-progress">Loading Modbus settings…</div>}
    {settings && <form className="modbus-form" onSubmit={save}>
      <fieldset>
        <legend>Service</legend>
        <label className="toggle"><input type="checkbox" checked={settings.enabled}
          onChange={(event) => setSettings({
            ...settings, enabled: event.target.checked,
          })} />Enable Modbus server</label>
        <small>Disabling the service policy closes every TCP and RTU transport.</small>
      </fieldset>

      <fieldset>
        <legend>Modbus TCP</legend>
        <div className="modbus-fields">
          <label className="toggle"><input type="checkbox" checked={settings.tcp.enabled}
            onChange={(event) => setSettings({
              ...settings,
              tcp: { ...settings.tcp, enabled: event.target.checked },
            })} />Enable TCP transport</label>
          <label>Listen address<input required value={settings.tcp.listen_address}
            onChange={(event) => setSettings({
              ...settings,
              tcp: { ...settings.tcp, listen_address: event.target.value },
            })} /></label>
          <label>TCP port<input type="number" min="1" max="65535" required
            value={settings.tcp.port} onChange={(event) => setSettings({
              ...settings,
              tcp: { ...settings.tcp, port: Number(event.target.value) },
            })} /></label>
          <label>Unit ID<input type="number" min="1" max="247" required
            value={settings.tcp.unit_id} onChange={(event) => setSettings({
              ...settings,
              tcp: { ...settings.tcp, unit_id: Number(event.target.value) },
            })} /></label>
          <label>Maximum clients<input type="number" min="1" max="1024" required
            value={settings.tcp.maximum_clients} onChange={(event) => setSettings({
              ...settings,
              tcp: { ...settings.tcp, maximum_clients: Number(event.target.value) },
            })} /></label>
        </div>
      </fieldset>

      <fieldset>
        <legend>Modbus RTU ports</legend>
        {settings.rtu.length === 0 && <p className="modbus-empty">
          No serial transports configured.</p>}
        <div className="modbus-rtu-list">
          {settings.rtu.map((port, index) => <article key={`${port.device}-${index}`}>
            <header><strong>RTU port {index + 1}</strong><button className="secondary"
              type="button" onClick={() => setSettings({
                ...settings, rtu: settings.rtu.filter((_, item) => item !== index),
              })}>Remove</button></header>
            <div className="modbus-fields">
              <label className="toggle"><input type="checkbox" checked={port.enabled}
                onChange={(event) => updateRtu(index, { enabled: event.target.checked })} />Enabled</label>
              <label>Device<input required value={port.device}
                onChange={(event) => updateRtu(index, { device: event.target.value })} /></label>
              <label>Baud rate<input type="number" min="1200" max="4000000" required
                value={port.baud_rate}
                onChange={(event) => updateRtu(index, { baud_rate: Number(event.target.value) })} /></label>
              <label>Parity<select value={port.parity}
                onChange={(event) => updateRtu(index, {
                  parity: event.target.value as ModbusRtuPortSettings['parity'],
                })}><option value="none">None</option><option value="even">Even</option>
                <option value="odd">Odd</option></select></label>
              <label>Data bits<select value={port.data_bits}
                onChange={(event) => updateRtu(index, {
                  data_bits: Number(event.target.value) as 7 | 8,
                })}><option value={7}>7</option><option value={8}>8</option></select></label>
              <label>Stop bits<select value={port.stop_bits}
                onChange={(event) => updateRtu(index, {
                  stop_bits: Number(event.target.value) as 1 | 2,
                })}><option value={1}>1</option><option value={2}>2</option></select></label>
              <label>Unit ID<input type="number" min="1" max="247" required
                value={port.unit_id}
                onChange={(event) => updateRtu(index, { unit_id: Number(event.target.value) })} /></label>
            </div>
          </article>)}
        </div>
        <button className="secondary" type="button" disabled={settings.rtu.length >= 32}
          onClick={() => setSettings({
            ...settings, rtu: [...settings.rtu, { ...DEFAULT_RTU_PORT }],
          })}>Add RTU port</button>
      </fieldset>

      <div className="modbus-actions"><button type="submit" disabled={busy}>
        {busy ? 'Applying…' : 'Apply and save'}</button><span>{message}</span></div>
    </form>}
  </div>
}
