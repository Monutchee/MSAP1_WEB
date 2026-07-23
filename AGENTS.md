# MSAP1 web repository guidance

- This repository contains only the React/TypeScript/Vite frontend. Backend,
  nginx lifecycle, ADC ownership, and Yocto service definitions live in their
  respective MSAP1 repositories.
- Use the versioned external JSON API under `/api/v1`. Do not access RPMsg,
  DMA devices, or the acquisition daemon's Unix socket here.
- Read `/api/v1/meter/readings`; voltage and current fields are PL-computed RMS
  values. Display user-facing channels CH0 through CH6. Keep CH7/VCM in the API
  model for future reference monitoring, but do not render it yet.
- Keep the frontend target-only: the Yocto package installs `dist/` and must
  not install Node.js or `node_modules` on the device.
- Before handing off a change, run `npm ci` and `npm run build`.
