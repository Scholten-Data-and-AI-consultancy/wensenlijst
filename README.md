# Wensenlijst

Cadeauwensen bijhouden voor Sinterklaas, Kerst, Oud en Nieuw of een verjaardag. Het is een installeerbare webapp: je zet hem op het beginscherm van je iPhone of Samsung en daarna opent hij schermvullend. Op de computer werkt hij gewoon in de browser. Alles staat op de server, dus wat iemand toevoegt of afvinkt zie je meteen op je eigen telefoon.

- Eén persoon maakt een evenement aan (soort, naam, datum) en zet de deelnemers erin
- Iedere deelnemer krijgt een eigen link, die de organisator met één tik via WhatsApp stuurt
- Iedereen zet wensen op zijn lijstje: link naar de winkel, omschrijving, prijs en een opmerking
- Bij de lijstjes van de anderen tik je op **Ik koop dit**. De anderen zien dan "Gekocht door Anna" en kopen het niet nog eens
- **Wat er van jouw eigen lijstje gekocht is, zie je nooit.** De server laat dat weg uit alles wat naar jouw telefoon gaat, dus ook spieken via de ontwikkelaarstools lukt niet
- Haalt iemand een wens weg die jij al gekocht had, dan krijg jij daar een melding van
- Onder **Mijn aankopen** zie je per persoon wat jij koopt, met het totaal
- De organisator kan deelnemers toevoegen, hernoemen of verwijderen, een link vervangen die bij de verkeerde terechtkwam en het evenement aanpassen of verwijderen

## Draaien

```bash
AANMAAKCODE=geheim npm start      # http://localhost:3000
npm test
```

Geen dependencies, alleen Node 20 of nieuwer.

| Variabele | Betekenis |
|-----------|-----------|
| `AANMAAKCODE` | Code die nodig is om een evenement aan te maken. Meedoen gaat met de persoonlijke link, daar is geen code voor nodig. Hoofdletters, spaties eromheen en aanhalingstekens tellen niet mee. Leeg betekent dat iedereen met het adres een evenement kan aanmaken. |
| `DATA_DIR` | Map voor `wensen.json`. In Docker is dat `/data`. |
| `PORT` | Standaard 3000. |

## Online zetten met Coolify

1. Nieuwe resource, kies deze repo, build pack **Dockerfile**.
2. Zet `AANMAAKCODE` als environment variable.
3. Voeg een **persistent storage** toe met destination `/data`, anders ben je de lijstjes kwijt bij elke deploy.
4. Geef hem een domein, bijvoorbeeld `wensen.siteoptima.nl`, met HTTPS. Zonder HTTPS werkt installeren niet.

## Op je telefoon zetten

Open eerst je persoonlijke link en zet de app **vanaf die pagina** op je beginscherm:

- **iPhone**: in Safari op Deel tikken en Zet op beginscherm kiezen.
- **Samsung**: in Chrome of Samsung Internet het menu openen en App installeren of Toevoegen aan startscherm kiezen.

Een app op het beginscherm van een iPhone begint met lege opslag. Daarom staat je persoonlijke link in het adres (`#k=...`) en heeft het manifest bewust geen `start_url`: de app start dan op het adres waar je hem toevoegde en weet zo nog wie je bent. Gaat dat toch mis, dan kun je de link op het startscherm van de app plakken.

## Hoe het werkt

- `lib.js` bevat het datamodel en elke regel over wie wat mag zien of doen. `viewEvent()` knipt per deelnemer weg wat die niet mag zien: aankopen op het eigen lijstje en de links van anderen (die ziet alleen de organisator).
- `server.js` bewaart alles in één JSON-bestand en meldt nieuwe versies via Server-Sent Events. De telefoon haalt dan zijn eigen weergave opnieuw op. Een persoonlijke link gaat altijd in de body van een POST mee, nooit in een URL op de server, dus hij komt niet in logs terecht. Het stuk na `#` stuurt een browser nooit naar de server.
- Wie andermans link heeft, is voor de app die persoon. Daarom staat er op het welkomstscherm dat je het adres niet moet doorsturen. De organisator kan een link vervangen.

De iconen maak je opnieuw met `python3 scripts/make-icons.py public/icons` (vereist Pillow).
