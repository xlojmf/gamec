# Deploy Catan to Coolify

Target website: **https://game.jmfserver.uk**  
Multiplayer endpoint: **https://game-api.jmfserver.uk**

The browser renders the 3D board. The VPS runs two Node containers: `web` serves the site; `game` runs room creation, authoritative rules and Socket.IO multiplayer. No GPU is required on the VPS.

Use the included **docker-compose.coolify.yml**. Keep `docker-compose.yml` for local development. The Coolify file builds both containers from source, adds health checks, persists matches, and leaves routing to Coolify's proxy.

## 1. Put this version in a Git repository

The deployment repository is **https://github.com/xlojmf/gamec**, branch **main**. Connect it to the existing **catan** project in Coolify using its Git integration or a deploy key if access requires one. Coolify must deploy the latest pushed commit containing the HTTPS endpoint changes and `docker-compose.coolify.yml`.

Include `public/assets/`, `public/sounds/`, the lockfile, Dockerfile, both Compose files and the new HTTPS endpoint code. Do not upload `node_modules/`, `dist/`, `work/` or your local `.env`. The Docker build now excludes local `.env` files and takes the public endpoint through a build argument.

## 2. Configure DNS

In the DNS zone for `jmfserver.uk`, add:

| Type | Name | Value |
|---|---|---|
| A | `game` | Your Coolify VPS public IPv4 address |
| A | `game-api` | The same VPS public IPv4 address |

Only add AAAA records if IPv6 is configured and reachable on this VPS. For the initial test, use DNS-only records if your DNS provider offers an additional proxy layer. Confirm both names resolve to the VPS before requesting certificates.

Coolify's proxy must be running and reachable on public ports **80 and 443**. The app does not need public host ports 3000 or 8000; these are internal container ports. Keep your existing Coolify management access as configured.

## 3. Create the Coolify application

