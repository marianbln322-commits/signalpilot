# SignalPilot

Aplicație locală (stil PinPilot) care citește **date live de pe MEXC**, calculează indicatori tehnici + concepte Smart Money **determinist** (nu din poze) și produce decizii **UP/DOWN** pentru contracte event-futures pe **10 / 30 minute**. Scanează automat și te **alertează** când apare un setup bun. Opțional folosește **Gemini** pentru justificare în limba română.

## Ce face

- Se conectează la MEXC (endpoint public, **fără cheie API**) și citește la fiecare ~3 secunde lumânările native 1m + 5m + 15m + 30m + 60m; timeframe-ul 3m este agregat determinist din OHLCV-ul real de 1m, aliniat la granițele UTC.
- Afișează simultan grafice candlestick live **1m/3m/5m/15m/30m** și prognoze distincte pentru **10m** (1m/3m/5m) și **30m** (5m/15m/30m). Graficele includ lumânarea în formare; analiza folosește numai lumânări închise ca să evite repaint/look-ahead.
- Calculează: **RSI, MACD, Bollinger, EMA 9/20/50, ATR, volum vs. medie**.
- Detectează **Smart Money**: FVG / Inversion FVG, Liquidity Sweep (SFP), Market Structure Shift (CHoCH), structură HH/HL/LH/LL.
- Combină totul prin confluență ponderată → output standardizat în **5 pași**:
  `Direcție · Interval (10/30 min) · Justificare · Nivel de încredere · Ce ar invalida`.
- **Scanner 24/7**: verifică implicit la 3 secunde, scanează simbolurile în paralel fără cicluri suprapuse și transmite UI-ul prin SSE; alertează numai când toate filtrele de execuție sunt îndeplinite.
- **Paper trading local**: fiecare alertă este evaluată automat, cu miză și payout configurabile, win-rate și P&L în USDT; nu plasează ordine reale.
- **Backtest** pe istoric real: îți arată win-rate-ul pe niveluri de încredere, **fără look-ahead**.

## Pornire rapidă pe Windows 10/11 64-bit (ZIP → extragi → dublu-click)

1. Descarcă arhiva ZIP a aplicației și extrage tot folderul.
2. Dă dublu-click pe **`PORNESTE-SIGNALPILOT.bat`**.
3. La prima pornire, launcherul descarcă automat în folder un runtime oficial Node.js dacă lipsește, verifică suma SHA256 și instalează dependențele. Pe Windows 64-bit x64/ARM64 nu cere instalare manuală sau drepturi de administrator.
4. Browserul se deschide automat la **http://localhost:3010**. Pentru oprire, închide fereastra SignalPilot.

Prima pornire necesită internet și poate dura câteva minute. Pornirile următoare refolosesc runtime-ul și dependențele locale. Folderele generate `.runtime` și `node_modules` pot rămâne lângă aplicație.

## Pornire din terminal (Windows/macOS/Linux)

```bash
npm install
npm start
```

Apoi deschide în browser: **http://localhost:3010**. Portul implicit este 3010 și poate fi schimbat cu variabila de mediu `PORT`.

Intervalul (10 vs 30 min) e ales automat după tipul setup-ului: sweep/momentum rapid → **10 min**, structură (FVG, trend) → **30 min**. Deci apar ambele. Payout-ul introdus în Setări e folosit pentru a afișa EV-ul (valoarea așteptată) și, opțional, pentru a comuta 10→30 când payout-ul pe 10 min e slab.
Ca să oprești: închide fereastra / `Ctrl+C`.

Fișierul vechi **`start.bat`** redirecționează către același launcher automat.

## Setări (în UI, se salvează în `config.json`)

- **Simboluri**: format MEXC fără underscore, ex. `BTCUSDT`, `ETHUSDT`.
- **Interval scanare** (secunde, minim 3).
- **Alertă de la încrederea**: `Scăzut` / `Mediu` / `Ridicat`.
- **Monitorizare 24/7**: activă implicit; orele de sesiune devin relevante numai dacă dezactivezi modul continuu.
- **Calibrare minimă**: implicit 30 rezultate exacte pentru aceeași monedă + direcție + fereastră, win-rate observat de minimum 60% și limită statistică conservatoare peste șansă.
- **Payout 10m / 30m și miză paper**: folosite pentru gate-ul break-even și P&L simulat; aplicația nu trimite ordine către MEXC.
- **Gemini** (opțional): activează + lipește cheia + alege modelul. Cheia rămâne **local**, pe mașina ta, în `config.json` (care e în `.gitignore`).

