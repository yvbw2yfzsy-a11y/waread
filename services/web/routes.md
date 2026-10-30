# waread Web-API – Referenz für das Frontend

Diese Datei beschreibt, was `services/web` **tatsächlich** ausliefert. Sie folgt dem Vertrag aus dem Projekt-Prompt;
Abweichungen und Ergänzungen sind mit **[Ergänzung]** bzw. **[Präzisierung]** markiert.

## Grundregeln

- **Basis-URL:** Der Dienst kennt kein Präfix. Nginx liefert ihn unter `/waread/` aus und entfernt das Präfix
  (Festlegung beim Zusammenführen, siehe `deploy/nginx/waread.conf`). Das Frontend sollte alle Pfade **relativ** ansprechen (`api/chats`, nicht `/api/chats`),
  damit es unter `/waread/` funktioniert.
- **Statische Dateien:** Der Dienst liefert den gebauten Frontend-Ordner `services/web/public/dist/` selbst aus (`web.public_dir`). Pfade ohne Dateiendung, die nicht existieren,
  fallen auf `index.html` zurück (Single-Page-App). Dotfiles werden nie ausgeliefert.
- **Authentifizierung:** Alles außer `POST /api/login`, `POST /api/logout`, `GET /healthz`, `GET /api/auth/state`,
  `POST /api/passkey/login/options`, `POST /api/passkey/login/verify` und den statischen
  Dateien verlangt ein gültiges Session-Cookie (`waread_session`, HttpOnly, SameSite=Strict). Ohne Session: `401 {"error":"unauthorized"}`.
  Das Frontend muss das Cookie nicht anfassen; `fetch` und `<img>`/`<audio>`/`EventSource` auf dieselbe Origin senden es automatisch.
  Es gibt keinen „Bin ich eingeloggt?"-Endpunkt: `GET api/status` beantworten mit 200 = eingeloggt, 401 = Login-Maske zeigen.
- **Request-Bodies:** JSON mit `Content-Type: application/json` (sonst `415`). Maximal 64 KB (Login 4 KB).
- **Antworten:** JSON, UTF-8, `Cache-Control: no-store` (Ausnahmen: Medien, Avatare, statische Dateien).
- **Fehlerformat:** `{"error": "<code>", ...optionale Felder}`. Der HTTP-Status trägt die Hauptinformation, der Code die Ursache.
- **Zeitstempel:** `waTimestamp`, `seenAt`, `playedAt`, `since`, `lastActivityAt`, `lastMessageAt` und die Suchfilter
  `from`/`to`/`before` werden **unverändert** aus der Datenbank durchgereicht und nie umgerechnet. Die Einheit
  (Sekunden oder Millisekunden) bestimmt der Ingest-Dienst; das Frontend muss `before`/`from`/`to` in derselben Einheit
  wie `waTimestamp` senden. Festlegung des Projekts: überall Unix-**Sekunden**.
- **IDs in Pfaden** (Chat-IDs enthalten `@`) immer mit `encodeURIComponent` kodieren.

### Anforderungen der Content-Security-Policy (wichtig für den Frontend-Bau)

Alle Antworten tragen:

```
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:;
connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'
```

Folgen für das Frontend:

- Keine Inline-Skripte, kein `onclick="..."`, keine externen CDNs, keine externen Schriften/Bilder.
- **Keine Inline-Styles im Markup** (`style="..."` und `setAttribute('style', …)` werden blockiert). Dynamische Werte über
  CSS-Klassen oder per CSSOM (`el.style.width = '40px'`) setzen – das ist erlaubt.
- Bilder aus `data:` sind erlaubt (QR-Code). Es gibt keine automatischen Link-Vorschauen; Links im Nachrichtentext
  sollten als einfacher Text/`<a rel="noreferrer noopener">` ohne Nachladen dargestellt werden.

## Authentifizierung

