import { useCallback, useEffect, useState } from 'react'
import {
  api, ApiError, type MeterDemand, type MeterEnergy,
  type PhaseTotalDecimalStrings,
} from '../api'

type ResetTarget = 'energy' | 'demand'
type PhaseKey = keyof PhaseTotalDecimalStrings

const PHASES: { key: PhaseKey; label: string }[] = [
  { key: 'phase_a', label: 'Phase A' },
  { key: 'phase_b', label: 'Phase B' },
  { key: 'phase_c', label: 'Phase C' },
  { key: 'total', label: 'Total' },
]

const QUADRANTS = [
  {
    key: 'reactive_quadrant_i_uvarh' as const,
    numeral: 'I', sign: 'P ≥ 0 · Q₁ > 0', meaning: 'Import · inductive / lagging',
  },
  {
    key: 'reactive_quadrant_ii_uvarh' as const,
    numeral: 'II', sign: 'P < 0 · Q₁ > 0', meaning: 'Export · inductive / lagging',
  },
  {
    key: 'reactive_quadrant_iii_uvarh' as const,
    numeral: 'III', sign: 'P < 0 · Q₁ < 0', meaning: 'Export · capacitive / leading',
  },
  {
    key: 'reactive_quadrant_iv_uvarh' as const,
    numeral: 'IV', sign: 'P ≥ 0 · Q₁ < 0', meaning: 'Import · capacitive / leading',
  },
]

/** Format an authoritative integer without ever narrowing it through Number. */
export function formatExactInteger(value: string): string {
  try {
    return new Intl.NumberFormat('en-US').format(BigInt(value))
  } catch {
    return value
  }
}

function ExactValue({ value, unit }: { value: string; unit: string }) {
  return <span className="energy-exact-value">
    <strong>{formatExactInteger(value)}</strong><small>{unit}</small>
  </span>
}

function EnergyGroup({ title, description, values, unit }: {
  title: string
  description: string
  values: PhaseTotalDecimalStrings
  unit: string
}) {
  return <article className="energy-group-card">
    <header><h3>{title}</h3><p>{description}</p></header>
    <dl>{PHASES.map(({ key, label }) => <div className={key === 'total' ? 'total' : ''}
      key={key}><dt>{label}</dt><dd><ExactValue value={values[key]} unit={unit} /></dd></div>)}</dl>
  </article>
}

function StateFlag({ ok, children }: { ok: boolean; children: string }) {
  return <span className={`energy-state-flag ${ok ? 'ok' : 'bad'}`}><i />{children}</span>
}

function ResetDialog({ target, epoch, busy, error, onCancel, onConfirm }: {
  target: ResetTarget
  epoch: string
  busy: boolean
  error: string
  onCancel: () => void
  onConfirm: () => void
}) {
  const energy = target === 'energy'
  return <div className="energy-reset-backdrop">
    <section className="energy-reset-dialog" role="alertdialog" aria-modal="true"
      aria-labelledby="energy-reset-title" aria-describedby="energy-reset-description">
      <p className="eyebrow">Administrative reset</p>
      <h2 id="energy-reset-title">{energy ? 'Reset all energy?' : 'Reset all demand peaks?'}</h2>
      <p id="energy-reset-description">{energy
        ? 'This zeros all 28 authoritative lifetime energy counters and begins a new reset epoch. The RPU session continues from a durable baseline.'
        : 'This zeros every phase and total import/export demand peak. Current demand is not reset.'}</p>
      <dl><div><dt>Expected epoch</dt><dd><code>{formatExactInteger(epoch)}</code></dd></div></dl>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="energy-reset-actions">
        <button type="button" className="secondary" disabled={busy} onClick={onCancel}>Cancel</button>
        <button type="button" className="danger" disabled={busy} onClick={onConfirm}>
          {busy ? 'Resetting…' : energy ? 'Reset all energy' : 'Reset all peaks'}
        </button>
      </div>
    </section>
  </div>
}

function DemandTable({ demand }: { demand: MeterDemand }) {
  return <div className="energy-table-frame"><table className="energy-demand-table">
    <caption>Signed 10-minute active demand and authoritative peaks</caption>
    <thead><tr><th scope="col">Scope</th><th scope="col">Current demand</th>
      <th scope="col">Import peak</th><th scope="col">Export peak</th></tr></thead>
    <tbody>{PHASES.map(({ key, label }) => <tr className={key === 'total' ? 'total' : ''}
      key={key}><th scope="row">{label}</th>
      <td><ExactValue value={demand.current_active_uw[key]} unit="µW" /></td>
      <td><ExactValue value={demand.import_peak_uw[key]} unit="µW" /></td>
      <td><ExactValue value={demand.export_peak_uw[key]} unit="µW" /></td></tr>)}</tbody>
  </table></div>
}

