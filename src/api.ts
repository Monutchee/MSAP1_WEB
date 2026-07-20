export interface Session {
  username: string
  role: string
}
export interface AcquisitionHealth {
  running: boolean
  record_available: boolean
  records: number
  bytes: number
  read_errors: number
  invalid_records: number
  sequence_gaps: number
  configuration_generation: number
}

export interface AdcHealth {
  healthy: boolean
  spi_responsive: boolean
  initialized: boolean
  init_complete: boolean
  configuration_match: boolean
  capture_active: boolean
  fifo_ok: boolean
  headers_valid: boolean
  meter_configured: boolean
  meter_generation_match: boolean
  dc_offset_removal: boolean
  sample_rate_hz: number
  frames: number
  fifo_overflows: number
  header_errors: number
}

export interface SystemHealth {
  healthy: boolean
  acquisition: AcquisitionHealth
  adc: AdcHealth
  backend_running: boolean
  nginx_running: boolean
}

export interface MeterChannel {
  index: number
  name: string
  unit: string
  valid: boolean
  mean_micro_units: number
  rms_count: number
  rms: number
}

export interface MeterReadings {
  sequence: number
  configuration_generation: number
  sample_rate_hz: number
  rms_window_samples: number
  status: number
  capture_frames: number
  header_errors: number
  fifo_overflows: number
  packetizer_drops: number
  hub_drops: number
  channels: MeterChannel[]
}

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new ApiError(response.status, payload.error ?? `Request failed (${response.status})`)
  }
  return payload as T
}

export const api = {
  login: (username: string, password: string) =>
    request<{ status: string }>('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request<{ status: string }>('/api/logout', { method: 'POST' }),
  session: () => request<Session>('/api/v1/session'),
  health: () => request<SystemHealth>('/api/v1/health'),
  meterReadings: () => request<MeterReadings>('/api/v1/meter/readings'),
}
