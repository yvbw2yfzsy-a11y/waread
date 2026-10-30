# Gestaltung: Apple-Look (Branch `design/apple-look`)

Stand: 30. Oktober 2026. Ausgangspunkt war der Stand von `claude/waread-design-features-5qn19p`. Dieser Branch ist inhaltlich identisch mit `main`, weil er schon über PR #1 zusammengeführt wurde.

Das hier ist reine Gestaltungsarbeit. Aufbau, Reihenfolge, Funktionen, Klassennamen, `id`s und `data-`-Attribute sind unverändert. Die Oberfläche bleibt wie WhatsApp aufgebaut (Chatliste, Chat mit Sprechblasen, untere Leiste) und übernimmt Größen, Farben und Formen aus dem Dunkelmodus von iOS. Grundlage sind Apples Human Interface Guidelines (HIG), zitiert nach Datei und Abschnitt der Referenzsammlung des Skills `apple-design`.

Gewissheitsstufen wie in `docs/VERSION2.md`: **GESICHERT** = gemessen oder durch einen Testlauf belegt. **VERMUTUNG** = aus Wissen über Safari/iOS geschlossen, nicht geprüft. **UNBEKANNT** = nicht beurteilbar.

## 1. Was sich ändert

| Bereich | Änderung |
| --- | --- |
| Variablen | Farben, Schriftgrößen, Radien, Schatten und Bewegung als `--…` in `:root` (`base.css`). Harte Farbwerte in `chat.css` und `views.css` sind durch Variablen ersetzt, wo sie dasselbe bedeuten. Übrig sind Werte mit nur einer Verwendung (z. B. Weiß auf Fotos in der Bildansicht, das Gelb des Aufblitzens). |
| Flächen | Grund `#000000` (iOS systemBackground dunkel), Karten und Leisten `#1c1c1e`, Sheet-Zeilen `#2c2c2e`. Chat-Hintergrund bleibt `#0b0b0c`. `theme-color` und Manifest auf `#000000`. |
| Text | Primär `#ffffff`, sekundär `rgba(235,235,245,0.6)` (iOS secondaryLabel). In Sprechblasen eigener Sekundärton `rgba(255,255,255,0.72)`: vorher stand `--text-dim` in grünen Blasen bei 3,40:1 (unter AA). |
| Schrift | iOS-Textstile: Large Title 34 fett, Headline 17 halbfett, Body 17, Subhead 15, Footnote 13, Caption 12/11. Nichts kleiner als 11 px. Ziffern in Zeiten und Zählern tabellarisch. Die negative Laufweite des großen Titels entfällt. |
| Trennlinien | Haarlinien `rgba(84,84,88,0.6)` (iOS separator), auf Retina 0,5 px. In der Chatliste wie bisher bis zum Text eingerückt. |
| Sprechblasen | Radius 18 px. Aufeinanderfolgende Nachrichten derselben Seite bilden eine Gruppe: 2 px Abstand statt 8 px, „Schwanz“ (kleiner Keil oben außen) nur an der ersten Blase, 6 px Radius, wo zwei Blasen aneinanderstoßen. Ein Datumstrenner oder die gelbe Neu-Linie beendet eine Gruppe. In Gruppenchats (Blasen mit Absendername) wird nicht gruppiert, weil das DOM den Absender nicht als Attribut trägt. Sticker haben keinen Schwanz. |
| Datum | Kleine Kapsel wie in WhatsApp auf iOS. |
| Sprachnachricht | Nach Vorlage WhatsApp auf iOS: Abspiel-Dreieck ohne Kreis (30 px, Tippfläche 44 px), dünne abgerundete Balken (gespielt weiß, Rest grau), runder Positionspunkt an der Grenze, Dauer darunter (15 px), Geschwindigkeit als dunkle Kapsel (52 × 40 px). Abspielen, Balken und Geschwindigkeit liegen auf einer Mittellinie (gemessen: 0 px Versatz). Der Punkt ist gelb, solange eine eingehende Nachricht nicht angehört ist (wie der gelbe Punkt am Mikrofon, der bleibt), sonst blau. Die Balken füllen die ganze Breite der Spur (`space-between`), damit ein Tipp dort landet, wo der Balken gezeichnet ist. Blase mindestens `min(300px, 76vw)` breit. |
| Liste | Name halbfett 17, Zeit und Vorschau 15, Gedrückt- und Ausgewählt-Zustand getrennt (`:active` 8 %, ausgewählt 14 % Weiß). |
| Leisten | Untere Navigation: Glas mit 24 px Unschärfe, Sättigung, feiner Lichtkante, dichtere Füllung (72 %). Ausgewählter Tab zeigt das gefüllte Symbol. Chat-Kopf und Fußleiste: gleiche Leistenfarbe, Haarlinie. Runde Knöpfe in Leisten (Zurück, Stumm, Schließen) mit Lichtkante. |
| Symbol „Einstellungen“ | Zahnrad statt Schieberegler (gleicher Exportname `settings` in `icons.ts`). Als ein Pfad mit Nabe, damit es im ausgewählten Tab gefüllt werden kann. |
| Knöpfe | Kapseln ohne Rand (Rand bleibt transparent, Größen ändern sich nicht), mindestens 44 px hoch. Primär grün, gefährlich rot. „Auch geschützte löschen“ behält den 2-px-Rand als Form-Merkmal. |
| Schalter | Die beiden Kontrollkästchen (Anzeige-Option, Suche „Nur neue“) sehen aus wie iOS-Schalter (51 × 31 px). Der Zustand steckt in der Lage des Knopfs (links aus, rechts an), Grün wiederholt ihn nur. Sie bleiben `<input type="checkbox">` an derselben Stelle links vom Text. |
| Formularzeilen | In den Einstellungs-Karten trennt eine Haarlinie die Zeilen wie in einer gruppierten iOS-Liste. Felder ohne Rand auf grauer Füllung, Suchfeld als Kapsel mit sichtbarem Fokusring. |
| Sheets und Dialoge | Obere Ecken 24 px, gleiten von unten herein (300 ms). Die Aktionen stehen in einer gemeinsamen Gruppe mit eingerückten Trennlinien statt in Einzelkästen. Hintergrund wird abgedunkelt und blendet ein. Bearbeitungsverlauf: „Aktuell“ behält den dickeren Rand und die Beschriftung. |
| Toast | Kapselform, federt kurz herein. |
| Bewegung | Nur `transform` und `opacity`, 150 bis 300 ms. Auf dem Telefon schiebt sich der Chat von rechts herein, die Liste blendet beim Zurückgehen ein. Gedrückte Knöpfe werden kurz auf 95 % verkleinert. Bei „Bewegung reduzieren“ entfallen alle Animationen, statt Verkleinern wird der Knopf blasser. |
| Tippflächen | Kleine Bedienelemente behalten ihre Optik und bekommen eine unsichtbare Fläche bis 44 px (Pseudo-Element): „Alle als gesehen“, „Jetzt laden“, „In WhatsApp öffnen“, Abspielen, Geschwindigkeit, Dokument laden, „bearbeitet“. Die Statuskapsel ist jetzt 44 px hoch. |
| Systemeinstellungen | „Kontrast erhöhen“ (`prefers-contrast: more`): undurchsichtige Trennlinien, hellerer Sekundärtext, Ränder an Knöpfen, Chips und Feldern, fast undurchsichtiges Glas. „Transparenz reduzieren“ (`prefers-reduced-transparency`): undurchsichtige Leisten. |

