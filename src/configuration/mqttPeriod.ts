/**
 * MQTT keeps its original compact wire IDs, while the canonical meter
 * attribute catalog uses descriptive period IDs. Keep that translation in
 * one place so labels, filtering, and invalid-selection checks agree.
 */
const MQTT_TO_CATALOG_PERIOD: Readonly<Record<string, string>> = {
  basic: 'basic',
  seconds10: 'seconds_10',
  cycles150_180: 'cycles_150_180',
  min10: 'minutes_10',
  hour2: 'hours_2',
  min10_live: 'minutes_10_live',
  hour2_live: 'hours_2_live',
  demand: 'demand',
}

export function meterCatalogPeriodForMqtt(period: string) {
  return MQTT_TO_CATALOG_PERIOD[period] ?? period
}
