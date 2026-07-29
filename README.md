# SignalPilot

Aplicație locală care citește date live de pe MEXC, calculează indicatori tehnici + concepte Smart Money **determinist**, și produce decizii **UP/DOWN** pentru contracte event-futures pe **10 / 30 minute**.

Ce o deosebește de un indicator obișnuit: nu îți dă doar o direcție, ci o **probabilitate măsurată** și o compară cu pragul de rentabilitate impus de payout. Dacă probabilitatea nu bate pragul, îți spune să nu intri.

---

## ⚠️ Citește asta întâi: ce s-a schimbat și de ce nu mai există cifre promise

O versiune anterioară a acestui README raporta rezultate de backtest de tipul „ETH Sniper 54.8% in-sample / 55.6% out-of-sample”. **Aceste cifre au fost retrase.** Nu erau reale, din trei motive măsurate în cod:

1. **Backtest-ul testa altă strategie decât cea care rula live.** Serverul trimitea motorului trei timeframe-uri (`5m`, `15m`, `60m`), iar backtest-ul doar două (`5m`, `15m`). Semnalul de aliniere cu trendul de 1h (pondere 1.5) exista live, dar nu în validare. Pe date identice, cele două puteau returna verdicte diferite — verificat: unul dădea `NEUTRU`, celălalt `UP`.

2. **Motorul citea lumânarea în formare** (*repainting*). Ultimul rând returnat de MEXC este lumânarea curentă, incompletă. Detectorii de sweep, spike de volum și raport de wick o citeau, deci verdictul se schimba în timpul barei. Măsurat pe aceeași bară de 5 minute: la 25% formată → `DOWN`, la 50% → `DOWN`, la 75% → `UP` **și alertă Sniper declanșată**, la închidere → `UP`. Alerta pleca pe date neconfirmate, care se puteau încă anula. Backtest-ul, care rula doar pe bare închise, nu vedea niciodată aceste oscilații.

3. **Nu exista separare train/test.** Win-rate-ul se raporta pe tot eșantionul, apoi se alegea cel mai bun subset („sweep + volum + ore active”) din exact aceleași numere care erau apoi citate ca dovadă. Asta e selectarea ipotezei pe datele folosite ca argument pentru ea.

Pe lângă acestea, două defecte de logică distorsionau puternic semnalele:

4. **Semnalele de 10 minute practic nu apăreau.** Fereastra se alegea comparând greutatea *însumată* a semnalelor „rapide” cu cea a semnalelor „structurale”. Contextul (trend, EMA, VWAP, aliniere 1h) e prezent aproape pe fiecare bară, iar declanșatorii rapizi sunt evenimente rare — deci structura câștiga aproape mereu. Măsurat pe 4000 de bare: **97.6% dintre semnale ieșeau pe 30 de minute, 2.4% pe 10.** README-ul promitea că „apar ambele”.

5. **FVG-urile se comportau ca zgomot, nu ca declanșatori.** Detectorul prindea orice imbalance mecanic de 3 lumânări, fără cerința de *displacement*, nu marca niciodată un gap ca mitigat, iar orice gap străpuns rămânea „Inversion FVG” tradeable pe termen nelimitat. Rezultat: prețul se afla în interiorul unui gap „valid” în 76% din bare, iar FVG + IFVG produceau **93% din toți declanșatorii**, acoperind complet celelalte setup-uri.

Toate cinci sunt reparate. Verificarea rulează offline, fără rețea:

```bash
node tools/selftest.js
```

### Ce au schimbat reparațiile (măsurat pe același random walk de 4200 de bare)

| | înainte | după |
|---|---|---|
| Semnale pe fereastra de 10 min | 2.4% | **20.1%** |
| Bare fără semnal (`NEUTRU`) | 14.4% | **59.8%** |
| Cel mai dominant setup | FVG+IFVG 93% | **max 22%** (RSI divergence) |
| Verdict stabil în timpul barei | nu | **da** |
| Semnale aprobate pe zgomot pur | — | **0 din 264** |

Ultimul rând e cel mai important. Pe date generate aleatoriu, unde prin construcție **nu există** niciun edge, poarta EV nu aprobă nimic. Orice motor poate fi făcut să dea semnale; ce protejează banii e să refuze când nu e nimic acolo.

---

## 🚦 Cum decide dacă merită intrat (partea specifică event futures)

Un contract binar nu te plătește pentru că ai ghicit direcția, ci pentru că ai ghicit **mai des decât cere payout-ul**. Cu payout `p`, o miză de 1 aduce `+p` la câștig și `-1` la pierdere:

```
EV = w·p − (1−w)          w = probabilitatea reală de câștig
```

EV devine pozitiv doar când `w > 1/(1+p)`. Pragul e brutal:

| Payout | Win-rate necesar doar ca să fii pe zero |
|---|---|
| 40% | 71.4% |
| 65% | 60.6% |
| 80% | 55.6% |
| 85% | 54.1% |

De aici decurg două reguli pe care aplicația le respectă strict:

**1. Un scor de confluență nu este o probabilitate.** „net 6.19” nu înseamnă nimic în termeni de șanse. Aplicația nu convertește scorul în procent printr-o formulă inventată; îl folosește doar ca etichetă de bucket și **măsoară** empiric în ce procent din cazuri fiecare bucket a ieșit bine (`lib/calibration.js`).

