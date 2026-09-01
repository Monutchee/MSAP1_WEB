import { useCallback, useEffect, useState } from 'react'
import {
  api, ApiError, type MeterDemand, type MeterEnergy,
  type PhaseTotalDecimalStrings,
} from '../api'

type ResetTarget = 'energy' | 'demand'
type PhaseKey = keyof PhaseTotalDecimalStrings
export type EnergyDisplayUnit = 'Wh' | 'kWh' | 'MWh'
export type DemandDisplayUnit = 'W' | 'kW' | 'MW'

const ENERGY_DISPLAY_UNITS: {
  value: EnergyDisplayUnit
  divisor: bigint
  decimals: number
  prefix: '' | 'k' | 'M'
}[] = [
  { value: 'Wh', divisor: 1_000_000n, decimals: 6, prefix: '' },
  { value: 'kWh', divisor: 1_000_000_000n, decimals: 9, prefix: 'k' },
  { value: 'MWh', divisor: 1_000_000_000_000n, decimals: 12, prefix: 'M' },
]

const DEMAND_DISPLAY_UNITS: {
  value: DemandDisplayUnit
  divisor: bigint
  decimals: number
}[] = [
  { value: 'W', divisor: 1_000_000n, decimals: 6 },
  { value: 'kW', divisor: 1_000_000_000n, decimals: 9 },
  { value: 'MW', divisor: 1_000_000_000_000n, decimals: 12 },
]

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

function formatScaledMicroValue(value: string, divisor: bigint, decimals: number): string {
  try {
    const input = BigInt(value)
    const negative = input < 0n
    const magnitude = negative ? -input : input
    const integer = magnitude / divisor
    const remainder = magnitude % divisor
    const fraction = remainder.toString().padStart(decimals, '0').replace(/0+$/, '')
    const sign = negative ? '-' : ''
    return `${sign}${new Intl.NumberFormat('en-US').format(integer)}${fraction ? `.${fraction}` : ''}`
  } catch {
    return value
  }
}

/** Convert exact micro-energy integers without narrowing through Number. */
export function formatEnergyValue(value: string, unit: EnergyDisplayUnit): string {
  const selected = ENERGY_DISPLAY_UNITS.find((candidate) => candidate.value === unit)
    ?? ENERGY_DISPLAY_UNITS[1]
  return formatScaledMicroValue(value, selected.divisor, selected.decimals)
}

/** Convert exact microwatt integers without narrowing through Number. */
export function formatDemandValue(value: string, unit: DemandDisplayUnit): string {
  const selected = DEMAND_DISPLAY_UNITS.find((candidate) => candidate.value === unit)
    ?? DEMAND_DISPLAY_UNITS[1]
  return formatScaledMicroValue(value, selected.divisor, selected.decimals)
}

function energyUnitLabel(unit: EnergyDisplayUnit, quantity: 'active' | 'apparent' | 'reactive') {
  const prefix = ENERGY_DISPLAY_UNITS.find((candidate) => candidate.value === unit)?.prefix ?? 'k'
  if (quantity === 'apparent') return `${prefix}VAh`
  if (quantity === 'reactive') return `${prefix}varh`
  return `${prefix}Wh`
}

function DemandValue({ value, displayUnit }: { value: string; displayUnit: DemandDisplayUnit }) {
  return <span className="energy-exact-value">
    <strong>{formatDemandValue(value, displayUnit)}</strong><small>{displayUnit}</small>
  </span>
}

function EnergyValue({ value, displayUnit, quantity }: {
  value: string
  displayUnit: EnergyDisplayUnit
  quantity: 'active' | 'apparent' | 'reactive'
}) {
  return <span className="energy-exact-value">
    <strong>{formatEnergyValue(value, displayUnit)}</strong>
    <small>{energyUnitLabel(displayUnit, quantity)}</small>
  </span>
}