Unverändert: Lage aller Bereiche, Zwei-Spalten-Layout ab 900 px samt `grid-template-rows: minmax(0, 1fr)`, alle `env(safe-area-inset-*)`-Werte, der untere Innenabstand der Liste (`104px` + Inset), Gelb für „neu“, Beschriftungen „Vom Absender gelöscht“ (gestrichelt), „bearbeitet“, „Einmal-…“, das Schild-Symbol, die Geschwindigkeitstaste rechts neben der Audiospur.

## 2. Änderungen außerhalb der CSS-Dateien

| Datei | Änderung | Grund |
| --- | --- | --- |
| `src/components/icons.ts` | neuer Pfad für `settings` (Zahnrad) | erlaubt laut Auftrag (gleicher Exportname). Zahnrad ist auf iOS das übliche Zeichen für Einstellungen. |
| `src/main.ts` | ein leerer, passiver `touchstart`-Listener auf `document` | Safari auf iOS zeigt `:active` (den Gedrückt-Zustand) nach verbreiteter Dokumentation nur, wenn die Seite einen Touch-Listener hat. Per CSS nicht lösbar. Passiv, daher kein Einfluss aufs Scrollen. Ob er nötig ist: VERMUTUNG. |
| `index.html` | `theme-color` `#0b0b0c` → `#000000` | passt zum neuen Grund. Safari färbt damit seine Leisten; per CSS nicht setzbar. |
| `static/manifest.webmanifest` | `background_color`, `theme_color` → `#000000` | gleicher Grund, für die Startbildschirm-App. |

