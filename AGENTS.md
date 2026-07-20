# MSAP1 web repository guidance

- This repository contains only the React/TypeScript/Vite frontend. Backend,
  nginx lifecycle, ADC ownership, and Yocto service definitions live in their
  respective MSAP1 repositories.
- Use the versioned external JSON API under `/api/v1`. Do not access RPMsg,
  DMA devices, or the acquisition daemon's Unix socket here.
- Read `/api/v1/meter/readings`; voltage fields are PL-computed RMS volts.
  Current fields remain explicitly invalid and display no fabricated value.
- Keep the frontend target-only: the Yocto package installs `dist/` and must
  not install Node.js or `node_modules` on the device.
- Before handing off a change, run `npm ci` and `npm run build`.