export function EnergyDemandView({ canReset, onUnauthorized }: {
  canReset: boolean
  onUnauthorized: () => void
}) {
  const [energy, setEnergy] = useState<MeterEnergy>()
  const [demand, setDemand] = useState<MeterDemand>()
  const [energyError, setEnergyError] = useState('')
  const [demandError, setDemandError] = useState('')
  const [resetTarget, setResetTarget] = useState<ResetTarget>()
  const [resetKey, setResetKey] = useState('')
  const [resetBusy, setResetBusy] = useState(false)
  const [resetError, setResetError] = useState('')
  const [resetNotice, setResetNotice] = useState('')

  const handleError = useCallback((reason: unknown, fallback: string, setter: (value: string) => void) => {
    if (reason instanceof ApiError && reason.status === 401) {
      onUnauthorized()
      return
    }
    setter(reason instanceof Error ? reason.message : fallback)
  }, [onUnauthorized])

  const refresh = useCallback(async () => {
    const [nextEnergy, nextDemand] = await Promise.allSettled([
      api.meterEnergy(), api.meterDemand(),
    ])
    if (nextEnergy.status === 'fulfilled') {
      setEnergy(nextEnergy.value)
      setEnergyError('')
    } else {
      handleError(nextEnergy.reason, 'Unable to read durable energy', setEnergyError)
    }
    if (nextDemand.status === 'fulfilled') {
      setDemand(nextDemand.value)
      setDemandError('')
    } else {
      handleError(nextDemand.reason, 'Unable to read 10-minute demand', setDemandError)
    }
  }, [handleError])

  useEffect(() => {
    let active = true
    let pending = false
    const poll = async () => {
      if (!active || pending) return
      pending = true
      await refresh()
      pending = false
    }
    void poll()
    const timer = window.setInterval(poll, 2000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [refresh])

  const openReset = (target: ResetTarget) => {
    setResetTarget(target)
    setResetError('')
    setResetNotice('')
    setResetKey(globalThis.crypto?.randomUUID?.() ??
      `m17-${target}-${Date.now().toString(36)}`)
  }

  const confirmReset = async () => {
    if (!resetTarget) return
    const epoch = resetTarget === 'energy' ? energy?.reset_epoch : demand?.peak_reset_epoch
    if (!epoch) return
    setResetBusy(true)
    setResetError('')
    try {
      const result = resetTarget === 'energy'
        ? await api.resetMeterEnergy(epoch, resetKey)
        : await api.resetMeterDemandPeaks(epoch, resetKey)
      setResetNotice(`${resetTarget === 'energy' ? 'Energy' : 'Demand peaks'} reset at epoch ${formatExactInteger(result.reset_epoch)}${result.replayed ? ' (idempotent replay)' : ''}.`)
      setResetTarget(undefined)
      await refresh()
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        onUnauthorized()
        return
      }
      setResetError(reason instanceof Error ? reason.message : 'Reset failed')
    } finally {
      setResetBusy(false)
    }
  }

  return <section className="reading-section energy-demand-view" aria-labelledby="energy-demand-title">
    <div className="reading-section-heading compact">
      <div><p className="eyebrow">Metrology M17</p><h2 id="energy-demand-title">Energy &amp; Demand</h2>
        <p>Durable lifetime energy and completed UTC 10-minute active demand.</p></div>
      {canReset && <div className="energy-admin-actions">
        <button type="button" className="secondary" disabled={!energy}
          onClick={() => openReset('energy')}>Reset all energy</button>
        <button type="button" className="secondary" disabled={!demand}
          onClick={() => openReset('demand')}>Reset demand peaks</button>
      </div>}
    </div>

    {resetNotice && <div className="energy-reset-notice" role="status">{resetNotice}</div>}
    {(energyError || demandError) && <div className="error-banner">
      <strong>Some durable values are unavailable</strong>
      <span>{[energyError, demandError].filter(Boolean).join(' · ')}</span>
    </div>}

    {energy ? <>
      <div className="energy-status" aria-label="Energy durability status">
        <StateFlag ok={energy.quality === 'valid'}>{`Energy ${energy.quality}`}</StateFlag>
        <StateFlag ok={!energy.incomplete_accumulation}>Accumulation complete</StateFlag>
        <StateFlag ok={!energy.saturated}>Counters not saturated</StateFlag>
        <StateFlag ok={!energy.discontinuity}>No session discontinuity</StateFlag>
        <span>Session <code>{formatExactInteger(energy.session_id)}</code></span>
        <span>Reset epoch <code>{formatExactInteger(energy.reset_epoch)}</code></span>
        <span>Durable update <code>{formatExactInteger(energy.last_durable_update_nanoseconds)} ns UTC</code></span>
      </div>

      <div className="energy-groups">
        <EnergyGroup title="Active import" description="P > 0 integrated over accepted samples"
          values={energy.active_import_uwh} unit="µWh" />
        <EnergyGroup title="Active export" description="Magnitude of P < 0 integrated over accepted samples"
          values={energy.active_export_uwh} unit="µWh" />
        <EnergyGroup title="Apparent energy" description="Apparent power integrated over accepted samples"
          values={energy.apparent_uvah} unit="µVAh" />
      </div>

      <section className="quadrant-panel" aria-labelledby="quadrant-energy-title">
        <header><p className="eyebrow">Fundamental reactive energy</p>
          <h3 id="quadrant-energy-title">Four-quadrant ledger</h3>
          <p>Each cell integrates |Q₁|. Total is classified from algebraic total P/Q₁ signs, not summed phase quadrants.</p></header>
        <div className="energy-table-frame"><table className="quadrant-matrix">
          <caption>Reactive energy by simultaneous active and fundamental-reactive power signs</caption>
          <thead><tr><th scope="col">Scope</th>{QUADRANTS.map((quadrant) => <th scope="col"
            key={quadrant.numeral}><strong>Quadrant {quadrant.numeral}</strong>
            <span>{quadrant.sign}</span><small>{quadrant.meaning}</small></th>)}</tr></thead>
          <tbody>{PHASES.map(({ key, label }) => <tr className={key === 'total' ? 'total' : ''}
            key={key}><th scope="row">{label}</th>{QUADRANTS.map((quadrant) => <td
              key={quadrant.numeral}><ExactValue value={energy[quadrant.key][key]}
                unit="µvarh" /></td>)}</tr>)}</tbody>
        </table></div>
        <p className="quadrant-axis-note"><strong>Axis behavior:</strong> P = 0 uses the import side;
          Q₁ = 0 adds no reactive energy to any quadrant.</p>
      </section>
    </> : <div className="harmonic-empty"><strong>Waiting for durable energy</strong>
      <span>Both ENERGY-v1 records must validate and commit before values appear.</span></div>}

    <section className="demand-panel" aria-labelledby="active-demand-title">
      <header><div><p className="eyebrow">UTC 10-minute block demand</p>
        <h3 id="active-demand-title">Active demand</h3></div>
        {demand && <div className="energy-status compact" aria-label="Demand interval status">
          <StateFlag ok={demand.quality === 'valid'}>{`Demand ${demand.quality}`}</StateFlag>
          <StateFlag ok={demand.time_aligned}>UTC aligned</StateFlag>
          <StateFlag ok={demand.boundary_valid && !demand.contaminated}>Interval clean</StateFlag>
        </div>}</header>
      {demand ? <>
        <DemandTable demand={demand} />
        <div className="demand-provenance">
          <span>Peak epoch <code>{formatExactInteger(demand.peak_reset_epoch)}</code></span>
          <span>Session <code>{formatExactInteger(demand.session_id)}</code></span>
          <span>Boundary sample <code>{formatExactInteger(demand.interval_target_sample)}</code></span>
          <span>Durable update <code>{formatExactInteger(demand.last_durable_update_nanoseconds)} ns UTC</code></span>
          {(demand.incomplete_accumulation || demand.saturated) && <strong>
            {demand.incomplete_accumulation ? 'Incomplete accumulation' : ''}
            {demand.incomplete_accumulation && demand.saturated ? ' · ' : ''}
            {demand.saturated ? 'Saturated' : ''}</strong>}
        </div>
      </> : <div className="harmonic-empty"><strong>Waiting for a completed UTC interval</strong>
        <span>Current demand and peaks publish only after a valid 10-minute family closes.</span></div>}
    </section>

    {resetTarget && <ResetDialog target={resetTarget}
      epoch={resetTarget === 'energy' ? energy?.reset_epoch ?? '' : demand?.peak_reset_epoch ?? ''}
      busy={resetBusy} error={resetError} onCancel={() => setResetTarget(undefined)}
      onConfirm={() => void confirmReset()} />}
  </section>
}
