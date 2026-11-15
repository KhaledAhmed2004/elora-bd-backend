# BD Shop API

NestJS 12 (ESM) + Prisma 7 + PostgreSQL 17. Serves the Next.js shop in `../frontend`.

## First run

```bash
cp .env.example .env        # then fill JWT secrets + SEED_ADMIN_PASSWORD
npm install                 # also generates the Prisma client
npm run db:up               # PostgreSQL in Docker (port 5432)
npm run db:migrate          # create tables
npm run db:seed             # owner account + the shop's catalog
npm run start:dev           # http://localhost:4000/api/health
```

## Useful

| Command | What it does |
| --- | --- |
| `npm run db:studio` | Browse/edit the database in the browser |
| `npm run db:migrate -- --name <change>` | After editing `prisma/schema.prisma` |
| `npm run test:e2e` | API tests (needs the database running) |

`prisma/seed-data.json` is the demo catalog (originally exported from the frontend mock data).

Money is whole Taka (`Int`). Phone numbers are stored as `01XXXXXXXXX`.

## Admin auth

Every route needs a signed-in user unless marked `@Public()`. Admin routes add
`@AdminOnly()` (any staff) or `@AdminOnly(...ROLE_GROUPS.manager)` / `.owner`.

| Endpoint | |
| --- | --- |
| `POST /api/admin/auth/login` | `{ email, password }` → `{ accessToken, expiresIn, admin }` + httpOnly refresh cookie. 5 tries/min per IP |
| `POST /api/admin/auth/refresh` | New access token from the cookie (rotates it; reusing an old one signs that login out) |
| `POST /api/admin/auth/logout` | Revokes the cookie's session |
| `GET /api/admin/auth/me` | Current admin (`Authorization: Bearer <accessToken>`) |
| `POST /api/admin/auth/change-password` | Signs out all other devices |
| `GET/POST /api/admin/staff`, `PATCH /api/admin/staff/:id` | Owner only: add staff, change role, deactivate, reset password |

Roles: **OWNER** everything · **MANAGER** orders, catalog, reports · **STAFF** orders, calls, customers.
Access tokens last 15 min; refresh tokens 30 days (max 90 days per login).

## Catalog

Shop (public):

| Endpoint | |
| --- | --- |
| `GET /api/categories`, `/api/categories/:slug` | Menu tree; one category + parent/children |
| `GET /api/products` | `?q=&category=&min=&max=&size=M,L&color=Navy&stock=1&sale=1&sort=newest\|popular\|price-asc\|price-desc\|discount&page=&limit=` |
| `GET /api/products/facets` | Filter options for `?category=&q=` |
| `GET /api/products/:slug`, `/:slug/related` | Product page (active or hidden; drafts 404) |
| `GET /api/products/collections/:name` | `featured`, `new-arrivals`, `best-sellers`, `flash-sale` |
| `GET /api/products/suggest?q=` | Header search |
| `GET /api/banners` | Home slider |
| `POST /api/coupons/check` | `{ code, subtotal }` → discount (20/min per IP) |

Admin: `/api/admin/products` (GET list/one, POST, PUT /:id, DELETE /:id),
`/api/admin/categories`, `/api/admin/banners` (+ `PATCH /order`), `/api/admin/coupons`.
All staff can read products/categories; changes need MANAGER or OWNER.
Public responses never include `costPrice`.

## Checkout & orders

Shop (public, rate-limited per IP):

| Endpoint | |
| --- | --- |
| `POST /api/checkout/quote` | `{ items:[{productId,variantId,quantity}], couponCode?, district? }` → live prices, stock problems, discount, delivery, total, advance |
| `POST /api/orders` | Place an order. Prices, stock, coupon, delivery and the advance rule are all recomputed on the server (5/min) |
| `POST /api/orders/track` | `{ orderNumber, phone }` — both must match |
| `POST /api/checkout/lead` | Phone + cart from the checkout form (incomplete-order follow-up) |
| `GET /api/settings` | Public shop settings (no courier costs) |

Admin (`/api/admin/orders`, any staff unless noted): list (`?status=&source=&q=&phone=&from=&to=`), `GET /counts`,
`GET /:id` (with fake-order risk), `POST` manual order, `PUT /:id` edit (before shipping),
`POST /:id/status`, `POST /:id/calls`, `PATCH /:id/note`, `POST /:id/advance`,
`POST /:id/return` (manager), `POST /bulk/status`, `POST /bulk/courier` (mock booking),
`POST /bulk/settle` (manager). Blacklist: `/api/admin/blacklist`. Settings: `PUT /api/admin/settings` (owner).

Stock leaves the shelf when an order is **confirmed** (not when it is placed) and comes back on cancel/return
(unless the return is damaged). Each stock change is a conditional update, so the last piece can't be sold twice.

## Other admin modules

| Area | Endpoints | Who |
| --- | --- | --- |
| Reviews | Shop: `GET/POST /api/products/:slug/reviews` (new ones wait for approval). Admin: `GET /api/admin/reviews`, `POST /status`, `PATCH /:id/reply`, `DELETE` `{ids}` | any staff |
| Incomplete orders | `GET /api/admin/incomplete-orders?status=active\|converted\|dismissed`, `POST /:id/notes`, `PATCH /:id/status`, `DELETE /:id`. Send `leadId` with a manual order to mark it recovered | any staff |
| Customers | `GET /api/admin/customers?q=&tag=&sort=`, `GET /:phone`, `PUT /:phone/tags`, `POST /:phone/notes`, `DELETE /:phone/notes/:id` | any staff |
| Expenses | `GET/POST /api/admin/expenses`, `DELETE /:id` | manager |
| Suppliers & purchases | `/api/admin/suppliers` (+ `/:id` ledger, `/:id/payments`), `/api/admin/purchases` (stock in; delete reverses) | manager |
| Reports | `GET /api/admin/dashboard` (all staff), `/api/admin/reports/profit-loss`, `/breakdown?by=product\|category\|district\|source`, `/courier` | manager |
| Activity log | `GET /api/admin/activity?group=&q=` | manager |

Dates are Bangladesh days (UTC+6): `?from=2026-11-01&to=2026-11-30`.
A product's stars and review count are recalculated from approved reviews whenever one is moderated.