## Cum e gândit (important)

- **Decizia UP/DOWN e determinist** — vine din numere reale, nu dintr-o interpretare de imagine. Se poate reproduce și testa.
- **Gemini NU decide direcția** — primește doar numerele deja calculate și scrie justificarea + un check de acord/risc. Dacă nu e configurat, aplicația folosește propriul text.
- **Poll REST sincronizat, nu WebSocket** — snapshot-urile native sunt cerute în paralel la aproximativ 3 secunde, au timeout și sunt publicate imediat prin SSE. Pentru decizii de 10/30 minute, analiza la închiderea lumânărilor este mai stabilă decât reacția la fiecare tick și evită semnale care se schimbă înainte de close.

## Endpoint-uri API

| Metodă | Rută | Descriere |
|---|---|---|
| GET | `/api/state` | config + ultimele verdicte + alerte |
| GET | `/api/signal?symbol=ETHUSDT` | analiză la cerere |
| POST | `/api/config` | salvează setările, repornește scanner-ul |
| POST | `/api/test-ai` | testează cheia Gemini |
| GET | `/api/backtest?symbol=BTCUSDT&limit=1000` | win-rate pe istoric |
| GET | `/api/stream` | flux live (SSE) |

## 🎯 Filtrul Sniper (opțional)

Aplicația rulează implicit în modul continuu 24/7. Filtrul Sniper poate fi activat suplimentar dacă vrei numai setup-uri cu liquidity sweep; în modul continuu, filtrul nu mai limitează semnalele la anumite ore. Orice semnal rămâne blocat până când trece calibrarea exactă, pragul de minimum 60%, limita statistică de fiabilitate, break-even-ul payout-ului, setup-ul tehnic și prospețimea datelor.

Backtest-ul pe date reale (in-sample + out-of-sample, ~4000 lumânări/lună) a arătat că **majoritatea semnalelor sunt zgomot (~48-49% win-rate)** și că scorul de „încredere" brut nu ajută. Singurul setup care a **supraviețuit testului out-of-sample** este combinația:

> **liquidity sweep + confirmare de volum + oră de sesiune activă (deschidere UE/SUA).**

Rezultate backtest (30 zile in-sample vs 30 zile out-of-sample):

| | in-sample | out-of-sample |
|---|---|---|
| ETH Sniper | 54.8% | **55.6%** (a rezistat) |
| BTC Sniper | 69.7% | 46.9% (a fost noroc) |

Concluzie onestă: **ETH ~55% e un edge subțire dar consistent; BTC nu a fost robust.** ~55% e abia peste break-even după comisioane — deci **NU e bani garantați**, ci un fir care merită validat înainte de bani reali.

**Filtrul Sniper este dezactivat implicit**, deoarece modul 24/7 permite oricând setup-uri care trec gate-ul statistic și tehnic. Îl poți activa din UI ca filtru suplimentar mai rar.

### Cum îl validezi corect (forward testing)
1. Rulează aplicația continuu; scannerul monitorizează toate orele.
2. La fiecare alertă 🎯 SNIPER, notează pe hârtie/demo: direcția, ora, prețul, și rezultatul după 10/30 min.
3. Strânge **minim 30-50 de semnale** înainte de orice concluzie.
4. Dacă rezultatele forward pentru aceeași monedă+direcție+fereastră trec gate-ul de 60% și limita statistică → continuă doar pe demo/paper înainte de orice risc real.

## 💰 Alegerea intervalului după EV (payout)

Contractele MEXC event-futures sunt binare: dacă îți iese, primești un **payout** (ex. +65% pe 10 min, +82% pe 30 min); dacă greșești, pierzi miza. Win-rate-ul necesar ca să fii pe zero e **`1 / (1 + payout)`**:

