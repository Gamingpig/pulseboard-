# PulseBoard — Lokales Google Health Dashboard (GitHub Pages)

Ein schlankes, modernes Health-Dashboard für PC & Laptop, das **zu 100 % lokal im Browser** läuft – ohne eigenes Backend, ohne Datenbank und ohne dass deine Gesundheitsdaten jemals auf einen fremden Server gelangen.

## Features
- **100 % lokal (`localStorage`):** Client ID, OAuth-Token und importierte Daten bleiben ausschließlich in deinem Browser.
- **Direkte Google Health API Anbindung:** Verbindet sich über Google Identity Services direkt vom Browser aus mit `health.googleapis.com/v4`.
- **Google Takeout JSON Import:** Importiere deine Fitbit-/Google-Takeout-Dateien direkt per Datei-Auswahl.
- **Demo-Modus:** Sofort einsatzbereit mit Beispieldaten, bevor du deinen Google-Login einrichtest.
- **Dark & Light Mode** mit interaktiven SVG-Diagrammen.

## Auf GitHub Pages veröffentlichen
1. Erstelle ein neues Repository auf GitHub (z. B. `pulseboard`).
2. Pushe dieses Projekt auf den `main`-Branch.
3. Öffne im GitHub-Repository **Settings → Pages** und wähle unter *Build and deployment* → **Deploy from a branch** (`main`, `/ (root)`).
4. Öffne deine GitHub-Pages-URL (`https://<dein-name>.github.io/<repo>/`), gehe im Dashboard auf **Google-Verbindung** und folge den 4 Schritten zur Verknüpfung mit Google Cloud.
