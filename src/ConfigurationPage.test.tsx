import { render, screen, within } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

let ConfigurationPage: typeof import('./App')['ConfigurationPage']

beforeAll(async () => {
  vi.stubGlobal('matchMedia', vi.fn((media: string) => ({
    matches: false,
    media,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })))
  ;({ ConfigurationPage } = await import('./App'))
})

afterAll(() => vi.unstubAllGlobals())

const frequency = {
  enabled: true,
  reference_channel: 6,
  mode: 'rolling_cycles' as const,
  averaging_cycles: 10,
  averaging_window_ms: 1000,
  minimum_hz: 40,
  maximum_hz: 80,
  hysteresis_volts: 1,
}

describe('Meter configuration grouping', () => {
  it('keeps grid, demand, and zero-crossing controls in their own categories', () => {
    render(<ConfigurationPage
      configuration={frequency}
      configurationStatus=""
      onChange={vi.fn()}
      onSubmit={(event) => event.preventDefault()}
      nominalFrequency={60}
      onNominalFrequencyChange={vi.fn()}
      measurementTopology="wye"
      onMeasurementTopologyChange={vi.fn()}
      systemNominalVoltage={120}
      onSystemNominalVoltageChange={vi.fn()}
      demandConfiguration={{ method: 'sliding', window_seconds: 60 }}
      onDemandConfigurationChange={vi.fn()}
      simulator={undefined}
      onSimulatorChange={vi.fn()}
      onUnauthorized={vi.fn()}
    />)

    const grid = screen.getByRole('region', { name: 'Nominal grid configuration' })
    expect(within(grid).getByLabelText(/Nominal grid frequency/)).toBeInTheDocument()
    expect(within(grid).getByLabelText(/Measurement connection/)).toBeInTheDocument()
    expect(within(grid).getByLabelText(/System nominal voltage/)).toBeInTheDocument()
    expect(within(grid).queryByLabelText(/Demand calculation/)).not.toBeInTheDocument()

    const demand = screen.getByRole('region', { name: 'Active-demand configuration' })
    expect(within(demand).getByLabelText(/Demand calculation/)).toBeInTheDocument()
    expect(within(demand).getByLabelText(/Demand averaging window/)).toBeInTheDocument()
    expect(within(demand).queryByLabelText(/Nominal grid frequency/)).not.toBeInTheDocument()

    const zeroCrossing = screen.getByRole('region', { name: 'Zero-crossing configuration' })
    expect(within(zeroCrossing).getByLabelText(/Enable measurement/)).toBeInTheDocument()
    expect(within(zeroCrossing).getByLabelText(/^Mode/)).toBeInTheDocument()
    expect(within(zeroCrossing).queryByLabelText(/Measurement connection/)).not.toBeInTheDocument()
    expect(within(zeroCrossing).queryByLabelText(/Demand/)).not.toBeInTheDocument()
  })
})
