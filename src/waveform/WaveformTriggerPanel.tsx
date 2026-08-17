import { FormEvent, useEffect, useState } from 'react'
import { api, ApiError, WaveformStatus } from '../api'

const DECIMATIONS = [1, 2, 4, 8, 16, 32]
const UNIT_STORAGE_KEY = 'msap1.waveform.trigger-unit'
/** Bytes per stored frame: 7 persisted channels x 4 bytes. */
const FRAME_BYTES = 28

type TriggerUnit = 'ms' | 'cycles'

function storedUnit(): TriggerUnit {
  return window.localStorage.getItem(UNIT_STORAGE_KEY) === 'cycles'
    ? 'cycles'
    : 'ms'
}

function formatBytes(bytes: number) {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(0)} kB`
  return `${bytes} B`
}

/**
 * Manual pre/post-trigger capture form, hosted on the Waveforms page next to
 * the history it produces.
 *
 * Durations can be entered in milliseconds or in grid cycles; cycles convert
 * through the *configured nominal* frequency (50/60 Hz), not the live
 * measured one, so a cycles request is deterministic and reproducible. The
 * API stays in milliseconds either way, and the inputs cap at the budget the
 * daemon reports (the frame-sized history buffer spans fewer seconds at
 * higher sample rates).
 *
 * The capture rate select chooses a decimation divisor: the file stores the
 * mean of every N acquisition frames. True samples-per-cycle rates would
 * need a grid-locked ADC clock, which this meter deliberately does not have.
 */
export function WaveformTriggerPanel({ status, onStatus, onUnauthorized }: {
  status: WaveformStatus | undefined
  onStatus: (status: WaveformStatus) => void
  onUnauthorized: () => void
}) {
  const [pretriggerMs, setPretriggerMs] = useState(3000)
  const [posttriggerMs, setPosttriggerMs] = useState(3000)
  const [decimation, setDecimation] = useState(1)
  const [unit, setUnit] = useState<TriggerUnit>(storedUnit)
  const [nominalHz, setNominalHz] = useState(60)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    api.activeSettings().then((activeSettings) => {
      if (!active) return
      setPretriggerMs(activeSettings.settings.waveform.default_pretrigger_ms)
      setPosttriggerMs(activeSettings.settings.waveform.default_posttrigger_ms)
      setDecimation(activeSettings.settings.waveform.default_decimation || 1)
      setNominalHz(activeSettings.settings.metering.nominal_frequency_hz || 60)
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

  function selectUnit(next: TriggerUnit) {
    setUnit(next)
    window.localStorage.setItem(UNIT_STORAGE_KEY, next)
  }

  const msPerCycle = 1000 / nominalHz
  const toCycles = (ms: number) => Math.round(ms / msPerCycle)
  const toMs = (cycles: number) => Math.round(cycles * msPerCycle)

  async function trigger(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setMessage('Arming capture…')
    setError('')
    try {
      const updated = await api.triggerWaveform(
        pretriggerMs, posttriggerMs, decimation)
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
      settings.waveform.default_decimation = decimation
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
  const sampleRate = status?.sample_rate_hz ?? 0
  const maxTotalMs = sampleRate
    ? Math.floor((status?.max_capture_frames ?? 0) * 1000 / sampleRate)
    : 0
  const requestedTotalMs = pretriggerMs + posttriggerMs
  const overBudget = maxTotalMs > 0 && requestedTotalMs > maxTotalMs
  const windowFrames = sampleRate
    ? Math.round(requestedTotalMs / 1000 * sampleRate) + 1
    : 0
  const estimatedBytes = windowFrames
    ? Math.ceil(windowFrames / decimation) * FRAME_BYTES
    : 0

  const cycles = unit === 'cycles'
  const inputValue = (ms: number) => cycles ? toCycles(ms) : ms
  const inputMax = cycles
    ? toCycles(maxTotalMs > 0 ? maxTotalMs : 120000)
    : (maxTotalMs > 0 ? maxTotalMs : 120000)
  const equivalent = (ms: number) => cycles
    ? `= ${ms.toLocaleString()} ms`
    : `= ${toCycles(ms).toLocaleString()} cycles at ${nominalHz} Hz`

  return <section className="waveform-trigger-panel">
    <header>
      <div><p className="eyebrow">Manual capture</p><h2>Trigger a capture</h2></div>
      {maxTotalMs > 0 && <span>
        Pre + post may total {(maxTotalMs / 1000).toFixed(1)} s
        ({toCycles(maxTotalMs).toLocaleString()} cycles) at{' '}
        {sampleRate.toLocaleString()} frame/s
      </span>}
    </header>
    {error && <div className="error-banner"><strong>Trigger failed</strong><span>{error}</span></div>}
    <form className="waveform-trigger-form" onSubmit={trigger}>
      <fieldset className="waveform-trigger-unit">
        <legend>Duration unit</legend>
        <label><input type="radio" name="waveform-trigger-unit" value="ms"
          checked={!cycles} onChange={() => selectUnit('ms')} />
          Milliseconds</label>
        <label><input type="radio" name="waveform-trigger-unit" value="cycles"
          checked={cycles} onChange={() => selectUnit('cycles')} />
          Grid cycles ({nominalHz} Hz nominal)</label>
      </fieldset>
      <label>Capture rate
        <select value={decimation}
          onChange={(event) => setDecimation(Number(event.target.value))}>
          {DECIMATIONS.map((divisor) => {
            const rate = sampleRate ? sampleRate / divisor : 0
            const perCycle = rate ? Math.round(rate / nominalHz) : 0
            return <option key={divisor} value={divisor}>
              {divisor === 1 ? 'Full rate' : `÷ ${divisor} (mean)`}
              {rate ? ` — ${Math.round(rate).toLocaleString()} sample/s` : ''}
              {perCycle ? ` ≈ ${perCycle} sample/cycle` : ''}
            </option>
          })}
        </select>
        {estimatedBytes > 0 &&
          <small>Estimated file: {formatBytes(estimatedBytes)}</small>}
      </label>
      <label>History before trigger ({cycles ? 'cycles' : 'ms'})
        <input type="number" min="0" max={inputMax}
          value={inputValue(pretriggerMs)}
          onChange={(event) => setPretriggerMs(cycles
            ? toMs(Number(event.target.value))
            : Number(event.target.value))} />
        <small>{equivalent(pretriggerMs)}</small></label>
      <label>Capture after trigger ({cycles ? 'cycles' : 'ms'})
        <input type="number" min="0" max={inputMax}
          value={inputValue(posttriggerMs)}
          onChange={(event) => setPosttriggerMs(cycles
            ? toMs(Number(event.target.value))
            : Number(event.target.value))} />
        <small>{equivalent(posttriggerMs)}</small></label>
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
