# waread – Frontend (Weboberfläche)

Schreibgeschützte, WhatsApp-ähnliche Leseoberfläche. Vanilla TypeScript, kein Framework,
gebündelt mit esbuild. Keine CDN-Referenzen, keine Webfonts (Systemschrift).
Die Oberfläche hat keine Eingabeleiste und ruft keinen Endpunkt auf, der etwas an WhatsApp sendet.

## Build

Das Frontend ist ein npm-Workspace des Projekts (`waread-frontend`). Im Projektordner:

```sh
npm install                              # beim ersten Mal; erzeugt package-lock.json
npm run build -w waread-frontend         # erzeugt dist/app.js, dist/styles.css und kopiert index.html und static/ (Symbole, Manifest) nach dist/
npm run typecheck -w waread-frontend     # tsc --noEmit
npm test -w waread-frontend              # Parser für WhatsApp-Formatierung (node:test)
```

Browsertests (optional, Playwright mit Chromium, nicht Teil von `npm test`): `node services/web/test/e2e-frontend.mjs` (Grundfunktionen) und `node services/web/test/e2e-frontend-v2.mjs` (Zitate, Verlauf, gelöscht, Schild, Einmal, Jetzt laden, Stumm, Löschwege, Layout mit langer Chatliste).

Der Gesamtbau (`npm run build` im Projektordner) enthält diesen Schritt. Weiterer Befehl im Ordner `services/web/public`: `npm run watch` (esbuild im Watch-Modus mit Inline-Sourcemaps).

Verwendete Versionen beim Test: esbuild 0.28.2, TypeScript 6.0.3 (Typprüfung zusätzlich mit 7.0.2 ausgeführt), Node 22. Der Build selbst hat nur esbuild als Abhängigkeit; TypeScript wird nur für `typecheck` gebraucht und kommt aus dem Projektordner.

`package-lock.json` liegt im Projektordner (erzeugt mit npm 10.9 gegen die öffentliche Registry); `npm ci` ist der vorgesehene Weg.

## Was ausgeliefert wird

Der Web-Dienst liefert **nur `services/web/public/dist/`** aus (`index.html`, `app.js`, `styles.css`, `apple-touch-icon.png`, `icon-*.png`, `manifest.webmanifest`; `build.mjs` kopiert `index.html` und den Ordner `static/` dorthin). Nicht ausgeliefert werden `node_modules/`, `src/`, `package.json`, `tsconfig.json`, `build.mjs`.

Alle URLs sind **relativ** (`api/chats`, `events`, `app.js`), damit die Seite unter `/waread/` (Nginx entfernt den Präfix) ebenso läuft wie unter `/`. Die Funktion `apiUrl()` in `src/api.ts` entfernt führende Schrägstriche; `BASE` (Standard leer) ist der einzige Ort für einen anderen Ursprung. Routing läuft über den URL-Hash (`#/chats/<id>`, `#/connection`), es sind keine Rewrite-Regeln nötig.

Hinweise für Backend und Nginx (umgesetzt in `deploy/nginx/waread.conf` bzw. im Web-Dienst):

- `/events` (SSE) wird ungepuffert durchgereicht (`proxy_buffering off`), sonst kommen Live-Updates verzögert an.
- `/api/media/:id` beantwortet Range-Anfragen (Safari braucht das für Audio).
- Die Seite setzt keine Inline-Skripte und keine `style`-Attribute. Sie läuft ohne Verletzung unter der Content-Security-Policy des Web-Dienstes (`default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`). `data:` unter `img-src` wird für den QR-Code gebraucht.

## Quellcode

