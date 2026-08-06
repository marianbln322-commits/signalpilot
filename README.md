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

## Android standalone (fără PC/server după instalare)

Aplicația Android împachetează interfața și motorul canonic SignalPilot localhost:3001 în APK. Datele MEXC/Binance/Gemini sunt accesate direct de telefon prin HTTPS, iar configurația și jurnalul sunt păstrate local pe telefon. Serverul Node.js nu este necesar după instalare.

Cerințe pentru build: **Android Studio**, Android SDK 35 și JDK 17. Deschide directorul `android/` în Android Studio, lasă Gradle Sync să termine, apoi rulează configurația `app` pe telefon sau emulator. Din terminal poți construi APK-ul astfel:

```bash
npm run android:build
```

APK-ul debug rezultat este:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

Pentru instalare manuală, activează temporar permisiunea Android de instalare din surse necunoscute pentru aplicația din care deschizi APK-ul. SignalPilot cere doar acces la internet și, pe Android 13+, permisiunea pentru notificări.

**Limitare Android:** scannerul rulează la intervalul configurat numai cât aplicația este deschisă în foreground. Dacă o trimiți în fundal sau închizi ecranul/aplicația, scanarea și cererile active sunt suspendate; la revenire, intrările restante din jurnal sunt rezolvate folosind prețul MEXC curent, la fel ca serverul canonic localhost:3001. Un serviciu Android permanent nu este inclus în această versiune.

## Setări (în UI, se salvează local)

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

## 📐 VWAP + aliniere cu trendul 1h

- **VWAP** (Volume-Weighted Average Price): ancora „valorii corecte" pe care o urmăresc scalperii. Preț peste VWAP în urcare = bias bullish; sub VWAP în coborâre = bias bearish.
- **Aliniere cu trendul de 1 oră**: aplicația citește și graficul de 60m și favorizează semnalele care merg în sensul trendului mare (trade with the trend).

## 🧠 Învățare din jurnal (se calibrează sesiune de sesiune)

Aplicația învață din **rezultatele tale reale**, nu dintr-o cutie neagră. Pe măsură ce jurnalul se umple, calculează win-rate-ul pe dimensiuni (tip setup, oră, monedă+direcție, order flow) și:
- **întărește** tiparele care îți câștigă (>55%)
- **blochează** automat tiparele pe care istoricul tău le arată pierzătoare (< `learningSuppressBelow`, implicit 45%)

Panoul „🧠 Ce a învățat" îți arată transparent ce merge și ce evită. **Are nevoie de minim ~10 semnale per tipar** înainte să acționeze — deci devine mai bună treptat, pe măsură ce tranzacționezi (pe demo întâi!). Nu inventează edge; optimizează în jurul celui real.

**Învățare non-stop:** cât timp aplicația e deschisă, înregistrează în fundal o „observație" per lumânare per monedă (chiar și fără alertă) și îi verifică singură rezultatul. Așa învață continuu despre ETH/USDT și BTC/USDT, 24/7, chiar dacă nu tranzacționezi. Observațiile alimentează învățarea, dar NU apar în lista ta de tranzacții (care rămâne doar cu alerte reale). Jurnalul persistă în `journal.json`, deci progresul nu se pierde la repornire.

## ⚠️ Avertisment

Tranzacționarea contractelor pe 10/30 min este **speculativă și riscantă**. Backtest-ul nu include comisioane/spread, iar rezultatele trecute **nu garantează** nimic în viitor. Folosește aplicația ca instrument de analiză, nu ca sfat financiar. Testează pe sume mici și verifică singur semnalele.


## SignalPilot Expert desktop separat (127.0.0.1:3017)

Varianta Expert este izolată în `desktop/` și rulează în paralel cu versiunile existente. Necesită Node.js 18+:

```bash
npm install
npm run start:3017
```

Pe Windows se poate folosi `start-3017.bat`. Interfața acceptă **http://127.0.0.1:3017** și **http://localhost:3017**; serverul rămâne legat fix pe `127.0.0.1`. Se oprește cu eroare dacă portul 3017 este ocupat și nu alege automat alt port. Răspunsurile includ CSP și protecție anti-framing.