**2. Se compară limita inferioară, nu estimarea optimistă.** Poarta EV folosește capătul de jos al intervalului de încredere Wilson. Un 56% obținut din 25 de mostre are limita inferioară la ~37% — nu e edge, e zgomot, și poarta îl refuză. E lent la „da” în mod deliberat: alternativa e să pierzi bani.

Dacă nu există calibrare cu suficiente date, banner-ul spune **„FĂRĂ DATE — nu intra”**. Nu inventează un număr. (Versiunea anterioară presupunea un win-rate de 55% prin `fallbackWinRate` și afișa un EV calculat din această presupunere — a fost eliminat.)

---

## Cum pornești

```bash
npm install
npm start
```

Apoi deschide **http://localhost:3005** (schimbi portul cu variabila `PORT`). Pe Windows, dublu-click pe `start.bat`.

### Pasul obligatoriu: calibrarea

Înainte de primul semnal, apasă **„Calibrează pe ultimele 30 de zile”**. Fără asta aplicația nu are cum să știe cât valorează un setup și va refuza corect orice intrare.

```
POST /api/calibrate    { "days": 30 }
```

Rezultatul se salvează în `calibration.json` și e folosit live până când jurnalul tău propriu are destule rezultate rezolvate, moment în care are prioritate (datele tale reale bat istoricul).

---

## Cum e gândit

- **Doar lumânări închise.** `lib/candles.js` taie lumânarea în formare înainte ca vreun detector să o vadă. Un verdict e o funcție pură a barelor confirmate, identificat prin `(simbol, barCloseTime)` — deci serverul emite exact o alertă per bară, nu una la fiecare scanare.
- **Paritate absolută între live și backtest.** Ambele apelează `engine.decide()` cu aceleași timeframe-uri. Dacă divergează, backtest-ul nu măsoară nimic util.
- **O singură taxonomie a declanșatorilor.** `TRIGGERS` în `lib/engine.js` este sursa unică de adevăr pentru „ce setup e acesta” și „ce fereastră i se potrivește”. Înainte, aceeași clasificare exista ca trei copii de regex în `engine.js`, `server.js` și `backtest.js`, care ajunseseră să nu mai coincidă.
- **Fereastra vine din declanșatorul principal**: evenimente impulsive de o singură lumânare (sweep, absorbție, breakout din squeeze, crossover) → **10 min**; setup-uri structurale (FVG, IFVG, shift de structură, divergență) → **30 min**.
- **Gemini nu decide nimic.** Primește numerele deja calculate și scrie justificarea în română. Opțional.

## Ce raportează backtest-ul

Nu un singur win-rate, ci ce e nevoie ca să judeci dacă cifra înseamnă ceva:

- **out-of-sample** pe o felie neatinsă, cu interval de încredere 95%
- **test binomial** față de o monedă aruncată (dacă `p > 0.05`, nu se distinge de noroc)
- **baseline „mereu UP” și „mereu DOWN”** pe exact aceleași bare
- **aceleași semnale evaluate la 10 ȘI la 30 de minute**, ca să vezi per setup care fereastră e mai bună
- **scor Brier + tabel de fiabilitate** — „70%” se întâmplă chiar în 70% din cazuri?
- **doar tranzacțiile aprobate de poarta EV**, cu EV realizat la payout-urile tale

Semnalele sunt distanțate cu cel puțin cea mai lungă fereastră, ca să nu împartă bare de rezultat între ele. Mostrele suprapuse sunt corelate și ar face testul de semnificație să pară mult mai puternic decât e.

## Endpoint-uri API

| Metodă | Rută | Descriere |
|---|---|---|
| GET | `/api/state` | config + ultimele verdicte + alerte |
| GET | `/api/signal?symbol=ETHUSDT` | analiză la cerere |
| POST | `/api/config` | salvează setările, repornește scanner-ul |
| POST | `/api/calibrate` | învață probabilitățile din istoric, salvează modelul |
| GET | `/api/calibration` | modelul de calibrare curent |
| GET | `/api/backtest?symbol=BTCUSDT&days=30` | evaluare out-of-sample completă |
| GET | `/api/stream` | flux live (SSE) |

## Order flow live

Pe lângă lumânări, aplicația citește dezechilibrul din order book (`/api/v3/depth`) și agresiunea tranzacțiilor (`/api/v3/aggTrades`). Nu se poate backtesta (MEXC nu dă istoric), deci e strict o confirmare live, validată prin jurnal.

Notă de corectitudine: clasificarea agresiunii cere acum explicit un boolean pe câmpul `m`. Înainte, orice tranzacție fără acel câmp era numărată tacit ca vânzare agresivă, ceea ce ar fi fabricat un bias permanent de scădere dacă bursa ar fi schimbat formatul.

---

## ⚠️ Avertisment

Această aplicație este un **instrument de măsurare**, nu un generator de profit și nu sfat financiar.

Reparațiile din această versiune elimină defecte care făceau rezultatele nemăsurabile. **Nu creează un edge.** Rămâne perfect posibil ca, după calibrare corectă pe datele tale, concluzia să fie că niciun setup nu bate pragul impus de payout-urile MEXC — iar dacă asta e realitatea, aplicația îți va spune să nu intri, și acela va fi răspunsul corect.

Predicția direcției pe 10–30 de minute este dominată de zgomot. Pragurile de 55–61% win-rate cerute de payout-urile tipice sunt foarte greu de atins consistent cu analiză tehnică. Validează pe demo, strânge minim 30–50 de semnale rezolvate înainte de orice concluzie, și nu risca sume pe care nu ți le permiți să le pierzi.
