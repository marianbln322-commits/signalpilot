# Brief: ce să repari într-o aplicație de semnale pe event futures

Copiază textul de mai jos și dă-l oricărui AI care lucrează pe o aplicație de acest tip. Fiecare punct vine dintr-un bug găsit și măsurat pe cod real, nu din teorie.

Ordinea contează: primele patru fac ca **măsurătoarea să mintă**, iar cât timp măsurătoarea minte, nicio îmbunătățire de strategie nu poate fi evaluată.

---

## Regula zero, înainte de orice

> **Construiește un test de nul și rulează-l primul.** Înlocuiește piața cu un random walk fără drift și rulează pe el tot lanțul: features, model, backtest, poartă de decizie. Acuratețea out-of-sample trebuie să iasă ~50%, Brier ~0.25, log loss ~0.693, iar poarta trebuie să refuze.
>
> Dacă sistemul găsește avantaj în zgomot pur, orice cifră pe care o produce pe date reale e fără valoare. Nu continua până nu trece.

Motiv: pe exact acest test, un fold individual a raportat 55.6% acuratețe pe date pur aleatoare. Aceeași cifră pe care aplicația veche o revendica drept „edge validat out-of-sample".

---

## A. Bug-uri care fac măsurătoarea falsă

**A1. Nu citi niciodată lumânarea în formare (repainting).**
Endpoint-urile de klines întorc bara curentă, incompletă, ca ultim rând. High/low/close/volume se schimbă până la închidere. Orice detector care o citește — sweep, spike de volum, raport de wick, RSI, MACD — produce un verdict care se schimbă în timpul barei. Aruncă barele neînchise înainte ca vreun detector să le vadă, verificând `closeTime > acum`.
*Verificare:* același verdict pentru aceeași bară închisă, indiferent de momentul scanării.

**A2. Backtest-ul și live-ul trebuie să primească exact aceleași intrări.**
În aplicația veche, live-ul trimitea trei timeframe-uri iar backtest-ul două. Semnalul lipsă avea greutate 1.5 la un prag de direcție de 0.8. Măsurat: **16.4% din semnale aveau altă direcție** decât ce fusese validat. Toate cifrele din documentație descriau un sistem care nu rula.
*Verificare:* un test care compară cheile primite de motor pe ambele căi.

**A3. Egalitatea e rambursare, nu pierdere.**
Pe contractele MEXC Up/Down, la preț identic miza se întoarce integral. Numărarea ei ca pierdere subestimează win-rate-ul, iar acel număr intră în calibrare și în decizia de miză. Marchează egalitățile ca nule și exclude-le din numitor.

**A4. Decontează pe prețul de referință al contractului, nu pe spot.**
Contractul se referă la **index price**. Pe un audit de 506 poziții reale, **17.3% s-au decis pe o mișcare sub 0.02%** — la marginea aceea, spot vs index poate inversa rezultatul. Folosește un TWAP pe ultimele secunde din index, nu un singur tick de spot.

**A5. Nu amesteca populații diferite în același estimator.**
Aplicația veche înregistra o „observație" per bară (~576/zi) și le punea în același bazin cu alertele reale (~10/zi). Orice medie peste amestec converge la rata de bază necondiționată (~50%) cu un interval **îngust**, pentru că `n` e mare. Rezultatul: estimarea rămâne lipită de 50% și poarta nu se deschide niciodată, oricât de real ar fi avantajul. Simulat pe 960 de zile cu un edge real de 62% prezent: limita inferioară a mers de la 49.0% la 49.98% și poarta a stat închisă tot timpul.
*Regulă:* estimează performanța alertelor **doar** din alerte. Ține observațiile separat, ca reper.

**A6. Prețul afișat trebuie să fie prețul live.**
Dacă motorul lucrează pe lumânări închise, prețul lui poate fi vechi de un întreg timeframe. În aplicația veche era luat din analiza de 15m — deci până la 15 minute vechi, o diferență tipică de ~3 USDT pe ETH. Afișează prețul din banda live și declară sursa și vechimea.

---

## B. Metodologie statistică

**B1. Corectează pentru comparații multiple, sau nu raporta.**
Aplicația veche raporta ~43 de bucket-uri de win-rate simultan (nivel de încredere × direcție × tip de setup × oră × praguri) și prezenta cel mai bun ca descoperire. Cu 43 de măsurători pe n≈25–40, găsești **întotdeauna** una la 55–63%.
Pe datele reale ale utilizatorului: din 21 de bucket-uri orare, 3 aveau p < 0.05 naiv (așteptat din hazard: 1.1) și **zero** au trecut corecția Bonferroni.
*Regulă:* declară dinainte ce testezi. Aplică Bonferroni sau Benjamini-Hochberg. Nu alege bucket-ul după ce ai văzut rezultatele.

**B2. Etichetele suprapuse cer intervale mai largi.**
Un eșantion la bara `i` e etichetat de bara `i+H`, deci `n` eșantioane consecutive conțin ~`n/H` observații independente. Un interval binomial naiv subestimează eroarea cu ~`sqrt(H)`. Calculează intervalul pe un sub-eșantion cu pas `H`.

**B3. Purjează la granițele train/test.**
Aruncă `H` bare între blocul de antrenare și cel de test, altfel eticheta se scurge.