Keine neuen Abhängigkeiten, keine Netzwerkaufrufe, keine Inline-Stile, keine externen Schriften oder Bilder. Server, Datenbank, Tests und Konfiguration sind unverändert.

## 3. Geprüft

Alle Messungen mit Playwright 1.63 und Chromium 153 in Telefon-Emulation 390 × 844 bei 2-facher Pixeldichte und Desktop 1440 × 900.

**GESICHERT (Testläufe, alle grün):**
- `npm run build`, `npm run typecheck`, `npm test`: Datenbank 34, Ingest 338, Web-Smoke 317, Passkey 168, Cleanup 38, Formatierung 7.
- `npm run check:no-send`: 32 Prüfungen.
- Browsertests `e2e-frontend.mjs` 16/16, `e2e-frontend-v2.mjs` 52/52 (darunter Zwei-Spalten-Layout mit langer Liste, Leiste direkt unter der Kopfzeile, Geschwindigkeitstaste rechts neben der Audiospur mit 4 bis 16 px Abstand), `passkey-e2e.mjs` 18/18. Jeweils keine Konsolenfehler und keine CSP-Verletzungen.
- Kein Test wurde geändert.

**GESICHERT (Messungen):**
- Kein Selektor aus den alten CSS-Dateien fehlt; alle `env(safe-area-inset-*)`-Deklarationen sind Zeichen für Zeichen gleich.
- Kein seitliches Scrollen bei 320 × 568 und 844 × 390 (Liste, Chat, Einstellungen: 0 px Überlauf).
- Tippflächen (Probe 21 px ober- und unterhalb sowie links und rechts der Mitte; Textlinks im Fließtext ausgenommen): vorher 13 Bedienelemente unter 42 px (u. a. Abspielen 40 × 40, Dokument laden 40 × 40, Knöpfe 40 hoch, Kontrollkästchen 22 × 22), nachher keines. „bearbeitet“: 62 × 28 → wirksam 74 × 44, nach oben verschoben, weil darunter die nächste Blase beginnt.
- „Bewegung reduzieren“: Animationsdauer des Chat-Fensters 0,01 ms.
- „Kontrast erhöhen“: Trennlinie `#7c7c80`, Sekundärtext 80 % statt 60 %.

**GESICHERT (Kontrast, berechnet nach WCAG aus den Farbwerten):**

