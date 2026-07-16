# SignalPilot

Aplicație locală (stil PinPilot) care citește **date live de pe MEXC**, calculează indicatori tehnici + concepte Smart Money **determinist** (nu din poze) și produce decizii **UP/DOWN** pentru contracte event-futures pe **10 / 30 minute**. Scanează automat și te **alertează** când apare un setup bun. Opțional folosește **Gemini** pentru justificare în limba română.

## Ce face

- Se conectează la MEXC (endpoint public, **fără cheie API**) și ia lumânări pe 5m + 15m.
- Calculează: **RSI, MACD, Bollinger, EMA 9/20/50, ATR, volum vs. medie**.
- Detectează **Smart Money**: FVG / Inversion FVG, Liquidity Sweep (SFP), Market Structure Shift (CHoCH), structură HH/HL/LH/LL.
- Combină totul prin confluență ponderată → output standardizat în **5 pași**:
  `Direcție · Interval (10/30 min) · Justificare · Nivel de încredere · Ce ar invalida`.
- **Scanner automat**: verifică la câteva secunde și dă **alertă (sunet + notificare)** doar când încrederea ≥ pragul ales.
- **Backtest** pe istoric real: îți arată win-rate-ul pe niveluri de încredere, **fără look-ahead**.

## Cum pornești (la fel ca PinPilot)

```bash
npm install
npm start
```

Apoi deschide în browser: **http://localhost:3001**
(Portul 3001 e ales special ca SignalPilot să ruleze în paralel cu PinPilot, care folosește 3000.)
Ca să oprești: închide fereastra / `Ctrl+C`.

Pe Windows poți da dublu-click pe **`start.bat`**.

## Setări (în UI, se salvează în `config.json`)

- **Simboluri**: format MEXC fără underscore, ex. `BTCUSDT`, `ETHUSDT`.
- **Interval scanare** (secunde, minim 3).
- **Alertă de la încrederea**: `Scăzut` / `Mediu` / `Ridicat`.
- **Gemini** (opțional): activează + lipește cheia + alege modelul. Cheia rămâne **local**, pe mașina ta, în `config.json` (care e în `.gitignore`).

## Cum e gândit (important)

- **Decizia UP/DOWN e determinist** — vine din numere reale, nu dintr-o interpretare de imagine. Se poate reproduce și testa.
- **Gemini NU decide direcția** — primește doar numerele deja calculate și scrie justificarea + un check de acord/risc. Dacă nu e configurat, aplicația folosește propriul text.
- **Poll REST, nu WebSocket** — pentru ferestre de 10/30 min, o prospețime de câteva secunde e suficientă și mult mai robustă (evită protobuf-ul de pe WS-ul MEXC).

## Endpoint-uri API

| Metodă | Rută | Descriere |
|---|---|---|
| GET | `/api/state` | config + ultimele verdicte + alerte |
| GET | `/api/signal?symbol=ETHUSDT` | analiză la cerere |
| POST | `/api/config` | salvează setările, repornește scanner-ul |
| POST | `/api/test-ai` | testează cheia Gemini |
| GET | `/api/backtest?symbol=BTCUSDT&limit=1000` | win-rate pe istoric |
| GET | `/api/stream` | flux live (SSE) |

## 🎯 Sniper Mode (recomandat)

Backtest-ul pe date reale (in-sample + out-of-sample, ~4000 lumânări/lună) a arătat că **majoritatea semnalelor sunt zgomot (~48-49% win-rate)** și că scorul de „încredere" brut nu ajută. Singurul setup care a **supraviețuit testului out-of-sample** este combinația:

> **liquidity sweep + confirmare de volum + oră de sesiune activă (deschidere UE/SUA).**

Rezultate backtest (30 zile in-sample vs 30 zile out-of-sample):

| | in-sample | out-of-sample |
|---|---|---|
| ETH Sniper | 54.8% | **55.6%** (a rezistat) |
| BTC Sniper | 69.7% | 46.9% (a fost noroc) |

Concluzie onestă: **ETH ~55% e un edge subțire dar consistent; BTC nu a fost robust.** ~55% e abia peste break-even după comisioane — deci **NU e bani garantați**, ci un fir care merită validat înainte de bani reali.

**Sniper Mode** (activat implicit) face aplicația să alerteze **DOAR** pe acest setup A+ — câteva semnale pe sesiune, nu 125/zi. Setează în UI orele tale locale de sesiune; aplicația le convertește automat în UTC.

### Cum îl validezi corect (forward testing)
1. Rulează aplicația în orele tale de sesiune (dimineață + seară).
2. La fiecare alertă 🎯 SNIPER, notează pe hârtie/demo: direcția, ora, prețul, și rezultatul după 10/30 min.
3. Strânge **minim 30-50 de semnale** înainte de orice concluzie.
4. Dacă win-rate-ul real ține peste ~55% → treci pe sume mici. Dacă nu → nu risca.

## ⚠️ Avertisment

Tranzacționarea contractelor pe 10/30 min este **speculativă și riscantă**. Backtest-ul nu include comisioane/spread, iar rezultatele trecute **nu garantează** nimic în viitor. Folosește aplicația ca instrument de analiză, nu ca sfat financiar. Testează pe sume mici și verifică singur semnalele.
