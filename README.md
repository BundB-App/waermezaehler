# Wärmezähler

Web-App (PWA) zum Erfassen und Auswerten von Wärmemengenzählern (UG, OG, Studio), Ölstand,
Betankungen und Heizungseinstellungen (Vorlauf Tag/Nacht, Kennlinie, Pumpenstufe).

- Läuft auf GitHub Pages, auf dem iPhone über „Zum Home-Bildschirm“ installierbar.
- Daten liegen **nicht** im Repo, sondern als `waermezaehler-daten.json` in einem geteilten Dropbox-Ordner
  (Dropbox-Login per OAuth PKCE, Abgleich mit Zusammenführung bei gleichzeitigen Änderungen).
- Auswertungen: Verbrauch je Woche/Monat/Jahr/Heizperiode, Kreisvergleich, Jahresvergleich,
  Witterungsbereinigung (Gradtage VDI 3807, Open-Meteo), Energiesignatur, Ölverbrauch und -prognose,
  Nutzungsgrad Öl → Wärme, Wirkung von Einstellungsänderungen.

Keine Build-Schritte: statische Dateien, Chart.js per CDN. Lokal testen: `python3 -m http.server 8000`.
