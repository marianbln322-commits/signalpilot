# SignalPilot

Aplicație locală (stil PinPilot) care citește **date live de pe MEXC**, calculează indicatori tehnici + concepte Smart Money **determinist** (nu din poze) și produce decizii **UP/DOWN** pentru contracte event-futures pe **10 / 30 minute**. Scanează automat și te **alertează** când apare un setup bun. Opțional folosește **Gemini** pentru justificare în limba română.

## Ce face

- Se conectează la MEXC (endpoint public, **fără cheie API**) și analizează numai lumânări **închise și sincronizate** pe 5m + 15m + 60m.
- Calculează: **RSI, MACD, Bollinger, EMA 9/20/50, ATR, VWAP de sesiune, volum vs. media barelor anterioare**.
- Detectează **Smart Money**: FVG / Inversion FVG, Liquidity Sweep (SFP), Market Structure Shift (CHoCH), structură HH/HL/LH/LL.
- Combină totul prin confluență ponderată → output standardizat în **5 pași**:
  `Direcție · Interval (10/30 min) · Justificare · Nivel de încredere · Ce ar invalida`.
- **Scanner automat**: verifică la câteva secunde și dă **alertă (sunet + notificare)** doar când încrederea ≥ pragul ales.
- **Backtest closed-bar** pe proxy Binance 5m/15m/60m: folosește ferestre de eveniment nesuprapuse și aceeași logică tehnică, dar nu poate reproduce order flow-ul sau microstructura MEXC.

## Cum pornești (la fel ca PinPilot)

```bash
npm install
npm start
```

Apoi deschide în browser: **http://localhost:3005**
(Portul 3005 e ales ca să ruleze în paralel cu PinPilot (3004) și versiuni mai vechi de SignalPilot. Poți schimba portul cu variabila de mediu PORT.)

Intervalul (10 vs 30 min) e ales automat după tipul setup-ului: sweep/momentum rapid → **10 min**, structură (FVG, trend) → **30 min**. Deci apar ambele. Payout-ul introdus în Setări e folosit pentru a afișa EV-ul (valoarea așteptată) și, opțional, pentru a comuta 10→30 când payout-ul pe 10 min e slab.
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

> **liquidity sweep + oră de sesiune activă**, cu confirmarea de volum disponibilă ca filtru opțional.

Rezultatele istorice de mai jos au motivat ipoteza inițială; după corecțiile de temporalitate și scoring trebuie regenerate înainte de a fi tratate drept comparabile cu versiunea curentă:

| | in-sample | out-of-sample |
|---|---|---|
| ETH Sniper | 54.8% | **55.6%** (a rezistat) |
| BTC Sniper | 69.7% | 46.9% (a fost noroc) |

Concluzie onestă: **ETH ~55% a fost o ipoteză promițătoare în versiunea veche, nu un edge confirmat pentru motorul reparat; BTC nu a fost robust.** Rezultatele trebuie regenerate și validate forward înainte de bani reali.

**Sniper Mode** (activat implicit) face aplicația să alerteze **DOAR** pe acest setup A+ — câteva semnale pe sesiune, nu 125/zi. Setează în UI orele tale locale de sesiune; aplicația le convertește automat în UTC.

### Cum îl validezi corect (forward testing)
1. Rulează aplicația în orele tale de sesiune (dimineață + seară).
2. La fiecare alertă 🎯 SNIPER, notează pe hârtie/demo: direcția, ora, prețul, și rezultatul după 10/30 min.
3. Strânge **minim 30-50 de semnale** înainte de orice concluzie.
4. Dacă win-rate-ul real ține peste ~55% → treci pe sume mici. Dacă nu → nu risca.

## 💰 Alegerea intervalului după EV (payout)

Contractele MEXC event-futures sunt binare: dacă îți iese, primești un **payout** (ex. +65% pe 10 min, +82% pe 30 min); dacă greșești, pierzi miza. Win-rate-ul necesar ca să fii pe zero e **`1 / (1 + payout)`**:

