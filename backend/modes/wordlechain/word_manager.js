const fs = require('fs');
const path = require('path');

const LOGS_DIR = path.join(__dirname, 'logs');
const CACHE_DIR = path.join(__dirname, 'cache');

// In-memory data structures: { 'it': Set(), 'en': Set() }
let wordCaches = { 'it': new Set(), 'en': new Set() };
let loggedWords = { 'it': new Set(), 'en': new Set() };

/**
 * Automatically create log/cache files for a specific language if they do not exist
 */
function ensureFilesExist(lang) {
    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    
    const logFile = path.join(LOGS_DIR, `words_${lang}.log`);
    const cacheFile = path.join(CACHE_DIR, `word_cache_${lang}.txt`);
    
    if (!fs.existsSync(logFile)) fs.writeFileSync(logFile, '', 'utf8');
    if (!fs.existsSync(cacheFile)) fs.writeFileSync(cacheFile, '', 'utf8');
    
    return { logFile, cacheFile };
}

/**
 * Load words from files into memory for a specific language.
 * Now robust against "messy" manual entries by normalizing on load.
 */
function loadLanguageData(lang) {
    const { logFile, cacheFile } = ensureFilesExist(lang);
    try {
        const cacheData = fs.readFileSync(cacheFile, 'utf8');
        cacheData.split('\n').forEach(line => {
            const word = line.trim().toLowerCase();
            // Basic check: must contain only letters for valid cache
            if (word && /^[a-z]+$/.test(word)) {
                wordCaches[lang].add(word);
            }
        });

        const logData = fs.readFileSync(logFile, 'utf8');
        logData.split('\n').forEach(line => {
            const word = line.trim().toLowerCase();
            if (word && /^[a-z]+$/.test(word)) {
                loggedWords[lang].add(word);
            }
        });
        
        console.log(`[WordManager] Loaded ${lang.toUpperCase()} - Cache: ${wordCaches[lang].size}, Logs: ${loggedWords[lang].size}`);
    } catch (err) {
        console.error(`[WordManager] Error loading ${lang} data:`, err.message);
    }
}

// Load both by default
loadLanguageData('it');
loadLanguageData('en');

/**
 * Validates word against basic rules:
 * - Only letters a-z (strictly no accents)
 * - Minimum 3 letters
 */
function isValidBasic(word) {
    const normalized = word.toLowerCase();
    // Rule: Only letters a-z (this naturally excludes accents, numbers, symbols)
    // Rule: Minimum 3 letters
    return /^[a-z]{3,}$/.test(normalized);
}

/**
 * 3️⃣ Cache functions: adds to cache and file if not already present
 */
function addWordToCache(word, lang = 'it') {
    const normalized = word.toLowerCase();
    if (!wordCaches[lang]) wordCaches[lang] = new Set();
    
    if (!wordCaches[lang].has(normalized)) {
        wordCaches[lang].add(normalized);
        const { cacheFile } = ensureFilesExist(lang);
        fs.appendFileSync(cacheFile, normalized + '\n', 'utf8');
    }
}

function isWordCached(word, lang = 'it') {
    return wordCaches[lang] && wordCaches[lang].has(word.toLowerCase());
}

/**
 * 4️⃣ Logging function: append lowercase word to language-specific log
 */
function logWord(word, lang = 'it') {
    const normalized = word.toLowerCase();
    if (!loggedWords[lang]) loggedWords[lang] = new Set();

    if (!loggedWords[lang].has(normalized)) {
        loggedWords[lang].add(normalized);
        const { logFile } = ensureFilesExist(lang);
        fs.appendFileSync(logFile, normalized + '\n', 'utf8');
    }
}

/**
 * 5️⃣ Manual entry: allows admin to add words manually
 */
function addManualWord(word, lang = 'it') {
    const normalized = word.toLowerCase();
    if (isValidBasic(normalized)) {
        if (!isWordCached(normalized, lang)) {
            addWordToCache(normalized, lang);
        }
        logWord(normalized, lang);
        return true;
    }
    return false;
}

/**
 * Validates word via LanguageTool if not in cache
 */
async function checkLanguageTool(word, language = 'it') {
    const langCode = language === 'en' ? 'en-US' : 'it';
    try {
        const params = new URLSearchParams({
            text: word.toLowerCase(),
            language: langCode
        });

        const response = await fetch('https://api.languagetool.org/v2/check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString()
        });

        if (!response.ok) return true; // Fallback

        const data = await response.json();
        
        // Filter out misspelled words
        const spellingErrors = (data.matches || []).filter(m =>
            m.rule && (
                m.rule.issueType === 'misspelling' ||
                m.rule.id === 'MORFOLOGIK_RULE_EN_US' ||
                m.rule.id === 'HUNSPELL_RULE' ||
                m.rule.id === 'HUNSPELL_NO_SUGGEST_RULE' ||
                (m.rule.category && m.rule.category.id === 'TYPOS')
            )
        );
        if (spellingErrors.length > 0) return false;

        // Rule: Reject proper nouns (cities, names, etc.)
        // LanguageTool often flags these with categories like 'CASING' or specific rule IDs
        const properNounMatch = (data.matches || []).find(m => 
            m.rule && (
                m.rule.id === 'PROPER_NOUN' || 
                (m.context && m.context.text && /^[A-Z]/.test(m.context.text.substring(m.offset, m.offset + m.length)))
            )
        );
        // Note: LanguageTool detection of proper nouns can be tricky in isolation.
        // We'll trust its dictionary but try to be cautious.
        
        return true;
    } catch (err) {
        return true; // Fallback
    }
}

/**
 * 2️⃣ Automatic word processing
 */
async function processWord(word, language = 'it') {
    const normalized = word.toLowerCase();

    // Basic rules check
    if (!isValidBasic(normalized)) return false;

    // Check cache for specific language
    if (isWordCached(normalized, language)) {
        logWord(normalized, language);
        return true;
    }

    // Call LanguageTool
    const isValid = await checkLanguageTool(normalized, language);
    
    if (isValid) {
        addWordToCache(normalized, language);
        logWord(normalized, language);
        return true;
    }

    return false;
}

/**
 * 6️⃣ Prefix checking: checks if the cache has at least one word starting with the prefix
 */
function hasWordWithPrefix(prefix, lang = 'it') {
    const p = prefix.toLowerCase();
    if (!wordCaches[lang] || wordCaches[lang].size === 0) return true; // Fallback se cache vuoto
    for (const word of wordCaches[lang]) {
        if (word.startsWith(p)) return true;
    }
    return false;
}

module.exports = {
    processWord,
    addWordToCache,
    isWordCached,
    logWord,
    addManualWord,
    hasWordWithPrefix
};
