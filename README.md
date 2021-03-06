![Contentfly CMS](https://www.contentfly-cms.de/file/get/7d937604-23e2-11e8-b76e-00ac10d52400)

# Contentfly
- **Lizenz**: Duale Lizenz MIT/ Properitär
- **Webseite**: http://www.contentfly-cms.de

## Die Contentfly Plattform

- **CMS**: https://github.com/area-net-gmbh/contentfly-cms
- **Ionic SDK**: https://github.com/area-net-gmbh/contentfly-ionic
- **Dokumentation**: https://www.contentfly-cms.de

# Releases-Notes

## Version 1

### 1.2.5

- Beim ersten Start werden alle Daten neu synchronisiert (syncstate wird nicht geladen)

### 1.2.4

- Nur benötigte Dateien synchronisieren (syncUsedFilesOnly)
- abhängige Entitäten laden (dependentEntities)

### 1.2.1

- Unterstützung Statistik-Plugin

## Version 2

- Ionic 4 und Capacitor
- siehe Branch v2

## Installation

**Installation per NPM**
`npm install contentfly-ionic`

**src/app/app.module.ts**
```
...
import {ContentflyModule} from "contentfly-ionic";

@NgModule({
  declarations: [
    ...
  ],
  imports: [
    ...
    ContentflyModule.forRoot({
      baseUrl: 'https://url.zum-contentfly-cms.de/'
    })
  ],
  bootstrap: [IonicApp],
  entryComponents: [
    MyApp
  ],
  providers: [
    ...
  ]
})
export class AppModule {}

```

Weiterführende Dokumentation unter https://www.contentfly-cms.de/docs/inonic

# Modulinformationen

Erstellen des Modules
`npm run build`

Veröffentlichen des Modules
`npm publish`

# Lizenz

Die Contentfly Plattform ist unter eine dualen Lizenz (MIT und properitär) verfügbar. Die genauen Lizenzbedingungen sind in der Datei _LICENCE_ zu finden.

# Die Contentfly Plattform ist ein Produkt der AREA-NET GmbH

AREA-NET GmbH
Werbeagentur, Internetagentur und App Agentur
Öschstrasse 33
73072 Donzdorf

**Kontakt**

- Telefon: 0 71 62 / 94 11 40
- Telefax: 0 71 62 / 94 11 18
- http://www.area-net.de
- http://www.app-agentur-bw.de
- http://www.Contentfly-cms.de


**Geschäftsführer**
Gaugler Stephan, Köller Holger, Schmid Markus

**Handelsregister**
HRB 541303 Ulm
Sitz der Gesellschaft: Donzdorf
UST-ID: DE208051892