| Payout | Win-rate necesar |
|---|---|
| 40% | 71.4% |
| 65% | 60.6% |
| 80% | 55.6% |
| 85% | 54.1% |

De aceea contează enorm ce fereastră alegi. Introdu în Setări payout-urile curente. Aplicația afișează EV-ul ambelor ferestre; dacă activezi `adaptiveInterval`, poate comuta 10→30 numai după ce ambele intervale au minimum 20 de rezultate nesuprapuse. Veto-ul `requirePositiveEv` nu blochează bootstrap-ul: devine activ doar după ce intervalul ales are 20 de rezultate compatibile cu versiunea curentă a politicii.

## 📊 Order flow live (ce citește un scalper)

Pe lângă lumânări, aplicația citește în timp real de pe MEXC:
- **Order book imbalance** (`/api/v3/depth`): sunt mai mulți bani la cumpărare sau la vânzare lângă preț?
- **Agresiunea tranzacțiilor** (`/api/v3/aggTrades`): cumpărătorii lovesc mai tare decât vânzătorii?

Rezultatul (`buy` / `sell` / `neutru` / `insufficient`) confirmă sau intră în conflict cu direcția. Cartea este ponderată după distanța față de mid, iar delta folosește maximum 60s cu decay; dacă batch-ul nu acoperă minimum 30s sau trade-urile sunt stale, starea devine `insufficient`, nu un semnal fals. Opțional (`requireOfAgree`), aplicația nu alertează când există un conflict valid.

## 📉 Context derivate MEXC

Aplicația colectează opțional funding rate, open interest, variația OI și basis-ul perpetual–index. Aceste valori sunt salvate în jurnal pentru forward-calibration, dar **nu primesc încă ponderi euristice**: ar fi necinstit să presupunem că funding pozitiv înseamnă automat DOWN sau că OI în creștere înseamnă automat continuare fără validare istorică.

## 📐 VWAP + aliniere cu trendul 1h

- **VWAP de sesiune**: ancora se resetează la 00:00 UTC, astfel încât are aceeași semnificație economică pe 5m și 15m.
- **Aliniere cu trendul de 1 oră**: aplicația citește și graficul de 60m și favorizează semnalele care merg în sensul trendului mare (trade with the trend).

## 🧠 Învățare din jurnal (se calibrează sesiune de sesiune)

Aplicația calibrează din **evenimente deduplicate și fără ferestre suprapuse pe același simbol**, nu dintr-o cutie neagră. Selectează o singură cohortă comparabilă (setup, simbol, direcție, interval și, când există destule date, order flow), aplică un prior Beta și decay temporal, apoi afișează un interval aproximativ de 95%. Nu mai mediază rate marginale corelate.

Panoul „🧠 Ce a învățat” cere implicit **effective sample size de minimum 20 per cohortă**. O alertă este blocată statistic numai când limita superioară aproximativă este sub pragul configurat. BTC și ETH pot rămâne corelate, deci această protecție reduce dependența fără a pretinde independență perfectă.

**Învățare non-stop:** cât timp aplicația e deschisă, înregistrează în fundal o „observație" per lumânare per monedă (chiar și fără alertă) și îi verifică singură rezultatul. Așa învață continuu despre ETH/USDT și BTC/USDT, 24/7, chiar dacă nu tranzacționezi. Observațiile alimentează învățarea, dar NU apar în lista ta de tranzacții (care rămâne doar cu alerte reale). Jurnalul persistă în `journal.json`, deci progresul nu se pierde la repornire.

## ⚠️ Avertisment

Tranzacționarea contractelor pe 10/30 min este **speculativă și riscantă**. Backtest-ul nu include comisioane/spread, iar rezultatele trecute **nu garantează** nimic în viitor. Settlement-ul jurnalului este un proxy bazat pe close-ul MEXC spot 1m; verifică rezultatul contractual dacă produsul folosește alt index, timestamp sau regulă de egalitate. Folosește aplicația ca instrument de analiză, nu ca sfat financiar. Testează pe sume mici și verifică singur semnalele.