Configurația locală este salvată atomic în `desktop/data/config.json`, iar jurnalul forward separat în `desktop/data/journal.json`; ambele sunt ignorate de Git. Stația expert monitorizează intenționat exact `BTCUSDT` și `ETHUSDT`; lista nu este extensibilă din UI, pentru a păstra două grafice și aceeași disciplină de analiză. Exemplul complet este `desktop/config.example.json`. API-ul Expert expune `GET /api/state`, `GET /api/stream`, `POST /api/config` și `POST /api/backtest` cu JSON `{ "symbol": "BTCUSDT", "days": 7 }` (maximum 30 zile). Operațiile POST cer Origin same-origin.

Scanarea expert folosește `api.mexc.com`. Un feed separat citește tickerul MEXC Spot la fiecare secundă pentru BTCUSDT și ETHUSDT și publică în UI last/bid/ask, spread, RTT și timpul ultimei observații. Acest preț live este separat explicit de motorul de decizie: motorul folosește numai lumânări închise. Ora de analiză este recalculată după fetch din ceasul local corectat cu skew-ul MEXC măsurat la midpoint. Dacă ora MEXC nu poate fi verificată, scannerul eșuează în siguranță, elimină rezultatele vechi și nu emite ENTER pe baza ceasului local. Sunt validate exact 300 de lumânări închise 1m, 5m, 15m, 30m și 60m, pe grila temporală exactă, cu metadata de prospețime și gaps.

Interfața arată un singur grafic per simbol, implicit **15m**, cu butoane **1m / 5m / 15m**, exact pentru schimbarea rapidă a intervalului. Motorul 10m cere acord dominant obligatoriu **1m + 5m**, cu 15m context/veto. Motorul 30m cere acord dominant obligatoriu **5m + 15m**, cu 30m și 60m context/veto. Un timeframe de context nu poate înlocui unul dintre cele două timeframe-uri obligatorii. Intrările extinse la peste 2,2 ATR de EMA20 sunt blocate fail-closed.

Live și replay folosesc aceeași fereastră de exact 300 candles pe fiecare timeframe și același contract din `desktop/lib/contract-timing.js`. Replay-ul descarcă 13 zile de pre-roll pentru a reconstrui cele 300 candles de 60m înaintea ferestrei evaluate. Intrarea este la primul 1m open strict după `generatedAt`, apoi exact 10/30 minute și `closeTime`-ul minutei finale. Un boundary lipsă după downtime/gap este INVALID, nu este înlocuit cu o lumânare ulterioară și este exclus din win-rate. Backtest-ul rulează într-un worker separat și folosește **Binance Vision numai ca proxy/in-sample**, nu istoric MEXC exact; parametrii rămân fixați.

Fiecare rezultat rezolvat primește review determinist: mișcare semnată, MFE, MAE și tag-uri de eșec. Învățarea este limitată intenționat: poate bloca un ENTER numai după minimum 30 de rezultate comparabile și numai dacă limita superioară Wilson95 este sub break-even-ul payout-ului. Nu poate crea un ENTER, schimba UP în DOWN sau modifica singură codul/pragurile. Jurnalul și calibrarea sunt izolate prin versiunea motorului.

Gemini este opțional și rulează numai ca auditor post-loss cu răspuns JSON structurat; nu participă la semnalul live. Cheia rămâne doar server-side:

```bash
# Linux/macOS
GEMINI_API_KEY="cheia-ta" GEMINI_MODEL="gemini-3-pro-preview" npm run start:3017

# Windows CMD
set GEMINI_API_KEY=cheia-ta
set GEMINI_MODEL=gemini-3-pro-preview
start-3017.bat
```

Pentru UP/DOWN, UI afișează o probabilitate istorică estimată numai din bucket-ul comparabil `horizon + direction + quality band`, cu win-rate, N și Wilson95: forward la N≥30 (preferat), altfel Binance proxy/in-sample la N≥50. La eșantion insuficient arată „necalibrat”, iar pentru WAIT nu estimează probabilitate. **`quality/confluence` nu este probabilitate.** MEXC Spot este proxy pentru grafic; settlement-ul Event Futures poate diferi. Niciun procent istoric nu prezice sigur semnalul curent și nu există promisiune de precizie sau profit.
