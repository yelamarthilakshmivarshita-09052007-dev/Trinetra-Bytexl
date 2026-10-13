# Trinetra — Digital Risk Protection

A runnable React + Express prototype for the Digital Risk Protection – Social & App Monitoring hackathon. A company registers its brand once; Trinetra then automatically searches configured public sources using the registered brand name, keywords, official social handles, and official app names, analyzes relevant results, and shows explainable findings.

## Included
- Brand profile with official social handles/URLs and official app names, publishers, and package IDs.
- Automatic source discovery after brand registration and when Start Monitoring is selected. No fabricated candidates are preloaded into live findings.
- Source monitoring: Apple App Store search and optional SerpAPI public-web discovery restricted to recognized social profile URLs and Google Play app-detail listings. Candidate discovery starts from the registered brand profile; there is no manual test-candidate interface.
- Detection engine: normalized name similarity using Levenshtein distance, added brand terms, spacing variants, risky-language indicators, app publisher mismatch, description overlap, supplied indicator signals.
- Computed score and explainable evidence for every analyzed candidate.
- Official asset exclusion before threat scoring.
- Persisted brand profiles, candidates, findings, simple statuses, and scan results.
- MongoDB persistence when `MONGODB_URI` is set; local JSON persistence for local demo.
- Responsive dashboard and a blank first-run registration flow.

## Run locally in VS Code
Requirements: Node.js 20+ and npm.

1. Extract the ZIP and open this folder in VS Code.
2. Open Terminal in the project root.
3. Install packages:
   ```bash
   npm install
   npm --prefix client install
   ```
4. Start backend and frontend:
   ```bash
   npm run dev
   ```
5. Open `http://localhost:5173`.

The frontend proxies `/api` requests to `http://localhost:5000`.

## Live demo walkthrough

1. Register the company once with the brand name, keywords, official social handles/URLs, and official app identities.
2. After saving, Trinetra automatically starts a source discovery scan using the registered identifiers. No suspicious profile URL needs to be entered.
3. Open **Source monitoring** to run another scan or choose Social media / App Stores.
4. Open **Social monitoring** and **App monitoring** to review discovered candidates, risk scores, and explanations. Ordinary websites and generic search pages are not mislabeled as social profiles or app listings.
5. Confirm registered official handles and apps are excluded from impersonation scoring.
6. Open **Findings** to review discovered candidates and update investigation status. The application does not create fabricated candidates when live providers are unavailable.


## Month-long hosted evaluation (Render)

The app uses same-origin relative API paths (`/api/...`) so the frontend does not call a judge's own `localhost`. The Express server serves `client/dist` when `NODE_ENV=production`. A Render Blueprint is included in `render.yaml`.

1. Push this folder to a GitHub repository. Ensure `.env` is not committed; `.gitignore` excludes it.
2. In Render, create a Blueprint from the repository and review `render.yaml`, or create a Web Service manually.
3. Use build command `npm install && npm --prefix client install && npm --prefix client run build`; start command `node server.js`; health check `/api/health`.
4. Set `NODE_ENV=production`. Set `MONGODB_URI` to a real MongoDB Atlas connection string for persistent hosted storage. Set `MONGODB_DB=brandshield`. Set `SERPAPI_API_KEY` if public-web search is needed. Set `FRONTEND_ORIGIN` to the exact public origin if you choose to restrict CORS; same-origin deployment normally does not need cross-origin browser requests.
5. After deploy, open the public site and `/api/health`, then verify brand registration, source discovery, and finding status updates.

**Persistence requirement:** production startup now requires a working `MONGODB_URI`. It will not silently fall back to ephemeral local JSON if MongoDB is missing or unreachable. The free hosting tier may sleep or have service limits; check the host's current terms.

**Credentials:** never commit `.env` or paste API keys into frontend code. Configure secrets in the hosting dashboard.

## Deployment
This repository can be deployed as one Node service that serves the built React app and API.

1. Create a MongoDB Atlas database and a least-privilege database user.
2. Push this folder to a private GitHub repository. Never commit `.env`.
3. In a Node hosting service (e.g. Render), use:
   - Build command: `npm install && npm --prefix client install && npm --prefix client run build`
   - Start command: `node server.js`
   - Environment variables: `NODE_ENV=production`, `MONGODB_URI=<your URI>`, optionally `MONGODB_DB=brandshield`, and `FRONTEND_ORIGIN=<deployed origin if needed>`.
4. The server serves `client/dist` in production. Test `/api/health` and the public website after deployment.
5. Configure Atlas network access carefully. Do not expose database credentials in frontend code.

## Scope and honest limitations
- After registration, the prototype automatically searches supported public sources using registered brand identifiers. Apple App Store search uses Apple's public Search API; social and Google Play public-web discovery require `SERPAPI_API_KEY`. No API keys are included.
- Public-web search is not the same as direct integration or a complete crawl of Instagram, Facebook, X, TikTok, LinkedIn, Google Play, or Apple's App Store. Coverage depends on each provider, indexing, query limits, and access permissions. Production-scale monitoring would require approved platform/provider integrations and scheduled recurring jobs.
- The rule-based score is a triage signal, not proof of abuse. False positives are possible; verify findings before taking action.
- MongoDB is required for hosted production persistence. Local JSON is used only when running outside production without `MONGODB_URI`.
- This is a single-workspace hackathon prototype. Authentication and multi-tenant access controls are not implemented. Do not use it for sensitive customer data or expose it as a production commercial service without adding authentication, authorization, and tenant isolation.
- No fabricated candidates are seeded. Older local/MongoDB demo records from earlier builds are removed during startup migration. Registering a different company clears the previous workspace and starts discovery for the new brand.

## Architecture
```text
Registered brand identifiers
                |
                v
 Apple Search API + optional SerpAPI public-web search
                |
                v
      Candidate validation
                |
                v
 Brand profile + official asset exclusion
                |
                v
 Name normalization / similarity / metadata rules
                |
                v
 Computed score + explainable evidence
                |
       +--------+---------+
       |                  |
       v                  v
 Social + app monitoring   Explainable risk score
       |                  |
       +--------+---------+
                |
                v
       MongoDB or local JSON
                |
                v
      React analyst dashboard
                |
                v
       Findings and simple status workflow
```


## Trinetra company registration

The first run starts with a blank brand profile and opens the registration form. The project logo at `client/public/trinetra-logo.svg` is the Trinetra product logo; it is not automatically used as the company logo URL. Enter the company name, optional logo URL, official website, keywords, social accounts and apps. The current prototype stores one active brand profile; this registration form updates that active profile and is not multi-tenant company registration. Separate company workspaces require authentication and tenant isolation, which are not included.


## Focused hackathon scope

This version focuses on brand profiles, social-media monitoring, app-store monitoring, source discovery, explainable look-alike detection, official-asset exclusion, simple finding statuses, and the overview dashboard. Optional threat graphs, evidence-vault pages, investigation timelines, report-export pages, recurrence history, and website-domain checks have been removed from the user interface.


### Fix for continuous nodemon restarts

The development server writes its local persistence file under `data/store.json`. Nodemon must not watch the `data/` folder, because writing that file during startup or requests can trigger another restart. The `server:dev` script and `nodemon.json` now watch `server.js` only and ignore `data/` and the frontend folder.