**B4. Alegerea hiperparametrilor nu se face pe setul de test.**
Selectează pe o coadă de validare **din interiorul** blocului de antrenare. Altfel un model mediocru capătă o cifră flatantă.

**B5. Nu inventa numere care conduc decizii de bani.**
Aplicația veche presupunea 55% win-rate când jurnalul era subțire (`fallbackWinRate: 55`) și apoi afișa un EV „calculat" din presupunere. Dacă nu ai date, spune că nu ai date și refuză.

**B6. Poarta folosește limita inferioară a intervalului, nu estimarea punctuală.**
56% din 25 de eșantioane are o limită inferioară în jur de 40%. Aia nu e un avantaj, e zgomot.

---

## C. Specific pentru event futures

**C1. Break-even-ul e impus de payout: `1 / (1 + payout)`.**
Raportează **EV**, nu win-rate. Un win-rate de 55% e profit la payout 85% și pierdere la 70%.

| Payout | Win-rate necesar | Marja casei |
|---|---|---|
| 85% | 54.1% | 8.1% |
| 80% | 55.6% | 11.1% |
| 70% | 58.8% | 17.6% |
| 40% | 71.4% | 42.9% |
| 10% | 90.9% | 81.8% |

**C2. Payout-ul e per simbol și se schimbă constant.**
Observat în aceeași secundă: BTCUSDT la 10% în timp ce ETHUSDT era la 70%. Un singur număr global în config e greșit din construcție — cu `payout: 65` poarta calcula un break-even de 60.6% pentru BTC când cel real era 90.9%.

**C3. Inversează testul de payout.**
În loc de „e payout-ul acesta suficient?" comparat cu o valoare din config care se învechește, afișează **payout-ul de care ar avea nevoie semnalul**. Utilizatorul citește cifra live de pe ecran și compară.

**C4. Nu există stop loss, deci hit rate-ul e singurul lever.**
Payoff-ul e fix. „Cut losses short, let winners run" nu există. O strategie de trend following, profitabilă pe perpetual, poate fi pierzătoare aici pentru că hit rate-ul ei e sub 45%. Optimizează pentru acuratețe direcțională la orizont fix, nu pentru magnitudine.

---

## D. Model, nu ponderi inventate

**D1. Nu scrie ponderi de confluență de mână.**
Aplicația veche avea `sweep = 3.0`, `FVG = 2.5`, `MSS = 2.2`, `trend = 1.5`. Nimic nu a verificat dacă un sweep merită 3.0, dacă ordinea nu ar trebui inversată, sau dacă vreuna conține informație. Sunt întrebări empirice la care s-a răspuns prin afirmație.
*Regulă:* transformă evenimentele în **features**, nu în verdicte, și învață ponderile din rezultate etichetate. Un an de bare de 5 minute ≈ 105.000 exemple per simbol.

**D2. La acest raport semnal/zgomot, preferă un model liniar regularizat.**
Un model boosted va memora setul de antrenare și va raporta o cifră frumoasă in-sample. Regresia logistică cu L2 optimizează log loss — exact probabilitatea de care are nevoie poarta — și are coeficienți citibili, deci vezi dacă semnul se potrivește cu povestea spusă despre setup.

**D3. Standardizează pe datele de antrenare, nu pe tot setul.**
Altfel setul de test influențează transformarea și rezultatele ies flatate.

**D4. Verifică unitățile termenului de regularizare.**
Într-o implementare, penalizarea L2 era împărțită la `n` în timp ce gradientul datelor era deja o medie pe minibatch — deci `l2` declarat era de ~`n` ori mai slab. Ridicarea lui de la 1 la 200 nu schimba nimic, iar modelul se supra-antrena **în timp ce părea regularizat**.

**D5. Ieșirea brută a modelului nu are voie să ajungă la poartă.**
Un model poate scoate 0.58 în timp ce predicțiile din banda aceea au ieșit corecte în 50% din cazuri. Salvează un **tabel de fiabilitate** din validarea walk-forward: pentru fiecare bandă de încredere, cât de des a fost efectiv corectă out-of-sample. Calea live caută banda și trimite porții cifra **măsurată**.

---

## E. Regula care contează cel mai mult

> **Nu revendica niciun avantaj fără un test out-of-sample declarat dinainte.**

Documentația aplicației vechi spunea „ETH Sniper 55.6%, a rezistat out-of-sample". Cifra era un artefact de comparații multiple pe n≈27, cu un interval de încredere real de aproximativ 36–75%.

Cineva a tranzacționat 506 poziții pe baza ei. Rezultatul măsurat: **51.6% win-rate, față de 56.5% necesar, −102.70 USDT.** Cele două măsurători independente — istoricul real și un an de date backtestate (50.19%, interval 49.6–50.7% pe 36.522 observații independente) — se confirmă reciproc.

Un număr inventat într-un README nu e o problemă de documentație. E o instrucțiune pe care cineva o execută cu bani reali.

**Criteriu de acceptare, stabilit înainte de a rula:**

> Semnalul trece dacă, pe date out-of-sample neatinse la dezvoltare, cu minimum 200 de observații independente, limita inferioară a intervalului de încredere 95% depășește break-even-ul impus de payout.

Dacă nu trece, spune-o. Fără reglaje, fără „mai încercăm cu alt prag" — exact așa se naște un 55.6% fals.
