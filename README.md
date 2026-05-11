# BCAT Ops

Internal operations dashboard for BCAT dispatch — calendar scheduling, load management, driver schedules, and audit logging.

**Stack:** React 19 · TypeScript · Vite · Tailwind v4 · shadcn/ui · FullCalendar · Zustand

---

## Local Development

```bash
# 1. Install dependencies
npm install

# 2. Set up environment
cp .env.example .env
# Edit .env if you have a commercial FullCalendar license key

# 3. Start dev server (http://localhost:5173)
npm run dev
```

---

## Build

```bash
npm run build   # outputs to dist/
npm run preview # preview the production build locally
```

---

## Deploy (AWS Amplify)

Deployments are automatic. Every push to `main` triggers a new build and deploy via AWS Amplify.

**Manual deploy steps (first-time setup):**

1. Go to [AWS Amplify Console](https://console.aws.amazon.com/amplify/)
2. Click **"Host web app"** → Connect to GitHub
3. Select the `bcat-ops` repo and `main` branch
4. Amplify auto-detects `amplify.yml` — no manual config needed
5. Add environment variables in Amplify Console:
   - `VITE_FULLCALENDAR_LICENSE` → your license key

**To push an update:**

```bash
git add .
git commit -m "your message"
git push origin main
# Amplify auto-deploys within ~2 minutes
```

---

## Custom Domain

Live at: **https://ops.bcatcorp.com**

DNS is managed externally. The domain is connected via AWS Amplify's custom domain settings with an ACM SSL certificate.

---

## Environment Variables

| Variable | Description |
|---|---|
| `VITE_FULLCALENDAR_LICENSE` | FullCalendar license key. Use `GPL-My-Project-Is-Open-Source` for open-source use. |

See `.env.example` for the full list.