### `POST api/login`
Body `{ "password": "<string 1..1024>" }`
- `200 {"ok":true}` + `Set-Cookie`. Lebensdauer standardmäßig 30 Tage.
- `401 {"error":"invalid_credentials"}`
- `403 {"error":"passkey_required"}` **[Ergänzung]**: die Passkey-Sperre ist aktiv, das Passwort wird nicht mehr angenommen (und nicht geprüft).
- `429 {"error":"too_many_attempts","retryAfterSeconds":N}` + Header `Retry-After`. Limit: 5 Versuche / 15 Minuten pro Client-IP;
  ein erfolgreicher Login setzt den Zähler zurück. Auch ein falsch formatierter Versuch zählt.
- `503 {"error":"busy"}` (Passwortprüfungen laufen nacheinander, Warteschlange voll – später erneut versuchen)
- `503 {"error":"auth_unavailable"}` (Serverkonfiguration defekt; kein Login möglich)

### `POST api/logout`
`200 {"ok":true}`, löscht das Cookie. Funktioniert auch ohne Session.

## Passkey-Sperre **[Ergänzung]**

Optional; braucht `web.passkey_rp_id` und `web.passkey_origin` (HTTPS und Host-Name, siehe `docs/INSTALL.md`, Abschnitt 17).
Alle Bodies sind JSON (`Content-Type: application/json`). Binärwerte (Challenge, IDs, Signaturen) sind base64url **ohne** Auffüllung.
Fehlgeschlagene Bestätigungen (`step/verify`) antworten mit **403**, nicht 401, damit das Frontend sie nicht mit einer abgelaufenen Sitzung verwechselt.

**Ohne Sitzung:**

- `GET api/auth/state` → `200 {"lock":boolean,"passkey":boolean}`. `lock`: Sperre aktiv. `passkey`: ein Passkey-Login ist möglich (konfiguriert und mindestens ein Passkey).
- `POST api/passkey/login/options` Body `{}` → `200 {"challengeId":"…","options":{…}}` (WebAuthn-Optionen für `navigator.credentials.get`, `allowCredentials` leer, `userVerification:"required"`). Challenge gilt 180 s, einmal.
- `POST api/passkey/login/verify` Body `{"challengeId","credential"}` → `200 {"ok":true}` + `Set-Cookie` (Laufzeit `passkey_session_hours`). `400 challenge_expired`, `401 invalid_credentials`, `409 passkey_unavailable` (kein Passkey eingerichtet) bzw. `409 passkey_not_configured` (Server nicht konfiguriert), `429 too_many_attempts`, `503 passkey_store_broken` (Passkey-Datei unlesbar; die Sperre bleibt zu).

**Mit Sitzung** (bei aktiver Sperre zusätzlich eine frische Passkey-Bestätigung, „Freigabe“, für Hinzufügen, Löschen und Ausschalten):

- `GET api/passkeys` → `200 {"configured","rpId","origin","lock","sessionHours","passkeys":[{"id","label","createdAt","lastUsedAt","backupEligible","backupState"}]}` (nie Schlüsselmaterial).
- `POST api/passkey/step/options` `{"purpose":"lock_on"|"lock_off"|"register"|"delete"}` → `200 {"challengeId","options"}`.
- `POST api/passkey/step/verify` `{"challengeId","credential"}` → `200 {"ok":true,"grant":"…","expiresInSeconds":120}`. Die Freigabe gilt 120 s, einmal, nur für diesen Zweck und nur für diese Sitzung.
- `POST api/passkey/register/options` `{"grant"?}` → `200 {"challengeId","options"}`. `grant` (Zweck `register`) ist bei aktiver Sperre Pflicht (`403 step_up_required`). Höchstens 10 Passkeys (`409 too_many_passkeys`).
- `POST api/passkey/register/verify` `{"challengeId","credential","label"}` → `200 {"ok":true, …wie GET api/passkeys}`. `400 challenge_expired`, `400 invalid_credential` (Prüfung der Registrierung fehlgeschlagen; der Grund steht nur im Server-Log), `409 passkey_exists`.
- `POST api/passkey/lock/on` `{"grant"}` (Zweck `lock_on`, immer Pflicht) → `200`; setzt ein neues Cookie, alle früheren Sitzungen sind ungültig, offene SSE-Verbindungen werden beendet.
- `POST api/passkey/lock/off` `{"grant"}` (Zweck `lock_off`) → `200`; ebenso neues Cookie (Laufzeit `session_days`), frühere Sitzungen ungültig.
- `POST api/passkey/delete` `{"id","grant"?}` → `200`. Bei aktiver Sperre ist `grant` (Zweck `delete`) Pflicht und der letzte Passkey nicht löschbar (`409 last_passkey_while_locked`). Unbekannte ID: `404 passkey_not_found`.

