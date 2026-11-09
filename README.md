# FAKE-CHECK

A web page that checks images, video and audio for AI-generated or deepfake content. A small Node server sends uploads to the Sightengine API, so your key stays on the server. No sign-in: each visitor gets 5 free checks a day, counted by IP address.

Results are estimates, not forensic proof.

## Run on your computer
1. Install Node 18 or newer.
2. Copy `.env.example` to `.env` and paste your Sightengine API user and API secret.
3. Run `node server.js` and open http://localhost:3000.

## Put it on Render
1. Upload this folder to a private GitHub repository. Do not upload a real `.env`.
2. In Render: New, then Web Service, then pick the repository.
3. Start Command: `node server.js`. Build Command: leave empty. Instance type: Starter.
4. Environment variables: `SIGHTENGINE_API_USER` and `SIGHTENGINE_API_SECRET` (both required), `NODE_ENV=production`, and `DATA_DIR=/data`.
5. Add a Disk (Advanced): mount path `/data`, 1 GB. Without it, daily counts reset on every restart.
6. Create the service and open the address Render shows.
7. Custom domain: Settings, then Custom Domains. Add the DNS records Render shows in your domain provider (GoDaddy: My Products, DNS).

## Ads
Two empty 4-inch ad areas sit at the top and bottom. In `public/index.html`, find `ad-top` and `ad-bottom` and paste your ad network code in place of the label.

## Things to know
- The 5-a-day limit is per IP address. People on the same network (an office, a mobile carrier) share one count, and someone who changes network can check more. Add a login later if you need a strict limit.
- Every check uses operations on your Sightengine plan (images with both models use more than one operation, and videos use one per frame checked). Lower `DAILY_LIMIT` if usage grows.
- Images and videos under 1 minute are supported. Audio is not, and longer videos would need Sightengine's asynchronous endpoint.
- Sightengine's `deepfake` model looks for swapped or edited faces, so it only matters for photos with faces.
- Add Terms of Service and a Privacy page. The "Terms of Service" link on the page is a placeholder.
- `/health` returns `{"ok":true}` for host health checks.
