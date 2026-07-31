# MSAP1 web interface

React, TypeScript, and Vite frontend for the MSAP1 meter API. The UI displays
PL-calculated RMS current for ILA, ILB, ILC, and ILN, plus RMS voltage for VLA,
VLB, and VLC through `GET /api/v1/meter/readings`. CH7/VCM remains available
in the API model for future reference monitoring but is not rendered.

The viewer-facing **About** tab displays the MNCOS/Yocto version, short image
build identifier, and software build date from `/api/v1/about`.

The main **Dashboard** contains live RMS readings and pipeline health. Meter
controls are separated under the administrator-only **Configuration → Meter**
view, including the grid-frequency zero-crossing settings.

Administrators can open **Developer → Overview** to monitor the ZynqMP LPD,
FPD, and PL temperatures discovered from their Linux hwmon labels, together
with the PL clock/rate and DMA acquisition counters moved out of the meter
view. The live cards retain a short browser-side history without adding
another target-side database.

**Developer → About** reports diagnostic MD5 fingerprints for the deployed PL
bitstream, both R5 firmware images, and the APU executables. These values help
identify deployed files; they are not security or integrity guarantees.

**Developer → Logs** presents the acquisition, web-backend/nginx, and firmware
lifecycle journal in one time-ordered view. The page supports component,
module, and severity filters, a normalized raw JSON view, and bounded live
updates using journald cursors. Journal access is provided only through the
authenticated backend API; the browser never reads the system journal
directly.

Administrators can open **Configuration → Waveform** to inspect raw history
capacity, sequence continuity, and completed sessions, then trigger a manual
pre/post capture. The browser sends only the trigger request; the acquisition
daemon owns the dedicated waveform DMA, history, time correlation, and file
materialization.

Node.js 20.19 or newer is required (the Yocto recipe currently builds with
Node.js 20.20).

```sh
npm ci
npm run build
```

For development, run `npm run dev`. Vite proxies `/api` to
`http://localhost:8080`. The target build is installed under
`/usr/share/msap1-web` and served by nginx.

The initial development login is `admin` / `admin`. Replace this temporary
authentication provider before production deployment.