| Paar | Verhältnis |
| --- | --- |
| Weiß auf `#000`, `#1c1c1e`, Blase ein `#262628`, Blase aus `#144a3a` | 21,0 / 17,0 / 15,1 / 10,1 : 1 |
| Sekundärtext auf `#000` / `#1c1c1e` / `#2c2c2e` / Chat `#0b0b0c` | 6,4 / 5,9 / 5,3 / 6,3 : 1 |
| Sekundärtext in Blase aus: vorher `#8d979c` | 3,40 : 1 (unter 4,5) |
| Sekundärtext in Blase aus / ein: jetzt 72 % Weiß | 6,1 / 8,5 : 1 |
| Uhrzeit in Blase aus / ein (68 % Weiß) | 5,7 / 7,8 : 1 |
| Link `#6cb8ff` in Blase aus / ein | 4,8 / 7,2 : 1 |
| Gelb auf `#000` / `#1c1c1e`; Zählerschrift auf Gelb | 14,5 / 11,8 / 12,7 : 1 |
| Tab-Beschriftung auf Glas über Schwarz / Grau `#888` / Hellgrau `#bbb` / Weiß: vorher (`#8d979c`, Glas 55 %) | 5,9 / 2,5 / 1,7 / 1,1 : 1 |
| dasselbe jetzt (75 % Weiß, Glas 72 %) | 9,0 / 6,0 / 5,1 / 4,0 : 1 |
| Primärknopf, Gefahrknopf (weiß auf `#1d6f55` / `#7a1f26`) | 6,1 / 10,2 : 1 |
| Fokusring `#6cb8ff` auf Blase aus (Grafik, mindestens 3:1) | 4,8 : 1 |

Gerechnet ohne die Unschärfe, die den Untergrund zusätzlich ausgleicht. Über rein weißem Inhalt läge die Tab-Beschriftung bei 4,0:1; unter der Leiste liegt in Liste, Suche und Einstellungen aber nur dunkler Inhalt mit Avataren.

## 4. VERMUTUNG (nicht geprüft)

- Auf dem iPhone rendert `-apple-system` SF Pro mit optischen Größen; die Laufweite stellt Safari dabei selbst ein. Deshalb gibt es keine eigenen `letter-spacing`-Werte nach Apples Tabelle (sie könnten sich sonst verdoppeln).
- `backdrop-filter` mit `-webkit-`-Präfix wirkt in Safari ab Version 15 wie in Chromium. Unschärfe gibt es nur auf der Navigation, dem Chat-Kopf und den runden Knöpfen der Bildansicht, wie vorher.
- 0,5-px-Haarlinien zeigt Safari auf Retina als eine Gerätepixel-Linie.
- `:has()` (Radius unten an der Blase über einer Folge-Blase, Ausnahme für Gruppenchats) braucht Safari 15.4. Ältere Versionen lassen genau diese Regeln weg: Gruppen bleiben erkennbar, nur die untere Ecke ist rund, und in Gruppenchats würden Nachrichten verschiedener Absender visuell gruppiert (Namen stehen weiter an jeder Blase).
- Der iOS-Schalter (`appearance: none` mit Hintergrundverlauf) erscheint in Safari wie in Chromium.
- Der leere `touchstart`-Listener ist für `:active` auf iOS nötig. Falls nicht, schadet er nicht.
- Der helle Text auf `#000` wirkt auf OLED-Bildschirmen nicht grell (Apple verwendet dieselbe Kombination).

## 5. UNBEKANNT

- Aussehen auf einem echten iPhone und in Safari/WebKit insgesamt; Aussagen wie „sieht aus wie iOS“ sind nicht belegt.
- Leistung des Glas-Effekts und der Animationen auf alten iPhones.
- Verhalten der Leisten bei eingeblendeter Tastatur (Suche, Bestätigungswort).
- Dynamic Island und Home-Balken: Chromium kennt keine Sicherheitsränder; die Werte sind nur im Code gleich geblieben.
- Teilen-Blatt, native Auswahlräder und Datumsfelder auf iOS.
- Ob Safari `prefers-contrast: more` meldet, wenn auf iOS „Kontrast erhöhen“ an ist. `prefers-reduced-transparency` meldet Safari nach meinem Wissen nicht.

## 6. Vorschläge, nicht umgesetzt