```
index.html
src/
  main.ts                 App-Shell, Login-Gate, Zwei-Spalten-Layout, SSE-Verdrahtung
  api.ts                  fetch-Client + Normalisierung der API-Antworten
  types.ts                Datenmodell, das das Frontend annimmt
  store.ts                Zustand, Pub/Sub, Paging, lokale „gesehen“/„angehört“-Marker
  sse.ts                  EventSource mit Reconnect (Backoff) und iOS-Reaktivierung
  router.ts               Hash-Router
  util.ts                 DOM-Helfer, Formatierung, Linkify (ohne innerHTML)
  components/
    chatList.ts           Chat-Übersicht, Filter-Chips, gelber Zähler
    chatView.ts           Chat: Datumstrenner, „N neue Nachrichten“, Paging, Sprung, Fußleiste
    seenTracker.ts        IntersectionObserver, 1 s Verweildauer
    bubble.ts             Sprechblasen, Zitate, Foto, Video, Dokument
    audioPlayer.ts        Sprachnachrichten-Player, 1x / 1,5x / 2x
    lightbox.ts           Vollbild: Pinch-Zoom, Wischen, Speichern
    searchView.ts         Suche mit Filtern
    settingsView.ts       Einstellungen, Speicherübersicht, zweistufiges Leeren
    connectionView.ts     Verbindungsstatus und QR-Code
    loginView.ts, nav.ts, avatar.ts, icons.ts, toast.ts
  styles.css              Einstiegspunkt, bindet styles/*.css per @import ein
  styles/base.css  chat.css  views.css
```

## Verhalten

- **Neu = gelb.** Zähler, Zeitangabe, Marker an der Sprechblase, Trennlinie und die Pille in der
  Navigation sind gelb, nie grün.
- **Gesehen:** Eine eingehende Nachricht gilt erst nach etwa einer Sekunde ununterbrochener
  Sichtbarkeit als gesehen (IntersectionObserver). Die Zeit pausiert, solange der Tab verborgen ist.
  Beim bloßen Öffnen eines Chats wird nichts markiert. Dazu gibt es unter der Kopfzeile eine schmale
  Leiste „N neue Nachrichten · Alle als gesehen“ (nur sichtbar, solange etwas ungesehen ist; sie
  schiebt den Inhalt nach unten, statt ihn zu überdecken) und in den Einstellungen die
  Option „Beim Öffnen eines Chats alles als gesehen markieren“ (im Browser gespeichert).
  Systemmeldungen (Typ „other“) zählen wie auf dem Server nicht als neu.
- **Angehört:** Der erste Start einer eingehenden Sprachnachricht ruft `POST /api/messages/:id/played` auf.
- **Fußleiste:** „Nur lesen. Antworten in WhatsApp.“ mit „In WhatsApp öffnen“ (`https://wa.me/<Nummer>`)
  bei Einzelchats mit bekannter Nummer. Bei Gruppen und bei Chats ohne Nummer erscheint ein Hinweistext.
- **Layout:** Unter 900 px Breite eine Spalte, ab 900 px Liste links und Chat rechts. Die Gridzeile hat eine feste
  Höhe (`grid-template-rows: minmax(0, 1fr)`); ohne sie wuchsen beide Spalten mit einer langen Chatliste über das
  Fenster hinaus, und Navigation und Fußleiste lagen unterhalb des sichtbaren Bereichs. Seitliche Sicherheitsränder
  (`safe-area-inset-left/right`) werden berücksichtigt.
- **Menü pro Nachricht:** Ein Tipp auf eine Sprechblase (außer auf Links, Knöpfen, Player und Zitat) öffnet ein Menü:
  mit Schild schützen / Schutz aufheben, auf dem Gerät sichern, Medium jetzt laden, Bearbeitungen ansehen.
- **Beschriftungen statt Farben:** „Vom Absender gelöscht“ (gestrichelter Rahmen, Papierkorb, Uhrzeit), „bearbeitet“
  (Knopf, öffnet den Verlauf mit Original, Fassungen, Aktuell), „Einmal-Foto / -Video / -Sprachnachricht“ (Symbol, Rahmen),
  Schild-Symbol bei der Uhrzeit. Gelöschte Nachrichten bleiben lesbar, solange `hide_deleted_content` im Web-Dienst `false` ist.
- **Zitate:** Text und Absender der zitierten Nachricht (vom Server: Original oder Kurzzitat der Antwort). Ist weder das Original
  noch ein Kurzzitat da, steht „Ursprüngliche Nachricht nicht mehr gespeichert“ (nicht anklickbar).
