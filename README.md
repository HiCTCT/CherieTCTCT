# Meta Competitor Ad Library

Internal dashboard for browsing and analysing competitor ads from the Meta Ad Library. Surfaces qualified ads (score ≥ 7.0) with sub-score breakdowns, AIDA framework mapping, funnel stage, and RACE stage classification.

## Tech Stack

- **Framework:** Next.js 14 (App Router)
- **Database:** SQLite via Prisma ORM
- **Language:** TypeScript
- **Data source:** CSV files in `meta-ad-library/`

## Getting Started

```bash
# Install dependencies
npm install

# Generate Prisma client
npx prisma generate

# Run migrations
npx prisma migrate dev

# Seed the database
npm run db:seed

# Start the dev server
npm run dev
```

The app runs on `http://localhost:3000` by default.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Start the development server |
| `npm run build` | Production build with lint and type-check |
| `npm run start` | Start the production server |
| `npm run db:seed` | Seed the database from CSV files |
| `npm run verify:runtime` | Run runtime verification checks (12 checks) |

## Project Structure

```
app/
  page.tsx                    # Dashboard with industry filter and search
  layout.tsx                  # Root layout
  ads/[id]/page.tsx           # Ad detail page
  industries/page.tsx         # Industries list
  industries/[slug]/page.tsx  # Industry detail page
  api/ads/route.ts            # GET /api/ads endpoint
  components/                 # Shared UI components

lib/
  analysis/                   # Modular analysis layer (static + video)
  data/                       # CSV data loaders
  ingestion/                  # Database ingestion layer
  queries/                    # Prisma query layer (ads, industries)
  db.ts                       # Prisma client singleton

prisma/
  schema.prisma               # Database schema
  seed.ts                     # Database seeder

scripts/
  verify-runtime.ts           # Runtime verification script
```

## Seeded Data

The seed populates the database with:

- **314** industries and **508** clients (from Agency Accounts CSV)
- **1** competitor ("Seed Competitor")
- **11** qualified ads (6 STATIC, 5 VIDEO) — all in Healthcare - TCM
- Full sub-score breakdowns and framework mapping on every ad analysis record

Qualification threshold is **7.0 / 10**.
