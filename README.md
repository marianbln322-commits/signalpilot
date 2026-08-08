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

## 💰 Cât să pui: miza vine din edge-ul măsurat

Când probabilitatea prudentă depășește pragul, aplicația calculează și **cât** merită pus, cu evidențiere pe nivele: `MICĂ` / `MEDIE` / `MARE` / `MAXIMĂ`. Nivelul e determinat de mărimea edge-ului în puncte peste pragul de rentabilitate — nu de cât de „sigur" arată semnalul.

Formula e Kelly pentru un payout binar `b`: `f* = (p·(1+b) − 1) / b`. Trei lucruri se aplică înainte ca vreo cifră să ajungă pe ecran:

1. **Se folosește probabilitatea prudentă**, limita inferioară a intervalului, nu estimarea punctuală. Kelly e extrem de sensibil la supraestimarea lui `p`: supralicitarea se compune spre ruină, în timp ce sublicitarea costă doar puțin randament.
2. **Se înmulțește cu o fracțiune** (implicit 0.25). Un sfert până la jumătate de Kelly e practica standard exact pentru că `p` real nu se cunoaște niciodată exact.
3. **Se plafonează dur** ca procent din capital (implicit 5%), indiferent ce sugerează formula. Un contract binar nu poate fi închis parțial — nu există stop-loss, poziția e totul sau nimic pe miza respectivă.

Consecința: „miză MAXIMĂ" înseamnă aici ~5% din capital, nu 50%. Exemple reale din motor, la payout 82% (prag 54.95%, cerut cu marjă 56.45%):

| Win-rate observat | Mostre | Probabilitate prudentă | Decizie | Miză |
|---|---|---|---|---|
| 54% | 300 | 50.3% | respins | 0 |
| 56% | 40 | 44.9% | respins | 0 |
| 58% | 120 | 52.5% | respins | 0 |
| 63% | 400 | 59.9% | **aprobat** | 2.73% — MARE |
| 70% | 500 | 67.3% | **aprobat** | 5% — MAXIMĂ |

Observă rândul cu 56% din 40 de mostre: arată tentant, dar limita inferioară e 44.9%. Aplicația refuză. Un instrument care ar recomanda o miză acolo te-ar costa bani.

## ⏱ Sincronizarea cu contractul

Două lucruri au fost nealiniate cu realitatea platformei și sunt reparate.

**Fereastra de intrare.** Verdictul descrie bara care s-a **închis**. Intrarea 6 minute mai târziu e un alt trade: orizontul efectiv e mai scurt și prețul de intrare s-a mutat. Semnalele expiră după `maxEntryDelaySec` (implicit 90s), cu numărătoare inversă în interfață. Un semnal expirat nu produce alertă.

