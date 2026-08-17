import { FormEvent, useEffect, useState } from 'react'
import { api, ApiError, WaveformStatus } from '../api'

/**
 * Manual pre/post-trigger capture form, hosted on the Waveforms page next to
 * the history it produces. The duration inputs cap at the budget the daemon
 * reports: the frame-sized history buffer spans fewer seconds at higher
 * sample rates, so a fixed cap silently stops fitting when the rate changes.
 */
export function WaveformTriggerPanel({ status, onStatus, onUnauthorized }: {
  status: WaveformStatus | undefined
  onStatus: (status: WaveformStatus) => void
  onUnauthorized: () => void
}) {
  const [pretriggerMs, setPretriggerMs] = useState(10000)
  const [posttriggerMs, setPosttriggerMs] = useState(10000)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

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
      onStatus(updated)
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
      const active = await api.activeSettings()
      const settings = structuredClone(active.settings)
      settings.waveform.default_pretrigger_ms = pretriggerMs
      settings.waveform.default_posttrigger_ms = posttriggerMs
      await api.saveSettings(settings)
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

  // 0 until the daemon has measured a sample rate.
  const maxTotalMs = status?.sample_rate_hz
    ? Math.floor(status.max_capture_frames * 1000 / status.sample_rate_hz)
    : 0
  const requestedTotalMs = pretriggerMs + posttriggerMs
  const overBudget = maxTotalMs > 0 && requestedTotalMs > maxTotalMs

  return <section className="waveform-trigger-panel">
    <header>
      <div><p className="eyebrow">Manual capture</p><h2>Trigger a capture</h2></div>
      {maxTotalMs > 0 && <span>
        Pre + post may total {(maxTotalMs / 1000).toFixed(1)} s at{' '}
        {status?.sample_rate_hz.toLocaleString()} frame/s
      </span>}
    </header>
    {error && <div className="error-banner"><strong>Trigger failed</strong><span>{error}</span></div>}
    <form className="waveform-trigger-form" onSubmit={trigger}>
      <label>History before trigger (ms)<input type="number" min="0"
        max={maxTotalMs > 0 ? maxTotalMs : 120000}
        value={pretriggerMs} onChange={(event) => setPretriggerMs(Number(event.target.value))} /></label>
      <label>Capture after trigger (ms)<input type="number" min="0"
        max={maxTotalMs > 0 ? maxTotalMs : 120000}
        value={posttriggerMs} onChange={(event) => setPosttriggerMs(Number(event.target.value))} /></label>
      <div className="waveform-trigger-action">
        <button type="submit" disabled={busy || !status?.running || overBudget}>
          {busy ? 'Triggering…' : 'Trigger waveform'}
        </button>
        <button className="secondary" type="button" onClick={() => void saveDefaults()}
          disabled={busy}>Apply and save</button>
        <span>{overBudget
          ? `Requested ${(requestedTotalMs / 1000).toFixed(1)} s exceeds the `
            + `${(maxTotalMs / 1000).toFixed(1)} s budget`
          : message}</span>
      </div>
    </form>
  </section>
}