In your Coolify project/environment, add a resource from the Git repository and select the intended branch. Choose **Docker Compose** as the build pack, with base directory `/` and Compose location `/docker-compose.coolify.yml`. Save/load the definition so both services appear. Use the Git application flow, rather than pasting this source-build file into an empty service. [Coolify Compose documentation](https://coolify.io/docs/applications/builds/docker-compose)

Configure these service domain fields:

| Coolify field | Enter exactly |
|---|---|
| Domains for `web` | `https://game.jmfserver.uk:3000` |
| Domains for `game` | `https://game-api.jmfserver.uk:8000` |

Those suffixes select **internal target ports**. Players browse `https://game.jmfserver.uk` without a port; the public API is `https://game-api.jmfserver.uk` without a port. Let Coolify generate routing labels and HTTPS certificates. [Coolify domain documentation](https://coolify.io/docs/core/networking/domains)

## 4. Set environment variables

In this application's Coolify Environment Variables, set:

```dotenv
VITE_GAME_SERVER_URL=https://game-api.jmfserver.uk
TURN_TIMEOUT_SECONDS=180
```

`VITE_GAME_SERVER_URL` is public configuration, not a secret. Make it available at **build time** if the UI offers a build-variable checkbox. The Compose file explicitly forwards it as a Docker build argument. It must contain `https://` and must **not** contain `:8000`, `/health`, `/rooms` or `/socket.io`.

Vite embeds this value into the browser bundle. After changing it, **rebuild/redeploy**, rather than only restarting containers. The previous client forced HTTP for the rooms API; this deployment revision uses the same configured HTTPS origin for REST and Socket.IO.

`TURN_TIMEOUT_SECONDS` is runtime configuration for `game`. After 180 seconds without progress, the watchdog can act for an idle player to keep play moving. You can use `600` for a slower first playtest. The minimum effective timeout is 5 seconds; setting 0 does not disable it.

Leave these values as defined in Compose:

- Web listens on internal port 3000.
- Game listens on internal port 8000.
- `FLATFILE_DIR=/data` stores matches and room records in the `catan-data` named volume.

## 5. Deploy and check service health

Click Deploy. The build installs dependencies, builds the website and game server, then starts `game` followed by `web`. Check both service logs and health status.

Open these addresses:

| Address | Expected result |
|---|---|
| `https://game.jmfserver.uk` | Landing page with island artwork |
| `https://game.jmfserver.uk/game?players=3` | Local 3-player table |
| `https://game.jmfserver.uk/online` | Online lobby |
| `https://game-api.jmfserver.uk/health` | Plain text `ok` |
| `https://game.jmfserver.uk/assets/astra/manifest.json` | JSON, version 2, including `details` |

Optional shell checks from your computer:

```bash
curl -fsS https://game-api.jmfserver.uk/health
curl -I https://game.jmfserver.uk
curl -i 'https://game-api.jmfserver.uk/socket.io/?EIO=4&transport=polling'
```

The Socket.IO polling request should return HTTP 200 with an opening packet beginning `0{` and a session ID. This checks the transport endpoint; the actual browser playtest below checks live connections. In browser DevTools, confirm requests use the HTTPS API hostname and a live Socket.IO connection is established. A WebSocket upgrade normally shows status 101; Socket.IO may also use polling.

## 6. Online multiplayer acceptance test

Use **three separate browser profiles/devices** for the first test. Avoid relying on duplicated tabs: credentials are stored in each tab's sessionStorage and a duplicated tab may copy them. Ideally include one phone on mobile data to test access from outside your home network.

1. On the website, open Online and create a **3-player** room.
2. Share its invite link or room code. On each device, choose a different seat and name.
3. Confirm names/seats synchronize. Only the creator should be able to start.
4. Start the match. Everyone should see the same island, opening rolls and turn order.
5. Complete both rounds of settlement-and-road setup. Confirm moves appear on all devices and only the active player can place.
6. Roll dice. Check both dice, the total and produced resources agree across clients.
7. Verify each player sees their own resource/development cards. Opponents should show **card counts**, without resource identities or unplayed development card identities. Local play intentionally has open hands.
8. Try a bank trade and a player trade; accept/decline from the recipient's device. Confirm only one transaction completes.
9. Build a settlement, road and city when affordable. Play a Knight/development card when legal and confirm its announcement appears for everyone.
10. Refresh one player's existing tab. It should reconnect to the same seat. Briefly disconnect/reconnect a device and check that the authoritative state catches up.
11. Check sound after an initial click: March, Knight and City controls, volume and stop. Browsers can block autoplay until interaction; that is expected.
12. Repeat a short setup with **4 players**. On mobile, check scrolling, hand cards, controls and number plates, including 12.

## 7. Persistence and updates

Keep **one `game` replica**. The current persistence layer is a local FlatFile store; it is not a shared database for horizontally scaled game servers.

After creating a test match, restart/redeploy the same Coolify resource. Keep players' browser tabs open and confirm the room and match survive a refresh/reconnect. The `catan-data` volume must remain mounted at `/data`; redeploying the same resource should retain that volume. Deleting the resource/volume, deploying under a new resource, or changing storage can lose or separate its saved games.

For a consistent backup, stop the game service, copy/archive its `/data` volume using your VPS backup tooling, and restart it. Test restoration into a separate test resource before relying on backups. Restoring server data does not restore credentials from a cleared browser session. There is no account-based seat recovery; closing a tab or clearing browser storage can lose access to that seat.

Push future changes to the configured branch and redeploy. Schedule game-service updates between matches when possible because connections briefly drop during a restart.

## Troubleshooting

| Symptom | Check |
|---|---|
| Site loads, but Create room fails | Check API `/health`, `VITE_GAME_SERVER_URL`, and rebuild after changes. DevTools must not show `http://`, localhost, or `:8000` API requests. |
| HTTPS certificate fails | DNS for both names, reachable ports 80/443, proxy logs, and any incorrect AAAA record. |
| 502 / No available server | Service logs/health and exact domain target ports: web 3000, game 8000. |
| Rooms work, live moves do not | Inspect `/socket.io/` requests and WebSocket upgrade through every proxy. The whole API hostname must reach `game`, not only `/rooms`. |
| Lobby API blocked by an access/login page | Check any extra proxy authentication applied to the API domain; Socket.IO and room requests must reach the game server. |
| Build exits with code 137 / killed | Inspect VPS memory and concurrent builds; add build memory/swap or build on a larger machine. |
| Room missing after redeployment | Verify the same resource and persistent volume are in use and `/data` is mounted. |
| Player cannot reclaim a seat | Use their original tab/session. New browser sessions do not have the seat credentials. |
| Someone's turn advances unexpectedly | Check the configured idle watchdog timeout. |
| Silent audio on first load | Click once, then use the sound controls and check browser/site audio permission. |

## Verification scope

Local validation passed: TypeScript, all **131 tests** (including four HTTPS endpoint regressions and real multiplayer socket integration), Compose configuration validation, and production builds of both Coolify services with the intended public API URL.

The project was checked locally for this deployment revision. The actual VPS, DNS, certificates and Coolify proxy still need the above remote checks; they have not been accessed or deployed from this task. This is a first online playtest deployment, not a load-tested public service. There are no player accounts, and the server currently accepts cross-origin clients.