**Prețul de decontare.** MEXC stabilește prețurile de decontare pentru predicțiile Up/Down folosind un **indice compozit în timp real combinat cu un preț mediu ponderat în timp (TWAP)** — vezi [anunțul oficial MEXC](https://blog.mexc.com/press-release/mexc-launches-up-or-down-prediction-feature/).

Jurnalul compara însă un singur tick de pe `/ticker/price` cu prețul de intrare. Aplicația se nota după alt barem decât cel după care plătește contractul, iar diferența nu e cosmetică: un wick în ultimele secunde răstoarnă o comparație pe un singur tick, dar aproape nu mișcă un TWAP. Test din suită:

```
preț plat la 3000, spike la 3060 pe ultimul tick, intrare la 3010, direcție UP
  un singur tick -> WIN
  TWAP pe 30s    -> LOSS
```

Se înregistrau câștiguri pe care contractul le-ar fi decontat ca pierderi, și invers. Acum decontarea folosește un TWAP pe ultimele `settlementTwapSec` (implicit 30s), din o bandă de prețuri eșantionată la fiecare 3 secunde, independent de bucla de scanare. Metoda folosită se salvează în fiecare intrare de jurnal, ca să nu se amestece tacit cu un fallback.

**Limitare declarată:** ponderile exacte ale indicelui compozit MEXC nu sunt publice, iar banda citește prețul spot de pe o singură platformă. Deci e o **aproximare** a prețului de decontare, nu o replică. Dar a aproxima mărimea corectă e mai bine decât a măsura precis mărimea greșită.

---

## Cum pornești

```bash
npm install
npm start
```

Apoi deschide **http://localhost:3011** (schimbi portul cu variabila `PORT`, ex. `PORT=3011 npm start`). Pe Windows, dublu-click pe `start.bat`.

### Pasul obligatoriu: calibrarea

Înainte de primul semnal, apasă **„Calibrează pe ultimele 30 de zile”**. Fără asta aplicația nu are cum să știe cât valorează un setup și va refuza corect orice intrare.

```
POST /api/calibrate    { "days": 30 }
```

Rezultatul se salvează în `calibration.json` și e folosit live până când jurnalul tău propriu are destule rezultate rezolvate, moment în care are prioritate (datele tale reale bat istoricul).

### Pornire din istoricul tău real de poziții

Un backtest pe date proxy estimează un edge. Pozițiile tale închise din MEXC nu estimează nimic — sunt rezultate decontate de MEXC, pe regulile lui, la payout-urile pe care le-ai primit efectiv. E cea mai bună dovadă disponibilă și scurtcircuitează cold-start-ul.

```bash
node tools/analyze-positions.js pozitii.csv
node tools/analyze-positions.js pozitii.csv --seed-calibration
```

CSV minim — numele coloanelor sunt tolerante (RO sau EN):

```
symbol,interval,stake,entry,settle,pnl,payout
ETHUSDT,10,5,1919.88,1921.40,3.50,70
```

Direcția se deduce singură: la câștig coincide cu sensul mișcării, la pierdere e opusă.

Coloana `payout` e opțională, dar **fără ea defalcarea pe niveluri de payout e imposibilă** — payout-ul se poate deduce din P&L doar la pozițiile câștigătoare, fiindcă o pierdere e mereu −100% din miză indiferent ce payout ți se oferea. Unealta detectează situația și refuză tabelul, în loc să afișeze 100% pe fiecare nivel. Iar aceea e întrebarea care decide totul: **payout-ul mare apare în momentele mai greu de prezis, sau nu?** Dacă da, „intru doar la 85%" te selectează în cele mai grele momente și avantajul aparent dispare.

## Ponderi învățate, nu inventate

Până acum motorul scora setup-urile cu constante scrise de mână:

```js
if (sweep)                       w = 3 + Math.min(1.5, sweep.strength);
if (structure.mss === 'bullish') add('up', 2.2, ...);
if (structure.trend === 'up')    add('up', 1.5, ...);
```

Nimic nu a verificat vreodată dacă un sweep merită 3.0 și un trend 1.5, dacă ordinea nu ar trebui inversată, sau dacă vreuna dintre ele conteaza. Sunt întrebări empirice la care s-a răspuns prin afirmație. Asta e diferența dintre a aplica reguli dintr-o carte și a fi tranzacționat efectiv: cineva cu un milion de execuții are ponderile calibrate de rezultate.

„Un milion de tranzacții de experiență" e o dimensiune de dataset, nu o metaforă. Un an de bare de 5 minute ≈ 105.000 de bare per simbol; fiecare devine un exemplu etichetat, la fiecare orizont. Două simboluri și două orizonturi trec de 400.000 de rezultate măsurate.

```bash
# o singură dată, pe mașina ta (are nevoie de rețea)
node tools/collect.js --symbol ETHUSDT --days 365
node tools/collect.js --symbol BTCUSDT --days 365

# antrenare + validare walk-forward
node tools/train.js --file data/ETHUSDT-5m-365d.json --horizon 10
node tools/train.js --file data/ETHUSDT-5m-365d.json --horizon 30 --save

# testul de nul, fără rețea: pe random walk TREBUIE să iasă ~50%
node tools/train.js --synthetic --days 120
```

`lib/features.js` produce ~100 de features normalizate (momentum în unități de ATR, oscilatoare centrate, formă de lumânare, regim de volatilitate, distanțe la swing-uri, evenimentele SMC, aliniere între timeframe-uri, ora ca sin/cos). `lib/model.js` e regresie logistică cu L2, fără dependențe.

### Ce face numărul demn de încredere

- **Purjare.** Un eșantion la bara `i` e etichetat de bara `i+H`, deci eșantioanele `i..i+H-1` împart fereastra de rezultat. La fiecare graniță train/test se aruncă `H` bare.
- **Interval de încredere onest.** Etichetele vecine se suprapun, deci `n` eșantioane consecutive conțin ~`n/H` observații independente. Se raportează ambele: intervalul naiv și cel calculat pe un sub-eșantion cu pas `H`.
- **L2 ales înăuntrul fold-ului.** Coada blocului de antrenare devine validare, grila se scorează pe ea, iar câștigătorul se refitează pe tot blocul. Alegerea L2 uitându-te la fold-urile de test e scurgere de informație — și e exact modul în care un model mediocru capătă o cifră flatantă.
- **Test de nul.** `--synthetic` înlocuiește piața cu un random walk fără drift. Rezultat: acuratețe out-of-sample **49.96%**, Brier **0.25128**, log loss **0.69573** — practic la limita lipsei de informație, iar poarta refuză. Dacă harness-ul ar produce edge din zgomot, nimic din el nu ar avea valoare.

Un detaliu care ilustrează de ce contează intervalul onest: pe random walk, un fold individual a raportat **55.6%** acuratețe. Aceeași cifră pe care o revendica o versiune anterioară a acestui README ca „edge validat out-of-sample".

### Ce a arătat auditul pe 506 poziții reale

Istoricul real de tranzacționare MEXC al utilizatorului (16.07–08.08.2026, 506 poziții decontate, validat contra totalurilor exportate) a fost trecut prin `tools/analyze-positions.js`. Rezultatul e păstrat aici pentru că e singura măsurătoare din acest proiect care nu e o estimare:

```
win-rate realizat      : 51.59%  (259/502, egalitățile excluse)
interval încredere 95% : 47.23% – 55.94%
payout mediu (ponderat): 77%   ->  break-even 56.50%
EV                     : -8.67% pe tranzacție
vs. monedă (50%)       : p = 0.24  — nedistinct de hazard
P&L                    : -102.70 USDT pe 8.018 USDT rulaj
```

Defalcat pe payout, win-rate-ul **nu** crește cu payout-ul: 70% → 52.0% (n=102), 80% → 52.1% (n=213), 85% → 49.7% (n=157). Deci nu există nici selecție adversă, nici avantaj — la niciun nivel nu se atinge break-even-ul.

Alte lucruri pe care auditul le-a stabilit, și care au produs modificări în cod:

- **Egalitatea e rambursare.** Pe fiecare egalitate exactă, payout-ul returnat era egal cu miza. Codul o trata ca pierdere, ceea ce subestima win-rate-ul și contamina calibrarea.
- **17.3% din poziții s-au decis pe o mișcare sub 0.02%.** La marginea aceea, diferența dintre spot și index price poate inversa rezultatul — de aici trecerea decontării pe index.
- **Payout-ul e per simbol.** Observat în aceeași secundă: BTCUSDT la 10%, ETHUSDT la 70%. Un singur număr global în config era greșit din construcție.
- **Orele „bune" nu există.** Din 21 de bucket-uri orare, 3 aveau p < 0.05 naiv (așteptat din hazard: 1.1) și **zero** au trecut corecția Bonferroni.

Concluzia, spusă direct: **nu există un avantaj demonstrabil în semnalele acestei aplicații.** Rolul corect al porții EV pe aceste date e să refuze. O versiune anterioară a acestui README revendica „ETH Sniper 55.6%, a rezistat out-of-sample" — cifra a fost retrasă, iar auditul confirmă de ce conta: cineva a tranzacționat pe baza ei.

### Două populații care nu se amestecă niciodată

Jurnalul conține două feluri de intrări, și distincția e esențială:

| | ce e | intră în calibrare/miză/învățare? |
|---|---|---|
| `background` | o mostră per bară închisă, înregistrată chiar dacă nu s-a dat nicio alertă | **nu** |
| alertă | semnal care a trecut filtrele — populația care se tranzacționează | **da** |
| alertă `uncalibrated` | alertă reală apărută în observation mode (afișată, nu recomandată) | **da** |

Mostrele de fundal se acumulează de ~60 de ori mai repede decât alertele. Orice medie peste amestecul celor două converge la rata de bază necondiționată — adică ~50% pe un orizont de tip monedă — și o face cu un interval de încredere tot mai **îngust**. Nu e doar imprecis: e ferm greșit, și devine tot mai încrezător în răspunsul greșit pe măsură ce aplicația rulează. Cu poarta EV care cere `CI low ≥ break-even + marjă`, efectul practic e că poarta nu s-ar deschide niciodată, oricât de real ar fi edge-ul.

De aceea `journal.samples()` e singura sursă permisă pentru calibrare, iar `learning.analyze()` exclude fundalul implicit. Alertele `uncalibrated` sunt incluse deliberat: dacă nu ar fi numărate, observation mode nu ar putea strânge niciodată dovezile care i-ar permite să se încheie.

Fundalul rămâne util, dar ca **reper**: răspunde la întrebarea „setup-ul filtrat e mai bun decât a lua pur și simplu fiecare bară?". Se raportează separat, în `stats().background` și `learning.summary().baseline`.

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

## ⚠️ Ce nu poate face acest instrument

Trebuie spus direct, pentru că e diferența dintre a folosi aplicația corect și a pierde bani cu ea.

**Nu se poate construi un instrument care „generează în majoritate semnale de win".** Nu e o limitare de programare pe care s-o rezolv cu mai mult cod. Win-rate-ul nu e o proprietate a aplicației, ci a pieței: fie există o regularitate exploatabilă în mișcările de 10–30 de minute, fie nu. Codul o poate doar **măsura**, nu produce.

Iar bara e ridicată de payout, nu de noi. La payout 65% ai nevoie de **60.6%** acuratețe direcțională doar ca să fii pe zero. Asta e foarte greu de susținut consistent cu analiză tehnică pe orizonturi de minute, unde mișcarea e dominată de zgomot.

Ce face în schimb această versiune, și ce e realizabil:

- **nu mai minte** — fără repainting, fără probabilități inventate, fără cifre de backtest produse de o strategie diferită de cea care rulează
- **măsoară onest** — out-of-sample, cu baseline și marjă de eroare, deci vei ști dacă ai edge sau doar noroc
- **refuză când nu e nimic** — dovedit pe date aleatorii: 0 semnale aprobate din 264
- **dimensionează după edge** — mai mult unde statistica susține, nimic unde nu

Dacă după calibrare pe datele tale concluzia e că niciun setup nu bate pragul, aplicația îți va spune să nu intri. **Acela nu e un eșec al instrumentului — e singurul răspuns corect**, și te scutește de pierderi.

Pierderile sunt normale chiar și cu edge real: la 60% win-rate, 4 din 10 tranzacții pierd, și serii de 4-5 pierderi consecutive apar frecvent. De asta există plafonul de miză.

Validează pe demo. Strânge minim 30–50 de semnale rezolvate înainte de orice concluzie. Nu risca sume pe care nu ți le permiți să le pierzi. Aceasta nu este consultanță financiară.
