/**
 * Word Cache Pre-Warmer for WordleChain
 * 
 * Validates common Italian words via LanguageTool API and saves
 * them to word_cache.json so they're instantly available in-game.
 * 
 * Usage: node prewarm_cache.js
 * 
 * The script respects API rate limits with delays between requests.
 * Run it once before deploying — the cache file persists across server restarts.
 */

const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, 'word_cache.json');

// Common Italian words (3+ letters) that are frequently used in WordleChain
const COMMON_WORDS_IT = [
    // A
    'ACQUA', 'ALBERO', 'ALTO', 'AMORE', 'AMICO', 'ANCORA', 'ANDARE', 'ANIMALE', 'ANNO', 'ANTICO',
    'APERTO', 'ARIA', 'ARRIVO', 'ARTE', 'ATTESA', 'AVERE', 'AZIONE', 'AZZURRO',
    // B
    'BAMBINO', 'BANCA', 'BANCO', 'BANANA', 'BARCA', 'BASSO', 'BELLO', 'BENE', 'BIANCO', 'BOCCA',
    'BORSA', 'BOSCO', 'BRACCIO', 'BRAVO', 'BUONO', 'BURRO', 'BUSTA',
    // C
    'CALCIO', 'CALDO', 'CAMBIO', 'CAMERA', 'CAMINO', 'CANE', 'CANTARE', 'CAPELLI', 'CAPIRE',
    'CAPPELLO', 'CARNE', 'CARTA', 'CASA', 'CASO', 'CASTELLO', 'CAVALLO', 'CENTRO', 'CERCARE',
    'CHIARO', 'CHIAVE', 'CHIESA', 'CIELO', 'CINEMA', 'CLASSE', 'COLORE', 'COME', 'COMUNE',
    'CONTO', 'CORPO', 'CORRERE', 'CORTO', 'COSA', 'COSTA', 'CREARE', 'CUCINA', 'CUORE', 'CURA',
    // D
    'DARE', 'DENTRO', 'DENTE', 'DESTRO', 'DIRE', 'DIRITTO', 'DISCO', 'DOLCE', 'DOMANDA',
    'DONNA', 'DOPO', 'DORMIRE', 'DOVE', 'DRAGO', 'DURO',
    // E
    'ENTRATA', 'ERBA', 'ERRORE', 'ESSERE', 'ESTATE', 'ESTERNO',
    // F
    'FACCIA', 'FAME', 'FAMIGLIA', 'FARE', 'FATTO', 'FAVORE', 'FELICE', 'FERMARE', 'FERRO',
    'FESTA', 'FIGLIO', 'FINE', 'FINESTRA', 'FIORE', 'FIUME', 'FOGLIA', 'FONDO', 'FORMA',
    'FORNO', 'FORTE', 'FOTO', 'FREDDO', 'FRESCO', 'FRONTE', 'FRUTTA', 'FUOCO', 'FUORI', 'FUTURO',
    // G
    'GAMBA', 'GATTO', 'GENTE', 'GIALLO', 'GIARDINO', 'GIOCO', 'GIORNO', 'GIOVANE', 'GIRO',
    'GONNA', 'GOVERNO', 'GRANDE', 'GRASSO', 'GRAZIE', 'GRIGIO', 'GRUPPO', 'GUANTO', 'GUERRA', 'GUSTO',
    // I
    'IDEA', 'IMMAGINE', 'IMPORTANTE', 'INDIRIZZO', 'INGLESE', 'INSIEME', 'INVERNO', 'ISOLA', 'ITALIA',
    // L
    'LAGO', 'LATTE', 'LAVORO', 'LEGGE', 'LEGNO', 'LENTO', 'LETTERA', 'LETTO', 'LIBERO', 'LIBRO',
    'LINGUA', 'LISTA', 'LUCE', 'LUNGO', 'LUOGO', 'LUPO',
    // M
    'MACCHINA', 'MADRE', 'MAGGIO', 'MAGLIA', 'MALE', 'MAMMA', 'MANO', 'MARE', 'MARITO', 'MATTINA',
    'MEDICO', 'MEGLIO', 'MENTE', 'MERCATO', 'MESE', 'MESSA', 'MEZZO', 'MINUTO', 'MONDO', 'MONTE',
    'MORIRE', 'MOSCA', 'MOTORE', 'MURO', 'MUSEO', 'MUSICA',
    // N
    'NASCERE', 'NATURA', 'NAVE', 'NERO', 'NIENTE', 'NOME', 'NONNO', 'NORD', 'NOSTRO', 'NOTTE',
    'NOVELLA', 'NUOVO', 'NUMERO', 'NUOTO', 'NUVOLA',
    // O
    'OCCHIO', 'OGGI', 'OGNI', 'OLIO', 'OMBRA', 'OPERA', 'ORA', 'ORDINE', 'ORECCHIO', 'ORO',
    'OSPEDALE', 'OVEST',
    // P
    'PADRE', 'PAESE', 'PAGARE', 'PAGINA', 'PALLA', 'PANE', 'PANINO', 'PARCO', 'PARETE', 'PARLARE',
    'PAROLA', 'PARTE', 'PARTIRE', 'PASSARE', 'PASSO', 'PASTA', 'PAURA', 'PELLE', 'PENSARE',
    'PEPE', 'PERDERE', 'PESCE', 'PESO', 'PEZZO', 'PIANO', 'PIAZZA', 'PICCOLO', 'PIEDE', 'PIETRA',
    'PIOGGIA', 'PIATTO', 'PIENO', 'PIZZA', 'POCO', 'POLLO', 'POMERIGGIO', 'PONTE', 'PORTA',
    'PORTARE', 'PORTO', 'POSTO', 'POTERE', 'PRANZO', 'PREZZO', 'PRIMO', 'PRONTO', 'PROPRIO',
    'PROSSIMO', 'PUNTO', 'PURO',
    // Q
    'QUADRO', 'QUALCOSA', 'QUANDO', 'QUANTO', 'QUELLO', 'QUESTO', 'QUESTIONE', 'QUIETE',
    // R
    'RADIO', 'RAGAZZO', 'RAGIONE', 'RAPIDO', 'REGALO', 'REGIME', 'REGOLA', 'RESTO', 'RETE',
    'RICCO', 'RICORDO', 'RIDERE', 'RIPOSO', 'RISPOSTA', 'RIVA', 'ROMA', 'ROMANZO', 'ROSA',
    'ROSSO', 'RUMORE', 'RUOTA',
    // S
    'SABATO', 'SABBIA', 'SALA', 'SALE', 'SALIRE', 'SALUTE', 'SANGUE', 'SAPERE', 'SCALA',
    'SCARPA', 'SCELTA', 'SCENA', 'SCHERZO', 'SCHIENA', 'SCIENZA', 'SCOPRIRE', 'SCRIVERE',
    'SCUOLA', 'SECONDO', 'SEDIA', 'SEGNALE', 'SEMPRE', 'SENSO', 'SENTIRE', 'SERA', 'SERVIRE',
    'SETTE', 'SICURO', 'SIGNORE', 'SILENZIO', 'SIMILE', 'SINISTRO', 'SISTEMA', 'SOGNO',
    'SOLE', 'SOLDI', 'SOLO', 'SONNO', 'SOPRA', 'SORELLA', 'SORTE', 'SOTTO', 'SPALLE',
    'SPECCHIO', 'SPORT', 'STAGIONE', 'STAMPA', 'STANZA', 'STELLA', 'STORIA', 'STRADA',
    'STRANIERO', 'STUDIO', 'STUPIDO', 'SUCCO', 'SUONO',
    // T
    'TAVOLO', 'TAZZA', 'TEMPO', 'TENERE', 'TERRA', 'TESTA', 'TIPO', 'TOGLIERE', 'TORNARE',
    'TORRE', 'TRENO', 'TROPPO', 'TROVARE', 'TUTTO',
    // U
    'UCCELLO', 'UFFICIO', 'ULTIMO', 'UMANO', 'UMORE', 'UNICO', 'UOMO', 'USARE', 'USCIRE', 'UTILE',
    // V
    'VACANZA', 'VALORE', 'VECCHIO', 'VEDERE', 'VELOCE', 'VENDERE', 'VENTO', 'VERDE', 'VERO',
    'VERSO', 'VESTITO', 'VETRO', 'VIAGGIO', 'VICINO', 'VILLA', 'VINCERE', 'VINO', 'VITA',
    'VIVERE', 'VOCE', 'VOLARE', 'VOLERE', 'VOLTA', 'VOLTO',
    // Z
    'ZERO', 'ZONA', 'ZUCCHERO', 'ZUPPA'
];

