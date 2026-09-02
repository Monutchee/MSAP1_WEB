import { describe, expect, it } from 'vitest'
import { meterCatalogPeriodForMqtt } from './mqttPeriod'

describe('MQTT meter period identity', () => {
  it('maps compact publication IDs to canonical attribute-catalog periods', () => {
    expect(meterCatalogPeriodForMqtt('seconds10')).toBe('seconds_10')
    expect(meterCatalogPeriodForMqtt('cycles150_180')).toBe('cycles_150_180')
    expect(meterCatalogPeriodForMqtt('min10')).toBe('minutes_10')
    expect(meterCatalogPeriodForMqtt('hour2_live')).toBe('hours_2_live')
    expect(meterCatalogPeriodForMqtt('demand')).toBe('demand')
  })

  it('leaves future already-canonical IDs intact', () => {
    expect(meterCatalogPeriodForMqtt('future_period')).toBe('future_period')
  })
})