| Payout | Win-rate necesar |
|---|---|
| 40% | 71.4% |
| 65% | 60.6% |
| 80% | 55.6% |
| 85% | 54.1% |

De aceea contează enorm ce fereastră alegi. Introdu în Setări payout-urile curente de pe MEXC (10 min și 30 min). Aplicația afișează EV-ul de planificare pentru fiecare fereastră din win-rate-ul jurnalului (sau fallback-ul configurat când istoricul nu ajunge). Opțional, `adaptiveInterval` poate muta un setup de la 10 la 30 minute când payout-ul scurt este nefavorabil. Separat, un forecast poate deveni `TRADE` numai când probabilitatea sa calibrată pe rezultate forward este **strict peste** break-even; scorul tehnic brut nu este tratat ca probabilitate.

## 📊 Order flow live (ce citește un scalper)

Pe lângă lumânări, aplicația citește în timp real de pe MEXC:
- **Order book imbalance** (`/api/v3/depth`): sunt mai mulți bani la cumpărare sau la vânzare lângă preț?
- **Agresiunea tranzacțiilor** (`/api/v3/aggTrades`): cumpărătorii lovesc mai tare decât vânzătorii?

Rezultatul (`buy` / `sell` / `neutru`) **confirmă sau intră în conflict** cu direcția semnalului. Opțional (`requireOfAgree`), aplicația nu alertează dacă order flow-ul contrazice direcția. ⚠️ Order flow-ul NU se poate backtesta (MEXC nu dă istoric), deci e o confirmare **live**, validată prin jurnal.

## 📐 VWAP + aliniere cu trendul 1h

- **VWAP** (Volume-Weighted Average Price): ancora „valorii corecte" pe care o urmăresc scalperii. Preț peste VWAP în urcare = bias bullish; sub VWAP în coborâre = bias bearish.
- **Aliniere cu trendul de 1 oră**: aplicația citește și graficul de 60m și favorizează semnalele care merg în sensul trendului mare (trade with the trend).

## 🧠 Învățare din jurnal (se calibrează sesiune de sesiune)

Aplicația învață din **rezultatele tale reale**, nu dintr-o cutie neagră. Pe măsură ce jurnalul se umple, calculează win-rate-ul pe dimensiuni (tip setup, oră, monedă+direcție, order flow) și:
- **evidențiază** tiparele cu rezultate bune în panoul statistic
- **blochează** execuția sub gate-ul strict de 60%, break-even sau fiabilitate

Panoul „🧠 Ce a învățat" arată transparent rezultatele. **Sunt necesare implicit minimum 30 rezultate forward exacte pentru aceeași monedă, direcție și fereastră** înainte de probabilitate calibrată. `TRADE` cere win-rate empiric de minimum 60%, probabilitate strict peste break-even și o limită Wilson 90% de minimum 50%, care reduce riscul unui procent mare obținut dintr-un eșantion fragil. Modelul 1m/3m/5m folosește calibrarea versiunea 3, deci înregistrările din strategiile vechi nu îl pot debloca. Aceste filtre nu garantează 60% în viitor; ele confirmă doar că istoricul forward comparabil a trecut pragul.

**Învățare non-stop:** cât timp aplicația e deschisă, înregistrează în fundal câte o observație la fiecare graniță exactă de 10m și 30m pentru fiecare monedă, folosind doar lumânări deja închise și prețul de deschidere al graniței. Rezultatul este stabilit din primul `aggTrade` de la ținta exactă; dacă acesta rămâne indisponibil după perioada de grație, observația devine `VOID` și nu intră în P&L sau învățare. Observațiile alimentează calibrarea, dar NU apar în lista ta de tranzacții. Jurnalul persistă în `journal.json`, deci progresul nu se pierde la repornire.

## ⚠️ Avertisment

Tranzacționarea contractelor pe 10/30 min este **speculativă și riscantă**. Backtest-ul nu include comisioane/spread, iar rezultatele trecute **nu garantează** nimic în viitor. Folosește aplicația ca instrument de analiză, nu ca sfat financiar. Testează pe sume mici și verifică singur semnalele.