## Verbindung

### `GET api/status`
`200 { "state": "connected"|"connecting"|"disconnected"|"needs_qr", "since"?: number }`
Der Zustand kommt vom Ingest-Dienst. `since` fehlt, wenn der Ingest keinen Wert gemeldet hat.

### `GET api/qr`
- `200 { "qr": "data:image/svg+xml;base64,..." }` – **[Präzisierung]** immer eine Daten-URL, direkt als `<img src>` verwendbar (nicht als HTML einsetzen).
- `404 {"error":"no_qr"}` – kein QR ansteht (Zustand ist nicht `needs_qr`).
- `503 {"error":"qr_render_unavailable"}` – QR liegt vor, kann aber auf dem Server nicht gerendert werden.

Der QR-Code wechselt alle paar Sekunden. Solange `state === "needs_qr"`, `api/qr` regelmäßig neu laden (z. B. alle 2–3 s)
und zusätzlich auf `connection_status` hören. QR-Codes werden **nie** per SSE verschickt. Maßgeblich sind die Werte, die der Ingest-Dienst
in die `settings`-Tabelle schreibt (`connection.status`, `connection.qr`, …); `api/status` und `api/qr` lesen von dort.

### `POST api/connect` (**[Ergänzung]**)
„Neu verbinden". Body wird nicht ausgewertet. `202 {"ok":true}`. Der Web-Dienst spricht nicht mit WhatsApp: Er legt nur den Befehl
`connection.command = connect` in die `settings`-Tabelle; der Ingest-Dienst holt ihn ab (innerhalb weniger Sekunden), beginnt eine
neue Kopplung (Zustand `needs_qr`, danach `api/qr`) und ignoriert den Befehl, solange eine Verbindung besteht. Gedacht für den Zustand
nach einer Abmeldung oder einem abgelaufenen QR, in dem der Ingest von sich aus nichts mehr versucht.

## Chats & Nachrichten

### `GET api/chats`
`200 Chat[]`, sortiert nach der **letzten Nachricht** (neueste zuerst). Chats ohne gespeicherte Nachricht werden nicht geliefert.

```jsonc
{
  "id": "4915111@s.whatsapp.net",
  "name": "Anna",                    // nie leer: Fallback = Teil der ID vor dem "@"
  "isGroup": false,
  "hasAvatar": true,                 // true -> GET api/chats/<id>/avatar
  "lastActivityAt": 1700000011,      // number | null
  "lastMessagePreview": "Hallo …",   // string (max. 140 Zeichen, Leerraum zusammengefasst) | null (kein Text / gelöscht)
  "lastMessageType": "text",         // text|image|voice|video|document|system
  "lastMessageDirection": "in",      // in|out
  "lastMessageAt": 1700000010,       // waTimestamp der letzten Nachricht
  "lastMessageDeleted": false,
  "lastMessageDurationSeconds": 63,  // number | null (Sprachnachricht/Video als letzte Nachricht)
  "lastMessageSender": "Lisa",       // string | null: Absender der letzten EINGEHENDEN Nachricht (Gruppenvorschau)
  "unreadCount": 3,                  // „neu": eingehend, seenAt = null, nicht gelöscht, kein System
  "muted": false                     // [Version 2] stumm: reine Anzeige, zählt im Frontend nicht bei „Neu"
}
```
Für Medien ohne Text ist `lastMessagePreview` `null`; das Frontend zeigt dann ein Symbol/Label passend zu `lastMessageType`.

### `GET api/chats/:id/avatar` **[Ergänzung]**
Profilbild (Bild-MIME, `Cache-Control: private, max-age=3600`). `404`, wenn keines vorhanden ist.

