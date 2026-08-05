# MSAP1 web repository guidance

- This repository contains only the React/TypeScript/Vite frontend. Backend,
  nginx lifecycle, ADC ownership, and Yocto service definitions live in their
  respective MSAP1 repositories.
- Use the versioned external JSON API under `/api/v1`. Do not access RPMsg,
  DMA devices, or the acquisition daemon's Unix socket here.
- Read `/api/v1/meter/readings`; voltage and current fields are PL-computed RMS
  values. Display user-facing channels CH0 through CH6. Keep CH7/VCM in the API
  model for future reference monitoring, but do not render it yet.
- Grid frequency is PL-computed from CH6/VLA. Display unavailable signal states
  without treating them as acquisition failures; only arithmetic faults degrade
  system health.
- Display both PL-measured ADC DCLK and `ADC_DRDY_N` falling-edge rates in the
  health metrics so capture-rate faults can be distinguished from DCLK faults.
  Expose the backend's ADC sample-rate-match verdict in pipeline health.
- The administrator-only Developer log view reads the bounded, cursor-paginated
  `/api/v1/developer/logs` endpoint. Keep journal access in the backend, cap
  retained browser entries, and use cursor continuation rather than timestamps
  for live updates.
- The Developer Overview reads `/api/v1/developer/temperatures` and displays
  the label-discovered LPD, FPD, and PL temperatures. Keep this diagnostic view
  administrator-only.
- The administrator-only Configuration Waveform view uses
  `GET /api/v1/waveforms` and `POST /api/v1/waveforms/trigger`. It displays
  daemon-owned history/session state and must not access DMA devices or raw
  waveform storage directly.
- Persistent product configuration is owned by `msap1-settings`. Typed
  Configuration forms update the complete document through
  `PUT /api/v1/settings/active`; a successful request hot-applies and
  atomically saves the settings. Do not persist settings in browser storage.
  Factory reset remains an administrator-only, explicitly confirmed operation.
- The authenticated Waveforms explorer lists persisted sessions returned by
  `GET /api/v1/waveforms`. View/download requests use the WebEngine-protected
  `/protected/waveforms/` nginx routes. Keep binary parsing and plotting in the
  modular `src/waveform/` surface; support legacy eight-channel files while
  presenting new seven-channel files in raw or profile-converted units.
- Keep the frontend target-only: the Yocto package installs `dist/` and must
  not install Node.js or `node_modules` on the device.
- Before handing off a change, run `npm ci` and `npm run build`.
