import { useMemo, useState } from 'react'
import { MeterAttributeCatalog } from '../api'
import './attributePicker.css'

const GROUP_LABELS: Record<string, string> = {
  frequency: 'Frequency', voltage_ln_rms: 'Voltage L-N RMS',
  voltage_ll_rms: 'Voltage L-L RMS', current_rms: 'Current RMS',
  fundamental: 'Fundamental', active_power: 'Active power',
  apparent_power: 'Apparent power', power_factor: 'Power factor',
  reactive_power: 'Reactive power',
  displacement_power_factor: 'Displacement power factor',
  phase_angle: 'Phase angle', unbalance: 'Unbalance',
  sequence_components: 'Sequence components', energy: 'Energy',
  demand: 'Demand', crest_factor: 'Crest factor', load_nature: 'Load nature',
  other: 'Other',
}

export function AttributePicker({ catalog, period, selected, onChange, disabled = false,
  label = 'Meter attributes' }: {
  catalog: MeterAttributeCatalog
  period: string
  selected: string[]
  onChange: (selected: string[]) => void
  disabled?: boolean
  label?: string
}) {
  const [search, setSearch] = useState('')
  const available = useMemo(() => new Set(
    catalog.periods.find((entry) => entry.id === period)?.attributes ?? []),
  [catalog, period])
  const normalized = search.trim().toLocaleLowerCase()
  const visible = useMemo(() => catalog.attributes.filter((attribute) => {
    if (!available.has(attribute.id)) return false
    if (!normalized) return true
    return [attribute.id, attribute.label, attribute.group, attribute.unit,
      ...attribute.search_aliases].some((value) =>
      value.toLocaleLowerCase().includes(normalized))
  }), [available, catalog, normalized])
  const grouped = useMemo(() => {
    const groups = new Map<string, typeof visible>()
    for (const attribute of visible) {
      const values = groups.get(attribute.group) ?? []
      values.push(attribute)
      groups.set(attribute.group, values)
    }
    return [...groups.entries()]
  }, [visible])
  const unavailableSelected = selected.filter((id) => !available.has(id))

  function toggle(id: string, checked: boolean) {
    onChange(checked
      ? catalog.attributes.filter((attribute) =>
        attribute.id === id || selected.includes(attribute.id)).map((attribute) => attribute.id)
      : selected.filter((value) => value !== id))
  }

  function selectVisible() {
    const next = new Set(selected)
    for (const attribute of visible) next.add(attribute.id)
    onChange(catalog.attributes.filter((attribute) => next.has(attribute.id))
      .map((attribute) => attribute.id))
  }

  return <fieldset className="attribute-picker">
    <legend>{label}</legend>
    <div className="attribute-picker-toolbar">
      <label>Search attributes<input type="search" value={search}
        placeholder="Name, key, group, or unit"
        onChange={(event) => setSearch(event.target.value)} disabled={disabled} /></label>
      <div role="status" aria-live="polite"><strong>{selected.length}</strong> selected</div>
      <button type="button" className="secondary" disabled={disabled || visible.length === 0}
        onClick={selectVisible}>Select visible</button>
      <button type="button" className="secondary" disabled={disabled || selected.length === 0}
        onClick={() => onChange([])}>Clear</button>
    </div>
    {unavailableSelected.length > 0 && <div className="attribute-picker-warning" role="alert">
      {unavailableSelected.length} selected attribute{unavailableSelected.length === 1 ? ' is' : 's are'} unavailable for this period. Review the selection before saving.
    </div>}
    {grouped.length === 0 && <p className="attribute-picker-empty">No attributes match this search.</p>}
    <div className="attribute-picker-groups">
      {grouped.map(([group, attributes]) => <section key={group}>
        <h4>{GROUP_LABELS[group] ?? group.replaceAll('_', ' ')}</h4>
        <div>{attributes.map((attribute) => <label key={attribute.id}>
          <input type="checkbox" checked={selected.includes(attribute.id)} disabled={disabled}
            onChange={(event) => toggle(attribute.id, event.target.checked)} />
          <span><strong>{attribute.label}</strong>
            <small>{attribute.id} · {attribute.unit}</small></span>
        </label>)}</div>
      </section>)}
    </div>
  </fieldset>
}