### `GET api/chats/:id/messages?before=<waTimestamp>&beforeId=<messageId>&limit=50`
`200 Message[]`, **aufsteigend sortiert** (älteste zuerst). Ohne `before` die neuesten `limit` Nachrichten; mit `before`
die `limit` Nachrichten **streng davor**.
- `limit`: 1–200, Standard 50. Ungültige Werte → `400 {"error":"invalid_parameter","parameter":"limit"}`.
- `beforeId` **[Ergänzung]**: Optional zusammen mit `before` setzen. Es stabilisiert die Seitengrenze bei mehreren Nachrichten
  mit gleichem Zeitstempel. Zum Nachladen älterer Nachrichten: `before` = `waTimestamp` und `beforeId` = `id` der **ältesten
  bereits geladenen** Nachricht.
- `404 {"error":"chat_not_found"}`.

```jsonc
// Message
{
  "id": "3EB0…",
  "chatId": "4915111@s.whatsapp.net",
  "sender": "…",                     // so gespeichert wie vom Ingest geliefert (kein Anzeigename garantiert)
  "waTimestamp": 1700000003,
  "direction": "in",                 // in|out
  "type": "image",                   // text|image|voice|video|document|system
  "text": "Foto vom See",            // Text bzw. Bildunterschrift; null bei geloeschten Nachrichten
  "replyTo": null,                   // ID der zitierten Nachricht | null
  "quoted": null,                    // [Version 2] siehe unten; null, wenn replyTo null ist
  "edited": false,
  "editedAt": null,                  // number | null, Zeitpunkt der letzten Bearbeitung
  "editCount": 0,                    // Zahl früherer Fassungen (GET api/messages/:id/versions)
  "deleted": false,                  // „für alle gelöscht" (vom Absender)
  "deletedAt": null,                 // number | null
  "viewOnce": false,                 // Einmal-Ansehen-Nachricht (nur Kennzeichnung)
  "protectedAt": null,               // number | null: Schild; geschützte Nachrichten löscht kein automatischer Lauf
  "seenAt": null,                    // number | null  – null = „neu" (gelb), nur für direction "in" relevant
  "playedAt": null,                  // number | null  – bei voice: null = noch nicht angehört
  "media": {                         // null, wenn die Nachricht keine Medien hat
    "status": "ready",               // pending|downloading|ready|failed|expired
    "mimeType": "image/jpeg",        // string | null
    "sizeBytes": 2000,               // number | null
    "durationSeconds": null,         // number | null
    "hasThumbnail": true,            // true -> GET api/media/<id>?thumb=1
    "fileName": null,                // Originalname bei Dokumenten (ohne Nachrichten-ID), sonst null
    "skipReason": null,              // rule_off | too_large | history | queue_full | retention | failed | link_expired | null
    "loadable": false                // true -> POST api/media/<id>/load ist möglich
  }
}
```
- **Gelöschte Nachrichten** (`deleted: true`, „für alle gelöscht" vom Absender): Standardmäßig bleiben `text` und `media`
  erhalten, das Frontend kennzeichnet sie mit „Vom Absender gelöscht". Mit `web.hide_deleted_content = true` sind `text` und
  `media` `null` und die Medien nicht abrufbar. Der Ingest erkennt Löschungen und Bearbeitungen über das Ereignis
  `messages.update` der Bibliothek (lokal, ohne Anfrage an WhatsApp).
- **`quoted`** (nur bei Antworten): `{ "id", "available", "sender", "fromMe", "type", "text", "deleted" }`. `available: true`:
  die Originalnachricht ist noch gespeichert, die Angaben stammen von ihr (`text` höchstens 140 Zeichen). `available: false`:
  das Original ist weg; `sender`, `type` und `text` stammen aus dem Kurzzitat, das der Ingest beim Speichern der Antwort
  abgelegt hat (können fehlen). `fromMe` ist dann `null`.
- **Dokumentname:** Dokumente liegen als `<Nachrichten-ID>__<Originalname>` auf der Platte; `media.fileName` und der
  `Content-Disposition`-Header des Downloads nennen nur den Originalnamen.
- Dateisystempfade werden nie ausgeliefert. Medien holt man immer über `api/media/<messageId>`.

### `PUT api/chats/:id/mute` **[Version 2]**
Body `{ "muted": true|false }`. Reine Anzeige-Einstellung (settings `chat.muted`, JSON-Liste, höchstens 1000 Einträge). `200 {"ok":true,"muted":boolean}`,
`400 invalid_body`, `404 chat_not_found`, `409 too_many_muted_chats`.

### `POST api/chats/:id/seen`
Body: **genau eines** von `{ "all": true }` oder `{ "upTo": "<messageId>" }`.
`200 {"updated": N}` (Anzahl neu als gesehen markierter Nachrichten). Der Zustand ist rein lokal; WhatsApp erfährt nichts.
Fehler: `400 all_or_upTo_required` (keins oder beide), `400 invalid_body`, `404 chat_not_found`.
Betroffene Nachrichten kommen zusätzlich als `message_updated` per SSE (auch in anderen Browser-Tabs).

### `POST api/messages/:id/played`
Kein Body nötig. `200 {"ok":true,"playedAt":number|null}`. Idempotent (der erste Zeitpunkt bleibt). `404 message_not_found`.

### `GET api/messages/:id/versions` **[Version 2]**
`200 { "id", "current": { "text", "editedAt" }, "versions": [ { "version": 1, "text", "replacedAt" }, … ] }`, älteste zuerst
(`version` 1 = Original, `replacedAt` = Zeitpunkt der nächsten Bearbeitung). `404 message_not_found`, auch bei gelöschten Nachrichten,
wenn `hide_deleted_content` an ist.

### `POST api/messages/:id/protect` **[Version 2]**
Body `{ "protected": true|false }` (Boolean, sonst `400 invalid_body`). Schild setzen oder entfernen.
`200 { "ok": true, "protectedAt": number|null, "loading": boolean }`. `loading: true`: Die Nachricht hat ein ladbares Medium, und
das Setzen des Schilds hat zugleich den Befehl „Medium laden" abgelegt. Geschützte Nachrichten (samt Medien und Versionen)
löscht weder der Cleanup-Dienst noch `POST api/storage/clear` ohne `includeProtected: true`. Zugehöriges SSE: `message_updated`.

## Medien

### `GET api/media/:messageId` und `GET api/media/:messageId?thumb=1` (**`?thumb=1` ist eine [Ergänzung]**)
- Mit **Range-Unterstützung** (ein Bereich pro Anfrage; `206`, `Accept-Ranges: bytes`, `416` bei nicht erfüllbarem Bereich).
  Safari braucht das für Audio/Video – `<audio src="api/media/<id>">` genügt, das Cookie wird automatisch gesendet.
- `ETag`/`If-None-Match` werden unterstützt (`304`), `Cache-Control: private, max-age=3600`.
- **Inline** nur für eine feste Positivliste passend zum Nachrichtentyp: Bilder (jpeg, png, webp, gif), `voice` (mp4/aac, mpeg, ogg, webm, wav),
  `video` (mp4, webm, quicktime). **Alles andere** (Dokumente, SVG, HTML, unbekannte Typen) kommt als
  `Content-Disposition: attachment` mit `application/octet-stream` – als Download-Link darstellen, niemals in `<iframe>`/`<object>` einbetten.
- `404 {"error":"media_not_ready","status":"pending|downloading|failed|expired"}`, wenn die Datei (noch) nicht vorliegt.
  Das Frontend richtet sich nach `message.media.status` und lädt nur bei `ready`.
- `?thumb=1`: Vorschaubild (jpeg/png/webp) – nur wenn `media.hasThumbnail` true ist, sonst `404`.

### `POST api/media/:messageId/load` **[Version 2]**
„Medium jetzt laden". Der Web-Dienst spricht nie mit WhatsApp oder dem Medienhost: Er legt nur den Befehl `load_media` in die Tabelle
`ingest_commands`; der Ingest holt genau dieses Medium (ein HTTPS-Abruf an den Medienhost, bis `max_mb_forced`) und meldet das
Ergebnis über `media_ready`. `202 {"ok":true}`; ein schon wartender Befehl für dieselbe Nachricht wird nicht verdoppelt.
`404 not_found` (unbekannt), `409 not_loadable` (`media.loadable` ist false).

## Suche

### `GET api/search?q=&chatId=&type=&from=&to=&onlyNew=&limit=`
`200 SearchHit[]` = `Message` plus `"chatName": string`, **neueste zuerst**, höchstens `limit` (1–200, Standard 100; `limit` ist eine **[Ergänzung]**).
- `q`: Freitext, max. 200 Zeichen. Wörter werden UND-verknüpft, das letzte Wort wirkt als Präfix („hal" findet „Hallo").
  Groß-/Kleinschreibung und Akzente (ü → u) sind egal. Bekannte Grenze: `ß` wird **nicht** zu `ss` gefaltet. FTS-Operatoren
  (`AND`, `OR`, `NEAR`, `-`, `*`, `"`, `:` …) haben **keine** Sonderbedeutung; Sonderzeichen sind harmlos.
- `chatId`, `type` (`text|image|voice|video|document|system`, sonst `400`), `from`/`to` (inklusive, Einheit wie `waTimestamp`), `onlyNew` (`1|true|0|false`).
- Ohne `q` muss mindestens ein Filter gesetzt sein, sonst `400 {"error":"q_or_filter_required"}` (z. B. `?onlyNew=1` liefert alle neuen Nachrichten).
- Nur Sonderzeichen in `q` → `200 []`. Gelöschte Nachrichten sind nur mit `hide_deleted_content = true` nicht auffindbar.

## Einstellungen & Speicher

### `GET api/settings` / `PUT api/settings`
```jsonc
{
  "retentionDays": 3,            // 1 | 3 | 7 | 14 | 30
  "retentionMediaDays": 3,       // 1 | 3 | 7 | 14 | 30, darf retentionDays nicht überschreiten
  "storageLimitMb": 0,           // ganze Zahl 0..10000000; 0 = kein Limit
  "downloadRules": {             // je Typ: mode "auto" | "off", maxMb 1..500
    "image":    { "mode": "auto", "maxMb": 10 },
    "voice":    { "mode": "auto", "maxMb": 10 },
    "video":    { "mode": "off",  "maxMb": 50 },
    "document": { "mode": "auto", "maxMb": 20 }
  }
}
```
- `PUT` ist eine **Teilaktualisierung**: nur mitgeschickte Felder ändern sich; bei `downloadRules` je Typ und je Feld. Antwort = vollständiger neuer Stand.
- Fehler `400`: `invalid_setting` (mit `field`), `unknown_setting`, `empty_update`, `media_retention_exceeds_message_retention`.
- *(Offen: Schema von `downloadRules` und die Bedeutung von `"off"` = „Metadaten speichern, Datei nicht laden" sind ein Vorschlag, der mit dem Ingest-Team abgestimmt werden muss.)*

### `GET api/storage/usage`
```jsonc
{
  "protectedMessages": 0,      // [Version 2] Nachrichten mit Schild
  "protectedMediaBytes": 0,    // Summe ihrer fertig geladenen Mediendateien
  "totalBytes": 123456,        // mediaBytes + dbBytes
  "mediaBytes": 120000,        // Summe media.size_bytes (nur status "ready", ohne Thumbnails)
  "dbBytes": 3456,             // Datenbankdatei inkl. WAL/SHM
  "limitBytes": null,          // storageLimitMb in Bytes oder null (kein Limit)
  "diskFreeBytes": 1000000,    // number | null (Dateisystem von media_dir)
  "diskTotalBytes": 9000000,   // number | null
  "perChat": [ { "chatId": "…", "name": "Anna", "messageCount": 12, "mediaCount": 3, "mediaBytes": 2100 } ],  // größte zuerst
  "perType": [ { "type": "image", "mediaCount": 1, "mediaBytes": 2000 } ]
}
```

### `POST api/storage/clear`
Body `{ "scope": "chat"|"media"|"all", "chatId"?: string, "confirm": true, "includeProtected"?: true }` – **`confirm` muss exakt das Boolean `true` sein**
(`"true"` oder `1` werden abgelehnt: `400 confirm_required`). Löscht **endgültig**; das Frontend muss vorher nachfragen.
**Geschützte Nachrichten (Schild) bleiben stehen**, ausser `includeProtected` ist genau `true` (jedes andere Nicht-Boolean: `400 invalid_body`).
Die Antwort nennt `keptProtected` (Zahl der verbliebenen geschützten Nachrichten).
- `chat`: alle Nachrichten und Medien dieses Chats (`chatId` Pflicht, `404 chat_not_found`, `400 chat_id_required`).
- `media`: alle Mediendateien; die Nachrichten bleiben, `media.status` wird `expired`.
- `all`: alle Nachrichten und Medien.
- `200 { "deletedMessages": n, "deletedMedia": n, "freedBytes": n, "keptProtected": n }`, anschließend SSE `cleanup_done`. Der Avatar-Cache bleibt unberührt.
- `409 clear_in_progress`, wenn gerade eine Löschung läuft.

## Live-Updates (Server-Sent Events)

`GET events` – `EventSource('events')` (gleiche Origin, Cookie automatisch). Erste Frames nach dem Verbinden:
`retry: 3000` und ein `connection_status` mit dem aktuellen Zustand. Alle weiteren Frames tragen `id:` (Outbox-ID);
nach einer Unterbrechung sendet der Browser automatisch `Last-Event-ID`, und der Dienst spielt Verpasstes nach (soweit noch
vorgehalten – die Outbox behält die letzten ~1000 Ereignisse). **Nach einem Reconnect trotzdem `api/chats` und die offene
Chat-Ansicht neu laden**, denn bei langen Pausen kann Verpasstes fehlen. Alle 25 s kommt ein Kommentar-Heartbeat (`: ping`).
Höchstens 16 gleichzeitige Verbindungen (`503 too_many_clients`).

| `event:` | `data:` (JSON) |
|---|---|
| `new_message` | `{ "chatId": string, "message": Message }` – `Message` exakt wie in der REST-Antwort |
| `message_updated` | `{ "messageId", "chatId", "seenAt": number\|null, "playedAt": number\|null, "deleted": boolean, "deletedAt": number\|null, "edited": boolean, "editedAt": number\|null, "editCount": number, "protectedAt": number\|null, "text": string\|null }` – **[Präzisierung]** immer der vollständige aktuelle Stand (Obermenge des Vertrags; Bearbeitung, Löschung und Schild ergänzt) |
| `media_ready` | `{ "messageId", "chatId", "status", "skipReason", "loadable", "thumbnailPath"?: "api/media/<id>?thumb=1", "filePath"?: "api/media/<id>" }` – **[Präzisierung]** statt Dateisystempfaden relative API-Pfade; `thumbnailPath` nur falls vorhanden, `filePath` nur bei `status: "ready"`; `skipReason`/`loadable` ändern sich auch ohne neue Datei (z. B. nach „Medium jetzt laden") |
| `connection_status` | `{ "state": "connected"\|"connecting"\|"disconnected"\|"needs_qr", "since"?: number }` |
| `history_synced` | `{ "stored": number }` – **[Ergänzung]** einmal je Verlaufspaket nach dem Koppeln; Chatliste neu laden (der Verlauf erzeugt keine einzelnen `new_message`) |
| `cleanup_done` | `{ "deletedMessages": number, "deletedMedia": number }` – Chatliste und offene Ansicht neu laden |

Hinweise: `seen` für viele Nachrichten erzeugt viele einzelne `message_updated`-Ereignisse. Ereignisse für Nachrichten, die inzwischen
gelöscht wurden, werden verworfen.

## Sonstiges

- `GET healthz` → `200 OK` (Text) ohne Login, `503`, wenn die Datenbank nicht lesbar ist.
- Unbekannter Pfad: `404 {"error":"not_found"}`; falsche Methode: `405 {"error":"method_not_allowed"}` mit `Allow`-Header.
- `400 bad_path`: nicht dekodierbarer Pfad. `413`: Body zu groß. `500 {"error":"internal_error"}`: Details stehen nicht in der Antwort.
