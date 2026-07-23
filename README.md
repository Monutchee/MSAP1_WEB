# MSAP1 web interface

React, TypeScript, and Vite frontend for the MSAP1 meter API. The UI displays
PL-calculated RMS current for ILA, ILB, ILC, and ILN, plus RMS voltage for VLA,
VLB, and VLC through `GET /api/v1/meter/readings`. CH7/VCM remains available
in the API model for future reference monitoring but is not rendered.

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