const wordManager = require('./word_manager');

// ─── Main ────────────────────────────────────────────────────

async function main() {
    const words = COMMON_WORDS_IT;
    let validated = 0;
    let skipped = 0;
    let errors = 0;

    console.log(`\n🚀 Pre-warming cache with ${words.length} Italian words using WordManager...\n`);

    for (let i = 0; i < words.length; i++) {
        const word = words[i];

        // Skip if already cached
        if (wordManager.isWordCached(word)) {
            skipped++;
            continue;
        }

        try {
            const valid = await wordManager.processWord(word, 'it');
            validated++;
            const icon = valid ? '✅' : '❌';
            process.stdout.write(`${icon} ${word.padEnd(15)} [${i + 1}/${words.length}]\r`);
        } catch (err) {
            errors++;
            process.stdout.write(`⚠️  ${word.padEnd(15)} ERROR: ${err.message}\r`);
        }

        // Rate limit: ~200ms between requests to be nice to the API
        await new Promise(resolve => setTimeout(resolve, 200));
    }

    console.log(`\n\n✨ Done!`);
    console.log(`   ✅ Validated: ${validated}`);
    console.log(`   ⏭️  Skipped (already cached): ${skipped}`);
    console.log(`   ⚠️  Errors: ${errors}`);
    console.log(`   📦 Cache populated via WordManager`);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
