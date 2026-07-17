# MSAP1 web repository guidance

- This repository contains only the React/TypeScript/Vite frontend. Backend,
  nginx lifecycle, ADC ownership, and Yocto service definitions live in their
  respective MSAP1 repositories.
- Use the versioned external JSON API under `/api/v1`. Do not access RPMsg,
  IIO, POSIX shared memory, or the acquisition daemon's Unix socket here.
- ADC values are signed 24-bit raw counts stored in JavaScript numbers. Do not
  label them as physical units without calibrated board transfer functions.
- Keep the frontend target-only: the Yocto package installs `dist/` and must
  not install Node.js or `node_modules` on the device.
- Before handing off a change, run `npm ci` and `npm run build`.