- **Fehlende Medien:** Der Platzhalter nennt Art, Größe und den Grund (Download-Regel „Aus“, zu groß, Verlauf von vor der
  Kopplung, nach Aufbewahrung gelöscht, bei WhatsApp nicht mehr verfügbar) und bietet „Jetzt laden“, wenn der Ingest die
  Schlüssel noch hat. Nur ein Befehl wird abgelegt; die Datei kommt über `media_ready`.
- **Sichern:** Teilen-Blatt (Web Share API mit Datei, nur in sicherem Kontext, bis 60 MB), sonst Download-Link. Auf dem iPhone ist
  das der Weg zu „In Fotos sichern“ / „In Dateien sichern“.
- **Sprachnachricht:** Symbol, Abspielen, Audiospur (30 Balken) und rechts davon die Geschwindigkeitstaste (mindestens 44 × 40 px).
- **Stumm:** Glocken-Knopf im Chat-Kopf. Stumme Chats zählen nicht in „Neu“, im Tab-Abzeichen und im Zähler am Zurück-Knopf.
- **Formatierung:** `*fett*`, `_kursiv_`, `~durchgestrichen~`, `` `code` `` und Codeblöcke (`src/richtext.ts`); Links bleiben Links.
- **Startbildschirm:** `apple-touch-icon` und Manifest (`display: standalone`).
- **Live-Updates:** `EventSource` auf `/events`. Bei Fehler wird die Verbindung geschlossen und mit
  wachsendem Abstand (1 s bis 30 s) neu aufgebaut. Nach Reconnect und nach längerem Hintergrund-Betrieb
  auf iOS werden Status, Chatliste und der offene Chat neu geladen.
- **Speicher leeren:** zwei getrennte Wege. „Speicher leeren (ohne geschützte)“: Schritt 1 Auswahl, Schritt 2 Eingabe von
  `LÖSCHEN`; geschützte Nachrichten bleiben. „Speicher leeren (auch geschützte)“: als extremer Schritt gekennzeichnet, nennt
  Zahl und Größe der geschützten Nachrichten und „kein Backup“, Eingabe von `GESCHÜTZTE LÖSCHEN`. Erst dann wird
  `POST /api/storage/clear` mit `confirm: true` (und beim extremen Weg `includeProtected: true`) gesendet.
- **Aufbewahrung ändern:** nur mit „Speichern“, mit sichtbarem Hinweis, wenn der Wert verkürzt wird.
  Beim Speichern bleiben unbekannte Felder und unbekannte `downloadRules`-Schlüssel erhalten.

## Datenformat

Endpunkte, JSON-Formen und SSE-Ereignisse beschreibt `services/web/routes.md`; das Frontend (`src/api.ts`) bildet die Antworten des Web-Dienstes auf sein Datenmodell (`src/types.ts`) ab. Zusammenführungsstand:

- **API-Typ ↔ UI-Typ:** `voice` ↔ `audio`, Richtung `in`/`out` ↔ `fromMe`; Download-Regeln `voice` ↔ `audio` (Schlüssel `image`, `voice`, `video`, `document` mit `mode: auto|off` und `maxMb`).
- **Zeitstempel:** Unix-Sekunden. Das Frontend erkennt trotzdem Werte über 1e12 als Millisekunden und verwendet dieselbe Einheit für `before`, `from` und `to`. Tagesgrenzen für `from`/`to` werden in der lokalen Zeitzone des Browsers gebildet.
- **`POST /api/chats/:id/seen`:** `upTo` wird als Nachrichten-ID gesendet; alle eingehenden Nachrichten bis einschließlich dieser (nach `waTimestamp`) gelten als gesehen. Alternativ `all: true`.
- **Medien:** `GET api/media/:id` und, wenn `media.hasThumbnail` gesetzt ist, `GET api/media/:id?thumb=1`. Fehlt `media.status`, gilt das Medium als bereit.
- **Verbindung:** `GET api/status`, `GET api/qr` (Daten-URL), `POST api/connect` („Neu verbinden“).
- **Suche:** Array oder `{ results | hits | messages: [...] }`; Typfilter `text`, `image`, `audio`, `video`, `document`; `onlyNew=1`.

## Bekannte Grenzen und offene Punkte

