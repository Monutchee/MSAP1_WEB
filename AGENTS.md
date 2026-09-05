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
- Configuration → Waveform owns waveform archive retention and optional
  MNCWF identity/calibration settings. Blank identity and Unknown calibration
  are allowed; any known calibration status requires an ID. These fields
  affect future captures only. Power Quality owns event detection/capture
  policies, not global waveform identity or retention. Each form reads the
  latest settings before saving and changes only its own fields.
- Persistent product configuration is owned by `msap1-settings`. Typed
  Configuration forms update the complete document through
  `PUT /api/v1/settings/active`; a successful request hot-applies and
  atomically saves the settings. Do not persist settings in browser storage.
  Factory reset remains an administrator-only, explicitly confirmed operation.
- Treat `metering.measurement_topology` as presentation metadata. Use `wye` to
  label the nominal voltage L-N and `delta` to label it L-L, but never infer a
  topology from readings or change/reconstruct metrology algorithms in the
  browser.
- Configuration -> Meter edits the physical ADC CH0--CH3 phase assignment and
  per-channel direction through `metering.current_wiring`. Keep A/B/C/N a
  permutation, implement manual phase changes as swaps, preserve directions
  when applying ABC/ACB presets, and display requested-versus-active health.
  Meter and waveform data are already canonical; never remap them in the
  browser.
- The Sequence reading view may display the backend's authoritative sequence
  magnitudes and unbalance ratios. Do not synthesize sequence angles or a polar
  sequence plot until those angles are explicitly published by the API.
- The Energy & Demand reading view consumes only the authoritative
  `/api/v1/meter/energy` and `/api/v1/meter/demand` models. Energy, demand,
  session IDs, sample anchors, and reset epochs arrive as decimal strings;
  format them with `BigInt` and never route authoritative values through
  JavaScript `Number`. Keep quadrants I--IV explicit with their P/Q1 sign
  labels. Reset controls are administrator-only, require confirmation, and
  send the displayed expected epoch with a fresh idempotency key.
- Historian energy/demand points retain an exact decimal string and reset
  epoch. A plotting-only numeric copy is acceptable, but graph series must
  break when the epoch changes so a reset is never rendered as consumption or
  a continuous peak history.
- Configuration -> Modbus edits `ProductSettings.modbus` through the same
  complete-document settings endpoint. Keep TCP/RTU validation aligned with
  the backend schema; the browser must never bind sockets or open serial ports.
- Use the backend's canonical `/api/v1/meter/attributes` descriptors for every
  selectable meter field. `AttributePicker` is the shared History, MQTT, and
  Data Logging control; do not add page-local ID/key/unit lists. Filter by
  usage and selected historian period, search label/key/group/unit, and make
  invalidated selections visible before removing them.
- Configuration -> Data Logging edits typed jobs and Data Channels through the
  dedicated `/api/v1/data-logging` API. Keep Local-only mutually exclusive
  with remote channels, show HTTP/FTP insecure-transport acknowledgement, and
  expose only protocol-relevant authentication and verification fields. A save
  must never contact an endpoint; channel testing is an explicit zero-data
  action.
- History -> Generated Files uses bounded status/list/detail/preview/download
  responses from the Data Sender. Downloads remain authenticated and
  manifest-authorized by the backend; the browser must never construct or
  expose a target filesystem path. Distinguish retained payloads from completed
  metadata and surface missing/damaged payload health as critical.
- Keep historian cleanup and generated-file cleanup separate in Management.
  Discarding any incomplete artifact requires an additional explicit
  confirmation and `discard_unsent`; never silently broaden one cleanup action
  to another persistence domain.
- The authenticated Waveforms explorer lists persisted sessions returned by
  `GET /api/v1/waveforms`. View/download requests use the WebEngine-protected
  `/protected/waveforms/` nginx routes. Keep binary parsing and plotting in the
  modular `src/waveform/` surface; support legacy eight-channel files while
  presenting new seven-channel files in raw or profile-converted units.
- Keep the frontend target-only: the Yocto package installs `dist/` and must
  not install Node.js or `node_modules` on the device.
- Before handing off a change, run `npm ci` and `npm run build`.