| Idee | Warum nicht |
| --- | --- |
| Griff (Grabber) am Sheet | Ein Griff zeigt an, dass sich das Sheet ziehen lässt (`sheets.md` › Mobile: „Include a grabber in a resizable sheet. A grabber shows people that they can drag the sheet to resize it“). Die Sheets lassen sich weder ziehen noch wegwischen; ein Griff wäre ein falsches Versprechen. Wegwischen nach unten wäre eine neue Geste (Regel „kein neuer Funktionsumfang“). Wenn gewünscht: zuerst die Geste, dann den Griff. |
| Inhalt unter Chat-Kopf und Fußleiste scrollen lassen | Erst dann wäre die weiche Kante im Chat ein echter „scroll edge effect“ (`scroll-views.md` › Scroll edge effects: „Only use a scroll edge effect when a scroll view is behind floating interface elements“). Hindernis außer der Layout-Änderung: Die Gesehen-Erkennung (`seenTracker.ts`, IntersectionObserver auf den Nachrichtenbereich) würde Nachrichten unter der Kopfzeile nach 1 s als gesehen zählen, obwohl sie verdeckt sind, und der Sprung zur ersten neuen Nachricht (`offsetTop - 70`) landet unter der Kopfzeile. Beides braucht TypeScript-Änderungen. |
| Schalter rechts in der Zeile | So steht es in iOS-Einstellungen. Wäre eine Verschiebung („nichts wandern“). |
| Dynamic Type | Mit `font: -apple-system-body` und `rem`-Größen würde die Schrift der iOS-Einstellung „Textgröße“ folgen (`typography.md` › Supporting Dynamic Type). Nicht in Chromium prüfbar, und große Stufen (bis 53 pt) würden das Layout spürbar verändern. |
| Mitlaufende Datumskapsel (`position: sticky`) | Wie in WhatsApp. Ändert, was beim Scrollen sichtbar bleibt; eher Verhalten als Gestaltung. |
| Glas am Knopf „Zu den neuesten Nachrichten“ | Er schwebt über Inhalt, Glas wäre dort richtig. Laut Auftrag bleibt `backdrop-filter` auf die Leisten beschränkt; er hat stattdessen eine dichte Füllung mit Lichtkante. |
| Großer Titel, der beim Scrollen in die Kopfzeile wandert | iOS-typisch, braucht JavaScript und verändert die Kopfzeile. |
| Absender als `data-`-Attribut an der Nachricht | Dann könnte die Gruppierung auch in Gruppenchats nach Absender greifen und der Name nur an der ersten Blase stehen. Braucht TypeScript-Änderung in `bubble.ts`. |
| Sprachnachricht wie WhatsApp: Profilbild mit Mikrofon rechts, Geschwindigkeit erst beim Abspielen | WhatsApp zeigt rechts das Profilbild und tauscht es beim Abspielen gegen die Geschwindigkeit. Hier muss die Taste immer rechts neben der Spur erreichbar bleiben, und Profilbilder lädt der Ingest bewusst nicht. Das Mikrofon mit gelbem Punkt bleibt links. |
| „Transkribieren“ | Neue Funktion (Spracherkennung), kein Gestaltungsthema. |
| SF Pro als eingebettete Schriftdatei | Abgelehnt. Der Lizenzeintrag in der Datei (`name`-Tabelle) lautet „Your use of the San Francisco font is subject to the terms of the applicable iOS Software License Agreement“, `fsType` 4 (nur Vorschau und Druck). Die Quelle war ein Fremdportal („Uploaded by MH1“, dessen Angabe „Free for personal use“ stammt nicht von Apple). Ein Commit würde die Dateien über GitHub und jedes Release weitergeben. Auf iPhone und Mac rendert `-apple-system` ohnehin SF Pro, mit dem passenden Text- oder Display-Schnitt. |
| Hellmodus | Ausgeschlossen. Die Farbvariablen sind so angelegt, dass ein zweiter Satz unter `prefers-color-scheme: light` später möglich wäre (`dark-mode.md` › Best practices rät von einem eigenen Schalter in der App ab und empfiehlt, der Systemeinstellung zu folgen). |

