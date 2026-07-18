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

## 💰 Alegerea intervalului după EV (payout)

Contractele MEXC event-futures sunt binare: dacă îți iese, primești un **payout** (ex. +65% pe 10 min, +82% pe 30 min); dacă greșești, pierzi miza. Win-rate-ul necesar ca să fii pe zero e **`1 / (1 + payout)`**:

| Payout | Win-rate necesar |
|---|---|
| 40% | 71.4% |
| 65% | 60.6% |
| 80% | 55.6% |
| 85% | 54.1% |

De aceea contează enorm ce fereastră alegi. Introdu în Setări payout-urile curente de pe MEXC (10 min și 30 min). Aplicația calculează **EV (valoarea așteptată)** pentru fiecare fereastră (folosind win-rate-ul din jurnal sau ~55% ca estimare inițială) și **alege automat fereastra cu EV mai bun** — exact ce făcea traderul când trecea de la 10 min (payout mic) la 30 min (payout 80-85%). Dacă payout-ul e prea mic pentru edge-ul tău (EV negativ), banner-ul te avertizează să **sari peste**.

## 📊 Order flow live (ce citește un scalper)

Pe lângă lumânări, aplicația citește în timp real de pe MEXC:
- **Order book imbalance** (`/api/v3/depth`): sunt mai mulți bani la cumpărare sau la vânzare lângă preț?
- **Agresiunea tranzacțiilor** (`/api/v3/aggTrades`): cumpărătorii lovesc mai tare decât vânzătorii?

Rezultatul (`buy` / `sell` / `neutru`) **confirmă sau intră în conflict** cu direcția semnalului. Opțional (`requireOfAgree`), aplicația nu alertează dacă order flow-ul contrazice direcția. ⚠️ Order flow-ul NU se poate backtesta (MEXC nu dă istoric), deci e o confirmare **live**, validată prin jurnal.

## 🧠 Învățare din jurnal (se calibrează sesiune de sesiune)

Aplicația învață din **rezultatele tale reale**, nu dintr-o cutie neagră. Pe măsură ce jurnalul se umple, calculează win-rate-ul pe dimensiuni (tip setup, oră, monedă+direcție, order flow) și:
- **întărește** tiparele care îți câștigă (>55%)
- **blochează** automat tiparele pe care istoricul tău le arată pierzătoare (< `learningSuppressBelow`, implicit 45%)

Panoul „🧠 Ce a învățat" îți arată transparent ce merge și ce evită. **Are nevoie de minim ~10 semnale per tipar** înainte să acționeze — deci devine mai bună treptat, pe măsură ce tranzacționezi (pe demo întâi!). Nu inventează edge; optimizează în jurul celui real.

## ⚠️ Avertisment

Tranzacționarea contractelor pe 10/30 min este **speculativă și riscantă**. Backtest-ul nu include comisioane/spread, iar rezultatele trecute **nu garantează** nimic în viitor. Folosește aplicația ca instrument de analiză, nu ca sfat financiar. Testează pe sume mici și verifică singur semnalele.
