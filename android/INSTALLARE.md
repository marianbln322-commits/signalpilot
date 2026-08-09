# SignalPilot Android — instalare

Aceasta este o aplicație Android separată, portată din snapshotul desktop original `c090a283833844cf53c99ba2ea35f5507778a6bd`. Fișierele desktop originale nu sunt modificate.

## Obținerea APK-ului

1. Deschide fila **Actions** a repository-ului GitHub.
2. Alege workflow-ul **Build SignalPilot Android APK**.
3. Deschide ultima execuție reușită de pe branch-ul `android/original-signalpilot`.
4. Descarcă artefactul `SignalPilot-Android-debug-apk`.
5. Dezarhivează și copiază `app-debug.apk` pe telefon.
6. Permite temporar instalarea aplicațiilor din sursa folosită și instalează APK-ul.

Alternativ, deschide directorul `android/` în Android Studio (JDK 17, Android SDK 35) și rulează `assembleDebug`.

## Configurare obligatorie pentru monitorizare continuă

1. Deschide SignalPilot Android și permite notificările.
2. Apasă **Permite rularea fără restricții de baterie** și aprobă excluderea.
3. Pe telefoane Xiaomi/Redmi/POCO, Huawei/Honor, Oppo/Realme, Vivo sau Samsung, activează și **Auto-start** / **Unrestricted battery** din setările producătorului.
4. Oprește modul **Nu deranja**, setează telefonul pe profil sonor și mărește volumul notificărilor, apoi apasă **TESTEAZĂ SUNETUL ȘI VIBRAȚIA**.
5. Apasă **PORNEȘTE 24/7**. Păstrează notificarea permanentă „SignalPilot monitorizează 24/7”.

Android nu permite unei aplicații să promită execuție absolut neîntreruptă: repornirile, economisirea agresivă a bateriei și restricțiile producătorului pot opri procese. Aplicația folosește un foreground service vizibil, `START_STICKY`, wake-lock limitat pe durata scanării, repornire după boot și alarmă de recuperare după eliminarea din lista Recent Apps.

## Comportament

- Citește direct endpointurile publice MEXC; nu cere cheie API.
- Rulează ciclurile continuu, cu o pauză de 8 secunde între cicluri, la fel ca versiunea originală; notificarea permanentă afișează durata reală a ultimului ciclu.
- Analizează 5m, 15m și contextul 60m cu RSI, MACD, Bollinger, EMA20/50, VWAP, volum, structură, FVG/IFVG, liquidity sweep și divergență RSI.
- Modul **Sniper original** este activ implicit și alertează rar, doar la liquidity sweep în orele active originale.
- Debifează Sniper dacă vrei alerte de la încrederea `Mediu` în sus.
- Opțional, activează veto-ul order flow pentru a bloca alertele când order book-ul și agresiunea tranzacțiilor contrazic direcția.
- Alertele folosesc notificări Android de prioritate mare, sunet și vibrație.
- Calibrarea online locală reține semnalele `Mediu`/`Ridicat`, le verifică după 10 sau 30 minute numai pe lumânări MEXC închise și adaptează conservator ponderile fiecărui indicator după minimum 5 rezultate decisive.
- Datele de învățare rămân pe telefon; multiplicatorii sunt limitați la `0,75×–1,25×`, iar codul aplicației nu se rescrie singur. Secțiunea **ÎNVĂȚARE ADAPTIVĂ LOCALĂ** arată exemplele, rata istorică și ponderile folosite.
- Nu plasează ordine și nu garantează rezultate viitoare. O rată istorică bună nu garantează un WIN pentru următorul semnal.