## 7. Zweite Runde: näher an iOS 26 (Stand 30. Oktober 2026)

| Bereich | Änderung | HIG |
| --- | --- | --- |
| Chat-Kopf, Neu-Leiste | Keine eigene Fläche und keine Trennlinie mehr; die Glas-Knöpfe (Zurück, Stumm) liegen auf dem Chat-Hintergrund. Unschärfe entfällt dort, weil hinter der Kopfzeile nichts liegt (spart Rechenzeit). | `toolbars.md` › Best practices: „Reduce the use of toolbar backgrounds and tinted controls.“ |
| Ränder des Nachrichtenbereichs | Weiche Kante oben (18 px) und unten (14 px) als feste Überlagerung, keine Maske auf dem Scrollbereich. | `layout.md` › Visual hierarchy: „Instead of applying a solid or semi-opaque background color beneath controls, use a scroll edge effect“ |
| Fußleiste | Schwebende Kapsel (8 px Abstand zum Rand plus Sicherheitsrand) wie die Eingabeleiste in WhatsApp auf iOS. Radius 28 px = Knopfradius 22 px + 6 px Innenabstand. | `toolbars.md` › Best practices: Radien „concentric with bar corners“ |
| Tab-Leiste | Fast volle Breite (`min(100% - 40px, 400px)`), drei gleich breite Tabs (größere Tippflächen), Zähler am Symbol. Darunter eine weiche Abdunklung, weil die Liste wirklich hinter der Leiste durchläuft. | `tab-bars.md` › Phone (iOS): „A tab bar floats above content at the bottom of the screen“; `scroll-views.md` › Scroll edge effects |
| Glas-Bedienelemente | Knöpfe, Statuskapsel und runde Leistenknöpfe mit einheitlicher grauer Füllung und heller Kante (`--control-bg`, `--control-ring`, `--glass-shine`). | `liquid-glass.md` › Cross-platform translation (Füllung, Lichtkante) |
| Einstellungen | Abschnittstitel stehen in kleinen Großbuchstaben über der abgerundeten Gruppe, wie in den iOS-Einstellungen. Ohne `:has()` (Safari vor 15.4) bleibt der Titel in der Gruppe. | `lists-and-tables.md` › Style: „the grouped style uses headers, footers, and additional space to separate groups of data“ |
| Sheets | Schweben 8 px über dem unteren Rand (plus Sicherheitsrand), alle Ecken 32 px; innere Aktionsgruppe 16 px (konzentrisch). | iOS-26-Erscheinungsbild; Anordnung der Schaltflächen unverändert (Schließen bleibt rechts, `sheets.md` sähe es links vor) |

**GESICHERT:** Browsertests 16/16, 52/52, 18/18 grün, keine Konsolenfehler und keine CSP-Verletzung. Kein Überlauf bei 320 × 568 und 844 × 390. Alle Tippflächen bleiben ≥ 44 px (Probe wie oben). Die Fußleiste bricht bei 320/375/390 px in 4/3/2 Zeilen um, genau wie vorher, und ist 5 px niedriger. Alle Sicherheitsränder sind gleich oder größer: Bei Fußleiste und Sheets wurde aus dem Innenabstand ein Außenabstand derselben Größe, der Inhalt sitzt dadurch weiter vom Rand. Unter „Kontrast erhöhen“ kommt die Trennlinie unter dem Chat-Kopf zurück, die weichen Kanten entfallen.

**VERMUTUNG:** Die weichen Kanten (Farbverlauf zu `#0b0b0c` bzw. Schwarz) sehen in Safari wie in Chromium aus. Ohne Unschärfe wirken sie etwas weicher als Apples eigener Effekt.

**UNBEKANNT:** Wirkung auf dem echten iPhone, insbesondere ob die Kapsel-Fußleiste mit eingeblendeter Tastatur (nur in der Suche) gut aussieht.
