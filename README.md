# MSAP1 web interface

React, TypeScript, and Vite frontend for the MSAP1 AD7771 diagnostic API. The
UI shows raw signed ADC counts; it does not label values as volts or amperes
until board calibration is available.

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
