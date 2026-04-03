# PAROLE XL - Nuova Modalità Multiplayer

Questa è una modalità di gioco integrata ma isolata che permette di giocare con parole di lunghezza variabile (5, 6, 7, 8 lettere) in multiplayer.

## 🚀 Come Funziona

La modalità è stata integrata nel server principale (`server.js`) tramite un namespace dedicato (`/parole_xl`), mantenendo la logica isolata in questa cartella.

1. **Avviare il Gioco:**
   Avvia normalmente il server principale:
   ```bash
   node server.js
   ```

2. **Giocare:**
   - Dalla Home page, clicca sul nuovo riquadro **Parole XL**.
   - Oppure visita direttamente: `http://localhost:3000/modes/parole_xl/index.html`

## 🎮 Funzionalità

### Modalità di Gioco
1. **⏱️ Turni (45s)**
   - I giocatori si alternano per indovinare la *stessa* parola (collaborativo/competitivo su griglia condivisa).
   - Tutti vedono le parole inserite da tutti.
   - Timer di 45 secondi per turno.

2. **⚡ No Turni (Gara di Velocità)**
   - Ognuno gioca sulla propria griglia privata contemporaneamente.
   - **Obiettivo**: Indovinare la parola prima degli altri.
   - **Visibilità**: Tu vedi la tua griglia. Degli avversari vedi solo il punteggio (es. **3/7** lettere verdi trovate).
   - Accetta qualsiasi parola (validazione disabilitata).

### Altre Opzioni
- **Lunghezze Variabili:** 5, 6, 7, 8 lettere.
- **Shuffle Mode:** Lunghezza casuale ogni round.
- **Vittoria:**
  - Il primo che indovina vince.
  - Messaggio a centro schermo con il nome del vincitore e la parola segreta.

## 📁 Struttura File Aggiornata
- `server.js`: Modulo logica server (esporta funzione di init).
- `client.js`: Logica client (Socket.io namespace `/parole_xl`).
- `index.html`: Interfaccia utente.
- `style.css`: Stile isolato.
- `words.js`: Database parole.
