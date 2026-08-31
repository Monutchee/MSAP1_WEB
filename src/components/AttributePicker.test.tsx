import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { MeterAttributeCatalog } from '../api'
import { AttributePicker } from './AttributePicker'

const catalog: MeterAttributeCatalog = {
  usage: 'historian',
  periods: [
    { id: 'basic', label: 'Basic 10/12-cycle',
      attributes: ['frequency', 'voltage.ln.a.rms'] },
    { id: 'minutes_10', label: '10 minute', attributes: ['voltage.ln.a.rms'] },
  ],
  attributes: [
    { id: 'frequency', label: 'Frequency', group: 'frequency', unit: 'Hz',
      value_kind: 'linear', search_aliases: ['mains hertz'],
      calculations: ['minimum', 'maximum', 'average', 'last'], periods: ['basic'] },
    { id: 'voltage.ln.a.rms', label: 'Line voltage A', group: 'voltage_ln_rms',
      unit: 'V', value_kind: 'linear', search_aliases: ['line neutral phase a'],
      calculations: ['minimum', 'maximum', 'average', 'last'],
      periods: ['basic', 'minutes_10'] },
  ],
}

describe('AttributePicker', () => {
  it('searches metadata, selects the visible set, and clears it', () => {
    function Harness() {
      const [selected, setSelected] = useState<string[]>([])
      return <AttributePicker catalog={catalog} period="basic"
        selected={selected} onChange={setSelected} />
    }
    render(<Harness />)
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search attributes' }),
      { target: { value: 'line neutral' } })
    expect(screen.getByRole('checkbox', { name: /Line voltage A/ })).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: /Frequency/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Select visible' }))
    expect(screen.getByRole('checkbox', { name: /Line voltage A/ })).toBeChecked()
    expect(screen.getByRole('status')).toHaveTextContent('1 selected')
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(screen.getByRole('status')).toHaveTextContent('0 selected')
  })

  it('warns instead of silently dropping a period-incompatible selection', () => {
    render(<AttributePicker catalog={catalog} period="minutes_10"
      selected={['frequency']} onChange={() => undefined} />)
    expect(screen.getByRole('alert')).toHaveTextContent(
      '1 selected attribute is unavailable for this period')
  })
})