function EnergyGroup({ title, description, values, displayUnit, quantity }: {
  title: string
  description: string
  values: PhaseTotalDecimalStrings
  displayUnit: EnergyDisplayUnit
  quantity: 'active' | 'apparent'
}) {
  return <article className="energy-group-card">
    <header><h3>{title}</h3><p>{description}</p></header>
    <dl>{PHASES.map(({ key, label }) => <div className={key === 'total' ? 'total' : ''}
      key={key}><dt>{label}</dt><dd><EnergyValue value={values[key]}
        displayUnit={displayUnit} quantity={quantity} /></dd></div>)}</dl>
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

function DemandTable({ demand, displayUnit }: {
  demand: MeterDemand
  displayUnit: DemandDisplayUnit
}) {
  return <div className="energy-table-frame"><table className="energy-demand-table">
    <caption>Signed active demand and authoritative peaks for the configured window</caption>
    <thead><tr><th scope="col">Scope</th><th scope="col">Current demand</th>
      <th scope="col">Import peak</th><th scope="col">Export peak</th></tr></thead>
    <tbody>{PHASES.map(({ key, label }) => <tr className={key === 'total' ? 'total' : ''}
      key={key}><th scope="row">{label}</th>
      <td><DemandValue value={demand.current_active_uw[key]} displayUnit={displayUnit} /></td>
      <td><DemandValue value={demand.import_peak_uw[key]} displayUnit={displayUnit} /></td>
      <td><DemandValue value={demand.export_peak_uw[key]} displayUnit={displayUnit} /></td></tr>)}</tbody>
  </table></div>
}

export function EnergyDemandView({ canReset, onUnauthorized, enabled = true }: {
  canReset: boolean
  onUnauthorized: () => void
  enabled?: boolean
}) {
  const [energy, setEnergy] = useState<MeterEnergy>()
  const [demand, setDemand] = useState<MeterDemand>()
  const [energyError, setEnergyError] = useState('')
  const [demandError, setDemandError] = useState('')
  const [demandWarmup, setDemandWarmup] = useState(false)
  const [displayUnit, setDisplayUnit] = useState<EnergyDisplayUnit>('kWh')
  const [demandDisplayUnit, setDemandDisplayUnit] = useState<DemandDisplayUnit>('kW')
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
      setDemandWarmup(false)
    } else if (nextDemand.reason instanceof ApiError && nextDemand.reason.status === 503 &&
      nextDemand.reason.message === 'no durable DEMAND checkpoint exists') {
      setDemand(undefined)
      setDemandError('')
      setDemandWarmup(true)
    } else {
      setDemandWarmup(false)
      handleError(nextDemand.reason, 'Unable to read active demand', setDemandError)
    }
  }, [handleError])

  useEffect(() => {
    if (!enabled) {
      setEnergy(undefined)
      setDemand(undefined)
      setEnergyError('')
      setDemandError('')
      return
    }
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
  }, [enabled, refresh])

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
        <p>Durable lifetime energy and configurable fixed or sliding active demand.</p></div>
      <div className="energy-view-controls">
        <label className="energy-unit-select">Energy unit
          <select aria-label="Energy display unit" value={displayUnit}
            onChange={(event) => setDisplayUnit(event.target.value as EnergyDisplayUnit)}>
            {ENERGY_DISPLAY_UNITS.map(({ value }) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        {canReset && <div className="energy-admin-actions">
          <button type="button" className="secondary" disabled={!energy}
            onClick={() => openReset('energy')}>Reset all energy</button>
          <button type="button" className="secondary" disabled={!demand}
            onClick={() => openReset('demand')}>Reset demand peaks</button>
        </div>}
      </div>
    </div>

    {resetNotice && <div className="energy-reset-notice" role="status">{resetNotice}</div>}
    {demandWarmup && <div className="energy-warmup-notice" role="status">
      <strong>Demand warm-up</strong>
      <span>The first durable value appears after the configured demand window fills.</span>
    </div>}
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
          values={energy.active_import_uwh} displayUnit={displayUnit} quantity="active" />
        <EnergyGroup title="Active export" description="Magnitude of P < 0 integrated over accepted samples"
          values={energy.active_export_uwh} displayUnit={displayUnit} quantity="active" />
        <EnergyGroup title="Apparent energy" description="Apparent power integrated over accepted samples"
          values={energy.apparent_uvah} displayUnit={displayUnit} quantity="apparent" />
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
              key={quadrant.numeral}><EnergyValue value={energy[quadrant.key][key]}
                displayUnit={displayUnit} quantity="reactive" /></td>)}</tr>)}</tbody>
        </table></div>
        <p className="quadrant-axis-note"><strong>Axis behavior:</strong> P = 0 uses the import side;
          Q₁ = 0 adds no reactive energy to any quadrant.</p>
      </section>
    </> : <div className="harmonic-empty"><strong>Waiting for durable energy</strong>
      <span>Both ENERGY-v1 records must validate and commit before values appear.</span></div>}

    <section className="demand-panel" aria-labelledby="active-demand-title">
      <header><div><p className="eyebrow">{demand
        ? `${demand.method === 'fixed_block' ? 'Fixed block' : 'Sliding'} · ${demand.window_seconds / 60} min window · ${demand.update_seconds} s update`
        : 'Configured active demand'}</p>
        <h3 id="active-demand-title">Active demand</h3></div>
        <div className="energy-view-controls">
          <label className="energy-unit-select">Demand unit
            <select aria-label="Demand display unit" value={demandDisplayUnit}
              onChange={(event) => setDemandDisplayUnit(event.target.value as DemandDisplayUnit)}>
              {DEMAND_DISPLAY_UNITS.map(({ value }) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          {demand && <div className="energy-status compact" aria-label="Demand interval status">
            <StateFlag ok={demand.quality === 'valid'}>{`Demand ${demand.quality}`}</StateFlag>
            {demand.method === 'fixed_block'
              ? <StateFlag ok={demand.time_aligned}>UTC aligned</StateFlag>
              : <StateFlag ok={demand.update_seconds === 3}>3-second refresh</StateFlag>}
            <StateFlag ok={demand.boundary_valid && !demand.contaminated}>Window clean</StateFlag>
          </div>}
        </div></header>
      {demand ? <>
        <DemandTable demand={demand} displayUnit={demandDisplayUnit} />
        <div className="demand-provenance">
          <span>Peak epoch <code>{formatExactInteger(demand.peak_reset_epoch)}</code></span>
          <span>Session <code>{formatExactInteger(demand.session_id)}</code></span>
          <span>Window anchor <code>{formatExactInteger(demand.interval_anchor_sample)}</code></span>
          <span>Profile generation <code>{formatExactInteger(String(demand.profile_generation))}</code></span>
          <span>Durable update <code>{formatExactInteger(demand.last_durable_update_nanoseconds)} ns UTC</code></span>
          {(demand.incomplete_accumulation || demand.saturated) && <strong>
            {demand.incomplete_accumulation ? 'Incomplete accumulation' : ''}
            {demand.incomplete_accumulation && demand.saturated ? ' · ' : ''}
            {demand.saturated ? 'Saturated' : ''}</strong>}
        </div>
      </> : <div className="harmonic-empty"><strong>Waiting for a completed demand window</strong>
        <span>Current demand and peaks publish after the configured window is valid and complete.</span></div>}
    </section>

    {resetTarget && <ResetDialog target={resetTarget}
      epoch={resetTarget === 'energy' ? energy?.reset_epoch ?? '' : demand?.peak_reset_epoch ?? ''}
      busy={resetBusy} error={resetError} onCancel={() => setResetTarget(undefined)}
      onConfirm={() => void confirmReset()} />}
  </section>
}
