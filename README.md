# AgroManage

Assign farm work, get photo proof with time and GPS, approve from anywhere.

## Why you saw "HTTP 404"
GitHub Pages only serves files. It cannot run `server.js`. This version handles both cases:

| Where it is opened | What happens |
|---|---|
| **A Node host** (Render, Railway, Fly.io, VPS, your PC with `node server.js`) | Real multi-user app: accounts, live updates between phones, photos on the server, optional AI review. |
| **GitHub Pages / a plain file** | **Demo mode** automatically. Everything works (sign up, tasks, photos, chat, stock) but is saved only in that one browser. Good for showing people the design. |

## Run it for real
```
node server.js
```
Open the address it prints. Needs Node 18+, nothing to install.

### Deploy on Render
1. Push this folder to GitHub (keep `server.js` at the top level).
2. Render: New > Blueprint (uses `render.yaml`) or New > Web Service, start command `node server.js`.
3. Open the `https://...onrender.com` address. https gives you camera and GPS on phones.
4. Free plans lose data on restart; the Blueprint adds a 1 GB disk (paid) at `/var/data`.

### GitHub Pages demo
Settings > Pages > Source: **GitHub Actions** (the workflow in `.github/workflows` publishes `public/`). Or choose "Deploy from a branch", folder `/ (root)`; the root `index.html` forwards to `public/`.

## Accounts
Sign up with name + password and receive a code like `AM-7K4Q2X`. Sign in with code + password. Max 5 members (`MAX_MEMBERS`). First account is the owner.

## Pictures
`public/img/agro1..agro7.jpg` (backgrounds) and `t1..t3.jpg` (gallery) are already included. Replace by keeping the names. `node embed-images.js` can bake them into `index.html` if you want.

## Settings
`PORT`, `DATA_DIR`, `MAX_MEMBERS`, `ANTHROPIC_API_KEY` (AI photo review), `AI_MODEL`, `SSL_KEY`/`SSL_CERT`.

Edit `public/site.json` for the "Made by" credit, portfolio link and gallery captions.
