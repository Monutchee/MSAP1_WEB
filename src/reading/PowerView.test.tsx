import { useState } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MeterReadingAttribute } from '../api'
import { PowerView } from './PowerView'
import type { PowerScope, ReadingRecord } from './readingModel'

function value(key: string, readingValue: number, unit: string): MeterReadingAttribute {
  return {
    key, value: readingValue, unit, valid: true, quality: 'valid', source_sequence: 2119,
  }
}

const fixtureValues: Record<string, [number, string]> = {
  'power.active.a': [357.69, 'W'],
  'power.active.b': [363.62, 'W'],
  'power.active.c': [363.66, 'W'],
  'power.active.total': [1084.97, 'W'],
  'power.reactive.a': [-62.49, 'var'],
  'power.reactive.b': [-0.004, 'var'],
  'power.reactive.c': [-0.02, 'var'],
  'power.reactive.total': [-62.52, 'var'],
  'power.apparent.a': [363.68, 'VA'],
  'power.apparent.b': [363.67, 'VA'],
  'power.apparent.c': [363.71, 'VA'],
  'power.apparent.total': [1091.06, 'VA'],
  'power.factor.a': [0.9835, 'PF'],
  'power.factor.b': [0.9999, 'PF'],
  'power.factor.c': [0.9999, 'PF'],
  'power.factor.total': [0.9944, 'PF'],
  'power.factor.displacement.a': [0.9848, 'PF'],
  'power.factor.displacement.b': [1, 'PF'],
  'power.factor.displacement.c': [1, 'PF'],
  'power.factor.displacement.total': [0.9949, 'PF'],
  'unbalance.voltage': [0.001, '%'],
  'unbalance.current': [5.823, '%'],
}

function powerRecord(overrides: Record<string, [number, string]> = {}): ReadingRecord {
  const values = { ...fixtureValues, ...overrides }
  return {
    interval: 'basic',
    attributes: Object.entries(values).map(([key, [readingValue, unit]]) =>
      value(key, readingValue, unit)),
    channels: [], sequence: 2119, configurationGeneration: 4,
    timeQuality: 'synchronized', utcStartNanoseconds: undefined,
    utcUncertaintyNanoseconds: undefined, recordComplete: true,
    arithmeticError: false, flags: [],
  }
}

function PowerHarness({ record }: { record: ReadingRecord }) {
  const [scope, setScope] = useState<PowerScope>('total')
  return <PowerView record={record} scope={scope} onScopeChange={setScope} />
}

afterEach(() => vi.useRealTimers())

describe('Power view', () => {
  it('shows the supplied fixture without deriving authoritative totals', () => {
    const { container } = render(<PowerHarness record={powerRecord()} />)

    expect(screen.getByRole('button', { name: 'Total' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getAllByText('1091.06 VA').length).toBeGreaterThan(1)
    expect(screen.getAllByText('Import · Capacitive/leading').length).toBeGreaterThan(0)
    expect(screen.getByRole('img', { name: /^Total P–Q₁ operating point/ })).toBeInTheDocument()
    expect(container.querySelector('#pq-svg-description')?.textContent)
      .toContain('fundamental reactive power -62.52 var')

    const point = container.querySelector('.pq-operating-point circle')
    expect(Number(point?.getAttribute('cx'))).toBeGreaterThan(280)
    expect(Number(point?.getAttribute('cy'))).toBeGreaterThan(215)

    expect(screen.getAllByText('0.00 var').length).toBeGreaterThan(0)
    expect(screen.getByText(/THD and a complete/)).toBeInTheDocument()
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3)
  })

  it('switches scope with labeled native buttons and moves Phase A below/right', () => {
    const { container } = render(<PowerHarness record={powerRecord()} />)
    const phaseA = screen.getByRole('button', { name: 'Phase A' })
    phaseA.focus()
    expect(phaseA).toHaveFocus()
    fireEvent.click(phaseA)
    expect(phaseA).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('img', { name: /^Phase A P–Q₁ operating point/ })).toBeInTheDocument()
    expect(screen.getAllByText('357.69 W').length).toBeGreaterThan(0)
    expect(screen.getAllByText('-62.49 var').length).toBeGreaterThan(0)
    const point = container.querySelector('.pq-operating-point circle')
    expect(Number(point?.getAttribute('cx'))).toBeGreaterThan(280)
    expect(Number(point?.getAttribute('cy'))).toBeGreaterThan(215)
  })

  it('keeps advanced engineering data collapsed until requested', () => {
    render(<PowerHarness record={powerRecord()} />)
    const summary = screen.getByText(/Advanced power measurements/)
    const details = summary.closest('details')
    expect(details).not.toHaveAttribute('open')
    fireEvent.click(summary)
    expect(details).toHaveAttribute('open')
    expect(screen.getByText('power.apparent.total')).toBeInTheDocument()
    expect(screen.getAllByText('valid').length).toBeGreaterThan(0)
  })

  it('does not plot missing or explicitly invalid coordinates as zero', () => {
    const record = powerRecord()
    record.attributes = record.attributes
      .filter((reading) => reading.key !== 'power.reactive.total')
      .map((reading) => reading.key === 'power.active.total'
        ? { ...reading, value: Number.NaN, valid: false, quality: 'invalid' as const }
        : reading)
    const { container } = render(<PowerView record={record} scope="total"
      onScopeChange={() => undefined} />)
    expect(container.querySelector('.pq-operating-point')).not.toBeInTheDocument()
    expect(screen.getByRole('img', { name: /operating point is unavailable/ })).toBeInTheDocument()
    expect(screen.getAllByText('Invalid').length).toBeGreaterThan(0)
  })

  it('grows immediately and waits five seconds before shrinking its scale', () => {
    vi.useFakeTimers()
    const { rerender } = render(<PowerView record={powerRecord()} scope="total"
      onScopeChange={() => undefined} />)
    expect(screen.getByText('±2,000 W / var')).toBeInTheDocument()

    rerender(<PowerView record={powerRecord({
      'power.active.total': [10, 'W'],
      'power.reactive.total': [2, 'var'],
      'power.apparent.total': [11, 'VA'],
    })} scope="total" onScopeChange={() => undefined} />)
    act(() => vi.advanceTimersByTime(4_999))
    expect(screen.getByText('±2,000 W / var')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(1))
    expect(screen.getByText('±20 W / var')).toBeInTheDocument()

    rerender(<PowerView record={powerRecord({
      'power.active.total': [4_500, 'W'],
      'power.reactive.total': [0, 'var'],
      'power.apparent.total': [4_600, 'VA'],
    })} scope="total" onScopeChange={() => undefined} />)
    expect(screen.getByText('±10,000 W / var')).toBeInTheDocument()
  })
})