Getestet wurde in Chromium (Desktop und Mobil-Emulation, Touch-Gesten per CDP) zuerst gegen einen Mock des API-Vertrags und beim Zusammenführen zusätzlich gegen den echten Web-Dienst mit gefüllter Testdatenbank (`services/web/test/e2e-frontend.mjs`, Playwright, optional, nicht Teil von `npm test`). **Nicht getestet:** echte WhatsApp-Daten, Safari/WebKit und ein echtes iPhone. Insbesondere Audio-Wiedergabe in Safari, Pinch-Zoom auf echten Touchgeräten und das Verhalten der SSE-Verbindung im iOS-Hintergrund sind ungeprüft.

- **Avatare:** Die Oberfläche nutzt `avatarUrl` bzw. `GET api/chats/:id/avatar`, wenn der Chat `hasAvatar` meldet. Der Ingest-Dienst lädt keine Profilbilder (das wäre eine Abfrage an WhatsApp); deshalb erscheinen Initialen auf einer aus der Chat-ID abgeleiteten Farbe.
- **Wellenform:** Liefert die API kein `media.waveform` (der Ingest liefert keines), sind die Balken ein dekoratives Muster aus der Nachrichten-ID und keine echten Audiodaten. Der Fortschritt und das Springen funktionieren trotzdem.
- **Filter „Fotos“ und „Sprachnachrichten“** in der Chatliste prüfen nur den Typ der letzten Nachricht des Chats, weil die Chatliste nur das liefert. „Chats, die irgendwo ein Foto enthalten“ ginge nur über die Suche mit `type=image`.
- **Sprung zu einer Nachricht** (Suchtreffer, Zitat): Es gibt keine Abfrage „um diese Nachricht herum“. Das Frontend lädt ältere Seiten (je 50) nach, bis die Nachricht da ist, höchstens 40 Seiten. Danach erscheint eine Meldung.
- **„Neu verbinden“:** Der Button ruft `POST api/connect` auf. Der Web-Dienst legt nur einen Befehl in die Datenbank, der Ingest-Dienst beginnt innerhalb weniger Sekunden eine neue Kopplung und der QR-Code erscheint, sobald der Status `needs_qr` ist. Nicht gegen ein echtes WhatsApp getestet.
- **QR-Format:** Der Web-Dienst liefert eine Daten-URL (SVG); im Bundle gibt es bewusst keinen QR-Encoder. Rendert der Server nicht (`qrcode` fehlt), zeigt die Oberfläche eine Fehlermeldung.
- **Nachrichtenformatierung:** Links und WhatsApp-Auszeichnungen werden dargestellt. Reaktionen werden nicht gespeichert; Umfragen, Standorte und Kontakte kommen als Text vom Ingest; Nachrichten ohne Text und ohne unterstützten Typ erscheinen als „Nicht unterstützter Nachrichtentyp“.
- **Sticker:** Der Ingest speichert sie als `image`. Ein WebP-Bild ohne Text wird als Sticker dargestellt (klein, ohne Blase). Das ist eine Heuristik: ein WebP-Foto ohne Unterschrift sähe genauso aus.
- **Dokumente:** Der Originalname steckt im gespeicherten Dateinamen (`<Nachrichten-ID>__<Name>`); der Server liefert ihn als `media.fileName` und im Download-Header. Ältere Dateien ohne diese Form zeigen „Dokument“.
- **Download-Regeln:** `auto` und `off` (mit Größengrenze). Bei `off` und bei zu großen Dateien speichert der Ingest den Status `expired` bzw. `failed` mit Grund (`skipReason`); „Medium jetzt laden“ holt sie später (bis `max_mb_forced`). Zeilen aus der Zeit vor Version 2 haben keinen Grund und zeigen „Datei nicht (mehr) gespeichert“.
- **Video:** Wiedergabe über das native `<video>`-Element ohne Vorschaubild.
- **Kein Offline-Betrieb**, kein Service Worker. Symbol und Manifest sind nur für den Startbildschirm da.
- **Nicht getestet:** Safari/WebKit, das Teilen-Blatt auf dem iPhone, das Verhalten als Startbildschirm-App (Dynamic Island: alle Kopfzeilen nutzen `env(safe-area-inset-top)`), echte WhatsApp-Daten.
