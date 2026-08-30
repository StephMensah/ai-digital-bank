# Partner logos

Every statement row asks for `logos/<slug>.svg`. If the file is there it is used. If it is
not, the row falls back to a generated mark in the partner's brand colour — so the statement
never looks broken while you are still collecting assets.

## Adding a partner

1. Get the logo from the partner's brand pack. Under your payment-partner agreement they will
   normally supply an SVG and a usage note; ask for the mark, not the full lock-up, since the
   tile is square.
2. Save it as `logos/<slug>.svg` using the slug in `manifest.json`.
3. Nothing else. No code change, no rebuild of the merchant list.

## Slugs

- `bolt.svg` — Bolt (#34D186)
- `uber.svg` — Uber (#111111)
- `yango.svg` — Yango (#FF3D00)
- `stc.svg` — STC (#0B6E4F)
- `melcom.svg` — Melcom (#E4002B)
- `shoprite.svg` — Shoprite (#E31E24)
- `palace-mall.svg` — Palace Mall (#7A3E9D)
- `jumia.svg` — Jumia (#F68B1E)
- `kfc.svg` — KFC (#A3080C)
- `papaye.svg` — Papaye (#D42027)
- `ecg.svg` — ECG (#F5A623)
- `ghana-water.svg` — Ghana Water (#0A7CC1)
- `dstv.svg` — DStv (#0D5AA7)
- `surfline.svg` — Surfline (#00A9E0)
- `mtn.svg` — MTN (#FFCB05)
- `telecel.svg` — Telecel (#E4002B)
- `at.svg` — AT (#0057B8)
- `ashesi-university.svg` — Ashesi University (#8C1D40)
- `adom-poultry-farms.svg` — Adom Poultry Farms (#5E8C31)
- `coastal-foods-ltd.svg` — Coastal Foods Ltd (#0E6BA8)
- `ridge-hotel.svg` — Ridge Hotel (#8A6D3B)
- `global-marine-ltd.svg` — Global Marine Ltd (#455A64)
- `payroll.svg` — Payroll (#37474F)
- `gra.svg` — GRA (#006B3F)
- `ssnit.svg` — SSNIT (#1A5632)
- `netflix.svg` — Netflix (#E50914)
- `spotify.svg` — Spotify (#1DB954)
- `mensah-properties.svg` — Mensah Properties (#6D4C41)
- `ai-digital-bank.svg` — AI-Digital Bank (#14B8AC)

## Rules worth keeping

- Square marks only. The tile is square with 13% padding; wordmarks get letterboxed and look wrong.
- SVG where possible, PNG at 2× if not. Call `FID.setLogoDir('/assets/partner-logos/')` if you
  serve them from elsewhere.
- Keep the file the partner gave you. Do not recolour or redraw a mark — most brand agreements
  forbid it, and a redrawn logo is the kind of detail that ends up in a dispute.
- A partner who leaves the scheme: delete the file. The fallback takes over the same day.
